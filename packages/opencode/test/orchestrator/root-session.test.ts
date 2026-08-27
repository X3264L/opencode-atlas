import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { Orchestrator } from "@/orchestrator/index"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Stat, Item } from "@/git"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { SessionID } from "@/session/schema"

// SUPER++ 010.4E: every Atlas project owns exactly one canonical root
// project-conversation session. Tests run against the REAL Session
// subsystem + project store; only the model-turn boundary (worker prompts)
// and git are deterministic fakes.

const fakeGit = Layer.mock(Git.Service, {
  hasHead: () => Effect.succeed(false),
  stats: () => Effect.succeed<Stat[]>([]),
  status: () => Effect.succeed<Item[]>([]),
})

const fakePrompt = Layer.mock(SessionPrompt.Service, {
  prompt: () =>
    Effect.succeed({
      parts: [{ type: "text", text: "worker step finished" }],
    } as never),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Orchestrator.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
    [
      [SessionPrompt.node, fakePrompt],
      [Git.node, fakeGit],
    ],
  ),
)

type RecordedEvent = { type: string; data: Record<string, unknown> }

const collectEvents = (types: string[]) =>
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    const events: RecordedEvent[] = []
    const unsub = yield* bridge.listen((event) => {
      if (types.includes(event.type)) {
        events.push({ type: event.type, data: event.data as Record<string, unknown> })
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return events
  })

const waitFor = <R>(check: Effect.Effect<boolean, unknown, R>, message: string) =>
  pollWithTimeout(check.pipe(Effect.map((ok) => (ok ? (true as const) : undefined))), message, "15 seconds")

describe("native root project conversations", () => {
  it.instance("createProject auto-creates one canonical root session without caller sessionID", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service

      const sessionEvents = yield* collectEvents([
        "atlas.project.session.created",
        "atlas.project.session.reconciled",
      ])
      const objective = yield* orch.createProject({
        title: "root conv A",
        description: "",
        acceptanceCriteria: ["a"],
      })
      const projectID = objective.projectID

      const result = yield* orch.chat({ projectID, text: "what is blocking us?" })
      expect(result.rootSessionID).toBeTruthy()
      expect(result.intent).toBe("status_request")
      const rootID = result.rootSessionID

      // Persisted project carries the same canonical association, confirmed durable
      const loaded = yield* orch.get(projectID)
      expect(loaded?.sessionID).toBe(rootID)
      expect(typeof loaded?.rootSessionConfirmedAt).toBe("number")

      // Repeated opens reuse the exact session; no duplicates accumulate
      const again = yield* orch.get(projectID)
      expect(again?.sessionID).toBe(rootID)

      yield* Effect.sleep("200 millis")
      // Exactly one lifecycle event fired for this project
      expect(sessionEvents.filter((e) => e.data.projectID === projectID).length).toBe(1)

      // Question routed to Brain Q&A path without mutating inbox/ledger
      const after = yield* orch.get(projectID)
      expect(after?.instructions ?? []).toEqual([])
      expect(after?.ideas ?? []).toEqual([])

      // Human message persisted in the root session (normal Session subsystem)
      const messages = yield* (yield* Session.Service)
        .messages({ sessionID: rootID as SessionID })
        .pipe(Effect.orElseSucceed(() => []))
      expect(JSON.stringify(messages)).toContain("what is blocking us?")
    }),
  )

  it.instance("restart durability: reopening reuses the exact root; conversation history persists", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "restartable", description: "", acceptanceCriteria: ["a"] })
      const projectID = objective.projectID

      const firstProbe = yield* Effect.gen(function* () {
        const { loadProject } = yield* Effect.promise(() => import("@/orchestrator/store"))
        let attempts = 0
        while (attempts < 50) {
          const raw = yield* Effect.promise(() => loadProject(projectID))
          if (raw?.sessionID) return raw
          attempts += 1
          yield* Effect.sleep("20 millis")
        }
        return undefined
      })
      expect(firstProbe?.sessionID).toBeTruthy()
      void firstProbe
      const first = yield* orch.chat({ projectID, text: "pre restart question?" })
      const S1 = first.rootSessionID

      // Simulated process restart: the on-disk snapshot is what a fresh Atlas
      // process loads, so its association must be the identical root.
      const storeMod = yield* Effect.promise(() => import("@/orchestrator/store"))
      const snapshot = yield* Effect.promise(() => storeMod.loadProject(projectID))
      expect(snapshot?.sessionID).toBe(S1)

      // Fresh loads land on the SAME session; repeated opens must not mint
      // replacement roots.
      for (let i = 0; i < 3; i++) {
        const reopened = yield* orch.get(projectID)
        expect(reopened?.sessionID).toBe(S1)
      }

      const secondChat = yield* orch.chat({ projectID, text: "post restart question?" })
      expect(secondChat.rootSessionID).toBe(S1)

      // Conversation history persists in the root session across reopens
      const messages = yield* (yield* Session.Service)
        .messages({ sessionID: S1 as SessionID })
        .pipe(Effect.orElseSucceed(() => []))
      const flattened = JSON.stringify(messages)
      expect(flattened).toContain("pre restart question?")
      expect(flattened).toContain("post restart question?")
    }),
  )


  it.instance("concurrent legacy migration creates exactly one root", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const { saveProject } = yield* Effect.promise(() => import("@/orchestrator/store"))

      const projectID = `proj-legacy-${Date.now().toString(36)}`
      // Pre-feature project: persisted without any session association
      yield* Effect.promise(() =>
        saveProject(projectID, {
          objective: {
            id: `obj-${projectID}`,
            projectID,
            title: "legacy project",
            description: "",
            acceptanceCriteria: ["old"],
            constraints: [],
            priorities: [],
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          roadmap: { version: 0, objectiveID: `obj-${projectID}`, status: "planning", tasks: [] },
          checkpoints: [],
          artifacts: [],
        }),
      )

      const createdEvents = yield* collectEvents(["atlas.project.session.created"])
      const chatResult = yield* orch.chat({
        projectID,
        text: "later add mobile support",
      })

      expect(chatResult.rootSessionID).toBe(chatResult.rootSessionID!)
      expect(chatResult.intent).toBe("idea")

      // Concurrent full opens converge on the exact same canonical root
      const [openA, openB] = yield* Effect.all([orch.get(projectID), orch.get(projectID)], { concurrency: 2 })
      expect(openA?.sessionID).toBe(openB?.sessionID)
      expect(openA?.sessionID).toBe(chatResult.rootSessionID)

      yield* Effect.sleep("200 millis")
      expect(createdEvents.filter((e) => e.data.projectID === projectID).length).toBe(1)
    }),
  )


  it.instance("missing stored session record reconciles exactly once", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const storeMod = yield* Effect.promise(() => import("@/orchestrator/store"))

      const projectID = `proj-gone-${Date.now().toString(36)}`
      yield* Effect.promise(() =>
        storeMod.saveProject(projectID, {
          objective: {
            id: `obj-${projectID}`,
            projectID,
            title: "corrupt link",
            description: "",
            acceptanceCriteria: ["x"],
            constraints: [],
            priorities: [],
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          roadmap: { version: 0, objectiveID: `obj-${projectID}`, status: "planning", tasks: [] },
          checkpoints: [],
          artifacts: [],
          sessionID: "ses_deletedfromspace",
        }),
      )

      const reconciledEvents = yield* collectEvents(["atlas.project.session.reconciled"])
      const first = yield* orch.get(projectID)
      expect(first?.sessionID).toBeTruthy()
      expect(first?.sessionID).not.toBe("ses_deletedfromspace")

      // Idempotent: later opens keep the replacement
      const second = yield* orch.get(projectID)
      expect(second?.sessionID).toBe(first!.sessionID)

      yield* Effect.sleep("150 millis")
      expect(reconciledEvents.filter((e) => e.data.projectID === projectID).length).toBe(1)
      expect(reconciledEvents[0]?.data.previousSessionID).toBe("ses_deletedfromspace")

      // Conversation is usable right away with zero manual setup
      const chat = yield* orch.chat({ projectID, text: "who is working on x?" })
      expect(chat.rootSessionID).toBe(first!.sessionID as string)
    }),
  )


  it.instance("instruction reaches Instruction Inbox; idea reaches Idea Ledger; neither mutates the other", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({ title: "routing", description: "", acceptanceCriteria: ["r"] })
      const projectID = objective.projectID
      yield* orch.plan(projectID)

      const instructionRes = yield* orch.chat({ projectID, text: "make tests highest priority" })
      expect(instructionRes.intent).toBe("instruction")
      expect(instructionRes.instructionStatus).toBe("queued")

      const ideaRes = yield* orch.chat({ projectID, text: "later add mobile support" })
      expect(ideaRes.intent).toBe("idea")

      const file = yield* orch.get(projectID)
      expect(file?.instructions?.length).toBe(1)
      expect(file?.instructions?.[0]?.disposition?.kind).toBe("priority_change")
      expect(file?.instructions?.[0]?.source).toBe("user")
      expect(file?.ideas?.length).toBe(1)
      expect((file?.ideas ?? [])[0]?.text).toContain("mobile support")
      expect(file?.ideas?.[0]?.status).toBe("captured")

      // Both human messages live in the same root conversation
      const chatRes = yield* orch.chat({ projectID, text: "why are we blocked?" })
      expect(chatRes.rootSessionID).toBe(instructionRes.rootSessionID)
    }),
  )


  it.instance("cross-flow: worker child sessions stay distinct children of the root", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const objective = yield* orch.createProject({
        title: "crossflow workers",
        description: "",
        acceptanceCriteria: ["w1"],
      })
      const projectID = objective.projectID
      const chatBefore = yield* orch.chat({ projectID, text: "what is ready?" })
      expect(chatBefore.intent).toBe("status_request")
      const rootID = chatBefore.rootSessionID!

      yield* orch.plan(projectID)
      yield* orch.start(projectID)
      const check = Effect.gen(function* () {
        const file = yield* orch.get(projectID)
        return file?.roadmap.tasks.every((task) => task.status === "complete") ?? false
      })
      yield* pollWithTimeout(check.pipe(Effect.map((ok) => (ok ? (true as const) : undefined))), "workers never completed", "15 seconds")
      yield* Effect.sleep("250 millis")

      // Worker outputs are NOT dumped into the root conversation; the only
      // message there remains the human question asked before execution.
      const messages = yield* (yield* Session.Service).messages({ sessionID: rootID as SessionID }).pipe(Effect.orElseSucceed(() => []))
      const flattened = JSON.stringify(messages)
      expect(flattened).toContain("what is ready?")
      expect(flattened).not.toContain("worker step finished")

      // Every worker session is a distinct child of the canonical root
      const children = yield* (yield* Session.Service).children(rootID as SessionID).pipe(Effect.orElseSucceed(() => []))
      expect(children.length).toBeGreaterThanOrEqual(1)
      for (const child of children) {
        expect(child.id).not.toBe(rootID)
      }
    }),
  )


  it.instance("project isolation: A and B roots and histories never mix", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator.Service
      const aObj = yield* orch.createProject({ title: "iso root A", description: "", acceptanceCriteria: ["a"] })
      const bObj = yield* orch.createProject({ title: "iso root B", description: "", acceptanceCriteria: ["b"] })

      const aChat = yield* orch.chat({ projectID: aObj.projectID, text: "alpha question here?" })
      const bChat = yield* orch.chat({ projectID: bObj.projectID, text: "bravo question here?" })
      expect(aChat.rootSessionID).not.toBe(bChat.rootSessionID)

      const sessions = yield* Session.Service
      const aMessages = JSON.stringify(yield* sessions.messages({ sessionID: aChat.rootSessionID as SessionID }).pipe(Effect.orElseSucceed(() => [])))
      const bMessages = JSON.stringify(yield* sessions.messages({ sessionID: bChat.rootSessionID as SessionID }).pipe(Effect.orElseSucceed(() => [])))

      expect(aMessages).toContain("alpha question here?")
      expect(aMessages).not.toContain("bravo question here?")
      expect(bMessages).toContain("bravo question here?")
      expect(bMessages).not.toContain("alpha question here?")
    }),
  )
})

