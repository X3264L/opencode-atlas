import { effectiveVramBytes, type HardwareProfile } from "./hardware"
import type { ModelVariant } from "./catalog"

// Central memory-estimation model for local LLMs. All numbers here are
// deliberately conservative estimates - never presented to users as measured
// facts unless a local benchmark produced the value.
const GB = 1e9
export const GB_BYTES = GB

export const MEMORY_MODEL = {
  // RAM the OS and other processes need when models spill into system memory
  osReserveBytes: 2 * GB,
  // CUDA/metal runtime + compute buffers on top of weights and KV cache
  runtimeOverheadBytes: 0.75 * GB,
  // Fraction of VRAM kept as safety reserve so the desktop and other apps
  // keep working while the model is loaded
  vramSafetyFraction: 0.12,
  // Maximum share of the (post-reserve) RAM budget usable for CPU offload
  ramOffloadFraction: 0.5,
  // Share of Apple unified memory the GPU can realistically address
  appleUnifiedUsableFraction: 0.7,
  // Minimum context window ever recommended
  minContextTokens: 4096,
} as const

export interface MemoryBudget {
  /** Raw detectable GPU/unified budget before safety reserve */
  vramBytes: number
  /** GPU budget minus the safety reserve - what a working set may actually consume */
  vramSafeBytes: number
  /** System RAM available for offload after OS reserve */
  ramBudgetBytes: number
}

export function memoryBudgets(hardware: HardwareProfile): MemoryBudget {
  const raw = effectiveVramBytes(hardware)
  return {
    vramBytes: raw,
    vramSafeBytes: Math.round(raw * (1 - MEMORY_MODEL.vramSafetyFraction)),
    ramBudgetBytes: Math.max(0, hardware.memory.totalBytes - MEMORY_MODEL.osReserveBytes),
  }
}

// Rough KV-cache cost per token per parameter of model weights (fp16 KV cache,
// GQA-style attention). Deliberately approximate; estimates are labeled as such.
function kvCacheBytesPerToken(parameterCount: number | undefined) {
  if (!parameterCount) return 64 // ~64 bytes/token fallback for unknown architectures
  return parameterCount * 8e-6
}

export function estimateContextMemory(variant: ModelVariant, contextTokens: number, parameterCount?: number) {
  return Math.round(kvCacheBytesPerToken(parameterCount) * contextTokens)
}

export function variantWeightBytes(variant: ModelVariant) {
  return variant.estimatedWeightBytes ?? variant.estimatedMemoryBytes ?? variant.downloadSizeBytes ?? 0
}

export interface WorkingSet {
  weightsBytes: number
  kvCacheBytes: number
  overheadBytes: number
  totalBytes: number
}

export function estimateWorkingSet(options: {
  variant: ModelVariant
  parameterCount?: number
  contextTokens: number
}): WorkingSet {
  const weights = variantWeightBytes(options.variant)
  const kv = estimateContextMemory(options.variant, options.contextTokens, options.parameterCount)
  const overhead =
    options.contextTokens > 0 || weights > 0 ? Math.max(MEMORY_MODEL.runtimeOverheadBytes, Math.round(weights * 0.04)) : 0
  return {
    weightsBytes: weights,
    kvCacheBytes: kv,
    overheadBytes: overhead,
    totalBytes: weights + kv + overhead,
  }
}

export const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

export interface ContextPlan {
  /** Largest context step whose full working set fits within the safe GPU budget */
  recommended: number
  /** Largest context step that fits before crossing into RAM offload territory */
  comfortableMaximum?: number
}

export function planContext(options: {
  profile: { contextLength?: number }
  variant: ModelVariant
  parameterCount?: number
  budget: MemoryBudget
}): ContextPlan {
  const max = options.profile.contextLength ?? MEMORY_MODEL.minContextTokens
  let recommended: number = MEMORY_MODEL.minContextTokens
  let comfortableMaximum: number | undefined

  for (const step of CONTEXT_STEPS) {
    if (step > max) break
    const workingSet = estimateWorkingSet({
      variant: options.variant,
      parameterCount: options.parameterCount,
      contextTokens: step,
    })
    if (options.budget.vramSafeBytes > 0 && workingSet.totalBytes <= options.budget.vramSafeBytes) {
      recommended = step
      comfortableMaximum = step
      continue
    }
    if (
      comfortableMaximum === undefined &&
      options.budget.vramSafeBytes > 0 &&
      options.budget.vramBytes + options.budget.ramBudgetBytes >= workingSet.totalBytes
    ) {
      // Fits only with offload - record where the comfortable zone ends
      break
    }
    if (options.budget.vramSafeBytes === 0 && workingSet.totalBytes <= options.budget.ramBudgetBytes * MEMORY_MODEL.ramOffloadFraction) {
      recommended = step
    }
  }

  return { recommended, ...(comfortableMaximum !== undefined ? { comfortableMaximum } : {}) }
}
