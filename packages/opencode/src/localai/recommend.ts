import { effectiveVramBytes, type HardwareProfile } from "./hardware"
import type { LocalModelProfile, ModelVariant } from "./catalog"

export type RecommendationPreset = "overall" | "coding" | "agent" | "speed" | "memory" | "context"

export const RECOMMENDATION_PRESETS: RecommendationPreset[] = [
  "overall",
  "coding",
  "agent",
  "speed",
  "memory",
  "context",
]

export type Compatibility = "excellent" | "good" | "usable" | "not_recommended"

export interface ModelRecommendation {
  model: LocalModelProfile
  variant: ModelVariant

  score: number

  compatibility: Compatibility

  reasons: string[]
  warnings: string[]

  estimated?: {
    vramBytes?: number
    ramBytes?: number
    contextLength?: number
  }

  installed?: boolean
}

const GB = 1e9
// RAM reserved for the OS and other processes when models spill into system memory
const OS_RESERVE_BYTES = 2 * GB

const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

// Rough KV-cache cost per token per parameter of model weights (fp16 KV cache,
// GQA-style attention). Deliberately approximate; estimates are labeled as such.
function kvCacheBytesPerToken(parameterCount: number | undefined) {
  if (!parameterCount) return 64 // ~64 bytes/token fallback for unknown architectures
  return parameterCount * 8e-6
}

export function estimateContextMemory(variant: ModelVariant, contextTokens: number, parameterCount?: number) {
  return Math.round(kvCacheBytesPerToken(parameterCount) * contextTokens)
}

export function recommendedContext(profile: LocalModelProfile, variant: ModelVariant, budgetBytes: number): number {
  const max = profile.contextLength ?? 8192
  let best = 4096
  for (const step of CONTEXT_STEPS) {
    const total = (variant.estimatedMemoryBytes ?? 0) + estimateContextMemory(variant, step, profile.parameterCount)
    if (total <= budgetBytes && step <= max) best = step
  }
  return best
}

interface MemoryBudget {
  vramBytes: number
  ramBytes: number
}

export function memoryBudget(profile: HardwareProfile): MemoryBudget {
  return {
    vramBytes: effectiveVramBytes(profile),
    ramBytes: Math.max(0, profile.memory.totalBytes - OS_RESERVE_BYTES),
  }
}

function compatibilityFor(
  requiredBytes: number,
  budget: MemoryBudget,
): { compatibility: Compatibility; offloadBytes: number } {
  if (budget.vramBytes > 0 && requiredBytes <= budget.vramBytes * 0.55) {
    return { compatibility: "excellent", offloadBytes: 0 }
  }
  // Weights plus a useful context window still fit entirely on the GPU
  if (budget.vramBytes > 0 && requiredBytes <= budget.vramBytes * 0.95) {
    return { compatibility: "good", offloadBytes: 0 }
  }
  const offloadBytes = Math.max(0, Math.round(requiredBytes - budget.vramBytes))
  if (offloadBytes <= budget.ramBytes * 0.5) {
    return { compatibility: "usable", offloadBytes }
  }
  return { compatibility: "not_recommended", offloadBytes }
}

// CPU inference is roughly an order of magnitude slower than GPU inference,
// and partial offloading sits in between.
function speedScore(requiredBytes: number, budget: MemoryBudget): number {
  let base: number
  if (requiredBytes < 4 * GB) base = 95
  else if (requiredBytes < 7 * GB) base = 85
  else if (requiredBytes < 12 * GB) base = 72
  else if (requiredBytes < 20 * GB) base = 58
  else if (requiredBytes < 35 * GB) base = 38
  else base = 18

  if (budget.vramBytes === 0) return Math.round(base * 0.35)
  if (requiredBytes > budget.vramBytes) return Math.round(base * 0.6)
  return base
}

const PRESET_WEIGHTS: Record<
  RecommendationPreset,
  { fit: number; coding: number; reasoning: number; speed: number; context: number }
> = {
  overall: { fit: 0.3, coding: 0.3, reasoning: 0.15, speed: 0.15, context: 0.1 },
  coding: { fit: 0.25, coding: 0.5, reasoning: 0.15, speed: 0.1, context: 0 },
  agent: { fit: 0.25, coding: 0.3, reasoning: 0.2, speed: 0.15, context: 0.1 },
  speed: { fit: 0.35, coding: 0.15, reasoning: 0.05, speed: 0.45, context: 0 },
  memory: { fit: 0.5, coding: 0.15, reasoning: 0.05, speed: 0.25, context: 0.05 },
  context: { fit: 0.35, coding: 0.1, reasoning: 0.1, speed: 0.1, context: 0.35 },
}

function contextScore(contextLength: number | undefined) {
  if (!contextLength) return 20
  const clamped = Math.min(contextLength, 131072)
  return Math.round((Math.log2(clamped / 4096) / Math.log2(131072 / 4096)) * 100)
}

export interface RecommendInput {
  hardware: HardwareProfile
  profiles: LocalModelProfile[]
  installedTags?: Set<string>
  preset?: RecommendationPreset
  measuredTokensPerSecond?: Map<string, number>
}

export function recommendModels(input: RecommendInput): ModelRecommendation[] {
  const preset = input.preset ?? "overall"
  const weights = PRESET_WEIGHTS[preset]
  const budget = memoryBudget(input.hardware)

  const recommendations = input.profiles.flatMap((model) => {
    const variant = model.variants[0]
    if (!variant) return []

    const runtimeTag = model.runtimes.ollama
    const installed = input.installedTags?.has(runtimeTag ?? "\u0000") ?? false

    const requiredBytes = variant.estimatedMemoryBytes ?? 0
    const recCtx = recommendedContext(model, variant, budget.vramBytes > 0 ? budget.vramBytes : budget.ramBytes)
    const ctxMemory = estimateContextMemory(variant, recCtx, model.parameterCount)
    const totalRequired = requiredBytes + ctxMemory
    const { compatibility, offloadBytes } = compatibilityFor(totalRequired, budget)
    const speed = speedScore(totalRequired, budget)

    const reasons: string[] = []
    const warnings: string[] = []

    if (compatibility === "excellent") {
      reasons.push("Fits entirely in your GPU memory with room to spare")
      const headroom = Math.round((budget.vramBytes - totalRequired) / GB)
      reasons.push(`Leaves approximately ${headroom} GB VRAM available`)
    } else if (compatibility === "good") {
      reasons.push("Fits on your GPU using most of its memory")
    } else if (compatibility === "usable") {
      warnings.push(
        offloadBytes > 0
          ? `Requires about ${Math.round(offloadBytes / GB)} GB of system memory offloading, which slows generation`
          : "Tight memory headroom; a smaller context window may be needed",
      )
      if (budget.vramBytes === 0) warnings.push("No dedicated GPU detected - generation will be slow")
    } else {
      warnings.push("Likely too large for this machine to run comfortably")
    }

    if ((model.capabilities.coding ?? 0) >= 85) reasons.push("Strong coding performance for its size class")
    if (preset === "agent" || preset === "overall") {
      if (model.capabilities.toolCalling === false)
        warnings.push("Limited tool-calling support - not suitable for agent mode")
      else if (model.capabilities.toolCalling) reasons.push("Supports tool calling")
    }
    if (model.capabilities.vision) reasons.push("Can read images")
    if (recCtx >= 32768) reasons.push(`Comfortably supports ${Math.round(recCtx / 1024)}K context here`)

    const overcommit = totalRequired > budget.vramBytes + budget.ramBytes
    if (overcommit) warnings.push("Needs more memory than this machine has available")

    let score =
      weights.fit *
        (compatibility === "excellent" ? 100 : compatibility === "good" ? 80 : compatibility === "usable" ? 45 : 10) +
      weights.coding * (model.capabilities.coding ?? 50) +
      weights.reasoning * (model.capabilities.reasoning ?? 50) +
      weights.speed * speed +
      weights.context * contextScore(model.contextLength)

    if (preset === "agent") {
      if (model.capabilities.agentCompatible) score += 8
      if (model.capabilities.toolCalling === false) score = Math.min(score, 35)
    }
    if (installed) score += 4

    // Measured throughput replaces the generic size-based speed guess
    const measured = runtimeTag ? input.measuredTokensPerSecond?.get(runtimeTag) : undefined
    if (measured) {
      const measuredSpeed = Math.min(100, Math.log10(Math.max(measured, 0.1)) * 33 + 66)
      score = score - weights.speed * speed + weights.speed * measuredSpeed
      reasons.push(`Measured at about ${measured.toFixed(1)} tokens/sec on this machine`)
    }

    score = Math.max(0, Math.min(100, score))

    return [
      {
        model,
        variant,
        score: Math.round(score),
        compatibility,
        reasons,
        warnings,
        estimated: {
          vramBytes: Math.min(totalRequired, budget.vramBytes),
          ramBytes: offloadBytes > 0 ? offloadBytes : undefined,
          contextLength: recCtx,
        },
        installed,
      } satisfies ModelRecommendation,
    ]
  })

  return recommendations.sort((a, b) => b.score - a.score)
}
