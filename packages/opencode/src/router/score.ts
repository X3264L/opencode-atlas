import type { RoutingCandidate, RoutingRequest, ScoredCandidate, TaskClassification } from "./types"
import type { FilterResult } from "./filter"

// Weighted scoring AFTER hard filters. Weights are centralized; evidence
// (measured performance, readiness) outranks generic heuristics. No rule says
// "cloud always wins hard tasks" or "local always wins easy tasks".

interface ScoreWeights {
  quality: number
  readiness: number
  context: number
  latency: number
  privacy: number
  cost: number
  warm: number
  evidence: number
}

const BASE_WEIGHTS: ScoreWeights = {
  quality: 0.2,
  readiness: 0.15,
  context: 0.1,
  latency: 0.15,
  privacy: 0.1,
  cost: 0.1,
  warm: 0.1,
  evidence: 0.1,
}

/** Difficulty shifts weight from cost/latency toward quality */
function weightsFor(difficulty: number, request: RoutingRequest): ScoreWeights {
  const weights = { ...BASE_WEIGHTS }
  const qualityBoost = difficulty * 0.12
  weights.quality += qualityBoost
  weights.cost = Math.max(0.02, weights.cost - qualityBoost / 2)
  weights.latency =
    request.policy.latencyPreference === "latency" ? weights.latency + 0.08 : request.policy.latencyPreference === "quality" ? Math.max(0.05, weights.latency - 0.05) : weights.latency
  return weights
}

function scoreCandidate(
  filterResult: FilterResult,
  classification: TaskClassification,
  request: RoutingRequest,
): { score: number; reasons: ScoredCandidate["reasons"] } {
  const candidate = filterResult.candidate
  const reasons: ScoredCandidate["reasons"] = [...filterResult.reasons]
  const weights = weightsFor(classification.difficulty, request)

  let score = 0

  // Quality/task fit - cloud models are presumed stronger for demanding work
  // ONLY via difficulty weighting; local quality comes from measured evidence.
  if (candidate.source === "cloud") {
    score += weights.quality * (0.6 + classification.difficulty * 0.3)
  } else {
    const readinessQuality = (candidate.readiness?.score ?? 50) / 100
    score += weights.quality * (0.35 + readinessQuality * 0.4)
  }

  // Readiness evidence
  if (candidate.readiness?.score !== undefined) {
    score += weights.readiness * (candidate.readiness.score / 100)
    if (request.requiresTools && candidate.readiness.tools === true) {
      score += weights.readiness * 0.5
    }
  } else if (candidate.source === "cloud") {
    score += weights.readiness * 0.7 // provider-grade reliability assumption, capped below measured proof
  }

  // Context headroom
  if (candidate.contextWindow !== undefined || candidate.effectiveRecommendedContext !== undefined) {
    const capacity =
      candidate.source === "local"
        ? (candidate.effectiveRecommendedContext ?? candidate.contextWindow)!
        : candidate.contextWindow!
    const needed = request.estimatedInputTokens ?? 4_000
    const headroom = Math.max(0, Math.min(1, 1 - needed / capacity))
    score += weights.context * headroom
  }

  // Latency: measured beats assumed; TTFT and tok/s both matter
  let latencyScore: number
  if (candidate.performance?.measured && candidate.performance.tokensPerSecond) {
    const tps = candidate.performance.tokensPerSecond
    latencyScore = Math.max(0, Math.min(1, Math.log10(Math.max(tps, 1)) / Math.log10(200)))
    reasons.push({ code: tps >= 40 ? "MEASURED_FAST" : tps < 8 ? "MEASURED_SLOW" : "MEASURED_FAST" })
  } else if (candidate.source === "local") {
    latencyScore = 0.45
  } else {
    latencyScore = 0.55 // network round trips assumed moderate
  }
  if (candidate.lifecycle === "warm") latencyScore += 0.15
  score += Math.min(1, latencyScore) * weights.latency

  // Privacy fit
  if (candidate.source === "local") {
    score += weights.privacy * 1
  } else {
    score += weights.privacy * 0.1
  }

  // Cost: local is free of API cost; unknown cloud price is penalized, not zeroed
  if (candidate.source === "local") {
    score += weights.cost
    if (!reasons.some((reason) => reason.code === "LOCAL_FREE")) {
      reasons.push({ code: "LOCAL_FREE" })
    }
  } else if (filterResult.estimatedCloudCost !== undefined) {
    const cost = filterResult.estimatedCloudCost
    score += weights.cost * Math.max(0, 1 - Math.min(1, cost / 0.5))
  } else {
    score += weights.cost * 0.25
  }

  // Warm-state advantage for locals (already partially in latency)
  if (candidate.lifecycle === "warm" && candidate.source === "local") {
    score += weights.warm
    reasons.push({ code: "MODEL_WARM" })
  } else if (candidate.lifecycle === "cold") {
    score += weights.warm * 0.3
    reasons.push({ code: "MODEL_COLD" })
  }

  // Evidence confidence
  let evidence = 0
  if (candidate.performance?.measured) evidence += 0.4
  if (candidate.readiness?.score !== undefined) evidence += 0.3
  if (candidate.source === "cloud" && filterResult.estimatedCloudCost !== undefined) evidence += 0.3
  if (candidate.health === "degraded") evidence -= 0.2
  score += weights.evidence * Math.max(0, Math.min(1, evidence))

  // Explicit policy preferences - visible, bounded influence
  if (candidate.source === "local" && request.policy.preferLocal) {
    score += 0.06
    reasons.push({ code: "LOCAL_PREFERRED" })
  }
  if (candidate.source === "cloud" && classification.difficulty >= 0.6) {
    score += classification.difficulty * 0.08
    reasons.push({ code: "CLOUD_SELECTED_EVIDENCE", detail: `difficulty ${classification.difficulty}` })
  }

  return { score, reasons }
}

export function scoreCandidates(
  filters: FilterResult[],
  classification: TaskClassification,
  request: RoutingRequest,
): ScoredCandidate[] {
  return filters
    .map((filterResult): ScoredCandidate => {
      const { score, reasons } = scoreCandidate(filterResult, classification, request)
      return {
        candidate: filterResult.candidate,
        score,
        rejected: filterResult.rejected,
        reasons,
        ...(filterResult.estimatedCloudCost !== undefined ? { estimatedCloudCost: filterResult.estimatedCloudCost } : {}),
      }
    })
    .sort((a, b) => b.score - a.score || Number(a.rejected) - Number(b.rejected))
}
