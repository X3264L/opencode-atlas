import type { LocalInstalledModel } from "./runtime-types"
import { detectAllRuntimes } from "./runtime-registry"

// Plain-data results so consumers (e.g. the provider registry) can build their
// own model representations without importing localai internals.
export interface DiscoveredLocalModel {
  id: string
  name: string
  runtimeID: string
  family?: string
  parameterCount?: number
  sizeBytes?: number
  quantization?: string
  contextLength?: number
  toolCalling?: boolean
  vision?: boolean
}

export interface DiscoveredLocalRuntime {
  runtime: string
  endpoint: string
  models: DiscoveredLocalModel[]
}

function toDiscovered(runtimeID: string, model: LocalInstalledModel): DiscoveredLocalModel {
  return {
    id: model.id,
    name: model.name,
    runtimeID,
    ...(model.family ? { family: model.family } : {}),
    ...(model.parameterCount !== undefined ? { parameterCount: model.parameterCount } : {}),
    ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
    ...(model.quantization ? { quantization: model.quantization } : {}),
    ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    toolCalling: model.toolCalling ?? false,
    vision: model.vision ?? false,
  }
}

/**
 * Discover models on every available local runtime. Each runtime is an
 * independent failure boundary - a dead runtime yields no entry instead of
 * throwing, so callers can stay failure-free.
 */
export async function discoverLocalRuntimes(): Promise<DiscoveredLocalRuntime[]> {
  const { available } = await detectAllRuntimes()
  const results = await Promise.all(
    available.map(async (adapter): Promise<DiscoveredLocalRuntime | undefined> => {
      try {
        const models = await adapter.listModels()
        if (models.length === 0) return undefined
        return {
          runtime: adapter.id,
          endpoint: adapter.endpoint ?? "",
          models: models.map((model) => toDiscovered(adapter.id, model)),
        }
      } catch {
        return undefined
      }
    }),
  )
  return results.filter((entry): entry is DiscoveredLocalRuntime => entry !== undefined)
}
