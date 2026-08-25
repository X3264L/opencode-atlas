import { describe, expect, test } from "bun:test"
import type { ModelBenchmark } from "@/localai/runtime-types"
import { chooseRuntime, type RuntimeCandidate } from "@/localai/runtime-choice"
import { detectAllRuntimes } from "@/localai/runtime-registry"

const fullCaps = {
  discovery: true,
  modelListing: true,
  modelInstall: true,
  modelRemoval: true,
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
  benchmark: true,
  cancellation: true,
}

const limitedCaps = { ...fullCaps, modelInstall: false, modelRemoval: false, externalModelFiles: true }

function bench(tps: number): ModelBenchmark {
  return { success: true, tokensPerSecond: tps, testedAt: Date.now() }
}

function candidate(overrides: Partial<RuntimeCandidate> & { runtimeID: string }): RuntimeCandidate {
  return {
    capabilities: fullCaps,
    usable: true,
    installed: true,
    ...overrides,
  }
}

describe("runtime registry isolation", () => {
  test("one dead runtime never breaks the others", async () => {
    const { runtimes } = await detectAllRuntimes()
    expect(runtimes).toHaveLength(4)
    // Every entry reports a result - none throw
    for (const runtime of runtimes) {
      expect(typeof runtime.available).toBe("boolean")
    }
    const ids = runtimes.map((runtime) => runtime.id)
    expect(ids).toEqual(["ollama", "lmstudio", "llamacpp", "mlx"])
  })

  test("mlx is reported unsupported off Apple Silicon without probing servers", async () => {
    // This Windows machine must show mlx as a detection RESULT but never usable
    const { runtimes, available } = await detectAllRuntimes()
    const mlx = runtimes.find((runtime) => runtime.id === "mlx")
    if (process.platform !== "darwin") {
      expect(mlx?.detail).toBe("unsupported on this platform")
      expect(available.some((adapter) => adapter.id === "mlx")).toBe(false)
    }
  })
})

describe("evidence-based runtime choice", () => {
  test("auto selects the runtime measured faster on this machine", () => {
    const choice = chooseRuntime([
      candidate({ runtimeID: "ollama", benchmark: bench(51.7) }),
      candidate({ runtimeID: "llamacpp", capabilities: limitedCaps, benchmark: bench(64.2) }),
    ])
    expect(choice.runtimeID).toBe("llamacpp")
    expect(choice.source).toBe("measured")
    expect(choice.reasons.some((reason) => reason.text.includes("% faster than ollama"))).toBe(true)
  })

  test("faster runtime with failed tool readiness loses the agent preset", () => {
    const choice = chooseRuntime(
      [
        candidate({ runtimeID: "ollama", benchmark: bench(51.7), readinessScore: 96, readinessToolCallingPass: true }),
        candidate({
          runtimeID: "llamacpp",
          capabilities: limitedCaps,
          benchmark: bench(64.2),
          readinessScore: 40,
          readinessToolCallingPass: false,
        }),
      ],
      { requireTools: true },
    )
    expect(choice.runtimeID).toBe("ollama")
  })

  test("explicit user preference overrides scoring when valid", () => {
    const choice = chooseRuntime(
      [
        candidate({ runtimeID: "lmstudio", capabilities: limitedCaps, benchmark: bench(48.9) }),
        candidate({ runtimeID: "ollama", benchmark: bench(80) }),
      ],
      { preference: "lmstudio" },
    )
    expect(choice.runtimeID).toBe("lmstudio")
    expect(choice.source).toBe("preference")
  })

  test("offline preferred runtime degrades gracefully with a caveat", () => {
    const choice = chooseRuntime(
      [
        candidate({ runtimeID: "ollama", benchmark: bench(51.7) }),
        candidate({ runtimeID: "llamacpp", usable: false, benchmark: bench(99) }),
      ],
      { preference: "llamacpp" },
    )
    expect(choice.runtimeID).toBe("ollama")
    expect(choice.reasons[0].kind).toBe("caveat")
  })

  test("unbenchmarked candidates use transparent heuristics, not fake speed", () => {
    const choice = chooseRuntime([
      candidate({ runtimeID: "ollama" }),
      candidate({ runtimeID: "lmstudio", capabilities: limitedCaps }),
    ])
    expect(choice.runtimeID).toBe("ollama")
    expect(choice.source).toBe("heuristic")
    expect(choice.reasons.some((reason) => reason.text.includes("No cross-runtime benchmark yet"))).toBe(true)
    // It cites lifecycle reasons instead of inventing performance numbers
    expect(choice.reasons.some((reason) => reason.text.includes("Full lifecycle support"))).toBe(true)
  })

  test("installed models beat uninstalled ones without measurements", () => {
    const choice = chooseRuntime([
      candidate({ runtimeID: "ollama", installed: false }),
      candidate({ runtimeID: "llamacpp", capabilities: limitedCaps, installed: true }),
    ])
    expect(choice.runtimeID).toBe("llamacpp")
  })

  test("single available runtime short-circuits honestly", () => {
    const choice = chooseRuntime([candidate({ runtimeID: "ollama", installed: false })])
    expect(choice.runtimeID).toBe("ollama")
    expect(choice.reasons[0].text).toContain("only available runtime")
  })

  test("nothing usable yields no choice at all", () => {
    const choice = chooseRuntime([candidate({ runtimeID: "ollama", usable: false })])
    expect(choice.runtimeID).toBeUndefined()
    expect(choice.source).toBe("none")
  })

  test("invalid measurements are ignored rather than trusted", () => {
    const bad: ModelBenchmark = { success: false, tokensPerSecond: Number.NaN, testedAt: Date.now() }
    const choice = chooseRuntime([
      candidate({ runtimeID: "ollama", benchmark: bad }),
      candidate({ runtimeID: "llamacpp", capabilities: limitedCaps, benchmark: bench(60) }),
    ])
    expect(choice.runtimeID).toBe("llamacpp")
  })
})
