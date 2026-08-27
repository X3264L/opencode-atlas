// Project message intent classification and routing.
// Routes project-level messages to the correct subsystem without treating
// every message as a roadmap mutation.

export type ProjectMessageIntent =
  | "question"
  | "instruction"
  | "clarification_response"
  | "idea"
  | "direct_project_command"
  | "memory_correction"
  | "status_request"
  | "unknown"

const QUESTION_PATTERN = /^\s*(why|what|which|how|who|when|where|is|are|does|can|should|did)\b/i
const QUESTION_SUFFIX = /\?\s*$/
const STATUS_PATTERN = /\b(blocked|blocking|running|status|progress|pending|ready)\b/i
const IDEA_PATTERN = /\b(later add|eventually|future|nice to have|idea|maybe someday)\b/i
const CORRECTION_PATTERN = /\b(that'?s wrong|that is wrong|incorrect|actually no|we never|correction:)\b/i
const COMMAND_PATTERN = /^\s*\/(plan|start|cancel|pause|resume)\b/

export interface ProjectMessageRoute {
  intent: ProjectMessageIntent
  /** For instructions, the text forwarded to the instruction inbox */
  instructionText?: string
  /** For questions, the query forwarded to brain retrieval */
  queryText?: string
  reason: string
  /**
   * True when no deterministic signal matched confidently. Callers may
   * escalate such routes to the model-backed classifier; the deterministic
   * route stays the safe fallback.
   */
  ambiguous?: boolean
}

export function classifyProjectMessage(text: string): ProjectMessageRoute {
  const trimmed = text.trim()
  if (!trimmed) return { intent: "unknown", reason: "empty message" }

  // Direct slash commands
  if (COMMAND_PATTERN.test(trimmed)) {
    return { intent: "direct_project_command", instructionText: trimmed, reason: "slash command" }
  }

  // Memory corrections are high-priority overrides
  if (CORRECTION_PATTERN.test(trimmed)) {
    return {
      intent: "memory_correction",
      instructionText: trimmed,
      reason: "user corrects a derived memory or decision",
    }
  }

  // Ideas don't mutate the roadmap
  if (IDEA_PATTERN.test(trimmed)) {
    return { intent: "idea", instructionText: trimmed, reason: "future scope / idea" }
  }

  // Questions end with ? or start with question words + status keywords
  if (QUESTION_SUFFIX.test(trimmed) || (QUESTION_PATTERN.test(trimmed) && !/\b(use|switch|add|remove|drop|make)\b/i.test(trimmed))) {
    if (STATUS_PATTERN.test(trimmed)) {
      return { intent: "status_request", queryText: trimmed, reason: "deterministic status query from orchestrator state" }
    }
    return { intent: "question", queryText: trimmed, reason: "brain Q&A" }
  }

  // Everything else that looks like an imperative → instruction inbox
  const imperativeVerbs =
    /\b(add|use|implement|create|remove|delete|drop|fix|refactor|change|update|switch|make|migrate|move|set)\b/i
  if (imperativeVerbs.test(trimmed)) {
    return { intent: "instruction", instructionText: trimmed, reason: "imperative instruction for the roadmap" }
  }

  // Status requests without question marks
  if (STATUS_PATTERN.test(trimmed)) {
    return { intent: "status_request", queryText: trimmed, reason: "status keyword detected" }
  }

  // Ambiguous: no strong deterministic signal matched. The default remains
  // Q&A, but callers may escalate this route to the model-backed classifier.
  return { intent: "question", queryText: trimmed, reason: "default to Q&A for non-imperative messages", ambiguous: true }
}
