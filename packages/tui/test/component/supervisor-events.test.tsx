/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { JSX } from "solid-js"
import { createSignal, onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { useEvent } from "../../src/context/event"
import { KVProvider } from "../../src/context/kv"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource } from "../fixture/tui-sdk"

function Harness(props: { events?: ReturnType<typeof createEventSource>["source"]; children: JSX.Element }) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createTuiResolvedConfig()
  onCleanup(registerOpencodeKeymap(keymap, renderer, { keybinds: config.keybinds, leader_timeout: config.leader_timeout }))
  return (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory="/tmp/opencode/packages/tui" events={props.events}>
        <RouteProvider>
          <TuiConfigProvider config={config}>
            <OpencodeKeymapProvider keymap={keymap}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ClipboardProvider>
                    <ToastProvider>
                      <DialogProvider>{props.children}</DialogProvider>
                    </ToastProvider>
                  </ClipboardProvider>
                </ThemeProvider>
              </KVProvider>
            </OpencodeKeymapProvider>
          </TuiConfigProvider>
        </RouteProvider>
      </SDKProvider>
    </TestTuiContexts>
  )
}

// Minimal MissionControl probe that mirrors DialogLocalAi supervisor logic
function SupervisorProbe(props: { projectID: string; onReady?: (api: { health: () => string; incidents: () => any[] }) => void }) {
  const event = useEvent()
  const [health, setHealth] = createSignal("healthy")
  const [incidents, setIncidents] = createSignal<any[]>([])

  onMount(() => {
    const disposers = [
      event.on("atlas.supervisor.health.changed", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setHealth(payload.properties.health)
      }),
      event.on("atlas.supervisor.incident.opened", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setIncidents((prev) => [
          ...prev,
          {
            id: payload.properties.incidentID,
            kind: payload.properties.kind,
            status: payload.properties.status,
            severity: payload.properties.severity,
          },
        ])
      }),
      event.on("atlas.supervisor.incident.classified", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setIncidents((prev) => prev.map((inc) => (inc.id === payload.properties.incidentID ? { ...inc, kind: payload.properties.kind } : inc)))
      }),
      event.on("atlas.supervisor.recovery.started", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setIncidents((prev) =>
          prev.map((inc) => (inc.id === payload.properties.incidentID ? { ...inc, status: "recovering", detail: payload.properties.action } : inc)),
        )
      }),
      event.on("atlas.supervisor.recovery.completed", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setIncidents((prev) => prev.map((inc) => (inc.id === payload.properties.incidentID ? { ...inc, status: "resolved" } : inc)))
      }),
      event.on("atlas.supervisor.recovery.failed", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setIncidents((prev) => prev.map((inc) => (inc.id === payload.properties.incidentID ? { ...inc, status: "escalated" } : inc)))
      }),
    ]
    onCleanup(() => disposers.forEach((d) => d()))
    props.onReady?.({ health, incidents })
  })

  return <text>{health()} {incidents().map((i) => `${i.kind}:${i.status}`).join(",")}</text>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("Mission Control receives incident.opened live", async () => {
  const events = createEventSource()
  let api!: { health: () => string; incidents: () => any[] }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.incidents().some((i) => i.id === "inc1" && i.kind === "test_failure")).toBe(true)
  app.renderer.destroy()
})

test("Mission Control receives recovery.started live", async () => {
  const events = createEventSource()
  let api!: { incidents: () => any[] }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt2",
      type: "atlas.supervisor.recovery.started",
      properties: { projectID: "proj-1", incidentID: "inc1", action: "retry_same_worker", attempt: 1 },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.incidents().find((i) => i.id === "inc1")?.status).toBe("recovering")
  app.renderer.destroy()
})

test("Mission Control receives recovery.completed live", async () => {
  const events = createEventSource()
  let api!: { incidents: () => any[] }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt2",
      type: "atlas.supervisor.recovery.started",
      properties: { projectID: "proj-1", incidentID: "inc1", action: "retry_same_worker", attempt: 1 },
    } as GlobalEvent["payload"],
  })
  await sleep(30)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt3",
      type: "atlas.supervisor.recovery.completed",
      properties: { projectID: "proj-1", incidentID: "inc1", action: "retry_same_worker", attempt: 1 },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.incidents().find((i) => i.id === "inc1")?.status).toBe("resolved")
  app.renderer.destroy()
})

test("Mission Control receives recovery.failed live", async () => {
  const events = createEventSource()
  let api!: { incidents: () => any[] }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "build_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt2",
      type: "atlas.supervisor.recovery.started",
      properties: { projectID: "proj-1", incidentID: "inc1", action: "retry_same_worker", attempt: 2 },
    } as GlobalEvent["payload"],
  })
  await sleep(30)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt3",
      type: "atlas.supervisor.recovery.failed",
      properties: { projectID: "proj-1", incidentID: "inc1", action: "retry_same_worker", attempt: 2, reason: "exhausted" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.incidents().find((i) => i.id === "inc1")?.status).toBe("escalated")
  app.renderer.destroy()
})

test("health header reacts to health.changed", async () => {
  const events = createEventSource()
  let api!: { health: () => string }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.health.changed",
      properties: { projectID: "proj-1", health: "degraded", previousHealth: "healthy" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.health()).toBe("degraded")
  app.renderer.destroy()
})

test("listener cleanup: closing Mission Control unsubscribes", async () => {
  const events = createEventSource()
  let api!: { incidents: () => any[] }
  let count = 0
  function CountingProbe(props: { projectID: string }) {
    const event = useEvent()
    onMount(() => {
      const d = event.on("atlas.supervisor.incident.opened", () => count++)
      onCleanup(d)
    })
    return <text />
  }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <CountingProbe projectID="proj-1" />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(count).toBe(1)
  app.renderer.destroy()
  // After destroy, further events should not increment
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt2",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc2", kind: "build_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(count).toBe(1)
})

test("project isolation: events from Project A do not update Project B view", async () => {
  const events = createEventSource()
  let apiA!: { incidents: () => any[] }
  let apiB!: { incidents: () => any[] }
  const app = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-A" onReady={(a) => (apiA = a as any)} />
      <SupervisorProbe projectID="proj-B" onReady={(a) => (apiB = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-A", incidentID: "incA", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(apiA.incidents().length).toBe(1)
  expect(apiB.incidents().length).toBe(0)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt2",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-B", incidentID: "incB", kind: "build_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(apiA.incidents().length).toBe(1)
  expect(apiB.incidents().length).toBe(1)
  app.renderer.destroy()
})

test("one event causes one visible update (no duplication on reopen)", async () => {
  const events = createEventSource()
  let api!: { incidents: () => any[] }
  const app1 = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  app1.renderer.destroy()
  // Reopen (simulate closing and reopening Mission Control)
  const app2 = await testRender(() => (
    <Harness events={events.source}>
      <SupervisorProbe projectID="proj-1" onReady={(a) => (api = a as any)} />
    </Harness>
  ))
  await sleep(150)
  events.emit({
    directory: "/tmp/opencode/packages/tui",
    workspace: undefined,
    payload: {
      id: "evt1",
      type: "atlas.supervisor.incident.opened",
      properties: { projectID: "proj-1", incidentID: "inc1", kind: "test_failure", severity: "error", status: "open" },
    } as GlobalEvent["payload"],
  })
  await sleep(50)
  expect(api.incidents().length).toBe(1)
  app2.renderer.destroy()
})
