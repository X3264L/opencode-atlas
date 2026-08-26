import type { Roadmap } from "./types"
import { downstream as dagDownstream } from "./dag"
import type { RoadmapPatchOperation } from "./changeset"

export interface ImpactAnalysis {
  directlyAffectedTaskIDs: string[]
  downstreamTaskIDs: string[]
  activeWorkerTaskIDs: string[]
  completedTaskIDs: string[]
  invalidatedArtifactIDs: string[]
  reusableArtifactIDs: string[]
  verificationInvalidations: string[]
  interruptTaskIDs: string[]
  continueTaskIDs: string[]
  risk: "low" | "medium" | "high"
  reasons: string[]
}

/**
 * Computes the impact of a ChangeSet on a roadmap. Deterministic — uses DAG
 * structure, task status, affected areas and artifact references.
 */
export function analyzeImpact(
  roadmap: Roadmap,
  operations: RoadmapPatchOperation[],
  runningTaskIDs: Set<string>,
): ImpactAnalysis {
  const directlyAffected = new Set<string>()
  for (const op of operations) {
    if ("taskID" in op && op.taskID) directlyAffected.add(op.taskID)
    if (op.op === "add_task") directlyAffected.add(op.task.id)
  }

  // Downstream = transitive dependents of directly-affected tasks
  const downstreamSet = new Set<string>()
  for (const taskID of directlyAffected) {
    for (const dep of dagDownstream(roadmap, taskID)) {
      if (!directlyAffected.has(dep)) downstreamSet.add(dep)
    }
  }

  // Classify each affected task by current status
  const activeWorker: string[] = []
  const completed: string[] = []
  const interrupt: string[] = []
  const continueRunning: string[] = []
  const verificationInvalidations: string[] = []

  for (const id of directlyAffected) {
    const task = roadmap.tasks.find((t) => t.id === id)
    if (!task) continue
    if (runningTaskIDs.has(id)) {
      activeWorker.push(id)
      // Architecture-level changes to a running worker require interruption
      interrupt.push(id)
    } else if (task.status === "complete") {
      completed.push(id)
      // Completed tasks that are directly modified need reverification
      verificationInvalidations.push(id)
      interrupt.push(id)
    } else {
      continueRunning.push(id)
    }
  }

  // Downstream tasks with complete status need reverification
  for (const id of downstreamSet) {
    const task = roadmap.tasks.find((t) => t.id === id)
    if (task?.status === "complete" || task?.status === "verifying") {
      verificationInvalidations.push(id)
    }
  }

  // Risk assessment
  let risk: ImpactAnalysis["risk"] = "low"
  const riskReasons: string[] = []
  if (interrupt.length > 0) {
    risk = "medium"
    riskReasons.push(`${interrupt.length} active worker(s) interrupted`)
  }
  if (verificationInvalidations.length > 0) {
    risk = "medium"
    riskReasons.push(`${verificationInvalidations.length} verification(s) invalidated`)
  }
  const hasArchitectureOp = operations.some(
    (op) => op.op === "update_acceptance_criteria" || op.op === "invalidate_task",
  )
  if (hasArchitectureOp && directlyAffected.size >= 3) {
    risk = "high"
    riskReasons.push("architecture change touching multiple tasks")
  }
  if (operations.some((op) => op.op === "cancel_task")) {
    if (runningTaskIDs.size > 0) {
      risk = "high"
      riskReasons.push("cancelling potentially active work")
    }
  }
  void riskReasons

  return {
    directlyAffectedTaskIDs: [...directlyAffected],
    downstreamTaskIDs: [...downstreamSet],
    activeWorkerTaskIDs: activeWorker,
    completedTaskIDs: completed,
    invalidatedArtifactIDs: [],
    reusableArtifactIDs: [],
    verificationInvalidations,
    interruptTaskIDs: interrupt,
    continueTaskIDs: [...runningTaskIDs].filter((id) => !directlyAffected.has(id)),
    risk,
    reasons: riskReasons,
  }
}
