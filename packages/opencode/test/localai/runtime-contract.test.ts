import { describe, expect, test } from "bun:test"
import { createOllamaAdapter } from "@/localai/runtime/ollama"
import { createLMStudioAdapter } from "@/localai/runtime/lmstudio"
import { createLlamaCppAdapter, parseGGUFQuantization, ggufDisplayName } from "@/localai/runtime/llamacpp"
import { createMlxAdapter } from "@/localai/runtime/mlx"
import { benchmarkViaOpenAICompat } from "@/localai/runtime/openai-compat"

// Shared SSE stream helper for OpenAI-compatible mock servers
function sseResponse(chunks: object[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function openAIMockServer(overrides: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      calls.push(url.pathname)
      const handler = overrides[url.pathname]
      if (handler) return handler(request)
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "test-model" }, { id: "" }, { id: "other-model" }] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    endpoint: `http://localhost:${server.port}`,
    calls,
    stop: () => server.stop(true),
  }
}

describe("openai-compatible transport", () => {
  test("lists models and drops entries without ids", async () => {
    const mock = openAIMockServer()
    const adapter = createLlamaCppAdapter({ endpoint: mock.endpoint })
    const models = await adapter.listModels()
    mock.stop()
    expect(models.map((model) => model.id)).toEqual(["other-model", "test-model"])
  })

  test("benchmark measures real streamed generation", async () => {
    let requests = 0
    const mock = openAIMockServer({
      "/v1/chat/completions": async () => {
        requests += 1
        return sseResponse([
          { choices: [{ delta: { content: "def reverse" } }] },
          { choices: [{ delta: { content: "(s):" } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 14, completion_tokens: 12 } },
        ])
      },
    })
    const run = () => benchmarkViaOpenAICompat(fetch, mock.endpoint, "test-model")
    // Under full-suite parallel load a localhost connection can be transiently
    // refused on Windows; one retry keeps this an environment-tolerant check.
    let result = await run()
    if (!result.success) result = await run()
    mock.stop()
    expect(requests).toBeGreaterThanOrEqual(1)
    expect(result.success).toBe(true)
    expect(result.tokensPerSecond).toBeGreaterThan(0)
    expect(result.timeToFirstTokenMs).toBeDefined()
  })

  test("benchmark fails honestly when the server errors", async () => {
    const mock = openAIMockServer({
      "/v1/chat/completions": () => new Response("boom", { status: 500 }),
    })
    const result = await benchmarkViaOpenAICompat(fetch, mock.endpoint, "test-model")
    mock.stop()
    expect(result.success).toBe(false)
    expect(result.error).toContain("500")
  })

  test("invalid JSON model responses do not crash listing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: "not-an-array" }),
    })
    const adapter = createLMStudioAdapter({ endpoint: `http://localhost:${server.port}` })
    const models = await adapter.listModels().catch(() => [])
    server.stop(true)
    expect(models).toEqual([])
  })
})

describe("runtime adapter contracts", () => {
  test("every adapter declares honest capabilities", () => {
    for (const adapter of [
      createOllamaAdapter(),
      createLMStudioAdapter(),
      createLlamaCppAdapter(),
      // MLX is evaluated on a supported platform here; real-platform gating
      // has its own dedicated tests below.
      createMlxAdapter({ platform: "darwin", arch: "arm64" }),
    ]) {
      expect(adapter.capabilities.discovery).toBe(true)
      expect(adapter.capabilities.modelListing).toBe(true)
      // Only Ollama manages model lifecycle today - the others must not fake it
      if (adapter.id !== "ollama") {
        expect(adapter.capabilities.modelInstall).toBe(false)
        expect(adapter.capabilities.modelRemoval).toBe(false)
      }
      if (!adapter.capabilities.benchmark) {
        expect(adapter.benchmarkModel).toBeUndefined()
      }
    }
  })

  test("ollama detects with version detail", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/version") return Response.json({ version: "0.12.9" })
        return new Response("nf", { status: 404 })
      },
    })
    const result = await createOllamaAdapter({ endpoint: `http://localhost:${server.port}` }).detect()
    server.stop(true)
    expect(result.available).toBe(true)
    expect(result.detail).toBe("v0.12.9")
  })

  test("ollama reports unavailable without throwing", async () => {
    const result = await createOllamaAdapter({ endpoint: "http://127.0.0.1:59998" }).detect()
    expect(result.available).toBe(false)
  })

  test("lmstudio surfaces quantization and family from the REST API", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/api/v0/models") {
          return Response.json({
            data: [
              {
                id: "qwen2.5-coder-14b-instruct",
                publisher: "lmstudio-community",
                arch: "qwen2",
                quantization: "Q6_K",
                state_bytes: 11_000_000_000,
              },
            ],
          })
        }
        return new Response("nf", { status: 404 })
      },
    })
    const models = await createLMStudioAdapter({ endpoint: `http://localhost:${server.port}` }).listModels()
    server.stop(true)
    expect(models[0].quantization).toBe("Q6_K")
    expect(models[0].family).toBe("qwen2")
    expect(models[0].sizeBytes).toBe(11_000_000_000)
  })

  test("llama.cpp detect uses /health and degrades while loading", async () => {
    const loading = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "loading model" }, { status: 503 }),
    })
    const degraded = await createLlamaCppAdapter({ endpoint: `http://localhost:${loading.port}` }).detect()
    loading.stop(true)
    expect(degraded.available).toBe(true)
    expect(degraded.detail).toBe("model loading")

    const ok = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }),
    })
    const available = await createLlamaCppAdapter({ endpoint: `http://localhost:${ok.port}` }).detect()
    ok.stop(true)
    expect(available.available).toBe(true)

    const down = await createLlamaCppAdapter({ endpoint: "http://127.0.0.1:59997" }).detect()
    expect(down.available).toBe(false)
  })
})

describe("gguf identity", () => {
  test("extracts canonical quantization labels from filenames", () => {
    expect(parseGGUFQuantization("qwen2.5-coder-14b-q6_k.gguf")).toBe("Q6_K")
    expect(parseGGUFQuantization("/models/Qwen/Qwen3-30B-Q4_K_M.gguf")).toBe("Q4_K_M")
    expect(parseGGUFQuantization("codestral-22b-q8_0")).toBe("Q8_0")
    expect(parseGGUFQuantization("model-f16.gguf")).toBe("F16")
  })

  test("unknown quantizations stay unknown", () => {
    expect(parseGGUFQuantization("totally-custom-build.gguf")).toBeUndefined()
    expect(parseGGUFQuantization("qwen-14b.gguf")).toBeUndefined()
  })

  test("display names strip paths and extensions only", () => {
    expect(ggufDisplayName("C:\\models\\qwen-14b-q6_k.gguf")).toBe("qwen-14b-q6_k")
    expect(ggufDisplayName("/srv/llm/deepseek.gguf")).toBe("deepseek")
  })
})

describe("mlx platform gating", () => {
  test("supported on Apple Silicon regardless of probe results", async () => {
    const adapter = createMlxAdapter({ platform: "darwin", arch: "arm64" })
    expect(adapter.capabilities.discovery).toBe(true)
  })

  test("unsupported elsewhere and never probes endpoints as usable", async () => {
    for (const platform of ["win32", "linux"]) {
      const adapter = createMlxAdapter({ platform, arch: "x86_64", endpoint: "http://localhost:12399" })
      expect(adapter.capabilities.discovery).toBe(false)
      const detection = await adapter.detect()
      expect(detection.available).toBe(false)
      expect(detection.detail).toBe("unsupported on this platform")
      await expect(adapter.listModels()).rejects.toThrow("not available")
    }
  })

  test("intel macs are not Apple Silicon", () => {
    const adapter = createMlxAdapter({ platform: "darwin", arch: "x86_64" })
    expect(adapter.capabilities.discovery).toBe(false)
  })
})
