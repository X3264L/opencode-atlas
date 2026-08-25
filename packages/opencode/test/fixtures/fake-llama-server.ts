// Deterministic llama-server stand-in for process-manager tests.
// Usage: bun run fake-llama-server.ts <mode> <port>
// Modes:
//   ready        - /health 200 immediately, exits cleanly when killed
//   slow:<ms>    - /health 503 for <ms>, then 200
//   never-ready  - /health always 503 until killed
//   crash:<ms>   - serves fine, then exits(2) after <ms>
//   noisy        - like ready but emits stdout+stderr log lines

// Modes:
//   ready        - /health 200 immediately, exits cleanly when killed
//   slow:<ms>    - /health 503 for <ms>, then 200
//   never-ready  - /health always 503 until killed
//   crash:<ms>   - serves fine, then exits(2) after <ms>
//   noisy        - like ready but emits stdout+stderr log lines

const mode = process.argv[2] ?? "ready"
const port = Number(process.argv[3])
const LOG_LINES = 8
if (!Number.isFinite(port) || port <= 0) {
  console.error("missing port")
  process.exit(64)
}

// Only these modes ever report healthy; never-ready must never flip
let healthy = mode === "ready" || mode === "noisy" || mode.startsWith("crash")
if (mode.startsWith("slow:")) {
  const delay = Number(mode.slice(5))
  setTimeout(() => {
    healthy = true
    console.log("[fixture] health ready")
  }, delay)
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: healthy ? "ok" : "loading" }), {
        status: healthy ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake-model" }] })
    return new Response("not found", { status: 404 })
  },
})

console.log(`[fixture] listening on ${server.port}`)
console.error(`[fixture] stderr line for log capture`)

if (mode === "noisy") {
  let counter = 0
  const timer = setInterval(() => {
    counter += 1
    console.log(`[fixture] stdout tick ${counter}`)
    if (counter > LOG_LINES) clearInterval(timer)
  }, 20)
}

const CRASH_AFTER_MS = mode.startsWith("crash:") ? Number(mode.slice(6)) : undefined
if (CRASH_AFTER_MS !== undefined) {
  setTimeout(() => {
    console.error("[fixture] simulating crash")
    process.exit(2)
  }, CRASH_AFTER_MS)
}

process.on("SIGTERM", () => {
  // Graceful path where the platform delivers signals
  console.log("[fixture] terminating")
  process.exit(0)
})
