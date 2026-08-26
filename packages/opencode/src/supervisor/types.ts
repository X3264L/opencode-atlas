// Autonomous Execution Supervisor: observes project execution health,
// classifies failures/stalls, selects bounded recovery actions.

import { countTokens } from "./tokenizer"

export type SupervisorHealth = "healthy" | "degraded" | "recovering" | "blocked" | "paused" | "failed"

export type IncidentKind =
  | "worker_stalled" | "worker_lost" | "tool_failure" | "provider_failure"
  | "runtime_failure" | "runtime_crashed" | "test_failure" | "build_failure" | "context_overflow"
  | "context_starvation" | "capability_mismatch" | "dependency_mismatch"
  | "write_conflict" | "integration_failure" | "verification_failure"
  | "repeated_failure" | "resource_pressure" | "unknown"

export type IncidentSeverity = "info" | "warning" | "error" | "critical"
export type IncidentStatus = "open" | "diagnosing" | "recovering" | "resolved" | "escalated" | "abandoned"

export interface SupervisorIncident {
  id: string
  projectID: string
  taskID?: string
  kind: IncidentKind
  severity: IncidentSeverity
  status: IncidentStatus
  evidenceRefs: string[]
  detail?: string
  createdAt: number
  updatedAt: number
}

export type RecoveryAction =
  | "retry_same_worker" | "retry_new_session" | "reassign_specialist" | "reroute_model"
  | "expand_context" | "trim_context" | "repair_contract" | "split_task"
  | "reopen_dependency" | "rerun_verification" | "restart_managed_runtime"
  | "checkpoint_and_replan" | "pause_project" | "request_user" | "mark_blocked"

export interface RecoveryBudget {
  maxIncidentsPerTask: number
  maxRecoveryAttemptsPerIncident: number
  maxModelEscalationsPerTask: number
}

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxIncidentsPerTask: 5,
  maxRecoveryAttemptsPerIncident: 3,
  maxModelEscalationsPerTask: 2,
}

/**
 * Deterministic recovery policy matrix: maps incident kinds to bounded recovery actions.
 * Escalation path: retry → reassign/reroute → split/replan → request_user.
 */
export function selectRecoveryActions(
  kind: IncidentKind,
  attemptNumber: number,
  budget: RecoveryBudget,
): RecoveryAction[] {
  if (attemptNumber > budget.maxRecoveryAttemptsPerIncident) return ["request_user"]
  const exhausted = attemptNumber >= budget.maxRecoveryAttemptsPerIncident

  switch (kind) {
    case "worker_stalled":
    case "worker_lost":
      return exhausted ? ["request_user"] : ["retry_new_session"]
    case "provider_failure":
    case "runtime_failure":
    case "runtime_crashed":
      return exhausted ? ["restart_managed_runtime", "request_user"] : ["retry_new_session", "restart_managed_runtime"]
    case "tool_failure":
    case "test_failure":
      return exhausted ? ["reassign_specialist", "request_user"] : ["retry_same_worker", "reassign_specialist"]
    case "build_failure":
      return exhausted ? ["mark_blocked"] : ["retry_same_worker"]
    case "context_overflow":
      return exhausted ? ["request_user"] : ["expand_context", "reroute_model"]
    case "context_starvation":
      return exhausted ? ["request_user"] : ["expand_context"]
    case "capability_mismatch":
      return exhausted ? ["request_user"] : ["reroute_model", "reassign_specialist"]
    case "write_conflict":
      return ["checkpoint_and_replan"]
    case "integration_failure":
      return exhausted ? ["mark_blocked"] : ["reopen_dependency", "rerun_verification"]
    case "verification_failure":
      return exhausted ? ["mark_blocked"] : ["rerun_verification", "repair_contract"]
    case "repeated_failure":
      return exhausted ? ["split_task", "request_user"] : ["reassign_specialist", "split_task"]
    case "resource_pressure":
      return ["pause_project"]
    default:
      return exhausted ? ["request_user"] : ["retry_same_worker"]
  }
}

/** Detects repeated identical failures using normalized fingerprints */
export function isRepeatedFailure(fingerprint: string, seenFingerprints: Map<string, number>): boolean {
  const count = (seenFingerprints.get(fingerprint) ?? 0) + 1
  seenFingerprints.set(fingerprint, count)
  return count >= 3
}

export function fingerprintFailure(kind: string, taskRevision: number, errorSignature: string): string {
  const normalized = errorSignature.toLowerCase().replace(/\d+/g, "#").slice(0, 120)
  return `${kind}:${taskRevision}:${normalized}`
}

// ---- Context accounting -------------------------------------------------------

export interface RequestContextEstimate {
  inputTokens: number
  reservedOutputTokens: number
  requiredTokens: number
  components: Partial<Record<"system" | "agent" | "conversation" | "contract" | "brain" | "files" | "tools" | "structuredOutput" | "overhead", number>>
  method: "conservative_estimate"
  confidence: "high" | "medium" | "low"
}

const CHARS_PER_TOKEN = 4
const DEFAULT_OUTPUT_RESERVE = 4_000


export function estimateRequestContext(input: {
  systemPrompt?: string
  agentPrompt?: string
  conversationText?: string
  contractText?: string
  brainContextText?: string
  fileTexts?: string[]
  toolSchemaCount?: number
  hasStructuredOutput?: boolean
  reservedOutputTokens?: number
  modelID?: string
}): RequestContextEstimate {
  const tok = (text: string | undefined) => countTokens(text ?? "", input.modelID).tokens
  const system = tok(input.systemPrompt)
  const agent = tok(input.agentPrompt)
  const conversation = tok(input.conversationText)
  const contract = tok(input.contractText)
  const brain = tok(input.brainContextText)
  const files = (input.fileTexts ?? []).reduce((sum, text) => sum + countTokens(text, input.modelID).tokens, 0)
  const tools = (input.toolSchemaCount ?? 0) * 300 // ~300 tokens per tool schema
  const structuredOutput = input.hasStructuredOutput ? 500 : 0
  const overhead = 200
  const reservedOutputTokens = input.reservedOutputTokens ?? DEFAULT_OUTPUT_RESERVE

  const inputTokens = system + agent + conversation + contract + brain + files + tools + structuredOutput + overhead
  return {
    inputTokens,
    reservedOutputTokens,
    requiredTokens: inputTokens + reservedOutputTokens,
    components: { system, agent, conversation, contract, brain, files, tools, structuredOutput, overhead },
    method: "conservative_estimate",
    confidence: "medium",
  }
}

/** Whether a candidate's effective context can accommodate the estimated request */
export function fitsInContext(estimate: RequestContextEstimate, effectiveContextTokens: number): boolean {
  return estimate.requiredTokens <= effectiveContextTokens
}
