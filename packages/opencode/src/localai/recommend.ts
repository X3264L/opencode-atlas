import type { HardwareProfile } from "./hardware"
import type { LocalModelProfile, ModelVariant } from "./catalog"
import { variantRuntimeTag } from "./catalog"
import {
  CONTEXT_STEPS,
  MEMORY_MODEL,
  estimateContextMemory,
  estimateWorkingSet,
  memoryBudgets,
  planContext,
  variantWeightBytes,
  type MemoryBudget,
} from "./memory-model"

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

/** How much of the model spills out of GPU memory into system RAM */
export type OffloadLevel = "none" | "partial" | "heavy" | "cpu_dominant"

/** How trustworthy this recommendation is - surfaced honestly in the UI */
export type RecommendationConfidence = "high" | "medium" | "low"

/** Distinguishes catalog estimates from locally measured results */
export type MetricSource = "estimated" | "measured"

const GB = 1e9

export interface WorkingSetEstimate {
  weightsBytes: number
  kvCacheBytes: number
  overheadBytes: number
  reserveBytes: number
  totalBytes: number
}

export interface VariantEvaluation {
  variant: ModelVariant
  runtimeTag?: string

  score: number
  compatibility: Compatibility
  offload: OffloadLevel

  reasons: string[]
  warnings: string[]

  estimated: WorkingSetEstimate & {
    vramBytes: number
    ramBytes?: number
    contextLength: number
    comfortableMaximumContext?: number
    headroomBytes?: number
    downloadBytes?: number
  }

  recommended: boolean

  /** Present only when a local benchmark measured this exact variant */
  measuredTokensPerSecond?: number
  metricSource: MetricSource
}

/** Evidence-backed runtime selection for this model+variant */
export interface RuntimeChoiceSummary {
  id: string
  source: "measured" | "preference" | "heuristic" | "none"
  reasons: { kind: "positive" | "caveat"; text: string }[]
}

export interface ModelRecommendation {
  model: LocalModelProfile
  /** The best variant for this machine */
  variant: ModelVariant

  score: number

  compatibility: Compatibility
  offload: OffloadLevel
  confidence: RecommendationConfidence

  reasons: string[]
  warnings: string[]

  estimated?: VariantEvaluation["estimated"]

  installed?: boolean

  /** All evaluated variants of this model, best first */
  alternatives: VariantEvaluation[]

  /** Locally measured OpenCode agent readiness score (0-100) if tested */
  readinessScore?: number

  /** Which runtime should serve this model, when one can */
  runtime?: RuntimeChoiceSummary
}

function classifyOffload(requiredBytes: number, budget: MemoryBudget): OffloadLevel {
  if (budget.vramSafeBytes <= 0) return requiredBytes > 0 ? "cpu_dominant" : "none"
  const offloadBytes = requiredBytes - budget.vramSafeBytes
  if (offloadBytes <= 0) return "none"
  const fraction = offloadBytes / Math.max(requiredBytes, 1)
  if (fraction <= 0.25) return "partial"
  return "heavy"
}

interface FitResult {
  compatibility: Compatibility
  offload: OffloadLevel
  offloadBytes: number
  headroomBytes: number
}

function compatibilityFor(workingSet: WorkingSetEstimate, budget: MemoryBudget): FitResult {
  const offload = classifyOffload(workingSet.totalBytes, budget)
  const offloadBytes = Math.max(0, Math.round(workingSet.totalBytes - budget.vramSafeBytes))
  const headroomBytes = Math.max(0, budget.vramSafeBytes - workingSet.totalBytes)

  if (offload === "none") {
    if (workingSet.totalBytes <= budget.vramSafeBytes * 0.62) {
      return { compatibility: "excellent", offload, offloadBytes: 0, headroomBytes }
    }
    // Weights plus a useful context still fit entirely within the safe GPU zone
    return { compatibility: "good", offload, offloadBytes: 0, headroomBytes }
  }
  if (offloadBytes <= budget.ramBudgetBytes * MEMORY_MODEL.ramOffloadFraction) {
    return { compatibility: "usable", offload, offloadBytes, headroomBytes: 0 }
  }
  return { compatibility: "not_recommended", offload, offloadBytes, headroomBytes: 0 }
}

// CPU inference is roughly an order of magnitude slower than GPU inference;
// partial offloading sits in between.
const OFFLOAD_SPEED_FACTOR: Record<OffloadLevel, number> = {
  none: 1,
  partial: 0.7,
  heavy: 0.45,
  cpu_dominant: 0.3,
}

const SPEED_SCORE_CEILING = 95
const SPEED_SCORE_FLOOR = 15

// Speed decays smoothly and monotonically with working-set size: every doubling
// of memory footprint costs a fixed number of points. The previous discrete
// buckets created ranking cliffs where a few hundred MB flipped a recommendation.
export function baseSpeedScore(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return SPEED_SCORE_CEILING
  const raw = 100 - 16 * Math.log2(totalBytes / (2 * GB))
  return Math.min(SPEED_SCORE_CEILING, Math.max(SPEED_SCORE_FLOOR, raw))
}

const MEASURED_SPEED_FLOOR = 10

// Maps locally measured tok/s onto the same 0-100 scale as the speed estimate.
// Logarithmic so doubling real throughput adds a fixed number of points; slow
// measurements must lower a recommendation relative to estimates, not raise it.
export function measuredThroughputScore(tokensPerSecond: number): number {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return MEASURED_SPEED_FLOOR
  const raw = 25 + 13.5 * Math.log2(tokensPerSecond)
  return Math.min(100, Math.max(MEASURED_SPEED_FLOOR, raw))
}

// Old builds may have persisted zeros or garbage benchmark values - only trust
// plausible positive rates so a bad measurement cannot poison the ranking.
function plausibleMeasurement(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

// Score practical context capacity on THIS machine, not theoretical maximum.
function contextScore(contextTokens: number | undefined) {
  if (!contextTokens) return 20
  const clamped = Math.min(contextTokens, 131072)
  return Math.round((Math.log2(clamped / 4096) / Math.log2(131072 / 4096)) * 100)
}

const PRESET_WEIGHTS: Record<
  RecommendationPreset,
  { fit: number; coding: number; reasoning: number; speed: number; context: number; quality: number }
> = {
  overall: { fit: 0.27, coding: 0.29, reasoning: 0.13, speed: 0.13, context: 0.08, quality: 0.1 },
  coding: { fit: 0.2, coding: 0.49, reasoning: 0.14, speed: 0.05, context: 0.04, quality: 0.08 },
  agent: { fit: 0.25, coding: 0.26, reasoning: 0.18, speed: 0.13, context: 0.08, quality: 0.1 },
  speed: { fit: 0.31, coding: 0.12, reasoning: 0.05, speed: 0.44, context: 0.04, quality: 0.04 },
  memory: { fit: 0.5, coding: 0.13, reasoning: 0.05, speed: 0.21, context: 0.06, quality: 0.05 },
  context: { fit: 0.3, coding: 0.08, reasoning: 0.08, speed: 0.09, context: 0.38, quality: 0.07 },
}

// Non-fit score components shrink when the model must offload - a model that
// needs heavy CPU offload should not outrank a smaller one that runs on-GPU.
const OFFLOAD_PENALTY: Record<OffloadLevel, number> = {
  none: 1,
  partial: 0.82,
  heavy: 0.5,
  cpu_dominant: 0.4,
}

function formatGb(bytes: number) {
  const value = bytes / GB
  return value >= 10 ? `${Math.round(value)} GB` : `${value.toFixed(1)} GB`
}

export interface RecommendInput {
  hardware: HardwareProfile
  profiles: LocalModelProfile[]
  installedTags?: Set<string>
  preset?: RecommendationPreset
  /** Measured generation throughput keyed by exact runtime tag */
  measuredTokensPerSecond?: Map<string, number>
  /** Measured agent-readiness scores keyed by exact runtime tag */
  readinessScores?: Map<string, number>
}

function evaluateVariant(
  model: LocalModelProfile,
  variant: ModelVariant,
  budget: MemoryBudget,
  input: RecommendInput,
  preset: RecommendationPreset,
): VariantEvaluation | undefined {
  const weightsBytes = variantWeightBytes(variant)
  if (!weightsBytes) return undefined

  const runtimeTag = variantRuntimeTag(model, variant)
  const measuredCandidate = runtimeTag !== undefined ? input.measuredTokensPerSecond?.get(runtimeTag) : undefined
  const measured = plausibleMeasurement(measuredCandidate) ? measuredCandidate : undefined
  const readiness = runtimeTag !== undefined ? input.readinessScores?.get(runtimeTag) : undefined

  // Largest context step whose full working set stays inside the safe GPU
  // budget (or a RAM-budget-aware step for CPU-only machines).
  const contextPlan = planContext({ profile: model, variant, parameterCount: model.parameterCount, budget })
  const recCtx = contextPlan.recommended

  const rawWorkingSet = estimateWorkingSet({
    variant,
    parameterCount: model.parameterCount,
    contextTokens: recCtx,
  })
  // Fold the safety reserve into the reported working set so users can see
  // where their memory goes instead of an unexplained gap.
  const workingSet: WorkingSetEstimate = {
    weightsBytes: rawWorkingSet.weightsBytes,
    kvCacheBytes: rawWorkingSet.kvCacheBytes,
    overheadBytes: rawWorkingSet.overheadBytes,
    reserveBytes: Math.round(budget.vramBytes * MEMORY_MODEL.vramSafetyFraction),
    totalBytes: rawWorkingSet.totalBytes,
  }

  const fit = compatibilityFor(workingSet, budget)
  const speed =
    baseSpeedScore(workingSet.totalBytes) * OFFLOAD_SPEED_FACTOR[fit.offload] * (variant.speedMultiplier ?? 1)

  const qualityMultiplier = variant.qualityMultiplier ?? 0.95
  const quantLabel = variant.quantization ?? "selected quantization"

  const fitValue =
    fit.compatibility === "excellent" ? 100 : fit.compatibility === "good" ? 80 : fit.compatibility === "usable" ? 42 : 8
  const codingValue = (model.capabilities.coding ?? 50) * qualityMultiplier
  const reasoningValue = (model.capabilities.reasoning ?? 50) * qualityMultiplier
  // Explicit quantization-quality term: at equal fitness a higher-quality
  // quantization should outrank a lossier one. Fit and speed still dominate
  // when hardware is tight, so this only breaks ties in favor of quality.
  const qualityValue = (qualityMultiplier - 0.9) * 1000
  const effectiveSpeed = measured !== undefined ? measuredThroughputScore(measured) : speed

  let score =
    PRESET_WEIGHTS[preset].fit * fitValue +
    PRESET_WEIGHTS[preset].coding * codingValue +
    PRESET_WEIGHTS[preset].reasoning * reasoningValue +
    PRESET_WEIGHTS[preset].speed * effectiveSpeed +
    PRESET_WEIGHTS[preset].context * contextScore(recCtx) +
    PRESET_WEIGHTS[preset].quality * qualityValue
  score = PRESET_WEIGHTS[preset].fit * fitValue + (score - PRESET_WEIGHTS[preset].fit * fitValue) * OFFLOAD_PENALTY[fit.offload]

  if (preset === "agent") {
    // Measured readiness is the strongest signal; estimated tool support is
    // only the fallback when no local test has run.
    if (readiness !== undefined) {
      score = score * 0.55 + readiness * 0.45
    } else if (model.capabilities.agentCompatible) {
      score += 6
    }
    if (model.capabilities.toolCalling === false) score = Math.min(score, 35)
  }

  const tag = runtimeTag ?? "\u0000"
  if (input.installedTags?.has(tag)) score += 4

  score = Math.max(0, Math.min(100, score))

  // ---- explanations --------------------------------------------------------
  const reasons: string[] = []
  const warnings: string[] = []

  if (fit.compatibility === "excellent") {
    reasons.push(`${quantLabel} working set fits within your ${formatGb(budget.vramBytes)} GPU with safe headroom`)
    reasons.push(`Leaves approximately ${formatGb(fit.headroomBytes)} of VRAM free`)
  } else if (fit.compatibility === "good") {
    reasons.push(`Runs primarily in GPU memory using most of your ${formatGb(budget.vramBytes)} VRAM`)
  } else if (fit.compatibility === "usable") {
    warnings.push(
      `Requires approximately ${formatGb(fit.offloadBytes)} of system-memory offload - performance will be reduced`,
    )
    if (budget.vramSafeBytes === 0) warnings.push("No dedicated GPU detected - generation will be slow")
  } else {
    warnings.push("Likely too large for this machine to run comfortably")
  }

  if ((variant.qualityMultiplier ?? 0) >= 0.97 && variant.quantization !== "Q4_K_M") {
    reasons.push(`${quantLabel} provides higher expected quality than Q4`)
  }
  if ((model.capabilities.coding ?? 0) >= 85) reasons.push("Strong coding performance for its size class")

  if (model.capabilities.toolCalling === false && (preset === "agent" || preset === "overall")) {
    warnings.push("Limited tool-calling support - not suitable for agent mode")
  } else if (model.capabilities.toolCalling && (preset === "agent" || preset === "overall")) {
    reasons.push("Supports tool calling")
  }

  if (recCtx >= 32768) reasons.push(`${Math.round(recCtx / 1024)}K context fits comfortably here`)

  const nextStep = CONTEXT_STEPS.find((step) => step > recCtx && step <= (model.contextLength ?? 0))
  if (nextStep) {
    const nextWorkingSet = estimateWorkingSet({
      variant,
      parameterCount: model.parameterCount,
      contextTokens: nextStep,
    })
    if (nextWorkingSet.totalBytes > budget.vramSafeBytes) {
      warnings.push(`${Math.round(nextStep / 1024)}K context would likely require system-memory offload here`)
    }
  }

  if (rawWorkingSet.totalBytes > budget.vramBytes + budget.ramBudgetBytes) {
    warnings.push("Needs more memory than this machine has available")
  }

  if (readiness !== undefined) {
    reasons.push(`OpenCode readiness measured at ${readiness}/100 on this machine`)
  }

  return {
    variant,
    ...(runtimeTag !== undefined ? { runtimeTag } : {}),
    score: Math.round(score),
    compatibility: fit.compatibility,
    offload: fit.offload,
    reasons,
    warnings,
    estimated: {
      ...workingSet,
      vramBytes: Math.max(0, workingSet.totalBytes - fit.offloadBytes),
      ramBytes: fit.offloadBytes > 0 ? fit.offloadBytes : undefined,
      contextLength: recCtx,
      ...(contextPlan.comfortableMaximum !== undefined
        ? { comfortableMaximumContext: contextPlan.comfortableMaximum }
        : {}),
      ...(fit.headroomBytes > 0 ? { headroomBytes: fit.headroomBytes } : {}),
      ...(variant.downloadSizeBytes !== undefined ? { downloadBytes: variant.downloadSizeBytes } : {}),
    },
    recommended: false,
    ...(measured !== undefined
      ? { measuredTokensPerSecond: measured, metricSource: "measured" as const }
      : { metricSource: "estimated" as const }),
  }
}

export function recommendModels(input: RecommendInput): ModelRecommendation[] {
  const preset = input.preset ?? "overall"
  const budget = memoryBudgets(input.hardware)

  const recommendations = input.profiles.flatMap((model) => {
    const evaluations = model.variants
      .map((variant) => evaluateVariant(model, variant, budget, input, preset))
      .filter((item): item is VariantEvaluation => item !== undefined)
    if (evaluations.length === 0) return []

    // Best variant: highest score; ties prefer higher expected quality.
    const sorted = [...evaluations].sort(
      (a, b) => b.score - a.score || (b.variant.qualityMultiplier ?? 0) - (a.variant.qualityMultiplier ?? 0),
    )
    // Never recommend a variant that cannot run when another one can.
    const best = sorted.find((item) => item.compatibility !== "not_recommended") ?? sorted[0]
    best.recommended = true

    const bestTag = best.runtimeTag
    const installed = bestTag !== undefined && (input.installedTags?.has(bestTag) ?? false)
    const readiness = bestTag !== undefined ? input.readinessScores?.get(bestTag) : undefined

    // Confidence reflects honest uncertainty about the recommendation basis.
    const gpuKnown = budget.vramBytes > 0
    const hasMeasurement = best.metricSource === "measured" || readiness !== undefined
    const confidence: RecommendationConfidence = gpuKnown && hasMeasurement ? "high" : gpuKnown ? "medium" : "low"

    const reasons = [...best.reasons]
    const warnings = [...best.warnings]
    if (best.compatibility !== "excellent") {
      const betterFitting = sorted.find(
        (item) =>
          item !== best &&
          item.compatibility === "excellent" &&
          (item.variant.qualityMultiplier ?? 0) > (best.variant.qualityMultiplier ?? 0),
      )
      if (betterFitting?.variant.quantization) {
        warnings.push(
          `${betterFitting.variant.quantization} would offer higher expected quality but needs more memory than available`,
        )
      }
    }
    if (installed) reasons.push("Already installed")

    return [
      {
        model,
        variant: best.variant,
        score: best.score,
        compatibility: best.compatibility,
        offload: best.offload,
        confidence,
        reasons,
        warnings,
        estimated: best.estimated,
        installed,
        alternatives: sorted,
        ...(readiness !== undefined ? { readinessScore: readiness } : {}),
      } satisfies ModelRecommendation,
    ]
  })

  return recommendations.sort((a, b) => b.score - a.score)
}

// Re-exported so existing consumers keep working against the shared estimator.
export { estimateContextMemory, memoryBudgets as memoryBudget, CONTEXT_STEPS }
