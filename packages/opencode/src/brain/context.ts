import type { BrainQuery, ContextPackItem, ContextDropRecord, ProjectContextPack, ProjectMemory } from "./types"
import { AUTHORITY_ORDER } from "./types"
import { retrieve } from "./retrieve"

// Context Fabric: compiles bounded, prioritized context packs from brain
// memories. Token-aware trimming drops lowest-priority items first; critical
// constraints and acceptance criteria are never silently dropped.

const NEVER_DROP_KINDS = new Set(["constraint", "decision", "user_preference"])

let packCounter = 0

export function estimateTokens(text: string): number {
  // Conservative estimate: ~4 chars per token
  return Math.ceil(text.length / 4)
}

export interface CompileContextPackInput {
  projectID: string
  purpose: "worker" | "planner" | "replanner" | "review" | "integration" | "project_question"
  targetTaskID?: string
  query: string
  memories: ProjectMemory[]
  /** Additional non-brain content (system prompt, contract, tool schemas) */
  fixedContent?: { kind: string; text: string }[]
  budgetTokens: number
  specialistProfile?: string
  includeHistorical?: boolean
}

/** Specialist profile boosts relevant memory kinds */
const SPECIALIST_BOOSTS: Record<string, Set<string>> = {
  backend: new Set(["api_contract", "schema_contract", "constraint", "failure", "lesson", "architecture_contract"]),
  frontend: new Set(["api_contract", "architecture_contract", "project_fact"]),
  tests: new Set(["verification_evidence", "failure", "constraint", "task_summary", "rejected_approach"]),
  review: new Set(["constraint", "verification_evidence", "decision", "artifact_summary"]),
  integration: new Set(["architecture_contract", "api_contract", "integration_note", "failure"]),
  research: new Set([]),
}

export function compileContextPack(input: CompileContextPackInput): ProjectContextPack {
  packCounter += 1
  const packID = `pack-${Date.now().toString(36)}-${packCounter}`

  // Compute fixed-content token cost
  let fixedTokenCost = 0
  const contentParts: { kind: string; text: string }[] = []
  for (const fc of input.fixedContent ?? []) {
    const tokens = estimateTokens(fc.text)
    fixedTokenCost += tokens
    contentParts.push({ kind: fc.kind, text: fc.text })
  }

  const remainingBudget = Math.max(0, input.budgetTokens - fixedTokenCost)

  // Retrieve + score memories
  const query: BrainQuery = {
    projectID: input.projectID,
    query: input.query,
    includeHistorical: input.includeHistorical,
    maxItems: 50,
  }
  const boosts = SPECIALIST_BOOSTS[input.specialistProfile ?? ""]
  const scored = scoreWithBoosts(input.memories, query, boosts)

  // Greedy inclusion by priority (score), respecting token budget
  const items: ContextPackItem[] = []
  const dropped: ContextDropRecord[] = []
  const seenSourceIDs = new Set<string>()
  let memoryTokensUsed = 0

  for (const entry of scored) {
    const text = `${entry.memory.title}\n${entry.memory.content}`
    const tokens = estimateTokens(text)

    // Deduplication: skip if we've already included this source
    const dedupeKey = `${entry.memory.kind}:${entry.memory.title.toLowerCase().slice(0, 60)}`
    if (seenSourceIDs.has(dedupeKey)) continue

    if (memoryTokensUsed + tokens > remainingBudget) {
      // Critical items are never dropped without explicit failure
      if (!NEVER_DROP_KINDS.has(entry.memory.kind)) {
        dropped.push({
          sourceID: entry.memory.id,
          reasonDropped: `over budget (${tokens} tokens needed, ${remainingBudget - memoryTokensUsed} remaining)`,
        })
        continue
      }
      // Even over-budget critical items get truncated rather than dropped
      const truncatedText = text.slice(0, Math.max(0, (remainingBudget - memoryTokensUsed) * 4))
      if (truncatedText.length < 20) {
        dropped.push({ sourceID: entry.memory.id, reasonDropped: "budget exhausted even for critical item" })
        continue
      }
    }

    seenSourceIDs.add(dedupeKey)
    memoryTokensUsed += tokens
    items.push({
      kind: entry.memory.kind,
      sourceID: entry.memory.id,
      authority: entry.memory.authority,
      status: entry.memory.status,
      relevanceScore: entry.score,
      estimatedTokens: tokens,
      reasonIncluded: buildIncludeReason(entry, input.specialistProfile),
    })

    contentParts.push({ kind: entry.memory.kind, text })
  }

  return {
    id: packID,
    projectID: input.projectID,
    purpose: input.purpose,
    ...(input.targetTaskID ? { targetTaskID: input.targetTaskID } : {}),
    items,
    contentParts,
    estimatedTokens: fixedTokenCost + memoryTokensUsed,
    budgetTokens: input.budgetTokens,
    dropped,
    provenance: items.map((item) => item.sourceID),
  }
}

function scoreWithBoosts(
  memories: ProjectMemory[],
  query: BrainQuery,
  boosts?: Set<string>,
): { memory: ProjectMemory; score: number; matchReasons: string[] }[] {
  const results = retrieve(memories, query)
  if (!boosts || boosts.size === 0) return results
  return results.map((entry) => ({
    ...entry,
    score: boosts.has(entry.memory.kind) ? entry.score * 1.3 : entry.score,
  }))
}

function buildIncludeReason(entry: { memory: ProjectMemory; matchReasons: string[] }, profile?: string): string {
  const parts: string[] = []
  if (entry.matchReasons.some((r) => r.startsWith("lexical"))) parts.push("matches query")
  if (entry.memory.authority === "user") parts.push("user-stated")
  else if (entry.memory.authority === "source_state") parts.push("current state")
  if (NEVER_DROP_KINDS.has(entry.memory.kind)) parts.push("critical")
  if (profile && SPECIALIST_BOOSTS[profile]?.has(entry.memory.kind)) parts.push(`relevant to ${profile}`)
  if (parts.length === 0) parts.push(`score ${entry.matchReasons.length > 0 ? "high" : "moderate"}`)
  return parts.join(", ")
}
