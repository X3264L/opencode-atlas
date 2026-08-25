import type { RoutingCandidate, RoutingDecision, RoutingFailureKind } from "./types"
import { mayFallback } from "./route"
import { classifyFailureFromMessage } from "./types"

// Bounded pre-commit fallback executor for one routed turn. Pure bookkeeping:
// callers perform the actual provider invocation through OpenCode's existing
// stack and report outcomes here. Guards implemented:
//
// - cancellation stops everything
// - meaningful streamed output stops replay
// - any executed tool stops replay (side effects cannot be proven idempotent)
// - same candidate never runs twice
// - attempt budget (primary + maxFallbackAttempts)
// - cloud budget accounting across primary + fallbacks, preferring actual usage
// - context failures only advance to strictly larger-capacity candidates
// - LOCAL / local_only / allowCloud=false can never reach a cloud candidate

export interface AttemptOutcome {
  candidate: RoutingCandidate
  result: "success" | "failed" | "cancelled"
  failureKind?: RoutingFailureKind
  errorMessage?: string
  /** Actual token usage from the failed request, preferred over estimates */
  actualUsage?: { inputTokens?: number; outputTokens?: number }
}

export interface ExecutionRouteStateInit {
  decision: Pick<RoutingDecision, "mode" | "fallbackPlan"> & {
    primary: RoutingCandidate
    estimatedCloudCost?: number
  }
  maxFallbackAttempts: number
  maxFallbackCloudCost?: number
  allowManagedAutoStart: boolean
  workspacePrivacy?: "standard" | "prefer_local" | "local_only"
  mode: "auto" | "local" | "hybrid" | "cloud"
  allowCloud: boolean
  privacy: "standard" | "prefer_local" | "local_only"
}

export function createExecutionRouteState(init: ExecutionRouteStateInit) {
  const allowCloud = init.allowCloud ?? true
  const attempted = new Map<string, RoutingCandidate>()
  const attempts: AttemptOutcome[] = []
  let fallbackCount = 0
  let estimatedCloudSpend = init.decision.estimatedCloudCost ?? 0
  let actualCloudSpend: number | undefined
  let cancelled = false
  let streamedMeaningfulOutput = false
  let executedSideEffectfulTool = false

  const keyOf = (candidate: RoutingCandidate) => `${candidate.providerID}/${candidate.modelID}`

  return {
    get primary() {
      return init.decision.primary
    },
    get cancelled() {
      return cancelled
    },
    get hasStreamedMeaningfulOutput() {
      return streamedMeaningfulOutput
    },
    get hasExecutedSideEffectfulTool() {
      return executedSideEffectfulTool
    },
    get attempts(): readonly AttemptOutcome[] {
      return attempts
    },
    get fallbackUsed() {
      return fallbackCount > 0
    },
    get fallbackCount() {
      return fallbackCount
    },
    getEstimatedCloudSpend() {
      return actualCloudSpend ?? estimatedCloudSpend
    },

    cancel() {
      cancelled = true
    },
    markStreamedMeaningfulOutput() {
      streamedMeaningfulOutput = true
    },
    markExecutedSideEffectfulTool() {
      executedSideEffectfulTool = true
    },

    recordSuccess(candidate: RoutingCandidate, actualUsage?: AttemptOutcome["actualUsage"]) {
      attempts.push({ candidate, result: "success", ...(actualUsage ? { actualUsage } : {}) })
      if (candidate.source === "cloud" && actualUsage !== undefined) {
        actualCloudSpend = estimateSpend(candidate, actualUsage)
      }
    },

    recordCancelled(candidate: RoutingCandidate) {
      cancelled = true
      attempts.push({ candidate, result: "cancelled", failureKind: "user_cancelled" })
    },

    /**
     * Reports a failed attempt and returns the next candidate to try, or
     * undefined when fallback is blocked by any guard.
     */
    nextAfterFailure(input: {
      candidate: RoutingCandidate
      failureKind?: RoutingFailureKind
      errorMessage?: string
      actualUsage?: AttemptOutcome["actualUsage"]
    }): { candidate?: RoutingCandidate; blockedReasonCode?: string; detail?: string } {
      const kind =
        input.failureKind ??
        (input.errorMessage ? classifyFailureFromMessage(input.errorMessage).kind : ("unknown" as RoutingFailureKind))

      attempts.push({
        candidate: input.candidate,
        result: "failed",
        failureKind: kind,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.actualUsage ? { actualUsage: input.actualUsage } : {}),
      })
      attempted.set(keyOf(input.candidate), input.candidate)

      if (input.actualUsage !== undefined && input.candidate.source === "cloud") {
        actualCloudSpend = estimateSpend(input.candidate, input.actualUsage)
      }

      if (cancelled) return { blockedReasonCode: "USER_CANCELLED" }
      if (kind === "user_cancelled") {
        cancelled = true
        return { blockedReasonCode: "USER_CANCELLED" }
      }
      if (streamedMeaningfulOutput || executedSideEffectfulTool) {
        return { blockedReasonCode: "COMMITMENT_REACHED" }
      }

      const verdict = mayFallback(kind)
      if (!verdict.allowed) return { blockedReasonCode: "USER_CANCELLED", detail: verdict.reason }

      // Context failures require strictly larger capacity
      const cloudPermitted =
        allowCloud && init.mode !== "local" && init.workspacePrivacy !== "local_only"
      const pool =
        kind === "context_exceeded"
          ? init.decision.fallbackPlan.filter((candidate) =>
              candidateCapacity(candidate) > candidateCapacity(input.candidate),
            )
          : init.decision.fallbackPlan.filter((candidate) => cloudPermitted || candidate.source !== "cloud")

      if (fallbackCount >= init.maxFallbackAttempts) {
        return { blockedReasonCode: "ATTEMPT_BUDGET_EXHAUSTED" }
      }

      const remainingBudget = remainingCloudBudget()
      const next = pool.find((candidate) => {
        if (attempted.has(keyOf(candidate))) return false
        if (candidate.source === "cloud") {
          if (remainingBudget !== undefined) {
            const projected = projectedCost(candidate)
            if (projected === "unknown") return false
            if (projected > remainingBudget) return false
          }
        }
        return true
      })

      if (!next) {
        return { blockedReasonCode: "NO_ELIGIBLE_FALLBACK" }
      }

      fallbackCount += 1
      if (next.source === "cloud") {
        const projected = projectedCost(next)
        if (typeof projected === "number") {
          estimatedCloudSpend += projected
        }
      }
      return { candidate: next }
    },

    /** Managed auto-start gate: only explicit opt-in and only cold locals */
    shouldAutoStart(candidate: RoutingCandidate): boolean {
      if (!init.allowManagedAutoStart) return false
      return candidate.source === "local" && candidate.lifecycle === "cold"
    },
  }

  function remainingCloudBudget(): number | undefined {
    if (init.maxFallbackCloudCost === undefined) return undefined
    const spent = actualCloudSpend ?? estimatedCloudSpend
    return Math.max(0, init.maxFallbackCloudCost - spent)
  }

  function projectedCost(candidate: RoutingCandidate): number | "unknown" {
    if (candidate.pricing?.inputPerMillion === undefined || candidate.pricing?.outputPerMillion === undefined) {
      return "unknown"
    }
    return (candidate.pricing.inputPerMillion * 4_000 + candidate.pricing.outputPerMillion * 2_000) / 1_000_000
  }
}

function candidateCapacity(candidate: RoutingCandidate): number {
  return candidate.source === "local"
    ? (candidate.effectiveRecommendedContext ?? candidate.contextWindow ?? 0)
    : (candidate.contextWindow ?? 0)
}

function estimateSpend(
  candidate: RoutingCandidate,
  usage: { inputTokens?: number; outputTokens?: number },
): number | undefined {
  const inputRate = candidate.pricing?.inputPerMillion
  const outputRate = candidate.pricing?.outputPerMillion
  if (inputRate === undefined || outputRate === undefined) return undefined
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return (input / 1_000_000) * inputRate + (output / 1_000_000) * outputRate
}
