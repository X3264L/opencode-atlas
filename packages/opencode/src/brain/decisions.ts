import type { ProjectDecision, MemoryProvenance } from "./types"

// Decision Ledger: create, supersede, and query architecture decisions.
// Superseded decisions remain history — they are never silently deleted.

let counter = 0
function uid(prefix: string) {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

export function createDecision(input: {
  title: string
  statement: string
  rationale?: string[]
  provenance?: MemoryProvenance[]
  roadmapVersion?: number
  objectiveVersion?: number
}): ProjectDecision {
  return {
    id: uid("decision"),
    projectID: "",
    title: input.title,
    statement: input.statement,
    rationale: input.rationale ?? [],
    status: "active",
    alternatives: [],
    madeAt: Date.now(),
    provenance: input.provenance ?? [],
    roadmapVersion: input.roadmapVersion,
    objectiveVersion: input.objectiveVersion,
  }
}

/** Marks the old decision superseded and returns it for persistence */
export function supersedeDecision(
  oldDecision: ProjectDecision,
  newDecisionID: string,
): ProjectDecision {
  return {
    ...oldDecision,
    status: "superseded",
    supersededBy: newDecisionID,
  }
}

/** Returns only currently active decisions */
export function activeDecisions(decisions: ProjectDecision[]): ProjectDecision[] {
  return decisions.filter((d) => d.status === "active")
}
