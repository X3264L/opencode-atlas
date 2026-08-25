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

export interface LocalRuntimeAdapter {
  id: string
  name: string
  endpoint?: string

  detect(): Promise<RuntimeDetectionResult>

  listModels(): Promise<LocalInstalledModel[]>

  installModel?(model: { id: string }, options?: InstallOptions): Promise<void>

  removeModel?(id: string): Promise<void>

  inspectModel?(id: string): Promise<ModelRuntimeInfo>

  benchmarkModel?(id: string, options?: BenchmarkOptions): Promise<ModelBenchmark>
}
