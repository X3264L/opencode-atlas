import { describe, expect, test } from "bun:test"
import { createOllamaAdapter } from "@/localai/runtime/ollama"
import { classifyJobFailure, isAbortError } from "@/localai/localai"

// Streams NDJSON progress events forever until the client cancels the stream
function serveSlowPull() {
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      let timer: ReturnType<typeof setInterval> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let completed = 0
          timer = setInterval(() => {
            completed += 1
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ status: "downloading", total: 1e9, completed })}\n`),
            )
          }, 10)
        },
        cancel() {
          if (timer) clearInterval(timer)
        },
      })
      return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
    },
  })
  return server
}

describe("install cancellation", () => {
  test("aborting an active pull rejects with an AbortError", async () => {
    const server = serveSlowPull()
    const endpoint = `http://localhost:${server.port}`
    const adapter = createOllamaAdapter({ endpoint })
    const controller = new AbortController()
    const pull = adapter.installModel!({ id: "some-model" }, { signal: controller.signal })
    controller.abort(new DOMException("Cancelled by user", "AbortError"))

    const outcome = await pull.then(
      () => "completed",
      (error) => error,
    )
    void server.stop(true)
    expect(outcome).not.toBe("completed")
    expect(isAbortError(outcome)).toBe(true)
  })

  test("abort interrupts promptly and no stale progress arrives afterwards", async () => {
    const server = serveSlowPull()
    const adapter = createOllamaAdapter({ endpoint: `http://localhost:${server.port}` })
    const controller = new AbortController()
    let progressEvents = 0
    const pull = adapter.installModel!({ id: "some-model" }, {
      signal: controller.signal,
      onProgress: () => {
        progressEvents += 1
      },
    })

    // Let a few real progress events arrive so we know the stream was live
    await Bun.sleep(120)
    const liveBefore = progressEvents
    expect(liveBefore).toBeGreaterThan(0)

    controller.abort(new DOMException("Cancelled by user", "AbortError"))
    const startedAt = Date.now()
    const outcome = await pull.then(
      () => "completed" as const,
      (error) => error,
    )
    const elapsed = Date.now() - startedAt

    // Prompt interruption - previously this hung until the runner timeout.
    // The bound stays far below the old hang while tolerating CI load spikes.
    expect(elapsed).toBeLessThan(2_500)
    expect(outcome).not.toBe("completed")
    expect(isAbortError(outcome)).toBe(true)

    // Reader disposal must have stopped consuming the stream
    await Bun.sleep(150)
    expect(progressEvents).toBe(liveBefore)

    void server.stop(true)
  })

  test("pre-pull abort rejects instead of starting the download", async () => {
    const server = serveSlowPull()
    const adapter = createOllamaAdapter({ endpoint: `http://localhost:${server.port}` })
    const controller = new AbortController()
    controller.abort(new DOMException("Cancelled by user", "AbortError"))
    const outcome = await adapter
      .installModel!({ id: "some-model" }, { signal: controller.signal })
      .then(
        () => "completed" as const,
        (error) => error,
      )
    void server.stop(true)
    expect(isAbortError(outcome)).toBe(true)
  })

  test("job failures caused by user aborts are classified as cancelled", () => {
    const abort = new DOMException("Cancelled by user", "AbortError")
    expect(classifyJobFailure(abort)).toBe("cancelled")
    expect(classifyJobFailure(new Error("insufficient disk space"))).toBe("error")
    expect(classifyJobFailure(new TypeError("fetch failed"))).toBe("error")
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new Error("nope"))).toBe(false)
  })
})

