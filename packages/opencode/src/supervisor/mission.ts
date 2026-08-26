import type { Roadmap, RoadmapTask } from "../orchestrator/types"

// Mission Control: aggregated read-only snapshot from authoritative subsystems.

export interface MissionControlSnapshot {
  projectID: string
  roadmapVersion: number
  roadmapStatus: string
  objectiveVersion: number
  totalTasks: number
  completeTasks: number
  failedTasks: number
  blockedTasks: number
  runningTasks: string[]
  health: "healthy" | "degraded" | "recovering" | "blocked"
  criticalPathLength: number
  tasks: {
    id: string
    title: string
    status: string
    dependencies: string[]
    priority: number
    workerProfile?: string
    attempt: number
    maxAttempts: number
    revision: number
  }[]
}

export function buildMissionControlSnapshot(
  projectID: string,
  roadmap: Roadmap,
  criticalPath: Map<string, number>,
): MissionControlSnapshot {
  const running = roadmap.tasks.filter((t) => t.status === "running").map((t) => t.id)
  const complete = roadmap.tasks.filter((t) => t.status === "complete").length
  const failed = roadmap.tasks.filter((t) => t.status === "failed").length
  const blocked = roadmap.tasks.filter((t) => t.status === "blocked").length

  const maxCritical = Math.max(0, ...criticalPath.values())

  let health: MissionControlSnapshot["health"] = "healthy"
  if (blocked > 0 || failed > 0) health = "degraded"
  if (roadmap.status === "blocked") health = "blocked"

  return {
    projectID,
    roadmapVersion: roadmap.version,
    roadmapStatus: roadmap.status,
    objectiveVersion: roadmap.version,
    totalTasks: roadmap.tasks.length,
    completeTasks: complete,
    failedTasks: failed,
    blockedTasks: blocked,
    runningTasks: running,
    health,
    criticalPathLength: maxCritical,
    tasks: roadmap.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dependencies: [...task.dependencies],
      priority: task.priority,
      ...(task.workerProfile ? { workerProfile: task.workerProfile } : {}),
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      revision: task.revision ?? 1,
    })),
  }
}

// ---- Release Autopilot --------------------------------------------------------

export interface ReleaseGateResult {
  gateID: string
  status: "pass" | "fail" | "unknown" | "skipped"
  evidenceRefs: string[]
  checkedAt: number
}

export interface ReleaseGate {
  gateID: string
  label: string
  required: boolean
  evaluate: (roadmap: Roadmap) => ReleaseGateResult
}

let releaseCounter = 0

export interface ReleasePlan {
  id: string
  projectID: string
  roadmapVersion: number
  gates: ReleaseGate[]
  results: ReleaseGateResult[]
  status: "draft" | "checking" | "ready" | "blocked" | "released" | "cancelled"
  createdAt: number
}

export function createReleaseGates(roadmap: Roadmap): ReleaseGate[] {
  return [
    { gateID: "all-tasks-complete", label: "All required tasks complete", required: true, evaluate: (rm) => ({ gateID: "all-tasks-complete", status: rm.tasks.every((t) => t.status === "complete") ? ("pass" as const) : ("fail" as const), evidenceRefs: [], checkedAt: Date.now() }) },
    { gateID: "no-blocked", label: "No blocked tasks", required: true, evaluate: (rm) => ({ gateID: "no-blocked", status: rm.tasks.some((t) => t.status === "blocked") ? ("fail" as const) : ("pass" as const), evidenceRefs: [], checkedAt: Date.now() }) },
    { gateID: "no-failed", label: "No failed tasks", required: true, evaluate: (rm) => ({ gateID: "no-failed", status: rm.tasks.some((t) => t.status === "failed") ? ("fail" as const) : ("pass" as const), evidenceRefs: [], checkedAt: Date.now() }) },
  ]
}

export function checkReleaseReadiness(projectID: string, roadmap: Roadmap): ReleasePlan {
  const gates = createReleaseGates(roadmap)
  const results = gates.map((gate) => gate.evaluate(roadmap))
  const allPass = results.every((r) => r.gateID && r.status === "pass")
  void allPass

  releaseCounter += 1
  const failedGate = results.find((r) => r.status === "fail")
  return {
    id: `release-${Date.now().toString(36)}-${releaseCounter}`,
    projectID,
    roadmapVersion: roadmap.version,
    gates,
    results: results.map((r) => ({ ...r, checkedAt: Date.now() })),
    status: failedGate ? "blocked" : "ready",
    createdAt: Date.now(),
  }
}
