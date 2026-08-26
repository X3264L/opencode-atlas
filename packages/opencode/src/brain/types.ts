// Atlas Project Brain - durable, evidence-grounded project memory.
//
// The Brain indexes and explains source-of-truth state; it does not replace it.
// Every memory item carries provenance back to evidence. Authority hierarchy:
//   user correction > source state > verified > agent result > derived

export type ProjectMemoryKind =
  | "project_fact"
  | "user_preference"
  | "constraint"
  | "decision"
  | "assumption"
  | "architecture_contract"
  | "api_contract"
  | "schema_contract"
  | "task_summary"
  | "worker_outcome"
  | "artifact_summary"
  | "verification_evidence"
  | "failure"
  | "blocker"
  | "rejected_approach"
  | "lesson"
  | "roadmap_change"
  | "objective_change"
  | "instruction_summary"
  | "open_question"
  | "risk"
  | "integration_note"

export type MemoryStatus = "active" | "historical" | "stale" | "invalidated" | "superseded"

/** Higher number = higher authority when ranking ties */
export const AUTHORITY_ORDER = {
  user: 6,
  source_state: 5,
  verified: 4,
  current_artifact: 3,
  agent_result: 2,
  derived: 1,
} as const

export type MemoryAuthority = keyof typeof AUTHORITY_ORDER

export interface MemoryProvenance {
  kind:
    | "user_message"
    | "session_message"
    | "roadmap"
    | "task"
    | "artifact"
    | "checkpoint"
    | "verification"
    | "instruction"
    | "changeset"
    | "file"
    | "git_diff"
    | "test_output"
    | "command_output"
  id?: string
  locator?: string
  excerptHash?: string
  createdAt?: number
}

export interface ProjectMemory {
  id: string
  projectID: string
  kind: ProjectMemoryKind
  title: string
  content: string
  status: MemoryStatus
  authority: MemoryAuthority
  confidence: number
  createdAt: number
  updatedAt: number
  roadmapVersion?: number
  objectiveVersion?: number
  taskID?: string
  taskRevision?: number
  artifactID?: string
  instructionID?: string
  changeSetID?: string
  sessionID?: string
  provenance: MemoryProvenance[]
  tags: string[]
}

// ---- Decision Ledger ---------------------------------------------------------

export interface DecisionAlternative {
  approach: string
  rejectedBecause?: string
}

export interface ProjectDecision {
  id: string
  projectID: string
  title: string
  statement: string
  rationale: string[]
  status: "proposed" | "active" | "superseded" | "reversed" | "invalidated"
  alternatives?: DecisionAlternative[]
  madeAt: number
  supersededBy?: string
  provenance: MemoryProvenance[]
  roadmapVersion?: number
  objectiveVersion?: number
}

// ---- Contracts -----------------------------------------------------------------

export interface ArchitectureContract {
  id: string
  projectID: string
  kind: "api" | "schema" | "module_boundary" | "event" | "persistence" | "runtime" | "security" | "tooling"
  name: string
  summary: string
  status: "active" | "stale" | "superseded"
  producerTaskIDs: string[]
  consumerTaskIDs: string[]
  artifactIDs: string[]
  provenance: MemoryProvenance[]
  version: number
}

// ---- Assumptions -----------------------------------------------------------------

export interface ProjectAssumption {
  id: string
  projectID: string
  statement: string
  status: "unverified" | "verified" | "false" | "superseded"
  importance: "low" | "medium" | "high"
  evidence: MemoryProvenance[]
  affectedTaskIDs: string[]
}

// ---- Open Questions / Risks -------------------------------------------------------

export interface ProjectOpenQuestion {
  id: string
  projectID: string
  question: string
  importance: "low" | "medium" | "high"
  status: "open" | "resolved" | "superseded"
  affectedTaskIDs: string[]
  evidence: MemoryProvenance[]
}

export interface ProjectRisk {
  id: string
  projectID: string
  risk: string
  severity: "low" | "medium" | "high"
  status: "open" | "mitigated" | "accepted"
  affectedTaskIDs: string[]
  mitigation?: string
  evidence: MemoryProvenance[]
}

// ---- Context Packs --------------------------------------------------------------

export interface ContextPackItem {
  kind: string
  sourceID: string
  authority: MemoryAuthority
  status: string
  relevanceScore: number
  estimatedTokens: number
  reasonIncluded: string
}

export interface ContextDropRecord {
  sourceID: string
  reasonDropped: string
}

export interface ProjectContextPack {
  id: string
  projectID: string
  purpose: "worker" | "planner" | "replanner" | "review" | "integration" | "project_question"
  targetTaskID?: string
  items: ContextPackItem[]
  contentParts: { kind: string; text: string }[]
  estimatedTokens: number
  budgetTokens: number
  dropped: ContextDropRecord[]
  provenance: string[]
}

// ---- Project Q&A ---------------------------------------------------------------

export interface ProjectAnswer {
  text: string
  confidence: "high" | "medium" | "low"
  sourceMemoryIDs: string[]
  sourceArtifactIDs: string[]
  sourceTaskIDs: string[]
  sourceDecisionIDs: string[]
}

// ---- Retrieval -------------------------------------------------------------------

export interface BrainQuery {
  projectID: string
  query: string
  kinds?: ProjectMemoryKind[]
  taskIDs?: string[]
  includeHistorical?: boolean
  maxItems?: number
}

export interface ScoredMemory {
  memory: ProjectMemory
  score: number
  matchReasons: string[]
}
