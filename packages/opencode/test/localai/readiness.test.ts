import { describe, expect, test } from "bun:test"
import { runReadinessTest } from "@/localai/readiness"

function serveMock(handlers: Record<string, (request: Request) => Response | Promise<Response>>) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const handler = handlers[url.pathname]
      if (!handler) return new Response("not found", { status: 404 })
      return handler(request)
    },
  })
  return `http://localhost:${server.port}`
}

const CHAT_OK = { message: { role: "assistant", content: "ok" } }

describe("agent readiness test", () => {
  test("passes all checks for a tool-calling model", async () => {
    let streamResponses = 0
    const endpoint = serveMock({
      "/api/chat": async (request) => {
        const body = JSON.parse(await request.text())
        if (body.stream === true) {
          streamResponses += 1
          return new Response(
            [
              JSON.stringify({ message: { content: "1" }, done: false }),
              JSON.stringify({ message: { content: "2" }, done: false }),
              JSON.stringify({ message: { content: "" }, done: true }),
              "",
            ].join("\n"),
          )
        }
        if (body.tools) {
          return Response.json({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "get_weather", arguments: { city: "Paris", unit: "celsius" } } }],
            },
          })
        }
        if (body.format) {
          return Response.json({
            message: { role: "assistant", content: JSON.stringify({ action: "move", from: "old.py", to: "new.py" }) },
          })
        }
        return Response.json(CHAT_OK)
      },
    })
    void streamResponses
    const result = await runReadinessTest("test-model", { endpoint })
    expect(result.success).toBe(true)
    expect(result.checks.every((check) => check.pass)).toBe(true)
    expect(result.score).toBe(100)
  })

  test("fails gracefully when the model cannot call tools", async () => {
    const endpoint = serveMock({
      "/api/chat": () => Response.json(CHAT_OK),
    })
    const result = await runReadinessTest("plain-model", { endpoint })
    expect(result.success).toBe(true)
    const toolCheck = result.checks.find((check) => check.id === "tool-calling")
    expect(toolCheck?.pass).toBe(false)
    expect(result.score).toBeLessThan(60)
  })

  test("reports failure when the runtime is unreachable", async () => {
    const result = await runReadinessTest("x", { endpoint: "http://127.0.0.1:59998" })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.score).toBe(0)
  })

  test("handles string-encoded tool arguments from older Ollama versions", async () => {
    const endpoint = serveMock({
      "/api/chat": async (request) => {
        const body = JSON.parse(await request.text())
        if (body.tools) {
          return Response.json({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "get_weather", arguments: '{"city": "Paris"}' } }],
            },
          })
        }
        return Response.json(CHAT_OK)
      },
    })
    const result = await runReadinessTest("legacy-model", { endpoint })
    const argsCheck = result.checks.find((check) => check.id === "structured-args")
    expect(argsCheck?.pass).toBe(true)
  })
})
