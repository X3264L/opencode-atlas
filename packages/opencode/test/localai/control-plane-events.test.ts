import { describe, expect, test } from "bun:test"
import { createRuntimeHealthWatcher } from "@/localai/health-watcher"
import { createLocalAiEventPublisher } from "@/localai/events"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect, Layer } from "effect"
import { EventManifest } from "@opencode-ai/schema/event-manifest"
import { LocalAiEvent } from "@opencode-ai/schema/localai-event"
import { createLMStudioAdapter } from "@/localai/runtime/lmstudio"

describe("event manifest registration", () => {
  test("all localai event types are registered and unique", () => {
    const expected = [
      "localai.instance.lifecycle",
      "localai.instance.log",
      "localai.health.changed",
      "localai.managed.artifact",
      "localai.executable.changed",
      "localai.benchmark.status",
      "localai.readiness.status",
      "localai.install.status",
      "localai.provider.changed",
    ]
    const manifestTypes = (EventManifest.Definitions as unknown as { type: string }[]).map((entry) => entry.type)
    for (const type of expected) expect(manifestTypes).toContain(type)
    // Routing + orchestrator event families are registered too
    for (const type of ["atlas.routing.decision", "atlas.project.created"]) {
      expect(manifestTypes).toContain(type)
    }
  })
})

describe("runtime health watcher", () => {
  function watcherWith(sequence: string[]) {
    const transitions: { runtimeID: string; health: string }[] = []
    let calls = 0
    const watcher = createRuntimeHealthWatcher({
      runtimes: () => ["ollama"],
      probe: async () => {
        const state = sequence[Math.min(calls, sequence.length - 1)]
        calls += 1
        return { state: state as "available" | "unavailable" | "degraded" }
      },
      onTransition: ({ runtimeID, health }) => transitions.push({ runtimeID, health: health.state }),
      intervalMs: 60_000,
    })
    return { watcher, transitions }
  }

  test("first observation seeds baseline without emitting", async () => {
    const { watcher, transitions } = watcherWith(["available"])
    await watcher.refresh()
    expect(transitions).toEqual([])
  })

  test("repeated identical probes never emit redundant events", async () => {
    const { watcher, transitions } = watcherWith(["available", "available", "available"])
    await watcher.refresh()
    await watcher.refresh()
    await watcher.refresh()
    expect(transitions).toEqual([])
  })

  test("real transitions emit exactly once each", async () => {
    const { watcher, transitions } = watcherWith(["unavailable", "degraded", "available", "available"])
    await watcher.refresh() // seed: unavailable
    await watcher.refresh() // unavailable -> degraded
    await watcher.refresh() // degraded -> available
    await watcher.refresh() // available -> available (no emit)
    expect(transitions.map((entry) => entry.health)).toEqual(["degraded", "available"])
  })
})

describe("benchmark / readiness / install event payloads", () => {
  function capturingBridge() {
    const published: { type: string; data: Record<string, unknown> }[] = []
    const bridge = {
      publish: (definition: { type: string }, data: Record<string, unknown>) => {
        published.push({ type: definition.type, data })
        return Effect.succeed(null as never)
      },
    } as unknown as typeof EventV2Bridge.Service.Service
    return { published, publisher: createLocalAiEventPublisher(bridge) }
  }

  test("publisher emits typed localai.* envelopes with compact payloads", () => {
    const { published, publisher } = capturingBridge()
    publisher.instanceLifecycle({
      runtimeID: "llamacpp",
      instanceID: "inst-1",
      artifactID: "gguf-1",
      state: "running",
      generation: 2,
    })
    publisher.benchmarkStatus({
      runtimeID: "llamacpp",
      modelID: "m.gguf",
      status: "completed",
      tokensPerSecond: 64.2,
      timeToFirstTokenMs: 310,
    })
    publisher.installStatus({ jobID: "job-1", runtimeID: "ollama", status: "progress", percent: 42 })
    publisher.providerChanged("llamacpp", true, "http://127.0.0.1:53142")

    expect(published.map((entry) => entry.type)).toEqual([
      "localai.instance.lifecycle",
      "localai.benchmark.status",
      "localai.install.status",
      "localai.provider.changed",
    ])
    expect(published[1]!.data).toMatchObject({ status: "completed", tokensPerSecond: 64.2 })
    // Optional fields are omitted rather than sent as null/undefined
    expect("error" in published[1]!.data).toBe(false)
    expect(published[2]!.data.percent).toBe(42)
  })

  test("readiness probes surface per-check completions through the publisher", async () => {
    const { published, publisher } = capturingBridge()
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/v1/chat/completions") {
          requests += 1
          if (requests === 1) {
            return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
          }
          if (requests === 2) {
            // Streaming check - emit a few SSE chunks
            const body =
              `data: ${JSON.stringify({ choices: [{ delta: { content: "1" } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: { content: "2" } }] })}\n\n` +
              "data: [DONE]\n\n"
            return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
          }
          if (requests === 5) {
            return Response.json({
              choices: [{ message: { role: "assistant", content: '{"action":"move","from":"old.py","to":"new.py"}' } }],
            })
          }
          // Tool calling / structured args / intermediate - no tools invoked
          return Response.json({ choices: [{ message: { role: "assistant", content: "nope" } }] })
        }
        return new Response("nf", { status: 404 })
      },
    })
    const adapter = createLMStudioAdapter({ endpoint: `http://localhost:${server.port}` })
    const result = await adapter.probeReadiness("test-model", {
      onCheck: (check) =>
        publisher.readinessStatus({
          runtimeID: "lmstudio",
          modelID: "test-model",
          status: "check_completed",
          check,
        }),
    })
    server.stop(true)

    expect(result.success).toBe(true)
    const checkEvents = published.filter((entry) => entry.data.status === "check_completed")
    expect(checkEvents).toHaveLength(5)
    expect(checkEvents.every((entry) => (entry.data.check as { id: string } | undefined)?.id !== undefined)).toBe(true)
    // The service layer additionally emits a final "completed" event carrying
    // result.score - covered by the payload-shape test above.
    expect(typeof result.score).toBe("number")
  })
})
