// Atlas Project Orchestrator - typed project/roadmap/task substrate.
//
// The deterministic core (DAG validation, scheduling order, write-scope
// serialization) lives here; execution delegates to existing OpenCode
// sessions/agents; model choice always flows through the Atlas router.

export type PrivacyPolicy = "standard" | "prefer_local" | "local_only"

export interface ProjectObjective {
  id: string
  projectID: string
  title: string
  description: string
  acceptanceCriteria: string[]
  constraints: string[]
  priorities: string[]
  /** Bumped when acceptance criteria/constraints/priorities change */
  version: number
  createdAt: number
  updatedAt: number
}

export type RoadmapStatus = "planning" | "executing" | "verifying" | "complete" | "blocked" | "cancelled"

export type TaskStatus =
  | "planned"
  | "ready"
  | "running"
  | "blocked"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled"

export interface RoadmapTask {
  id: string
  title: string
  description: string
  status: TaskStatus
  dependencies: string[]
  acceptanceCriteria: string[]
  affectedAreas?: string[]
  expectedArtifacts?: string[]
  workerProfile?: string
  preferredCapabilities?: string[]
  priority: number
  parallelizable: boolean
  attempt: number
  maxAttempts: number
  /** Bumped when the task's scope/criteria change (distinct from failure attempts) */
  revision: number
}

export interface Roadmap {
  version: number
  objectiveID: string
  status: RoadmapStatus
  tasks: RoadmapTask[]
}

// ---- Contracts / results ----------------------------------------------------

export interface ContextReference {
  kind: string
  id: string
  locator?: string
  summary?: string
}

export interface VerificationStep {
  kind: "command" | "test" | "file_exists" | "review"
  command?: string
  target?: string
  path?: string
  criteria?: string[]
}

export interface WorkerContract {
  taskID: string
  roadmapVersion: number

  objectiveSummary: string
  title: string
  description: string

  completedDependencies: string[]
  acceptanceCriteria: string[]
  constraints: string[]

  contextRefs: ContextReference[]
  expectedArtifacts: string[]

  workerProfile?: string
  preferredCapabilities?: string[]

  verificationPlan: VerificationStep[]
}

export interface WorkerArtifact {
  id: string
  taskID: string
  kind: string
  label: string
  locator?: string
  summary?: string
  /** Lineage tracking for live roadmap mutation */
  status?: "valid" | "stale" | "invalidated" | "superseded"
  roadmapVersionCreated?: number
  objectiveVersionCreated?: number
  taskRevisionCreated?: number
  sourceCheckpointID?: string
  invalidatedByInstructionID?: string
  invalidatedByChangeSetID?: string
  supersededByArtifactID?: string
  reason?: string
}

export interface VerificationEvidence {
  step: VerificationStep
  passed: boolean
  detail?: string
}

export interface WorkerResult {
  taskID: string
  status: "completed" | "failed" | "blocked" | "cancelled"
  summary: string

  artifacts: WorkerArtifact[]
  filesChanged?: string[]
  commandsRun?: string[]
  verificationEvidence?: VerificationEvidence[]

  blockers?: string[]
  reusableWork?: ContextReference[]

  startedAt: number
  finishedAt: number
}

export type FailureClass =
  | "model_failure"
  | "tool_failure"
  | "test_failure"
  | "build_failure"
  | "scope_conflict"
  | "missing_dependency"
  | "insufficient_context"
  | "blocked_external"
  | "cancelled"
  | "unknown"

export interface Checkpoint {
  taskID: string
  workerSessionID?: string
  status: TaskStatus
  completedWork: string[]
  remainingWork: string[]
  filesChanged: string[]
  artifacts: WorkerArtifact[]
  verificationState?: string
  contextRefs: ContextReference[]
  at: number
}

// ---- Events -----------------------------------------------------------------

export type OrchestratorEvent =
  | { type: "atlas.project.created"; projectID: string; title: string }
  | { type: "atlas.roadmap.updated"; projectID: string; version: number }
  | { type: "atlas.task.state"; projectID: string; taskID: string; state: TaskStatus; attempt: number }
  | { type: "atlas.worker.started"; projectID: string; taskID: string; profile?: string }
  | { type: "atlas.worker.completed"; projectID: string; taskID: string }
  | { type: "atlas.worker.failed"; projectID: string; taskID: string; failureClass: FailureClass; detail?: string }
  | { type: "atlas.verification.completed"; projectID: string; taskID: string; passed: boolean }
  | { type: "atlas.project.completed"; projectID: string }
  | { type: "atlas.project.blocked"; projectID: string; reason?: string }
  | { type: "atlas.project.cancelled"; projectID: string }

export type Emit = (event: OrchestratorEvent) => void
