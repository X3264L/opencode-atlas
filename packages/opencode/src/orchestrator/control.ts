import path from "path"
import Bun from "bun"
import { Global } from "@opencode-ai/core/global"

// Persisted control state + checkpoint metadata (file-backed, restart-safe)

export type PauseMode = "stop_scheduling_only" | "finish_current_safe_step" | "checkpoint_and_stop_workers"
export type ControlStatus = "running" | "pausing" | "paused" | "resuming"

export interface ProjectControlState {
  status: ControlStatus
  mode?: PauseMode
  requestedAt?: number
  pausedAt?: number
  checkpointID?: string
  reason?: string
}

export interface ProjectCheckpoint {
  id: string
  projectID: string
  createdAt: number
  objectiveVersion: number
  roadmapVersion: number
  organizationVersion?: number
  projectStatus: string
  pauseState?: string
  activeWorkerCheckpoints: {
    workerID: string
    taskID: string
    taskRevision: number
    checkpointID?: string
  }[]
  git: {
    branch?: string
    head?: string
    base?: string
    dirty?: boolean
    diffstat?: { additions: number; deletions: number; files: number }
  }
  brain: {
    memoryCount?: number
    latestMemoryTimestamp?: number
    snapshotRef?: string
  }
  verification: {
    completedTaskIDs: string[]
    failedTaskIDs: string[]
    blockedTaskIDs: string[]
  }
  openIncidentIDs: string[]
}

function controlPath(projectID: string) {
  return path.join(Global.Path.state, "orchestrator", projectID, "control.json")
}

function checkpointDir(projectID: string) {
  return path.join(Global.Path.state, "orchestrator", projectID, "checkpoints")
}

function checkpointPath(projectID: string, checkpointID: string) {
  return path.join(checkpointDir(projectID), `${checkpointID}.json`)
}

export async function loadControlState(projectID: string): Promise<ProjectControlState> {
  try {
    const raw = await Bun.file(controlPath(projectID)).json()
    if (raw && typeof raw === "object" && typeof raw.status === "string") return raw as ProjectControlState
  } catch {}
  return { status: "running" }
}

export async function saveControlState(projectID: string, state: ProjectControlState): Promise<void> {
  const file = controlPath(projectID)
  await Bun.write(file, JSON.stringify(state, null, 2))
}

export async function saveCheckpoint(checkpoint: ProjectCheckpoint): Promise<void> {
  const dir = checkpointDir(checkpoint.projectID)
  // ensure dir via Bun.write will create, but ensure parent
  const file = checkpointPath(checkpoint.projectID, checkpoint.id)
  await Bun.write(file, JSON.stringify(checkpoint, null, 2))
  // also update latest pointer
  const latestPath = path.join(dir, "_latest.json")
  await Bun.write(latestPath, JSON.stringify({ id: checkpoint.id }, null, 2))
}

export async function loadCheckpoint(projectID: string, checkpointID: string): Promise<ProjectCheckpoint | undefined> {
  try {
    const raw = await Bun.file(checkpointPath(projectID, checkpointID)).json()
    return raw as ProjectCheckpoint
  } catch {
    return undefined
  }
}

export async function listCheckpoints(projectID: string): Promise<ProjectCheckpoint[]> {
  const dir = checkpointDir(projectID)
  try {
    const entries = await Array.fromAsync(new Bun.Glob("chk-*.json").scan({ cwd: dir, onlyFiles: true }))
    const checkpoints: ProjectCheckpoint[] = []
    for (const entry of entries) {
      if (entry === "_latest.json") continue
      try {
        const raw = await Bun.file(path.join(dir, entry)).json()
        checkpoints.push(raw as ProjectCheckpoint)
      } catch {}
    }
    checkpoints.sort((a, b) => a.createdAt - b.createdAt)
    return checkpoints
  } catch {
    return []
  }
}

export async function latestCheckpoint(projectID: string): Promise<ProjectCheckpoint | undefined> {
  const checkpoints = await listCheckpoints(projectID)
  if (checkpoints.length === 0) return undefined
  return checkpoints[checkpoints.length - 1]
}

export async function ensureCheckpointDir(projectID: string) {
  try {
    const dir = checkpointDir(projectID)
    // Bun.write creates parent dirs, but an explicit mkdir keeps listing races quiet
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dir, { recursive: true })
  } catch {}
}

/** Organization plan version when a persisted org file exists; undefined honestly otherwise */
export async function loadOrganizationVersion(projectID: string): Promise<number | undefined> {
  try {
    const raw = await Bun.file(path.join(Global.Path.state, "orchestrator", projectID, "org.json")).json()
    if (raw && typeof raw === "object" && typeof raw.version === "number") return raw.version
  } catch {}
  return undefined
}
