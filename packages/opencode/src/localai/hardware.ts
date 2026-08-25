import os from "os"
import fs from "fs/promises"
import path from "path"

export interface GPUProfile {
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown"
  model: string
  vramBytes?: number
  architecture?: string
}

export interface HardwareProfile {
  os: {
    platform: string
    arch: string
  }
  cpu: {
    model?: string
    physicalCores?: number
    logicalCores?: number
  }
  memory: {
    totalBytes: number
    availableBytes?: number
  }
  gpus: GPUProfile[]
}

export type CommandRunner = (cmd: string, args: string[], timeoutMs?: number) => Promise<string | undefined>

const COMMAND_TIMEOUT_MS = 5_000

export async function runCommand(cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: timeoutMs,
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0) return undefined
    return output
  } catch {
    return undefined
  }
}

function resolveCommand(name: string) {
  return Bun.which(name) ?? undefined
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

export function classifyGpuVendor(name: string): GPUProfile["vendor"] {
  const value = name.toLowerCase()
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(value)) return "nvidia"
  if (/radeon|\bamd\b|rx \d|vega|navi|polaris/.test(value)) return "amd"
  if (/intel|arc |iris|uhd graphics|hd graphics/.test(value)) return "intel"
  if (/apple|m[1-4]\b/.test(value)) return "apple"
  return "unknown"
}

// Windows reports AdapterRAM as a 32-bit value, which saturates just below
// 4 GiB. Readings near the ceiling are artifacts, so only trust clearly
// smaller values.
const MAX_WINDOWS_ADAPTER_RAM_BYTES = 3.5 * 1024 * 1024 * 1024

const VIRTUAL_GPU_PATTERN = /basic|hyper-?v|vmware|virtualbox|qxl|cirrus|microsoft remote/i

export function parseNvidiaSmiOutput(output: string): GPUProfile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [name, vramMib, computeCap] = line.split(",").map((part) => part.trim())
      if (!name || VIRTUAL_GPU_PATTERN.test(name)) return []
      return [
        {
          vendor: "nvidia" as const,
          model: name,
          vramBytes: Number(vramMib) > 0 ? Math.round(Number(vramMib) * 1024 * 1024) : undefined,
          architecture: computeCap ? `compute capability ${computeCap}` : undefined,
        },
      ]
    })
}

async function probeNvidia(exec: CommandRunner): Promise<GPUProfile[]> {
  const cmd = resolveCommand("nvidia-smi")
  if (!cmd) return []
  const output = await exec(cmd, ["--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits"])
  if (!output) return []
  return parseNvidiaSmiOutput(output)
}

export function parseWindowsVideoControllers(output: string): GPUProfile[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.flatMap((item: { Name?: string; AdapterRAM?: number }) => {
    const name = item.Name?.trim()
    if (!name || VIRTUAL_GPU_PATTERN.test(name)) return []
    const ram = item.AdapterRAM
    const vramBytes = typeof ram === "number" && ram > 0 && ram < MAX_WINDOWS_ADAPTER_RAM_BYTES ? ram : undefined
    return [{ vendor: classifyGpuVendor(name), model: name, ...(vramBytes ? { vramBytes } : {}) }]
  })
}

async function probeWindowsGpus(exec: CommandRunner): Promise<GPUProfile[]> {
  const cmd = resolveCommand("powershell") ?? resolveCommand("pwsh")
  if (!cmd) return []
  const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"
  const output = await exec(cmd, ["-NoProfile", "-NonInteractive", "-Command", script])
  if (!output) return []
  return parseWindowsVideoControllers(output)
}

async function probeLinuxGpus(): Promise<GPUProfile[]> {
  // Best-effort sysfs scan; amdgpu exposes VRAM directly.
  const entries = await safe(() => fs.readdir("/sys/class/drm"), [])
  const cards = entries.filter((entry) => /^card\d+$/.test(entry)).sort()
  const results: GPUProfile[] = []
  for (const card of cards) {
    const base = path.join("/sys/class/drm", card, "device")
    const vendorRaw = await safe(() => fs.readFile(path.join(base, "vendor"), "utf8"), "")
    const vendorId = vendorRaw.trim().toLowerCase()
    if (vendorId !== "0x10de" && vendorId !== "0x1002" && vendorId !== "0x8086") continue
    const vendor = vendorId === "0x10de" ? "nvidia" : vendorId === "0x1002" ? "amd" : "intel"
    let model = await safe(async () => {
      for (const file of ["product_name", "label", "device"]) {
        const content = await fs.readFile(path.join(base, file), "utf8")
        const value = content.trim()
        if (value && !value.startsWith("0x")) return value
      }
      return ""
    }, "")
    if (!model) continue
    if (VIRTUAL_GPU_PATTERN.test(model)) continue
    const vramRaw = await safe(() => fs.readFile(path.join(base, "mem_info_vram_total"), "utf8"), "")
    const vramBytes = Number(vramRaw.trim()) > 0 ? Number(vramRaw.trim()) : undefined
    results.push({ vendor, model, ...(vramBytes ? { vramBytes } : {}) })
  }
  return results
}

async function probeAppleChip(exec: CommandRunner) {
  const output = await exec("sysctl", ["-n", "machdep.cpu.brand_string"])
  return output?.trim() || undefined
}

export async function detectHardware(exec: CommandRunner = runCommand): Promise<HardwareProfile> {
  const platform = process.platform

  const gpus = await (async () => {
    if (platform === "darwin") {
      if (process.arch === "arm64") {
        const chip = await probeAppleChip(exec)
        return [
          {
            vendor: "apple" as const,
            model: chip ?? "Apple Silicon",
          },
        ]
      }
      return [] satisfies GPUProfile[]
    }
    const nvidia = await probeNvidia(exec)
    const others = platform === "win32" ? await probeWindowsGpus(exec) : await probeLinuxGpus()
    const merged = [...nvidia]
    for (const gpu of others) {
      // nvidia-smi already covers discrete NVIDIA GPUs with reliable VRAM numbers
      if (gpu.vendor === "nvidia" && nvidia.length > 0) continue
      merged.push(gpu)
    }
    return merged
  })()

  const cpuModel = platform === "darwin" ? ((await probeAppleChip(exec)) ?? os.cpus()[0]?.model) : os.cpus()[0]?.model

  return {
    os: { platform, arch: process.arch },
    cpu: {
      ...(cpuModel ? { model: cpuModel } : {}),
      logicalCores: os.cpus().length,
    },
    memory: {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
    },
    gpus,
  }
}

// Apple Silicon has unified memory; the GPU can typically address most of it
// but the OS and other processes need room too.
export function effectiveVramBytes(profile: HardwareProfile): number {
  const discrete = profile.gpus
    .filter((gpu) => gpu.vendor === "nvidia" || gpu.vendor === "amd" || gpu.vendor === "intel")
    .reduce((sum, gpu) => sum + (gpu.vramBytes ?? 0), 0)
  if (discrete > 0) return discrete
  const apple = profile.gpus.some((gpu) => gpu.vendor === "apple")
  if (apple) return Math.round(profile.memory.totalBytes * 0.7)
  return 0
}
