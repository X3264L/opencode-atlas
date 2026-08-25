import type { LocalRuntimeAdapter, RuntimeDetectionResult } from "./runtime-types"
import { createLMStudioAdapter } from "./runtime/lmstudio"
import { createLlamaCppAdapter } from "./runtime/llamacpp"
import { createMlxAdapter } from "./runtime/mlx"
import { createOllamaAdapter } from "./runtime/ollama"

// Central runtime registry. Adapters are constructed per call so env-based
// endpoint overrides stay fresh; detection runs in parallel with independent
// failure boundaries - one dead runtime never breaks the others.

export type RuntimeID = "ollama" | "lmstudio" | "llamacpp" | "mlx"

export function createRuntimeAdapters(env?: Record<string, string | undefined>): LocalRuntimeAdapter[] {
  return [
    createOllamaAdapter(env ? { env } : undefined),
    createLMStudioAdapter(env ? { env } : undefined),
    createLlamaCppAdapter(env ? { env } : undefined),
    createMlxAdapter(env ? { env } : undefined),
  ]
}

export function getRuntimeAdapter(
  id: string,
  env?: Record<string, string | undefined>,
): LocalRuntimeAdapter | undefined {
  return createRuntimeAdapters(env).find((adapter) => adapter.id === id)
}

/** Adapters that can actually serve inference on this machine right now */
export async function availableRuntimeAdapters(
  env?: Record<string, string | undefined>,
): Promise<LocalRuntimeAdapter[]> {
  const adapters = createRuntimeAdapters(env)
  const detections = await Promise.all(adapters.map((adapter) => adapter.detect().catch(() => null)))
  return adapters.filter((adapter, index) => detections[index]?.available && adapter.capabilities.modelListing)
}

export interface RuntimeDetectionSet {
  runtimes: RuntimeDetectionResult[]
  /** Adapters whose detect() reported available, ready for further use */
  available: LocalRuntimeAdapter[]
  all: LocalRuntimeAdapter[]
}

export async function detectAllRuntimes(env?: Record<string, string | undefined>): Promise<RuntimeDetectionSet> {
  const adapters = createRuntimeAdapters(env)
  const detections = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.detect()
      } catch {
        return {
          id: adapter.id,
          name: adapter.name,
          available: false,
          ...(adapter.endpoint ? { endpoint: adapter.endpoint } : {}),
          detail: "detection failed",
        } satisfies RuntimeDetectionResult
      }
    }),
  )
  const available = adapters.filter((_, index) => detections[index].available)
  return { runtimes: detections, available, all: adapters }
}
