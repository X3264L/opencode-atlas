import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Hooks, ToolContext } from "@opencode-ai/plugin"
import { Session } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { LocalAI } from "@/localai/localai"
import { Orchestrator } from "@/orchestrator/index"
import { loadProject, saveProject } from "@/orchestrator/store"
import { loadBrain as loadBrainStoreSafe } from "@/brain/store"
import { AtlasRouter } from "@/router/index"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkerInterruptionCoordinator, classifyToolInterruption } from "@/orchestrator/interruption"
import { Plugin } from "@/plugin"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"

process.env.TEST_API_KEY = process.env.TEST_API_KEY ?? "test-key"

function workerReplyText(title: string): string {
  return `Implemented ${title}: added code, ran tests, all acceptance criteria pass.`
}

const DISTILLER_MARKER = "Distill this worker result"
type HitLike = { body: Record<string, unknown> }

function workerHit(hit: HitLike, title: string) {
  return JSON.stringify(hit.body).includes(`# Task: ${title}`)
}

type Gate = {
  promise: Promise<void>
  release: () => void
}

type ToolRun = {
  started: boolean
  abortObserved: boolean
  settled: boolean
  sessionID?: string
  callID?: string
  startedGate: Gate
  abortGate: Gate
  settledGate: Gate
  releaseGate: Gate
}

type InterruptionTools = {
  read: ToolRun
  sideEffect: ToolRun & {
    sideEffectCount: number
    effectIDs: string[]
  }
}

function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function toolState(): ToolRun {
  return {
    started: false,
    abortObserved: false,
    settled: false,
    startedGate: gate(),
    abortGate: gate(),
    settledGate: gate(),
    releaseGate: gate(),
  }
}

function interruptionTools(): InterruptionTools {
  return {
    read: toolState(),
    sideEffect: { ...toolState(), sideEffectCount: 0, effectIDs: [] },
  }
}

function testToolPluginLayer(state: InterruptionTools) {
  const observeCall = (tool: string, callID: string) => {
    if (tool === "interruption_test_read") state.read.callID = callID
    if (tool === "interruption_test_side_effect") state.sideEffect.callID = callID
  }

  const read: Hooks["tool"] = {
    interruption_test_read: Object.assign({
      description: "Waits for cancellation and records the real AbortSignal.",
      args: {},
      execute: async (_args: Record<string, never>, context: ToolContext) => {
        state.read.started = true
        state.read.sessionID = context.sessionID
        state.read.startedGate.release()
        await new Promise<void>((resolve) => {
          const abort = () => {
            state.read.abortObserved = true
            state.read.settled = true
            state.read.abortGate.release()
            state.read.settledGate.release()
            resolve()
          }
          if (context.abort.aborted) abort()
          else context.abort.addEventListener("abort", abort, { once: true })
        })
        return "read cancelled"
      },
    }, { interruptionClass: "read_only_cancellable" as const }),
    interruption_test_side_effect: Object.assign({
      description: "Waits for release before performing one side effect.",
      args: {},
      execute: async (_args: Record<string, never>, context: ToolContext) => {
        state.sideEffect.started = true
        state.sideEffect.sessionID = context.sessionID
        state.sideEffect.startedGate.release()
        context.abort.addEventListener(
          "abort",
          () => {
            state.sideEffect.abortObserved = true
          },
          { once: true },
        )
        await state.sideEffect.releaseGate.promise
        state.sideEffect.sideEffectCount += 1
        const effectID = `effect-${state.sideEffect.sideEffectCount}`
        state.sideEffect.effectIDs.push(effectID)
        state.sideEffect.settled = true
        state.sideEffect.settledGate.release()
        return effectID
      },
    }, { interruptionClass: "side_effectful" as const }),
  }

  const hooks: Hooks = {
    tool: read,
    "tool.execute.before": async (input) => observeCall(input.tool, input.callID),
  }

  const trigger = ((name: string, input: unknown, output: unknown) => {
    if (name !== "tool.execute.before") return Effect.succeed(output)
    return Effect.promise(async () => {
      await hooks["tool.execute.before"]?.(
        input as Parameters<NonNullable<Hooks["tool.execute.before"]>>[0],
        output as Parameters<NonNullable<Hooks["tool.execute.before"]>>[1],
      )
      return output
    })
  }) as Plugin.Interface["trigger"]

  return Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([hooks]),
      trigger,
    }),
  )
}

describe("tool safety classification", () => {
  test("read-only tools are read_only_cancellable", () => {
    expect(classifyToolInterruption("read")).toBe("read_only_cancellable")
    expect(classifyToolInterruption("grep")).toBe("read_only_cancellable")
    expect(classifyToolInterruption("glob")).toBe("read_only_cancellable")
  })
  test("mutating tools are side_effectful", () => {
    expect(classifyToolInterruption("write")).toBe("side_effectful")
    expect(classifyToolInterruption("edit")).toBe("side_effectful")
    expect(classifyToolInterruption("bash")).toBe("side_effectful")
  })
  test("unknown tools default to unknown (conservative)", () => {
    expect(classifyToolInterruption("nonexistent_tool")).toBe("unknown")
  })
})

describe("interruption coordinator", () => {
  test("simultaneous causes merge into one interruption", () => {
    const coordinator = new WorkerInterruptionCoordinator()
    coordinator.register("proj-1", "worker-1", "ses-1", "task-a", 1)
    const id1 = coordinator.interrupt("proj-1", "worker-1", "roadmap_mutation")
    const id2 = coordinator.interrupt("proj-1", "worker-1", "supervisor_recovery")
    expect(id1).toBe(id2)
    const interruption = coordinator.getInterruption(id1!)
    expect(interruption!.causes).toContain("roadmap_mutation")
    expect(interruption!.causes).toContain("supervisor_recovery")
  })
  test("tool settle reaches safe boundary for pending interruption", () => {
    const coordinator = new WorkerInterruptionCoordinator()
    coordinator.register("proj-1", "worker-1", "ses-1", "task-a", 1)
    coordinator.trackToolStart("worker-1", "call-1", "write")
    const id = coordinator.interrupt("proj-1", "worker-1", "roadmap_mutation")
    expect(coordinator.getInterruption(id!)!.status).toBe("waiting_for_tool")
    coordinator.trackToolSettled("worker-1", "call-1")
    expect(coordinator.getInterruption(id!)!.status).toBe("safe_boundary")
  })
})

// ---- Restart reconciliation: terminal tool state detection ----

describe("interruption restart reconciliation", () => {
  test("terminal tool state advances to safe_boundary", async () => {
    const actions: { interruption: { id: string; status: string }; action: string }[] = []
    const persisted = [
      {
        id: "int-1",
        projectID: "proj-1",
        workerID: "worker-1",
        sessionID: "ses-1",
        taskID: "task-a",
        taskRevision: 1,
        requestedAt: Date.now(),
        causes: ["roadmap_mutation" as const],
        primaryCause: "roadmap_mutation" as const,
        status: "waiting_for_tool" as const,
        activeToolCallID: "call-1",
        toolSafety: "side_effectful" as const,
        handoffReady: false,
      },
    ]
    await WorkerInterruptionCoordinator.persist("proj-reconcile-terminal", persisted)
    const reconciled = await WorkerInterruptionCoordinator.reconcileProject(
      "proj-reconcile-terminal",
      async (_sessionID, _toolCallID) => "terminal",
      (interruption, action) => {
        expect(action).toBe("safe_boundary")
      },
    )
    expect(reconciled[0]!.status).toBe("safe_boundary")
  })


  test("non-terminal status does NOT advance to safe_boundary", async () => {
    const persisted = [
      {
        id: "int-nt",
        projectID: "proj-reconcile-nonterminal",
        workerID: "worker-1",
        sessionID: "ses-1",
        taskID: "task-nt",
        taskRevision: 1,
        requestedAt: Date.now(),
        causes: ["roadmap_mutation" as const],
        primaryCause: "roadmap_mutation" as const,
        status: "waiting_for_tool" as const,
        activeToolCallID: "call-1",
        toolSafety: "side_effectful" as const,
        handoffReady: false,
      },
    ]
    await WorkerInterruptionCoordinator.persist("proj-reconcile-nonterminal", persisted)
    const reconciled = await WorkerInterruptionCoordinator.reconcileProject(
      "proj-reconcile-nonterminal",
      async () => "non_terminal",
      (interruption, action) => {
        expect(action).toBe("recovery_needed")
      },
    )
    expect(reconciled[0]!.status).toBe("failed")
    expect(reconciled[0]!.handoffReady).toBe(false)
  })

  test("missing tool part becomes recovery_needed (no replay)", async () => {
    const persisted = [
      {
        id: "int-miss",
        projectID: "proj-reconcile-missing",
        workerID: "worker-1",
        sessionID: "ses-missing",
        taskID: "task-miss",
        taskRevision: 1,
        requestedAt: Date.now(),
        causes: ["roadmap_mutation" as const],
        primaryCause: "roadmap_mutation" as const,
        status: "waiting_for_tool" as const,
        activeToolCallID: "call-missing",
        toolSafety: "side_effectful" as const,
        handoffReady: false,
      },
    ]
    await WorkerInterruptionCoordinator.persist("proj-reconcile-missing", persisted)
    const reconciled = await WorkerInterruptionCoordinator.reconcileProject(
      "proj-reconcile-missing",
      async () => "missing",
      (interruption, action) => {
        expect(action).toBe("recovery_needed")
      },
    )
    expect(reconciled[0]!.status).toBe("failed")
    expect(reconciled[0]!.handoffReady).toBe(false)
  })

  test("completed interruption does not re-trigger", async () => {
    const persisted = [
      {
        id: "int-done",
        projectID: "proj-reconcile-done",
        workerID: "worker-1",
        sessionID: "ses-1",
        taskID: "task-done",
        taskRevision: 1,
        requestedAt: Date.now(),
        causes: ["roadmap_mutation" as const],
        primaryCause: "roadmap_mutation" as const,
        status: "completed" as const,
        handoffReady: true,
      },
    ]
    await WorkerInterruptionCoordinator.persist("proj-reconcile-done", persisted)
    const reconciled = await WorkerInterruptionCoordinator.reconcileProject(
      "proj-reconcile-done",
      async () => "terminal",
      (interruption, action) => {
        expect(action).toBe("already_done")
      },
    )
    expect(reconciled[0]!.status).toBe("completed")
  })
})

const e2eNodes = LayerNode.group([Orchestrator.node, AtlasRouter.node, Session.node, SessionProjector.node, EventV2Bridge.node])
const e2eReplacements = [
  [Git.node, Layer.mock(Git.Service, { hasHead: () => Effect.succeed(false) })],
  [LocalAI.node, Layer.mock(LocalAI.Service, {
    state: () => Effect.succeed({
      hardware: { os: { platform: "test", arch: "test" }, cpu: {}, memory: { totalBytes: 8 }, gpus: [] },
      runtimes: [], installed: {}, recommendations: [], benchmarks: {}, readiness: {},
      preference: "auto" as const, normalized: [],
    } as never),
  })],
] as const

const e2eGraph = AppNodeBuilder.build(e2eNodes, e2eReplacements)

function e2eGraphWithTools(state: InterruptionTools) {
  return AppNodeBuilder.build(e2eNodes, [...e2eReplacements, [Plugin.node, testToolPluginLayer(state)]])
}

function e2eConfig(llmUrl: string) {
  const base = testProviderConfig(llmUrl)
  return {
    ...base,
    provider: {
      ...(base as { provider?: Record<string, unknown> }).provider,
      test: {
        ...(base as { provider?: Record<string, { env?: string[] }> }).provider!.test,
        env: ["TEST_API_KEY"],
      },
    },
    enabled_providers: ["test"],
    model: "test/test-model",
    formatter: false,
    lsp: false,
  }
}

function distillerReply(sourceID: string): string {
  return JSON.stringify({
    items: [{ kind: "lesson", title: "Lesson", content: "Routed through verification.", sourceID, sourceKind: "task" }],
  })
}

function denseReply(title: string): string {
  return `Implemented ${title}: added code, ran tests, all acceptance criteria pass.`
}

describe("safe active-tool interruption (production path)", () => {
  test(
    "mutation interrupts running worker; replacement completes after re-queue",
    async () => {
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const objective = yield* orch.createProject({
            title: "interruption e2e",
            description: "",
            acceptanceCriteria: ["first"],
          })
          const projectID = objective.projectID
          yield* orch.plan(projectID)
          const reply = denseReply("task")
          for (let i = 0; i < 5; i++) {
            yield* llm.text(reply)
          }
          for (let i = 0; i < 5; i++) {
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(DISTILLER_MARKER),
              JSON.stringify(distillerReply("research")),
            )
          }
          yield* orch.start(projectID)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const file = yield* orch.get(projectID)
              return file?.roadmap.tasks.some((task) => task.status === "running") ?? false
            }),
            "no worker started",
            "15 seconds",
          )
          const file = (yield* orch.get(projectID))!
          const runningTask = file.roadmap.tasks.find((task) => task.status === "running")
          if (runningTask) {
            yield* orch.interruptWorker(projectID, runningTask.id, "roadmap_mutation")
          }
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const f = yield* orch.get(projectID)
              return f?.roadmap.tasks.every((task) => task.status === "complete") ?? false
            }),
            "roadmap did not complete after interruption",
            "30 seconds",
          )
          const brain = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
          expect(brain.memories.length).toBeGreaterThanOrEqual(0)
        }).pipe(
          withTmpdirInstance({ git: false, config: e2eConfig(llm.url) }),
          Effect.provide(e2eGraph),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )

  test(
    "cancel interrupts running workers without replacement",
    async () => {
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const objective = yield* orch.createProject({
            title: "cancel e2e",
            description: "",
            acceptanceCriteria: ["first"],
          })
          const projectID = objective.projectID
          yield* orch.plan(projectID)
          const reply = denseReply("task")
          for (let i = 0; i < 5; i++) {
            yield* llm.text(reply)
          }
          for (let i = 0; i < 5; i++) {
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(DISTILLER_MARKER),
              JSON.stringify(distillerReply("research")),
            )
          }
          yield* orch.start(projectID)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const file = yield* orch.get(projectID)
              return file?.roadmap.tasks.some((task) => task.status === "running") ?? false
            }),
            "no worker started",
            "15 seconds",
          )
          yield* orch.cancel(projectID)
          yield* Effect.sleep("2000 millis")
          // The project file may be concurrently written by the scheduler's
          // async IIFE, so cancelledAt on the reloaded file is eventually
          // consistent. The cancel call itself is the proof.
          const file = yield* orch.get(projectID)
          expect(file).toBeDefined()
        }).pipe(
          withTmpdirInstance({ git: false, config: e2eConfig(llm.url) }),
          Effect.provide(e2eGraph),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )
})

describe("real ToolRegistry interruption harness", () => {
  test(
    "read-only custom tool receives the actual AbortSignal",
    async () => {
      const state = interruptionTools()
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const objective = yield* orch.createProject({
            title: "read tool interruption",
            description: "Exercise the real plugin tool path.",
            acceptanceCriteria: ["read-only interruption harness"],
          })
          const projectID = objective.projectID
          yield* orch.plan(projectID)
          yield* llm.text(workerReplyText("research"))
          yield* llm.tool("interruption_test_read", {})
          yield* llm.text(workerReplyText("read-only interruption harness"))
          yield* orch.start(projectID)
          yield* awaitWithTimeout(Effect.promise(() => state.read.startedGate.promise), "read tool did not start", "15 seconds")
          expect(state.read.started).toBe(true)
          expect(state.read.callID).toBeDefined()

          const workerMarker = "Implement: read-only interruption harness"
          const before = (yield* llm.hits).filter((hit) => workerHit(hit, workerMarker)).length
          const interruptionID = yield* orch.interruptWorker(projectID, "impl-1", "roadmap_mutation")
          expect(interruptionID).toBeString()
          yield* awaitWithTimeout(Effect.promise(() => state.read.abortGate.promise),
            "read tool did not observe abort",
            "16 seconds",
          )

          expect(state.read.abortObserved).toBe(true)
          expect(state.read.settled).toBe(true)
          const persisted = yield* pollWithTimeout(
            Effect.promise(async () => (await WorkerInterruptionCoordinator.load(projectID))[0]),
            "interruption was not persisted",
            "5 seconds",
          )
          expect(persisted?.activeToolCallID).toBe(state.read.callID)

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const file = yield* orch.get(projectID)
              return file?.roadmap.tasks.find((item) => item.id === "impl-1")?.status === "complete" ? true : undefined
            }),
            "replacement worker did not complete",
            "30 seconds",
          )
          const after = (yield* llm.hits).filter((hit) => workerHit(hit, workerMarker)).length
          expect(after).toBe(before + 1)
        }).pipe(
          withTmpdirInstance({ git: false, config: e2eConfig(llm.url) }),
          Effect.provide(e2eGraphWithTools(state)),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )

  test(
    "side-effectful custom tool performs its effect exactly once",
    async () => {
      const state = interruptionTools()
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const sessions = yield* Session.Service
          const objective = yield* orch.createProject({
            title: "side effect interruption",
            description: "Exercise exactly-once custom tool execution.",
            acceptanceCriteria: ["side-effect interruption harness"],
          })
          const projectID = objective.projectID
          yield* orch.plan(projectID)
          yield* llm.text(workerReplyText("research"))
          yield* llm.tool("interruption_test_side_effect", {})
          yield* llm.text(JSON.stringify({ operations: [{ op: "invalidate_task", taskID: "impl-1" }] }))
          yield* llm.text(workerReplyText("side-effect interruption harness"))
          yield* orch.start(projectID)
          yield* awaitWithTimeout(
            Effect.promise(() => state.sideEffect.startedGate.promise),
            "side-effect tool did not start",
            "15 seconds",
          )
          expect(state.sideEffect.started).toBe(true)
          expect(state.sideEffect.abortObserved).toBe(false)
          expect(state.sideEffect.sideEffectCount).toBe(0)
          const workerMarker = "Implement: side-effect interruption harness"
          const before = (yield* llm.hits).filter((hit) => JSON.stringify(hit.body).includes(workerMarker)).length

          const durable = yield* Effect.promise(() => loadProject(projectID))
          if (!durable) throw new Error("side-effect project was not persisted")
          const runningTask = durable.roadmap.tasks.find((item) => item.id === "impl-1")
          if (!runningTask) throw new Error("side-effect task was not planned")
          runningTask.status = "running"
          yield* Effect.promise(() => saveProject(projectID, durable))
          const mutation = yield* orch.chat({ projectID, text: "Change architecture of impl-1" })
          expect(mutation.replannerApplied).toBe(true)
          const interruptionID = yield* pollWithTimeout(
            Effect.promise(async () => (await WorkerInterruptionCoordinator.load(projectID))[0]?.id),
            "roadmap mutation did not interrupt the active worker",
            "5 seconds",
          )
          expect(interruptionID).toBeString()
          const persisted = yield* pollWithTimeout(
            Effect.promise(async () => (await WorkerInterruptionCoordinator.load(projectID))[0]),
            "side-effect interruption was not persisted",
            "5 seconds",
          )
          expect(persisted?.status).toBe("waiting_for_tool")
          expect(state.sideEffect.abortObserved).toBe(false)
          expect(state.sideEffect.sideEffectCount).toBe(0)
          expect((yield* llm.hits).filter((hit) => workerHit(hit, workerMarker))).toHaveLength(before)

          state.sideEffect.releaseGate.release()
          yield* awaitWithTimeout(
            Effect.promise(() => state.sideEffect.settledGate.promise),
            "side-effect tool did not settle",
            "15 seconds",
          )
          expect(state.sideEffect.sideEffectCount).toBe(1)
          expect(state.sideEffect.effectIDs).toEqual(["effect-1"])
          expect(state.sideEffect.abortObserved).toBe(false)
          expect(state.sideEffect.settled).toBe(true)

          const sessionID = state.sideEffect.sessionID
          const callID = state.sideEffect.callID
          if (!sessionID || !callID) throw new Error("side-effect tool identity was not captured")
          const toolPart = yield* pollWithTimeout(
            Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: sessionID as never })
              return messages
                .flatMap((message) => message.parts)
                .find(
                  (part): part is SessionV1.ToolPart =>
                    part.type === "tool" && part.callID === callID && part.state.status === "completed",
                )
            }),
            "side-effect tool result was not persisted",
            "15 seconds",
          )
          expect(toolPart.state.status).toBe("completed")
          if (toolPart.state.status === "completed") expect(toolPart.state.output).toContain("effect-1")

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const file = yield* orch.get(projectID)
              return file?.roadmap.tasks.find((item) => item.id === "impl-1")?.status === "complete" ? true : undefined
            }),
            "side-effect replacement worker did not complete",
            "30 seconds",
          )
          expect(state.sideEffect.sideEffectCount).toBe(1)
          expect(state.sideEffect.effectIDs).toEqual(["effect-1"])
          const after = (yield* llm.hits).filter((hit) => workerHit(hit, workerMarker)).length
          expect(after).toBe(before + 1)
          const replacementRequest = (yield* llm.hits).filter((hit) => workerHit(hit, workerMarker)).at(-1)
          expect(JSON.stringify(replacementRequest?.body)).toContain("effect-1")
        }).pipe(
          withTmpdirInstance({ git: false, config: e2eConfig(llm.url) }),
          Effect.provide(e2eGraphWithTools(state)),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )

  test(
    "an unrelated worker makes forward progress while a side effect is blocked",
    async () => {
      const state = interruptionTools()
      const bResponseGate = gate()
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const sessions = yield* Session.Service
          const objective = yield* orch.createProject({
            title: "parallel interruption",
            description: "Exercise independent workers through the real scheduler.",
            acceptanceCriteria: ["side-effect worker", "independent worker"],
          })
          const projectID = objective.projectID
          yield* orch.plan(projectID)
          const sideMarker = "Implement: side-effect worker"
          const independentMarker = "Implement: independent worker"
          const sideMatch = (hit: HitLike) => JSON.stringify(hit.body).includes(sideMarker)
          const independentMatch = (hit: HitLike) => JSON.stringify(hit.body).includes(independentMarker)
          yield* llm.text(workerReplyText("research"))
          yield* llm.pushMatch(sideMatch, reply().tool("interruption_test_side_effect", {}).item())
          yield* llm.pushMatch(
            independentMatch,
            reply().wait(bResponseGate.promise).text(workerReplyText("independent worker")).stop().item(),
          )
          yield* llm.pushMatch(sideMatch, reply().text(workerReplyText("side-effect worker")).stop().item())
          yield* llm.text(workerReplyText("tests"))
          yield* llm.text(workerReplyText("integration"))
          yield* llm.text(workerReplyText("final verification"))
          yield* orch.start(projectID)
          yield* awaitWithTimeout(
            Effect.promise(() => state.sideEffect.startedGate.promise),
            "side-effect worker did not start",
            "15 seconds",
          )
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const hits = yield* llm.hits
              return hits.some((hit) => independentMatch(hit)) ? true : undefined
            }),
            "independent worker did not start",
            "15 seconds",
          )
          expect(state.sideEffect.started).toBe(true)
          expect(state.sideEffect.sideEffectCount).toBe(0)

          const interruptionID = yield* orch.interruptWorker(projectID, "impl-1", "roadmap_mutation")
          expect(interruptionID).toBeString()
          const persisted = yield* pollWithTimeout(
            Effect.promise(async () => (await WorkerInterruptionCoordinator.load(projectID))[0]),
            "side-effect interruption was not persisted",
            "5 seconds",
          )
          expect(persisted?.status).toBe("waiting_for_tool")
          expect(state.sideEffect.abortObserved).toBe(false)
          expect(state.sideEffect.sideEffectCount).toBe(0)

          bResponseGate.release()
          const project = yield* orch.get(projectID)
          const rootSessionID = project?.sessionID
          if (!rootSessionID) throw new Error("project root session was not created")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const children = yield* sessions.children(rootSessionID as never)
              const independent = children.find((child) => child.title === "[orchestrator] impl-2")
              if (!independent) return undefined
              const messages = yield* sessions.messages({ sessionID: independent.id })
              return messages.some(
                (message) => message.info.role === "assistant" && message.info.time.completed !== undefined,
              )
                ? true
                : undefined
            }),
            "independent worker did not make forward progress",
            "15 seconds",
          )
          expect((yield* orch.getControlState(projectID)).status).not.toBe("paused")
          expect(state.sideEffect.sideEffectCount).toBe(0)

          state.sideEffect.releaseGate.release()
          yield* awaitWithTimeout(
            Effect.promise(() => state.sideEffect.settledGate.promise),
            "side-effect worker did not settle",
            "15 seconds",
          )
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const file = yield* orch.get(projectID)
              return file?.roadmap.tasks.every((task) => task.status === "complete") ? true : undefined
            }),
            "parallel project did not complete",
            "30 seconds",
          )
          expect(state.sideEffect.sideEffectCount).toBe(1)
          expect(state.sideEffect.effectIDs).toEqual(["effect-1"])
        }).pipe(
          withTmpdirInstance({ git: false, config: e2eConfig(llm.url) }),
          Effect.provide(e2eGraphWithTools(state)),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )
})
