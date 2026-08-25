// Lightweight OpenCode-compatibility probe for local models. Runs small
// sandboxed requests against the runtime's chat API - never touches user files.
export interface ReadinessCheck {
  id: "chat" | "streaming" | "tool-calling" | "structured-args" | "structured-output"
  label: string
  pass: boolean
}

export interface ReadinessResult {
  success: boolean
  error?: string
  checks: ReadinessCheck[]
  score: number
  testedAt: number
}

interface ChatMessage {
  role: string
  content?: string
  tool_calls?: { function: { name: string; arguments: unknown } }[]
}

interface FetchLike {
  (
    input: string,
    init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response>
}

const REQUEST_TIMEOUT_MS = 120_000

const WEATHER_TOOL = {
  type: "function",
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

async function chat(fetchFn: FetchLike, endpoint: string, modelID: string, body: Record<string, unknown>) {
  const res = await fetchFn(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelID, stream: false, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`chat failed with HTTP ${res.status}`)
  return (await res.json()) as { message?: ChatMessage }
}

function parseToolArguments(input: unknown): Record<string, unknown> | undefined {
  let raw = input
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value]))
}

export async function runReadinessTest(
  modelID: string,
  options: { endpoint: string; fetch?: FetchLike },
): Promise<ReadinessResult> {
  const fetchFn = options.fetch ?? fetch
  const checks: ReadinessCheck[] = []
  const testedAt = Date.now()

  try {
    const basic = await chat(fetchFn, options.endpoint, modelID, {
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      options: { num_predict: 16 },
    })
    checks.push({
      id: "chat",
      label: "Chat",
      pass: !!basic.message?.content && basic.message.content.trim().length > 0,
    })

    let streamedChunks = 0
    try {
      const res = await fetchFn(`${options.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelID,
          messages: [{ role: "user", content: "Count from 1 to 5." }],
          stream: true,
          options: { num_predict: 32 },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          streamedChunks += decoder
            .decode(value, { stream: true })
            .split("\n")
            .filter((line) => line.includes(`"done":false`) || line.includes(`"done": true`)).length
        }
      }
    } catch {}
    checks.push({ id: "streaming", label: "Streaming", pass: streamedChunks > 1 })

    let toolCalled = false
    let argsValid = false
    try {
      const result = await chat(fetchFn, options.endpoint, modelID, {
        messages: [{ role: "user", content: "What is the weather in Paris right now? Use the get_weather tool." }],
        tools: [WEATHER_TOOL],
        options: { num_predict: 128 },
      })
      const call = result.message?.tool_calls?.[0]
      toolCalled = call?.function?.name === "get_weather"
      if (call && toolCalled) {
        const args = parseToolArguments(call.function.arguments)
        argsValid = typeof args?.city === "string" && args.city.toLowerCase().includes("paris")
      }
    } catch {}
    checks.push({ id: "tool-calling", label: "Tool Calling", pass: toolCalled })
    checks.push({ id: "structured-args", label: "Structured Args", pass: argsValid })

    let structuredValid = false
    try {
      const result = await chat(fetchFn, options.endpoint, modelID, {
        messages: [
          {
            role: "user",
            content:
              'You are editing files. Return a JSON object describing how to rename the file "old.py" to "new.py". Shape: {"action": string ("move"), "from": string, "to": string}',
          },
        ],
        format: {
          type: "object",
          properties: { action: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
          required: ["action", "from", "to"],
        },
        options: { num_predict: 96 },
      })
      const parsed = JSON.parse(result.message?.content ?? "{}")
      structuredValid =
        typeof parsed.action === "string" && typeof parsed.from === "string" && typeof parsed.to === "string"
    } catch {}
    checks.push({ id: "structured-output", label: "Structured Output", pass: structuredValid })

    const passed = checks.filter((check) => check.pass).length
    return { success: true, checks, score: Math.round((passed / checks.length) * 100), testedAt }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      checks,
      score: 0,
      testedAt,
    }
  }
}
