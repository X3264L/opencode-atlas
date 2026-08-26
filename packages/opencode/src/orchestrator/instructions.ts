// Project Instruction Inbox: typed, persisted instructions with deterministic
// classification, disposition reason codes, and supersession handling.
//
// The classifier is intentionally keyword/structure-based (no LLM call) for
// P0. An AI-assisted classifier can be layered later behind the same interface
// as long as its output validates against the typed disposition.

import type { PrivacyPolicy } from "./types"

export type InstructionSource = "user" | "system" | "recovery" | "verification" | "worker"

export type InstructionStatus =
  | "received"
  | "classifying"
  | "queued"
  | "awaiting_review"
  | "applying"
  | "applied"
  | "deferred"
  | "rejected"
  | "superseded"
  | "failed"

export type InstructionDispositionKind =
  | "clarification"
  | "constraint"
  | "priority_change"
  | "scope_addition"
  | "scope_removal"
  | "task_amendment"
  | "architecture_change"
  | "dependency_change"
  | "cancel_task"
  | "defer"
  | "resume"
  | "replan_slice"
  | "project_cancel"
  | "idea"
  | "no_change"

export const INSTRUCTION_REASON_CODES = [
  "USER_ADDS_REQUIREMENT",
  "USER_REMOVES_REQUIREMENT",
  "USER_ADDS_CONSTRAINT",
  "USER_REPRIORITIZES",
  "USER_CHANGES_ARCHITECTURE",
  "USER_CANCELS_TASK",
  "USER_DEFERS_SCOPE",
  "TASK_RUNNING",
  "TASK_ALREADY_COMPLETE",
  "DEPENDENCY_IMPACT",
  "ARTIFACT_INVALIDATED",
  "ARTIFACT_REUSABLE",
  "NO_EXECUTION_IMPACT",
  "CLARIFICATION_REQUIRED",
  "CONFLICTS_WITH_CONSTRAINT",
  "DUPLICATE_INSTRUCTION",
  "SUPERSEDES_PRIOR_INSTRUCTION",
  "SAFE_TO_PATCH",
  "SAFE_TO_QUEUE",
  "INTERRUPTION_REQUIRED",
  "INTERRUPTION_UNSAFE",
  "SPECIALIST_UNAVAILABLE",
  "GENERIC_AGENT_FALLBACK",
] as const

export type InstructionReasonCode = (typeof INSTRUCTION_REASON_CODES)[number]

export interface InstructionDisposition {
  kind: InstructionDispositionKind
  summary: string
  affectedTaskIDs: string[]
  affectedArtifactIDs: string[]
  requiresRoadmapMutation: boolean
  requiresWorkerInterruption: boolean
  requiresClarification: boolean
  confidence: "high" | "medium" | "low"
  reasonCodes: InstructionReasonCode[]
}

export interface ProjectInstruction {
  id: string
  projectID: string
  text: string
  source: InstructionSource
  status: InstructionStatus
  urgency: "normal" | "urgent"
  roadmapVersionReceived: number
  objectiveVersionReceived: number
  createdAt: number
  updatedAt: number
  disposition?: InstructionDisposition
}

export interface ClassifiedInstruction {
  kind: InstructionDispositionKind
  /** Explicit task IDs referenced in the instruction text */
  taskIDs: string[]
  /** Extracted constraint text when kind === "constraint" */
  constraintText?: string
  /** Extracted priority target for priority_change */
  priorityTarget?: { taskOrScope: string; direction: "up" | "down" }
  /** New scope title for scope_addition */
  newScopeTitle?: string
  /** Deferred/cancelled scope for removal */
  removedScopeTitle?: string
  /** Architecture-change subject */
  architectureSubject?: string
  reasonCodes: InstructionReasonCode[]
  confidence: "high" | "medium" | "low"
}

const PRIORITY_PATTERN = /\b(first|top priority|highest priority|priority|before everything)\b/i
const DEFER_PATTERN = /\b(later|defer|move to later|postpone|deprioritize|can wait)\b/i
const CANCEL_TASK_PATTERN = /\b(cancel|drop|remove|don'?t do|skip)\b/i
const CONSTRAINT_PATTERN = /\b(don'?t (touch|modify|change)|must not|never (touch|modify|change)|constraint|keep existing|no db|no database|do not modify)\b/i
const ARCH_CHANGE_PATTERN = /\b(switch to|instead of|replace.*with|use passkeys?|change (the )?(auth|arch|architecture)|redesign|restructure|migrate from)\b/i
const SCOPE_ADD_PATTERN = /\b(add|also|include|support)\b/i
const IDEA_PATTERN = /\b(later add|eventually|future|someday|nice to have|idea)\b/i

/**
 * Deterministic classifier using explicit signals. Returns undefined if the
 * instruction cannot be confidently classified (caller may set clarification).
 */
export function classifyInstruction(
  text: string,
  context?: {
    knownTaskIDs?: string[]
    knownTaskTitles?: string[]
    activeRunningTasks?: string[]
  },
): ClassifiedInstruction {
  const knownTaskIDs = context?.knownTaskIDs ?? []
  const knownTaskTitles = context?.knownTaskTitles ?? []
  const lower = text.toLowerCase()
  const reasonCodes: InstructionReasonCode[] = []
  let confidence: "high" | "medium" | "low" = "medium"

  // Referenced task IDs (exact match against known IDs)
  const referencedTasks = knownTaskIDs.filter((id) => text.includes(id))

  if (IDEA_PATTERN.test(lower)) {
    return { kind: "idea", taskIDs: referencedTasks, reasonCodes: ["NO_EXECUTION_IMPACT"], confidence: "high" }
  }

  if (CONSTRAINT_PATTERN.test(lower)) {
    reasonCodes.push("USER_ADDS_CONSTRAINT")
    return {
      kind: "constraint",
      taskIDs: referencedTasks,
      constraintText: text.trim(),
      reasonCodes,
      confidence: "high",
    }
  }

  if (PRIORITY_PATTERN.test(lower)) {
    reasonCodes.push("USER_REPRIORITIZES")
    // Try to find which task/scope
    const target = knownTaskTitles.find((title) => lower.includes(title.toLowerCase().split(" ")[0]))
    return {
      kind: "priority_change",
      taskIDs: referencedTasks.length > 0 ? referencedTasks : target ? [target] : [],
      ...(target ? { priorityTarget: { taskOrScope: target, direction: DEFER_PATTERN.test(lower) ? ("down" as const) : ("up" as const) } } : {}),
      reasonCodes,
      confidence: "high",
    }
  }

  if (CANCEL_TASK_PATTERN.test(lower)) {
    reasonCodes.push("USER_CANCELS_TASK")
    const target = knownTaskTitles.find((title) => lower.includes(title.toLowerCase()))
    return {
      kind: referencedTasks.length > 0 || target ? ("cancel_task" as const) : ("scope_removal" as const),
      taskIDs: referencedTasks.length > 0 ? referencedTasks : [],
      ...(target || referencedTasks.length > 0
        ? { removedScopeTitle: target ?? referencedTasks[0] }
        : {}),
      reasonCodes,
      confidence: target || referencedTasks.length > 0 ? ("high" as const) : ("medium" as const),
    }
  }

  if (ARCH_CHANGE_PATTERN.test(lower)) {
    reasonCodes.push("USER_CHANGES_ARCHITECTURE")
    return {
      kind: "architecture_change",
      taskIDs: referencedTasks,
      architectureSubject: text.trim(),
      reasonCodes,
      confidence: "high",
    }
  }

  if (DEFER_PATTERN.test(lower)) {
    reasonCodes.push("USER_DEFERS_SCOPE")
    const target = knownTaskTitles.find((title) => lower.includes(title.toLowerCase()))
    return {
      kind: "defer",
      taskIDs: referencedTasks,
      ...(target ? { removedScopeTitle: target } : {}),
      reasonCodes,
      confidence: "high",
    }
  }

  if (SCOPE_ADD_PATTERN.test(lower) && !ARCH_CHANGE_PATTERN.test(lower)) {
    reasonCodes.push("USER_ADDS_REQUIREMENT")
    return {
      kind: "scope_addition",
      taskIDs: [],
      newScopeTitle: text.trim(),
      reasonCodes,
      confidence: "medium",
    }
  }

  // Fallback: task amendment if it references a known task
  if (referencedTasks.length > 0) {
    reasonCodes.push("SAFE_TO_PATCH")
    return { kind: "task_amendment", taskIDs: referencedTasks, reasonCodes, confidence: "medium" }
  }

  return {
    kind: "clarification",
    taskIDs: [],
    reasonCodes: ["CLARIFICATION_REQUIRED"],
    confidence: "low",
  }
}

/** Detects exact duplicates and supersession pairs in the instruction log */
export function detectSupersession(newText: string, existingInstructions: { id: string; text: string; status: string }[]): {
  duplicateOfID?: string
  supersedesID?: string
} {
  const normalizedNew = newText.trim().toLowerCase()
  for (const existing of existingInstructions) {
    if (existing.status !== "applied" && existing.status !== "queued") continue
    const normalizedExisting = existing.text.trim().toLowerCase()
    if (normalizedExisting === normalizedNew) return { duplicateOfID: existing.id }
    // Simple supersession: negation/replacement pattern referencing prior topic
    if (/\b(actually|instead|rather than|not .* but|switch)/i.test(normalizedNew)) {
      const stripPunct = (w: string) => w.replace(/[^a-z0-9]/gi, "")
      const existingWords = new Set(
        normalizedExisting.split(/\s+/).map(stripPunct).filter((w) => w.length > 3),
      )
      const overlap = normalizedNew
        .split(/\s+/)
        .map(stripPunct)
        .filter((w) => w.length > 3 && existingWords.has(w))
      if (overlap.length >= 1) return { supersedesID: existing.id }
    }
  }
  return {}
}
