import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Git, type Stat, type Item } from "@/git"
import { Orchestrator } from "@/orchestrator/index"
import { loadProject, saveProject } from "@/orchestrator/store"
import { saveControlState } from "@/orchestrator/control"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Supervisor } from "@/supervisor/index"
import { saveBrain } from "@/brain/store"
import { pollWithTimeout, testEffect } from "../lib/effect"

// SUPER++ 010.4D: checkpoint / pause / resume exercised through production
// service entry points. Workers run the real orchestrator scheduling path;
// only the session and git boundaries are deterministic fakes (same pattern
// as diffstat-runtime tests).

// Deterministic worker gating: a task listed here blocks inside its fake
// model turn until released, emulating a side-effectful in-flight tool.
const gates = new Map<string, Deferred.Deferred<void>>()
const startedTitles = new Set<string>()
const promptTexts: string[] = []

const clearRuntimeState = () => {
  gates.clear()
  startedTitles.clear()
  promptTexts.length = 0
}

const fakeGit = Layer.mock(Git.Service, {
  hasHead: () => Effect.succeed(true),
  stats: (_cwd: string, _ref: string) =>
    Effect.succeed<Stat[]>([{ file: "src/a.ts", additions: 5, deletions: 1 }]),
  status: () => Effect.succeed<Item[]>([]),
  statUntracked: () => Effect.succeed(undefined),
  branch: () => Effect.succeed("main"),
  run: () =>
    Effect.succeed({
      exitCode: 0,
      text: () => "abc123head",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      truncated: false,
    }),
})

const sessionLayer = Layer.mock(Session.Service, {
  create: () => Effect.succeed({ id: "sess-fake" } as never),
})

const promptLayer = Layer.mock(SessionPrompt.Service, {
  prompt: (input: { parts: readonly { readonly type: string; readonly text?: string }[] }) =>
    Effect.gen(function* () {
      const text = input.parts.find((p) => p.type === "text")?.text ?? ""
      const title = /^# Task: (.+)$/m.exec(text)?.[1] ?? "unknown"
      startedTitles.add(title)
      const gate = gates.get(title)
      // Safe-boundary semantics: an in-flight worker turn finishes its current
      // tool; pause never tears the turn down mid-execution.
      if (gate) yield* Deferred.await(gate)
      promptTexts.push(text)
      return {
        parts: [{ type: "text", text: `worker finished: ${title}` }],
      } as never
    }),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, Supervisor.node, EventV2Bridge.node]),
    [
      [Session.node, sessionLayer],
      [SessionPrompt.node, promptLayer],
      [Git.node, fakeGit],
    ],
  ),
)

type RecordedEvent = { type: string; data: Record<string, unknown> }

const collectEvents = (types?: string[]) =>
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    const events: RecordedEvent[] = []
    const unsub = yield* bridge.listen((event) => {
      if (!types || types.includes(event.type)) {
        events.push({ type: event.type, data: event.data as Record<string, unknown> })
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return events
  })

const waitFor = <R>(check: Effect.Effect<boolean, unknown, R>, message: string) =>
  pollWithTimeout(
    check.pipe(Effect.map((passed) => (passed ? (true as const) : undefined))),
    message,
    "10 seconds",
  )

const startedFailureOf = (action: Effect.Effect<unknown, Error>) =>
  action.pipe(Effect.exit, Effect.map((exit) => exit._tag === "Failure"))

describe("project checkpoint / pause / resume", () => {
  it.live("checkpoint persists versions, git metadata, incidents; list/get/latest work; reads emit nothing", () =>
    Effect.gen(function* () {
      const { mkdtemp, rm } = yield* Effect.promise(() => import("node:fs/promises"))
      const os = yield* Effect.promise(() => import("node:os"))
      const checkpointWorkspace = yield* Effect.promise(() => mkdtemp(`${os.tmpdir()}/atlas-cp-ws-`))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(checkpointWorkspace, { recursive: true, force: true })).pipe(Effect.orDie),
      )
      const orch = yield* Orchestrator.Service
      const supervisor = yield* Supervisor.Service
      const objective = yield* orch.createProject({
        title: "checkpoint lifecycle",
        description: "",
        acceptanceCriteria: ["done"],
        workspace: checkpointWorkspace,
      })
      const projectID = objective.projectID
      yield* orch.plan(projectID)

      yield* Effect.promise(() =>
        saveBrain(projectID, { version: 1, memories: [], decisions: [], contracts: [], assumptions: [], questions: [], risks: [] }),
      )
      const incident = yield* supervisor.openIncident({ projectID, kind: "build_failure" })

      const checkpointEvents = yield* collectEvents(["atlas.project.checkpoint.created"])
      const cp = yield* orch.checkpoint(projectID)

      expect(cp.projectID).toBe(projectID)
      expect(cp.objectiveVersion).toBe(1)
      expect(cp.roadmapVersion).toBeGreaterThanOrEqual(1)
      expect(cp.git.branch).toBe("main")
      expect(cp.git.head).toBe("abc123head")
      expect(cp.git.dirty).toBe(false)
      expect(cp.git.diffstat).toEqual({ additions: 5, deletions: 1, files: 1 })
      expect(cp.brain.memoryCount).toBe(0)
      expect(cp.openIncidentIDs).toContain(incident.id)

      expect(yield* orch.getCheckpoint(projectID, cp.id)).toEqual(cp)
      expect((yield* orch.listCheckpoints(projectID)).map((c) => c.id)).toContain(cp.id)
      expect(yield* orch.latestCheckpoint(projectID)).toEqual(cp)

      // Creating the checkpoint above emits exactly one event
      yield* Effect.sleep("150 millis")
      expect(checkpointEvents.filter((e) => e.data.checkpointID === cp.id).length).toBe(1)
      const countAfterCreate = checkpointEvents.length

      // Read-only APIs never emit additional mutation events
      yield* orch.getCheckpoint(projectID, cp.id)
      yield* orch.listCheckpoints(projectID)
      yield* orch.latestCheckpoint(projectID)
      yield* Effect.sleep("150 millis")
      expect(checkpointEvents.length).toBe(countAfterCreate)

      // An explicit second checkpoint emits exactly one event for itself
      const cp2 = yield* orch.checkpoint(projectID)
      expect(cp2.id).not.toBe(cp.id)
      yield* Effect.sleep("150 millis")
      expect(checkpointEvents.filter((e) => e.data.checkpointID === cp2.id).length).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.live("default pause checkpoints, publishes paused once, duplicate requests stay idempotent", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "pause default", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)

      const pausedEvents = yield* collectEvents(["atlas.project.paused"])
      const paused = yield* orch.pause(projectID)
      expect(paused.status).toBe("paused")
      expect(paused.mode).toBe("finish_current_safe_step")
      expect(typeof paused.checkpointID).toBe("string")
      expect(typeof paused.pausedAt).toBe("number")

      yield* Effect.sleep("150 millis")
      expect(pausedEvents.length).toBe(1)
      expect(pausedEvents[0]?.data.mode).toBe("finish_current_safe_step")
      expect(pausedEvents[0]?.data.checkpointID).toEqual(paused.checkpointID)

      // Duplicate pause (even a different mode) never re-checkpoints/re-emits
      const again = yield* orch.pause(projectID, "stop_scheduling_only")
      expect(again).toEqual(paused)
      yield* Effect.sleep("150 millis")
      expect(pausedEvents.length).toBe(1)

      expect(yield* orch.getControlState(projectID)).toEqual(paused)
    }).pipe(Effect.scoped),
  )

  it.live("stop_scheduling_only pauses without a checkpoint and hard-blocks admission", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "pause barrier", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)
      yield* orch.pause(projectID, "stop_scheduling_only")

      clearRuntimeState()
      const failed = yield* startedFailureOf(orch.start(projectID))
      expect(failed).toBe(true)
      expect(startedTitles.size).toBe(0)

      const control = yield* orch.getControlState(projectID)
      expect(control.status).toBe("paused")
      expect(control.mode).toBe("stop_scheduling_only")
      expect(control.checkpointID).toBeUndefined()
    }).pipe(Effect.scoped),
  )

  it.live("supervisor suppresses stalled/lost detection while paused; external failures stay visible", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const supervisor = yield* Supervisor.Service
      const objective = yield* orch.createProject({ title: "pause supervisor", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)
      yield* orch.pause(projectID, "stop_scheduling_only")

      const suppressed = yield* supervisor.openIncident({ projectID, kind: "worker_stalled" })
      expect(suppressed.status).toBe("abandoned")
      expect((yield* supervisor.getIncidents(projectID)).find((i) => i.id === suppressed.id)).toBeUndefined()

      const lost = yield* supervisor.openIncident({ projectID, kind: "worker_lost" })
      expect(lost.status).toBe("abandoned")

      const external = yield* supervisor.openIncident({ projectID, kind: "provider_failure", detail: "runtime down" })
      expect(external.status).toBe("open")
      expect((yield* supervisor.getIncidents(projectID)).map((i) => i.id)).toContain(external.id)

      yield* orch.resume(projectID)
      const afterResume = yield* supervisor.openIncident({ projectID, kind: "worker_stalled" })
      expect(afterResume.status).toBe("open")
      expect((yield* supervisor.getIncidents(projectID)).map((i) => i.id)).toContain(afterResume.id)
    }).pipe(Effect.scoped),
  )

  it.live("resume re-admits scheduling after pause; emits resumed once; repeat resume is a no-op", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "resume flow", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)
      yield* orch.pause(projectID, "stop_scheduling_only")

      clearRuntimeState()
      const resumedEvents = yield* collectEvents(["atlas.project.resumed"])
      const resumed = yield* orch.resume(projectID)
      expect(resumed.status).toBe("running")
      yield* Effect.sleep("150 millis")
      expect(resumedEvents.length).toBe(1)

      const idle = yield* orch.resume(projectID)
      expect(idle.status).toBe("running")
      yield* Effect.sleep("150 millis")
      expect(resumedEvents.length).toBe(1)

      // Planning-stage projects do not self-start; execution is explicit again
      yield* orch.start(projectID)
      yield* waitFor(Effect.sync(() => startedTitles.size >= 1), "worker did not launch after resume + start")
      yield* waitFor(
        Effect.gen(function* () {
          const file = yield* orch.get(projectID)
          return file?.roadmap.tasks.every((task) => task.status === "complete") ?? false
        }),
        "roadmap did not complete after resume + start",
      )
      const file = yield* orch.get(projectID)
      expect(file?.roadmap.status).toBe("complete")
    }).pipe(Effect.scoped),
  )

  it.live("restart while pausing reconciles conservatively into paused; nothing auto-runs", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "crash during pausing", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)

      // Simulated crash mid-pause: pausing marker persisted + stale running task
      const file = (yield* Effect.promise(() => loadProject(projectID)))!
      file.roadmap.tasks.forEach((task) => {
        task.status = "running"
      })
      yield* Effect.promise(() => saveProject(projectID, file))
      yield* Effect.promise(() => saveControlState(projectID, { status: "pausing", mode: "finish_current_safe_step" }))

      // Fresh load reconciles: running tasks are not trusted live
      const reloaded = yield* orch.get(projectID)
      expect(reloaded?.roadmap.tasks.every((task) => task.status !== "running")).toBe(true)
      expect((yield* orch.getControlState(projectID)).status).toBe("paused")

      // Only explicit resume restarts execution
      clearRuntimeState()
      expect(yield* startedFailureOf(orch.start(projectID))).toBe(true)
      expect(startedTitles.size).toBe(0)
      yield* orch.resume(projectID)
      expect((yield* orch.getControlState(projectID)).status).toBe("running")
    }).pipe(Effect.scoped),
  )

  it.live("cross-flow: pause stops scheduling at the safe boundary; mutated roadmap executes only after resume", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "crossflow", description: "", acceptanceCriteria: ["first", "second"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)

      // Install a serializable 3-task pipeline sharing one write scope, so
      // workers run strictly one-at-a-time through the real scheduler.
      const file = (yield* Effect.promise(() => loadProject(projectID)))!
      file.roadmap.tasks = [
        ["gate-a", "Worker Alpha"],
        ["gate-b", "Worker Beta"],
        ["gate-c", "Worker Gamma"],
      ].map(([id, title], index) => ({
        id,
        title,
        description: `desc ${id}`,
        status: "planned" as const,
        dependencies: [],
        acceptanceCriteria: [`${id} acceptance`],
        affectedAreas: ["src/shared"],
        priority: 5,
        parallelizable: true,
        attempt: 0,
        maxAttempts: 2,
        revision: 1,
      })) as typeof file.roadmap.tasks
      yield* Effect.promise(() => saveProject(projectID, file))

      clearRuntimeState()
      const gateA = yield* Deferred.make<void>()
      gates.set("Worker Alpha", gateA)

      const lifecycleEvents = yield* collectEvents([
        "atlas.project.paused",
        "atlas.project.resumed",
        "atlas.project.checkpoint.created",
      ])

      yield* orch.start(projectID)
      yield* waitFor(Effect.sync(() => startedTitles.has("Worker Alpha")), "first worker did not start")

      // Pause lands while Alpha holds its write scope: its current turn keeps
      // running to the existing safe boundary instead of being torn down...
      const paused = yield* orch.pause(projectID, "finish_current_safe_step")
      expect(typeof paused.checkpointID).toBe("string")
      // ...and Beta/Gamma were never admitted: no stale queued work exists.
      expect(startedTitles.has("Worker Beta")).toBe(false)

      // Releasing the safe boundary lets Alpha drain and the scheduler stops
      Deferred.doneUnsafe(gateA, Effect.void)
      yield* waitFor(
        Effect.gen(function* () {
          const current = yield* orch.get(projectID)
          return current?.roadmap.tasks.find((task) => task.id === "gate-a")?.status === "complete"
        }),
        "alpha did not finish its safe boundary step",
      )
      expect(startedTitles.has("Worker Beta")).toBe(false)
      expect(startedTitles.has("Worker Gamma")).toBe(false)
      expect([...startedTitles]).toEqual(["Worker Alpha"])

      // User mutates the roadmap while paused: Beta gets a fresh revision and
      // title. Mutation alone never resumes execution.
      const mutated = (yield* Effect.promise(() => loadProject(projectID)))!
      const beta = mutated.roadmap.tasks.find((task) => task.id === "gate-b")!
      beta.revision += 1
      beta.title = "Worker Beta v2"
      mutated.roadmap.version += 1
      yield* Effect.promise(() => saveProject(projectID, mutated))
      expect(startedTitles.has("Worker Beta v2")).toBe(false)

      // Simulated restart: a fresh load sees exactly the persisted snapshot
      const restarted = (yield* Effect.promise(() => loadProject(projectID)))!
      expect(restarted.roadmap.tasks.find((task) => task.id === "gate-b")?.revision).toBe(beta.revision)

      // Explicit resume reloads latest state and executes remaining valid work;
      // pre-mutation contracts are compiled fresh (stale ones never replay).
      yield* orch.resume(projectID)
      yield* waitFor(
        Effect.sync(() => startedTitles.has("Worker Beta v2")),
        "resumed execution did not compile the latest revision",
      )
      yield* waitFor(
        Effect.gen(function* () {
          const current = yield* orch.get(projectID)
          return current?.roadmap.tasks.every((task) => task.status === "complete") ?? false
        }),
        "cross-flow roadmap did not complete after resume",
      )
      const finalText = promptTexts.join("\n\n---\n\n")
      expect(finalText).toContain("# Task: Worker Beta v2")
      expect(finalText).toContain("# Task: Worker Gamma")

      yield* Effect.sleep("250 millis")
      const types = lifecycleEvents.map((e) => e.type)
      expect(types.filter((t) => t === "atlas.project.paused").length).toBe(1)
      expect(types.filter((t) => t === "atlas.project.resumed").length).toBe(1)
      expect(types.includes("atlas.project.checkpoint.created")).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live("project isolation: pausing A leaves B untouched with separated state", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const aObj = yield* orch.createProject({ title: "iso A", description: "", acceptanceCriteria: ["a"] })
      const bObj = yield* orch.createProject({ title: "iso B", description: "", acceptanceCriteria: ["b"] })

      yield* orch.pause(aObj.projectID)
      expect((yield* orch.getControlState(aObj.projectID)).status).toBe("paused")
      expect((yield* orch.getControlState(bObj.projectID)).status).toBe("running")

      const aCp = yield* orch.latestCheckpoint(aObj.projectID)
      const bCp = yield* orch.latestCheckpoint(bObj.projectID)
      expect(aCp?.projectID).toBe(aObj.projectID)
      expect(bCp).toBeUndefined()
    }).pipe(Effect.scoped),
  )
})
