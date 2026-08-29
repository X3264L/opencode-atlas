import type { WorkerResult, WorkerContract } from "./types"

export interface WorkerHandoff {
  fromWorkerID?: string
  toRoleID: string
  taskID: string
  taskRevision: number
  validArtifactIDs: string[]
  staleArtifactIDs: string[]
  decisionIDs: string[]
  blockers: string[]
  contextPackSummary?: string
  reasonCode: string
  createdAt: number
}

export function createHandoff(input: {
  fromWorkerID?: string
  toRoleID: string
  taskID: string
  taskRevision: number
  priorResult?: WorkerResult
  priorContract?: WorkerContract
  reasonCode: string
}): WorkerHandoff {
  const artifacts = input.priorResult?.artifacts ?? []
  const failed = input.reasonCode.includes("fail") || input.reasonCode.includes("crash")
  return {
    fromWorkerID: input.fromWorkerID,
    toRoleID: input.toRoleID,
    taskID: input.taskID,
    taskRevision: input.taskRevision,
    validArtifactIDs: failed ? [] : artifacts.map((a) => a.id),
    staleArtifactIDs: failed ? artifacts.map((a) => a.id) : [],
    decisionIDs: [],
    blockers: input.priorResult?.blockers ?? [],
    ...(input.priorResult?.summary ? { contextPackSummary: input.priorResult.summary.slice(0, 500) } : {}),
    reasonCode: input.reasonCode,
    createdAt: Date.now(),
  }
}

/** Renders handoff as text for inclusion in replacement worker's prompt */
export function handoffToPromptText(handoff: WorkerHandoff): string {
  const lines = [`## Handoff from previous worker (${handoff.reasonCode})`]
  if (handoff.contextPackSummary) lines.push("", "### Prior worker result", handoff.contextPackSummary)
  if (handoff.blockers.length > 0) lines.push("", "### Blockers", ...handoff.blockers.map((b) => `- ${b}`))
  if (handoff.validArtifactIDs.length > 0)
    lines.push("", "### Valid artifacts from prior work", ...handoff.validArtifactIDs.map((id) => `- ${id}`))
  if (handoff.staleArtifactIDs.length > 0)
    lines.push("", "### Stale artifacts (do NOT rely on these)", ...handoff.staleArtifactIDs.map((id) => `- ${id}`))
  return lines.join("\n")
}
