import path from "path"
import Bun from "bun"
import { Global } from "@opencode-ai/core/global"
import type { Checkpoint, ProjectObjective, Roadmap, WorkerArtifact } from "./types"

// File-backed project persistence under the Atlas state dir. Declarative
// state only; survives restart and is inspectable afterwards.

export interface ProjectFile {
  objective: ProjectObjective
  roadmap: Roadmap
  checkpoints: Checkpoint[]
  artifacts: WorkerArtifact[]
  /** sessionID of the root/project conversation */
  sessionID?: string
  workspace?: string
  cancelledAt?: number
}

function dirFor(projectID: string) {
  return path.join(Global.Path.state, "orchestrator", projectID)
}

export async function saveProject(projectID: string, file: ProjectFile) {
  try {
    await Bun.write(path.join(dirFor(projectID), "project.json"), JSON.stringify(file, null, 2))
  } catch {}
}

export async function loadProject(projectID: string): Promise<ProjectFile | undefined> {
  try {
    const raw = await Bun.file(path.join(dirFor(projectID), "project.json")).json()
    return raw && typeof raw === "object" ? (raw as ProjectFile) : undefined
  } catch {
    return undefined
  }
}

export async function listProjects(): Promise<string[]> {
  const base = path.join(Global.Path.state, "orchestrator")
  try {
    const entries = await Array.fromAsync(new Bun.Glob("*/project.json").scan({ cwd: base, onlyFiles: true }))
    return entries.map((entry) => path.dirname(entry)).sort()
  } catch {
    return []
  }
}

/** Stale running/verifying tasks from a previous process are recovered */
export function recoverStaleRuns(roadmap: Roadmap) {
  let changed = false
  for (const task of roadmap.tasks) {
    if (task.status === "running" || task.status === "verifying") {
      task.status = task.attempt + 1 < task.maxAttempts ? "ready" : "failed"
      changed = true
    }
  }
  if (roadmap.status === "executing" || roadmap.status === "verifying") {
    roadmap.status = "planning"
    changed = true
  }
  return changed
}
