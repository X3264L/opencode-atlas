import { describe, expect, test } from "bun:test"
import {
  classifyGpuVendor,
  detectHardware,
  parseNvidiaSmiOutput,
  parseWindowsVideoControllers,
} from "@/localai/hardware"

describe("gpu vendor classification", () => {
  test("classifies major vendors", () => {
    expect(classifyGpuVendor("NVIDIA GeForce RTX 4090")).toBe("nvidia")
    expect(classifyGpuVendor("AMD Radeon RX 7900 XTX")).toBe("amd")
    expect(classifyGpuVendor("Intel(R) Arc(TM) A770")).toBe("intel")
    expect(classifyGpuVendor("Intel Iris Xe")).toBe("intel")
    expect(classifyGpuVendor("Some Random Adapter")).toBe("unknown")
  })
})

describe("nvidia-smi parsing", () => {
  test("parses multiple GPUs with VRAM", () => {
    const gpus = parseNvidiaSmiOutput("NVIDIA GeForce RTX 4070, 12282, 8.9\nNVIDIA GeForce RTX 3090, 24576, 8.6\n")
    expect(gpus).toHaveLength(2)
    expect(gpus[0].model).toBe("NVIDIA GeForce RTX 4070")
    expect(gpus[0].vramBytes).toBe(Math.round(12282 * 1024 * 1024))
    expect(gpus[1].model).toBe("NVIDIA GeForce RTX 3090")
    expect(gpus[1].architecture).toBe("compute capability 8.6")
  })

  test("skips malformed lines and virtual adapters", () => {
    const gpus = parseNvidiaSmiOutput("\nHyper-V Video, 1024, 8.0\n")
    expect(gpus).toHaveLength(0)
  })
})

describe("windows video controller parsing", () => {
  test("parses single and multiple controllers", () => {
    const json = JSON.stringify([
      { Name: "NVIDIA GeForce RTX 4080 SUPER", AdapterRAM: 4293918720 },
      { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
    ])
    const gpus = parseWindowsVideoControllers(json)
    expect(gpus).toHaveLength(1)
    expect(gpus[0].vendor).toBe("nvidia")
  })

  test("drops saturated AdapterRAM readings above 4 GiB boundary trust", () => {
    const json = JSON.stringify([{ Name: "AMD Radeon RX 9070 XT", AdapterRAM: 17179869184 }])
    const gpus = parseWindowsVideoControllers(json)
    expect(gpus).toHaveLength(1)
    // uint32-saturated values are unreliable; VRAM is omitted rather than wrong
    expect(gpus[0].vramBytes).toBeUndefined()
  })

  test("returns empty on malformed output", () => {
    expect(parseWindowsVideoControllers("not json")).toHaveLength(0)
  })
})

describe("hardware detection failure handling", () => {
  test("never throws when command runners fail", async () => {
    const profile = await detectHardware(async () => undefined)
    expect(profile.os.platform).toBe(process.platform)
    expect(profile.os.arch).toBe(process.arch)
    expect(profile.memory.totalBytes).toBeGreaterThan(0)
    expect(profile.gpus).toEqual([])
    expect(profile.cpu.logicalCores).toBeGreaterThan(0)
  })
})
