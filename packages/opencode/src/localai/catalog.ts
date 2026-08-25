// Curated catalog of local coding/agent models. Data here is ESTIMATED and
// exists so the recommendation engine has metadata to work with; measured
// benchmark results always take priority when available. Kept isolated so it
// can later be generated or remotely updated without touching UI or logic.

export interface ModelVariant {
  id: string
  quantization?: string
  downloadSizeBytes?: number
  estimatedMemoryBytes?: number
}

export interface LocalModelProfile {
  id: string
  name: string
  family?: string
  parameterCount?: number
  variants: ModelVariant[]
  capabilities: {
    coding?: number
    reasoning?: number
    toolCalling?: boolean
    vision?: boolean
    agentCompatible?: boolean
  }
  contextLength?: number
  runtimes: {
    ollama?: string
  }
}

const GB = 1e9

function gb(value: number) {
  return Math.round(value * GB)
}

export const LOCAL_MODEL_CATALOG: LocalModelProfile[] = [
  {
    id: "qwen3-coder-flash",
    name: "Qwen3 Coder 30B",
    family: "qwen3",
    parameterCount: 30.5e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(18.6), estimatedMemoryBytes: gb(24) }],
    capabilities: { coding: 92, reasoning: 75, toolCalling: true, agentCompatible: true },
    contextLength: 262144,
    runtimes: { ollama: "qwen3-coder:30b" },
  },
  {
    id: "qwen2.5-coder-32b",
    name: "Qwen2.5 Coder 32B",
    family: "qwen2.5",
    parameterCount: 32.8e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(19.9), estimatedMemoryBytes: gb(25) }],
    capabilities: { coding: 89, reasoning: 72, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:32b" },
  },
  {
    id: "qwen2.5-coder-14b",
    name: "Qwen2.5 Coder 14B",
    family: "qwen2.5",
    parameterCount: 14.8e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(9.0), estimatedMemoryBytes: gb(12) }],
    capabilities: { coding: 86, reasoning: 70, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:14b" },
  },
  {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5 Coder 7B",
    family: "qwen2.5",
    parameterCount: 7.6e9,
    variants: [
      { id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(4.7), estimatedMemoryBytes: gb(6.5) },
      { id: "q8", quantization: "Q8_0", downloadSizeBytes: gb(8.1), estimatedMemoryBytes: gb(10.5) },
    ],
    capabilities: { coding: 82, reasoning: 65, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:7b" },
  },
  {
    id: "qwen2.5-coder-3b",
    name: "Qwen2.5 Coder 3B",
    family: "qwen2.5",
    parameterCount: 3.1e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(1.9), estimatedMemoryBytes: gb(3.2) }],
    capabilities: { coding: 74, reasoning: 58, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:3b" },
  },
  {
    id: "gpt-oss-20b",
    name: "GPT-OSS 20B",
    family: "gpt-oss",
    parameterCount: 20.9e9,
    variants: [{ id: "default", quantization: "MXFP4", downloadSizeBytes: gb(13), estimatedMemoryBytes: gb(16) }],
    capabilities: { coding: 88, reasoning: 90, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "gpt-oss:20b" },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    family: "gpt-oss",
    parameterCount: 116.8e9,
    variants: [{ id: "default", quantization: "MXFP4", downloadSizeBytes: gb(64), estimatedMemoryBytes: gb(83) }],
    capabilities: { coding: 93, reasoning: 94, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "gpt-oss:120b" },
  },
  {
    id: "devstral-24b",
    name: "Devstral Small 24B",
    family: "devstral",
    parameterCount: 23.6e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(14.3), estimatedMemoryBytes: gb(18) }],
    capabilities: { coding: 85, reasoning: 74, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "devstral:24b" },
  },
  {
    id: "mistral-small-24b",
    name: "Mistral Small 3.2 24B",
    family: "mistral",
    parameterCount: 24.0e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(15), estimatedMemoryBytes: gb(19) }],
    capabilities: { coding: 83, reasoning: 78, toolCalling: true, vision: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "mistral-small3.2:24b" },
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    family: "qwen3",
    parameterCount: 14.8e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(9.3), estimatedMemoryBytes: gb(13) }],
    capabilities: { coding: 84, reasoning: 84, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "qwen3:14b" },
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    family: "qwen3",
    parameterCount: 8.2e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(5.2), estimatedMemoryBytes: gb(7.5) }],
    capabilities: { coding: 80, reasoning: 82, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "qwen3:8b" },
  },
  {
    id: "phi4-14b",
    name: "Phi 4 14B",
    family: "phi",
    parameterCount: 14.7e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(9.1), estimatedMemoryBytes: gb(12) }],
    capabilities: { coding: 81, reasoning: 76, toolCalling: true, agentCompatible: true },
    contextLength: 16384,
    runtimes: { ollama: "phi4:14b" },
  },
  {
    id: "glm4-9b",
    name: "GLM 4 9B",
    family: "glm",
    parameterCount: 9.3e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(5.6), estimatedMemoryBytes: gb(8) }],
    capabilities: { coding: 78, reasoning: 72, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "glm4:9b" },
  },
  {
    id: "llama3.1-8b",
    name: "Llama 3.1 8B",
    family: "llama",
    parameterCount: 8.0e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(4.9), estimatedMemoryBytes: gb(6.9) }],
    capabilities: { coding: 70, reasoning: 66, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "llama3.1:8b" },
  },
  {
    id: "deepseek-r1-14b",
    name: "DeepSeek R1 Distill 14B",
    family: "deepseek-r1",
    parameterCount: 14.8e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(9.0), estimatedMemoryBytes: gb(12) }],
    capabilities: { coding: 76, reasoning: 87, toolCalling: false, agentCompatible: false },
    contextLength: 131072,
    runtimes: { ollama: "deepseek-r1:14b" },
  },
  {
    id: "deepseek-r1-8b",
    name: "DeepSeek R1 Distill 8B",
    family: "deepseek-r1",
    parameterCount: 8.0e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(4.9), estimatedMemoryBytes: gb(6.7) }],
    capabilities: { coding: 72, reasoning: 85, toolCalling: false, agentCompatible: false },
    contextLength: 131072,
    runtimes: { ollama: "deepseek-r1:8b" },
  },
  {
    id: "gemma3-27b",
    name: "Gemma 3 27B",
    family: "gemma3",
    parameterCount: 27.4e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(17), estimatedMemoryBytes: gb(22) }],
    capabilities: { coding: 79, reasoning: 80, toolCalling: false, vision: true },
    contextLength: 131072,
    runtimes: { ollama: "gemma3:27b" },
  },
  {
    id: "gemma3-12b",
    name: "Gemma 3 12B",
    family: "gemma3",
    parameterCount: 12.2e9,
    variants: [{ id: "default", quantization: "Q4_K_M", downloadSizeBytes: gb(8.1), estimatedMemoryBytes: gb(11) }],
    capabilities: { coding: 74, reasoning: 74, toolCalling: false, vision: true },
    contextLength: 131072,
    runtimes: { ollama: "gemma3:12b" },
  },
]

export function findCatalogProfile(id: string): LocalModelProfile | undefined {
  return LOCAL_MODEL_CATALOG.find((profile) => profile.id === id)
}

// Match an installed runtime model back to its catalog entry by ollama tag.
export function findCatalogProfileByRuntimeTag(runtime: "ollama", tag: string): LocalModelProfile | undefined {
  return LOCAL_MODEL_CATALOG.find((profile) => profile.runtimes[runtime] === tag)
}
