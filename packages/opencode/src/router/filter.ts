import type { PrivacyPolicy, RoutingCandidate, RoutingReason, RoutingRequest } from "./types"

// Hard capability/context/privacy/cost filtering. Hard requirements reject -
// they are never soft score penalties.

export interface FilterResult {
  candidate: RoutingCandidate
  rejected: boolean
  reasons: RoutingReason[]
  estimatedCloudCost?: number
}

export function estimateCloudCost(
  candidate: RoutingCandidate,
  request: RoutingRequest,
): number | "unknown" | undefined {
  if (candidate.source !== "cloud") return undefined
  const inputRate = candidate.pricing?.inputPerMillion
  const outputRate = candidate.pricing?.outputPerMillion
  if (inputRate === undefined || outputRate === undefined) return "unknown"
  // Unknown/zero output estimate uses a conservative bounded default
  const inputTokens = request.estimatedInputTokens ?? 4_000
  const outputTokens = request.estimatedOutputTokens ?? 2_000
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate
}

export function filterCandidates(request: RoutingRequest, candidates: RoutingCandidate[]): FilterResult[] {
  const effectivePrivacy = strongestPrivacy(request.policy.privacy, request.workspacePrivacy)
  const cloudAllowedByPolicy =
    request.policy.allowCloud && request.policy.mode !== "local" && effectivePrivacy !== "local_only"

  return candidates.map((candidate) => {
    const reasons: RoutingReason[] = []
    let rejected = false

    const reject = (reason: RoutingReason) => {
      reasons.push(reason)
      rejected = true
    }

    if (!candidate.capabilities.chat) {
      reject({ code: "CAPABILITY_CHAT_MISSING" })
    }
    if (candidate.health === "unavailable") {
      reject({ code: "RUNTIME_UNAVAILABLE", detail: `${candidate.providerID}/${candidate.modelID}` })
    }

    if (request.requiresTools && candidate.capabilities.tools === false) {
      reject({ code: "CAPABILITY_TOOLS_MISSING" })
    } else if (
      request.requiresTools &&
      candidate.source === "local" &&
      candidate.readiness?.tools === false
    ) {
      // Measured readiness outranks advertised capability
      reject({ code: "READINESS_FAILED", detail: "tool calling failed readiness" })
    }

    if (request.requiresVision && candidate.capabilities.vision !== true) {
      reject({ code: "CAPABILITY_VISION_MISSING" })
    }

    if (
      request.requiresStructuredOutput &&
      candidate.readiness?.structuredOutput === false
    ) {
      reject({ code: "STRUCTURED_OUTPUT_UNREADY" })
    }

    // Context fit uses EFFECTIVE capacity for local candidates
    const capacity =
      candidate.source === "local"
        ? (candidate.effectiveRecommendedContext ?? candidate.contextWindow)
        : candidate.contextWindow
    const requiredContext = request.estimatedInputTokens ?? 0
    if (capacity !== undefined && requiredContext > capacity) {
      reject({ code: "CONTEXT_TOO_LARGE", detail: `${requiredContext} > ${capacity}` })
    } else if (capacity === undefined && request.requiresLongContext) {
      reasons.push({ code: "CONTEXT_UNKNOWN" })
    }

    // Privacy / mode boundaries are technical walls, not preferences
    if (effectivePrivacy === "local_only") {
      reasons.push({ code: "PRIVACY_LOCAL_ONLY" })
      if (candidate.source === "cloud") reject({ code: "LOCAL_REQUIRED" })
    }
    if (request.policy.mode === "local" && candidate.source === "cloud") {
      reject({ code: "CLOUD_DISABLED" })
    }
    if (request.policy.mode === "cloud" && candidate.source === "local") {
      reject({ code: "CLOUD_MODE_LOCAL_EXCLUDED" })
    }
    if (!request.policy.allowCloud && candidate.source === "cloud") {
      reject({ code: "CLOUD_DISABLED" })
    }

    // Cost caps - unknown price is not free
    const cost = estimateCloudCost(candidate, request)
    if (candidate.source === "cloud") {
      if (cost === "unknown") {
        reasons.push({ code: "UNKNOWN_COST" })
      } else if (typeof cost === "number") {
        if (request.policy.maxCloudCostPerRequest !== undefined && cost > request.policy.maxCloudCostPerRequest) {
          reject({
            code: "COST_OVER_BUDGET",
            detail: `$${cost.toFixed(4)} > $${request.policy.maxCloudCostPerRequest.toFixed(4)}`,
          })
        }
      }
    }

    return {
      candidate,
      rejected,
      reasons,
      ...(typeof cost === "number" ? { estimatedCloudCost: cost } : {}),
    }
  })
}

export function strongestPrivacy(...values: (PrivacyPolicy | undefined)[]): PrivacyPolicy {
  let result: PrivacyPolicy = "standard"
  for (const value of values) {
    if (!value) continue
    if (value === "local_only") return "local_only"
    if (value === "prefer_local") result = "prefer_local"
  }
  return result
}
