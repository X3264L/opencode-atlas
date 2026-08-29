import fs from "fs/promises"
import { accessSync, constants } from "node:fs"
import { createServer } from "node:net"
import path from "path"

// Atlas-managed llama-server launch plumbing. Everything here is typed and
// shell-free: the executable is spawned with an argument array, never a
// command string. User-controlled values (model paths) are passed as single
// arguments and never interpreted as shell syntax.

export interface LlamaServerExecutable {
  path: string
  source: "configured" | "path-lookup" | "common-location"
}

export type ExecutableResolution =
  | ({ found: true } & LlamaServerExecutable)
  | { found: false; reason: string }

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

const COMMON_LOCATIONS = [
  "/usr/local/bin/llama-server",
  "/opt/homebrew/bin/llama-server",
  "/usr/bin/llama-server",
]

export interface ExecutableLookupDeps {
  which?: (name: string) => string | undefined
  existsFile?: (candidate: string) => Promise<boolean>
  platform?: string
}

export function findExecutable(name: string): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  const candidates = path.isAbsolute(name)
    ? [name]
    : pathEntries.flatMap((entry) => extensions.map((extension) => path.join(entry, name + extension)))
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * Locates llama-server without downloading anything. Order:
 * explicit configured path → PATH lookup → a few common local install spots.
 */
export async function resolveLlamaServerExecutable(
  configuredPath: string | undefined,
  deps: ExecutableLookupDeps = {},
): Promise<ExecutableResolution> {
  const existsFile = deps.existsFile ?? isExecutableFile
  const which = deps.which ?? findExecutable

  if (configuredPath) {
    if (await existsFile(configuredPath)) {
      return { found: true, path: configuredPath, source: "configured" }
    }
    return { found: false, reason: "Configured llama-server path does not exist" }
  }

  const onPath = which("llama-server")
  if (onPath && (await existsFile(onPath))) {
    return { found: true, path: onPath, source: "path-lookup" }
  }

  for (const candidate of COMMON_LOCATIONS) {
    if (await existsFile(candidate)) {
      return { found: true, path: candidate, source: "common-location" }
    }
  }

  // Windows installs commonly live under Program Files or user-local tools
  if ((deps.platform ?? process.platform) === "win32") {
    const candidates = [
      path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "llama.cpp", "bin", "llama-server.exe"),
      path.join("C:", "Program Files", "llama.cpp", "bin", "llama-server.exe"),
    ].filter((entry) => entry.length > "llama-server.exe".length)
    for (const candidate of candidates) {
      if (await existsFile(candidate)) {
        return { found: true, path: candidate, source: "common-location" }
      }
    }
  }

  return { found: false, reason: "llama-server executable not found - configure its path in /local" }
}

/** Loopback-only by default; managed servers are never exposed to the LAN */
export const MANAGED_HOST = "127.0.0.1"

export interface LlamaServerLaunchConfig {
  modelPath: string
  host?: string
  port: number
  contextSize?: number
  gpuLayers?: number
  threads?: number
}

/**
 * The single place where llama-server CLI flags are constructed. Values must
 * come from validated/typed sources - this function never accepts raw strings
 * that could smuggle extra flags.
 */
export function buildLlamaServerArgs(config: LlamaServerLaunchConfig): string[] {
  const args = ["-m", config.modelPath, "--host", config.host ?? MANAGED_HOST, "--port", String(config.port)]
  if (config.contextSize !== undefined) args.push("--ctx-size", String(Math.floor(config.contextSize)))
  if (config.gpuLayers !== undefined) args.push("-ngl", String(Math.floor(config.gpuLayers)))
  if (config.threads !== undefined) args.push("--threads", String(Math.floor(config.threads)))
  return args
}

/**
 * Finds a free loopback port via the OS: bind an ephemeral listener, note the
 * port, release it. There is an inherent race until the child binds; the
 * process manager detects bind failure through startup health and retries.
 */
export async function findFreeLoopbackPort(probe?: () => Promise<number>): Promise<number> {
  if (probe) return probe()
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: MANAGED_HOST, port: 0 }, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : undefined
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (port === undefined) throw new Error("Failed to determine loopback port")
  return port
}
