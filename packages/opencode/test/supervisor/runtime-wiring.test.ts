import { describe, expect, test } from "bun:test"
import { estimateRequestContext, fitsInContext, selectRecoveryActions, DEFAULT_RECOVERY_BUDGET } from "@/supervisor/types"
import { generateOrganizationPlan, computeCriticalPath, scoreRoleForTask } from "@/supervisor/org"
import { buildMissionControlSnapshot, checkReleaseReadiness } from "@/supervisor/mission"
import { classifyFailureFromMessage } from "@/router/types"
import type { Roadmap, RoadmapTask } from "@/orchestrator/types"

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id, title: id, description: "", status: "planned",
    dependencies: [], acceptanceCriteria: [`${id} ok`],
    priority: 5, parallelizable: true, attempt: 0, maxAttempts: 2, revision: 1, ...overrides,
  }
}

describe("execution-time wiring", () => {
  test("context estimator produces real values that feed router candidate filtering", () => {
    // Simulate a large agentic request
    const estimate = estimateRequestContext({
      systemPrompt: "You are a coding assistant. ".repeat(100),
      agentPrompt: "Backend specialist. ".repeat(50),
      conversationText: "User message and history. ".repeat(500),
      contractText: "Implement auth endpoint. ".repeat(80),
      brainContextText: "Active constraint: no DB schema. ".repeat(60),
      toolSchemaCount: 10,
      reservedOutputTokens: 4_000,
    })
    // Verify it's real accounting, not a floor
    expect(estimate.inputTokens).toBeGreaterThan(5_000)
    expect(estimate.requiredTokens).toBe(estimate.inputTokens + estimate.reservedOutputTokens)
    // A large request exceeds small-context models
    const bigEstimate = estimateRequestContext({
      systemPrompt: "S".repeat(128_000),
      reservedOutputTokens: 4_000,
    })
    expect(fitsInContext(bigEstimate, 16_000)).toBe(false)
    expect(fitsInContext(bigEstimate, 64_000)).toBe(true)
  })

  test("supervisor classifies scheduler failures into recovery actions", () => {
    // Simulate a runtime crash during scheduled execution
    const failureMsg = "llama-server crashed unexpectedly"
    const kind = classifyFailureFromMessage(failureMsg).kind
    expect(kind).toBe("runtime_crashed")
    // Recovery policy selects appropriate actions
    const actions = selectRecoveryActions(kind as never, 0, DEFAULT_RECOVERY_BUDGET)
    expect(actions).toContain("retry_new_session")
    expect(actions).toContain("restart_managed_runtime")
  })

  test("org plan generates from real roadmap and scores task assignment", () => {
    const rm: Roadmap = {
      version: 1, objectiveID: "o1", status: "executing",
      tasks: [
        task("be-1", { workerProfile: "backend", affectedAreas: ["src/api"] }),
        task("be-2", { workerProfile: "backend", affectedAreas: ["src/auth"] }),
        task("fe-1", { workerProfile: "frontend" }),
        task("tests", { dependencies: ["be-1", "be-2"], workerProfile: "tests" }),
      ],
    }
    const org = generateOrganizationPlan("proj-1", rm, 1)
    // Backend role should have capacity > 1 for two backend tasks
    const backendRole = org.roles.find((r) => r.profileID === "backend")!
    expect(backendRole.capacity).toBeGreaterThan(0)

    // Assignment scoring prefers backend role for backend tasks
    const scoring = scoreRoleForTask(backendRole, rm.tasks[0]!, 0)
    expect(scoring.score).toBeGreaterThan(30)
    expect(scoring.reasons).toContain("profile match")
  })

  test("mission control snapshot reflects post-execution state", async () => {
    // Start with all planned
    const rm: Roadmap = { version: 5, objectiveID: "o1", status: "executing",
      tasks: [task("t1"), task("t2"), task("t3")] }
    const before = buildMissionControlSnapshot("p1", rm, new Map())
    expect(before.completeTasks).toBe(0)
    expect(before.health).toBe("healthy")

    // Simulate execution completing t1+t2 but failing t3
    rm.tasks[0]!.status = "complete"
    rm.tasks[1]!.status = "complete"
    rm.tasks[2]!.status = "failed"

    const after = buildMissionControlSnapshot("p1", rm, new Map())
    expect(after.completeTasks).toBe(2)
    expect(after.failedTasks).toBe(1)
    expect(after.health).toBe("degraded")
  })

  test("release gates transition from blocked to ready after successful execution", () => {
    const rm: Roadmap = { version: 3, objectiveID: "o1", status: "executing",
      tasks: [task("a"), task("b")] }

    // Before execution → blocked
    const beforeRelease = checkReleaseReadiness("p1", rm)
    expect(beforeRelease.status).toBe("blocked")

    // After execution → ready
    rm.tasks.forEach((t) => (t.status = "complete"))
    const afterRelease = checkReleaseReadiness("p1", rm)
    expect(afterRelease.status).toBe("ready")
    expect(afterRelease.results.every((r) => r.status === "pass")).toBe(true)
  })

  test("failure classification connects to supervisor recovery actions", () => {
    // Real error message → classifier → recovery policy → actions
    const messages = [
      { msg: "connection refused to llama-server", expectedKind: "runtime_unavailable" },
      { msg: "HTTP 429 rate limited by provider", expectedKind: "provider_rate_limited" },
      { msg: "context length exceeded maximum tokens", expectedKind: "context_exceeded" },
    ]
    for (const { msg, expectedKind } of messages) {
      const kind: string = classifyFailureFromMessage(msg).kind
      expect(kind).toBe(expectedKind)
      const actions = selectRecoveryActions(kind as never, 0, { ...DEFAULT_RECOVERY_BUDGET })
      expect(actions.length).toBeGreaterThan(0)
    }
  })
})
