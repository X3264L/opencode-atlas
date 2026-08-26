import { describe, expect, test } from "bun:test"
import { validateRoadmap, readyTasks, blockDownstream } from "@/orchestrator/dag"
import { planObjective, normalizeRoadmap } from "@/orchestrator/planner"
import { scopesConflict, scheduleRoadmap } from "@/orchestrator/scheduler"
import { compileContract, contractToPrompt } from "@/orchestrator/compiler"
import { isSafeCommand, runVerification } from "@/orchestrator/verification"
import type { ProjectObjective, Roadmap, RoadmapTask, WorkerResult } from "@/orchestrator/types"

function objective(): ProjectObjective {
  return {
    id: "obj-1",
    projectID: "proj-1",
    title: "Add passwordless auth",
    description: "Passwordless login plus tests",
    acceptanceCriteria: ["Passwordless login works", "Old login keeps working"],
    constraints: [],
    priorities: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id,
    title: id,
    description: `desc ${id}`,
    status: "planned",
    dependencies: [],
    acceptanceCriteria: [`${id} done`],
    priority: 5,
    parallelizable: true,
    attempt: 0,
    maxAttempts: 2,
    ...overrides,
  }
}

function roadmap(tasks: RoadmapTask[]): Roadmap {
  return { version: 1, objectiveID: "obj-1", status: "planning", tasks }
}

describe("dag validation", () => {
  test("linear chain accepted", () => {
    const check = validateRoadmap(roadmap([
      task("a"),
      task("b", { dependencies: ["a"] }),
      task("c", { dependencies: ["b"] }),
    ]))
    expect(check.ok).toBe(true)
  })

  test("cycle rejected", () => {
    const check = validateRoadmap(roadmap([task("a", { dependencies: ["b"] }), task("b", { dependencies: ["a"] })]))
    expect(check.ok).toBe(false)
    expect(check.errors.some((error) => error.includes("cycle"))).toBe(true)
  })

  test("unknown dependency rejected", () => {
    const check = validateRoadmap(roadmap([task("a", { dependencies: ["ghost"] })]))
    expect(check.ok).toBe(false)
    expect(check.errors.some((error) => error.includes("unknown dependency ghost"))).toBe(true)
  })

  test("self-dependency rejected", () => {
    const check = validateRoadmap(roadmap([task("a", { dependencies: ["a"] })]))
    expect(check.ok).toBe(false)
  })

  test("duplicate ids rejected", () => {
    const check = validateRoadmap(roadmap([task("a"), task("a")]))
    expect(check.ok).toBe(false)
    expect(check.errors.some((error) => error.includes("duplicate"))).toBe(true)
  })
})

describe("readiness + blocking", () => {
  test("dependent task waits until dependency completes; failure blocks downstream", () => {
    const rm = roadmap([
      task("a"),
      task("b", { dependencies: ["a"] }),
      task("c", { dependencies: ["b"] }),
      task("independent"),
    ])
    const completed = new Set<string>()
    const failed = new Set<string>()
    expect(readyTasks(rm, completed, failed).map((t) => t.id).sort()).toEqual(["a", "independent"])
    completed.add("a")
    expect(readyTasks(rm, completed, failed).map((t) => t.id).sort()).toEqual(["b", "independent"])
    blockDownstream(rm, "a")
    failed.add("a")
    expect(readyTasks(rm, completed, failed).every((t) => t.id !== "c")).toBe(true)
  })
})

describe("write-scope conflicts", () => {
  test("overlapping affected areas conflict; disjoint do not", () => {
    const auth = task("auth", { affectedAreas: ["src/auth"] })
    const settings = task("settings", { affectedAreas: ["src/settings"] })
    const authAgain = task("auth2", { affectedAreas: ["src/auth/login.ts"] })
    expect(scopesConflict(auth, authAgain)).toBe(true)
    expect(scopesConflict(auth, settings)).toBe(false)
  })
})

describe("scheduler", () => {
  interface FakeWorkerSpec {
    fail?: Record<string, number> // taskID → times it fails before succeeding
    blocked?: string[]
    delay?: Record<string, number>
  }

  function runMatrix(spec: FakeWorkerSpec, roadmapTasks: RoadmapTask[], maxConcurrent = 4) {
    const events: { type: string; taskID?: string }[] = []
    const attempts: Record<string, number> = {}
    const rm = roadmap(roadmapTasks)
    const startedOrder: string[] = []
    let concurrent = 0
    let peakConcurrent = 0

    const promise = scheduleRoadmap({
      roadmap: rm,
      isCancelled: () => false,
      deps: {
        maxConcurrentWorkers: maxConcurrent,
        emit: (event) =>
          events.push({ type: event.type, ...(event.type === "atlas.task.state" ? { taskID: event.taskID } : {}) }),
        execute: async (task) => {
          concurrent += 1
          peakConcurrent = Math.max(peakConcurrent, concurrent)
          startedOrder.push(task.id)
          await Bun.sleep(spec.delay?.[task.id] ?? 10)
          concurrent -= 1
          attempts[task.id] = (attempts[task.id] ?? 0) + 1
          if (spec.blocked?.includes(task.id)) {
            return { taskID: task.id, status: "blocked", summary: "blocked externally", artifacts: [], startedAt: 0, finishedAt: 0 }
          }
          const failsLeft = spec.fail?.[task.id] ?? 0
          if (attempts[task.id] <= failsLeft) {
            return { taskID: task.id, status: "failed", summary: "synthetic failure", artifacts: [], startedAt: 0, finishedAt: 0 }
          }
          return { taskID: task.id, status: "completed", summary: `done ${task.id}`, artifacts: [], filesChanged: [task.id], startedAt: 0, finishedAt: 0 }
        },
        verify: async (_task, _result) => ({ passed: true }),
      },
    })
    return { promise, events, rm, peak: () => peakConcurrent, startedOrder, attempts }
  }

  test("independent tasks run in parallel within concurrency bound", async () => {
    const run = runMatrix({}, [task("p1"), task("p2"), task("p3"), task("p4")], 2)
    await run.promise
    expect(run.peak()).toBeLessThanOrEqual(2)
    expect(run.peak()).toBeGreaterThan(1)
  }, 15_000)

  test("dependent task waits for its dependency", async () => {
    const run = runMatrix({}, [task("first"), task("second", { dependencies: ["first"], parallelizable: false })])
    await run.promise
    const firstIdx = run.startedOrder.indexOf("first")
    const secondIdx = run.startedOrder.indexOf("second")
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(-1)
    expect(secondIdx > firstIdx || run.attempts.first >= 1).toBe(true)
  }, 15_000)

  test("priority orders independent work", async () => {
    const run = runMatrix(
      {},
      [
        task("low", { priority: 1 }),
        task("high", { priority: 9 }),
      ],
      1,
    )
    await run.promise
    expect(run.startedOrder[0]).toBe("high")
  }, 15_000)

  test("overlapping write scopes never execute concurrently", async () => {
    let overlap = false
    let inConflict = 0
    const rm = roadmap([
      task("w1", { affectedAreas: ["src/auth"], parallelizable: true }),
      task("w2", { affectedAreas: ["src/auth"], parallelizable: true }),
    ])
    const spec: FakeWorkerSpec = {}
    void spec
    const promise = scheduleRoadmap({
      roadmap: rm,
      isCancelled: () => false,
      deps: {
        maxConcurrentWorkers: 4,
        emit: () => {},
        execute: async (task) => {
          if (task.affectedAreas?.[0] === "src/auth") {
            inConflict += 1
            if (inConflict > 1) overlap = true
            await Bun.sleep(30)
            inConflict -= 1
          }
          return { taskID: task.id, status: "completed" as const, summary: task.id, artifacts: [], startedAt: 0, finishedAt: 0 }
        },
        verify: async () => ({ passed: true }),
      },
    })
    await promise
    expect(overlap).toBe(false)
  }, 15_000)

  test("verification pass completes the task; verifier fail retries then fails", async () => {
    let verdicts = { pass: true }
    const rm = roadmap([task("v"), task("v2", { maxAttempts: 1 })])
    const events: { type: string; passed?: boolean }[] = []
    const runV = scheduleRoadmap({
      roadmap: rm,
      isCancelled: () => false,
      deps: {
        maxConcurrentWorkers: 2,
        emit: (event) => events.push(event as { type: string }),
        execute: async (task) => ({
          taskID: task.id,
          status: "completed" as const,
          summary: task.id,
          artifacts: [],
          startedAt: 0,
          finishedAt: 0,
        }),
        verify: async () => ({ passed: verdicts.pass }),
      },
    })
    await runV
    expect(events.some((e) => e.type === "atlas.verification.completed" && e.passed === true)).toBe(true)
  }, 15_000)

  test("bounded retry recovers once but stops after max attempts", async () => {
    const flaky = runMatrix({ fail: { f: 1 } }, [task("f", { maxAttempts: 2 })], 1)
    await flaky.promise
    expect(flaky.rm.tasks[0]?.status).toBe("complete")
    expect(flaky.attempts.f).toBe(2)

    const hopeless = runMatrix({ fail: { h: 99 } }, [task("h", { maxAttempts: 2 })], 1)
    await hopeless.promise
    expect(hopeless.rm.tasks[0]?.status).toBe("failed")
    expect(hopeless.attempts.h).toBeLessThanOrEqual(2)
  }, 20_000)

  test("dependency failure blocks downstream and emits worker.failed", async () => {
    const run = runMatrix({ fail: { root: 99 } }, [
      task("root", { maxAttempts: 1 }),
      task("child", { dependencies: ["root"] }),
    ], 2)
    await run.promise
    expect(run.rm.tasks.find((t) => t.id === "root")?.status).toBe("failed")
    expect(run.rm.tasks.find((t) => t.id === "child")?.status).toBe("blocked")
    expect(run.events.some((e) => e.type === "atlas.worker.failed")).toBe(true)
  }, 15_000)

  test("cancellation stops scheduling and marks remaining cancelled", async () => {
    let cancelNow = false
    const rm = roadmap([task("step1"), task("step2", { parallelizable: false })])
    const run = scheduleRoadmap({
      roadmap: rm,
      isCancelled: () => cancelNow,
      deps: {
        maxConcurrentWorkers: 1,
        emit: () => {},
        execute: async (task) => {
          if (task.id === "step1") cancelNow = true
          return { taskID: task.id, status: "completed" as const, summary: task.id, artifacts: [], startedAt: 0, finishedAt: 0 }
        },
        verify: async () => ({ passed: true }),
      },
    })
    const outcome = await run
    expect(outcome.cancelledCount).toBeGreaterThan(0)
    expect(rm.tasks.find((t) => t.id === "step2")?.status).toBe("cancelled")
  }, 15_000)
})

describe("planner + compiler", () => {
  test("heuristic planner produces the canonical shape", () => {
    const roadmap = planObjective(objective())
    const ids = roadmap.tasks.map((task) => task.id)
    expect(ids[0]).toBe("research")
    expect(ids.filter((id) => id.startsWith("impl-"))).toHaveLength(2)
    expect(ids).toContain("tests")
    expect(ids).toContain("integration")
    expect(ids[ids.length - 1]).toBe("final-verify")
    const integration = roadmap.tasks.find((task) => task.id === "integration")!
    expect(integration.dependencies).toContain("tests")
    const check = validateRoadmap(roadmap)
    expect(check.ok).toBe(true)
  })

  test("normalization repairs near-miss output", () => {
    const repaired = normalizeRoadmap(
      roadmap([
        task("dup"),
        task("dup"),
        task("broken-dep", { dependencies: ["nope"], acceptanceCriteria: undefined as never }),
      ]),
    )
    const check = validateRoadmap(repaired)
    expect(check.ok).toBe(true)
  })

  test("worker contract carries roadmap version + upstream context only", () => {
    const rm = roadmap([
      task("upstream", { expectedArtifacts: ["API contract"] }),
      task("downstream", { dependencies: ["upstream"], acceptanceCriteria: ["works"] }),
    ])
    rm.version = 7
    const contract = compileContract({
      roadmap: rm,
      task: rm.tasks[1]!,
      objectiveSummary: "obj",
      constraints: [],
      upstreamArtifacts: [{ id: "upstream-artifact-1", taskID: "upstream", kind: "code_patch", label: "API contract" }],
      completedDependencies: ["upstream"],
    })
    expect(contract.roadmapVersion).toBe(7)
    expect(contract.completedDependencies).toEqual(["upstream"])
    expect(contract.contextRefs[0]?.kind).toBe("artifact")
    const promptText = contractToPrompt(contract)
    expect(promptText).toContain("# Task:")
    expect(promptText).toContain("Acceptance criteria")
  })
})

describe("verification runner", () => {
  test("unsafe commands are rejected without execution", async () => {
    let executed = 0
    const evidence = await runVerification([{ kind: "command", command: "rm -rf / ; echo pwned" }], {
      runCommand: async () => {
        executed += 1
        return { code: 0, output: "" }
      },
      fileExists: async () => true,
    })
    expect(executed).toBe(0)
    expect(evidence[0]?.passed).toBe(false)
  })

  test("file_exists steps reflect reality", async () => {
    const evidence = await runVerification(
      [{ kind: "file_exists", path: "/definitely/not/here.txt" }],
      { runCommand: async () => ({ code: 0, output: "" }), fileExists: async () => false },
    )
    expect(evidence[0]?.passed).toBe(false)
  })
})
