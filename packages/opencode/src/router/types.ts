// Atlas Intelligent Router - deterministic, explainable local/cloud routing.
//
// Trust rules encoded here:
// - explicit user model selection always wins
// - LOCAL/privacy-local-only makes cloud technically impossible per request
// - unknown price is never treated as free
// - user cancellation never triggers fallback
//
// The router only RESOLVES provider/model identity; execution always flows
// through OpenCode's existing provider stack.

export type AtlasRoutingMode = "auto" | "local" | "hybrid" | "cloud"

export type PrivacyPolicy = "standard" | "prefer_local" | "local_only"

export interface AtlasRoutingPolicy {
  mode: AtlasRoutingMode
  privacy: PrivacyPolicy
  /** Hard kill-switch - even AUTO/HYBRID cannot use cloud when false */
  allowCloud: boolean
  preferLocal: boolean
  allowManagedAutoStart: boolean
  /** USD per request; undefined = no cap */
  maxCloudCostPerRequest?: number
  maxFallbackAttempts: number
  /** USD across one failure chain */
  maxFallbackCloudCost?: number
  latencyPreference: "latency" | "balanced" | "quality"
}

export const DEFAULT_POLICY: AtlasRoutingPolicy = {
  mode: "auto",
  privacy: "standard",
  allowCloud: true,
  preferLocal: true,
  allowManagedAutoStart: false,
  maxFallbackAttempts: 2,
  latencyPreference: "balanced",
}

export interface RoutingRequest {
  surface: string
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  fileCount?: number

  requiresTools?: boolean
  requiresStructuredOutput?: boolean
  requiresVision?: boolean
  requiresLongContext?: boolean

  workspacePrivacy?: PrivacyPolicy
  explicitModel?: { providerID: string; modelID: string }

  policy: AtlasRoutingPolicy
}

export type TaskClass =
  | "tiny_edit"
  | "simple_chat"
  | "code_explanation"
  | "single_file_edit"
  | "multi_file_refactor"
  | "agentic_tool_task"
  | "long_context_analysis"
  | "vision_task"
  | "high_reasoning"

export interface TaskClassification {
  taskClass: TaskClass
  /** 0 trivial → 1 demanding */
  difficulty: number
  reasons: string[]
}

export interface RoutingCandidateCapabilities {
  chat: boolean
  tools?: boolean
  structuredOutput?: boolean
  vision?: boolean
}

export interface RoutingReadiness {
  score?: number
  tools?: boolean
  structuredOutput?: boolean
}

export interface RoutingPerformance {
  tokensPerSecond?: number
  timeToFirstTokenMs?: number
  measured: boolean
}

export type CandidateSource = "local" | "cloud"

export interface RoutingCandidate {
  source: CandidateSource
  providerID: string
  modelID: string
  runtimeID?: string
  runtimeModelID?: string
  variantID?: string

  capabilities: RoutingCandidateCapabilities
  contextWindow?: number
  effectiveRecommendedContext?: number

  health: "available" | "degraded" | "unavailable"

  readiness?: RoutingReadiness
  performance?: RoutingPerformance
  lifecycle?: "warm" | "cold" | "not_installed"

  pricing?: {
    inputPerMillion?: number
    outputPerMillion?: number
  }
}

// ---- Reason codes -----------------------------------------------------------

export const ROUTING_REASONS = [
  "USER_EXPLICIT_MODEL",
  "LOCAL_REQUIRED",
  "CLOUD_DISABLED",
  "CLOUD_MODE_LOCAL_EXCLUDED",
  "PRIVACY_LOCAL_ONLY",
  "PRIVACY_PREFER_LOCAL",
  "CAPABILITY_TOOLS_MISSING",
  "CAPABILITY_VISION_MISSING",
  "CAPABILITY_CHAT_MISSING",
  "STRUCTURED_OUTPUT_UNREADY",
  "CONTEXT_TOO_LARGE",
  "CONTEXT_UNKNOWN",
  "RUNTIME_UNAVAILABLE",
  "READINESS_FAILED",
  "MODEL_WARM",
  "MODEL_COLD",
  "MEASURED_FAST",
  "MEASURED_SLOW",
  "ESTIMATED_QUALITY_FIT",
  "COST_OVER_BUDGET",
  "FALLBACK_COST_OVER_BUDGET",
  "UNKNOWN_COST",
  "LOCAL_FREE",
  "LOCAL_PREFERRED",
  "CLOUD_SELECTED_EVIDENCE",
  "LOW_CONFIDENCE",
  "NO_CAPABLE_CANDIDATE",
] as const

export type RoutingReasonCode = (typeof ROUTING_REASONS)[number]

export interface RoutingReason {
  code: RoutingReasonCode
  detail?: string
}

export interface ScoredCandidate {
  candidate: RoutingCandidate
  score: number
  rejected: boolean
  reasons: RoutingReason[]
  estimatedCloudCost?: number
}

export interface RoutingAlternative {
  candidate: RoutingCandidate
  score?: number
  rejected: boolean
  reasons: RoutingReason[]
}

export interface RoutingDecision {
  mode: AtlasRoutingMode
  selected?: RoutingCandidate
  confidence: "high" | "medium" | "low"
  bypassed: boolean
  reasons: RoutingReason[]
  alternatives: RoutingAlternative[]
  estimatedCloudCost?: number
  fallbackPlan: RoutingCandidate[]
  classification: TaskClassification
}

// ---- Failure classification for hybrid fallback -----------------------------

export type RoutingFailureKind =
  | "runtime_unavailable"
  | "runtime_crashed"
  | "context_exceeded"
  | "tool_calling_failed"
  | "structured_output_failed"
  | "timeout"
  | "provider_rate_limited"
  | "provider_auth_error"
  | "model_not_found"
  | "server_error"
  | "user_cancelled"
  | "unknown"

export function classifyFailure(error: unknown): { kind: RoutingFailureKind; message?: string } {
  if (error instanceof Error) return classifyFailureFromMessage(error.message)
  if (typeof error === "string") return classifyFailureFromMessage(error)
  return { kind: "unknown" }
}

export function classifyFailureFromMessage(message: string): { kind: RoutingFailureKind; message: string } {
  const value = message.toLowerCase()
  if (value.includes("cancel") || value.includes("abort")) return { kind: "user_cancelled", message }
  if (value.includes("auth") || value.includes("api key") || value.includes("401") || value.includes("403"))
    return { kind: "provider_auth_error", message }
  if (value.includes("429") || value.includes("rate limit")) return { kind: "provider_rate_limited", message }
  if (
    value.includes("context length") ||
    value.includes("context too") ||
    value.includes("too many tokens") ||
    value.includes("maximum context")
  )
    return { kind: "context_exceeded", message }
  if (value.includes("tool") && (value.includes("fail") || value.includes("not supported")))
    return { kind: "tool_calling_failed", message }
  if (value.includes("structured output") || value.includes("json schema"))
    return { kind: "structured_output_failed", message }
  if (value.includes("timeout") || value.includes("timed out")) return { kind: "timeout", message }
  if (value.includes("crash") || value.includes("runtime is not running") || value.includes("exited"))
    return { kind: "runtime_crashed", message }
  if (value.includes("not found") || value.includes("404")) return { kind: "model_not_found", message }
  if (value.includes("unavailable") || value.includes("connection refused") || value.includes("econnrefused"))
    return { kind: "runtime_unavailable", message }
  if (value.includes("500") || value.includes("502") || value.includes("503"))
    return { kind: "server_error", message }
  return { kind: "unknown", message }
}
