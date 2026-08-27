import { describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
process.env.TEST_API_KEY = process.env.TEST_API_KEY ?? "test-key"
process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? "local-key"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { LocalAI } from "@/localai/localai"
import { Provider } from "@/provider/provider"
import { Orchestrator } from "@/orchestrator/index"
import { loadProject, saveProject as saveProjectStrict } from "@/orchestrator/store"
import { loadBrain as loadBrainStoreSafe } from "@/brain/store"
import * as ModelIntel from "@/orchestrator/index"

import { AtlasRouter } from "@/router/index"
import { runRoutedCompletion } from "@/orchestrator/model-intelligence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer, raw } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// SUPER++ 010.4F — the three model-backed intelligence paths driven through
// the PRODUCTION routing/execution entry points:
//
//   Orchestrator.chat → deterministic classifier → ambiguous gate
//     → AtlasRouter.decide (real scoring/filtering over live candidates)
//     → scratch session carrying ONLY the routed provider/model identity
//     → the same SessionPrompt execution entry every normal turn uses
//
// The leaf LLM/LocalAI/Provider nodes are deterministic fakes so tests run
// without network access; everything above them is the unmodified runtime.
// Execution-boundary invocations are counted directly at the prompt boundary
// so local-only / no-model assertions are observable facts.

let executedModelCalls = 0

const emptyState = () => ({
  hardware: {
    os: { platform: "test", arch: "test" },
    cpu: {},
    memory: { totalBytes: 8 },
    gpus: [],
  },
  runtimes: [],
  installed: {} as Record<string, never[]>,
  recommendations: [],
  benchmarks: {} as Record<string, Record<string, never>>,
  readiness: {} as Record<string, Record<string, never>>,
  preference: "auto" as const,
  normalized: [],
})

const localAIMock = Layer.mock(LocalAI.Service, {
  state: () => Effect.succeed(emptyState() as never),
})


const scriptedReplies: string[] = []

const fakePrompt = Layer.mock(SessionPrompt.Service, {
  prompt: () => {
    executedModelCalls += 1
    const reply = scriptedReplies.shift() ?? "{}"
    return Effect.succeed({ parts: [{ type: "text", text: reply }] } as never)
  },
})

const fakeGit = Layer.mock(Git.Service, {
  hasHead: () => Effect.succeed(false),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, AtlasRouter.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
    [
      [SessionPrompt.node, fakePrompt],
      [Git.node, fakeGit],
      [LocalAI.node, localAIMock],
    ],
  ),
)

const modelCalls = () => executedModelCalls

function getBrainCount(projectID: string) {
  return Effect.map(Effect.promise(() => loadBrainStoreSafe(projectID)), (brain) => brain.memories.length)
}



// ---- PROOF HARNESS ---------------------------------------------------------
// Real session/prompt/provider stack with a deterministic fake HTTP LLM
// endpoint (TestLLMServer). Nothing above the network boundary is mocked.

import { withTmpdirInstance } from "../fixture/fixture"

type LocalMode = { local: boolean }

function emptyLocalState() {
  return {
    hardware: { os: { platform: "test", arch: "test" }, cpu: {}, memory: { totalBytes: 8 }, gpus: [] },
    runtimes: [],
    installed: {} as Record<string, never[]>,
    recommendations: [],
    benchmarks: {} as Record<string, Record<string, never>>,
    readiness: {} as Record<string, Record<string, never>>,
    preference: "auto" as const,
    normalized: [],
  }
}

function installedLocalState() {
  return {
    hardware: { os: { platform: "test", arch: "test" }, cpu: {}, memory: { totalBytes: 8 }, gpus: [] },
    runtimes: [{ id: "ollama", name: "Ollama", available: true, health: { state: "available" } }],
    installed: { ollama: [{ id: "local-dense", toolCalling: true }] },
    benchmarks: {},
    readiness: { ollama: { "local-dense": { score: 80 } } },
    recommendations: [],
    preference: "auto" as const,
    normalized: [],
  }
}

const e2eGit = Layer.mock(Git.Service, {
  hasHead: () => Effect.succeed(false),
})

function buildE2EGraph(local: boolean) {
  const localAI =
    local === false
      ? Layer.mock(LocalAI.Service, { state: () => Effect.succeed(emptyLocalState() as never) })
      : Layer.mock(LocalAI.Service, { state: () => Effect.succeed(installedLocalState() as never) })
  return AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, AtlasRouter.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
    [
      [Git.node, e2eGit],
      [LocalAI.node, localAI],
    ],
  )
}

function cloudInstanceConfig(llmUrl: string) {
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

function localInstanceConfig(llmUrl: string) {
  const base = cloudInstanceConfig(llmUrl)
  return {
    ...base,
    enabled_providers: ["ollama"],
    model: "ollama/local-dense",
    provider: {
      ...(base as { provider?: Record<string, unknown> }).provider,
      ollama: {
        name: "Ollama",
        id: "ollama",
        env: ["OLLAMA_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "local-dense": {
            id: "local-dense",
            name: "Local Dense",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 32_000, output: 4_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "local-key", baseURL: llmUrl },
      },
    },
  }
}

function denseWorkerText(): string {
  return [
    "Implemented the passkey registration endpoint end to end.",
    "Added credential schema and storage bindings for WebAuthn attestation objects.",
    "Extended auth architecture with a dedicated verification boundary in src/auth.",
    "Ran the integration suite locally; every acceptance criterion passes.",
    "Follow-ups: register device metadata table and add rate limiting middleware.",
  ].join(" ")
}


function e2eEnv(local: boolean) {
  return buildE2EGraph(local).pipe(Layer.provideMerge(NodeServices.layer as never))
}


const DISTILLER_MARKER = "Distill this worker result"
const CLASSIFIER_MARKER = "Classify this project message"
const REPLANNER_MARKER = "Propose a roadmap ChangeSet"


const e2eTimeoutMs = 180_000

function distillerReply(sourceID: string, title = "Passkey boundary decided", content = "Auth architecture routed through a dedicated verification boundary.") {
  return {
    items: [{ kind: "lesson", title, content, sourceID, sourceKind: "task" }],
  }
}

type HitLike = { body: Record<string, unknown> }

function countHits(hits: readonly HitLike[], opts: { marker?: string; model?: string }) {
  let count = 0
  for (const hit of hits) {
    const rawBody = JSON.stringify(hit.body)
    if (rawBody.includes("Generate a title for this conversation")) continue
    if (opts.model && !rawBody.includes('"' + opts.model + '"')) continue
    if (opts.marker && !rawBody.includes(opts.marker)) continue
    count += 1
  }
  return count
}


const itUnit = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, AtlasRouter.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
    [
      [SessionPrompt.node, fakePrompt],
      [Git.node, fakeGit],
      [LocalAI.node, localAIMock],
    ],
  ),
)

function localAIMockFor(local: boolean) {
  return local
    ? Layer.mock(LocalAI.Service, { state: () => Effect.succeed(installedLocalState() as never) })
    : Layer.mock(LocalAI.Service, { state: () => Effect.succeed(emptyLocalState() as never) })
}

describe("model-backed intelligence paths", () => {
  itUnit.instance("invalid classifier output is rejected; deterministic fallback preserved", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "classifier bad enum", description: "", acceptanceCriteria: ["a"] })
      yield* orch.plan(objective.projectID)

      scriptedReplies.length = 0
      scriptedReplies.push(JSON.stringify({ intent: "make_it_so", confidence: 0.9, reasonCode: "bad_enum" }))

      const res = yield* orch.chat({
        projectID: objective.projectID,
        text: "team feels uneasy about overall pacing and ownership lately",
      })

      expect(res.intent).toBe("question") // deterministic fallback
      expect(res.reason.startsWith("default to Q&A")).toBe(true)
      expect((yield* orch.get(objective.projectID))?.instructions ?? []).toEqual([])
    }),
  )

  itUnit.instance("ambiguous message classifies to instruction through the routed classifier", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "classifier works", description: "", acceptanceCriteria: ["a"] })
      yield* orch.plan(objective.projectID)

      scriptedReplies.length = 0
      scriptedReplies.push(JSON.stringify({ intent: "instruction", confidence: 0.9, reasonCode: "wants_test_split" }))
      const before = modelCalls()

      const res = yield* orch.chat({
        projectID: objective.projectID,
        text: "current testing approach feels underwhelming around here",
      })
      expect(res.intent).toBe("instruction")
      expect(modelCalls()).toBe(before + 1)
      expect((yield* orch.get(objective.projectID))?.instructions?.[0]?.status).toBe("queued")
    }),
  )

  itUnit.instance("unknown task references in model classification are rejected outright", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "classifier refs", description: "", acceptanceCriteria: ["a"] })
      yield* orch.plan(objective.projectID)

      scriptedReplies.length = 0
      scriptedReplies.push(
        JSON.stringify({ intent: "instruction", confidence: 0.9, reasonCode: "ref", referencedTaskIDs: ["task-does-not-exist"] }),
      )
      const before = modelCalls()

      const res = yield* orch.chat({
        projectID: objective.projectID,
        text: "we should probably rethink testing entirely",
      })
      expect(res.intent).toBe("question")
      expect(modelCalls()).toBe(before + 1)
      expect((yield* orch.get(objective.projectID))?.instructions ?? []).toEqual([])
    }),
  )

  itUnit.instance(
    "complex architecture instruction runs the model replanner with bounded repairs; validator stays authoritative",
    () =>
      Effect.gen(function* () {
        const orch = yield* Orchestrator.Service
        const objective = yield* orch.createProject({
          title: "replanner",
          description: "",
          acceptanceCriteria: ["first", "second"],
        })
        const projectID = objective.projectID
        yield* orch.plan(projectID)
        const beforeVersion = (yield* orch.get(projectID))!.roadmap.version
        const revisionsBefore = Object.fromEntries(
          ((yield* orch.get(projectID))!.roadmap.tasks).map((task) => [task.id, task.revision]),
        )
        const beforeCalls = modelCalls()

        scriptedReplies.length = 0
        const passkeyTask = {
          id: "model-added",
          title: "Passkeys",
          description: "",
          status: "planned",
          dependencies: [],
          acceptanceCriteria: ["passkey login supported"],
          priority: 5,
          parallelizable: true,
          attempt: 0,
          maxAttempts: 2,
          revision: 1,
        }
        scriptedReplies.push(
          JSON.stringify({ operations: [{ op: "reprioritize_task", taskID: "does-not-exist", priority: 1 }], rationale: "v1" }),
        )
        scriptedReplies.push(JSON.stringify({ operations: [{ op: "add_task", task: passkeyTask }], rationale: "v2" }))

        const res = yield* orch.chat({
          projectID,
          text: "change the auth architecture to passkeys but keep legacy login working",
        })
        expect(res.intent).toBe("instruction")
        expect(res.instructionStatus).toBe("applied")
        expect(res.replannerApplied).toBe(true)
        expect(res.replannerAttempts).toBe(2)
        expect(modelCalls()).toBe(beforeCalls + 2)

        const after = (yield* orch.get(projectID))!
        expect(after.roadmap.version).toBe(beforeVersion + 1)
        expect(after.roadmap.tasks.find((task) => task.id === "model-added")).toBeTruthy()
        for (const task of after.roadmap.tasks) {
          if (task.id in revisionsBefore && task.id !== "research") {
            expect(task.revision).toBe(revisionsBefore[task.id])
          }
        }
        expect((after.instructions ?? []).some((i) => i.status === "applied")).toBe(true)
      }),
  )

  itUnit.instance(
    "invalid proposals exhaust bounded repairs safely; simple deterministic edits never invoke a model",
    () =>
      Effect.gen(function* () {
        const orch = yield* Orchestrator.Service
        const objective = yield* orch.createProject({
          title: "repair bounds",
          description: "",
          acceptanceCriteria: ["first", "second"],
        })
        const projectID = objective.projectID
        yield* orch.plan(projectID)
        const beforeVersion = (yield* orch.get(projectID))!.roadmap.version
        const beforeCalls = modelCalls()

        scriptedReplies.length = 0
        const staleProposal = JSON.stringify({
          operations: [{ op: "add_dependency", taskID: "impl-1", dependsOn: "final-verify-not-real" }],
          rationale: "bad",
        })
        scriptedReplies.push(staleProposal, staleProposal, staleProposal)

        const res = yield* orch.chat({
          projectID,
          text: "change persistence strategy across the architecture without breaking current api contracts",
        })
        expect(res.intent).toBe("instruction")
        expect(res.replannerApplied).toBe(false)
        expect((yield* orch.get(projectID))!.roadmap.version).toBe(beforeVersion)
        expect(res.replannerAttempts).toBe(3)
        expect(modelCalls()).toBe(beforeCalls + 3)

        const callsAt = modelCalls()
        const simpleRes = yield* orch.chat({ projectID, text: "make tests highest priority" })
        expect(simpleRes.intent).toBe("instruction")
        expect(simpleRes.instructionStatus).toBe("queued")
        expect(simpleRes.replannerApplied).toBeUndefined()
        expect(modelCalls()).toBe(callsAt)
      }),
  )

  itUnit.instance("cancelled project aborts intelligence without consulting any model", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "cancelled", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)
      yield* orch.cancel(projectID)

      scriptedReplies.length = 0
      scriptedReplies.push(JSON.stringify({ intent: "instruction", confidence: 0.9, reasonCode: "x" }))
      const before = modelCalls()

      const res = yield* orch.chat({
        projectID,
        text: "something feels generally off with our approach",
      })
      expect(res.intent).toBe("question")
      expect(modelCalls()).toBe(before)
    }),
  )

  itUnit.instance("local_only privacy: ambiguous escalation sees zero cloud candidates and falls back", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({
        title: "local only",
        description: "",
        acceptanceCriteria: ["a"],
      })
      const projectID = objective.projectID
      const file0 = (yield* Effect.promise(() => loadProject(projectID)))!
      file0.privacy = "local_only"
      yield* Effect.promise(() => saveProjectStrict(projectID, file0))

      scriptedReplies.length = 0
      const before = modelCalls()

      const res = yield* orch.chat({
        projectID,
        text: "overall direction feels vague lately",
      })

      expect(res.intent).toBe("question")
      expect(modelCalls()).toBe(before)
    }),
  )
})

describe("model intelligence production proofs", () => {
  test(
    "E2E: real worker execution fires routed worker_distiller and persists derived memory",
    async () => {
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service
          const sessions = yield* Session.Service

          const originalWorkerThreshold = ModelIntel.intelligenceThresholds.workerMinChars
          ModelIntel.intelligenceThresholds.workerMinChars = 30

          try {
            const objective = yield* orch.createProject({
              title: "worker distiller e2e",
              description: "",
              acceptanceCriteria: ["only-one"],
            })
            const projectID = objective.projectID
            yield* orch.plan(projectID)
            const rootSessionID = (yield* orch.get(projectID))!.sessionID!

            // Queue the routed distiller reply FIRST so the distiller scratch
            // turn never steals a worker FIFO reply.
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(DISTILLER_MARKER),
              JSON.stringify(distillerReply("research")),
            )
            for (let i = 0; i < 5; i++) {
              yield* llm.text(denseWorkerText())
            }

            yield* orch.start(projectID)

            let distilledSeen = false
            for (let attempt = 0; attempt < 150; attempt++) {
              const brain = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
              if (brain.memories.some((m) => m.tags?.includes("model_distilled") === true)) {
                distilledSeen = true
                break
              }
              yield* Effect.sleep("200 millis")
            }
            expect(distilledSeen).toBe(true)

            const brain = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
            const distilled = brain.memories.find((m) => m.title === "Passkey boundary decided")
            expect(distilled!.authority).toBe("derived")
            expect(distilled!.provenance[0]?.id).toBe("research")

            const children = yield* sessions.children(rootSessionID as never).pipe(Effect.orElseSucceed(() => []))
            expect(children.length).toBeGreaterThanOrEqual(1)
            for (const child of children) expect(child.id).not.toBe(rootSessionID)

            const hits = yield* llm.hits
            expect(countHits(hits, { marker: DISTILLER_MARKER, model: "test-model" })).toBeGreaterThanOrEqual(1)

            // Restart persistence: re-reading the file-backed brain keeps it.
            const reloaded = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
            expect(reloaded.memories.some((m) => m.title === "Passkey boundary decided")).toBe(true)
          } finally {
            ModelIntel.intelligenceThresholds.workerMinChars = originalWorkerThreshold
          }
        }).pipe(
          withTmpdirInstance({ git: false, config: cloudInstanceConfig(llm.url) }),
          Effect.provide(buildE2EGraph(false)),
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
    "E2E local_only: classifier + replanner + worker-distiller all execute on LOCAL model with zero cloud calls",
    async () => {
      const program = Effect.gen(function* () {
        const llm = yield* TestLLMServer
        yield* Effect.gen(function* () {
          const orch = yield* Orchestrator.Service

          const originalWorker = ModelIntel.intelligenceThresholds.workerMinChars
          ModelIntel.intelligenceThresholds.workerMinChars = 30

          try {
            const objective = yield* orch.createProject({
              title: "local only flows",
              description: "",
              acceptanceCriteria: ["first", "second"],
            })
            const projectID = objective.projectID
            {
              const file0 = (yield* Effect.promise(() => loadProject(projectID)))!
              file0.privacy = "local_only"
              yield* Effect.promise(() => saveProjectStrict(projectID, file0))
            }
            yield* orch.plan(projectID)

            // A) ambiguous — LOCAL classifier
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(CLASSIFIER_MARKER),
              JSON.stringify({ intent: "instruction", confidence: 0.9, reasonCode: "local_wants" }),
            )
            const resA = yield* orch.chat({ projectID, text: "overall quality approach feels under-specified here" })
            expect(resA.intent).toBe("instruction")

            // B) complex instruction — LOCAL replanner (invalid then valid)
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(REPLANNER_MARKER) && JSON.stringify(hit.body).includes("does-not-exist"),
              replannerInvalid(),
            )
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(REPLANNER_MARKER) && !JSON.stringify(hit.body).includes("does-not-exist"),
              replannerValid(),
            )
            const resB = yield* orch.chat({
              projectID,
              text: "change the auth architecture to passkeys but keep legacy login working",
            })
            expect(resB.replannerApplied).toBe(true)

            // C) workers run locally; dense results fire the LOCAL distiller.
            yield* llm.textMatch(
              (hit: HitLike) => JSON.stringify(hit.body).includes(DISTILLER_MARKER),
              JSON.stringify(distillerReply("research", "Local auth lesson", "Routed through dedicated verification boundary.")),
            )
            for (let i = 0; i < 6; i++) {
              yield* llm.textMatch(
                (hit: HitLike) =>
                  JSON.stringify(hit.body).includes("# Task:") &&
                  !JSON.stringify(hit.body).includes(DISTILLER_MARKER),
                denseWorkerText(),
              )
            }
            yield* orch.start(projectID)

            let distilledSeen = false
            for (let attempt = 0; attempt < 150; attempt++) {
              const brain = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
              if (brain.memories.some((m) => m.title === "Local auth lesson")) {
                distilledSeen = true
                break
              }
              yield* Effect.sleep("200 millis")
            }
            expect(distilledSeen).toBe(true)

            const hits = yield* llm.hits
            expect(countHits(hits, { model: "test-model" })).toBe(0)
            expect(countHits(hits, { marker: CLASSIFIER_MARKER, model: "local-dense" })).toBeGreaterThanOrEqual(1)
            expect(countHits(hits, { marker: REPLANNER_MARKER, model: "local-dense" })).toBeGreaterThanOrEqual(1)
            expect(countHits(hits, { marker: DISTILLER_MARKER, model: "local-dense" })).toBeGreaterThanOrEqual(1)

            const brainFinal = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
            expect(brainFinal.memories.find((m) => m.title === "Local auth lesson")?.authority).toBe("derived")
          } finally {
            ModelIntel.intelligenceThresholds.workerMinChars = originalWorker
          }
        }).pipe(
          withTmpdirInstance({ git: false, config: localInstanceConfig(llm.url) }),
          Effect.provide(buildE2EGraph(true)),
          Effect.provide(NodeServices.layer),
          Effect.provide(TestLLMServer.layer),
          Effect.scoped,
        )
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)
      await Effect.runPromise(program as never, { signal: AbortSignal.timeout(180_000) })
    },
    180_000,
  )

  function replannerInvalid(): string {
    return JSON.stringify({ operations: [{ op: "reprioritize_task", taskID: "does-not-exist", priority: 1 }], rationale: "v1" })
  }

  function replannerValid(): string {
    return JSON.stringify({
      operations: [
        {
          op: "add_task",
          task: {
            id: "model-added",
            title: "Passkeys",
            description: "",
            status: "planned",
            dependencies: [],
            acceptanceCriteria: ["passkey login supported"],
            priority: 5,
            parallelizable: true,
            attempt: 0,
            maxAttempts: 2,
            revision: 1,
          },
        },
      ],
      rationale: "v2",
    })
  }
})
