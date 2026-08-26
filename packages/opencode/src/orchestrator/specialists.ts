// Specialist agent registry: maps worker profiles onto real OpenCode
// configured agents. Atlas routing still chooses the model; the specialist
// only determines the role/agent/system-prompt/tool-policy dimension.

export interface SpecialistProfile {
  id: string
  label: string
  capabilities: string[]
  /** Agent name in OpenCode's agent registry; undefined = generic fallback */
  agentName?: string
  systemPromptTemplate?: string
  riskLevel: "low" | "medium" | "high"
  routingRequirements?: {
    requiresTools?: boolean
    requiresLongContext?: boolean
    minReadinessScore?: number
  }
}

const DEFAULT_PROFILES: Record<string, SpecialistProfile> = {
  research: {
    id: "research",
    label: "Research",
    capabilities: ["read", "search", "summarize"],
    riskLevel: "low",
  },
  architecture: {
    id: "architecture",
    label: "Architecture",
    capabilities: ["read", "edit", "reason"],
    riskLevel: "high",
    routingRequirements: { requiresTools: true, minReadinessScore: 60 },
  },
  backend: {
    id: "backend",
    label: "Backend",
    capabilities: ["edit", "tools", "test"],
    riskLevel: "medium",
    routingRequirements: { requiresTools: true },
  },
  frontend: {
    id: "frontend",
    label: "Frontend",
    capabilities: ["edit", "tools", "ui"],
    riskLevel: "medium",
    routingRequirements: { requiresTools: true },
  },
  database: {
    id: "database",
    label: "Database",
    capabilities: ["edit", "schema", "migration"],
    riskLevel: "high",
  },
  tests: {
    id: "tests",
    label: "Tests",
    capabilities: ["test", "edit", "fixture"],
    riskLevel: "low",
  },
  integration: {
    id: "integration",
    label: "Integration",
    capabilities: ["read", "test", "build"],
    riskLevel: "medium",
  },
  review: {
    id: "review",
    label: "Review",
    capabilities: ["read", "diff"],
    riskLevel: "low",
  },
  docs: {
    id: "docs",
    label: "Docs",
    capabilities: ["edit", "write"],
    riskLevel: "low",
  },
}

/** Resolves a worker profile to a specialist; falls back to generic */
export function resolveSpecialist(
  profile: string | undefined,
  availableAgents: Set<string>,
): { profile: SpecialistProfile; usedFallback: boolean } {
  const key = (profile ?? "").toLowerCase()
  if (key && DEFAULT_PROFILES[key]) {
    const spec = DEFAULT_PROFILES[key]!
    if (!spec.agentName || availableAgents.has(spec.agentName)) {
      return { profile: spec, usedFallback: false }
    }
    // Requested specialist's agent is not configured — generic fallback
    return { profile: { ...spec, agentName: undefined }, usedFallback: true }
  }
  // Generic
  return { profile: { id: "generic", label: "Generic", capabilities: [], riskLevel: "low" }, usedFallback: true }
}
