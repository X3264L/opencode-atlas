import { describe, expect, test } from "bun:test"
import type { ModelBenchmark } from "@/localai/runtime-types"
import { matchCatalogVariant, normalizeInstances, type RuntimeModelInstance } from "@/localai/identity"
import { LOCAL_MODEL_CATALOG } from "@/localai/catalog"

const coder14 = LOCAL_MODEL_CATALOG.find((profile) => profile.id === "qwen2.5-coder-14b")!

describe("catalog variant matching", () => {
  test("matches an ollama-style tag exactly", () => {
    const q6 = coder14.variants.find((variant) => variant.quantization === "Q6_K")!
    expect(
      matchCatalogVariant({ id: "qwen2.5-coder:14b-q6_K", quantization: "Q6_K", parameterCount: 14_800_000_000 }, coder14, q6),
    ).toBe(true)
  })

  test("quant mismatch never matches even with a similar name", () => {
    const q6 = coder14.variants.find((variant) => variant.quantization === "Q6_K")!
    expect(
      matchCatalogVariant({ id: "qwen2.5-coder-14b-instruct-Q8_0", quantization: "Q8_0", parameterCount: 14_800_000_000 }, coder14, q6),
    ).toBe(false)
  })

  test("parameter count divergence blocks matching despite name overlap", () => {
    const q4 = coder14.variants[0]
    expect(matchCatalogVariant({ id: "qwen2.5-coder-7b-q4_k_m", quantization: "Q4_K_M", parameterCount: 7_600_000_000 }, coder14, q4)).toBe(
      false,
    )
  })

  test("unrelated names stay unmatched even with equal size and quant", () => {
    const q4 = coder14.variants[0]
    expect(
      matchCatalogVariant({ id: "totally-different-model-14b-q4_k_m", quantization: "Q4_K_M", parameterCount: 14_800_000_000 }, coder14, q4),
    ).toBe(false)
  })
})

describe("cross-runtime normalization", () => {
  const instance = (runtimeID: string, runtimeModelID: string, quantization?: string): RuntimeModelInstance => ({
    runtimeID,
    runtimeModelID,
    model: {
      id: runtimeModelID,
      name: runtimeModelID,
      ...(quantization ? { quantization } : {}),
      parameterCount: 14_800_000_000,
    },
  })

  test("the same logical model on multiple runtimes collapses into one group", () => {
    const groups = normalizeInstances([
      instance("ollama", "qwen2.5-coder:14b-q6_K", "Q6_K"),
      instance("llamacpp", "/models/qwen2.5-coder-14b-q6_k.gguf", "Q6_K"),
      instance("lmstudio", "qwen2.5-coder-14b-instruct", "Q6_K"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].instances.map((entry) => entry.runtimeID).sort()).toEqual(["llamacpp", "lmstudio", "ollama"])
    expect(groups[0].instances[0].modelID).toBe("qwen2.5-coder-14b")
    expect(groups[0].instances[0].variantID).toBe("q6_k")
  })

  test("uncertain identities are displayed separately, not merged", () => {
    const groups = normalizeInstances([
      instance("ollama", "qwen2.5-coder:14b", "Q4_K_M"),
      instance("llamacpp", "mystery-file-no-quant.gguf"),
    ])
    // The unmatched llama.cpp file keeps its own raw group
    expect(groups).toHaveLength(2)
    expect(groups[1].key.startsWith("raw/")).toBe(true)
  })
})

describe("benchmark and readiness identity", () => {
  test("records for the same model+quant on different runtimes do not collide", () => {
    const store: Record<string, Record<string, ModelBenchmark>> = {}
    const write = (runtimeID: string, runtimeModelID: string, tps: number) => {
      store[runtimeID] = { ...store[runtimeID], [runtimeModelID]: { success: true, tokensPerSecond: tps, testedAt: Date.now() } }
    }
    write("ollama", "qwen2.5-coder:14b-q6_K", 51.7)
    write("llamacpp", "qwen2.5-coder-14b-q6_k.gguf", 64.2)

    // Same logical Qwen/Q6 identity - distinct runtime artifacts
    expect(store["ollama"]["qwen2.5-coder:14b-q6_K"].tokensPerSecond).toBe(51.7)
    expect(store["llamacpp"]["qwen2.5-coder-14b-q6_k.gguf"].tokensPerSecond).toBe(64.2)
    expect(Object.keys(store)).toEqual(["ollama", "llamacpp"])
  })
})
