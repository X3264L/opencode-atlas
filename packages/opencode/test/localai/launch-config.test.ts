import { describe, expect, test } from "bun:test"
import { buildLlamaServerArgs, findFreeLoopbackPort, resolveLlamaServerExecutable } from "@/localai/launch-config"

describe("llama-server argument builder", () => {
  test("builds a typed argv array - never a shell string", () => {
    const args = buildLlamaServerArgs({
      modelPath: "C:\\Users\\User Name\\Models\\qwen 14b Q6_K.gguf",
      port: 53142,
      contextSize: 32768,
    })
    expect(Array.isArray(args)).toBe(true)
    // The user path is ONE argv entry, spaces intact, no quoting/escaping
    expect(args).toContain("C:\\Users\\User Name\\Models\\qwen 14b Q6_K.gguf")
    expect(args.join(" ")).not.toContain('"')
    expect(args.join(" ")).not.toContain("&&")
  })

  test("binds loopback by default", () => {
    const args = buildLlamaServerArgs({ modelPath: "/m.gguf", port: 8080 })
    const hostIndex = args.indexOf("--host")
    expect(args[hostIndex + 1]).toBe("127.0.0.1")
  })

  test("includes optional tuning flags only when provided", () => {
    const minimal = buildLlamaServerArgs({ modelPath: "/m.gguf", port: 1 })
    expect(minimal).not.toContain("--ctx-size")
    expect(minimal).not.toContain("-ngl")

    const full = buildLlamaServerArgs({ modelPath: "/m.gguf", port: 1, contextSize: 16384, gpuLayers: 33, threads: 6 })
    expect(full.indexOf("--ctx-size")).toBeGreaterThan(-1)
    expect(full[full.indexOf("--ctx-size") + 1]).toBe("16384")
    expect(full[full.indexOf("-ngl") + 1]).toBe("33")
    expect(full[full.indexOf("--threads") + 1]).toBe("6")
  })
})

describe("llama-server executable discovery", () => {
  test("explicit configured path wins when it exists", async () => {
    const resolution = await resolveLlamaServerExecutable("/tools/llama-server", {
      existsFile: async (candidate) => candidate === "/tools/llama-server",
    })
    expect(resolution.found).toBe(true)
    if (resolution.found) {
      expect(resolution.path).toBe("/tools/llama-server")
      expect(resolution.source).toBe("configured")
    }
  })

  test("invalid configured path reports not-found instead of throwing", async () => {
    const resolution = await resolveLlamaServerExecutable("/gone/llama-server", {
      which: () => undefined,
      existsFile: async () => false,
    })
    expect(resolution.found).toBe(false)
    if (!resolution.found) expect(resolution.reason).toContain("Configured llama-server path")
  })

  test("PATH lookup is used when nothing is configured", async () => {
    const resolution = await resolveLlamaServerExecutable(undefined, {
      which: (name) => (name === "llama-server" ? "/usr/local/bin/llama-server" : undefined),
      existsFile: async (candidate) => candidate === "/usr/local/bin/llama-server",
    })
    expect(resolution.found).toBe(true)
    if (resolution.found) expect(resolution.source).toBe("path-lookup")
  })

  test("clean not-found state when nothing exists", async () => {
    const resolution = await resolveLlamaServerExecutable(undefined, {
      which: () => undefined,
      existsFile: async () => false,
    })
    expect(resolution.found).toBe(false)
    if (!resolution.found) expect(resolution.reason.toLowerCase()).toContain("not found")
  })
})

describe("port selection", () => {
  test("returns an OS-assigned free loopback port", async () => {
    const port = await findFreeLoopbackPort()
    expect(port).toBeGreaterThan(0)
    expect(Number.isInteger(port)).toBe(true)
  })

  test("supports injected probes for deterministic collision tests", async () => {
    let calls = 0
    const port = await findFreeLoopbackPort(async () => {
      calls += 1
      return 40000 + calls
    })
    expect(port).toBe(40001)
  })
})
