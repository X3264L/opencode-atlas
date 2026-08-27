import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { AtlasRouter } from "@/router/index"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { PrivacyPolicy } from "./types"
import type { RoadmapPatchOperation } from "./changeset"
import type { ProjectMemory, ProjectMemoryKind, MemoryProvenance } from "../brain/types"

// Model-backed project intelligence: ambiguous-message classifier, selective
// replanner, worker/session distiller.
//
// Every helper here is the ONLY bridge between Atlas intelligence flows and
// the real execution stack:
//
//   AtlasRouter.decide()  → routed provider/model identity (never hardcoded)
//   ephemeral scratch session with that model identity
//   normal OpenCode prompt pipeline (provider stack, usage/cost, cancellation)
//   strict structured-output validation of the reply
//
// No direct provider SDK calls, no second routing layer, no regex-trusting of
// malformed model prose.

export type IntelligencePurpose =
  | "project_message_classifier"
  | "selective_replanner"
  | "worker_distiller"
  | "session_distiller"

export interface RoutedDeps {
  router: typeof AtlasRouter.Service.Service
  sessions: typeof Session.Service.Service
  promptService: typeof SessionPrompt.Service.Service
}

export interface RoutedCallInput {
  purpose: IntelligencePurpose
  userText: string
  estimatedInputTokens?: number
  privacy?: PrivacyPolicy
}

export class IntelligenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntelligenceError"
  }
}

// ---- Structured output primitives ---------------------------------------------

/** Safest existing fallback when a provider lacks native structured output:
 * pull the outermost JSON object out of the reply text, then run the caller's
 * validator over it. Malformed JSON is never trusted downstream. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) throw new IntelligenceError("model reply contained no JSON object")
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new IntelligenceError("model reply was not valid JSON")
  }
  if (!parsed || typeof parsed !== "object") throw new IntelligenceError("model JSON was not an object")
  return parsed
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== "string") throw new IntelligenceError(`missing field: ${key}`)
  return value
}

function requireNumberIn(raw: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = raw[key]
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new IntelligenceError(`field ${key} must be a number in [${min}, ${max}]`)
  }
  return value
}

// ---- One routed completion through the real stack -----------------------------

export interface RoutedReply {
  text: string
  providerID: string
  modelID: string
  source: "local" | "cloud"
}

/**
 * One structured-model turn through the production stack:
 *   router.decide → ephemeral scratch session carrying ONLY the routed model
 *   identity → normal prompt pipeline → last assistant text.
 *
 * Scratch sessions are removed immediately so intelligence turns never leak
 * into project transcripts or Mission surfaces. Cancellation semantics are
 * those of any normal routed call; telemetry sees a normal prompt turn.
 */
export function runRoutedCompletion(deps: RoutedDeps, input: RoutedCallInput): Effect.Effect<RoutedReply, Error> {
  return Effect.gen(function* () {
    const decision = yield* deps.router
      .decide({
        surface: `atlas.${input.purpose}`,
        requiresStructuredOutput: true,
        ...(input.estimatedInputTokens !== undefined ? { estimatedInputTokens: input.estimatedInputTokens } : {}),
        ...(input.privacy ? { workspacePrivacy: input.privacy } : {}),
      })

    const selected = decision.selected
    // bypassed means an explicit user override hijacked routing — intelligence
    // calls must always go through genuine routing so they stay auditable and
    // privacy-correct.
    if (!selected || decision.bypassed) {
      return yield* Effect.fail(new IntelligenceError("no routed candidate available"))
    }

    const scratch = yield* deps.sessions
      .create({ title: `[atlas:${input.purpose}]` })

    const reply = yield* deps.promptService
      .prompt({
        sessionID: scratch.id,
        // Routed identity rides the normal prompt input; the execution stack
        // resolves it through the regular provider registry.
        model: {
          providerID: ProviderV2.ID.make(selected.providerID),
          modelID: ModelV2.ID.make(selected.modelID),
        },
        parts: [{ type: "text", text: input.userText }],
      })

    // The model's authoritative reply lives in the scratch session transcript.
    let text =
      ([...reply.parts].reverse().find((part) => part.type === "text") as unknown as { text?: string } | undefined)
        ?.text ?? ""
    if (!text) {
      // The reply may only be visible through the session transcript (async
      // durable projection); poll briefly before giving up.
      for (let attempt = 0; attempt < 24; attempt++) {
        const transcript = yield* deps.sessions
          .messages({ sessionID: scratch.id })
          .pipe(Effect.orElseSucceed(() => []))
        const found = [...transcript]
          .reverse()
          .flatMap((entry) => entry.parts)
          .find((part) => part.type === "text" && (part as unknown as { text?: string }).text)
        text = (found as unknown as { text?: string } | undefined)?.text ?? ""
        if (text) break
        yield* Effect.sleep("50 millis")
      }
    }

    yield* deps.sessions.remove(scratch.id).pipe(Effect.catch(() => Effect.void))
    return {
      text,
      providerID: selected.providerID,
      modelID: selected.modelID,
      source: selected.source,
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof IntelligenceError ? error : new IntelligenceError(String(error)),
    ),
  )
}

// ---- 1. Classifier -------------------------------------------------------------

export interface ModelProjectMessageClassification {
  intent:
    | "question"
    | "instruction"
    | "clarification_response"
    | "idea"
    | "direct_project_command"
    | "memory_correction"
    | "status_request"
    | "unknown"
  confidence: number
  reasonCode: string
  referencedTaskIDs?: string[]
}

const INTENTS = new Set([
  "question",
  "instruction",
  "clarification_response",
  "idea",
  "direct_project_command",
  "memory_correction",
  "status_request",
  "unknown",
])

/** Strict classification validation. Invalid intent enum, missing/out-of-range
 * confidence or unknown task references are rejected outright. */
export function parseClassification(raw: unknown, validTaskIDs: ReadonlySet<string>): ModelProjectMessageClassification {
  if (!raw || typeof raw !== "object") throw new IntelligenceError("classification was not an object")
  const obj = raw as Record<string, unknown>
  const intent = requireString(obj, "intent")
  if (!INTENTS.has(intent)) throw new IntelligenceError(`invalid intent: ${intent}`)
  const confidence = requireNumberIn(obj, "confidence", 0, 1)
  const result: ModelProjectMessageClassification = {
    intent: intent as ModelProjectMessageClassification["intent"],
    confidence,
    reasonCode: requireString(obj, "reasonCode"),
  }
  if ("referencedTaskIDs" in obj) {
    const ids = obj.referencedTaskIDs
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new IntelligenceError("referencedTaskIDs must be string[]")
    }
    for (const id of ids) {
      if (!validTaskIDs.has(id)) throw new IntelligenceError(`unknown task reference: ${id}`)
    }
    if (ids.length > 0) result.referencedTaskIDs = ids
  }
  return result
}

export function classifierContextText(input: {
  message: string
  objectiveTitle: string
  objectiveVersion: number
  roadmapVersion: number
  constraints: string[]
  taskIDsAndTitles: { id: string; title: string }[]
}): string {
  const tasks = input.taskIDsAndTitles.map((task) => `- ${task.id}: ${task.title}`).join("\n") || "- none"
  return [
    'Classify this project message. Reply with ONLY a JSON object {"intent":"question|instruction|clarification_response|idea|direct_project_command|memory_correction|status_request|unknown","confidence":<number 0..1>,"reasonCode":"short_snake_reason","referencedTaskIDs":["existing_task_id"]}.',
    "",
    `Objective v${input.objectiveVersion}: ${input.objectiveTitle}`,
    `Roadmap version: ${input.roadmapVersion}`,
    `Constraints: ${input.constraints.join("; ") || "none"}`,
    "Known tasks:",
    tasks,
    "",
    "Message:",
    input.message,
  ].join("\n")
}

// ---- 2. Selective replanner -----------------------------------------------------

const OPERATIONS_DOC =
  'add_task(task full object), update_task(taskID, fields), cancel_task(taskID), defer_task(taskID), reprioritize_task(taskID,priority), add_dependency(taskID,dependsOn), remove_dependency(taskID,dependsOn), invalidate_task(taskID), reopen_task(taskID), update_acceptance_criteria(taskID,criteria), update_project_constraints(constraints[])'

export function replannerContextText(input: {
  instruction: string
  objectiveSummary: string
  objectiveVersion: number
  roadmapVersion: number
  affectedTasks: {
    id: string
    title: string
    status: string
    revision: number
    dependencies: string[]
    acceptanceCriteria: string[]
  }[]
  constraints: string[]
  decisions: string[]
  contracts: string[]
  previousError?: string
}): string {
  const tasks =
    input.affectedTasks
      .map(
        (task) =>
          `- id:${task.id} "${task.title}" status=${task.status} rev=${task.revision} deps=[${task.dependencies.join(",")}]\n  criteria=${JSON.stringify(task.acceptanceCriteria)}`,
      )
      .join("\n") || "- none"
  const lines = [
    `Propose a roadmap ChangeSet for the instruction below.`,
    `Allowed operations (${OPERATIONS_DOC}).`,
    `Reply with ONLY JSON: {"operations":[...],"rationale":"short"}.`,
    "",
    `Instruction: ${input.instruction}`,
    `Objective v${input.objectiveVersion}: ${input.objectiveSummary}`,
    `baseRoadmapVersion MUST be exactly: ${input.roadmapVersion}`,
    "Affected slice:",
    tasks,
    `Constraints: ${input.constraints.join("; ") || "none"}`,
    `Decisions: ${input.decisions.join("; ") || "none"}`,
    `Contracts: ${input.contracts.join("; ") || "none"}`,
  ]
  if (input.previousError) {
    lines.push("", `Your previous proposal was rejected by the validator: ${input.previousError}`, "Fix it.")
  }
  return lines.join("\n")
}

/** Shape-level check only; applyChangeSet remains the authoritative validator. */
export function requireOperationsArray(raw: unknown): RoadmapPatchOperation[] {
  if (!raw || typeof raw !== "object") throw new IntelligenceError("proposal was not an object")
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.operations)) throw new IntelligenceError("operations must be an array")
  return obj.operations as RoadmapPatchOperation[]
}

// ---- 3. Distillation ----------------------------------------------------------

export interface DistilledItem {
  kind: ProjectMemoryKind
  title: string
  content: string
  /** Must reference an ID present in the supplied evidence pack */
  sourceID: string
  sourceKind: MemoryProvenance["kind"]
}

const MEMORY_KINDS = new Set<string>([
  "project_fact", "user_preference", "constraint", "decision", "assumption", "architecture_contract",
  "api_contract", "schema_contract", "task_summary", "worker_outcome", "artifact_summary",
  "verification_evidence", "failure", "blocker", "rejected_approach", "lesson", "roadmap_change",
  "objective_change", "instruction_summary", "open_question", "risk", "integration_note",
])

/**
 * Provenance validation: any item whose kind is unrecognised is dropped; any
 * item whose sourceID does not exist in the supplied evidence pack is dropped
 * ("invalid source") rather than promoted. Unsupported provenance can never
 * become authoritative memory — authority stays "derived".
 */
export function collectDistilledItems(
  raw: unknown,
  evidenceIDs: ReadonlySet<string>,
): DistilledItem[] {
  if (!raw || typeof raw !== "object") throw new IntelligenceError("distillation was not an object")
  const obj = raw as Record<string, unknown>
  const items: DistilledItem[] = []
  for (const sectionKey of Object.keys(obj)) {
    const section = obj[sectionKey]
    if (!Array.isArray(section)) continue
    for (const entryRaw of section) {
      if (!entryRaw || typeof entryRaw !== "object") continue
      const entry = entryRaw as Record<string, unknown>
      const kind = typeof entry.kind === "string" ? entry.kind : undefined
      const title = typeof entry.title === "string" ? entry.title : undefined
      const content = typeof entry.content === "string" ? entry.content : undefined
      const sourceID = typeof entry.sourceID === "string" ? entry.sourceID : undefined
      const sourceKind =
        typeof entry.sourceKind === "string" && MEMORY_PROVENANCE_KINDS.has(entry.sourceKind)
          ? (entry.sourceKind as MemoryProvenance["kind"])
          : undefined
      if (!kind || !MEMORY_KINDS.has(kind)) continue
      if (!title || !content || !sourceID || !sourceKind) continue
      if (!evidenceIDs.has(sourceID)) continue // invalid provenance → dropped
      items.push({ kind: kind as ProjectMemoryKind, title, content, sourceID, sourceKind })
    }
  }
  return items
}

const MEMORY_PROVENANCE_KINDS = new Set<string>([
  "user_message", "session_message", "roadmap", "task", "artifact", "checkpoint", "verification",
  "instruction", "changeset", "file", "git_diff", "test_output", "command_output",
])

export function workerDistillerPrompt(input: {
  instructionSummary: string
  taskID: string
  taskRevision: number
  summary: string
  blockers: string[]
  artifactRefs: { id: string; label: string }[]
  verificationRefs: string[]
  filesChanged?: string[]
}): string {
  return [
    "Distill this worker result into project memory.",
    'Reply with ONLY JSON: {"items":[{"kind":"<brain memory kind>","title":"...","content":"...","sourceID":"<id from evidence>","sourceKind":"task|artifact|verification|file"}]}. Only evidence-pack IDs may be referenced.',
    "",
    `Contract objective: ${input.instructionSummary}`,
    `Evidence pack IDs: task=${input.taskID}(rev ${input.taskRevision}), artifacts=${JSON.stringify(input.artifactRefs)}, verifications=${JSON.stringify(input.verificationRefs)}, files=${JSON.stringify(input.filesChanged ?? [])}`,
    "",
    `Worker summary:`,
    input.summary,
    input.blockers.length > 0 ? `\nBlockers:\n${input.blockers.map((b) => `- ${b}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function sessionDistillerPrompt(input: {
  messages: string[]
  objective: string
  constraints: string[]
  decisions: string[]
  openQuestions: string[]
}): string {
  return [
    "Distill this root-project-conversation slice into durable memories.",
    'Reply with ONLY JSON: {"items":[{kind,title,content,sourceID:"user_message:<index>",sourceKind:"user_message"}]}. sourceID must reference one of the numbered user messages.',
    "",
    `Objective: ${input.objective}`,
    `Constraints: ${input.constraints.join("; ") || "none"}`,
    `Known decisions: ${input.decisions.join("; ") || "none"}`,
    `Open questions: ${input.openQuestions.join("; ") || "none"}`,
    "",
    "Conversation slice:",
    ...input.messages.map((message, index) => `[msg:${index}] ${message}`),
  ].join("\n")
}

/** Runs one distillation call and validates every item's provenance. */
export function runValidatedDistillation(deps: RoutedDeps, input: RoutedCallInput & { evidenceIDs: ReadonlySet<string> }) {
  return Effect.gen(function* () {
    const reply = yield* runRoutedCompletion(deps, input)
    const rawObj = yield* Effect.try({
      try: () => extractJsonObject(reply.text),
      catch: (e) => new IntelligenceError(`parse failed: ${(e instanceof Error ? e.message : String(e))}`),
    })
    const items = yield* Effect.try({
      try: () => collectDistilledItems(rawObj, input.evidenceIDs),
      catch: (e) => new IntelligenceError(`collect failed: ${e instanceof Error ? e.message : String(e)}`),
    })
    return { items, reply }
  })
}

/** Converts validated distilled items into Brain memories (authority=derived). */
export function toDerivedMemories(items: DistilledItem[], input: { projectID: string; roadmapVersion?: number }): ProjectMemory[] {
  const now = Date.now()
  return items.map((item, index) => ({
    id: `distill-model-${now.toString(36)}-${index}`,
    projectID: input.projectID,
    kind: item.kind,
    title: item.title.slice(0, 120),
    content: item.content.slice(0, 2000),
    status: "active" as const,
    authority: "derived" as const,
    confidence: 0.55,
    createdAt: now,
    updatedAt: now,
    ...(input.roadmapVersion !== undefined ? { roadmapVersion: input.roadmapVersion } : {}),
    provenance: [{ kind: item.sourceKind, id: item.sourceID }] as MemoryProvenance[],
    tags: ["model_distilled"],
  }))
}
