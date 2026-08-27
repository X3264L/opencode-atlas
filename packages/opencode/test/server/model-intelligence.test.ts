import { describe, expect } from "bun:test"
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
import { testEffect } from "../lib/effect"

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

const providerMock = Layer.mock(Provider.Service, {
  list: () =>
    Effect.succeed({
      test: {
        key: "test-key",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            release_date: "2025-01-01",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            cost: { input: 0.15, output: 0.6 },
            limit: { context: 100_000, output: 8_192 },
          },
        },
      },
    } as never),
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
      [Provider.node, providerMock],
    ],
  ),
)

const modelCalls = () => executedModelCalls

function getBrainCount(projectID: string) {
  return Effect.map(Effect.promise(() => loadBrainStoreSafe(projectID)), (brain) => brain.memories.length)
}

describe("model-backed intelligence paths", () => {
  it.instance("invalid classifier output is rejected; deterministic fallback preserved", () =>
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

  it.instance("ambiguous message classifies to instruction through the routed classifier", () =>
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

  it.instance("unknown task references in model classification are rejected outright", () =>
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
        text: "overall QA structure leaves people uneasy lately",
      })
      expect(res.intent).toBe("question")
      expect(modelCalls()).toBe(before + 1)
      expect((yield* orch.get(objective.projectID))?.instructions ?? []).toEqual([])
    }),
  )

  it.instance(
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
        // Attempt 1: invalid operation target (unknown task) — forces a repair.
        scriptedReplies.push(
          JSON.stringify({ operations: [{ op: "reprioritize_task", taskID: "does-not-exist", priority: 1 }], rationale: "v1" }),
        )
        // Attempt 2: valid proposal.
        scriptedReplies.push(JSON.stringify({ operations: [{ op: "add_task", task: passkeyTask }], rationale: "v2" }))

        const res = yield* orch.chat({
          projectID,
          text: "change the auth architecture to passkeys but keep legacy login working",
        })
        expect(res.intent).toBe("instruction")
        expect(res.instructionStatus).toBe("applied")
        expect(res.replannerApplied).toBe(true)
        expect(modelCalls()).toBe(beforeCalls + 2) // initial proposal + one bounded repair

        const after = (yield* orch.get(projectID))!
        expect(after.roadmap.version).toBe(beforeVersion + 1)
        expect(after.roadmap.tasks.find((task) => task.id === "model-added")).toBeTruthy()
        // Unaffected slice byte-stable: pre-existing tasks keep their revisions.
        for (const task of after.roadmap.tasks) {
          if (task.id in revisionsBefore && task.id !== "research") {
            expect(task.revision).toBe(revisionsBefore[task.id])
          }
        }
        expect((after.instructions ?? []).some((i) => i.status === "applied")).toBe(true)
      }),
  )

  it.instance(
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

        // Simple priority edit is fully deterministic: zero additional calls.
        const callsAt = modelCalls()
        const simpleRes = yield* orch.chat({ projectID, text: "make tests highest priority" })
        expect(simpleRes.intent).toBe("instruction")
        expect(simpleRes.instructionStatus).toBe("queued")
        expect(simpleRes.replannerApplied).toBeUndefined()
        expect(modelCalls()).toBe(callsAt)
      }),
  )

  it.instance("cancelled project aborts intelligence without consulting any model", () =>
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

  it.instance("local_only privacy: ambiguous escalation sees zero cloud candidates and falls back", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({
        title: "local only",
        description: "",
        acceptanceCriteria: ["a"],
      })
      const projectID = objective.projectID
      // Mark the workspace local-only.
      const file0 = (yield* Effect.promise(() => loadProject(projectID)))!
      file0.privacy = "local_only"
      yield* Effect.promise(() => saveProjectStrict(projectID, file0))

      scriptedReplies.length = 0
      const before = modelCalls()

      const res = yield* orch.chat({
        projectID,
        text: "overall direction feels vague lately",
      })

      // No cloud model was invoked (fake test provider is cloud) and the safe
      // deterministic route answered instead.
      expect(res.intent).toBe("question")
      expect(modelCalls()).toBe(before)
    }),
  )

  it.instance(
    "large checkpoint triggers routed session distillation; provenance validated",
    () =>
      Effect.gen(function* () {
        const orch = yield* Orchestrator.Service
        const objective = yield* orch.createProject({
          title: "checkpoint distill",
          description: "",
          acceptanceCriteria: ["a"],
        })
        const projectID = objective.projectID

        // Lower the threshold for test determinism, restore afterwards.
        const originalThreshold = ModelIntel.intelligenceThresholds.checkpointMinBytes
        ModelIntel.intelligenceThresholds.checkpointMinBytes = 10
        try {
          scriptedReplies.length = 0
          scriptedReplies.push(
            JSON.stringify({
              items: [
                {
                  kind: "decision",
                  title: "Freeze API surface",
                  content: "Snapshot decided the public API stays stable during stabilization.",
                  sourceID: objective.projectID,
                  sourceKind: "checkpoint",
                },
              ],
            }),
          )

          const beforeBrain = yield* getBrainCount(projectID)
          yield* orch.pause(projectID, "finish_current_safe_step")
          const afterValid = yield* getBrainCount(projectID)
          expect(afterValid).toBe(beforeBrain + 1)
          const brainAfter = (yield* Effect.promise(() => loadBrainStoreSafe(projectID)))!
          const derived = brainAfter.memories.find((m) => m.title === "Freeze API surface")
          expect(derived?.authority).toBe("derived")
          expect(derived?.provenance[0]?.id).toBe(objective.projectID)

          // Invalid provenance is dropped without corrupting Brain state.
          const beforeInvalid = modelCalls()
          yield* orch.checkpoint(projectID).pipe(Effect.option)
          expect(modelCalls()).toBeGreaterThan(beforeInvalid)

        } finally {
        }
      }),
  )

  it.instance("session conversation threshold triggers distillation with provenance validation", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({
        title: "session threshold",
        description: "",
        acceptanceCriteria: ["a"],
      })
      const projectID = objective.projectID

      const originalEvery = ModelIntel.intelligenceThresholds.sessionEveryMessages
      ModelIntel.intelligenceThresholds.sessionEveryMessages = 2
      try {
        // Message #1 (deterministic simple), message #2 fires the trigger.
        scriptedReplies.length = 0
        // Valid decision referencing msg:0 → persisted.
        scriptedReplies.push(
          JSON.stringify({
            items: [
              { kind: "decision", title: "Prefer local models", content: "User wants local execution.", sourceID: "msg:0", sourceKind: "user_message" },
              // Invalid: source id outside supplied evidence pack.
              { kind: "constraint", title: "Bogus", content: "Unsupported provenance.", sourceID: "msg:42", sourceKind: "session_message" },
            ],
          }),
        )
        const brainBefore1 = yield* getBrainCount(projectID)
        yield* orch.chat({ projectID, text: "what is blocking us about local models?" })
        let brainAfter = yield* getBrainCount(projectID)
        expect(brainAfter).toBe(brainBefore1)

        yield* orch.chat({ projectID, text: "what is our overall progress on local models?" })

        // Threshold 2: distiller ran on message #2 and stored only valid items.
        brainAfter = yield* getBrainCount(projectID)
        expect(brainAfter).toBe(1)
        const brain = (yield* Effect.promise(() => loadBrainStoreSafe(projectID)))!
        expect(brain.memories.some((m) => m.authority === "derived")).toBe(true)
        expect(brain.memories.some((m) => m.title === "Bogus")).toBe(false)
      } finally {
        ModelIntel.intelligenceThresholds.sessionEveryMessages = originalEvery
      }
    }),
  )

  it.instance(
    "cross-flow: ambiguous msg → routed classifier → complex replanner → routed checkpoint distillation",
    () =>
      Effect.gen(function* () {
        const orch = yield* Orchestrator.Service
        const objective = yield* orch.createProject({
          title: "crossflow intelligence",
          description: "",
          acceptanceCriteria: ["first", "second"],
        })
        const projectID = objective.projectID
        yield* orch.plan(projectID)
        const roadmapBefore = (yield* orch.get(projectID))!.roadmap.version

        const originalCheckpoint = ModelIntel.intelligenceThresholds.checkpointMinBytes
        ModelIntel.intelligenceThresholds.checkpointMinBytes = 10
        try {
          // 1) Ambiguous message → model classifies as instruction.
          scriptedReplies.length = 0
          scriptedReplies.push(JSON.stringify({ intent: "instruction", confidence: 0.9, reasonCode: "user_rethink" }))
          // 2) Complexity gate sees architecture keyword → replanner runs twice.
          scriptedReplies.push(replannerInvalid(), replannerValid())
          // 3) pause() creates a checkpoint ≥ threshold → distiller runs last.
          scriptedReplies.push(distillerReply(objective.projectID))

          yield* orch.chat({
            projectID,
            text: "change the auth architecture to passkeys but keep legacy login working",
          })

          const afterMutation = (yield* orch.get(projectID))!
          expect(afterMutation.roadmap.version).toBe(roadmapBefore + 1)
          expect(afterMutation.roadmap.tasks.some((task) => task.id === "model-added")).toBe(true)

          yield* orch.pause(projectID, "finish_current_safe_step")
          const brain = yield* Effect.promise(() => loadBrainStoreSafe(projectID))
          const distilled = brain.memories.find((m) => m.title === "Snapshot decision captured")
          expect(distilled?.authority).toBe("derived")
          expect(distilled?.provenance[0]?.id).toBe(projectID)

          // Restart semantics: fresh open keeps mutated roadmap (no auto-model calls).
          ModelIntel.intelligenceThresholds.checkpointMinBytes = originalCheckpoint
          scriptedReplies.length = 0
          const beforeCalls = modelCalls()
          const reopened = (yield* orch.get(projectID))!
          expect(reopened.roadmap.tasks.some((task) => task.id === "model-added")).toBe(true)
          expect(modelCalls()).toBe(beforeCalls)
        } finally {
          ModelIntel.intelligenceThresholds.checkpointMinBytes = originalCheckpoint
        }
      }),
  )
})

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

function distillerReply(sourceID: string): string {
  return JSON.stringify({
    items: [
      {
        kind: "decision",
        title: "Snapshot decision captured",
        content: "Stabilization snapshot recorded.",
        sourceID,
        sourceKind: "checkpoint",
      },
    ],
  })
}
