// Curated catalog of local coding/agent models. Data here is ESTIMATED and
// exists so the recommendation engine has metadata to work with; measured
// benchmark results always take priority when available. Kept isolated so it
// can later be generated or remotely updated without touching UI or logic.
//
// Quantization guidance:
// - Each variant may carry its own Ollama runtime tag. The DEFAULT variant
//   uses the model's primary library tag (guaranteed to exist). Higher-quality
//   quants follow Ollama's documented `{tag}-q{N}` naming convention; their
//   availability depends on what the registry publishes for that model. If a
//   tag does not exist, the pull fails with Ollama's own error message - we
//   never pretend a quantization was installed.

export interface ModelVariant {
  id: string
  /** Runtime identifier used to install exactly this variant */
  runtimeTag?: string

  quantization?: string

  downloadSizeBytes?: number

  /** Weight footprint once loaded (excludes KV cache and runtime overhead) */
  estimatedWeightBytes?: number

  /**
   * Expected output quality relative to full precision (1.0 = near-lossless).
   * ESTIMATE derived from public perplexity deltas, not measured locally.
   */
  qualityMultiplier?: number

  /**
   * Relative generation speed vs the baseline quantization for this model
   * (larger quants are slower because inference is memory-bandwidth bound).
   */
  speedMultiplier?: number

  notes?: string[]

  /** @deprecated legacy field kept for compatibility; prefer estimatedWeightBytes */
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

// Approximate bytes-per-weight by quantization (GGUF k-quant family).
const QUANT_PROFILE: Record<string, { bpw: number; quality: number; speed: number }> = {
  Q4_K_M: { bpw: 4.85, quality: 0.955, speed: 1.06 },
  Q5_K_M: { bpw: 5.65, quality: 0.972, speed: 1.03 },
  Q6_K: { bpw: 6.6, quality: 0.985, speed: 1.0 },
  Q8_0: { bpw: 8.5, quality: 1.0, speed: 0.93 },
}

function gb(value: number) {
  return Math.round(value * GB)
}

interface QuantSpec {
  quant: keyof typeof QUANT_PROFILE
  /** Suffix appended to the base tag; empty for the default library tag */
  suffix?: string
  notes?: string[]
}

// Build quantization variants for a dense model. Sizes are derived from
// parameter count using approximate bits-per-weight, so they stay internally
// consistent instead of hand-maintained magic numbers.
function quantVariants(
  baseTag: string,
  parameterCount: number,
  specs: QuantSpec[],
): ModelVariant[] {
  return specs.map((spec) => {
    const profile = QUANT_PROFILE[spec.quant]
    // bpw is BITS per weight - convert to bytes
    const weights = Math.round((parameterCount * profile.bpw) / 8 / 1e6) * 1_000_000
    const isDefault = !spec.suffix
    return {
      id: isDefault ? "default" : spec.quant.toLowerCase(),
      runtimeTag: isDefault ? baseTag : `${baseTag}${spec.suffix}`,
      quantization: spec.quant,
      downloadSizeBytes: weights,
      estimatedWeightBytes: weights,
      qualityMultiplier: profile.quality,
      speedMultiplier: profile.speed,
      ...(spec.notes ? { notes: spec.notes } : {}),
    } satisfies ModelVariant
  })
}

export const LOCAL_MODEL_CATALOG: LocalModelProfile[] = [
  {
    id: "qwen3-coder-flash",
    name: "Qwen3 Coder 30B",
    family: "qwen3",
    parameterCount: 30.5e9,
    variants: quantVariants("qwen3-coder:30b", 30.5e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
    ]),
    capabilities: { coding: 92, reasoning: 75, toolCalling: true, agentCompatible: true },
    contextLength: 262144,
    runtimes: { ollama: "qwen3-coder:30b" },
  },
  {
    id: "qwen2.5-coder-32b",
    name: "Qwen2.5 Coder 32B",
    family: "qwen2.5",
    parameterCount: 32.8e9,
    variants: quantVariants("qwen2.5-coder:32b", 32.8e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
    ]),
    capabilities: { coding: 89, reasoning: 72, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:32b" },
  },
  {
    id: "qwen2.5-coder-14b",
    name: "Qwen2.5 Coder 14B",
    family: "qwen2.5",
    parameterCount: 14.8e9,
    variants: quantVariants("qwen2.5-coder:14b", 14.8e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 86, reasoning: 70, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:14b" },
  },
  {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5 Coder 7B",
    family: "qwen2.5",
    parameterCount: 7.6e9,
    variants: quantVariants("qwen2.5-coder:7b", 7.6e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 82, reasoning: 65, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:7b" },
  },
  {
    id: "qwen2.5-coder-3b",
    name: "Qwen2.5 Coder 3B",
    family: "qwen2.5",
    parameterCount: 3.1e9,
    variants: quantVariants("qwen2.5-coder:3b", 3.1e9, [
      { quant: "Q4_K_M" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 74, reasoning: 58, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "qwen2.5-coder:3b" },
  },
  {
    // gpt-oss ships as native MXFP4; other quants are not published
    id: "gpt-oss-20b",
    name: "GPT-OSS 20B",
    family: "gpt-oss",
    parameterCount: 20.9e9,
    variants: [
      {
        id: "default",
        quantization: "MXFP4",
        downloadSizeBytes: gb(13),
        estimatedWeightBytes: gb(13),
        qualityMultiplier: 0.97,
        speedMultiplier: 1.05,
        notes: ["Native MXFP4 build - this is the quantization OpenAI trained the model for"],
      },
    ],
    capabilities: { coding: 88, reasoning: 90, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "gpt-oss:20b" },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    family: "gpt-oss",
    parameterCount: 116.8e9,
    variants: [
      {
        id: "default",
        quantization: "MXFP4",
        downloadSizeBytes: gb(64),
        estimatedWeightBytes: gb(64),
        qualityMultiplier: 0.97,
        speedMultiplier: 1.0,
        notes: ["Requires very high end hardware or a large unified-memory machine"],
      },
    ],
    capabilities: { coding: 93, reasoning: 94, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "gpt-oss:120b" },
  },
  {
    id: "devstral-24b",
    name: "Devstral Small 24B",
    family: "devstral",
    parameterCount: 23.6e9,
    variants: quantVariants("devstral:24b", 23.6e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
    ]),
    capabilities: { coding: 85, reasoning: 74, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "devstral:24b" },
  },
  {
    id: "mistral-small-24b",
    name: "Mistral Small 3.2 24B",
    family: "mistral",
    parameterCount: 24.0e9,
    variants: quantVariants("mistral-small3.2:24b", 24.0e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
    ]),
    capabilities: { coding: 83, reasoning: 78, toolCalling: true, vision: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "mistral-small3.2:24b" },
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    family: "qwen3",
    parameterCount: 14.8e9,
    variants: quantVariants("qwen3:14b", 14.8e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 84, reasoning: 84, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "qwen3:14b" },
  },
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    family: "qwen3",
    parameterCount: 8.2e9,
    variants: quantVariants("qwen3:8b", 8.2e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 80, reasoning: 82, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "qwen3:8b" },
  },
  {
    id: "phi4-14b",
    name: "Phi 4 14B",
    family: "phi",
    parameterCount: 14.7e9,
    variants: quantVariants("phi4:14b", 14.7e9, [{ quant: "Q4_K_M" }, { quant: "Q6_K", suffix: "-q6_K" }]),
    capabilities: { coding: 81, reasoning: 76, toolCalling: true, agentCompatible: true },
    contextLength: 16384,
    runtimes: { ollama: "phi4:14b" },
  },
  {
    id: "glm4-9b",
    name: "GLM 4 9B",
    family: "glm",
    parameterCount: 9.3e9,
    variants: quantVariants("glm4:9b", 9.3e9, [{ quant: "Q4_K_M" }, { quant: "Q6_K", suffix: "-q6_K" }]),
    capabilities: { coding: 78, reasoning: 72, toolCalling: true, agentCompatible: true },
    contextLength: 32768,
    runtimes: { ollama: "glm4:9b" },
  },
  {
    id: "llama3.1-8b",
    name: "Llama 3.1 8B",
    family: "llama",
    parameterCount: 8.0e9,
    variants: quantVariants("llama3.1:8b", 8.0e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
      { quant: "Q8_0", suffix: "-q8_0" },
    ]),
    capabilities: { coding: 70, reasoning: 66, toolCalling: true, agentCompatible: true },
    contextLength: 131072,
    runtimes: { ollama: "llama3.1:8b" },
  },
  {
    id: "deepseek-r1-14b",
    name: "DeepSeek R1 Distill 14B",
    family: "deepseek-r1",
    parameterCount: 14.8e9,
    variants: quantVariants("deepseek-r1:14b", 14.8e9, [
      { quant: "Q4_K_M" },
      { quant: "Q6_K", suffix: "-q6_K" },
    ]),
    capabilities: { coding: 76, reasoning: 87, toolCalling: false, agentCompatible: false },
    contextLength: 131072,
    runtimes: { ollama: "deepseek-r1:14b" },
  },
  {
    id: "deepseek-r1-8b",
    name: "DeepSeek R1 Distill 8B",
    family: "deepseek-r1",
    parameterCount: 8.0e9,
    variants: quantVariants("deepseek-r1:8b", 8.0e9, [{ quant: "Q4_K_M" }, { quant: "Q8_0", suffix: "-q8_0" }]),
    capabilities: { coding: 72, reasoning: 85, toolCalling: false, agentCompatible: false },
    contextLength: 131072,
    runtimes: { ollama: "deepseek-r1:8b" },
  },
  {
    id: "gemma3-27b",
    name: "Gemma 3 27B",
    family: "gemma3",
    parameterCount: 27.4e9,
    variants: quantVariants("gemma3:27b", 27.4e9, [{ quant: "Q4_K_M" }, { quant: "Q6_K", suffix: "-q6_K" }]),
    capabilities: { coding: 79, reasoning: 80, toolCalling: false, vision: true },
    contextLength: 131072,
    runtimes: { ollama: "gemma3:27b" },
  },
  {
    id: "gemma3-12b",
    name: "Gemma 3 12B",
    family: "gemma3",
    parameterCount: 12.2e9,
    variants: quantVariants("gemma3:12b", 12.2e9, [{ quant: "Q4_K_M" }, { quant: "Q8_0", suffix: "-q8_0" }]),
    capabilities: { coding: 74, reasoning: 74, toolCalling: false, vision: true },
    contextLength: 131072,
    runtimes: { ollama: "gemma3:12b" },
  },
]

/** Resolve the runtime identifier that installs exactly this variant. */
export function variantRuntimeTag(profile: LocalModelProfile, variant: ModelVariant): string | undefined {
  if (variant.runtimeTag) return variant.runtimeTag
  return profile.runtimes.ollama
}

export function findCatalogProfile(id: string): LocalModelProfile | undefined {
  return LOCAL_MODEL_CATALOG.find((profile) => profile.id === id)
}

export function findCatalogVariant(profile: LocalModelProfile, variantID: string | undefined): ModelVariant {
  if (variantID) {
    const match = profile.variants.find((variant) => variant.id === variantID)
    if (match) return match
  }
  return profile.variants[0]
}

// Match an installed runtime model back to its catalog entry by ollama tag.
export function findCatalogProfileByRuntimeTag(runtime: "ollama", tag: string): LocalModelProfile | undefined {
  return LOCAL_MODEL_CATALOG.find((profile) =>
    profile.variants.some((variant) => variantRuntimeTag(profile, variant) === tag),
  )
}
