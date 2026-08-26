import { describe, expect, test } from "bun:test"
import {
  selectRecoveryActions,
  isRepeatedFailure,
  fingerprintFailure,
  estimateRequestContext,
  fitsInContext,
  DEFAULT_RECOVERY_BUDGET,
} from "@/supervisor/types"
import {
  generateOrganizationPlan,
  scoreRoleForTask,
  computeCriticalPath,
} from "@/supervisor/org"
import {
  buildMissionControlSnapshot,
  checkReleaseReadiness,
} from "@/supervisor/mission"
import type { Roadmap, RoadmapTask } from "@/orchestrator/types"

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id, title: id, description: `desc ${id}`, status: "planned",
    dependencies: [], acceptanceCriteria: [`${id} done`],
    priority: 5, parallelizable: true, attempt: 0, maxAttempts: 2, revision: 1, ...overrides,
  }
}

function roadmap(tasks: RoadmapTask[], version = 1): Roadmap {
  return { version, objectiveID: "obj-1", status: "executing", tasks }
}

// ---- SUPER++ 008: Supervisor ----

describe("recovery policy", () => {
  test("context overflow → expand_context then reroute_model", () => {
    const actions = selectRecoveryActions("context_overflow", 0, DEFAULT_RECOVERY_BUDGET)
    expect(actions).toContain("expand_context")
    expect(actions).toContain("reroute_model")
  })

  test("exhausted attempts escalate to request_user", () => {
    const actions = selectRecoveryActions("worker_stalled", 5, DEFAULT_RECOVERY_BUDGET)
    expect(actions).toEqual(["request_user"])
  })

  test("runtime crash triggers managed runtime restart", () => {
    const actions = selectRecoveryActions("runtime_failure", 0, DEFAULT_RECOVERY_BUDGET)
    expect(actions).toContain("restart_managed_runtime")
  })

  test("write conflict always checkpoints and replans (no retry)", () => {
    const actions = selectRecoveryActions("write_conflict", 0, DEFAULT_RECOVERY_BUDGET)
    expect(actions).toContain("checkpoint_and_replan")
    expect(actions).not.toContain("retry_same_worker")
  })
})

describe("repeated failure detection", () => {
  test("same fingerprint repeated 3+ times detected", () => {
    const seen = new Map<string, number>()
    const fp = fingerprintFailure("test_failure", 2, "expect(received).toBe(expected)")
    expect(isRepeatedFailure(fp, seen)).toBe(false) // 1st
    expect(isRepeatedFailure(fp, seen)).toBe(false) // 2nd
    expect(isRepeatedFailure(fp, seen)).toBe(true) // 3rd
  })

  test("different fingerprints tracked independently", () => {
    const seen = new Map<string, number>()
    expect(isRepeatedFailure(fingerprintFailure("a", 1, "x"), seen)).toBe(false)
    expect(isRepeatedFailure(fingerprintFailure("b", 1, "y"), seen)).toBe(false)
  })
})

describe("request context estimation", () => {
  test("accounts for all components", () => {
    const est = estimateRequestContext({
      systemPrompt: "s".repeat(8000),
      agentPrompt: "a".repeat(4000),
      conversationText: "c".repeat(20000),
      contractText: "ct".repeat(1000),
      brainContextText: "b".repeat(12000),
      fileTexts: ["f".repeat(6000)],
      toolSchemaCount: 8,
      hasStructuredOutput: true,
      reservedOutputTokens: 4000,
    })
    expect(est.components.system).toBe(2000)
    expect(est.components.agent).toBe(1000)
    expect(est.components.brain).toBe(3000)
    expect(est.components.files).toBe(1500)
    expect(est.components.tools).toBe(2400)
    expect(est.requiredTokens).toBeGreaterThan(10_000)
    expect(est.method).toBe("conservative_estimate")
  })

  test("fitsInContext rejects undersized candidate", () => {
    const est = estimateRequestContext({ systemPrompt: "s".repeat(128_000), reservedOutputTokens: 4_000 })
    // ~32K input + 4K output = ~36K required
    expect(fitsInContext(est, 32_000)).toBe(false)
    expect(fitsInContext(est, 64_000)).toBe(true)
  })
})

// ---- SUPER++ 009: Organization ----

describe("organizational genesis", () => {
  test("simple roadmap generates minimal organization", () => {
    const rm = roadmap([task("a"), task("b")])
    const plan = generateOrganizationPlan("proj-1", rm, 1)
    expect(plan.roles.length).toBeGreaterThanOrEqual(1)
    expect(plan.maxConcurrentWorkers).toBeLessThanOrEqual(4)
  })

  test("backend-heavy roadmap gets backend capacity > 1", () => {
    const rm = roadmap([
      task("be-1", { workerProfile: "backend" }),
      task("be-2", { workerProfile: "backend" }),
      task("be-3", { workerProfile: "backend" }),
      task("be-4", { workerProfile: "backend" }),
    ])
    const plan = generateOrganizationPlan("proj-1", rm, 1)
    const backendRole = plan.roles.find((r) => r.profileID === "backend")
    expect(backendRole?.capacity ?? 0).toBeGreaterThan(1)
  }, )

  test("tiny project does not spawn huge org", () => {
    const rm = roadmap([task("only")])
    const plan = generateOrganizationPlan("proj-1", rm, 1)
    expect(plan.roles.length).toBeLessThanOrEqual(2)
  })

  test("critical path computed from dependency chain", () => {
    const rm = roadmap([
      task("root"),
      task("mid-a", { dependencies: ["root"] }),
      task("mid-b", { dependencies: ["root"] }),
      task("leaf", { dependencies: ["mid-a", "mid-b"] }),
    ])
    const cp = computeCriticalPath(rm)
    expect(cp.get("leaf")).toBe(3) // root → mid → leaf
  })
})

describe("role assignment scoring", () => {
  test("profile match + capacity scores highest", () => {
    const role = { id: "r1", profileID: "backend", label: "", mission: "", capabilities: ["edit"], capacity: 2, taskAffinity: [], riskLevel: "medium" as const, status: "active" as const }
    const result = scoreRoleForTask(role, task("t", { workerProfile: "backend" }), 0)
    expect(result.score).toBeGreaterThan(50)
    expect(result.reasons).toContain("profile match")
    expect(result.reasons).toContain("has capacity")
  })

  test("at-capacity role penalized even with profile match", () => {
    const role = { id: "r1", profileID: "backend", label: "", mission: "", capabilities: [], capacity: 2, taskAffinity: [], riskLevel: "low" as const, status: "active" as const }
    const atCapacity = scoreRoleForTask(role, task("t", { workerProfile: "backend" }), 2)
    const hasCapacity = scoreRoleForTask(role, task("t", { workerProfile: "backend" }), 0)
    expect(hasCapacity.score).toBeGreaterThan(atCapacity.score)
  })
})

// ---- SUPER++ 010: Mission Control + Release Autopilot ----

describe("mission control snapshot", () => {
  test("aggregates correct counts and health", () => {
    const rm = roadmap([
      task("done", { status: "complete" as never }),
      task("running", { status: "running" as never }),
      task("blocked-t", { status: "blocked" as never }),
      task("failed-t", { status: "failed" as never }),
    ])
    const snapshot = buildMissionControlSnapshot("proj-1", rm, computeCriticalPath(rm))
    expect(snapshot.totalTasks).toBe(4)
    expect(snapshot.completeTasks).toBe(1)
    expect(snapshot.blockedTasks).toBe(1)
    expect(snapshot.failedTasks).toBe(1)
    expect(snapshot.health).toBe("degraded")
  })

  test("healthy project shows healthy status", () => {
    const rm = roadmap([task("ok", { status: "complete" as never })])
    const snapshot = buildMissionControlSnapshot("proj-1", rm, new Map())
    expect(snapshot.health).toBe("healthy")
  })

  test("critical path length reflected in snapshot", () => {
    const rm = roadmap([
      task("a"),
      task("b", { dependencies: ["a"] }),
      task("c", { dependencies: ["b"] }),
    ])
    const cp = computeCriticalPath(rm)
    const snapshot = buildMissionControlSnapshot("proj-1", rm, cp)
    expect(snapshot.criticalPathLength).toBe(3)
  })
})

describe("release autopilot", () => {
  test("all complete → ready", () => {
    const rm = roadmap([task("a", { status: "complete" as never }), task("b", { status: "complete" as never })])
    const release = checkReleaseReadiness("proj-1", rm)
    expect(release.status).toBe("ready")
  })

  test("failed task blocks release", () => {
    const rm = roadmap([task("a", { status: "failed" as never })])
    const release = checkReleaseReadiness("proj-1", rm)
    expect(release.status).toBe("blocked")
  })

  test("in-progress blocks release", () => {
    const rm = roadmap([task("a", { status: "running" as never })])
    const release = checkReleaseReadiness("proj-1", rm)
    expect(release.status).toBe("blocked")
  })

  test("gate results carry evidence refs", () => {
    const rm = roadmap([task("a", { status: "complete" as never })])
    const release = checkReleaseReadiness("proj-1", rm)
    expect(release.results.every((r) => Array.isArray(r.evidenceRefs))).toBe(true)
  })
})
