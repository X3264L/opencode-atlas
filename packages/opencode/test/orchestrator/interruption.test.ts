import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { LocalAI } from "@/localai/localai"
import { Orchestrator } from "@/orchestrator/index"
import { loadProject } from "@/orchestrator/store"
import { loadBrain as loadBrainStoreSafe } from "@/brain/store"
import { AtlasRouter } from "@/router/index"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkerInterruptionCoordinator, classifyToolInterruption } from "@/orchestrator/interruption"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { withTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

process.env.TEST_API_KEY = process.env.TEST_API_KEY ?? "test-key"

function workerReplyText(title: string): string {
  return `Implemented ${title}: added code, ran tests, all acceptance criteria pass.`
}

const DISTILLER_MARKER = "Distill this worker result"
type HitLike = { body: Record<string, unknown> }

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
  test("fence staleness: old generation rejected, current accepted", () => {
    const coordinator = new WorkerInterruptionCoordinator()
    coordinator.register("proj-1", "worker-old", "ses-old", "task-a", 1)
    expect(coordinator.isStale("task-a", "worker-old")).toBe(false)
    coordinator.fenceAndReplace("proj-1", "task-a", "worker-old")
    expect(coordinator.isStale("task-a", "worker-old")).toBe(true)
    coordinator.register("proj-1", "worker-new", "ses-new", "task-a", 1)
    expect(coordinator.isStale("task-a", "worker-new")).toBe(false)
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

const e2eGraph = AppNodeBuilder.build(
  LayerNode.group([Orchestrator.node, AtlasRouter.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
  [
    [Git.node, Layer.mock(Git.Service, { hasHead: () => Effect.succeed(false) })],
    [LocalAI.node, Layer.mock(LocalAI.Service, {
      state: () => Effect.succeed({
        hardware: { os: { platform: "test", arch: "test" }, cpu: {}, memory: { totalBytes: 8 }, gpus: [] },
        runtimes: [], installed: {}, recommendations: [], benchmarks: {}, readiness: {},
        preference: "auto" as const, normalized: [],
      } as never),
    })],
  ],
)

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
  test.skip(
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
          expect(brain.memories.length).toBeGreaterThanOrEqual(1)
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

  test.skip(
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
          const file = yield* orch.get(projectID)
          expect(file?.cancelledAt).toBeDefined()
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