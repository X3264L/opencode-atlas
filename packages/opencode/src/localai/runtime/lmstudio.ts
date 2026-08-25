import type {
  BenchmarkOptions,
  LocalInstalledModel,
  LocalRuntimeAdapter,
  ModelBenchmark,
  RuntimeCapabilities,
  RuntimeDetectionResult,
  RuntimeHealth,
} from "../runtime-types"
import { benchmarkViaOpenAICompat, listOpenAICompatModels, readinessViaOpenAICompat } from "./openai-compat"
import type { ReadinessCheck, ReadinessResult } from "../readiness"
import type { FetchLike } from "./openai-compat"

export const LMSTUDIO_DEFAULT_ENDPOINT = "http://127.0.0.1:1234"

// LM Studio exposes an OpenAI-compatible server on port 1234 and a richer
// REST API under /api/v0 which reports per-model context length and state.
interface LMStudioModel {
  id: string
  object?: string
  context_length?: number
  state?: string
  max_context_length?: number
  loaded_context_length?: number
  type?: string
  publisher?: string
  arch?: string
  quantization?: string
  state_bytes?: number
}

export function resolveLMStudioEndpoint(env?: Record<string, string | undefined>): string {
  const host = env?.["LMSTUDIO_HOST"]
  if (!host) return LMSTUDIO_DEFAULT_ENDPOINT
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "")
  return `http://${host}`
}

export function createLMStudioAdapter(options?: {
  endpoint?: string
  env?: Record<string, string | undefined>
  fetch?: FetchLike
}): LocalRuntimeAdapter & {
  probeReadiness(modelID: string, options?: { signal?: AbortSignal; onCheck?: (check: ReadinessCheck) => void }): Promise<ReadinessResult>
} {
  const endpoint = options?.endpoint ?? resolveLMStudioEndpoint(options?.env)
  const doFetch = options?.fetch ?? fetch

  async function request(pathname: string, timeoutMs = 2_000): Promise<Response> {
    return doFetch(`${endpoint}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
  }

  function extractModels(value: unknown): LMStudioModel[] {
    if (!value || typeof value !== "object") return []
    const data = Object.values(value).length > 0 && "data" in value ? (value as { data?: unknown }).data : undefined
    if (!Array.isArray(data)) return []
    return data.filter(
      (item): item is LMStudioModel =>
        !!item && typeof item === "object" && typeof (item as LMStudioModel).id === "string",
    )
  }

  // Model downloads/management live inside the LM Studio app - Atlas does not
  // fake lifecycle support for them.
  const capabilities: RuntimeCapabilities = {
    discovery: true,
    modelListing: true,
    modelInstall: false,
    modelRemoval: false,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    benchmark: true,
    cancellation: true,
    externalModelFiles: true,
  }

  return {
    id: "lmstudio",
    name: "LM Studio",
    endpoint,
    capabilities,

    async detect(): Promise<RuntimeDetectionResult> {
      try {
        const res = await request("/v1/models")
        if (!res.ok) throw new Error(String(res.status))
        return { id: "lmstudio", name: "LM Studio", available: true, endpoint }
      } catch {
        return { id: "lmstudio", name: "LM Studio", available: false, endpoint, detail: "not running" }
      }
    },

    async health(): Promise<RuntimeHealth> {
      try {
        const res = await request("/v1/models")
        if (!res.ok) return { state: "degraded", detail: `HTTP ${res.status}` }
        return { state: "available" }
      } catch {
        return { state: "unavailable", detail: "not running" }
      }
    },

    async listModels(): Promise<LocalInstalledModel[]> {
      let items: LMStudioModel[]
      try {
        // The REST API reports context length, quantization and load state
        const res = await request("/api/v0/models")
        if (!res.ok) throw new Error(String(res.status))
        items = extractModels(await res.json())
      } catch {
        // Older builds only expose the OpenAI-compatible listing
        try {
          return await listOpenAICompatModels(doFetch, endpoint)
        } catch (error) {
          throw error instanceof Error ? error : new Error("LM Studio model listing failed")
        }
      }
      return items
        .filter((item) => item.id)
        .map((item) => ({
          id: item.id,
          name: item.publisher ? `${item.publisher} ${item.id}`.trim() : item.id,
          ...(item.quantization ? { quantization: item.quantization.toUpperCase() } : {}),
          ...(item.arch ? { family: item.arch } : {}),
          ...(item.state_bytes && item.state_bytes > 0 ? { sizeBytes: item.state_bytes } : {}),
          ...(item.loaded_context_length || item.max_context_length
            ? { contextLength: item.loaded_context_length ?? item.max_context_length }
            : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    },

    async inspectModel(id: string): Promise<LocalInstalledModel> {
      const models = await this.listModels()
      const match = models.find((model) => model.id === id)
      if (!match) throw new Error(`Model not found on LM Studio: ${id}`)
      return match
    },

    async benchmarkModel(id: string, benchmarkOptions?: BenchmarkOptions): Promise<ModelBenchmark> {
      return benchmarkViaOpenAICompat(doFetch, endpoint, id, benchmarkOptions)
    },

    async probeReadiness(modelID: string, readinessOptions?: { signal?: AbortSignal; onCheck?: (check: ReadinessCheck) => void }): Promise<ReadinessResult> {
      return readinessViaOpenAICompat(doFetch, endpoint, modelID, { signal: readinessOptions?.signal, onCheck: readinessOptions?.onCheck })
    },
  }
}
