import path from "path"
import Bun from "bun"
import { Global } from "@opencode-ai/core/global"
import { buildLlamaServerArgs, findFreeLoopbackPort, MANAGED_HOST, resolveLlamaServerExecutable, type ExecutableResolution } from "./launch-config"
import { checkArtifactFile, type ManagedGgufArtifact } from "./gguf"

// Atlas-managed llama.cpp process ownership. Atlas ONLY ever terminates child
// processes it spawned itself, referenced by live object identity - never by
// PID alone. Persisted process rows are declarative history; after a restart
// they are surfaced as stale and their old PIDs are never signalled.

export type ManagedInstanceState = "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed"

export interface ManagedLaunchOverrides {
  contextSize?: number
  gpuLayers?: number
  threads?: number
}

export interface ManagedRuntimeInstance {
  id: string
  artifactID: string
  ownership: "managed"
  state: ManagedInstanceState
  endpoint?: string
  port?: number
  /** Informational only - never used to signal a process */
  pid?: number
  startedAt?: string
  exitedAt?: string
  exitCode?: number
  lastError?: string
}

interface LiveProcess {
  instanceID: string
  artifactID: string
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">
}

export interface LogLine {
  at: number
  source: "stdout" | "stderr"
  line: string
}

export const LOG_BUFFER_LIMIT = 400
const DEFAULT_STOP_GRACE_MS = 5_000
const DEFAULT_STARTUP_DEADLINE_MS = 120_000
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const PORT_ATTEMPTS = 3

export interface ProcessManagerDeps {
  storePath?: string
  now?: () => string
  random?: () => number
  spawn?: (executable: string, args: string[]) => Bun.Subprocess<"ignore", "pipe", "pipe">
  portProbe?: () => Promise<number>
  healthFetch?: (url: string, timeoutMs: number) => Promise<{ ok: boolean }>
  startupDeadlineMs?: number
  stopGraceMs?: number
  /** Overrides applied when neither the caller nor the artifact specifies one */
  defaultContextSize?: number
  /** Test/managed override for real executable discovery */
  executableResolution?: ExecutableResolution
}

function defaultStorePath() {
  return path.join(Global.Path.state, "localai-managed.json")
}

function defaultSpawn(executable: string, args: string[]) {
  // Typed argv only - no shell, no command string, no interpolation
  return Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function defaultHealthFetch(url: string, timeoutMs: number) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { ok: res.ok }
}

interface StoreFile {
  artifacts?: ManagedGgufArtifact[]
  llamaServerPath?: string
  instances?: ManagedRuntimeInstance[]
}

/** States that imply liveness - they must never survive an Atlas restart */
const LIVE_STATES: ManagedInstanceState[] = ["starting", "running", "stopping"]

export function createManagedLlamaCppManager(deps: ProcessManagerDeps = {}) {
  const storePath = deps.storePath ?? defaultStorePath()
  const now = deps.now ?? (() => new Date().toISOString())
  const spawnFn = deps.spawn ?? defaultSpawn
  const healthFetch = deps.healthFetch ?? defaultHealthFetch
  const startupDeadlineMs = deps.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS

  let artifacts: ManagedGgufArtifact[] = []
  let llamaServerPath: string | undefined
  let instanceHistory: ManagedRuntimeInstance[] = []
  const instances = new Map<string, ManagedRuntimeInstance>()
  const live = new Map<string, LiveProcess>()
  const logs = new Map<string, LogLine[]>()
  const locks = new Map<string, Promise<unknown>>()

  async function persist() {
    const file: StoreFile = {
      artifacts,
      ...(llamaServerPath ? { llamaServerPath } : {}),
      // Declarative history only - pid stripped, never re-used for signalling
      instances: instanceHistory.slice(-50).map(({ pid: _pid, ...rest }) => rest),
    }
    try {
      await Bun.write(storePath, JSON.stringify(file, null, 2))
    } catch {}
  }

  async function initialize() {
    let file: StoreFile = {}
    try {
      file = ((await Bun.file(storePath).json()) as StoreFile) ?? {}
    } catch {}
    artifacts = Array.isArray(file.artifacts) ? file.artifacts : []
    llamaServerPath = typeof file.llamaServerPath === "string" ? file.llamaServerPath : undefined
    instanceHistory = Array.isArray(file.instances) ? file.instances : []
    // Anything claiming liveness from a previous session is stale - persisted
    // PIDs are NOT proof of ownership and are never signalled.
    let changed = false
    for (const instance of instanceHistory) {
      if (LIVE_STATES.includes(instance.state)) {
        instance.state = "stopped"
        instance.lastError = "stale - Atlas restarted"
        changed = true
      }
    }
    if (changed) await persist()
  }

  function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    locks.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  function recordLog(instanceID: string, source: "stdout" | "stderr", line: string) {
    const buffer = logs.get(instanceID) ?? []
    buffer.push({ at: Date.now(), source, line })
    while (buffer.length > LOG_BUFFER_LIMIT) buffer.shift()
    logs.set(instanceID, buffer)
  }

  function watchStream(instanceID: string, stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr") {
    void (async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split("\n")
          buffer = parts.pop() ?? ""
          for (const line of parts) {
            if (line.trim()) recordLog(instanceID, source, line)
          }
        }
        if (buffer.trim()) recordLog(instanceID, source, buffer)
      } catch {}
    })()
  }

  function persistable(instance: ManagedRuntimeInstance): ManagedRuntimeInstance {
    const { pid: _pid, ...rest } = instance
    return rest
  }

  function commit(instance: ManagedRuntimeInstance) {
    instances.set(instance.id, instance)
    const index = instanceHistory.findIndex((entry) => entry.id === instance.id)
    if (index >= 0) instanceHistory[index] = persistable(instance)
    else instanceHistory.push(persistable(instance))
  }

  function attachChild(instance: ManagedRuntimeInstance, liveProc: LiveProcess) {
    if (liveProc.proc.stdout) watchStream(instance.id, liveProc.proc.stdout, "stdout")
    if (liveProc.proc.stderr) watchStream(instance.id, liveProc.proc.stderr, "stderr")

    void liveProc.proc.exited.then((code) => {
      // Only react if this exact child is still the tracked owner
      if (live.get(instance.id) !== liveProc) return
      live.delete(instance.id)
      const current = instances.get(instance.id)
      if (!current) return
      if (current.state === "starting") {
        current.exitCode = code ?? undefined
        current.exitedAt = now()
        current.lastError =
          current.lastError ?? `llama-server exited during startup (code ${code === null ? "signal" : code})`
        // Startup-loop decides retry/fail; mark failed unless already resolved
        if (instances.get(instance.id)?.state === "starting") {
          current.state = "failed"
          commit(current)
          void persist()
        }
      } else if (current.state === "running") {
        current.state = "crashed"
        current.exitCode = code ?? undefined
        current.exitedAt = now()
        current.lastError = `llama-server crashed (code ${code === null ? "signal" : code})`
        commit(current)
        void persist()
      } else if (current.state === "stopping") {
        current.state = "stopped"
        current.exitCode = code ?? undefined
        current.exitedAt = now()
        commit(current)
        void persist()
      }
    })
  }

  function killOwned(liveProc: LiveProcess) {
    try {
      liveProc.proc.kill()
    } catch {}
  }

  async function terminateOwned(liveProc: LiveProcess) {
    killOwned(liveProc)
    const finished = await Promise.race([
      liveProc.proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), stopGraceMs)),
    ])
    if (!finished && live.get(liveProc.instanceID) === liveProc) {
      // Same owned child ignored graceful termination - force kill
      try {
        liveProc.proc.kill(9)
      } catch {}
      await liveProc.proc.exited.catch(() => {})
    }
  }

  async function pollHealth(endpoint: string): Promise<boolean> {
    try {
      return (await healthFetch(`${endpoint}/health`, HEALTH_REQUEST_TIMEOUT_MS)).ok
    } catch {
      return false
    }
  }

  function activeForArtifact(artifactID: string): ManagedRuntimeInstance | undefined {
    return [...instances.values()].find(
      (entry) => entry.artifactID === artifactID && LIVE_STATES.includes(entry.state),
    )
  }

  async function startArtifact(
    artifact: ManagedGgufArtifact,
    launchOptions?: ManagedLaunchOverrides,
  ): Promise<ManagedRuntimeInstance> {
    const resolution =
      deps.executableResolution ?? (await resolveLlamaServerExecutable(llamaServerPath))
    if (!resolution.found) throw new Error(resolution.reason)

    const fileStatus = await checkArtifactFile(artifact)
    if (!fileStatus.exists) throw new Error(`Model file missing: ${artifact.path}`)

    const existing = activeForArtifact(artifact.id)
    if (existing) return existing

    const gpuLayers = launchOptions?.gpuLayers ?? artifact.launchOverrides?.gpuLayers
    const threads = launchOptions?.threads ?? artifact.launchOverrides?.threads
    const overrides: ManagedLaunchOverrides = {
      contextSize:
        launchOptions?.contextSize ??
        artifact.launchOverrides?.contextSize ??
        deps.defaultContextSize ??
        8192,
      ...(gpuLayers !== undefined ? { gpuLayers } : {}),
      ...(threads !== undefined ? { threads } : {}),
    }

    const instance: ManagedRuntimeInstance = {
      id: `inst-${Date.now().toString(36)}-${Math.floor((deps.random?.() ?? Math.random()) * 1e6).toString(36)}`,
      artifactID: artifact.id,
      ownership: "managed",
      state: "starting",
      startedAt: now(),
    }
    commit(instance)

    let attempt = 0
    let lastBindishError: string | undefined
    while (attempt < PORT_ATTEMPTS) {
      attempt += 1
      const port = await findFreeLoopbackPort(deps.portProbe)
      const endpoint = `http://${MANAGED_HOST}:${port}`
      instance.endpoint = endpoint
      instance.port = port

      const args = buildLlamaServerArgs({
        modelPath: artifact.path,
        port,
        ...overrides,
      })

      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
      try {
        proc = spawnFn(resolution.path, args)
      } catch (error) {
        instance.state = "failed"
        instance.exitedAt = now()
        instance.lastError = `Failed to start llama-server: ${error instanceof Error ? error.message : String(error)}`
        commit(instance)
        void persist()
        throw new Error(instance.lastError)
      }

      instance.pid = proc.pid > 0 ? proc.pid : undefined
      const liveProc: LiveProcess = { instanceID: instance.id, artifactID: artifact.id, proc }
      live.set(instance.id, liveProc)
      recordLog(instance.id, "stderr", `[atlas] llama-server spawned (${path.basename(resolution.path)}) on ${endpoint}`)
      attachChild(instance, liveProc)

      const deadline = Date.now() + startupDeadlineMs
      let ready = false
      let exitedEarly = false
      while (Date.now() < deadline) {
        if (!live.has(instance.id)) {
          exitedEarly = true
          break
        }
        if (await pollHealth(endpoint)) {
          ready = true
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
      }

      if (ready) {
        instance.state = "running"
        instance.lastError = undefined
        commit(instance)
        void persist()
        return { ...instance }
      }

      if (exitedEarly && attempt < PORT_ATTEMPTS) {
        // Likely bind collision on the chosen port - bounded retry elsewhere
        const stillOwnedEarly = live.get(instance.id)
        if (stillOwnedEarly) {
          await terminateOwned(stillOwnedEarly)
          live.delete(instance.id)
        }
        lastBindishError = instance.lastError
        instance.state = "starting"
        instance.lastError = undefined
        instance.exitCode = undefined
        commit(instance)
        continue
      }

      // Hard failure: label BEFORE terminating so the exit handler keeps the
      // authoritative reason instead of overwriting it with a kill artifact.
      const timedOut = !exitedEarly
      instance.state = "failed"
      instance.exitedAt = now()
      if (timedOut) {
        instance.lastError = "startup timed out before the server became healthy"
      } else if (!instance.lastError) {
        instance.lastError = "llama-server exited before becoming healthy"
      }
      commit(instance)

      const stillOwned = live.get(instance.id)
      if (stillOwned) {
        await terminateOwned(stillOwned)
        live.delete(instance.id)
      }
      void persist()
      throw new Error(instance.lastError ?? "failed to start llama-server")
    }

    instance.state = "failed"
    instance.exitedAt = now()
    instance.lastError = "Could not bind a port after several attempts"
    commit(instance)
    void persist()
    throw new Error(instance.lastError)
  }

  async function stopInstance(instanceID: string, reason?: string): Promise<ManagedRuntimeInstance> {
    const instance = instances.get(instanceID) ?? instanceHistory.find((entry) => entry.id === instanceID)
    if (!instance) throw new Error("Unknown instance")

    const liveProc = live.get(instanceID)
    if (!liveProc) {
      // Includes stale rows recovered after restart: idempotent, nothing to signal
      if (LIVE_STATES.includes(instance.state)) {
        instance.state = "stopped"
        instance.exitedAt = now()
        commit(instance)
        void persist()
      }
      return { ...instance }
    }

    const wasStarting = instance.state === "starting"
    instance.state = "stopping"
    commit(instance)
    await terminateOwned(liveProc)
    live.delete(instanceID)

    const current = instances.get(instanceID)!
    if (current.state === "stopping") {
      current.state = "stopped"
      current.exitedAt = now()
      if (wasStarting) current.lastError = reason ?? "cancelled"
      commit(current)
      void persist()
      return { ...current }
    }
    return { ...current }
  }

  return {
    initialize,

    getArtifacts(): ManagedGgufArtifact[] {
      return [...artifacts]
    },

    async addArtifact(artifact: ManagedGgufArtifact) {
      artifacts = [...artifacts.filter((entry) => entry.id !== artifact.id), artifact]
      await persist()
    },

    async removeArtifact(id: string): Promise<{ ok: boolean; error?: string }> {
      const active = activeForArtifact(id)
      if (active) return { ok: false, error: "Stop the running model first" }
      const before = artifacts.length
      artifacts = artifacts.filter((entry) => entry.id !== id)
      if (artifacts.length === before) return { ok: false, error: "Unknown artifact" }
      await persist()
      return { ok: true }
    },

    setLlamaServerPath(executablePath: string | undefined) {
      llamaServerPath = executablePath
      void persist()
    },

    getLlamaServerPath(): string | undefined {
      return llamaServerPath
    },

    resolveExecutable() {
      return resolveLlamaServerExecutable(llamaServerPath)
    },

    /** Serialized per artifact: double-start / stop+start cannot interleave */
    start(artifactID: string, launchOptions?: ManagedLaunchOverrides): Promise<ManagedRuntimeInstance> {
      const artifact = artifacts.find((entry) => entry.id === artifactID)
      if (!artifact) return Promise.reject(new Error("Unknown artifact"))
      return serialize(`artifact:${artifactID}`, () => startArtifact(artifact, launchOptions))
    },

    /** Safe against arbitrary IDs: only owned live children are ever signalled */
    stop(instanceID: string, reason?: string): Promise<ManagedRuntimeInstance> {
      return serialize(`instance:${instanceID}`, () => stopInstance(instanceID, reason))
    },

    restart(instanceID: string, launchOptions?: ManagedLaunchOverrides): Promise<ManagedRuntimeInstance> {
      const instance = instances.get(instanceID)
      if (!instance) return Promise.reject(new Error("Unknown instance"))
      return serialize(`artifact:${instance.artifactID}`, async () => {
        await stopInstance(instanceID, "restarting")
        const artifact = artifacts.find((entry) => entry.id === instance.artifactID)
        if (!artifact) throw new Error("Registered model no longer exists")
        return startArtifact(artifact, launchOptions)
      })
    },

    listInstances(): ManagedRuntimeInstance[] {
      const transientIDs = new Set(instances.keys())
      return [
        ...[...instances.values()].map((entry) => ({ ...entry })),
        ...instanceHistory.filter((entry) => !transientIDs.has(entry.id)).map((entry) => ({ ...entry })),
      ]
    },

    getInstance(instanceID: string): ManagedRuntimeInstance | undefined {
      const transient = instances.get(instanceID)
      return transient ? { ...transient } : instanceHistory.find((entry) => entry.id === instanceID)
    },

    /** Healthy/starting instance serving an artifact right now */
    runningInstanceForArtifact(artifactID: string): ManagedRuntimeInstance | undefined {
      const active = activeForArtifact(artifactID)
      return active ? { ...active } : undefined
    },

    logsFor(instanceID: string, limit = 100): LogLine[] {
      return (logs.get(instanceID) ?? []).slice(-limit)
    },

    /** Normal-shutdown cleanup: stops every child Atlas owns. Best-effort -
     * hard OS kills/power loss cannot run cleanup hooks. */
    async dispose() {
      const owned = [...live.values()]
      await Promise.all(
        owned.map(async (proc) => {
          try {
            await terminateOwned(proc)
          } catch {}
          live.delete(proc.instanceID)
        }),
      )
    },

    /** Synchronous last-resort cleanup for exit events that cannot await */
    disposeSync() {
      for (const proc of [...live.values()]) {
        try {
          proc.proc.kill()
        } catch {}
      }
      live.clear()
    },
  }
}

export type ManagedLlamaCppManager = ReturnType<typeof createManagedLlamaCppManager>

let singleton: ManagedLlamaCppManager | undefined

/** Process-scoped manager consumed by discovery/provider integration */
export function getManagedLlamaCppManager(): ManagedLlamaCppManager {
  singleton ??= createManagedLlamaCppManager()
  return singleton
}
