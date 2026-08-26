import { describe, expect, test } from "bun:test"
import { routeProjectMessage } from "@/orchestrator/project-message"
import { distillWorkerCompletion, compactMemories } from "@/orchestrator/distill"
import { estimateRequestContext, fitsInContext } from "@/supervisor/types"
import { generateOrganizationPlan, computeCriticalPath, scoreRoleForTask } from "@/supervisor/org"
import { buildMissionControlSnapshot, checkReleaseReadiness } from "@/supervisor/mission"
import type { Roadmap, RoadmapTask, WorkerResult, WorkerContract } from "@/orchestrator/types"

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id, title: id, description: "", status: "planned",
    dependencies: [], acceptanceCriteria: [`${id} ok`],
    priority: 5, parallelizable: true, attempt: 0, maxAttempts: 2, revision: 1, ...overrides,
  }
}

// ---- PART II: Project conversation routing ----

describe("project conversation routing", () => {
  test("status question does not mutate roadmap", () => {
    const result = routeProjectMessage("What is blocking us right now?")
    expect(result.intent).toBe("status_request")
    expect(result.instructionText).toBeUndefined()
  })

  test("instruction reaches instruction inbox", () => {
    const result = routeProjectMessage("Make tests highest priority.")
    expect(result.intent).toBe("instruction")
    expect(result.instructionText).toBeDefined()
  })

  test("idea reaches idea ledger, not roadmap", () => {
    const result = routeProjectMessage("Later add mobile support.")
    expect(result.intent).toBe("idea")
    expect(result.ideaText).toBeDefined()
    expect(result.instructionText).toBeUndefined()
  })
})

// ---- PART III: Worker distillation → Brain memories ----

describe("worker completion distillation", () => {
  test("worker completion event produces brain memories", () => {
    const contract: WorkerContract = {
      taskID: "backend-auth", roadmapVersion: 5,
      objectiveSummary: "Auth upgrade", title: "Backend auth",
      description: "Implement passkey auth", completedDependencies: [],
      acceptanceCriteria: ["Passkey registration works"], constraints: [],
      contextRefs: [], expectedArtifacts: [], verificationPlan: [],
    }
    const result: WorkerResult = {
      taskID: "backend-auth", status: "completed",
      summary: "Implemented passkey registration endpoint.",
      artifacts: [{ id: "a-1", taskID: "backend-auth", kind: "code_patch", label: "auth endpoint" }],
      filesChanged: ["src/auth/passkey.ts"],
      startedAt: Date.now() - 5000, finishedAt: Date.now(),
    }
    const memories = distillWorkerCompletion({ contract, result, projectID: "proj-1", roadmapVersion: 5 })
    expect(memories.length).toBeGreaterThanOrEqual(2)
    expect(memories.some((m) => m.kind === "worker_outcome")).toBe(true)
    expect(memories.some((m) => m.taskID === "backend-auth")).toBe(true)
  })

  test("failure blockers produce blocker memories", () => {
    const contract: WorkerContract = {
      taskID: "t-fail", roadmapVersion: 3, objectiveSummary: "test",
      title: "Failing task", description: "", completedDependencies: [],
      acceptanceCriteria: ["works"], constraints: [], contextRefs: [],
      expectedArtifacts: [], verificationPlan: [],
    }
    const result: WorkerResult = {
      taskID: "t-fail", status: "failed", summary: "failed",
      artifacts: [], blockers: ["missing dependency artifact"],
      startedAt: 0, finishedAt: Date.now(),
    }
    const memories = distillWorkerCompletion({ contract, result, projectID: "proj-1", roadmapVersion: 3 })
    expect(memories.some((m) => m.kind === "blocker" && m.content.includes("missing dependency"))).toBe(true)
  })
})

// ---- PART IV: Compaction ----

describe("brain compaction", () => {
  test("compacts repetitive derived summaries but preserves constraints", () => {
    let counter = 0
    const mkDerived = (taskID: string): any => ({
      id: `d-${++counter}`, projectID: "p1", kind: "worker_outcome",
      title: `outcome ${counter}`, content: `summary ${counter}`,
      status: "active", authority: "derived", confidence: 0.6,
      createdAt: counter * 1000, updatedAt: counter * 1000,
      provenance: [], tags: [], taskID,
    })
    const constraintMem = { id: "constraint-critical", projectID: "p1", kind: "constraint", title: "No DB changes", content: "no db", status: "active", authority: "source_state", confidence: 1, createdAt: 0, updatedAt: 0, provenance: [], tags: [] }

    // Build 10 duplicate derived summaries for same task
    const memories: any[] = [constraintMem as any]
    for (let i = 0; i < 10; i++) memories.push(mkDerived("same-task"))

    const result = compactMemories(memories)
    expect(result).not.toBeNull()
    if (!result) return
    // Constraint preserved
    expect(result.compacted.some((m) => m.id === "constraint-critical")).toBe(true)
    // Duplicates removed
    expect(result.removedCount).toBeGreaterThan(0)
  })

  test("below threshold returns null (no compaction needed)", () => {
    const few = Array.from({ length: 3 }, (_, i) => ({
      id: `m-${i}`, projectID: "p1", kind: "worker_outcome", title: `t${i}`, content: "",
      status: "active", authority: "derived" as const, confidence: 0.5,
      createdAt: 0, updatedAt: 0, provenance: [], tags: [],
    }))
    expect(compactMemories(few as never)).toBeNull()
  })
})

// ---- PART V: Context estimator → routing ----

describe("context estimator feeds real routing decisions", () => {
  test("large request rejects undersized candidate; fits large candidate", () => {
    const est = estimateRequestContext({
      systemPrompt: "S".repeat(128_000),
      toolSchemaCount: 12,
      reservedOutputTokens: 4_000,
    })
    expect(est.requiredTokens).toBeGreaterThan(32_000)
    expect(fitsInContext(est, 32_000)).toBe(false)
    expect(fitsInContext(est, 64_000)).toBe(true)
  })

  test("small request fits in small context model", () => {
    const est = estimateRequestContext({
      systemPrompt: "short system prompt",
      reservedOutputTokens: 2_000,
    })
    expect(fitsInContext(est, 8_192)).toBe(true)
  })
})

// ---- Mission Control + Release end-to-end ----

describe("mission control + release lifecycle", () => {
  test("roadmap transitions blocked→ready as tasks complete through execution", async () => {
    const rm: Roadmap = {
      version: 3, objectiveID: "o1", status: "executing",
      tasks: [
        task("research"),
        task("implement", { dependencies: ["research"] }),
        task("verify", { dependencies: ["implement"] }),
      ],
    }
    const cp = computeCriticalPath(rm)
    expect(cp.get("verify")).toBe(3)

    // Initially all planned → release blocked
    const before = checkReleaseReadiness("p1", rm)
    expect(before.status).toBe("blocked")

    // Complete research → still blocked
    rm.tasks[0]!.status = "complete"
    const mid = checkReleaseReadiness("p1", rm)
    expect(mid.status).toBe("blocked")

    // Complete everything → ready
    rm.tasks[1]!.status = "complete"
    rm.tasks[2]!.status = "complete"
    const after = checkReleaseReadiness("p1", rm)
    expect(after.status).toBe("ready")

    // Mission control reflects final state
    const snapshot = buildMissionControlSnapshot("p1", rm, cp)
    expect(snapshot.completeTasks).toBe(3)
    expect(snapshot.health).toBe("healthy")
  }, 15_000)
})
