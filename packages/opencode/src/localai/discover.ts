import { createOllamaAdapter, resolveOllamaEndpoint } from "./runtime/ollama"

// Plain-data result so consumers (e.g. the provider registry) can build their
// own model representations without importing localai internals.
export interface DiscoveredLocalModel {
  id: string
  name: string
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

// Best-effort discovery - returns undefined instead of throwing when Ollama
// is absent or unreachable, so callers can stay failure-free.
export async function discoverLocalOllamaModels(): Promise<DiscoveredLocalRuntime | undefined> {
  try {
    const adapter = createOllamaAdapter()
    const detection = await adapter.detect()
    if (!detection.available) return undefined
    const models = await adapter.listModels()
    return {
      runtime: "ollama",
      endpoint: resolveOllamaEndpoint(),
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.family ? { family: model.family } : {}),
        ...(model.parameterCount !== undefined ? { parameterCount: model.parameterCount } : {}),
        ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
        ...(model.quantization ? { quantization: model.quantization } : {}),
        ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
        toolCalling: model.toolCalling ?? false,
        vision: model.vision ?? false,
      })),
    }
  } catch {
    return undefined
  }
}
