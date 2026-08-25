export interface LocalInstalledModel {
  id: string
  name: string
  sizeBytes?: number
  quantization?: string
  parameterCount?: number
  family?: string
  contextLength?: number
  toolCalling?: boolean
  vision?: boolean
  reasoning?: boolean
  installedAt?: number
}

export interface RuntimeDetectionResult {
  id: string
  name: string
  available: boolean
  detail?: string
  endpoint?: string
}

/** What a runtime can actually do - the UI and API adapt to this instead of guessing. */
export interface RuntimeCapabilities {
  discovery: boolean
  modelListing: boolean
  modelInstall: boolean
  modelRemoval: boolean
  streaming: boolean
  toolCalling: boolean
  structuredOutput: boolean
  embeddings?: boolean
  vision?: boolean
  benchmark: boolean
  cancellation: boolean
  /** Models are files managed outside Atlas (GGUF files, LM Studio downloads) */
  externalModelFiles?: boolean
}

export type RuntimeHealthState = "available" | "unavailable" | "degraded" | "unsupported"

export interface RuntimeHealth {
  state: RuntimeHealthState
  detail?: string
}

export interface InstallProgress {
  percent?: number
  status: string
}

export interface InstallOptions {
  onProgress?: (progress: InstallProgress) => void
  signal?: AbortSignal
}

export interface ModelRuntimeInfo extends LocalInstalledModel {}

export type ModelLocation = "local" | "cloud"

export interface BenchmarkOptions {
  signal?: AbortSignal
  maxTokens?: number
}

export interface ModelBenchmark {
  success: boolean
  error?: string
  tokensPerSecond?: number
  promptTokensPerSecond?: number
  timeToFirstTokenMs?: number
  memoryUsedBytes?: number
  testedAt: number
}

/**
 * Normalized identity for one runnable model on one runtime. The same logical
 * catalog model+variant may exist as several instances on different runtimes;
 * benchmark/readiness records key off this identity, never display names.
 */
export interface LocalModelInstance {
  /** Logical model id from the catalog when known */
  modelID?: string
  /** Quantization variant id from the catalog when known */
  variantID?: string
  runtimeID: string
  /** Identifier the RUNTIME itself uses (tag, path, or served model name) */
  runtimeModelID: string
}

export const RUNTIME_CAPABILITIES_FULL_LIFECYCLE: RuntimeCapabilities = {
  discovery: true,
  modelListing: true,
  modelInstall: true,
  modelRemoval: true,
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  benchmark: true,
  cancellation: true,
}

export interface LocalRuntimeAdapter {
  id: string
  name: string
  endpoint?: string

  capabilities: RuntimeCapabilities

  detect(): Promise<RuntimeDetectionResult>

  listModels(): Promise<LocalInstalledModel[]>

  health?(): Promise<RuntimeHealth>

  installModel?(model: { id: string }, options?: InstallOptions): Promise<void>

  removeModel?(id: string): Promise<void>

  inspectModel?(id: string): Promise<ModelRuntimeInfo>

  benchmarkModel?(id: string, options?: BenchmarkOptions): Promise<ModelBenchmark>
}
