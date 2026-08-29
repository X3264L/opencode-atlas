import path from "path"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import type { Checkpoint, ProjectObjective, Roadmap, WorkerArtifact, PrivacyPolicy } from "./types"
import type { ProjectInstruction } from "./instructions"
import type { ProjectIdea } from "./ideas"
import type { RoadmapChangeSet } from "./changeset"

// File-backed project persistence under the Atlas state dir. Declarative
// state only; survives restart and is inspectable afterwards.

export interface ProjectFile {
  objective: ProjectObjective
  roadmap: Roadmap
  checkpoints: Checkpoint[]
  artifacts: WorkerArtifact[]
  /** Canonical root project conversation session (human ↔ organization). Workers are its children. */
  sessionID?: string
  /** When the root session association was last confirmed durable; unconfirmed IDs re-verify on open */
  rootSessionConfirmedAt?: number
  /** Instruction Inbox: project conversation instructions awaiting/mutating the roadmap */
  instructions?: ProjectInstruction[]
  /** Idea Ledger: future-scope captures that must not mutate the roadmap */
  ideas?: ProjectIdea[]
  /** Model-proposed ChangeSets that went through the deterministic validator */
  changesets?: RoadmapChangeSet[]
  /** Workspace privacy policy controlling cloud model eligibility for intelligence calls */
  privacy?: PrivacyPolicy
  workspace?: string
  cancelledAt?: number
}

function dirFor(projectID: string) {
  return path.join(Global.Path.state, "orchestrator", projectID)
}

/**
 * Persistence that reports failure instead of swallowing. Used by flows that
 * must reconcile side effects (e.g. removing a just-created root session when
 * project identity cannot be committed).
 */
export async function writeProjectStrict(projectID: string, file: ProjectFile) {
  const filePath = path.join(dirFor(projectID), "project.json")
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(file, null, 2))
}

export async function saveProject(projectID: string, file: ProjectFile) {
  try {
    await writeProjectStrict(projectID, file)
  } catch {}
}

export async function loadProject(projectID: string): Promise<ProjectFile | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(dirFor(projectID), "project.json"), "utf8"))
    return raw && typeof raw === "object" ? (raw as ProjectFile) : undefined
  } catch {
    return undefined
  }
}

export async function listProjects(): Promise<string[]> {
  const base = path.join(Global.Path.state, "orchestrator")
  try {
    const entries = await readdir(base, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await readFile(path.join(base, entry.name, "project.json"))
        projects.push(entry.name)
      } catch {}
    }
    return projects.sort()
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
