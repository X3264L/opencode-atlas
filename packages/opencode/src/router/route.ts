import type {
  RoutingCandidate,
  RoutingDecision,
  RoutingFailureKind,
  RoutingRequest,
  ScoredCandidate,
} from "./types"
import { classifyTask } from "./classify"
import { filterCandidates, strongestPrivacy } from "./filter"
import { scoreCandidates } from "./score"

/**
 * The routing entry point. Deterministic: same inputs produce the same
 * decision. Explicit user model selection bypasses everything.
 */
export function route(request: RoutingRequest, candidates: RoutingCandidate[]): RoutingDecision {
  const classification = classifyTask(request)

  // Manual override: never reinterpret a concrete selection as a hint.
  if (request.explicitModel) {
    const match = candidates.find(
      (candidate) =>
        candidate.providerID === request.explicitModel!.providerID &&
        candidate.modelID === request.explicitModel!.modelID,
    )
    // The selection may be a model Atlas has never normalized - honor it anyway
    const selected =
      match ??
      ({
        source: LOCAL_RUNTIME_IDS.has(request.explicitModel.providerID) ? "local" : "cloud",
        providerID: request.explicitModel.providerID,
        modelID: request.explicitModel.modelID,
        capabilities: { chat: true },
        health: "available",
      } satisfies RoutingCandidate)
    return {
      mode: request.policy.mode,
      selected,
      confidence: "high",
      bypassed: true,
      reasons: [
        { code: "USER_EXPLICIT_MODEL", detail: `${request.explicitModel.providerID}/${request.explicitModel.modelID}` },
      ],
      alternatives: [],
      fallbackPlan: [],
      classification,
    }
  }

  const filters = filterCandidates(request, candidates)
  const scored = scoreCandidates(filters, classification, request)
  const usable = scored.filter((entry) => !entry.rejected)
  const selected = usable[0]

  if (!selected) {
    return noCapableDecision(request, scored, classification)
  }

  const confidence = confidenceFor(selected, usable)
  const reasons = [...selected.reasons]
  if (usable.length === 1 && selected.candidate.source === "local") {
    reasons.push({ code: "LOCAL_REQUIRED", detail: "only one viable candidate" })
  }

  // Fallback plan: remaining usable candidates in score order, bounded by policy
  const fallbackPlan = buildFallbackPlan(request, usable.slice(1))

  return {
    mode: request.policy.mode,
    selected: selected.candidate,
    confidence,
    bypassed: false,
    reasons,
    alternatives: scored.map((entry) => ({
      candidate: entry.candidate,
      score: Number(entry.score.toFixed(4)),
      rejected: entry.rejected,
      reasons: entry.reasons,
    })),
    ...(selected.estimatedCloudCost !== undefined ? { estimatedCloudCost: selected.estimatedCloudCost } : {}),
    fallbackPlan,
    classification,
  }
}

function noCapableDecision(
  request: RoutingRequest,
  scored: ScoredCandidate[],
  classification: ReturnType<typeof classifyTask>,
): RoutingDecision {
  const effectivePrivacy = strongestPrivacy(request.policy.privacy, request.workspacePrivacy)
  const reasons: RoutingDecision["reasons"] = [{ code: "NO_CAPABLE_CANDIDATE" }]
  const cloudBlocked =
    effectivePrivacy === "local_only" || request.policy.mode === "local" || !request.policy.allowCloud

  if (cloudBlocked) {
    reasons.push({
      code:
        effectivePrivacy === "local_only"
          ? "PRIVACY_LOCAL_ONLY"
          : request.policy.mode === "local"
            ? "CLOUD_DISABLED"
            : "CLOUD_DISABLED",
      detail: effectivePrivacy === "local_only" ? "workspace policy" : undefined,
    })
  }

  return {
    mode: request.policy.mode,
    confidence: "low",
    bypassed: false,
    reasons,
    alternatives: scored.map((entry) => ({
      candidate: entry.candidate,
      score: Number(entry.score.toFixed(4)),
      rejected: entry.rejected,
      reasons: entry.reasons,
    })),
    fallbackPlan: [],
    classification,
  }
}

function buildFallbackPlan(request: RoutingRequest, remaining: ScoredCandidate[]): RoutingCandidate[] {
  const plan: RoutingCandidate[] = []
  let cloudSpend = 0
  for (const entry of remaining) {
    if (plan.length >= request.policy.maxFallbackAttempts + 1) break
    if (entry.candidate.source === "cloud") {
      if (entry.estimatedCloudCost === undefined) {
        // Unknown price cannot be budget-checked - exclude from auto escalation
        continue
      }
      if (request.policy.maxFallbackCloudCost !== undefined) {
        if (cloudSpend + entry.estimatedCloudCost > request.policy.maxFallbackCloudCost) continue
        cloudSpend += entry.estimatedCloudCost
      }
    }
    plan.push(entry.candidate)
  }
  return plan
}

/** Whether a failure of the given kind may fall back to the next candidate */
export function mayFallback(kind: RoutingFailureKind, request: RoutingRequest): { allowed: boolean; reason?: string } {
  if (kind === "user_cancelled") {
    return { allowed: false, reason: "user cancellation never triggers fallback" }
  }
  const effectivePrivacy = strongestPrivacy(request.policy.privacy, request.workspacePrivacy)
  const cloudForbidden = effectivePrivacy === "local_only" || request.policy.mode === "local" || !request.policy.allowCloud
  if (cloudForbidden) {
    return {
      allowed: false,
      reason:
        effectivePrivacy === "local_only"
          ? "Cloud fallback is disabled by workspace policy."
          : "Local-only mode never falls back to cloud.",
    }
  }
  if (kind === "provider_auth_error") {
    // Auth errors are deterministic configuration problems - retrying another
    // candidate is fine but retrying THE SAME provider would loop; caller owns
    // that via the already-computed fallback plan (different candidates only).
    return { allowed: true }
  }
  if (kind === "context_exceeded") {
    return { allowed: true, reason: "fallback must target larger context" }
  }
  return { allowed: true }
}

/** Only candidates with strictly larger context may absorb context failures */
export function fallbackForContextExceeded(plan: RoutingCandidate[], requiredTokens: number): RoutingCandidate[] {
  return plan.filter((candidate) => {
    const capacity = candidate.source === "local"
      ? (candidate.effectiveRecommendedContext ?? candidate.contextWindow ?? 0)
      : (candidate.contextWindow ?? 0)
    return capacity > requiredTokens
  })
}

const LOCAL_RUNTIME_IDS = new Set(["ollama", "lmstudio", "llamacpp", "mlx"])

function confidenceFor(selected: ScoredCandidate, usable: ScoredCandidate[]): "high" | "medium" | "low" {
  const candidate = selected.candidate
  let points = 0
  if (candidate.performance?.measured) points += 2
  if (candidate.readiness?.score !== undefined) points += 2
  if (candidate.contextWindow !== undefined || candidate.effectiveRecommendedContext !== undefined) points += 1
  if (candidate.health === "available") points += 1
  if (candidate.source === "cloud" && selected.estimatedCloudCost !== undefined) points += 1
  if (candidate.health === "degraded") points -= 2
  if (usable.length <= 1) points -= 1

  if (points >= 5) return "high"
  if (points >= 3) return "medium"
  return "low"
}
