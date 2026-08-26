import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Supervisor } from "@/supervisor/index"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Supervisor.node, EventV2Bridge.node])),
)

const collect = (types: string[]) =>
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    const events: { type: string; data: any }[] = []
    const unsub = yield* bridge.listen((event) => {
      if (types.includes(event.type)) events.push({ type: event.type, data: event.data })
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsub)
    return events
  })

describe("supervisor EventV2Bridge wiring", () => {
  it.live("incident creation emits incident.opened and health.changed", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect([
        "atlas.supervisor.incident.opened",
        "atlas.supervisor.health.changed",
      ])
      const incident = yield* supervisor.openIncident({ projectID: "proj-1", kind: "test_failure", severity: "error", taskID: "t1" })
      // allow publish microtasks
      yield* Effect.sleep(50)
      expect(events.some((e) => e.type === "atlas.supervisor.incident.opened" && e.data.incidentID === incident.id)).toBe(true)
      expect(events.some((e) => e.type === "atlas.supervisor.health.changed" && e.data.health === "degraded")).toBe(true)
    }),
  )

  it.live("classification emits incident.classified", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect(["atlas.supervisor.incident.classified"])
      const incident = yield* supervisor.openIncident({ projectID: "proj-1", kind: "unknown" })
      yield* Effect.sleep(20)
      events.length = 0
      yield* supervisor.classifyIncident({ projectID: "proj-1", incidentID: incident.id, kind: "build_failure" })
      yield* Effect.sleep(50)
      expect(events.some((e) => e.type === "atlas.supervisor.incident.classified" && e.data.kind === "build_failure")).toBe(true)
    }),
  )

  it.live("recovery start emits recovery.started and health recovering", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect(["atlas.supervisor.recovery.started", "atlas.supervisor.health.changed"])
      const incident = yield* supervisor.openIncident({ projectID: "proj-2", kind: "tool_failure" })
      yield* Effect.sleep(20)
      events.length = 0
      yield* supervisor.startRecovery({ projectID: "proj-2", incidentID: incident.id, action: "retry_same_worker", attempt: 1 })
      yield* Effect.sleep(50)
      expect(events.some((e) => e.type === "atlas.supervisor.recovery.started" && e.data.action === "retry_same_worker")).toBe(true)
      expect(events.some((e) => e.type === "atlas.supervisor.health.changed" && e.data.health === "recovering")).toBe(true)
    }),
  )

  it.live("successful recovery emits recovery.completed and restores health", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect(["atlas.supervisor.recovery.completed", "atlas.supervisor.health.changed"])
      const incident = yield* supervisor.openIncident({ projectID: "proj-3", kind: "test_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-3", incidentID: incident.id, action: "reassign_specialist", attempt: 1 })
      yield* Effect.sleep(20)
      events.length = 0
      yield* supervisor.completeRecovery({ projectID: "proj-3", incidentID: incident.id, action: "reassign_specialist", attempt: 1 })
      yield* Effect.sleep(50)
      expect(events.some((e) => e.type === "atlas.supervisor.recovery.completed")).toBe(true)
      expect(events.some((e) => e.type === "atlas.supervisor.health.changed" && e.data.health === "healthy")).toBe(true)
    }),
  )

  it.live("failed recovery emits recovery.failed and blocks health", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect(["atlas.supervisor.recovery.failed", "atlas.supervisor.health.changed"])
      const incident = yield* supervisor.openIncident({ projectID: "proj-4", kind: "build_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-4", incidentID: incident.id, action: "retry_same_worker", attempt: 2 })
      yield* Effect.sleep(20)
      events.length = 0
      yield* supervisor.failRecovery({ projectID: "proj-4", incidentID: incident.id, action: "retry_same_worker", attempt: 2, reason: "exhausted" })
      yield* Effect.sleep(50)
      expect(events.some((e) => e.type === "atlas.supervisor.recovery.failed" && e.data.reason === "exhausted")).toBe(true)
      expect(events.some((e) => e.type === "atlas.supervisor.health.changed" && e.data.health === "blocked")).toBe(true)
    }),
  )

  it.live("health transition emits health.changed", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events = yield* collect(["atlas.supervisor.health.changed"])
      yield* supervisor.setHealth("proj-health", "degraded")
      yield* Effect.sleep(50)
      expect(events.some((e) => e.data.health === "degraded")).toBe(true)
      events.length = 0
      // setting same health should not emit again
      yield* supervisor.setHealth("proj-health", "degraded")
      yield* Effect.sleep(50)
      expect(events.length).toBe(0)
    }),
  )

  it.live("events travel through EventV2Bridge and are typed in SDK", () =>
    Effect.gen(function* () {
      // Verify SDK generation includes all 6 types by checking runtime event types are known
      const supervisor = yield* Supervisor.Service
      const events = yield* collect([
        "atlas.supervisor.health.changed",
        "atlas.supervisor.incident.opened",
        "atlas.supervisor.incident.classified",
        "atlas.supervisor.recovery.started",
        "atlas.supervisor.recovery.completed",
        "atlas.supervisor.recovery.failed",
      ])
      const inc = yield* supervisor.openIncident({ projectID: "proj-sdk", kind: "unknown" })
      yield* supervisor.classifyIncident({ projectID: "proj-sdk", incidentID: inc.id, kind: "tool_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-sdk", incidentID: inc.id, action: "retry_same_worker", attempt: 1 })
      yield* supervisor.completeRecovery({ projectID: "proj-sdk", incidentID: inc.id, action: "retry_same_worker", attempt: 1 })
      // Need a second incident for failed path
      const inc2 = yield* supervisor.openIncident({ projectID: "proj-sdk2", kind: "build_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-sdk2", incidentID: inc2.id, action: "retry_same_worker", attempt: 1 })
      yield* supervisor.failRecovery({ projectID: "proj-sdk2", incidentID: inc2.id, action: "retry_same_worker", attempt: 1, reason: "test" })
      yield* Effect.sleep(50)
      const types = new Set(events.map((e) => e.type))
      expect(types.has("atlas.supervisor.health.changed")).toBe(true)
      expect(types.has("atlas.supervisor.incident.opened")).toBe(true)
      expect(types.has("atlas.supervisor.incident.classified")).toBe(true)
      expect(types.has("atlas.supervisor.recovery.started")).toBe(true)
      expect(types.has("atlas.supervisor.recovery.completed")).toBe(true)
      expect(types.has("atlas.supervisor.recovery.failed")).toBe(true)
    }),
  )

  it.live("representative recovery lifecycle ordering is coherent", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events: string[] = []
      const bridge = yield* EventV2Bridge.Service
      const unsub = yield* bridge.listen((event) => {
        if (event.type.startsWith("atlas.supervisor")) events.push(event.type)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const inc = yield* supervisor.openIncident({ projectID: "proj-order", kind: "test_failure" })
      yield* supervisor.classifyIncident({ projectID: "proj-order", incidentID: inc.id, kind: "test_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-order", incidentID: inc.id, action: "retry_same_worker", attempt: 1 })
      yield* supervisor.completeRecovery({ projectID: "proj-order", incidentID: inc.id, action: "retry_same_worker", attempt: 1 })
      yield* Effect.sleep(50)
      const openedIdx = events.indexOf("atlas.supervisor.incident.opened")
      const classifiedIdx = events.indexOf("atlas.supervisor.incident.classified")
      const startedIdx = events.indexOf("atlas.supervisor.recovery.started")
      const completedIdx = events.indexOf("atlas.supervisor.recovery.completed")
      expect(openedIdx).toBeGreaterThanOrEqual(0)
      expect(classifiedIdx).toBeGreaterThan(openedIdx)
      expect(startedIdx).toBeGreaterThan(classifiedIdx)
      expect(completedIdx).toBeGreaterThan(startedIdx)
    }),
  )

  it.live("alternate failed lifecycle ordering", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events: string[] = []
      const bridge = yield* EventV2Bridge.Service
      const unsub = yield* bridge.listen((event) => {
        if (event.type.startsWith("atlas.supervisor")) events.push(event.type)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const inc = yield* supervisor.openIncident({ projectID: "proj-order2", kind: "build_failure" })
      yield* supervisor.classifyIncident({ projectID: "proj-order2", incidentID: inc.id, kind: "build_failure" })
      yield* supervisor.startRecovery({ projectID: "proj-order2", incidentID: inc.id, action: "retry_same_worker", attempt: 2 })
      yield* supervisor.failRecovery({ projectID: "proj-order2", incidentID: inc.id, action: "retry_same_worker", attempt: 2 })
      yield* Effect.sleep(50)
      const startedIdx = events.indexOf("atlas.supervisor.recovery.started")
      const failedIdx = events.indexOf("atlas.supervisor.recovery.failed")
      expect(failedIdx).toBeGreaterThan(startedIdx)
    }),
  )

  it.live("project isolation: events from Project A do not update Project B view", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const eventsA: any[] = []
      const eventsB: any[] = []
      const bridge = yield* EventV2Bridge.Service
      const unsub = yield* bridge.listen((event) => {
        if (event.type === "atlas.supervisor.incident.opened") {
          if ((event.data as any).projectID === "proj-A") eventsA.push(event.data)
          if ((event.data as any).projectID === "proj-B") eventsB.push(event.data)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      yield* supervisor.openIncident({ projectID: "proj-A", kind: "test_failure" })
      yield* Effect.sleep(50)
      expect(eventsA.length).toBe(1)
      expect(eventsB.length).toBe(0)
      yield* supervisor.openIncident({ projectID: "proj-B", kind: "build_failure" })
      yield* Effect.sleep(50)
      expect(eventsA.length).toBe(1)
      expect(eventsB.length).toBe(1)
    }),
  )

  it.live("read-only supervisor API calls do NOT emit mutation events", () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.Service
      const events: any[] = []
      const bridge = yield* EventV2Bridge.Service
      const unsub = yield* bridge.listen((event) => {
        if (event.type.startsWith("atlas.supervisor")) events.push(event)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)
      const inc = yield* supervisor.openIncident({ projectID: "proj-read", kind: "unknown" })
      yield* Effect.sleep(50)
      events.length = 0
      // Read operations
      yield* supervisor.getHealth("proj-read")
      yield* supervisor.getIncidents("proj-read")
      yield* supervisor.getIncident("proj-read", inc.id)
      yield* Effect.sleep(50)
      expect(events.length).toBe(0)
    }),
  )
})
