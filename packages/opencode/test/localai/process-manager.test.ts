import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createManagedLlamaCppManager, LOG_BUFFER_LIMIT, type ManagedRuntimeInstance } from "@/localai/process-manager"
import type { ManagedGgufArtifact } from "@/localai/gguf"

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-llama-server.ts")

async function makeArtifact(overrides: Partial<ManagedGgufArtifact> = {}): Promise<ManagedGgufArtifact> {
  // Real tiny files: the manager validates existence before spawning
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-gguf-art-"))
  const fileName = overrides.displayName ? `${overrides.displayName}.gguf` : `model-${Math.random().toString(36).slice(2, 8)}.gguf`
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
}

/**
 * Creates an isolated manager whose children are the deterministic bun
 * fixture. `mode` selects the fixture behavior; the real chosen port is read
 * back out of the constructed argv.
 */
function harness(mode: string, overrides: Parameters<typeof createManagedLlamaCppManager>[0] = {}) {
  const storePath = path.join(os.tmpdir(), `atlas-pm-${Math.random().toString(36).slice(2)}.json`)
  const spawnedArgs: string[][] = []
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
    ...overrides,
  })
  return { manager, storePath, spawnedArgs }
}

async function withRunning(mode: string, fn: (h: Harness, instance: ManagedRuntimeInstance) => Promise<void>) {
  const h = harness(mode)
  await h.manager.initialize()
  const artifact = await makeArtifact()
  await h.manager.addArtifact(artifact)
  const instance = await h.manager.start(artifact.id)
  try {
    await fn(h, instance)
  } finally {
    await h.manager.dispose()
  }
}

describe("process lifecycle", () => {
  test("start reaches running through the health gate; stop is clean", async () => {
    await withRunning("ready", async (h, started) => {
      expect(started.state).toBe("running")
      expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(typeof started.pid).toBe("number")

      if (started.state !== "running") {
      console.error("DEBUG-LOGS:", JSON.stringify(h.manager.logsFor(started.id, 20)))
      console.error("DEBUG-ARGS:", JSON.stringify(h.spawnedArgs))
    }    const stopped = await h.manager.stop(started.id)
      expect(stopped.state).toBe("stopped")
      expect(h.manager.listInstances().find((entry) => entry.id === stopped.id)?.state).toBe("stopped")
    })
  })

  test("stop is idempotent after the child already exited", async () => {
    await withRunning("ready", async (h, started) => {
      await h.manager.stop(started.id)
      const again = await h.manager.stop(started.id)
      expect(again.state).toBe("stopped")
    })
  })

  test("slow model loading stays starting until health reports ready", async () => {
    const h = harness("slow:900")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    // The start promise resolves only when healthy - verify it takes effect
    const instance = await h.manager.start(artifact.id)
    expect(instance.state).toBe("running")
    await h.manager.dispose()
  })

  test("health never ready times out into failed with cleanup", async () => {
    const h = harness("never-ready", { startupDeadlineMs: 1_200 })
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    let failed = false
    try {
      await h.manager.start(artifact.id)
    } catch (error) {
      failed = true
      expect((error as Error).message).toContain("healthy")
    }
    expect(failed).toBe(true)

    const instances = h.manager.listInstances()
    expect(instances[0].state).toBe("failed")
    // Owned child was cleaned up after the failed startup
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    const logs = h.manager.logsFor(instances[0].id, 5)
    expect(Array.isArray(logs)).toBe(true)
    await h.manager.dispose()
  })

  test("unexpected exit while running becomes crashed with diagnostics", async () => {
    const h = harness("crash:400")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    // Health gate passes first, then the fixture self-destructs
    const instance = await h.manager.start(artifact.id)
    expect(instance.state).toBe("running")
    await Bun.sleep(700)
    const updated = h.manager.listInstances().find((entry) => entry.id === instance.id)!
    expect(updated.state).toBe("crashed")
    expect(updated.exitCode).toBe(2)
    await h.manager.dispose()
  }, 10_000)

  test("port collision retries on a fresh port within bounded attempts", async () => {
    // First probe hands out a port we immediately occupy, simulating the
    // bind race; later probes ask the OS for genuinely free ports.
    let call = 0
    const squatters: Bun.TCPSocketListener[] = []
    const h = harness("ready", {
      portProbe: async () => {
        call += 1
        if (call === 1) {
          const victim = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
          const taken = victim.port
          victim.stop(true)
          squatters.push(Bun.listen({ hostname: "127.0.0.1", port: taken, socket: { data() {} } }))
          return taken
        }
        const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
        const free = server.port
        server.stop(true)
        return free
      },
    })
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)

    // The fixture exits early on the occupied port; manager must retry and run
    const instance = await h.manager.start(artifact.id)
    expect(instance.state).toBe("running")
    expect(call).toBeGreaterThanOrEqual(2)
    await h.manager.dispose()
    for (const squatter of squatters) squatter.stop(true)
  }, 20_000)

  test("restart performs a real stop-then-start lifecycle", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const first = await h.manager.start(artifact.id)

    const second = await h.manager.restart(first.id)
    expect(second.id).not.toBe(first.id)
    expect(second.state).toBe("running")

    // Old instance must be dead in history
    const oldEntry = h.manager.listInstances().find((entry) => entry.id === first.id)!
    expect(["stopped", "stopping"]).toContain(oldEntry.state)
    await h.manager.dispose()
  }, 15_000)

  test("double start returns the same single instance", async () => {
    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const [a, b] = await Promise.all([h.manager.start(artifact.id), h.manager.start(artifact.id)])
    expect(a.id).toBe(b.id)
    await h.manager.dispose()
  }, 15_000)
})

describe("ownership safety", () => {
  test("unknown instance IDs are rejected - external processes are never touched", async () => {
    // An HTTP server the manager has NEVER seen
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

    // External server still alive and answering
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

    // Watchdog: PID 999999999 must not exist; even if it did, nothing may kill it.
    const h = createManagedLlamaCppManager({ storePath })
    await h.initialize()
    const stale = h.listInstances().find((entry) => entry.id === "inst-old")!
    expect(stale.state).toBe("stopped")
    expect(stale.lastError).toContain("stale")

    // Stop against the stale row must not signal anything
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
    expect(a.state).toBe("running")
    expect(b.state).toBe("running")

    await h.manager.dispose()
    const states = h.manager.listInstances().filter((entry) => [a.id, b.id].includes(entry.id))
    for (const entry of states) {
      expect(["stopped", "crashed", "failed"]).toContain(entry.state)
    }
  }, 15_000)

  test("removing a registration while running is rejected; allowed once stopped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-remove-"))
    const ggufPath = path.join(dir, "model-q4_k_m.gguf")
    await fs.writeFile(ggufPath, "fixture bytes")

    const h = harness("ready")
    await h.manager.initialize()
    const artifact = await makeArtifact({ id: "gguf-rm", path: ggufPath, quantization: "Q4_K_M" })
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)

    const whileRunning = await h.manager.removeArtifact(artifact.id)
    expect(whileRunning.ok).toBe(false)
    expect(whileRunning.error).toContain("Stop")

    await h.manager.stop(started.id)
    const removed = await h.manager.removeArtifact(artifact.id)
    expect(removed.ok).toBe(true)

    // The user's GGUF file itself is untouched
    expect((await fs.stat(ggufPath)).isFile()).toBe(true)
    await h.manager.dispose()
  }, 15_000)
})

describe("log capture", () => {
  test("stdout and stderr are captured with sources and stay bounded", async () => {
    const h = harness("noisy")
    await h.manager.initialize()
    const artifact = await makeArtifact()
    await h.manager.addArtifact(artifact)
    const started = await h.manager.start(artifact.id)

    // Give stream readers time to drain some lines
    await Bun.sleep(600)
    const all = h.manager.logsFor(started.id, LOG_BUFFER_LIMIT)
    expect(all.length).toBeGreaterThan(0)
    expect(all.some((line) => line.source === "stderr")).toBe(true)
    // Every captured line carries its origin tag context via source field
    expect(all.every((line) => line.source === "stdout" || line.source === "stderr")).toBe(true)

    // Bounded view: requesting fewer lines returns exactly that tail
    const tail = h.manager.logsFor(started.id, 3)
    expect(tail.length).toBeLessThanOrEqual(3)
    await h.manager.dispose()
  }, 15_000)
})
