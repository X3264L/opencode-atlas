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
import type { ReadinessResult } from "../readiness"
import type { FetchLike } from "./openai-compat"

export const LLAMACPP_DEFAULT_ENDPOINT = "http://127.0.0.1:8080"

// llama.cpp support targets an externally running llama-server (or any
// compatible OpenAI endpoint). Atlas never launches processes implicitly -
// automatic server management is a separate opt-in concern.

// Known quantization labels used in GGUF filenames (e.g. qwen14b-q6_k.gguf)
const GGUF_QUANT_PATTERN =
  /(?:^|[-_.])\b(IQ[0-9A-Z_]+|Q[2-8][._]?[0-9A-Z_]*|F16|F32|BF16|MXFP4[A-Z_-]*)\b(?=$|[-_.])/i

/**
 * Extracts a normalized quantization label from a model id or GGUF filename.
 * Returns uppercase canonical form like "Q6_K" or undefined when unknown -
 * unknown identities stay unknown instead of being guessed.
 */
export function parseGGUFQuantization(raw: string): string | undefined {
  const match = GGUF_QUANT_PATTERN.exec(raw)
  if (!match) return undefined
  return match[1].toUpperCase().replace(/[._]/g, "_")
}

/** Strips file extension and path components from a runtime model id */
export function ggufDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw
  return base.replace(/\.gguf$/i, "")
}

function estimateParameterCount(raw: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(ggufDisplayName(raw))
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * 1e9)
}

export function resolveLlamaCppEndpoint(env?: Record<string, string | undefined>): string {
  const host = env?.["LLAMACPP_HOST"]
  if (!host) return LLAMACPP_DEFAULT_ENDPOINT
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "")
  return `http://${host}`
}

export function createLlamaCppAdapter(options?: {
  endpoint?: string
  env?: Record<string, string | undefined>
  fetch?: FetchLike
}): LocalRuntimeAdapter & {
  probeReadiness(modelID: string, options?: { signal?: AbortSignal }): Promise<ReadinessResult>
} {
  const endpoint = options?.endpoint ?? resolveLlamaCppEndpoint(options?.env)
  const doFetch = options?.fetch ?? fetch

  async function request(pathname: string, timeoutMs = 2_000): Promise<Response> {
    return doFetch(`${endpoint}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
  }

  // llama-server has no lifecycle API for model files - they are chosen at
  // server start. Install/remove therefore do not exist here.
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

  async function detectHealth(): Promise<RuntimeHealth> {
    try {
      const res = await request("/health")
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { status?: string }
        if (body.status && body.status !== "ok") return { state: "degraded", detail: body.status }
        return { state: "available" }
      }
      if (res.status === 503) return { state: "degraded", detail: "model loading" }
      return { state: "unavailable", detail: `HTTP ${res.status}` }
    } catch {
      return { state: "unavailable", detail: "not running" }
    }
  }

  return {
    id: "llamacpp",
    name: "llama.cpp",
    endpoint,
    capabilities,

    async detect(): Promise<RuntimeDetectionResult> {
      const health = await detectHealth()
      if (health.state === "available" || health.state === "degraded") {
        return { id: "llamacpp", name: "llama.cpp", available: true, endpoint, ...(health.detail ? { detail: health.detail } : {}) }
      }
      return { id: "llamacpp", name: "llama.cpp", available: false, endpoint, detail: "not running" }
    },

    health: detectHealth,

    async listModels(): Promise<LocalInstalledModel[]> {
      const models = await listOpenAICompatModels(doFetch, endpoint)
      return models.map((model) => {
        const quant = parseGGUFQuantization(model.id)
        const parameterCount = estimateParameterCount(model.id)
        return {
          ...model,
          name: ggufDisplayName(model.id),
          ...(quant ? { quantization: quant } : {}),
          ...(parameterCount ? { parameterCount } : {}),
        }
      })
    },

    async inspectModel(id: string): Promise<LocalInstalledModel> {
      const models = await this.listModels()
      const match = models.find((model) => model.id === id)
      if (!match) throw new Error(`Model not found on llama.cpp server: ${id}`)
      return match
    },

    async benchmarkModel(id: string, benchmarkOptions?: BenchmarkOptions): Promise<ModelBenchmark> {
      return benchmarkViaOpenAICompat(doFetch, endpoint, id, benchmarkOptions)
    },

    async probeReadiness(modelID: string, readinessOptions?: { signal?: AbortSignal }): Promise<ReadinessResult> {
      return readinessViaOpenAICompat(doFetch, endpoint, modelID, readinessOptions)
    },
  }
}
