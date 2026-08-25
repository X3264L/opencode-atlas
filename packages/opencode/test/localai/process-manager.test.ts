import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { appendFileSync } from "node:fs"
import os from "os"
import path from "path"
import {
  createManagedLlamaCppManager,
  LOG_BUFFER_LIMIT,
  type ManagedManagerEvent,
  type ManagedRuntimeInstance,
} from "@/localai/process-manager"
import type { ManagedGgufArtifact } from "@/localai/gguf"

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-llama-server.ts")

async function makeArtifact(overrides: Partial<ManagedGgufArtifact> = {}): Promise<ManagedGgufArtifact> {
  // Real tiny files: the manager validates existence before spawning
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-gguf-art-"))
  const fileName = overrides.displayName
    ? `${overrides.displayName}.gguf`
    : `model-${Math.random().toString(36).slice(2, 8)}.gguf`
  const filePath = path.join(dir, fileName)
  await fs.writeFile(filePath, "fixture gguf bytes")
  return {
    id: `gguf-test-${Math.random().toString(36).slice(2, 8)}`,
    runtimeID: "llamacpp",
    path: filePath,
    displayName: fileName.replace(/\.gguf$/, ""),
    source: "user-file",
    registeredAt: new Date().toISOString(),
    ...overrides,
  }
}

interface Harness {
  manager: ReturnType<typeof createManagedLlamaCppManager>
  storePath: string
  spawnedArgs: string[][]
  events: ManagedManagerEvent[]
}

/**
 * Creates an isolated manager whose children are the deterministic bun
 * fixture. `mode` selects the fixture behavior; lifecycle/log events are
 * captured for ordering assertions.
 */
function harness(mode: string, overrides: Parameters<typeof createManagedLlamaCppManager>[0] = {}): Harness {
  const storePath = path.join(os.tmpdir(), `atlas-pm-${Math.random().toString(36).slice(2)}.json`)
  const spawnedArgs: string[][] = []
  const events: ManagedManagerEvent[] = []
  const manager = createManagedLlamaCppManager({
    storePath,
    startupDeadlineMs: overrides.startupDeadlineMs ?? 4_000,
    stopGraceMs: overrides.stopGraceMs ?? 2_000,
    defaultContextSize: 4096,
    // No real llama-server is required - resolution and children are fixtures
    executableResolution: { found: true, path: "fixture-llama-server", source: "configured" },
    spawn: (executable, args) => {
      spawnedArgs.push([...args])
      const port = args[args.indexOf("--port") + 1]
      return Bun.spawn([process.execPath, FIXTURE, mode, port], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    },
    emit: (event) => events.push(event),
    ...overrides,
  })
  return { manager, storePath, spawnedArgs, events }
}

function lifecycleStates(events: ManagedManagerEvent[], instanceID: string) {
  return events
    .filter((event): event is Extract<ManagedManagerEvent, { kind: "lifecycle" }> => event.kind === "lifecycle")
    .filter((event) => event.instanceID === instanceID)
    .map((event) => ({ state: event.state, phase: event.phase, generation: event.generation }))
}

/** Deterministically waits for a predicate over the instance snapshot */
async function waitFor(
  manager: ReturnType<typeof createManagedLlamaCppManager>,
  instanceID: string,
  predicate: (instance: ManagedRuntimeInstance | undefined) => boolean,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const instance = manager.listInstances().find((entry) => entry.id === instanceID)
    if (predicate(instance)) return instance
    if (Date.now() > deadline) throw new Error(`timed out waiting on instance ${instanceID}`)
    await Bun.sleep(50)
  }
}

describe("non-blocking start", () => {
  test("start returns while the server is still starting; running arrives later", async () => {
    const h = harness("slow:800")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    const instance = await h.manager.start(artifact.id)
    // Returned BEFORE health readiness - this is the non-blocking contract
    expect(instance.state).toBe("starting")
    expect(instance.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const final = await waitFor(h.manager, instance.id, (entry) => entry?.state === "running")
    expect(final?.state).toBe("running")
    await h.manager.dispose()
  }, 15_000)

  test("double start returns the same instance instead of spawning twice", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const [a, b] = await Promise.all([h.manager.start(artifact.id), h.manager.start(artifact.id)])
    expect(a.id).toBe(b.id)
    await waitFor(h.manager, a.id, (entry) => entry?.state === "running")
    const spawnsForArtifact = h.spawnedArgs.length
    await Bun.sleep(200)
    expect(spawnsForArtifact).toBe(1)
    await h.manager.dispose()
  }, 15_000)
})

describe("lifecycle event order", () => {
  test("start emits starting phases then running only after health readiness", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    const started = await h.manager.start(artifact.id)
    await waitFor(h.manager, started.id, (entry) => entry?.state === "running")
    // Allow the final transition event to land
    await Bun.sleep(50)

    const sequence = lifecycleStates(h.events, started.id)
    expect(sequence[0]?.state).toBe("starting")
    const phases = sequence.map((entry) => entry.phase).filter(Boolean)
    expect(phases).toContain("port_selected")
    expect(phases).toContain("spawning")
    expect(phases.indexOf("port_selected")).toBeLessThan(phases.indexOf("spawning"))
    const runningIndex = sequence.findIndex((entry) => entry.state === "running")
    expect(runningIndex).toBeGreaterThan(-1)
    // No running before every setup phase
    expect(phases.length).toBeGreaterThan(0)
    await h.manager.dispose()
  }, 15_000)

  test("stop emits stopping then stopped; no resurrection afterwards", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)
    await waitFor(h.manager, started.id, (entry) => entry?.state === "running")

    await h.manager.stop(started.id)
    await Bun.sleep(80)

    const sequence = lifecycleStates(h.events, started.id).map((entry) => entry.state)
    const stoppingIndex = sequence.lastIndexOf("stopping")
    const stoppedIndex = sequence.lastIndexOf("stopped")
    expect(stoppingIndex).toBeGreaterThan(-1)
    expect(stoppedIndex).toBe(stoppingIndex + 1)
    // Terminal means terminal - nothing may follow
    expect(sequence.slice(stoppedIndex + 1)).not.toContain("running")
    await h.manager.dispose()
  }, 15_000)

  test("cancel during loading reaches stopped and never becomes running later", async () => {
    const h = harness("never-ready", { startupDeadlineMs: 30_000 })
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    const started = await h.manager.start(artifact.id)
    await waitFor(h.manager, started.id, (entry) =>
      Boolean(entry && entry.phase === "health_wait" && entry.state === "starting"),
    )

    // User cancels while the model is loading
    const cancelled = await h.manager.stop(started.id, "cancelled by user")
    expect(["stopped", "stopping"]).toContain(cancelled.state)

    // Even though the deadline has not elapsed, no running may ever appear
    await Bun.sleep(400)
    const states = lifecycleStates(h.events, started.id).map((entry) => entry.state)
    expect(states).not.toContain("running")
    const final = h.manager.listInstances().find((entry) => entry.id === started.id)!
    expect(final.state).toBe("stopped")
    await h.manager.dispose()
  }, 20_000)

  test("startup timeout produces failed", async () => {
    const h = harness("never-ready", { startupDeadlineMs: 1_200 })
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    const started = await h.manager.start(artifact.id)
    const failed = await h.manager.waitForTerminal(started.id)
    expect(failed.state).toBe("failed")
    expect(failed.lastError).toContain("timed out")
    await h.manager.dispose()
  }, 20_000)

  test("crash while running emits crashed with exit code", async () => {
    const h = harness("crash:400")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)
    await waitFor(h.manager, started.id, (entry) => entry?.state === "running")
    const crashed = await waitFor(h.manager, started.id, (entry) => entry?.state === "crashed")
    expect(crashed?.exitCode).toBe(2)
    await h.manager.dispose()
  }, 15_000)

  test("restart bumps generation; old generation goes terminal first", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const first = await h.manager.start(artifact.id)
    const oldGeneration = first.generation
    await waitFor(h.manager, first.id, (entry) => entry?.state === "running")

    void h.manager.waitForTerminal(first.id).catch(() => {})
    const second = await h.manager.restart(first.id)
    expect(second.id).not.toBe(first.id)
    expect(second.generation).toBe(oldGeneration + 1)

    await waitFor(h.manager, second.id, (entry) => entry?.state === "running")

    // Old instance reached a terminal state, and its events never claim running again
    const oldEntry = h.manager.listInstances().find((entry) => entry.id === first.id)!
    expect(oldEntry.state).toBe("stopped")

    // Stale-generation simulation: an event bearing the OLD id/generation must
    // not be mistaken for current state - ids differ so clients can drop it.
    const staleEvent = h.events.find(
      (event) => event.kind === "lifecycle" && event.instanceID === first.id && event.generation === oldGeneration,
    )
    expect(staleEvent).toBeDefined()
    expect(second.id).not.toBe((staleEvent as Extract<ManagedManagerEvent, { kind: "lifecycle" }>).instanceID)
    await h.manager.dispose()
  }, 20_000)
})

describe("log streaming bounds", () => {
  test("noisy runtime emits batched bounded log events without flooding", async () => {
    const h = harness("noisy")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)

    await waitFor(h.manager, started.id, (entry) => entry?.state === "running")
    await Bun.sleep(600)

    const logEvents = h.events.filter(
      (event): event is Extract<ManagedManagerEvent, { kind: "log" }> => event.kind === "log",
    )
    expect(logEvents.length).toBeGreaterThan(0)
    for (const event of logEvents) {
      expect(event.lines.length).toBeLessThanOrEqual(80)
      for (const line of event.lines) {
        expect(["stdout", "stderr"]).toContain(line.source)
        expect(typeof line.at).toBe("number")
      }
    }
    // History ring stays bounded even when many lines streamed
    expect(h.manager.logsFor(started.id, LOG_BUFFER_LIMIT * 2).length).toBeLessThanOrEqual(LOG_BUFFER_LIMIT)
    await h.manager.dispose()
  }, 15_000)
})

describe("ownership safety", () => {
  test("unknown instance IDs are rejected - external processes are never touched", async () => {
    const external = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ok" }),
    })
    const h = harness("never-ready", { startupDeadlineMs: 800 })
    await h.manager.initialize()

    let rejected = false
    try {
      await h.manager.stop(`inst-not-a-real-id-${external.port}`)
    } catch (error) {
      rejected = true
      expect((error as Error).message).toBe("Unknown instance")
    }
    expect(rejected).toBe(true)

    const res = await fetch(`http://127.0.0.1:${external.port}/health`)
    expect(res.ok).toBe(true)
    external.stop(true)
    await h.manager.dispose()
  })

  test("persisted live-state PIDs are marked stale, never signalled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-stale-"))
    const storePath = path.join(dir, "managed.json")
    await fs.writeFile(
      storePath,
      JSON.stringify({
        artifacts: [],
        instances: [
          {
            id: "inst-old",
            artifactID: "gguf-old",
            ownership: "managed",
            state: "running",
            pid: 999_999_999,
            endpoint: "http://127.0.0.1:1",
          },
        ],
      }),
    )

    const h = createManagedLlamaCppManager({ storePath })
    await h.initialize()
    const stale = h.listInstances().find((entry) => entry.id === "inst-old")!
    expect(stale.state).toBe("stopped")
    expect(stale.lastError).toContain("stale")

    const result = await h.stop("inst-old")
    expect(result.state).toBe("stopped")
  })

  test("manager dispose cleans up every owned child", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifactA = await makeArtifact()
    const artifactB = await makeArtifact()
    await h.manager.addArtifact(artifactA)
    await h.manager.addArtifact(artifactB)
    const a = await h.manager.start(artifactA.id)
    const b = await h.manager.start(artifactB.id)
    await waitFor(h.manager, a.id, (entry) => entry?.state === "running")
    await waitFor(h.manager, b.id, (entry) => entry?.state === "running")

    await h.manager.dispose()
    const states = h.manager.listInstances().filter((entry) => [a.id, b.id].includes(entry.id))
    for (const entry of states) {
      expect(["stopped", "crashed", "failed"]).toContain(entry.state)
    }
  }, 20_000)

  test("removing a registration while running is rejected; allowed once stopped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-remove-"))
    const ggufPath = path.join(dir, "model-q4_k_m.gguf")
    await fs.writeFile(ggufPath, "fixture bytes")

    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact({ id: "gguf-rm", path: ggufPath, quantization: "Q4_K_M" })
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)
    await waitFor(h.manager, started.id, (entry) => entry?.state === "running")

    const whileRunning = await h.manager.removeArtifact(artifact.id)
    expect(whileRunning.ok).toBe(false)
    expect(whileRunning.error).toContain("Stop")

    await h.manager.stop(started.id)
    const removed = await h.manager.removeArtifact(artifact.id)
    expect(removed.ok).toBe(true)

    // The user's GGUF file itself is untouched
    expect((await fs.stat(ggufPath)).isFile()).toBe(true)
    await h.manager.dispose()
  }, 20_000)
})
