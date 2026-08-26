import type { Roadmap, RoadmapTask } from "../orchestrator/types"

// Organizational Genesis: typed org plan derived from roadmap structure.
// Roles are specialist mappings (not model names); teams group related roles;
// assignment uses deterministic scoring with critical-path awareness.

export interface OrganizationRole {
  id: string
  profileID: string
  label: string
  mission: string
  capabilities: string[]
  capacity: number
  taskAffinity: string[]
  riskLevel: "low" | "medium" | "high"
  status: "planned" | "active" | "idle" | "retired"
}

export interface OrganizationTeam {
  id: string
  label: string
  roleIDs: string[]
  purpose: "feature" | "platform" | "integration" | "review" | "research" | "recovery"
}

export type OrganizationEdgeKind = "reviews" | "integrates" | "depends_on" | "coordinates_with"

export interface OrganizationEdge {
  fromRoleID: string
  toRoleID: string
  kind: OrganizationEdgeKind
}

export interface OrganizationPlan {
  id: string
  projectID: string
  version: number
  roles: OrganizationRole[]
  teams: OrganizationTeam[]
  edges: OrganizationEdge[]
  maxConcurrentWorkers: number
  createdFromRoadmapVersion: number
  createdFromObjectiveVersion: number
  rationaleCodes: string[]
}

/** Derives a bounded organization plan from the roadmap's worker profiles */
export function generateOrganizationPlan(
  projectID: string,
  roadmap: Roadmap,
  objectiveVersion: number,
): OrganizationPlan {
  const profiles = new Map<string, { count: number; areas: Set<string> }>()
  for (const task of roadmap.tasks) {
    const profile = task.workerProfile ?? "generic"
    const entry = profiles.get(profile) ?? { count: 0, areas: new Set<string>() }
    entry.count += 1
    for (const area of task.affectedAreas ?? []) entry.areas.add(area)
    profiles.set(profile, entry)
  }

  // Capacity heuristic: 1 base + extra per 3 tasks of same profile, capped at 3
  const roles: OrganizationRole[] = []
  let roleCounter = 0
  for (const [profileID, info] of [...profiles.entries()].sort()) {
    const capacity = Math.min(3, 1 + Math.floor(info.count / 3))
    roles.push({
      id: `role-${++roleCounter}`,
      profileID,
      label: `${profileID} (${capacity})`,
      mission: `Handle ${profileID} tasks`,
      capabilities: [profileID],
      capacity,
      taskAffinity: [...info.areas].slice(0, 5),
      riskLevel: profileID === "database" || profileID === "architecture" ? "high" : "medium",
      status: "planned",
    })
  }

  return {
    id: `org-${Date.now().toString(36)}`,
    projectID,
    version: 1,
    roles,
    teams: [],
    edges: [],
    maxConcurrentWorkers: Math.min(4, roles.length + 1),
    createdFromRoadmapVersion: roadmap.version,
    createdFromObjectiveVersion: objectiveVersion,
    rationaleCodes: ["derived_from_roadmap_profiles"],
  }
}

/** Scores a role for a specific task assignment */
export function scoreRoleForTask(role: OrganizationRole, task: RoadmapTask, currentLoad: number): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  if (role.profileID === task.workerProfile) {
    score += 40
    reasons.push("profile match")
  } else if (role.capabilities.some((c) => c === task.workerProfile)) {
    score += 20
    reasons.push("capability overlap")
  }

  if (role.taskAffinity.some((area) => task.affectedAreas?.includes(area))) {
    score += 15
    reasons.push("area affinity")
  }

  if (currentLoad < role.capacity) {
    score += 25
    reasons.push("has capacity")
  } else {
    score -= 20
    reasons.push("at capacity")
  }

  if (task.priority >= 7 && role.riskLevel !== "high") score += 10

  return { score, reasons }
}

/** Computes the critical path (longest dependency chain to each task) */
export function computeCriticalPath(roadmap: Roadmap): Map<string, number> {
  const byId = new Map(roadmap.tasks.map((t) => [t.id, t]))
  const memo = new Map<string, number>()

  function longestChain(id: string, visiting: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    const task = byId.get(id)
    let depth = 0
    for (const dep of task?.dependencies ?? []) {
      if (!byId.has(dep)) continue
      depth = Math.max(depth, longestChain(dep, visiting))
    }
    visiting.delete(id)
    memo.set(id, depth + 1)
    return depth + 1
  }

  for (const task of roadmap.tasks) longestChain(task.id, new Set())
  return memo
}
