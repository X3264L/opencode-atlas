/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../src/context/event"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, directory, json } from "../fixture/tui-sdk"

const useSdkHook = useSDK

// SUPER++ 010.4D Mission Control reactivity + action transport contracts.
// Event-driven behavior is exercised through the same reactive wiring the
// Local AI dialog installs; backend actions are exercised through the real
// generated SDK client so path/payload contracts cannot silently drift.

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

type Recorder = {
  status: () => string
  timeline: () => string[]
}

// Mirrors the exact event handlers installed by DialogLocalAi Mission Control
function ControlProbe(props: { projectID: string; onReady?: (api: Recorder) => void }) {
  const event = useEvent()
  const [status, setStatus] = createSignal("running")
  const [timeline, setTimeline] = createSignal<string[]>([])

  onMount(() => {
    const disposers = [
      event.on("atlas.project.checkpoint.created", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setTimeline((prev) => [...prev, `checkpoint:${payload.properties.checkpointID}`])
      }),
      event.on("atlas.project.paused", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setStatus(`paused:${payload.properties.mode}`)
      }),
      event.on("atlas.project.resumed", (payload) => {
        if (payload.properties.projectID !== props.projectID) return
        setStatus("running")
      }),
    ]
    onCleanup(() => disposers.forEach((dispose) => dispose()))
    props.onReady?.({ status, timeline })
  })

  return <text>{`${status()}|${timeline().join(",")}`}</text>
}

async function sleep(ms: number) {
  await Bun.sleep(ms)
}

test("checkpoint event appends to the visible timeline", async () => {
  const events = createEventSource()
  let api!: Recorder
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source}>
        <ControlProbe projectID="proj-1" onReady={(a) => (api = a)} />
      </SDKProvider>
    </TestTuiContexts>
  ))
  try {
    await sleep(120)
    expect(api.timeline()).toEqual([])
    events.emit(
      global({
        id: "evt1",
        type: "atlas.project.checkpoint.created",
        properties: { projectID: "proj-1", checkpointID: "chk-a1", timestamp: Date.now() },
      } as never),
    )
    await sleep(80)
    expect(api.timeline().join()).toContain("checkpoint:chk-a1")
  } finally {
    app.renderer.destroy()
  }
})

test("paused event reflects pause mode immediately; resumed event restores running", async () => {
  const events = createEventSource()
  let api!: Recorder
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source}>
        <ControlProbe projectID="proj-1" onReady={(a) => (api = a)} />
      </SDKProvider>
    </TestTuiContexts>
  ))
  try {
    await sleep(120)
    events.emit(
      global({
        id: "evt1",
        type: "atlas.project.paused",
        properties: { projectID: "proj-1", mode: "finish_current_safe_step", timestamp: Date.now() },
      } as never),
    )
    await sleep(80)
    expect(api.status()).toBe("paused:finish_current_safe_step")

    events.emit(global({ id: "evt2", type: "atlas.project.resumed", properties: { projectID: "proj-1", timestamp: Date.now() } }))
    await sleep(80)
    expect(api.status()).toBe("running")
  } finally {
    app.renderer.destroy()
  }
})

test("project isolation: A's control events do not update B's view", async () => {
  const events = createEventSource()
  let apiA!: Recorder
  let apiB!: Recorder
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source}>
        <ControlProbe projectID="proj-A" onReady={(a) => (apiA = a)} />
        <ControlProbe projectID="proj-B" onReady={(b) => (apiB = b)} />
      </SDKProvider>
    </TestTuiContexts>
  ))
  try {
    await sleep(120)
    events.emit(
      global({
        id: "evt1",
        type: "atlas.project.paused",
        properties: { projectID: "proj-A", mode: "stop_scheduling_only", timestamp: Date.now() },
      } as never),
    )
    await sleep(80)
    expect(apiA.status()).toBe("paused:stop_scheduling_only")
    expect(apiB.status()).toBe("running")
  } finally {
    app.renderer.destroy()
  }
})

test("listener cleanup: destroyed probes no longer receive control events", async () => {
  const events = createEventSource()
  let updates = 0
  function CountingProbe() {
    const event = useEvent()
    onMount(() => {
      const dispose = event.on("atlas.project.paused", () => {
        updates += 1
      })
      onCleanup(dispose)
    })
    return <text />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source}>
        <CountingProbe />
      </SDKProvider>
    </TestTuiContexts>
  ))
  await sleep(120)
  events.emit(
    global({ id: "evt1", type: "atlas.project.paused", properties: { projectID: "p", mode: "stop_scheduling_only", timestamp: 1 } }),
  )
  await sleep(60)
  expect(updates).toBe(1)
  app.renderer.destroy()
  events.emit(
    global({ id: "evt2", type: "atlas.project.paused", properties: { projectID: "p", mode: "stop_scheduling_only", timestamp: 2 } }),
  )
  await sleep(60)
  expect(updates).toBe(1)
})

// ---- Action ⇄ backend transport contract ----

const checkpointShape = {
  id: "chk-t1",
  projectID: "proj-ctl",
  createdAt: 123,
  objectiveVersion: 1,
  roadmapVersion: 2,
  projectStatus: "executing",
  activeWorkerCheckpoints: [],
  git: {},
  brain: {},
  verification: { completedTaskIDs: [], failedTaskIDs: [], blockedTaskIDs: [] },
  openIncidentIDs: [],
}

test("Checkpoint/Pause/Resume actions hit the typed orchestrator endpoints with correct payloads", async () => {
  const events = createEventSource()
  const calls: { method: string; path: string; body?: unknown }[] = []

  // Intercepts the same paths the dialog's three actions call through
  // sdk.client.atlas.project.{checkpoint.create,pause,resume}.
  const override = async (method: string, url: URL, body?: unknown): Promise<Response | undefined> => {
    calls.push({ method, path: url.pathname, ...(body !== undefined ? { body } : {}) })

    if (method === "POST" && url.pathname === "/orchestrator/projects/proj-ctl/checkpoint")
      return json(checkpointShape)
    if (method === "POST" && url.pathname === "/orchestrator/projects/proj-ctl/pause") {
      expect((body as { mode?: string }).mode).toBe("stop_scheduling_only")
      return json({ status: "paused", mode: "stop_scheduling_only", requestedAt: 1, pausedAt: 2 })
    }
    if (method === "POST" && url.pathname === "/orchestrator/projects/proj-ctl/resume")
      return json({ status: "running" })
    if (method === "GET" && url.pathname === "/orchestrator/projects/proj-ctl/control-state")
      return json({ status: "running" })
    if (method === "GET" && url.pathname === "/orchestrator/projects/proj-ctl/checkpoints") return json([])
    return undefined
  }

  // hey-api passes a fully built Request to fetch(input); some realms hide
  // behind a non-standard config object, so tolerate both shapes.
  const recordedFetch = (async (input: unknown, init?: RequestInit) => {
    const isNative = typeof Request !== "undefined" && input instanceof Request
    const asRequest = () => {
      try {
        return (input as Request).clone().text()
      } catch {
        return Promise.resolve(undefined)
      }
    }

    let url = ""
    let method = "GET"
    let parsedBody: unknown
    if (isNative) {
      url = (input as Request).url
      method = (input as Request).method
      const text = await asRequest()
      if (text) {
        try {
          parsedBody = JSON.parse(text)
        } catch {}
      }
    } else {
      const loose = (input ?? {}) as { url?: string; method?: string; body?: unknown }
      url = loose.url ?? ""
      method = loose.method ?? init?.method ?? "GET"
      if (loose.body !== undefined) {
        try {
          parsedBody = typeof loose.body === "string" ? JSON.parse(loose.body) : loose.body
        } catch {}
      }
    }

    const response = await override(method, new URL(url), parsedBody)
    if (response) return response
    // Surface unmatched traffic so contract drift fails loudly with context
    console.error("UNMATCHED", method, url)
    return new Response(JSON.stringify({ unhandled: url }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

  let sdkRef!: ReturnType<typeof useSdkHook>
  let done!: () => void
  const mounted = new Promise<void>((resolve) => {
    done = resolve
  })

  function SdkProbe() {
    const sdk = useSdkHook()
    onMount(() => {
      sdkRef = sdk
      done()
    })
    return <text />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={recordedFetch}>
        <SdkProbe />
      </SDKProvider>
    </TestTuiContexts>
  ))
  try {
    await mounted

    const cpRes = await sdkRef.client.atlas.project.checkpoint.create({ projectID: "proj-ctl" })
    expect(cpRes.data?.id).toBe("chk-t1")

    const pauseRes = await sdkRef.client.atlas.project.pause({
      projectID: "proj-ctl",
      atlasPauseInput: { mode: "stop_scheduling_only" },
    })
    expect(pauseRes.data?.status).toBe("paused")

    const resumeRes = await sdkRef.client.atlas.project.resume({ projectID: "proj-ctl" })
    expect(resumeRes.data?.status).toBe("running")

    const methods = calls.map((c) => `${c.method} ${c.path}`)
    expect(methods).toContain("POST /orchestrator/projects/proj-ctl/checkpoint")
    expect(methods).toContain("POST /orchestrator/projects/proj-ctl/pause")
    expect(methods).toContain("POST /orchestrator/projects/proj-ctl/resume")

    const pauseCall = calls.find((c) => c.path.endsWith("/pause"))
    expect((pauseCall?.body as { mode?: string }).mode).toBe("stop_scheduling_only")
  } finally {
    app.renderer.destroy()
  }
})
