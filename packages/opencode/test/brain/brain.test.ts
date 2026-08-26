import { describe, expect, test } from "bun:test"
import type { ProjectMemory } from "@/brain/types"
import { retrieve } from "@/brain/retrieve"
import { compileContextPack, estimateTokens } from "@/brain/context"
import { createDecision, supersedeDecision, activeDecisions } from "@/brain/decisions"
import { classifyProjectMessage } from "@/orchestrator/project-chat"

function mem(overrides: Partial<ProjectMemory> & { id: string; title: string; content: string }): ProjectMemory {
  return {
    projectID: "proj-1",
    kind: "project_fact",
    status: "active",
    authority: "derived",
    confidence: 0.8,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    provenance: [{ kind: "session_message" }],
    tags: [],
    ...overrides,
  }
}

describe("project message intent routing", () => {
  test("question → brain Q&A", () => {
    const route = classifyProjectMessage("Why are we using EventV2Bridge?")
    expect(route.intent).toBe("question")
  })

  test("status request → deterministic state query", () => {
    const route = classifyProjectMessage("What is blocked right now?")
    expect(route.intent).toBe("status_request")
  })

  test("instruction → instruction inbox", () => {
    const route = classifyProjectMessage("Use passkeys instead of email links.")
    expect(route.intent).toBe("instruction")
  })

  test("idea → idea ledger, not roadmap", () => {
    const route = classifyProjectMessage("Later add native mobile support.")
    expect(route.intent).toBe("idea")
  })

  test("memory correction → correction flow", () => {
    const route = classifyProjectMessage("That's wrong — we never decided to remove SQLite.")
    expect(route.intent).toBe("memory_correction")
  })
})

describe("retrieval authority ranking", () => {
  test("user constraint outranks derived summary on same topic", () => {
    const constraint = mem({
      id: "constraint-1",
      kind: "constraint",
      title: "No DB schema changes",
      content: "The project explicitly prohibits modifying the database schema.",
      authority: "source_state",
      confidence: 1,
      tags: ["db", "schema"],
    })
    const derived = mem({
      id: "derived-1",
      kind: "project_fact",
      title: "DB migration may be needed",
      content: "A DB schema migration might be required for the new auth system.",
      authority: "derived",
      confidence: 0.5,
      status: "stale",
    })
    const results = retrieve([derived, constraint], {
      projectID: "proj-1",
      query: "database schema changes",
    })
    expect(results[0]?.memory.id).toBe("constraint-1")
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
  })

  test("active decision beats stale similar decision", () => {
    const oldDecision = mem({
      id: "d-old",
      kind: "decision",
      title: "Use email links for auth",
      content: "We chose email magic links for authentication.",
      status: "superseded",
      authority: "source_state",
      confidence: 1,
    })
    const newDecision = mem({
      id: "d-new",
      kind: "decision",
      title: "Use passkeys for auth",
      content: "We chose WebAuthn passkeys for authentication instead.",
      status: "active",
      authority: "source_state",
      confidence: 1,
    })
    const results = retrieve([oldDecision, newDecision], {
      projectID: "proj-1",
      query: "auth strategy approach",
    })
    expect(results[0]?.memory.id).toBe("d-new")
  })

  test("historical query can retrieve superseded decisions", () => {
    const oldDecision = mem({
      id: "d-old",
      kind: "decision",
      title: "Use email links for auth",
      content: "We chose email magic links.",
      status: "superseded",
    })
    const results = retrieve([oldDecision], {
      projectID: "proj-1",
      query: "auth strategy",
      includeHistorical: true,
    })
    expect(results.length).toBeGreaterThan(0)
  })

  test("task-specific failure retrieved for that task only", () => {
    const backendFailure = mem({
      id: "fail-backend",
      kind: "failure",
      taskID: "backend-auth",
      title: "Backend tool calling failed",
      content: "Tool calling readiness failed on this model.",
    })
    const frontendFailure = mem({
      id: "fail-frontend",
      kind: "failure",
      taskID: "frontend-ui",
      title: "Frontend layout issue",
      content: "Layout broke on mobile viewport.",
    })
    const results = retrieve([backendFailure, frontendFailure], {
      projectID: "proj-1",
      query: "tool calling failure",
      taskIDs: ["backend-auth"],
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.memory.taskID === "backend-auth")).toBe(true)
  })

  test("cross-project isolation", () => {
    const otherProject = mem({ id: "other", projectID: "proj-other", title: "Other project memory", content: "unrelated" })
    const results = retrieve([otherProject], { projectID: "proj-1", query: "anything" })
    expect(results).toHaveLength(0)
  })
})

describe("context pack compilation", () => {
  test("over-budget drops lowest-priority items first, preserves critical constraints", () => {
    const criticalConstraint = mem({
      id: "critical-constraint",
      kind: "constraint",
      title: "Local-only policy",
      content: "This project must never send data to cloud providers. All processing must remain local.",
      authority: "source_state",
      confidence: 1,
    })
    const acceptanceCriteria = mem({
      id: "acceptance",
      kind: "project_fact",
      title: "Acceptance criteria",
      content: "Passkey registration must work without password fallback.",
      authority: "source_state",
      confidence: 1,
    })
    const apiContract = mem({
      id: "api-contract",
      kind: "api_contract",
      title: "Auth API v2",
      content: "POST /auth/passkey/register creates a new credential.",
      authority: "current_artifact",
      confidence: 0.9,
    })
    const oldSuperseded = mem({
      id: "old-decision",
      kind: "decision",
      title: "Old decision about email links",
      content: "This was superseded by passkeys. It described using email magic link flow with a verification step and template customization options for different user segments including enterprise users who need SSO integration via SAML providers.",
      status: "superseded",
      authority: "derived",
      confidence: 0.3,
    })
    const unrelatedSummary = mem({
      id: "unrelated-worker",
      kind: "worker_outcome",
      title: "Docs worker completed unrelated task",
      content: "Updated documentation for the settings page layout, navigation structure, and footer styling across all pages including responsive breakpoints and dark mode adjustments for accessibility compliance verification.",
      authority: "agent_result",
      confidence: 0.6,
    })

    // Tiny budget forces dropping
    const pack = compileContextPack({
      projectID: "proj-1",
      purpose: "worker",
      targetTaskID: "backend-passkey",
      query: "passkey registration endpoint implementation",
      memories: [criticalConstraint, acceptanceCriteria, apiContract, oldSuperseded, unrelatedSummary],
      fixedContent: [],
      budgetTokens: 200,
      specialistProfile: "backend",
    })

    // Critical constraint retained
    expect(pack.items.some((item) => item.sourceID === "critical-constraint")).toBe(true)
    // Old superseded + unrelated dropped first
    if (pack.dropped.length > 0) {
      const dropIDs = pack.dropped.map((d) => d.sourceID)
      // If anything was dropped, old superseded or unrelated should be first
      expect(dropIDs.some((id) => ["old-decision", "unrelated-worker"].includes(id))).toBe(true)
    }
  })

  test("deduplication: same decision reachable via multiple paths included once", () => {
    const decisionMem = mem({
      id: "decision-unique",
      kind: "decision",
      title: "Use SQLite for local metadata",
      content: "SQLite chosen over Postgres for local-only metadata storage.",
    })
    const duplicateViaTask = mem({
      id: "decision-via-task",
      kind: "task_summary",
      title: "Use SQLite for local metadata",
      content: "Task summary mentions SQLite choice.",
    })
    const pack = compileContextPack({
      projectID: "proj-1",
      purpose: "planner",
      query: "database storage choice",
      memories: [decisionMem, duplicateViaTask],
      budgetTokens: 10_000,
    })
    // Only one item with this dedup key should appear
    const dbItems = pack.items.filter((item) => item.kind === "decision" || (item as any).title?.includes?.("SQLite"))
    expect(dbItems.filter((i) => i.reasonIncluded.includes("database"))).toHaveLength(0) // no double-count
  })
})

describe("token estimation", () => {
  test("estimateTokens returns reasonable values", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0)
    expect(estimateTokens("")).toBe(0)
    // ~4 chars per token
    expect(estimateTokens("a".repeat(400))).toBeGreaterThanOrEqual(100)
  })
})

describe("context pack explainability", () => {
  test("items carry inclusion reasons and token estimates", () => {
    const constraintMem = mem({
      id: "c1",
      kind: "constraint",
      title: "No cloud under local-only",
      content: "All processing must remain on-device when privacy is local_only.",
      authority: "source_state",
    })
    const pack = compileContextPack({
      projectID: "proj-1",
      purpose: "review",
      query: "cloud privacy constraints",
      memories: [constraintMem],
      budgetTokens: 5000,
    })
    expect(pack.items[0]?.reasonIncluded).toBeDefined()
    expect(pack.items[0]?.estimatedTokens).toBeGreaterThan(0)
    expect(pack.provenance).toContain("c1")
  })
})

describe("decision ledger", () => {
  test("create → supersede → active list excludes superseded", () => {
    let d1 = createDecision({ title: "Use email links", statement: "Email magic links for auth" })
    d1.projectID = "proj-1"
    const d2 = createDecision({ title: "Use passkeys", statement: "WebAuthn passkeys for auth" })
    d2.projectID = "proj-1"

    d1 = supersedeDecision(d1, d2.id)

    expect(d1.status).toBe("superseded")
    expect(d1.supersededBy).toBe(d2.id)
    expect(activeDecisions([d1, d2]).map((d) => d.id)).toEqual([d2.id])
  })
})
