import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Orchestrator } from "@/orchestrator/index"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Git, type Stat } from "@/git"
import type { DiffstatSummary } from "@/orchestrator/diffstat"
import { testEffect } from "../lib/effect"

// Canned git source routed by working directory so multiple projects can share
// one fake service without leaking state into each other.
const gitHasHead = new Map<string, boolean>()
const gitStats = new Map<string, Stat[]>()

const fakeGit = Layer.mock(Git.Service, {
  hasHead: (cwd: string) => Effect.succeed(gitHasHead.get(cwd) ?? false),
  stats: (cwd: string) => Effect.succeed(gitStats.get(cwd) ?? []),
  status: () => Effect.succeed([]),
  statUntracked: () => Effect.succeed(undefined),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, EventV2Bridge.node]),
    [
      [Session.node, Layer.mock(Session.Service, { create: () => Effect.succeed({ id: "sess-diffstat-root" } as never) })],
      [SessionPrompt.node, Layer.mock(SessionPrompt.Service, {})],
      [Git.node, fakeGit],
    ],
  ),
)

interface DiffstatEvent {
  projectID: string
  additions: number
  deletions: number
  files: number
}

const collectDiffstatEvents = () =>
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    const events: DiffstatEvent[] = []
    const signals: Deferred.Deferred<DiffstatEvent>[] = []
    const unsubscribe = yield* bridge.listen((event) => {
      if (event.type !== "atlas.diffstat.changed") return Effect.void
      const data = event.data as DiffstatEvent
      events.push(data)
      for (const signal of signals.splice(0)) Deferred.doneUnsafe(signal, Effect.succeed(data))
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const next = () =>
      Effect.gen(function* () {
        const signal = yield* Deferred.make<DiffstatEvent>()
        signals.push(signal)
        return yield* Deferred.await(signal)
      })
    return { events, next }
  })

const cleanupProject = (projectID: string) =>
  Effect.promise(() => rm(path.join(Global.Path.state, "orchestrator", projectID), { recursive: true, force: true }))

const tempWorkspace = (prefix: string) => Effect.promise(() => mkdtemp(path.join(os.tmpdir(), prefix)))

const createWatchedProject = Effect.fn("test.createWatchedProject")(function* (dir: string) {
  const orchestrator = yield* Orchestrator.Service
  const objective = yield* orchestrator.createProject({
    title: "diffstat",
    description: "",
    acceptanceCriteria: [],
    workspace: dir,
  })
  return objective.projectID
})

describe("runtime diffstat watcher", () => {
  it.instance(
    "emits on clean→dirty and dirty→clean, stays silent while unchanged",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempWorkspace("atlas-diffstat-")
        gitStats.delete(dir)
        gitHasHead.set(dir, true)

        const recorder = yield* collectDiffstatEvents()
        const projectID = yield* createWatchedProject(dir)

        // Baseline primed with an empty summary; unchanged polls emit nothing
        yield* Effect.sleep("2400 millis")
        expect(recorder.events).toEqual([])

        // clean → dirty
        gitStats.set(dir, [
          { file: "src/auth.ts", additions: 82, deletions: 11 },
          { file: "src/logo.png", additions: 0, deletions: 0, binary: true },
        ])
        const dirty = yield* Effect.race(
          recorder.next(),
          Effect.sleep("6000 millis").pipe(Effect.as(undefined)),
        )
        expect(dirty).toEqual({ projectID, additions: 82, deletions: 11, files: 2 })

        // unchanged summary → nothing further
        const countAfterDirty = recorder.events.length
        yield* Effect.sleep("2400 millis")
        expect(recorder.events.length).toBe(countAfterDirty)

        // dirty → clean
        gitStats.set(dir, [])
        const clean = yield* Effect.race(
          recorder.next(),
          Effect.sleep("6000 millis").pipe(Effect.as(undefined)),
        )
        expect(clean).toEqual({ projectID, additions: 0, deletions: 0, files: 0 })

        // Cancel stops the watcher: further mutations emit nothing
        const orchestrator = yield* Orchestrator.Service
        expect(yield* orchestrator.cancel(projectID)).toBe(true)
        const countAfterCancel = recorder.events.length
        gitStats.set(dir, [{ file: "late.ts", additions: 9, deletions: 1 }])
        yield* Effect.sleep("2400 millis")
        expect(recorder.events.length).toBe(countAfterCancel)

        yield* cleanupProject(projectID)
      }).pipe(Effect.scoped),
    20_000,
  )

  it.instance(
    "re-activating a stopped project creates no duplicate watcher emissions",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempWorkspace("atlas-diffstat-")
        gitHasHead.set(dir, true)
        gitStats.set(dir, [])

        const recorder = yield* collectDiffstatEvents()
        const orchestrator = yield* Orchestrator.Service
        const projectID = yield* createWatchedProject(dir)

        // Stop, then reactivate through the read entry point
        yield* orchestrator.cancel(projectID)
        const file = yield* orchestrator.get(projectID)
        expect(file?.workspace).toBe(dir)

        gitStats.set(dir, [{ file: "a.ts", additions: 3, deletions: 0 }])
        yield* Effect.race(recorder.next(), Effect.sleep("6000 millis").pipe(Effect.as(undefined)))
        yield* Effect.sleep("2400 millis")

        const mine = recorder.events.filter((event) => event.projectID === projectID)
        expect(mine).toEqual([{ projectID, additions: 3, deletions: 0, files: 1 }])

        yield* cleanupProject(projectID)
      }).pipe(Effect.scoped),
    20_000,
  )

  it.instance(
    "two projects watch their own workspaces independently",
    () =>
      Effect.gen(function* () {
        const dirA = yield* tempWorkspace("atlas-diffstat-a-")
        const dirB = yield* tempWorkspace("atlas-diffstat-b-")
        gitHasHead.set(dirA, true)
        gitHasHead.set(dirB, true)
        gitStats.set(dirA, [])
        gitStats.set(dirB, [])

        const recorder = yield* collectDiffstatEvents()
        const idA = yield* createWatchedProject(dirA)
        const idB = yield* createWatchedProject(dirB)

        gitStats.set(dirB, [{ file: "b.ts", additions: 7, deletions: 2 }])
        const event = yield* Effect.race(recorder.next(), Effect.sleep("6000 millis").pipe(Effect.as(undefined)))
        expect(event?.projectID).toBe(idB)
        expect(event).toEqual({ projectID: idB, additions: 7, deletions: 2, files: 1 })
        expect(recorder.events.every((entry) => entry.projectID !== idA)).toBe(true)

        yield* cleanupProject(idA)
        yield* cleanupProject(idB)
      }).pipe(Effect.scoped),
    20_000,
  )

  it.instance(
    "read model exposes real summaries/files and never publishes change events",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempWorkspace("atlas-diffstat-read-")
        gitHasHead.set(dir, true)
        gitStats.set(dir, [
          { file: "src/auth.ts", additions: 82, deletions: 11 },
          { file: "assets/logo.png", additions: 0, deletions: 0, binary: true },
        ])

        const recorder = yield* collectDiffstatEvents()
        const orchestrator = yield* Orchestrator.Service
        const projectID = yield* createWatchedProject(dir)

        const summary: DiffstatSummary | undefined = yield* orchestrator.workingTreeSummary(projectID)
        expect(summary).toEqual({ additions: 82, deletions: 11, files: 2 })

        const files = yield* orchestrator.workingTreeFiles(projectID)
        expect(files).toEqual([
          { path: "src/auth.ts", additions: 82, deletions: 11, binary: false },
          { path: "assets/logo.png", binary: true },
        ])

        // No workspace → honest unknowns
        expect(yield* orchestrator.workingTreeSummary("proj-nonexistent")).toBeUndefined()
        expect(yield* orchestrator.workingTreeFiles("proj-nonexistent")).toEqual([])

        yield* Effect.sleep("120 millis")
        expect(recorder.events).toEqual([])

        yield* cleanupProject(projectID)
      }).pipe(Effect.scoped),
    10_000,
  )
})
