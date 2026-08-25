import type {
  InstallOptions,
  LocalInstalledModel,
  LocalRuntimeAdapter,
  ModelBenchmark,
  ModelRuntimeInfo,
  RuntimeDetectionResult,
} from "../runtime-types"

export const OLLAMA_DEFAULT_ENDPOINT = "http://127.0.0.1:11434"

// OLLAMA_HOST may be "host:port", "0.0.0.0:port" or a full URL
export function resolveOllamaEndpoint(env?: Record<string, string | undefined>): string {
  const host = env?.["OLLAMA_HOST"]
  if (!host) return OLLAMA_DEFAULT_ENDPOINT
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "")
  const [hostPart, portPart] = host.split(":")
  const scheme = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "http"
  if (!hostPart) return OLLAMA_DEFAULT_ENDPOINT
  return `${scheme}://${hostPart || "127.0.0.1"}:${portPart || "11434"}`
}

interface FetchLike {
  (
    input: string,
    init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response>
}

function parseParameterCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const match = /([0-9.]+)\s*(b|m)/i.exec(raw)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  return /m/i.test(match[2]) ? Math.round(value * 1e6) : Math.round(value * 1e9)
}

interface OllamaTagModel {
  name: string
  size?: number
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
}

interface OllamaShowResponse {
  license?: unknown
  modelfile?: string
  parameters?: string
  template?: string
  capabilities?: string[]
  model_info?: Record<string, unknown>
}

function contextLengthFromShow(show: OllamaShowResponse): number | undefined {
  const info = show.model_info ?? {}
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number") return value
  }
  return undefined
}

export function createOllamaAdapter(options?: { endpoint?: string; fetch?: FetchLike }): LocalRuntimeAdapter {
  const endpoint = options?.endpoint ?? resolveOllamaEndpoint()
  const doFetch = options?.fetch ?? fetch

  // `null` disables the idle timeout entirely - used for streaming endpoints
  // like pulls and generations that legitimately run for many minutes.
  async function request(
    pathname: string,
    init?: Parameters<FetchLike>[1],
    timeoutMs: number | null = 5_000,
  ): Promise<Response> {
    const signals: AbortSignal[] = []
    if (init?.signal) signals.push(init.signal)
    if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs))
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    return doFetch(`${endpoint}${pathname}`, {
      ...init,
      signal,
      headers: { "Content-Type": "application/json", ...init?.headers },
    })
  }

  async function json<T>(pathname: string, init?: Parameters<FetchLike>[1], timeoutMs?: number): Promise<T> {
    const res = await request(pathname, init, timeoutMs)
    if (!res.ok) throw new Error(`Ollama ${pathname} failed with ${res.status}`)
    return (await res.json()) as T
  }

  async function show(modelID: string): Promise<OllamaShowResponse | undefined> {
    try {
      return await json<OllamaShowResponse>(
        "/api/show",
        { method: "POST", body: JSON.stringify({ model: modelID }) },
        10_000,
      )
    } catch {
      return undefined
    }
  }

  async function toInstalledModel(item: OllamaTagModel): Promise<LocalInstalledModel> {
    const detail = await show(item.name)
    const capabilities = detail?.capabilities ?? []
    return {
      id: item.name,
      name: item.name,
      ...(item.size !== undefined ? { sizeBytes: item.size } : {}),
      ...(item.details?.quantization_level ? { quantization: item.details.quantization_level } : {}),
      ...(parseParameterCount(item.details?.parameter_size) !== undefined
        ? { parameterCount: parseParameterCount(item.details?.parameter_size) }
        : {}),
      ...(item.details?.family ? { family: item.details.family } : {}),
      ...(contextLengthFromShow(detail ?? {}) !== undefined ? { contextLength: contextLengthFromShow(detail!) } : {}),
      toolCalling: capabilities.includes("tools"),
      vision: capabilities.includes("vision"),
      reasoning: capabilities.includes("thinking") || item.name.includes("deepseek-r1"),
    }
  }

  return {
    id: "ollama",
    name: "Ollama",
    endpoint,

    async detect(): Promise<RuntimeDetectionResult> {
      try {
        const version = await json<{ version?: string }>("/api/version", {}, 2_000)
        return {
          id: "ollama",
          name: "Ollama",
          available: true,
          endpoint,
          detail: version.version ? `v${version.version}` : undefined,
        }
      } catch (error) {
        return {
          id: "ollama",
          name: "Ollama",
          available: false,
          endpoint,
          detail: error instanceof Error && error.name === "TimeoutError" ? "timed out" : "not running",
        }
      }
    },

    async listModels(): Promise<LocalInstalledModel[]> {
      const result = await json<{ models?: OllamaTagModel[] }>("/api/tags")
      const models = await Promise.all((result.models ?? []).map(toInstalledModel))
      return models.sort((a, b) => a.id.localeCompare(b.id))
    },

    async inspectModel(id: string): Promise<ModelRuntimeInfo> {
      const installed = await toInstalledModel({ name: id })
      return installed
    },

    async installModel(model: { id: string }, installOptions?: InstallOptions): Promise<void> {
      const res = await request(
        "/api/pull",
        { method: "POST", body: JSON.stringify({ model: model.id, stream: true }), signal: installOptions?.signal },
        null,
      )
      if (!res.ok) throw new Error(`Failed to pull ${model.id}: HTTP ${res.status}`)
      if (!res.body) throw new Error(`Failed to pull ${model.id}: empty response`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          let event: { status?: string; total?: number; completed?: number; error?: string }
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.error) throw new Error(event.error)
          if (installOptions?.onProgress && event.status) {
            installOptions.onProgress({
              status: event.status,
              percent:
                event.total && event.completed !== undefined && event.total > 0
                  ? Math.min(100, Math.round((event.completed / event.total) * 100))
                  : undefined,
            })
          }
        }
      }
    },

    async removeModel(id: string): Promise<void> {
      const res = await request("/api/delete", { method: "DELETE", body: JSON.stringify({ model: id }) }, 30_000)
      if (!res.ok) throw new Error(`Failed to remove ${id}: HTTP ${res.status}`)
    },

    async benchmarkModel(id: string, benchmarkOptions?): Promise<ModelBenchmark> {
      const startedAt = Date.now()
      try {
        const prompt = "Write a Python function that reverses a string. Answer briefly."
        const maxTokens = benchmarkOptions?.maxTokens ?? 128
        let timeToFirstTokenMs: number | undefined
        let final: {
          load_duration?: number
          prompt_eval_count?: number
          prompt_eval_duration?: number
          eval_count?: number
          eval_duration?: number
        } = {}

        const res = await request(
          "/api/generate",
          {
            method: "POST",
            body: JSON.stringify({
              model: id,
              prompt,
              stream: true,
              options: { num_predict: maxTokens },
            }),
            signal: benchmarkOptions?.signal,
          },
          // Generation can be slow on CPU; cap at 10 minutes
          600_000,
        )
        if (!res.ok) throw new Error(`Benchmark request failed with HTTP ${res.status}`)
        if (!res.body) throw new Error("Benchmark response had no body")

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              if (timeToFirstTokenMs === undefined && event.response) {
                timeToFirstTokenMs = Date.now() - startedAt
              }
              if (event.done) final = event
            } catch {}
          }
        }

        const tokensPerSecond =
          final.eval_count && final.eval_duration ? final.eval_count / (final.eval_duration / 1e9) : undefined
        const promptTokensPerSecond =
          final.prompt_eval_count && final.prompt_eval_duration
            ? final.prompt_eval_count / (final.prompt_eval_duration / 1e9)
            : undefined

        if (!tokensPerSecond || !Number.isFinite(tokensPerSecond)) {
          throw new Error("Benchmark completed without measurable generation speed")
        }

        return {
          success: true,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          ...(promptTokensPerSecond ? { promptTokensPerSecond: Math.round(promptTokensPerSecond * 10) / 10 } : {}),
          ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
          testedAt: Date.now(),
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          testedAt: Date.now(),
        }
      }
    },
  }
}
