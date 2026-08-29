import path from "path"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { Global } from "@opencode-ai/core/global"
import { buildLlamaServerArgs, findFreeLoopbackPort, MANAGED_HOST, resolveLlamaServerExecutable, type ExecutableResolution } from "./launch-config"
import { checkArtifactFile, type ManagedGgufArtifact } from "./gguf"

// Atlas-managed llama.cpp process ownership. Atlas ONLY ever terminates child
// processes it spawned itself, referenced by live object identity - never by
// PID alone. Persisted process rows are declarative history; after a restart
// they are surfaced as stale and their old PIDs are never signalled.
//
// Eventing contract: meaningful transitions surface through the injected
// `emit` callback (lifecycle + batched log lines). `state` stays a small
// persisted machine; transient detail lives in `phase`. Each launch bumps
// `generation`, so stale async events from older runs are identifiable.

export type ManagedInstanceState = "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed"

export type ManagedInstancePhase =
  | "port_selected"
  | "spawning"
  | "loading_model"
  | "health_wait"
  | "ready"
  | "cancelled"

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
  /** Bumped on every launch - stale async events from older runs are ignored */
  generation: number
  phase?: ManagedInstancePhase
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
  proc: ManagedChildProcess
}

interface ManagedChildProcess {
  pid?: number
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
  exited: Promise<number | null>
  kill(signal?: number): void
}

export interface LogLine {
  at: number
  source: "stdout" | "stderr"
  line: string
}

/** Framework-free event union consumed by the Local AI control plane */
export type ManagedManagerEvent =
  | {
      kind: "lifecycle"
      runtimeID: string
      instanceID: string
      artifactID: string
      state: ManagedInstanceState
      phase?: ManagedInstancePhase
      generation: number
      exitCode?: number
      reason?: string
      stderrTail?: string[]
    }
  | {
      kind: "log"
      runtimeID: string
      instanceID: string
      lines: LogLine[]
    }

export const LOG_BUFFER_LIMIT = 400
const LOG_FLUSH_INTERVAL_MS = 150
const LOG_MAX_LINES_PER_EVENT = 80
const DEFAULT_STOP_GRACE_MS = 5_000
const DEFAULT_STARTUP_DEADLINE_MS = 120_000
const HEALTH_REQUEST_TIMEOUT_MS = 2_000
const PORT_ATTEMPTS = 3

export interface ProcessManagerDeps {
  storePath?: string
  now?: () => string
  random?: () => number
  spawn?: (executable: string, args: string[]) => ManagedChildProcess
  portProbe?: () => Promise<number>
  healthFetch?: (url: string, timeoutMs: number) => Promise<{ ok: boolean }>
  startupDeadlineMs?: number
  stopGraceMs?: number
  defaultContextSize?: number
  executableResolution?: ExecutableResolution
  /** Receives lifecycle/log events; must never throw */
  emit?: (event: ManagedManagerEvent) => void
}

function defaultStorePath() {
  return path.join(Global.Path.state, "localai-managed.json")
}

function defaultSpawn(executable: string, args: string[]) {
  // Typed argv only - no shell, no command string, no interpolation
  const child = spawn(executable, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null))
    child.once("close", (code) => resolve(code))
  })
  return {
    pid: child.pid ?? undefined,
    stdout: child.stdout ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>) : undefined,
    stderr: child.stderr ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>) : undefined,
    exited,
    kill: (signal?: number) => {
      child.kill(signal)
    },
  }
}

async function defaultHealthFetch(url: string, timeoutMs: number) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { ok: res.ok }
}

interface StoreFile {
  artifacts?: ManagedGgufArtifact[]
  llamaServerPath?: string
  instances?: Omit<ManagedRuntimeInstance, "pid">[]
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
  let instanceHistory: Omit<ManagedRuntimeInstance, "pid">[] = []
  const instances = new Map<string, ManagedRuntimeInstance>()
  const live = new Map<string, LiveProcess>()
  const logs = new Map<string, LogLine[]>()
  const pendingLogs = new Map<string, LogLine[]>()
  const locks = new Map<string, Promise<unknown>>()
  const terminalWaiters = new Map<string, (instance: ManagedRuntimeInstance) => void>()
  const spawnedWaiters = new Map<string, Array<() => void>>()
  let logFlushTimer: ReturnType<typeof setInterval> | undefined

  function emitLifecycle(
    instance: ManagedRuntimeInstance,
    extra?: { exitCode?: number; reason?: string; stderrTail?: string[] },
  ) {
    deps.emit?.({
      kind: "lifecycle",
      runtimeID: "llamacpp",
      instanceID: instance.id,
      artifactID: instance.artifactID,
      state: instance.state,
      ...(instance.phase ? { phase: instance.phase } : {}),
      generation: instance.generation,
      ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.stderrTail ? { stderrTail: extra.stderrTail } : {}),
    })
  }

  function ensureLogFlushing() {
    if (logFlushTimer) return
    logFlushTimer = setInterval(() => {
      for (const [instanceID, queued] of pendingLogs) {
        while (queued.length > 0) {
          const batch = queued.splice(0, LOG_MAX_LINES_PER_EVENT)
          deps.emit?.({ kind: "log", runtimeID: "llamacpp", instanceID, lines: batch })
        }
      }
    }, LOG_FLUSH_INTERVAL_MS)
    ;(logFlushTimer as unknown as { unref?: () => void }).unref?.()
  }

  function recordLog(instanceID: string, source: "stdout" | "stderr", line: string) {
    const entry: LogLine = { at: Date.now(), source, line }
    const buffer = logs.get(instanceID) ?? []
    buffer.push(entry)
    while (buffer.length > LOG_BUFFER_LIMIT) buffer.shift()
    logs.set(instanceID, buffer)
    const queued = pendingLogs.get(instanceID) ?? []
    queued.push(entry)
    while (queued.length > LOG_BUFFER_LIMIT) queued.shift()
    pendingLogs.set(instanceID, queued)
    ensureLogFlushing()
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

  async function persist() {
    const file: StoreFile = {
      artifacts,
      ...(llamaServerPath ? { llamaServerPath } : {}),
      instances: instanceHistory.slice(-50),
    }
    try {
      await mkdir(path.dirname(storePath), { recursive: true })
      await writeFile(storePath, JSON.stringify(file, null, 2))
    } catch {}
  }

  async function initialize() {
    let file: StoreFile = {}
    try {
      file = (JSON.parse(await readFile(storePath, "utf8")) as StoreFile) ?? {}
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

  /** Serialized per artifact or per instance key */
  function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    locks.set(
      key,
      next.catch(() => {}),
    )
    return next
  }

  function commit(instance: ManagedRuntimeInstance) {
    instances.set(instance.id, instance)
    const index = instanceHistory.findIndex((entry) => entry.id === instance.id)
    const { pid: _pid, ...rest } = instance
    if (index >= 0) instanceHistory[index] = rest
    else instanceHistory.push(rest)
  }

  function resolveTerminal(instance: ManagedRuntimeInstance) {
    const waiter = terminalWaiters.get(instance.id)
    if (waiter) {
      terminalWaiters.delete(instance.id)
      waiter({ ...instance })
    }
    notifySpawned(instance.id)
  }

  function notifySpawned(instanceID: string) {
    const list = spawnedWaiters.get(instanceID)
    if (!list) return
    spawnedWaiters.delete(instanceID)
    for (const fn of list) fn()
  }

  /** Resolves once the instance has an endpoint (spawn done) or reached a
   * terminal state - used so start() can return usable identity quickly. */
  function waitForSpawned(instanceID: string): Promise<void> {
    const current = instances.get(instanceID)
    if (current && (current.endpoint !== undefined || !LIVE_STATES.includes(current.state))) return Promise.resolve()
    return new Promise((resolve) => {
      const list = spawnedWaiters.get(instanceID) ?? []
      list.push(resolve)
      spawnedWaiters.set(instanceID, list)
    })
  }

  function stderrTail(instanceID: string, count = 5): string[] | undefined {
    const buffer = logs.get(instanceID)
    if (!buffer) return undefined
    return buffer.slice(-count).map((line) => (line.line.length > 200 ? `${line.line.slice(0, 200)}…` : line.line))
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
          current.lastError ??
          `llama-server exited during startup (code ${code === null ? "signal" : code})`
        current.phase = undefined
        commit(current)
        emitLifecycle(current, {
          exitCode: current.exitCode,
          reason: current.lastError,
          stderrTail: stderrTail(current.id),
        })
        resolveTerminal(current)
        void persist()
        return
      }

      if (current.state === "running") {
        current.state = "crashed"
        current.exitCode = code ?? undefined
        current.exitedAt = now()
        current.lastError = `llama-server crashed (code ${code === null ? "signal" : code})`
        current.phase = undefined
        commit(current)
        emitLifecycle(current, {
          exitCode: current.exitCode,
          reason: current.lastError,
          stderrTail: stderrTail(current.id),
        })
        resolveTerminal(current)
        void persist()
        return
      }

      if (current.state === "stopping") {
        current.state = "stopped"
        current.exitCode = code ?? undefined
        current.exitedAt = now()
        current.phase = undefined
        commit(current)
        emitLifecycle(current)
        resolveTerminal(current)
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

    /**
   * Runs the full launch lifecycle to terminal state. Called in the
   * background by `start()` - callers who need the outcome attach through
   * `waitForTerminal` instead of blocking the start request.
   */
  async function runLifecycle(
    artifact: ManagedGgufArtifact,
    instance: ManagedRuntimeInstance,
    launchOptions?: ManagedLaunchOverrides,
  ): Promise<ManagedRuntimeInstance> {
    const gpuLayers = launchOptions?.gpuLayers ?? artifact.launchOverrides?.gpuLayers
    const threads = launchOptions?.threads ?? artifact.launchOverrides?.threads
    const overrides: ManagedLaunchOverrides = {
      contextSize:
        launchOptions?.contextSize ?? artifact.launchOverrides?.contextSize ?? deps.defaultContextSize ?? 8192,
      ...(gpuLayers !== undefined ? { gpuLayers } : {}),
      ...(threads !== undefined ? { threads } : {}),
    }

    let attempt = 0
    while (attempt < PORT_ATTEMPTS) {
      attempt += 1
      const port = await findFreeLoopbackPort(deps.portProbe)
      const endpoint = `http://${MANAGED_HOST}:${port}`
      instance.endpoint = endpoint
      instance.port = port
      notifySpawned(instance.id)
      instance.phase = "port_selected"
      emitLifecycle(instance)
      if (instances.get(instance.id)?.state !== "starting") return { ...instance }

      instance.phase = "spawning"
      emitLifecycle(instance)
      const args = buildLlamaServerArgs({ modelPath: artifact.path, port, ...overrides })

      let proc: ManagedChildProcess
      try {
        proc = spawnFn(resolvedExecutable!.path, args)
      } catch (error) {
        instance.state = "failed"
        instance.exitedAt = now()
        instance.lastError = `Failed to start llama-server: ${error instanceof Error ? error.message : String(error)}`
        instance.phase = undefined
        commit(instance)
        emitLifecycle(instance, { reason: instance.lastError })
        void persist()
        return { ...instance }
      }

      instance.pid = proc.pid !== undefined && proc.pid > 0 ? proc.pid : undefined
      instance.phase = "loading_model"
      commit(instance)
      emitLifecycle(instance)

      const liveProc: LiveProcess = { instanceID: instance.id, artifactID: instance.artifactID, proc }
      live.set(instance.id, liveProc)
      recordLog(instance.id, "stderr", `[atlas] llama-server spawned (${path.basename(resolvedExecutable!.path)}) on ${endpoint}`)
      attachChild(instance, liveProc)

      const deadline = Date.now() + startupDeadlineMs
      let ready = false
      let exitedEarly = false
      while (Date.now() < deadline) {
        // Stop/cancel during startup wins over everything - a late health
        // success must never resurrect this instance into running.
        if (live.get(instance.id) !== liveProc) {
          exitedEarly = true
          break
        }
        if (await pollHealth(endpoint)) {
          ready = true
          break
        }
        instance.phase = "health_wait"
        commit(instance)
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
      }

      if (ready && instances.get(instance.id)?.state === "starting" && live.get(instance.id) === liveProc) {
        instance.state = "running"
        instance.phase = undefined
        instance.lastError = undefined
        commit(instance)
        emitLifecycle(instance)
        resolveTerminal(instance)
        void persist()
        return { ...instance }
      }

      // If stop/cancel claimed this instance while we were polling, respect it
      const currentState = instances.get(instance.id)?.state
      if (currentState && currentState !== "starting" && currentState !== "failed") {
        return { ...instances.get(instance.id)! }
      }

      const stillOwned = live.get(instance.id)
      if (stillOwned) {
        // Timeout with a live child: label failure BEFORE killing so the exit
        // handler keeps the authoritative reason instead of the kill artifact
        instance.state = "failed"
        instance.exitedAt = now()
        instance.phase = undefined
        if (!instance.lastError) {
          instance.lastError = "startup timed out before the server became healthy"
        }
        commit(instance)
        await terminateOwned(stillOwned)
        live.delete(instance.id)
        emitLifecycle(instance, { exitCode: instance.exitCode, reason: instance.lastError })
        resolveTerminal(instance)
        void persist()
        continue
      }

      if (exitedEarly && attempt < PORT_ATTEMPTS) {
        // Bind collision on the chosen port - bounded retry elsewhere. The
        // exit handler already recorded failed/lastError for this attempt.
        lastBindishError = instance.lastError
        instance.generation += 1
        instance.state = "starting"
        instance.phase = undefined
        instance.lastError = undefined
        instance.exitCode = undefined
        commit(instance)
        continue
      }

      instance.state = "failed"
      instance.exitedAt = now()
      instance.phase = undefined
      instance.lastError =
        instance.lastError ??
        lastBindishError ??
        "llama-server exited before becoming healthy"
      commit(instance)
      emitLifecycle(instance, { reason: instance.lastError })
      resolveTerminal(instance)
      void persist()
      return { ...instance }
    }

    instance.state = "failed"
    instance.exitedAt = now()
    instance.phase = undefined
    instance.lastError = "Could not bind a port after several attempts"
    commit(instance)
    emitLifecycle(instance, { reason: instance.lastError })
    resolveTerminal(instance)
    void persist()
    return { ...instance }
  }

  let resolvedExecutable: Extract<ExecutableResolution, { found: true }> | undefined

  async function startArtifact(
    artifact: ManagedGgufArtifact,
    launchOptions?: ManagedLaunchOverrides,
  ): Promise<ManagedRuntimeInstance> {
    const resolution = deps.executableResolution ?? (await resolveLlamaServerExecutable(llamaServerPath))
    if (!resolution.found) throw new Error(resolution.reason)
    resolvedExecutable = resolution

    const fileStatus = await checkArtifactFile(artifact)
    if (!fileStatus.exists) throw new Error(`Model file missing: ${artifact.path}`)

    const existing = activeForArtifact(artifact.id)
    if (existing) return { ...existing }

    const generation = (generationByArtifact.get(artifact.id) ?? 0) + 1
    generationByArtifact.set(artifact.id, generation)

    const instance: ManagedRuntimeInstance = {
      id: `inst-${Date.now().toString(36)}-${Math.floor((deps.random?.() ?? Math.random()) * 1e6).toString(36)}`,
      artifactID: artifact.id,
      ownership: "managed",
      state: "starting",
      generation,
      startedAt: now(),
    }
    commit(instance)
    emitLifecycle(instance)

    // Non-blocking: the lifecycle runs in the background; callers observe
    // progress via events or waitForTerminal. An unexpected crash of the
    // lifecycle itself must fail the instance instead of leaving it hanging.
    void runLifecycle(artifact, instance, launchOptions).catch((error) => {
      const current = instances.get(instance.id)
      if (!current || !LIVE_STATES.includes(current.state)) return
      current.state = "failed"
      current.exitedAt = now()
      current.phase = undefined
      current.lastError = error instanceof Error ? error.message : String(error)
      commit(current)
      emitLifecycle(current, { reason: current.lastError })
      resolveTerminal(current)
      void persist()
    })
    return { ...instance }
  }

  async function stopInstance(instanceID: string, reason?: string): Promise<ManagedRuntimeInstance> {
    const instance = instances.get(instanceID) ?? instanceHistory.find((entry) => entry.id === instanceID)
    if (!instance) throw new Error("Unknown instance")

    const liveProc = live.get(instanceID)
    if (!liveProc) {
      if (LIVE_STATES.includes(instance.state)) {
        instance.state = "stopped"
        instance.exitedAt = now()
        instance.phase = "cancelled"
        commit(instance)
        emitLifecycle(instance)
        resolveTerminal(instance)
        void persist()
      }
      return { ...instance }
    }

    instance.state = "stopping"
    commit(instance)
    emitLifecycle(instance)
    await terminateOwned(liveProc)
    live.delete(instanceID)

    const current = instances.get(instanceID)!
    if (current.state === "stopping") {
      current.state = "stopped"
      current.exitedAt = now()
      current.phase = undefined
      if (current.lastError === undefined && reason) current.lastError = reason
      commit(current)
      emitLifecycle(current)
      resolveTerminal(current)
      void persist()
      return { ...current }
    }
    return { ...current }
  }

  const generationByArtifact = new Map<string, number>()
  let lastBindishError: string | undefined

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
      resolvedExecutable = undefined
      void persist()
    },

    getLlamaServerPath(): string | undefined {
      return llamaServerPath
    },

    resolveExecutable() {
      return resolveLlamaServerExecutable(llamaServerPath)
    },

    /** Returns immediately with the starting instance; lifecycle continues async */
    stop(instanceID: string, reason?: string): Promise<ManagedRuntimeInstance> {
      const instance = instances.get(instanceID) ?? instanceHistory.find((entry) => entry.id === instanceID)
      if (!instance) return Promise.reject(new Error("Unknown instance"))
      return serialize("instance:${instanceID}", () => stopInstance(instanceID, reason))
    },

    start(artifactID: string, launchOptions?: ManagedLaunchOverrides): Promise<ManagedRuntimeInstance> {
      const artifact = artifacts.find((entry) => entry.id === artifactID)
      if (!artifact) return Promise.reject(new Error("Unknown artifact"))
      return serialize(`artifact:${artifactID}`, async () => {
        const created = await startArtifact(artifact, launchOptions)
        // Give the lifecycle a moment to reach the spawned milestone so the
        // caller gets endpoint identity, without waiting for health.
        await Promise.race([waitForSpawned(created.id), new Promise<void>((r) => setTimeout(r, 5_000))])
        return instances.get(created.id) ?? created
      })
    },

    /** Awaits the terminal state of one specific instance run */
    waitForTerminal(instanceID: string): Promise<ManagedRuntimeInstance> {
      const existing = instances.get(instanceID)
      if (existing && !LIVE_STATES.includes(existing.state)) return Promise.resolve({ ...existing })
      return new Promise((resolve, reject) => {
        terminalWaiters.set(instanceID, resolve)
        void setTimeout(() => {
          if (terminalWaiters.has(instanceID)) {
            terminalWaiters.delete(instanceID)
            reject(new Error("timed out waiting for instance to reach a terminal state"))
          }
        }, startupDeadlineMs + 30_000)
      })
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

    runningInstanceForArtifact(artifactID: string): ManagedRuntimeInstance | undefined {
      const active = activeForArtifact(artifactID)
      return active ? { ...active } : undefined
    },

    logsFor(instanceID: string, limit = 100): LogLine[] {
      return (logs.get(instanceID) ?? []).slice(-limit)
    },

    /** Stops every owned child; best-effort under hard OS termination */
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
      if (logFlushTimer) clearInterval(logFlushTimer)
      logFlushTimer = undefined
    },

    disposeSync() {
      for (const proc of [...live.values()]) {
        try {
          proc.proc.kill()
        } catch {}
      }
      live.clear()
      if (logFlushTimer) clearInterval(logFlushTimer)
      logFlushTimer = undefined
    },
  }
}


export type ManagedLlamaCppManager = ReturnType<typeof createManagedLlamaCppManager>

let singleton: ManagedLlamaCppManager | undefined

/** Process-scoped manager consumed by discovery/provider integration */
export function getManagedLlamaCppManager(deps?: ProcessManagerDeps): ManagedLlamaCppManager {
  singleton ??= createManagedLlamaCppManager(deps)
  return singleton
}
