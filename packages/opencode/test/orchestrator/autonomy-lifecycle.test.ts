import { describe, expect, test } from "bun:test"
import type { Roadmap, RoadmapTask, WorkerResult, WorkerContract } from "@/orchestrator/types"
import { routeProjectMessage } from "@/orchestrator/project-message"
import { distillWorkerCompletion, compactMemories } from "@/orchestrator/distill"
import { estimateRequestContext, fitsInContext, selectRecoveryActions } from "@/supervisor/types"
import { generateOrganizationPlan, computeCriticalPath, scoreRoleForTask } from "@/supervisor/org"
import { buildMissionControlSnapshot, checkReleaseReadiness } from "@/supervisor/mission"
import { retrieve } from "@/brain/retrieve"

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id, title: id, description: "", status: "planned",
    dependencies: [], acceptanceCriteria: [`${id} ok`],
    priority: 5, parallelizable: true, attempt: 0, maxAttempts: 2, revision: 1, ...overrides,
  }
}

// ---- Full autonomy lifecycle integration test ----

describe("end-to-end autonomy lifecycle", () => {
  test("project creation → routing → scheduling → failure → recovery → completion → mission control → release", async () => {
    // 1. Create project objective
    const objective = {
      title: "Add passwordless authentication",
      description: "Passkey auth with old login preserved",
      acceptanceCriteria: ["Passkey registration works", "Old login keeps working"],
      constraints: ["No DB schema changes"],
    }

    // 2. Build roadmap
    const roadmapTasks = [
      task("research", { workerProfile: "research" }),
      task("passkey-backend", { dependencies: ["research"], workerProfile: "backend" }),
      task("old-login-verify", { dependencies: ["research"], workerProfile: "tests" }),
      task("integration", { dependencies: ["passkey-backend", "old-login-verify"], parallelizable: false }),
    ]
    const rm: Roadmap = { version: 1, objectiveID: "obj-1", status: "executing", tasks: roadmapTasks }

    // 3. Generate organization plan
    const org = generateOrganizationPlan("proj-1", rm, 1)
    expect(org.roles.length).toBeGreaterThan(0)

    // 4. Compute critical path
    const cp = computeCriticalPath(rm)
    expect(cp.get("integration")).toBeGreaterThanOrEqual(3)

    // 5. Route the first task using real context estimation
    const firstTask = rm.tasks[0]!
    const contextEstimate = estimateRequestContext({
      systemPrompt: `Research agent for ${objective.title}`,
      conversationText: "Investigate current auth. ",
      contractText: JSON.stringify(firstTask),
      toolSchemaCount: 4,
      reservedOutputTokens: 2_000,
    })
    expect(fitsInContext(contextEstimate, 32_768)).toBe(true)

    // 6. Simulate research completing
    rm.tasks[0]!.status = "complete"
    const snapshotAfterResearch = buildMissionControlSnapshot("proj-1", rm, cp)
    expect(snapshotAfterResearch.completeTasks).toBe(1)

    // 7. Simulate passkey-backend failing
    rm.tasks[1]!.status = "failed"
    const snapshotAfterFail = buildMissionControlSnapshot("proj-1", rm, cp)
    expect(snapshotAfterFail.health).toBe("degraded")

    // 8. Classify the failure and select recovery actions
    const kind = classifyFailureFromMessage("llama-server crashed unexpectedly").kind
    expect(kind).toBe("runtime_crashed")
    const actions = selectRecoveryActions(kind as never, 0, DEFAULT_RECOVERY_BUDGET)
    expect(actions.length).toBeGreaterThan(0)

    // 9. Recovery succeeds → task back to running then complete
    rm.tasks[1]!.status = "running"
    rm.tasks[1]!.attempt += 1
    rm.tasks[1]!.status = "complete"

    // 10. Complete remaining tasks
    rm.tasks[2]!.status = "complete"
    rm.tasks[3]!.status = "complete"

    // 11. Mission control reflects final state
    const finalSnapshot = buildMissionControlSnapshot("proj-1", rm, cp)
    expect(finalSnapshot.completeTasks).toBe(4)
    expect(finalSnapshot.health).toBe("healthy")

    // 12. Release check passes
    const release = checkReleaseReadiness("proj-1", rm)
    expect(release.status).toBe("ready")
    expect(release.results.every((r) => r.status === "pass")).toBe(true)

    // 13. Brain distillation creates memories from completed work
    const contract: WorkerContract = {
      taskID: "passkey-backend", roadmapVersion: rm.version,
      objectiveSummary: objective.title, title: "Backend auth",
      description: "Implement passkey", completedDependencies: [],
      acceptanceCriteria: ["Passkey registration works"], constraints: objective.constraints,
      contextRefs: [], expectedArtifacts: [], verificationPlan: [],
    }
    const workerResult: WorkerResult = {
      taskID: "passkey-backend", status: "completed",
      summary: "Implemented passkey registration endpoint",
      artifacts: [{ id: "a-1", taskID: "passkey-backend", kind: "code_patch", label: "auth endpoint" }],
      startedAt: Date.now() - 5000, finishedAt: Date.now(),
    }
    const brainMemories = distillWorkerCompletion({
      contract, result: workerResult, projectID: "proj-1", roadmapVersion: rm.version,
    })
    expect(brainMemories.some((m) => m.kind === "worker_outcome")).toBe(true)
    expect(brainMemories.some((m) => m.taskID === "passkey-backend")).toBe(true)

    // 14. Brain retrieval finds relevant memory
    const retrieved = retrieve(brainMemories, {
      projectID: "proj-1",
      query: "passkey backend outcome",
    })
    expect(retrieved.length).toBeGreaterThan(0)
    expect(retrieved[0]?.memory.content).toContain("passkey")
  }, 15_000)
})

// Import at bottom to avoid circular issues in test file
import { classifyFailureFromMessage } from "@/router/types"
import { DEFAULT_RECOVERY_BUDGET } from "@/supervisor/types"