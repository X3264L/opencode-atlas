import path from "path"
import Bun from "bun"
import { Global } from "@opencode-ai/core/global"
import type {
  ProjectMemory,
  ProjectDecision,
  ArchitectureContract,
  ProjectAssumption,
  ProjectOpenQuestion,
  ProjectRisk,
} from "./types"

// File-backed brain persistence. One JSON file per project under the Atlas
// state dir. Backward compatible: missing fields default to empty.

export interface BrainFile {
  version: 1
  memories: ProjectMemory[]
  decisions: ProjectDecision[]
  contracts: ArchitectureContract[]
  assumptions: ProjectAssumption[]
  questions: ProjectOpenQuestion[]
  risks: ProjectRisk[]
}

function emptyBrainFile(): BrainFile {
  return { version: 1, memories: [], decisions: [], contracts: [], assumptions: [], questions: [], risks: [] }
}

function brainPath(projectID: string) {
  return path.join(Global.Path.state, "brain", `${projectID}.json`)
}

export async function loadBrain(projectID: string): Promise<BrainFile> {
  try {
    const raw = await Bun.file(brainPath(projectID)).json()
    if (!raw || typeof raw !== "object") return emptyBrainFile()
    // Backward compat: SUPER++005/006 projects have no brain file at all
    return {
      version: raw.version ?? 1,
      memories: Array.isArray(raw.memories) ? raw.memories : [],
      decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
      contracts: Array.isArray(raw.contracts) ? raw.contracts : [],
      assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],
      questions: Array.isArray(raw.questions) ? raw.questions : [],
      risks: Array.isArray(raw.risks) ? raw.risks : [],
    }
  } catch {
    return emptyBrainFile()
  }
}

export async function saveBrain(projectID: string, file: BrainFile) {
  const dir = path.dirname(brainPath(projectID))
  await Bun.write(brainPath(projectID), JSON.stringify(file, null, 2))
  void dir
}

/** Deterministic bootstrap from existing structured project state */
export function bootstrapMemories(input: {
  objectiveTitle?: string
  objectiveDescription?: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  roadmapVersion?: number
  taskSummaries?: { id: string; status: string; title: string }[]
}): ProjectMemory[] {
  const memories: ProjectMemory[] = []
  let counter = 0
  const uid = () => `mem-bootstrap-${Date.now().toString(36)}-${(counter++).toString(36)}`
  const now = Date.now()

  if (input.objectiveTitle) {
    memories.push({
      id: uid(),
      projectID: "",
      kind: "project_fact",
      title: input.objectiveTitle,
      content: input.objectiveDescription ?? "",
      status: "active",
      authority: "source_state",
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      provenance: [{ kind: "roadmap" }],
      tags: ["objective"],
    })
  }
  for (const constraint of input.constraints ?? []) {
    memories.push({
      id: uid(),
      projectID: "",
      kind: "constraint",
      title: constraint.slice(0, 80),
      content: constraint,
      status: "active",
      authority: "source_state",
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      provenance: [{ kind: "roadmap" }],
      tags: ["constraint", "active"],
    })
  }
  for (const t of input.taskSummaries ?? []) {
    memories.push({
      id: uid(),
      projectID: "",
      kind: "task_summary",
      title: t.title,
      content: `Task ${t.id} is ${t.status}`,
      status: "active",
      authority: "source_state",
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      taskID: t.id,
      provenance: [{ kind: "task", id: t.id }],
      tags: ["task", t.status],
    })
  }
  return memories
}
