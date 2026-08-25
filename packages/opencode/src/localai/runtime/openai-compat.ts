import type {
  BenchmarkOptions,
  LocalInstalledModel,
  ModelBenchmark,
} from "../runtime-types"
import type { ReadinessCheck, ReadinessResult } from "../readiness"

// Shared transport for local runtimes exposing OpenAI-compatible endpoints
// (/v1/models, /v1/chat/completions): LM Studio, llama-server, mlx-lm server.
// Ollama deliberately does NOT use this - its native API carries richer
// metadata that Atlas relies on.

export interface FetchLike {
  (
    input: string,
    init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response>
}

const BENCHMARK_TIMEOUT_MS = 600_000

export interface OpenAIChatToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface OpenAIChatMessage {
  role?: string
  content?: string | null
  tool_calls?: OpenAIChatToolCall[]
}

interface ChatCompletionResponse {
  choices?: { message?: OpenAIChatMessage }[]
}

interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: OpenAIChatToolCall[] }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

function parseDataLines(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  for (const line of parts) {
    const trimmed = line.trim()
    if (trimmed.startsWith("data:")) events.push(trimmed.slice(5).trim())
  }
  return { events, rest }
}

export async function listOpenAICompatModels(
  fetchFn: FetchLike,
  endpoint: string,
  timeoutMs = 3_000,
): Promise<LocalInstalledModel[]> {
  const res = await fetchFn(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`/v1/models failed with HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { id?: string }[] }
  const items = Array.isArray(body.data) ? body.data : []
  return items
    .filter((item): item is { id: string } => typeof item.id === "string" && item.id.length > 0)
    .map((item) => ({ id: item.id, name: item.id }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

async function chatCompletion(
  fetchFn: FetchLike,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<OpenAIChatMessage | undefined> {
  const res = await fetchFn(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`chat completion failed with HTTP ${res.status}`)
  const data = (await res.json()) as ChatCompletionResponse
  return data.choices?.[0]?.message
}

/** Streams a completion, invoking onChunk for every delta. Returns final usage. */
async function streamChatCompletion(
  fetchFn: FetchLike,
  endpoint: string,
  body: Record<string, unknown>,
  onChunk: (delta: string, toolCalls?: OpenAIChatToolCall[]) => void,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ completionTokens?: number; promptTokens?: number }> {
  const res = await fetchFn(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream: true, stream_options: { include_usage: true }, ...body }),
    signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 120_000),
  })
  if (!res.ok) throw new Error(`chat completion failed with HTTP ${res.status}`)
  if (!res.body) throw new Error("empty response body")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: { completionTokens?: number; promptTokens?: number } = {}
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = parseDataLines(buffer)
      buffer = rest
      for (const event of events) {
        if (event === "[DONE]") continue
        let chunk: ChatCompletionChunk
        try {
          chunk = JSON.parse(event)
        } catch {
          continue
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) onChunk(delta.content)
        if (delta?.tool_calls?.length) onChunk("", delta.tool_calls)
        if (chunk.usage) {
          usage = { completionTokens: chunk.usage.completion_tokens, promptTokens: chunk.usage.prompt_tokens }
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  return usage
}

/**
 * Benchmarks a model through an OpenAI-compatible endpoint. Measured values
 * come only from real generation - never synthesized.
 */
export async function benchmarkViaOpenAICompat(
  fetchFn: FetchLike,
  endpoint: string,
  runtimeModelID: string,
  options?: BenchmarkOptions & { prompt?: string },
): Promise<ModelBenchmark> {
  const startedAt = Date.now()
  try {
    const maxTokens = options?.maxTokens ?? 128
    const prompt = options?.prompt ?? "Write a Python function that reverses a string. Answer briefly."
    let timeToFirstTokenMs: number | undefined
    let generatedChars = 0
    let streamedChunks = 0

    const usage = await streamChatCompletion(
      fetchFn,
      endpoint,
      {
        model: runtimeModelID,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      },
      (delta) => {
        if (timeToFirstTokenMs === undefined && delta.length > 0) timeToFirstTokenMs = Date.now() - startedAt
        generatedChars += delta.length
        streamedChunks += 1
      },
      { signal: options?.signal, timeoutMs: BENCHMARK_TIMEOUT_MS },
    )

    // Prefer the server's own token accounting; fall back to a chars/4
    // estimate clearly derived from real output.
    let completionTokens = usage.completionTokens
    if (!completionTokens || completionTokens <= 0) completionTokens = Math.round(generatedChars / 4)
    const elapsedSeconds = (Date.now() - startedAt) / 1000
    if (!completionTokens || elapsedSeconds <= 0 || streamedChunks === 0) {
      throw new Error("Benchmark completed without measurable generation speed")
    }

    const result: ModelBenchmark = {
      success: true,
      tokensPerSecond: Math.round((completionTokens / elapsedSeconds) * 10) / 10,
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      testedAt: Date.now(),
    }
    return result
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      testedAt: Date.now(),
    }
  }
}

const WEATHER_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature unit" },
      },
      required: ["city"],
    },
  },
}

function parseToolArguments(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined
  let raw: unknown = input
  try {
    raw = JSON.parse(input)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, value]))
}

/**
 * Readiness probe over the normalized OpenAI-compatible surface. Checks that
 * fail because the RUNTIME lacks a feature are reported honestly as failing -
 * model capability and runtime exposure stay distinguishable via capabilities.
 */
export async function readinessViaOpenAICompat(
  fetchFn: FetchLike,
  endpoint: string,
  runtimeModelID: string,
  options?: { signal?: AbortSignal; onCheck?: (check: ReadinessCheck) => void },
): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = []
  const testedAt = Date.now()

  try {
    const basic = await chatCompletion(
      fetchFn,
      endpoint,
      { model: runtimeModelID, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 16 },
      120_000,
      options?.signal,
    )
    checks.push({
      id: "chat",
      label: "Chat",
      pass: !!basic?.content && basic.content.trim().length > 0,
    })
    options?.onCheck?.(checks[checks.length - 1]!)

    let streamedChunks = 0
    try {
      await streamChatCompletion(
        fetchFn,
        endpoint,
        { model: runtimeModelID, messages: [{ role: "user", content: "Count from 1 to 5." }], max_tokens: 32 },
        () => {
          streamedChunks += 1
        },
        { signal: options?.signal },
      )
    } catch {}
    checks.push({ id: "streaming", label: "Streaming", pass: streamedChunks > 1 })
    options?.onCheck?.(checks[checks.length - 1]!)

    let toolCalled = false
    let argsValid = false
    try {
      const message = await chatCompletion(
        fetchFn,
        endpoint,
        {
          model: runtimeModelID,
          messages: [{ role: "user", content: "What is the weather in Paris right now? Use the get_weather tool." }],
          tools: [WEATHER_TOOL],
          max_tokens: 128,
        },
        120_000,
        options?.signal,
      )
      const call = message?.tool_calls?.[0]
      toolCalled = call?.function?.name === "get_weather"
      if (toolCalled) {
        const args = parseToolArguments(call?.function?.arguments)
        argsValid = typeof args?.city === "string" && String(args.city).toLowerCase().includes("paris")
      }
    } catch {}
    checks.push({ id: "tool-calling", label: "Tool Calling", pass: toolCalled })
    options?.onCheck?.(checks[checks.length - 1]!)
    checks.push({ id: "structured-args", label: "Structured Args", pass: argsValid })
    options?.onCheck?.(checks[checks.length - 1]!)

    let structuredValid = false
    try {
      const message = await chatCompletion(
        fetchFn,
        endpoint,
        {
          model: runtimeModelID,
          messages: [
            {
              role: "user",
              content:
                'Return a JSON object describing how to rename the file "old.py" to "new.py". Shape: {"action": string ("move"), "from": string, "to": string}. Respond with JSON only.',
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "rename",
              schema: {
                type: "object",
                properties: { action: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
                required: ["action", "from", "to"],
              },
            },
          },
          max_tokens: 96,
        },
        120_000,
        options?.signal,
      )
      const parsed = JSON.parse(message?.content ?? "{}")
      structuredValid =
        typeof parsed.action === "string" && typeof parsed.from === "string" && typeof parsed.to === "string"
    } catch {}
    checks.push({ id: "structured-output", label: "Structured Output", pass: structuredValid })
    options?.onCheck?.(checks[checks.length - 1]!)

    const passed = checks.filter((check) => check.pass).length
    return { success: true, checks, score: Math.round((passed / checks.length) * 100), testedAt }
  } catch (error) {
    return {
      success: false,
      ...(error instanceof Error ? { error: error.message } : {}),
      checks,
      score: 0,
      testedAt,
    }
  }
}
