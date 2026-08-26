import type { Roadmap, RoadmapTask, TaskStatus } from "./types"

// Deterministic DAG engine: validation, readiness computation, downstream
// traversal and parallel-safe batching. Malformed roadmaps are never executed.

export interface DagValidation {
  ok: boolean
  errors: string[]
}

const VALID_STATUSES: TaskStatus[] = [
  "planned",
  "ready",
  "running",
  "blocked",
  "verifying",
  "complete",
  "failed",
  "cancelled",
]

export function validateRoadmap(roadmap: Roadmap): DagValidation {
  const errors: string[] = []
  const seen = new Set<string>()

  if (!Array.isArray(roadmap.tasks) || roadmap.tasks.length === 0) {
    errors.push("roadmap has no tasks")
  }

  for (const task of roadmap.tasks ?? []) {
    if (seen.has(task.id)) errors.push(`duplicate task id: ${task.id}`)
    seen.add(task.id)
    if (!VALID_STATUSES.includes(task.status)) errors.push(`invalid status on ${task.id}: ${task.status}`)
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      errors.push(`empty acceptance criteria on ${task.id}`)
    }
    if (typeof task.priority !== "number" || !Number.isFinite(task.priority)) {
      errors.push(`invalid priority on ${task.id}`)
    }
    if (!(task.maxAttempts >= 1)) errors.push(`invalid maxAttempts on ${task.id}`)
  }

  for (const task of roadmap.tasks ?? []) {
    for (const dep of task.dependencies ?? []) {
      if (dep === task.id) errors.push(`self-dependency on ${task.id}`)
      else if (!seen.has(dep)) errors.push(`unknown dependency ${dep} on ${task.id}`)
    }
  }

  // Cycle detection via iterative DFS with colors
  const byId = indexBy(roadmap.tasks ?? [])
  const color = new Map<string, number>()
  const visit = (id: string, stack: Set<string>): void => {
    const state = color.get(id) ?? 0
    if (state === 1) return
    if (stack.has(id)) {
      errors.push(`dependency cycle involving ${id}`)
      return
    }
    stack.add(id)
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (dep === id) continue
      visit(dep, stack)
    }
    stack.delete(id)
    color.set(id, 1)
  }
  for (const task of roadmap.tasks ?? []) visit(task.id, new Set())

  return { ok: errors.length === 0, errors }
}

export function indexBy(tasks: RoadmapTask[]): Map<string, RoadmapTask> {
  return new Map(tasks.map((task) => [task.id, task]))
}

/** Tasks whose dependencies are all complete and which are schedulable now */
export function readyTasks(roadmap: Roadmap, completed: Set<string>, failed: Set<string>): RoadmapTask[] {
  return roadmap.tasks
    .filter((task) => !completed.has(task.id))
    .filter((task) => task.status === "planned" || task.status === "ready")
    .filter((task) => task.dependencies.every((dep) => completed.has(dep)))
    .filter((task) => !task.dependencies.some((dep) => failed.has(dep)))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

/** Downstream task ids that depend (transitively) on the given task */
export function downstream(roadmap: Roadmap, taskID: string): Set<string> {
  const result = new Set<string>()
  let frontier = [taskID]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const task of roadmap.tasks) {
      if (result.has(task.id)) continue
      if (task.dependencies.some((dep) => frontier.includes(dep))) {
        result.add(task.id)
        next.push(task.id)
      }
    }
    frontier = next
  }
  return result
}

/** Blocks downstream tasks of failed ones; returns newly blocked ids */
export function blockDownstream(roadmap: Roadmap, failedTaskID: string): string[] {
  const blocked: string[] = []
  for (const id of downstream(roadmap, failedTaskID)) {
    const task = roadmap.tasks.find((entry) => entry.id === id)
    if (task && (task.status === "planned" || task.status === "ready")) {
      task.status = "blocked"
      blocked.push(id)
    }
  }
  return blocked
}
