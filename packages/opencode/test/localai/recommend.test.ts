import { describe, expect, test } from "bun:test"
import { LOCAL_MODEL_CATALOG } from "@/localai/catalog"
import { recommendModels, recommendedContext, RECOMMENDATION_PRESETS } from "@/localai/recommend"
import type { HardwareProfile } from "@/localai/hardware"
import type { LocalModelProfile } from "@/localai/catalog"

const GB = 1e9

function hardware(
  overrides: Partial<HardwareProfile> & { vramBytes?: number; totalMemoryBytes?: number } = {},
): HardwareProfile {
  const gpus =
    overrides.vramBytes !== undefined && overrides.vramBytes > 0
      ? [{ vendor: "nvidia" as const, model: "Test GPU", vramBytes: overrides.vramBytes }]
      : []
  return {
    os: { platform: "linux", arch: "x86_64" },
    cpu: { model: "Test CPU", logicalCores: 8 },
    memory: {
      totalBytes: overrides.totalMemoryBytes ?? 32 * GB,
      availableBytes: (overrides.totalMemoryBytes ?? 32 * GB) / 2,
    },
    gpus: overrides.gpus ?? gpus,
  }
}

const smallModel = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!
const mediumModel = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
const largeModel = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!

describe("recommendation compatibility", () => {
  test("8 GB VRAM fits the 7B model and rejects the 32B model", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 8 * GB }), profiles: [smallModel, largeModel] })
    const small = results.find((r) => r.model.id === "qwen2.5-coder-7b")!
    const large = results.find((r) => r.model.id === "qwen2.5-coder-32b")!
    expect(small.compatibility).toBe("good")
    expect(large.compatibility).toBe("not_recommended")
    expect(large.warnings.length).toBeGreaterThan(0)
  })

  test("12 GB VRAM runs the 7B model entirely on GPU", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 12 * GB }), profiles: [smallModel] })
    expect(results[0].compatibility).toBe("good")
    expect(results[0].estimated?.ramBytes).toBeUndefined()
    expect(results[0].reasons.length).toBeGreaterThan(0)
  })

  test("16 GB VRAM gives the 7B model an excellent rating", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 16 * GB }), profiles: [smallModel] })
    expect(results[0].compatibility).toBe("excellent")
    expect(results[0].warnings.length).toBe(0)
  })

  test("16 GB VRAM needs offloading for the 14B model at large context", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 16 * GB }), profiles: [mediumModel] })
    // weights alone fit; a useful context pushes it over the comfort line
    expect(results[0].compatibility).toBe("usable")
    expect(results[0].warnings.length).toBeGreaterThan(0)
  })

  test("24 GB VRAM keeps the 32B model usable with reduced context", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 24 * GB }), profiles: [largeModel] })
    expect(results[0].compatibility).toBe("usable")
    expect(results[0].estimated?.contextLength).toBeLessThan(largeModel.contextLength!)
  })

  test("larger models are penalized when they exceed comfortable memory", () => {
    const results = recommendModels({
      hardware: hardware({ vramBytes: 8 * GB }),
      profiles: [smallModel, mediumModel, largeModel],
    })
    const scores = new Map(results.map((r) => [r.model.id, r.score]))
    expect(scores.get(smallModel.id)!).toBeGreaterThan(scores.get(mediumModel.id)!)
    expect(scores.get(mediumModel.id)!).toBeGreaterThan(scores.get(largeModel.id)!)
  })

  test("CPU-only machines never rate excellent", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 0 }), profiles: [smallModel, largeModel] })
    for (const result of results) {
      expect(result.compatibility).not.toBe("excellent")
      expect(result.estimated?.vramBytes).toBe(0)
    }
  })

  test("apple silicon unified memory counts as usable GPU budget", () => {
    const macStudio: HardwareProfile = {
      os: { platform: "darwin", arch: "arm64" },
      cpu: { model: "Apple M2 Max", logicalCores: 12 },
      memory: { totalBytes: 64 * GB, availableBytes: 40 * GB },
      gpus: [{ vendor: "apple", model: "Apple M2 Max" }],
    }
    const small = recommendModels({ hardware: macStudio, profiles: [smallModel] })[0]
    expect(small.compatibility).toBe("excellent")
    // unified memory also lets bigger models run fully on-device
    const large = recommendModels({ hardware: macStudio, profiles: [largeModel] })[0]
    expect(large.compatibility).not.toBe("not_recommended")
  })

  test("gpt-oss-120b is not recommended on small machines", () => {
    const huge = LOCAL_MODEL_CATALOG.find((m) => m.id === "gpt-oss-120b")!
    const results = recommendModels({
      hardware: hardware({ vramBytes: 12 * GB, totalMemoryBytes: 32 * GB }),
      profiles: [huge],
    })
    expect(results[0].compatibility).toBe("not_recommended")
    expect(results[0].warnings.length).toBeGreaterThan(0)
  })
})

describe("presets", () => {
  test("all presets are exposed", () => {
    expect(RECOMMENDATION_PRESETS).toEqual(["overall", "coding", "agent", "speed", "memory", "context"])
  })

  test("agent preset gates models without tool calling", () => {
    const noTools = LOCAL_MODEL_CATALOG.find((m) => m.id === "deepseek-r1-8b")!
    const results = recommendModels({
      hardware: hardware({ vramBytes: 48 * GB }),
      profiles: [noTools],
      preset: "agent",
    })
    expect(results[0].score).toBeLessThanOrEqual(35)
    const overall = recommendModels({
      hardware: hardware({ vramBytes: 48 * GB }),
      profiles: [noTools],
      preset: "overall",
    })
    expect(results[0].score).toBeLessThanOrEqual(overall[0].score)
  })

  test("preset changes ranking between speed and coding candidates", () => {
    const tiny = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!
    const strongCoder = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
    const machine = hardware({ vramBytes: 48 * GB })
    const speedRank = recommendModels({ hardware: machine, profiles: [tiny, strongCoder], preset: "speed" })
    const codingRank = recommendModels({ hardware: machine, profiles: [tiny, strongCoder], preset: "coding" })
    expect(speedRank[0].model.id).toBe(tiny.id)
    expect(codingRank[0].model.id).toBe(strongCoder.id)
  })

  test("measured throughput beats size-based estimates", () => {
    const machine = hardware({ vramBytes: 30 * GB })
    const tiny = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!
    const big = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!
    const withoutMeasurement = recommendModels({ hardware: machine, profiles: [tiny, big], preset: "overall" })
    const withMeasurement = recommendModels({
      hardware: machine,
      profiles: [tiny, big],
      preset: "overall",
      measuredTokensPerSecond: new Map([
        [tiny.runtimes.ollama!, 5],
        [big.runtimes.ollama!, 120],
      ]),
    })
    const bigBefore = withoutMeasureRank(withoutMeasurement, big.id)
    const bigAfter = withoutMeasureRank(withMeasurement, big.id)
    expect(bigAfter).toBeGreaterThan(bigBefore)
  })

  function withoutMeasureRank(results: { score: number; model: LocalModelProfile }[], id: string) {
    return results.find((r) => r.model.id === id)!.score
  }
})

describe("context recommendation", () => {
  const profile = LOCAL_MODEL_CATALOG.find((m) => m.id === "llama3.1-8b")!

  test("shrinks as memory constraints tighten", () => {
    const roomy = recommendedContext(profile, profile.variants[0], 64 * GB)
    const tight = recommendedContext(profile, profile.variants[0], 6 * GB)
    const tighter = recommendedContext(profile, profile.variants[0], 4 * GB)
    expect(roomy).toBeGreaterThan(tight)
    expect(tight).toBeGreaterThanOrEqual(tighter)
    expect(roomy).toBeLessThanOrEqual(profile.contextLength!)
  })

  test("never recommends more than the model maximum or less than 4096", () => {
    expect(recommendedContext(profile, profile.variants[0], 1000 * GB)).toBe(profile.contextLength!)
    expect(recommendedContext(profile, profile.variants[0], 0)).toBe(4096)
  })
})
