import type { Emit, Roadmap, RoadmapTask, WorkerResult } from "./types"
import { blockDownstream, readyTasks } from "./dag"

// Bounded-concurrency scheduler. Dependency safety comes from the DAG;
// write-scope conflicts serialize risky tasks; cancellation is cooperative.

export interface SchedulerDeps {
  maxConcurrentWorkers: number
  emit: Emit
  execute: (task: RoadmapTask) => Promise<WorkerResult>
  verify: (task: RoadmapTask, result: WorkerResult) => Promise<{ passed: boolean; evidence?: string[] }>
}

/** Two tasks conflict when their affected areas intersect or nest
 * (path-prefix aware: "src/auth" conflicts with "src/auth/login.ts") */
export function scopesConflict(a: RoadmapTask, b: RoadmapTask): boolean {
  const norm = (areas?: string[]) => [...new Set((areas ?? []).map((area) => area.trim().replace(/\/+$/, "")).filter(Boolean))]
  const aAreas = norm(a.affectedAreas)
  const bAreas = norm(b.affectedAreas)
  if (aAreas.includes("*") || bAreas.includes("*")) return aAreas.length + bAreas.length > 0
  for (const x of aAreas) {
    for (const y of bAreas) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true
    }
  }
  return false
}

/** Greedy batch selection honoring concurrency + write-scope serialization */
export function selectBatch(ready: RoadmapTask[], running: RoadmapTask[], maxConcurrent: number): RoadmapTask[] {
  const capacity = Math.max(0, maxConcurrent - running.length)
  if (capacity === 0) return []
  const batch: RoadmapTask[] = []
  for (const task of ready) {
    if (batch.length >= capacity) break
    // Non-parallelizable tasks run alone; conflicting scopes serialize
    const conflicts = [...running, ...batch].some(
      (other) => !task.parallelizable || !other.parallelizable || scopesConflict(task, other),
    )
    if (!conflicts) batch.push(task)
  }
  return batch.length > 0 ? batch : ready.length > 0 && running.length === 0 ? [ready[0]!] : []
}

export interface ScheduleOutcome {
  completed: Set<string>
  failed: Set<string>
  cancelledCount: number
}

/**
 * Drives the roadmap to completion (or cancellation/blocking). Deterministic
 * given deterministic execute/verify fakes.
 */
export async function scheduleRoadmap(input: {
  roadmap: Roadmap
  deps: SchedulerDeps
  isCancelled: () => boolean
  isPaused?: () => boolean | Promise<boolean>
}): Promise<ScheduleOutcome> {
  const { roadmap, deps, isCancelled } = input
  const isPaused = input.isPaused ?? (() => false)
  const completed = new Set<string>()
  const failed = new Set<string>()
  let cancelledCount = 0

  const setState = (task: RoadmapTask, state: RoadmapTask["status"]) => {
    task.status = state
    deps.emit({ type: "atlas.task.state", projectID: "", taskID: task.id, state, attempt: task.attempt })
  }

  for (;;) {
    if (isCancelled()) {
      for (const task of roadmap.tasks) {
        if (["planned", "ready", "blocked"].includes(task.status)) {
          task.status = "cancelled"
          cancelledCount += 1
        }
      }
      return { completed, failed, cancelledCount }
    }
    if (await isPaused()) {
      return { completed, failed, cancelledCount }
    }

    const ready = readyTasks(roadmap, completed, failed)
    const running = roadmap.tasks.filter((task) => task.status === "running" || task.status === "verifying")

    if (ready.length === 0 && running.length === 0) {
      // Nothing schedulable remains
      break
    }

    const batch = selectBatch(ready, running, deps.maxConcurrentWorkers)
    if (batch.length === 0 && running.length === 0) {
      // Ready exists but everything conflicts with nothing running → take one anyway
      batch.push(ready[0]!)
    }
    if (batch.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      continue
    }

    await Promise.all(
      batch.map(async (task) => {
        // Cancellation between batch selection and execution
        if (isCancelled()) {
          setState(task, "cancelled")
          cancelledCount += 1
          return
        }
        setState(task, "running")
        deps.emit({
          type: "atlas.worker.started",
          projectID: "",
          taskID: task.id,
          ...(task.workerProfile ? { profile: task.workerProfile } : {}),
        })
        try {
          const result = await deps.execute(task)
          if (isCancelled()) {
            task.attempt += 1
            setState(task, "cancelled")
            cancelledCount += 1
            return
          }
          if (result.status !== "completed") {
            throw new Error(result.blockers?.join("; ") ?? result.summary ?? "worker did not complete")
          }

          setState(task, "verifying")
          const verification = await deps.verify(task, result)
          deps.emit({
            type: "atlas.verification.completed",
            projectID: "",
            taskID: task.id,
            passed: verification.passed,
          })

          if (verification.passed) {
            task.attempt += 1
            setState(task, "complete")
            completed.add(task.id)
            deps.emit({ type: "atlas.worker.completed", projectID: "", taskID: task.id })
          } else if (task.attempt + 1 < task.maxAttempts) {
            task.attempt += 1
            setState(task, "ready") // bounded retry with prior evidence available
          } else {
            setState(task, "failed")
            failed.add(task.id)
            blockDownstream(roadmap, task.id)
            deps.emit({
              type: "atlas.worker.failed",
              projectID: "",
              taskID: task.id,
              failureClass: "test_failure",
              detail: "verification failed after max attempts",
            })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isCancelled() || message.toLowerCase().includes("cancel")) {
            setState(task, "cancelled")
            cancelledCount += 1
            return
          }
          if (task.attempt + 1 < task.maxAttempts) {
            task.attempt += 1
            setState(task, "ready")
          } else {
            setState(task, "failed")
            failed.add(task.id)
            blockDownstream(roadmap, task.id)
            deps.emit({
              type: "atlas.worker.failed",
              projectID: "",
              taskID: task.id,
              failureClass: "unknown",
              ...(message ? { detail: message } : {}),
            })
          }
        }
      }),
    )
  }

  return { completed, failed, cancelledCount }
}
