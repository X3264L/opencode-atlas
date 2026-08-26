import type { Roadmap, RoadmapTask, ProjectObjective } from "./types"
import { validateRoadmap } from "./dag"

// Typed ChangeSet engine: all roadmap mutation flows through here.
// Atomic apply: validate everything against a version-checked snapshot,
// then commit all-or-nothing. Stale base versions are rejected.

export type RoadmapPatchOperation =
  | { op: "add_task"; task: RoadmapTask }
  | { op: "update_task"; taskID: string; fields: Partial<Pick<RoadmapTask, "title" | "description" | "acceptanceCriteria" | "affectedAreas" | "workerProfile" | "priority">> }
  | { op: "cancel_task"; taskID: string }
  | { op: "defer_task"; taskID: string }
  | { op: "reprioritize_task"; taskID: string; priority: number }
  | { op: "add_dependency"; taskID: string; dependsOn: string }
  | { op: "remove_dependency"; taskID: string; dependsOn: string }
  | { op: "invalidate_task"; taskID: string; reason?: string }
  | { op: "reopen_task"; taskID: string }
  | { op: "update_acceptance_criteria"; taskID: string; criteria: string[] }
  | { op: "update_project_constraints"; constraints: string[] }
  | { op: "add_artifact_reference"; taskID: string; artifactID: string }
  | { op: "invalidate_artifact"; artifactID: string; reason?: string }

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

export interface RoadmapChangeSet {
  id: string
  projectID: string
  instructionID: string

  baseRoadmapVersion: number
  baseObjectiveVersion: number

  operations: RoadmapPatchOperation[]
  impact: ImpactAnalysis
  risk: "low" | "medium" | "high"

  status: "proposed" | "validated" | "awaiting_review" | "applying" | "applied" | "rejected" | "failed"

  createdAt: number
  appliedAt?: number
}

export interface ApplyResult {
  ok: boolean
  roadmap?: Roadmap
  objective?: ProjectObjective
  error?: string
  staleVersions?: boolean
}

let csCounter = 0
function nextChangesetID() {
  csCounter += 1
  return `cs-${Date.now().toString(36)}-${csCounter}`
}

/**
 * Applies a ChangeSet atomically. Returns the mutated copies on success or an
 * error without touching the originals. Optimistic concurrency: rejects when
 * baseRoadmapVersion/baseObjectiveVersion don't match current state.
 */
export function applyChangeSet(
  changeset: Pick<RoadmapChangeSet, "baseRoadmapVersion" | "baseObjectiveVersion" | "operations">,
  currentRoadmap: Roadmap,
  currentObjective: ProjectObjective,
): ApplyResult {
  // Optimistic concurrency check
  if (changeset.baseRoadmapVersion !== currentRoadmap.version) {
    return { ok: false, staleVersions: true, error: `stale baseRoadmapVersion ${changeset.baseRoadmapVersion} != ${currentRoadmap.version}` }
  }
  if (changeset.baseObjectiveVersion !== currentObjective.version) {
    return { ok: false, staleVersions: true, error: `stale baseObjectiveVersion ${changeset.baseObjectiveVersion} != ${currentObjective.version}` }
  }

  // Deep-copy so partial failures never touch originals
  const roadmap: Roadmap = JSON.parse(JSON.stringify(currentRoadmap))
  const objective: ProjectObjective = JSON.parse(JSON.stringify(currentObjective))
  const byId = new Map(roadmap.tasks.map((t) => [t.id, t]))

  let objectiveChanged = false

  for (const op of changeset.operations) {
    switch (op.op) {
      case "add_task": {
        if (byId.has(op.task.id)) {
          return { ok: false, error: `duplicate task id: ${op.task.id}` }
        }
        const newTask = { ...op.task, revision: op.task.revision ?? 1 }
        roadmap.tasks.push(newTask)
        byId.set(op.task.id, newTask)
        break
      }
      case "update_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        Object.assign(existing, op.fields)
        existing.revision += 1
        break
      }
      case "cancel_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        if (existing.status === "complete") return { ok: false, error: `cannot cancel complete task ${op.taskID}` }
        existing.status = "cancelled"
        break
      }
      case "defer_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        existing.status = "blocked"
        break
      }
      case "reprioritize_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        existing.priority = op.priority
        break
      }
      case "add_dependency": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        if (op.dependsOn === op.taskID) return { ok: false, error: `self-dependency on ${op.taskID}` }
        if (!byId.has(op.dependsOn)) return { ok: false, error: `unknown dependency target ${op.dependsOn}` }
        if (!existing.dependencies.includes(op.dependsOn)) existing.dependencies.push(op.dependsOn)
        break
      }
      case "remove_dependency": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        existing.dependencies = existing.dependencies.filter((d) => d !== op.dependsOn)
        break
      }
      case "invalidate_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        existing.status = "planned"
        existing.attempt = 0
        existing.revision += 1
        break
      }
      case "reopen_task": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        existing.status = "ready"
        break
      }
      case "update_acceptance_criteria": {
        const existing = byId.get(op.taskID)
        if (!existing) return { ok: false, error: `unknown task ${op.taskID}` }
        if (op.criteria.length === 0) return { ok: false, error: `empty acceptance criteria for ${op.taskID}` }
        existing.acceptanceCriteria = op.criteria
        existing.revision += 1
        break
      }
      case "update_project_constraints": {
        objective.constraints = [...op.constraints]
        objectiveChanged = true
        break
      }
      default:
        return { ok: false, error: `unsupported operation` }
    }
  }

  if (objectiveChanged) objective.version += 1
  roadmap.version += 1

  // Post-apply DAG validation — reject the entire batch on cycle/invalid
  const validation = validateRoadmap(roadmap)
  if (!validation.ok) {
    return { ok: false, error: `post-apply validation failed: ${validation.errors.join("; ")}` }
  }

  return { ok: true, roadmap, objective }
}
