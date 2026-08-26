import type { WorkerResult, WorkerContract } from "./types"
import type { ProjectMemory } from "../brain/types"
import { AUTHORITY_ORDER } from "../brain/types"

// Event-driven Brain distillation: derives structured memories from real
// worker/session events without LLM calls. Deterministic extraction only.

export function distillWorkerCompletion(input: {
  contract: WorkerContract
  result: WorkerResult
  projectID: string
  roadmapVersion: number
}): ProjectMemory[] {
  const now = Date.now()
  const memories: ProjectMemory[] = []
  let counter = 0
  const uid = () => `distill-${now.toString(36)}-${++counter}`

  // Worker outcome
  memories.push({
    id: uid(),
    projectID: input.projectID,
    kind: "worker_outcome",
    title: `${input.contract.title}: ${input.result.status}`,
    content: input.result.summary.slice(0, 1000),
    status: "active",
    authority: "agent_result",
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
    taskID: input.contract.taskID,
    roadmapVersion: input.roadmapVersion,
    provenance: [{ kind: "task", id: input.contract.taskID }],
    tags: ["worker", input.result.status],
  })

  // Artifact summaries
  for (const artifact of input.result.artifacts) {
    memories.push({
      id: uid(),
      projectID: input.projectID,
      kind: "artifact_summary",
      title: artifact.label,
      content: `Artifact from ${input.contract.taskID}: ${artifact.label}${artifact.summary ? `. ${artifact.summary}` : ""}`,
      status: "active",
      authority: "agent_result",
      confidence: 0.7,
      createdAt: now,
      updatedAt: now,
      taskID: input.contract.taskID,
      provenance: [{ kind: "artifact", id: artifact.id }],
      tags: ["artifact", artifact.kind],
    })
  }

  // Verification evidence
  for (const evidence of input.result.verificationEvidence ?? []) {
    if (!evidence.passed) continue
    memories.push({
      id: uid(),
      projectID: input.projectID,
      kind: "verification_evidence",
      title: `Verification passed: ${evidence.step.kind}`,
      content: evidence.detail ?? `Verified ${evidence.step.kind} step`,
      status: "active",
      authority: "verified",
      confidence: 0.9,
      createdAt: now,
      updatedAt: now,
      taskID: input.contract.taskID,
      provenance: [{ kind: "verification", id: input.contract.taskID }],
      tags: ["verification"],
    })
  }

  // Failures
  for (const blocker of input.result.blockers ?? []) {
    memories.push({
      id: uid(),
      projectID: input.projectID,
      kind: "blocker",
      title: `Blocker: ${blocker.slice(0, 80)}`,
      content: blocker,
      status: "active",
      authority: "agent_result",
      confidence: 0.7,
      createdAt: now,
      updatedAt: now,
      taskID: input.contract.taskID,
      provenance: [{ kind: "session_message" }],
      tags: ["blocker"],
    })
  }

  return memories
}

// ---- Compaction ----

const COMPACTION_THRESHOLD_DERIVED = 10
const COMPACTION_THRESHOLD_DUPLICATE_PER_TASK = 3
const PROTECTED_KINDS = new Set(["constraint", "decision", "user_preference"])

/**
 * Merges repetitive derived summaries; never touches protected kinds.
 * Returns null if no compaction needed.
 */
export function compactMemories(memories: ProjectMemory[]): { compacted: ProjectMemory[]; removedCount: number } | null {
  const derived = memories.filter((m) => m.authority === "derived")
  if (derived.length < COMPACTION_THRESHOLD_DERIVED) return null

  // Group by taskID+kind to find duplicates per task revision
  const groupsByTask = new Map<string, ProjectMemory[]>()
  for (const m of derived) {
    const key = `${m.taskID ?? "none"}:${m.kind}`
    const list = groupsByTask.get(key) ?? []
    list.push(m)
    groupsByTask.set(key, list)
  }

  const removeIds = new Set<string>()
  for (const [, group] of groupsByTask) {
    if (group.length <= COMPACTION_THRESHOLD_DUPLICATE_PER_TASK) continue
    // Keep newest, remove oldest duplicates
    const sorted = group.sort((a, b) => b.updatedAt - a.updatedAt)
    for (let i = COMPACTION_THRESHOLD_DUPLICATE_PER_TASK; i < sorted.length; i++) {
      removeIds.add(sorted[i]!.id)
    }
  }

  if (removeIds.size === 0) return null

  return {
    compacted: memories.filter((m) => !removeIds.has(m.id)),
    removedCount: removeIds.size,
  }
}
