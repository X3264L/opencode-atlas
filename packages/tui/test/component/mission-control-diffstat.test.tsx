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
import {
  LocalAiDiffstatDetails,
  diffReturnRoute,
  diffstatEventSummary,
  diffstatHudRow,
} from "../../src/component/dialog-local-ai"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, json } from "../fixture/tui-sdk"

// ---- Pure helpers ----

test("diffstat event payloads normalize into the HUD summary", () => {
  expect(diffstatEventSummary({ additions: 428, deletions: 137, files: 12 })).toEqual({
    additions: 428,
    deletions: 137,
    files: 12,
  })
  expect(diffstatEventSummary({ additions: "NaN", deletions: 1, files: 1 })).toBeUndefined()
  expect(diffstatEventSummary(undefined)).toBeUndefined()
})

test("compact HUD row renders the exact working-tree summary", () => {
  const row = diffstatHudRow({ additions: 428, deletions: 137, files: 12 })
  expect(row.title).toContain("+428 −137 · 12 files")
  expect(row.description).toContain("Session: unknown")
  const empty = diffstatHudRow(undefined)
  expect(empty.title).toContain("no changes detected")
  expect(empty.description).toContain("Session: unknown")
})

test("drilldown return routes map onto the diff viewer's return contract", () => {
  expect(diffReturnRoute({ type: "home" })).toEqual({ name: "home" })
  expect(diffReturnRoute({ type: "session", sessionID: "ses_1" })).toEqual({
    name: "session",
    params: { sessionID: "ses_1" },
  })
  expect(diffReturnRoute({ type: "plugin", id: "other", data: { a: 1 } })).toEqual({
    name: "other",
    params: { a: 1 },
  })
})

// ---- Drilldown render harness ----

function Harness(props: {
  fetch?: typeof fetch
  events?: ReturnType<typeof createEventSource>["source"]
  children: JSX.Element
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = createTuiResolvedConfig()
  onCleanup(registerOpencodeKeymap(keymap, renderer, { keybinds: config.keybinds, leader_timeout: config.leader_timeout }))
  return (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory="/tmp/opencode/packages/tui" fetch={props.fetch} events={props.events}>
        <RouteProvider>
          <TuiConfigProvider config={createTuiResolvedConfig()}>
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

const fileDiffstatResponse = [
  { path: "src/auth.ts", additions: 82, deletions: 11, binary: false },
  { path: "src/session.ts", additions: 41, deletions: 3, binary: false },
  { path: "assets/logo.png", binary: true },
]

async function renderDrilldown(override?: (url: URL) => Response | undefined) {  let requested: string | undefined
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.includes("file-diffstat")) {
      requested = url.pathname
      return json(override?.(url) ?? fileDiffstatResponse)
    }
    return json({})
  }) as typeof globalThis.fetch

  const app = await testRender(() => (
    <Harness fetch={fetchImpl}>
      <LocalAiDiffstatDetails projectID="proj-1" />
    </Harness>
  ))
  await waitForFrameText(app, "src/auth.ts", "No working-tree")
  return { app, requested: () => requested }
}

async function waitForFrameText(
  app: Awaited<ReturnType<typeof testRender>>,
  ...needles: string[]
) {
  // Async data lands between frames; keep polling past waitForFrame's short burst
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return await app.waitForFrame((frame) => needles.some((needle) => frame.includes(needle)))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`timed out waiting for frame containing ${needles.join(" | ")}`)
}

test("drilldown renders real per-file rows with exact numbers and binary marker", async () => {
  const view = await renderDrilldown()
  try {
    expect(view.requested()).toContain("/orchestrator/projects/proj-1/file-diffstat")
    const frameText = await waitForFrameText(view.app, "assets/logo.png", "binary")
    expect(frameText).toContain("src/auth.ts")
    expect(frameText).toContain("+82 −11")
    expect(frameText).toContain("src/session.ts")
    expect(frameText).toContain("+41 −3")
    // Binary files never fabricate line counts
    expect(frameText).toContain("binary")
    // Honest session labeling
    expect(frameText).toContain("Session: unknown")
    expect(frameText).toContain("Working tree versus HEAD")
  } finally {
    view.app.renderer.destroy()
  }
})

test("empty workspace renders an honest no-changes state", async () => {
  const view = await renderDrilldown(() => json([]))
  try {
    await waitForFrameText(view.app, "No working-tree changes")
  } finally {
    view.app.renderer.destroy()
  }
})

// ---- Live event reactivity through the real SDK event plumbing ----

test("atlas.diffstat.changed updates the visible summary and unsubscribes on dispose", async () => {
  const events = createEventSource()
  const seen: string[] = []
  let setLine!: (value: string) => void

  function Probe() {
    const event = useEvent()
    const [line, set] = createSignal("")
    setLine = set
    onMount(() => {
      const dispose = event.on("atlas.diffstat.changed", (payload) => {
        const summary = diffstatEventSummary(payload.properties)
        if (summary) seen.push(`${summary.additions}:${summary.deletions}:${summary.files}`)
        set(summary ? `Working tree +${summary.additions} −${summary.deletions} · ${summary.files} files` : "")
      })
      onCleanup(dispose)
    })
    return <text>{line()}</text>
  }

  const app = await testRender(() => (
    <Harness events={events.source}>
      <Probe />
    </Harness>
  ))

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitSeenCount = async (count: number) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (seen.length >= count) return
      await sleep(25)
    }
  }

  const emitAt = (additions: number, deletions: number, files: number) =>
    events.emit({
      directory: "/tmp/opencode/packages/tui",
      workspace: undefined,
      payload: {
        id: "evt_diffstat_1",
        type: "atlas.diffstat.changed",
        properties: { projectID: "proj-1", additions, deletions, files },
      } as GlobalEvent["payload"],
    })

  try {
    // Wait for the SDK event source subscription to attach
    await sleep(150)
    emitAt(428, 137, 12)
    await waitSeenCount(1)
    expect(seen).toEqual(["428:137:12"])

    app.renderer.destroy()

    emitAt(1, 2, 3)
    await sleep(50)
    // Listener was disposed with the component: no further deliveries
    expect(seen).toEqual(["428:137:12"])
  } finally {
    app.renderer.destroy()
  }
})
