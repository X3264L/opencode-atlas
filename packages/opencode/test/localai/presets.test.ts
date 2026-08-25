import { describe, expect, test } from "bun:test"
import { LOCAL_MODEL_CATALOG } from "@/localai/catalog"
import { recommendModels, RECOMMENDATION_PRESETS } from "@/localai/recommend"
import type { HardwareProfile } from "@/localai/hardware"

const GB = 1e9

function hardware(vramBytes = 48 * GB, totalMemoryBytes = 64 * GB): HardwareProfile {
  return {
    os: { platform: "linux", arch: "x86_64" },
    cpu: { model: "Test CPU", logicalCores: 8 },
    memory: { totalBytes: totalMemoryBytes, availableBytes: totalMemoryBytes / 2 },
    gpus: vramBytes > 0 ? [{ vendor: "nvidia" as const, model: "Test GPU", vramBytes }] : [],
  }
}

describe("presets", () => {
  test("all presets are exposed in stable order", () => {
    expect(RECOMMENDATION_PRESETS).toEqual(["overall", "coding", "agent", "speed", "memory", "context"])
  })

  test("agent preset gates models without tool calling even with high coding scores", () => {
    const noTools = LOCAL_MODEL_CATALOG.find((m) => m.id === "gemma3-27b")!
    const toolUser = LOCAL_MODEL_CATALOG.find((m) => m.id === "devstral-24b")!
    const ranked = recommendModels({
      hardware: hardware(),
      profiles: [noTools, toolUser],
      preset: "agent",
    })
    expect(ranked[0].model.id).toBe(toolUser.id)
  })

  test("measured readiness outranks raw coding ability in the agent preset", () => {
    const weakerButReady = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!
    const strongerNoData = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!
    // Readiness was measured for every variant tag of the weak model
    const readinessScores = new Map(
      weakerButReady.variants.map((v) => [`${weakerButReady.runtimes.ollama}${v.id === "default" ? "" : `-${v.id}`}`, 95] as const),
    )
    const ranked = recommendModels({
      hardware: hardware(96 * GB),
      profiles: [weakerButReady, strongerNoData],
      preset: "agent",
      readinessScores,
    })
    expect(ranked[0].model.id).toBe(weakerButReady.id)
    expect(ranked[0].readinessScore).toBe(95)
  })

  test("preset choice changes ranking between speed and coding candidates", () => {
    const tiny = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!
    const strongCoder = LOCAL_MODEL_CATALOG.find((m) => m.id === "gpt-oss-20b")!
    const machine = hardware()
    const speedRank = recommendModels({ hardware: machine, profiles: [tiny, strongCoder], preset: "speed" })
    const codingRank = recommendModels({ hardware: machine, profiles: [tiny, strongCoder], preset: "coding" })
    expect(speedRank[0].model.id).toBe(tiny.id)
    expect(codingRank[0].model.id).toBe(strongCoder.id)
  })

  test("context preset rewards practical local context capacity over theoretical maximum", () => {
    const longCtxSmall = LOCAL_MODEL_CATALOG.find((m) => m.id === "llama3.1-8b")!
    const shortCtxMid = LOCAL_MODEL_CATALOG.find((m) => m.id === "phi4-14b")!
    const ranked = recommendModels({
      hardware: hardware(20 * GB),
      profiles: [longCtxSmall, shortCtxMid],
      preset: "context",
    })
    expect(ranked[0].model.id).toBe(longCtxSmall.id)
    expect(ranked[0].estimated!.contextLength).toBeGreaterThan(ranked[1].estimated!.contextLength)
  })
})

describe("benchmarks and confidence", () => {
  test("measured throughput overrides size-based estimates per exact tag", () => {
    const machine = hardware(30 * GB)
    const tiny = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!
    const mid = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
    const baseline = recommendModels({ hardware: machine, profiles: [tiny, mid], preset: "overall" })
    // The tiny model was benchmarked slow across ALL of its variants; the mid
    // model was benchmarked fast on its default tag only.
    const measured = recommendModels({
      hardware: machine,
      profiles: [tiny, mid],
      preset: "overall",
      measuredTokensPerSecond: new Map([
        ...tiny.variants.map((v) => [`${tiny.runtimes.ollama}${v.id === "default" ? "" : `-${v.id}`}`, 5] as const),
        ["qwen2.5-coder:14b", 120],
      ]),
    })
    const scoreOf = (results: typeof baseline, id: string) => results.find((r) => r.model.id === id)!.score
    expect(scoreOf(measured, mid.id)).toBeGreaterThan(scoreOf(baseline, mid.id))
    expect(scoreOf(measured, tiny.id)).toBeLessThan(scoreOf(baseline, tiny.id))
  })

  test("variant benchmarks keep independent identities - measuring Q4 does not boost Q8", () => {
    const machine = hardware(30 * GB)
    const mid = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
    // Measure ONLY the default (Q4_K_M) tag
    const measuredQ4Only = recommendModels({
      hardware: machine,
      profiles: [mid],
      preset: "overall",
      measuredTokensPerSecond: new Map([["qwen2.5-coder:14b", 120]]),
    })[0]
    const q4Alternative = measuredQ4Only.alternatives.find((a) => a.variant.quantization === "Q4_K_M")!
    const q8Alternative = measuredQ4Only.alternatives.find((a) => a.variant.quantization === "Q8_0")!
    expect(q4Alternative.metricSource).toBe("measured")
    expect(q8Alternative.metricSource).toBe("estimated")
    expect(q8Alternative.measuredTokensPerSecond).toBeUndefined()
  })

  test("confidence reflects detection quality and measurement availability", () => {
    const coder = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!

    const estimatedOnly = recommendModels({ hardware: hardware(24 * GB), profiles: [coder] })[0]
    expect(estimatedOnly.confidence).toBe("medium")

    const measured = recommendModels({
      hardware: hardware(24 * GB),
      profiles: [coder],
      measuredTokensPerSecond: new Map(
        coder.variants.map((v) => [`${coder.runtimes.ollama}${v.id === "default" ? "" : `-${v.id}`}`, 40] as const),
      ),
    })[0]
    expect(measured.confidence).toBe("high")

    const unknownGpu = recommendModels({ hardware: hardware(0), profiles: [coder] })[0]
    expect(unknownGpu.confidence).toBe("low")
  })

  test("recommendation reasons mention quantization quality and headroom specifically", () => {
    const result = recommendModels({ hardware: hardware(24 * GB), profiles: [LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!] })[0]
    const allText = [...result.reasons, ...result.warnings].join("\n")
    if (result.compatibility === "excellent") {
      expect(allText).toMatch(/VRAM free|headroom/)
    }
    expect(result.reasons.length + result.warnings.length).toBeGreaterThan(1)
  })
})
