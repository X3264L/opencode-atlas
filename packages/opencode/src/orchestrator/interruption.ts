import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"

// Safe active-tool interruption coordinator.
//
// One authoritative coordinator per orchestrator layer tracks active workers,
// their in-flight tool calls, interruption requests (with cause merging),
// fencing generations, and stale-result rejection. All interruption flows —
// roadmap mutation, supervisor recovery, pause, cancel, worker replacement —
// converge here.

export type ToolInterruptionClass =
  | "read_only_cancellable"
  | "cancellable"
  | "side_effectful"
  | "non_cancellable"
  | "unknown"

export type InterruptCause =
  | "roadmap_mutation"
  | "supervisor_recovery"
  | "project_pause"
  | "project_cancel"
  | "worker_replacement"

export type InterruptionStatus =
  | "requested"
  | "waiting_for_tool"
  | "cancelling"
  | "safe_boundary"
  | "checkpointing"
  | "handoff_ready"
  | "completed"
  | "failed"

export interface ActiveToolState {
  toolCallID: string
  name: string
  safety: ToolInterruptionClass
  startedAt: number
}

export interface WorkerInterruption {
  id: string
  projectID: string
  workerID: string
  sessionID: string
  taskID: string
  taskRevision: number
  requestedAt: number
  causes: InterruptCause[]
  primaryCause: InterruptCause
  status: InterruptionStatus
  activeToolCallID?: string
  toolSafety?: ToolInterruptionClass
  checkpointID?: string
  handoffReady: boolean
}

export interface WorkerRegistration {
  projectID: string
  workerID: string
  sessionID: string
  taskID: string
  taskRevision: number
  generation: number
  activeTool: ActiveToolState | null
  interruptionID?: string
}

/** Conservative tool-name → safety classification. Names are stable tool IDs
 * from the registry; unknown tools default to "unknown" (most conservative). */
const TOOL_SAFETY: Record<string, ToolInterruptionClass> = {
  read: "read_only_cancellable",
  grep: "read_only_cancellable",
  glob: "read_only_cancellable",
  list: "read_only_cancellable",
  find: "read_only_cancellable",
  webfetch: "read_only_cancellable",
  lsp: "read_only_cancellable",
  ls: "read_only_cancellable",
  tree: "read_only_cancellable",
  todo: "read_only_cancellable",
  todowrite: "cancellable",
  write: "side_effectful",
  edit: "side_effectful",
  apply_patch: "side_effectful",
  bash: "side_effectful",
  shell: "side_effectful",
  task: "unknown",
  skill: "cancellable",
  question: "cancellable",
}

export function classifyToolInterruption(name: string): ToolInterruptionClass {
  return TOOL_SAFETY[name] ?? "unknown"
}

let interruptionCounter = 0

export class WorkerInterruptionCoordinator {
  private workers = new Map<string, WorkerRegistration>()
  private interruptions = new Map<string, WorkerInterruption>()
  private fences = new Map<string, { generation: number; owner: string | null }>()
  private onEvent?: (event: { type: string; projectID: string; taskID: string; workerID?: string; cause?: string }) => void

  constructor(onEvent?: WorkerInterruptionCoordinator["onEvent"]) {
    this.onEvent = onEvent
  }

  register(projectID: string, workerID: string, sessionID: string, taskID: string, taskRevision: number): void {
    const generation = (this.fences.get(taskID)?.generation ?? 0) + 1
    this.fences.set(taskID, { generation, owner: workerID })
    this.workers.set(workerID, { projectID, workerID, sessionID, taskID, taskRevision, generation, activeTool: null })
  }

  unregister(workerID: string): void {
    const reg = this.workers.get(workerID)
    if (reg) {
      const fence = this.fences.get(reg.taskID)
      if (fence && fence.owner === workerID) fence.owner = null
    }
    this.workers.delete(workerID)
  }

  trackToolStart(workerID: string, toolCallID: string, name: string): void {
    const reg = this.workers.get(workerID)
    if (!reg) return
    reg.activeTool = { toolCallID, name, safety: classifyToolInterruption(name), startedAt: Date.now() }
  }

  trackToolSettled(workerID: string, toolCallID: string): void {
    const reg = this.workers.get(workerID)
    if (!reg || !reg.activeTool || reg.activeTool.toolCallID !== toolCallID) return
    reg.activeTool = null
    // A pending interruption waiting for the tool can now reach the boundary.
    if (reg.interruptionID) {
      const interruption = this.interruptions.get(reg.interruptionID)
      if (interruption && (interruption.status === "waiting_for_tool" || interruption.status === "cancelling")) {
        interruption.status = "safe_boundary"
        this.emit({ type: "atlas.worker.interrupted", projectID: interruption.projectID, taskID: interruption.taskID, workerID })
      }
    }
  }

  hasActiveTool(workerID: string): boolean {
    return this.workers.get(workerID)?.activeTool !== null && this.workers.get(workerID)?.activeTool !== undefined
  }

  getActiveTool(workerID: string): ActiveToolState | null {
    return this.workers.get(workerID)?.activeTool ?? null
  }

  /** Merges causes: if an interruption is already pending for this worker, the
   * new cause is added; exactly one flow results. Returns the interruption ID
   * or null if the worker is unknown. */
  interrupt(projectID: string, workerID: string, cause: InterruptCause): string | null {
    const reg = this.workers.get(workerID)
    if (!reg) return null

    // Merge into existing pending interruption
    if (reg.interruptionID) {
      const existing = this.interruptions.get(reg.interruptionID)
      if (existing && existing.status !== "completed" && existing.status !== "failed") {
        if (!existing.causes.includes(cause)) existing.causes.push(cause)
        return existing.id
      }
    }

    interruptionCounter += 1
    const id = `int-${Date.now().toString(36)}-${interruptionCounter}`
    const tool = reg.activeTool
    const safety = tool?.safety ?? "unknown"

    const interruption: WorkerInterruption = {
      id,
      projectID,
      workerID,
      sessionID: reg.sessionID,
      taskID: reg.taskID,
      taskRevision: reg.taskRevision,
      requestedAt: Date.now(),
      causes: [cause],
      primaryCause: cause,
      status: tool ? (safety === "side_effectful" || safety === "unknown" || safety === "non_cancellable" ? "waiting_for_tool" : "cancelling") : "safe_boundary",
      ...(tool ? { activeToolCallID: tool.toolCallID, toolSafety: safety } : {}),
      handoffReady: false,
    }
    this.interruptions.set(id, interruption)
    reg.interruptionID = id

    // Fence the old worker immediately: bump the generation and clear the
    // owner so any subsequent result from this worker is detected as stale.
    const fence = this.fences.get(reg.taskID)
    if (fence) {
      fence.generation += 1
      fence.owner = null
    }

    this.emit({ type: "atlas.worker.interruption.requested", projectID, taskID: reg.taskID, workerID, cause })
    return id
  }

  markSafeBoundary(interruptionID: string): void {
    const interruption = this.interruptions.get(interruptionID)
    if (!interruption) return
    interruption.status = "safe_boundary"
    this.emit({ type: "atlas.worker.interrupted", projectID: interruption.projectID, taskID: interruption.taskID, workerID: interruption.workerID })
  }

  markCheckpointing(interruptionID: string, checkpointID: string): void {
    const interruption = this.interruptions.get(interruptionID)
    if (!interruption) return
    interruption.status = "checkpointing"
    interruption.checkpointID = checkpointID
  }

  markHandoffReady(interruptionID: string): void {
    const interruption = this.interruptions.get(interruptionID)
    if (!interruption) return
    interruption.status = "handoff_ready"
    interruption.handoffReady = true
  }

  complete(interruptionID: string): void {
    const interruption = this.interruptions.get(interruptionID)
    if (!interruption) return
    interruption.status = "completed"
    const reg = this.workers.get(interruption.workerID)
    if (reg) reg.interruptionID = undefined
  }

  /** Fences a worker: bumps the task's generation so any late result from the
   * old generation is rejected. Returns the new generation. */
  fenceAndReplace(projectID: string, taskID: string, oldWorkerID: string): number {
    const fence = this.fences.get(taskID) ?? { generation: 0, owner: null }
    fence.generation += 1
    fence.owner = null
    this.fences.set(taskID, fence)
    return fence.generation
  }

  /** Whether a result from the given worker for the given task is stale. */
  isStale(taskID: string, workerID: string): boolean {
    const fence = this.fences.get(taskID)
    if (!fence) return false
    return fence.owner !== workerID
  }

  getGeneration(taskID: string): number {
    return this.fences.get(taskID)?.generation ?? 0
  }

  getWorkerByTask(taskID: string): WorkerRegistration | undefined {
    for (const reg of this.workers.values()) {
      if (reg.taskID === taskID) return reg
    }
    return undefined
  }

  getWorkerBySession(sessionID: string): WorkerRegistration | undefined {
    return this.workers.get(sessionID)
  }

  getWorkersByProject(projectID: string): WorkerRegistration[] {
    return [...this.workers.values()].filter((reg) => reg.projectID === projectID)
  }

  getInterruption(id: string): WorkerInterruption | undefined {
    return this.interruptions.get(id)
  }

  getPendingByProject(projectID: string): WorkerInterruption[] {
    return [...this.interruptions.values()].filter(
      (i) => i.projectID === projectID && i.status !== "completed" && i.status !== "failed",
    )
  }

  private emit(event: { type: string; projectID: string; taskID: string; workerID?: string; cause?: string }): void {
    this.onEvent?.(event)
  }
}
