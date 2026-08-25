import fs from "fs/promises"
import os from "os"
import path from "path"

// Best-effort free-disk detection. Every failure mode returns undefined -
// disk information must never be fatal for Local AI flows.

export function resolveOllamaModelsDir(env?: Record<string, string | undefined>): string {
  const configured = env?.["OLLAMA_MODELS"]
  if (configured) return configured
  return path.join(os.homedir(), ".ollama", "models")
}

export async function freeDiskBytes(directory: string): Promise<number | undefined> {
  try {
    // fs.statfs exists in Node >= 18.15 and Bun; fall back silently elsewhere
    const statfsFn = (fs as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs
    if (!statfsFn) return undefined
    const probe = directory && directory.length > 0 ? directory : process.cwd()
    const stats = await statfsFn(probe)
    if (!stats || !(stats.bsize > 0)) return undefined
    return stats.bavail * stats.bsize
  } catch {
    return undefined
  }
}

// Keep this much headroom beyond the download itself - models expand during
// verification and the system needs room to keep functioning.
const DISK_SAFETY_MARGIN_BYTES = 1e9

export interface DiskCheckResult {
  ok: boolean
  freeBytes?: number
  requiredBytes: number
  message?: string
}

export async function checkDiskSpace(options: {
  directory: string
  downloadBytes?: number
}): Promise<DiskCheckResult> {
  const required = options.downloadBytes ?? 0
  if (!required) return { ok: true, requiredBytes: 0 }
  const free = await freeDiskBytes(options.directory)
  if (free === undefined) return { ok: true, freeBytes: undefined, requiredBytes: required }
  const needed = required + DISK_SAFETY_MARGIN_BYTES
  return {
    ok: free >= needed,
    freeBytes: free,
    requiredBytes: needed,
    message:
      free < needed
        ? `Not enough free disk space: about ${Math.round(required / 1e9)} GB is needed plus safety margin, ${Math.round(free / 1e9)} GB available`
        : undefined,
  }
}
