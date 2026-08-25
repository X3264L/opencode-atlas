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

export const MLX_DEFAULT_ENDPOINT = "http://127.0.0.1:8080"

// MLX runs exclusively on Apple Silicon. On every other platform the runtime
// reports "unsupported" and is never probed as a usable backend.
export function mlxSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === "darwin" && arch === "arm64"
}

export function resolveMlxEndpoint(env?: Record<string, string | undefined>): string {
  const host = env?.["MLX_HOST"]
  if (!host) return MLX_DEFAULT_ENDPOINT
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, "")
  return `http://${host}`
}

function unsupportedCapabilities(): RuntimeCapabilities {
  return {
    discovery: false,
    modelListing: false,
    modelInstall: false,
    modelRemoval: false,
    streaming: false,
    toolCalling: false,
    structuredOutput: false,
    benchmark: false,
    cancellation: false,
    externalModelFiles: true,
  }
}

const supportedCapabilities: RuntimeCapabilities = {
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

export function createMlxAdapter(options?: {
  endpoint?: string
  env?: Record<string, string | undefined>
  fetch?: FetchLike
  platform?: string
  arch?: string
}): LocalRuntimeAdapter & {
  probeReadiness(modelID: string, options?: { signal?: AbortSignal; onCheck?: (check: ReadinessCheck) => void }): Promise<ReadinessResult>
} {
  // Endpoint overrides only apply on supported platforms - never probe
  // user-configured remote endpoints from machines that cannot run MLX.
  const supported = mlxSupported(options?.platform ?? process.platform, options?.arch ?? process.arch)
  const endpoint = supported ? (options?.endpoint ?? resolveMlxEndpoint(options?.env)) : MLX_DEFAULT_ENDPOINT
  const doFetch = options?.fetch ?? fetch

  async function request(pathname: string, timeoutMs = 2_000): Promise<Response> {
    return doFetch(`${endpoint}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
  }

  if (!supported) {
    return {
      id: "mlx",
      name: "MLX",
      endpoint,
      capabilities: unsupportedCapabilities(),

      async detect(): Promise<RuntimeDetectionResult> {
        return { id: "mlx", name: "MLX", available: false, endpoint, detail: "unsupported on this platform" }
      },

      async listModels(): Promise<LocalInstalledModel[]> {
        throw new Error("MLX is not available on this platform")
      },

      async probeReadiness(): Promise<ReadinessResult> {
        return { success: false, error: "MLX is not available on this platform", checks: [], score: 0, testedAt: Date.now() }
      },
    }
  }

  // mlx-lm server exposes OpenAI-compatible routes. Model management happens
  // through the Hugging Face cache - outside Atlas lifecycle control here.
  return {
    id: "mlx",
    name: "MLX",
    endpoint,
    capabilities: supportedCapabilities,

    async detect(): Promise<RuntimeDetectionResult> {
      try {
        await listOpenAICompatModels(doFetch, endpoint)
        return { id: "mlx", name: "MLX", available: true, endpoint }
      } catch {
        return { id: "mlx", name: "MLX", available: false, endpoint, detail: "not running" }
      }
    },

    async health(): Promise<RuntimeHealth> {
      try {
        await request("/v1/models")
        return { state: "available" }
      } catch {
        return { state: "unavailable", detail: "not running" }
      }
    },

    async listModels(): Promise<LocalInstalledModel[]> {
      return listOpenAICompatModels(doFetch, endpoint)
    },

    async inspectModel(id: string): Promise<LocalInstalledModel> {
      const models = await this.listModels()
      const match = models.find((model) => model.id === id)
      if (!match) throw new Error(`Model not found on MLX server: ${id}`)
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
