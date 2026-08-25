import { describe, expect, test } from "bun:test"
import { createOllamaAdapter, resolveOllamaEndpoint } from "@/localai/runtime/ollama"

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

describe("endpoint resolution", () => {
  test("defaults to the standard Ollama port", () => {
    expect(resolveOllamaEndpoint()).toBe("http://127.0.0.1:11434")
  })

  test("parses OLLAMA_HOST variants", () => {
    expect(resolveOllamaEndpoint({ OLLAMA_HOST: "127.0.0.1:9999" })).toBe("http://127.0.0.1:9999")
    expect(resolveOllamaEndpoint({ OLLAMA_HOST: "https://ollama.example.com" })).toBe("https://ollama.example.com")
  })
})

describe("detection", () => {
  test("reports available when the version endpoint responds", async () => {
    const endpoint = serveMock({
      "/api/version": () => Response.json({ version: "0.12.9" }),
    })
    const result = await createOllamaAdapter({ endpoint }).detect()
    expect(result.available).toBe(true)
    expect(result.detail).toBe("v0.12.9")
  })

  test("reports unavailable when nothing is listening", async () => {
    const result = await createOllamaAdapter({ endpoint: "http://127.0.0.1:59999" }).detect()
    expect(result.available).toBe(false)
  })
})

describe("installed models", () => {
  test("lists models with metadata merged from /api/show", async () => {
    let showCalls = 0
    const endpoint = serveMock({
      "/api/version": () => Response.json({ version: "0.12.9" }),
      "/api/tags": () =>
        Response.json({
          models: [
            {
              name: "qwen2.5-coder:7b",
              size: 4_700_000_000,
              details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" },
            },
          ],
        }),
      "/api/show": () => {
        showCalls += 1
        return Response.json({
          capabilities: ["completion", "tools"],
          model_info: { "qwen2.context_length": 32768 },
        })
      },
    })
    const models = await createOllamaAdapter({ endpoint }).listModels()
    expect(showCalls).toBe(1)
    expect(models).toHaveLength(1)
    const model = models[0]
    expect(model.id).toBe("qwen2.5-coder:7b")
    expect(model.sizeBytes).toBe(4_700_000_000)
    expect(model.quantization).toBe("Q4_K_M")
    expect(model.parameterCount).toBe(7_600_000_000)
    expect(model.contextLength).toBe(32768)
    expect(model.toolCalling).toBe(true)
    expect(model.vision).toBe(false)
  })

  test("tolerates missing /api/show details", async () => {
    const endpoint = serveMock({
      "/api/tags": () => Response.json({ models: [{ name: "legacy:latest" }] }),
      "/api/show": () => new Response("error", { status: 500 }),
    })
    const models = await createOllamaAdapter({ endpoint }).listModels()
    expect(models[0].toolCalling).toBe(false)
    expect(models[0].contextLength).toBeUndefined()
  })

  test("propagates malformed tags responses as errors", async () => {
    const endpoint = serveMock({
      "/api/tags": () => new Response("bad gateway", { status: 502 }),
    })
    expect(createOllamaAdapter({ endpoint }).listModels()).rejects.toThrow()
  })
})

describe("installation", () => {
  test("streams pull progress percentages", async () => {
    const progressEvents: { percent?: number; status: string }[] = []
    const body = [
      JSON.stringify({ status: "pulling manifest" }),
      JSON.stringify({ status: "downloading", total: 100, completed: 25 }),
      JSON.stringify({ status: "downloading", total: 100, completed: 100 }),
      JSON.stringify({ status: "success" }),
      "",
    ].join("\n")
    const endpoint = serveMock({
      "/api/pull": () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
    })
    await createOllamaAdapter({ endpoint }).installModel!(
      { id: "qwen3:8b" },
      {
        onProgress: (progress) => progressEvents.push(progress),
      },
    )
    expect(progressEvents.map((event) => event.percent)).toEqual([undefined, 25, 100, undefined])
  })

  test("surfaces download errors", async () => {
    const body = `${JSON.stringify({ error: "insufficient disk space" })}\n`
    const endpoint = serveMock({
      "/api/pull": () => new Response(body),
    })
    expect(createOllamaAdapter({ endpoint }).installModel!({ id: "qwen3:8b" }, {})).rejects.toThrow(
      "insufficient disk space",
    )
  })

  test("fails on HTTP errors", async () => {
    const endpoint = serveMock({
      "/api/pull": () => new Response("nope", { status: 500 }),
    })
    expect(createOllamaAdapter({ endpoint }).installModel!({ id: "x" }, {})).rejects.toThrow("HTTP 500")
  })
})

describe("benchmarking", () => {
  test("measures tokens per second from eval stats", async () => {
    const body = [
      JSON.stringify({ response: "He" }),
      JSON.stringify({ response: "llo" }),
      JSON.stringify({
        done: true,
        prompt_eval_count: 10,
        prompt_eval_duration: 1_000_000_000,
        eval_count: 20,
        eval_duration: 2_000_000_000,
      }),
      "",
    ].join("\n")
    const endpoint = serveMock({
      "/api/generate": () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
    })
    const benchmark = await createOllamaAdapter({ endpoint }).benchmarkModel!("llama3.1:8b")
    expect(benchmark.success).toBe(true)
    expect(benchmark.tokensPerSecond).toBe(10)
    expect(benchmark.promptTokensPerSecond).toBe(10)
    expect(benchmark.timeToFirstTokenMs).toBeDefined()
  })

  test("returns a failure result instead of throwing", async () => {
    const endpoint = serveMock({
      "/api/generate": () => new Response("boom", { status: 500 }),
    })
    const benchmark = await createOllamaAdapter({ endpoint }).benchmarkModel!("x")
    expect(benchmark.success).toBe(false)
    expect(benchmark.error).toBeDefined()
  })
})
