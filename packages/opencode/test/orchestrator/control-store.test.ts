import { describe, expect, test } from "bun:test"
import {
  loadControlState,
  saveControlState,
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  latestCheckpoint,
  loadOrganizationVersion,
  type ProjectCheckpoint,
} from "@/orchestrator/control"

// Low-level persistence contracts: file-backed, restart-safe, inspectable.

function sampleCheckpoint(projectID: string, createdAt: number): ProjectCheckpoint {
  return {
    id: `chk-test-${createdAt.toString(36)}`,
    projectID,
    createdAt,
    objectiveVersion: 3,
    roadmapVersion: 5,
    organizationVersion: 2,
    projectStatus: "executing",
    activeWorkerCheckpoints: [{ workerID: "worker-a", taskID: "a", taskRevision: 4 }],
    git: { branch: "main", head: "abc123", dirty: true, diffstat: { additions: 10, deletions: 2, files: 3 } },
    brain: { memoryCount: 7 },
    verification: { completedTaskIDs: ["x"], failedTaskIDs: [], blockedTaskIDs: [] },
    openIncidentIDs: ["inc-1"],
  }
}

describe("project control persistence", () => {
  test("control state defaults to running when absent", async () => {
    const state = await loadControlState("proj-control-absent")
    expect(state.status).toBe("running")
  })

  test("control state persists and reloads (restart-safe)", async () => {
    const state = { status: "paused" as const, mode: "finish_current_safe_step" as const, requestedAt: 1, pausedAt: 2, checkpointID: "chk-x", reason: "test" }
    await saveControlState("proj-control-restart", state)
    const loaded = await loadControlState("proj-control-restart")
    expect(loaded).toEqual(state)
  })

  test("checkpoint saves, fetches by ID, lists chronologically", async () => {
    const first = sampleCheckpoint("proj-control-list", 1000)
    const second = { ...sampleCheckpoint("proj-control-list", 2000), id: `chk-test-${2000}` }
    await saveCheckpoint(first)
    await saveCheckpoint(second)

    expect(await loadCheckpoint("proj-control-list", first.id)).toEqual(first)
    const list = await listCheckpoints("proj-control-list")
    expect(list.map((c) => c.id)).toEqual([first.id, second.id])
    expect(await latestCheckpoint("proj-control-list")).toEqual(second)
  })

  test("empty project has no checkpoints honestly", async () => {
    expect(await listCheckpoints("proj-control-none")).toEqual([])
    expect(await latestCheckpoint("proj-control-none")).toBeUndefined()
    expect(await loadCheckpoint("proj-control-none", "missing")).toBeUndefined()
  })

  test("organization version is undefined when no org file exists", async () => {
    expect(await loadOrganizationVersion("proj-control-noorg")).toBeUndefined()
  })
})
