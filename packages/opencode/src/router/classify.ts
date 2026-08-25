import type { RoutingRequest, TaskClassification, TaskClass } from "./types"

/**
 * Deterministic structure-based classification. No extra LLM call, no prompt
 * keyword parsing - only known request/surface metadata.
 */
export function classifyTask(request: RoutingRequest): TaskClassification {
  const reasons: string[] = []
  let difficulty = 0

  const inputTokens = request.estimatedInputTokens ?? 0
  const outputTokens = request.estimatedOutputTokens ?? 0
  const fileCount = request.fileCount ?? 0

  if (request.requiresVision) {
    reasons.push("vision_required")
    difficulty += 0.35
  }
  if (inputTokens > 96_000) {
    reasons.push("very_large_input")
    difficulty += 0.3
  } else if (inputTokens > 32_000) {
    reasons.push("large_input")
    difficulty += 0.15
  } else if (inputTokens > 8_000) {
    reasons.push("medium_input")
    difficulty += 0.05
  }
  if (fileCount > 5) {
    reasons.push("multi_file_scope")
    difficulty += 0.25
  } else if (fileCount > 1) {
    reasons.push("few_file_scope")
    difficulty += 0.1
  }
  if (request.requiresTools) {
    reasons.push("tools_required")
    difficulty += 0.2
  }
  if (request.requiresStructuredOutput) {
    reasons.push("structured_output_required")
    difficulty += 0.1
  }
  if (outputTokens > 4_000) {
    reasons.push("long_output_expected")
    difficulty += 0.15
  }

  let taskClass: TaskClass
  if (request.requiresVision) {
    taskClass = "vision_task"
  } else if (request.requiresTools && /agent|tool/i.test(request.surface)) {
    taskClass = "agentic_tool_task"
  } else if (inputTokens > 96_000 || request.requiresLongContext) {
    taskClass = "long_context_analysis"
  } else if (fileCount > 1) {
    taskClass = "multi_file_refactor"
  } else if (/edit|apply|patch/i.test(request.surface) && inputTokens < 2_000 && fileCount === 0) {
    taskClass = "tiny_edit"
    reasons.push("tiny_edit_surface")
  } else if (/edit|apply|write|patch/i.test(request.surface) && fileCount === 1) {
    taskClass = "single_file_edit"
  } else if (/explain|review|describe/i.test(request.surface)) {
    taskClass = "code_explanation"
  } else if (/chat|ask|summar/i.test(request.surface)) {
    taskClass = "simple_chat"
  } else if (difficulty >= 0.2) {
    taskClass = "high_reasoning"
  } else {
    taskClass = "simple_chat"
  }

  // Class-specific adjustments keep the scale bounded and meaningful
  if (taskClass === "agentic_tool_task") difficulty += 0.15
  if (taskClass === "long_context_analysis") difficulty += 0.1
  if (taskClass === "tiny_edit" || taskClass === "simple_chat") difficulty -= 0.1
  if (taskClass === "single_file_edit" && fileCount <= 1 && inputTokens < 8_000) {
    reasons.push("small_edit_scope")
    difficulty -= 0.05
  }

  return {
    taskClass,
    difficulty: Math.max(0, Math.min(1, Number(difficulty.toFixed(2)))),
    reasons,
  }
}
