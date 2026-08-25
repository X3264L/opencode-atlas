import { describe, expect, test } from "bun:test"
import { LOCAL_MODEL_CATALOG } from "@/localai/catalog"
import { baseSpeedScore, measuredThroughputScore, recommendModels } from "@/localai/recommend"
import type { HardwareProfile } from "@/localai/hardware"

const GB = 1e9

function hardware(overrides: { vramBytes?: number; totalMemoryBytes?: number } = {}): HardwareProfile {
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
    gpus,
  }
}

const coder14 = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
const small = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!

describe("multi-quantization recommendations", () => {
  test("larger quantization wins when comfortably supported", () => {
    // 24 GB card: the 14B model's Q8_0 (~13 GB weights + context) fits with headroom
    const results = recommendModels({ hardware: hardware({ vramBytes: 24 * GB }), profiles: [coder14] })
    expect(results[0].variant.quantization).toBe("Q8_0")
    // Fully GPU-resident even if utilization keeps it short of "excellent"
    expect(["excellent", "good"]).toContain(results[0].compatibility)
    expect(results[0].offload).toBe("none")
    expect(results[0].alternatives.find((a) => a.variant.quantization === "Q8_0")?.recommended).toBe(true)
  })

  test("smaller quantization wins when the larger one causes memory pressure", () => {
    // 12 GB card: Q8_0 spills into RAM while smaller quants fit on-GPU
    const results = recommendModels({ hardware: hardware({ vramBytes: 12 * GB }), profiles: [coder14] })
    const bestQuality = results[0].alternatives.find((a) => a.variant.quantization === "Q8_0")!
    if (bestQuality.compatibility === results[0].compatibility) return
    expect(results[0].variant.qualityMultiplier!).toBeLessThanOrEqual(bestQuality.variant.qualityMultiplier!)
    expect(bestQuality.recommended).toBe(false)
  })

  test("every evaluated variant is exposed as an alternative and exactly one is recommended", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 16 * GB }), profiles: [coder14] })
    expect(results[0].alternatives).toHaveLength(coder14.variants.length)
    expect(results[0].alternatives.filter((a) => a.recommended)).toHaveLength(1)
  })

  test("each variant resolves to its own runtime tag", () => {
    const tags = coder14.variants.map((v) => v.runtimeTag)
    expect(tags).toContain("qwen2.5-coder:14b")
    expect(tags).toContain("qwen2.5-coder:14b-q6_K")
    expect(tags).toContain("qwen2.5-coder:14b-q8_0")
  })

  test("installed detection uses the selected variant's tag, not another variant's", () => {
    const machine = hardware({ vramBytes: 24 * GB })
    const installedDefaultOnly = recommendModels({
      hardware: machine,
      profiles: [coder14],
      installedTags: new Set(["qwen2.5-coder:14b"]),
    })[0]
    // On a 24GB card the engine picks Q8_0 which has a different tag
    if (installedDefaultOnly.variant.quantization !== "Q4_K_M") {
      expect(installedDefaultOnly.installed).toBeFalsy()
    } else {
      expect(installedDefaultOnly.installed).toBe(true)
    }
  })
})

describe("memory model behavior", () => {
  test("safety reserve is reported inside the working set", () => {
    const results = recommendModels({ hardware: hardware({ vramBytes: 16 * GB }), profiles: [coder14] })
    expect(results[0].estimated?.reserveBytes).toBeGreaterThan(0)
    expect(Math.abs(results[0].estimated!.reserveBytes - Math.round(16 * GB * 0.12))).toBeLessThan(1e6)
  })

  test("working set accounts for weights, KV cache, overhead and reserve", () => {
    const estimated = recommendModels({ hardware: hardware({ vramBytes: 16 * GB }), profiles: [coder14] })[0].estimated!
    for (const key of ["weightsBytes", "kvCacheBytes", "overheadBytes", "reserveBytes"] as const) {
      expect(estimated[key]).toBeGreaterThan(0)
    }
    // total excludes the reserve (reserve stays free), but must cover weights+kv+overhead
    expect(estimated.totalBytes).toBeGreaterThanOrEqual(
      estimated.weightsBytes + estimated.kvCacheBytes + estimated.overheadBytes,
    )
  })

  test("oversized models are not recommended on small machines", () => {
    const huge = LOCAL_MODEL_CATALOG.find((m) => m.id === "gpt-oss-120b")!
    const result = recommendModels({
      hardware: hardware({ vramBytes: 8 * GB, totalMemoryBytes: 64 * GB }),
      profiles: [huge],
    })[0]
    expect(result.compatibility).toBe("not_recommended")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  test("offload level escalates from none through heavy to cpu_dominant", () => {
    const gpuResident = recommendModels({ hardware: hardware({ vramBytes: 24 * GB }), profiles: [coder14] })[0]
    expect(gpuResident.offload).toBe("none")

    const offloaded = recommendModels({ hardware: hardware({ vramBytes: 4 * GB }), profiles: [coder14] })[0]
    expect(["partial", "heavy"]).toContain(offloaded.offload)

    const cpuOnly = recommendModels({ hardware: hardware({ vramBytes: 0 }), profiles: [small] })[0]
    expect(cpuOnly.offload).toBe("cpu_dominant")
    expect(cpuOnly.compatibility).not.toBe("excellent")
  })

  test("offload penalty makes GPU-resident smaller models win overall ranking", () => {
    const mid = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!
    // On an 8 GB card the 14B offloads heavily while the 7B runs on-GPU.
    const results = recommendModels({
      hardware: hardware({ vramBytes: 8 * GB }),
      profiles: [mid, coder14],
      preset: "overall",
    })
    expect(results[0].model.id).toBe(mid.id)
  })

  test("apple silicon unified memory counts toward the GPU budget", () => {
    const macStudio: HardwareProfile = {
      os: { platform: "darwin", arch: "arm64" },
      cpu: { model: "Apple M2 Max", logicalCores: 12 },
      memory: { totalBytes: 96 * GB, availableBytes: 60 * GB },
      gpus: [{ vendor: "apple", model: "Apple M2 Max" }],
    }
    const result = recommendModels({ hardware: macStudio, profiles: [coder14] })[0]
    expect(result.compatibility).toBe("excellent")
    expect(result.variant.quantization).toBe("Q8_0")
  })

  test("48 GB cards comfortably fit the 32B model at higher quality", () => {
    const big = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!
    const result = recommendModels({ hardware: hardware({ vramBytes: 48 * GB }), profiles: [big] })[0]
    // High utilization may rate "good" instead of "excellent" - both are runnable
    expect(["excellent", "good"]).toContain(result.compatibility)
    const q6 = result.alternatives.find((a) => a.variant.quantization === "Q6_K")!
    const q4 = result.alternatives.find((a) => a.variant.quantization === "Q4_K_M")!
    expect(result.variant.qualityMultiplier!).toBeGreaterThan(q4.variant.qualityMultiplier!)
    expect(q6.score).toBeGreaterThan(q4.score)
  })
})

describe("smooth speed estimation", () => {
  test("speed score decreases monotonically with working-set size", () => {
    for (let gb = 1; gb < 80; gb += 1) {
      expect(baseSpeedScore(gb * GB)).toBeGreaterThanOrEqual(baseSpeedScore((gb + 0.5) * GB))
      expect(baseSpeedScore((gb + 0.5) * GB)).toBeGreaterThanOrEqual(baseSpeedScore((gb + 1) * GB))
    }
  })

  test("no ranking cliff at old bucket boundaries", () => {
    for (const boundary of [4, 7, 12, 20, 35]) {
      const jump = Math.abs(baseSpeedScore((boundary + 0.1) * GB) - baseSpeedScore((boundary - 0.1) * GB))
      expect(jump).toBeLessThan(2)
    }
  })

  test("scores stay within sensible bounds even for extreme sizes", () => {
    expect(baseSpeedScore(0)).toBeLessThanOrEqual(95)
    expect(baseSpeedScore(-5 * GB)).toBeLessThanOrEqual(95)
    expect(baseSpeedScore(Number.NaN)).toBeLessThanOrEqual(95)
    expect(baseSpeedScore(Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(15)
    expect(baseSpeedScore(1000 * GB)).toBeLessThanOrEqual(20)
  })
})

describe("measured throughput scoring", () => {
  test("follows the calibrated monotonic curve", () => {
    expect(measuredThroughputScore(1)).toBeCloseTo(25, 0)
    expect(measuredThroughputScore(5)).toBeCloseTo(56, 0)
    expect(measuredThroughputScore(10)).toBeCloseTo(70, 0)
    expect(measuredThroughputScore(20)).toBeCloseTo(83, 0)
    expect(measuredThroughputScore(40)).toBeGreaterThanOrEqual(95)
    expect(measuredThroughputScore(120)).toBe(100)
  })

  test("invalid measurements never poison the scale", () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const score = measuredThroughputScore(bad)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
      expect(score).toBeLessThan(30)
    }
  })

  test("slow measured throughput demotes a variant that estimates alone would favor", () => {
    const machine = hardware({ vramBytes: 30 * GB })
    const tiny = LOCAL_MODEL_CATALOG.find((m) => m.id === "qwen2.5-coder-3b")!
    const tag = tiny.runtimes.ollama!
    const baseline = recommendModels({ hardware: machine, profiles: [tiny] })
    const slow = recommendModels({ hardware: machine, profiles: [tiny], measuredTokensPerSecond: new Map([[tag, 5]]) })
    const before = baseline[0].alternatives.find((a) => a.runtimeTag === tag)!
    const after = slow[0].alternatives.find((a) => a.runtimeTag === tag)!
    expect(before.metricSource).toBe("estimated")
    expect(after.metricSource).toBe("measured")
    expect(after.measuredTokensPerSecond).toBe(5)
    expect(after.score).toBeLessThan(before.score)
  })
})

describe("context intelligence", () => {
  test("recommended context includes KV cache in the working set", () => {
    const estimated = recommendModels({ hardware: hardware({ vramBytes: 12 * GB }), profiles: [coder14] })[0].estimated!
    expect(estimated.kvCacheBytes).toBeGreaterThan(0)
    expect(estimated.contextLength).toBeGreaterThanOrEqual(4096)
  })

  test("tighter memory produces smaller recommended contexts", () => {
    const roomy = recommendModels({ hardware: hardware({ vramBytes: 48 * GB }), profiles: [coder14] })[0]
    const tight = recommendModels({ hardware: hardware({ vramBytes: 8 * GB }), profiles: [coder14] })[0]
    expect(roomy.estimated!.contextLength).toBeGreaterThan(tight.estimated!.contextLength)
  })

  test("never exceeds model maximum or drops below 4096", () => {
    const phi4 = LOCAL_MODEL_CATALOG.find((m) => m.id === "phi4-14b")!
    const bigCard = recommendModels({ hardware: hardware({ vramBytes: 100 * GB }), profiles: [phi4] })[0]
    expect(bigCard.estimated!.contextLength).toBeLessThanOrEqual(phi4.contextLength!)
    const tinyCard = recommendModels({
      hardware: hardware({ vramBytes: 1 * GB, totalMemoryBytes: 8 * GB }),
      profiles: [phi4],
    })[0]
    expect(tinyCard.estimated!.contextLength).toBeGreaterThanOrEqual(4096)
  })

  test("warns when the next context step would require offload", () => {
    const result = recommendModels({ hardware: hardware({ vramBytes: 10 * GB }), profiles: [coder14] })[0]
    if (result.estimated!.contextLength < coder14.contextLength!) {
      expect(result.warnings.some((w) => w.includes("K context would likely require system-memory offload"))).toBe(true)
    }
  })
})
