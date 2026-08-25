import type { RuntimeHealth } from "./runtime-types"

// Change-only runtime health broadcasting. Periodic probes compare against the
// last known state and emit ONLY effective transitions, so a quiet healthy
// machine produces zero events. One failing runtime never blocks the others -
// each probe is an independent failure boundary.

export interface HealthWatcherDeps {
  /** Runtime IDs to watch, in priority order */
  runtimes: () => string[]
  probe: (runtimeID: string) => Promise<RuntimeHealth>
  onTransition: (input: { runtimeID: string; health: RuntimeHealth }) => void
  intervalMs?: number
}

export interface RuntimeHealthWatcher {
  start(): void
  stop(): void
  /** Force one immediate sweep; returns true if any transition was emitted */
  refresh(): Promise<boolean>
}

const DEFAULT_INTERVAL_MS = 30_000

export function createRuntimeHealthWatcher(deps: HealthWatcherDeps): RuntimeHealthWatcher {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const known = new Map<string, RuntimeHealth>()
  let timer: ReturnType<typeof setInterval> | undefined
  let sweeping = false

  async function sweep(): Promise<boolean> {
    if (sweeping) return false
    sweeping = true
    let changed = false
    try {
      await Promise.all(
        deps.runtimes().map(async (runtimeID) => {
          let health: RuntimeHealth
          try {
            health = await deps.probe(runtimeID)
          } catch {
            health = { state: "unavailable", detail: "probe failed" }
          }
          const previous = known.get(runtimeID)
          // First observation seeds the baseline without emitting - reconnecting
          // clients refetch snapshots, so history is not needed.
          if (!previous) {
            known.set(runtimeID, health)
            return
          }
          if (previous.state === health.state && previous.detail === health.detail) return
          known.set(runtimeID, health)
          changed = true
          deps.onTransition({ runtimeID, health })
        }),
      )
    } finally {
      sweeping = false
    }
    return changed
  }

  return {
    start() {
      if (timer) return
      void sweep()
      timer = setInterval(() => void sweep(), intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    refresh: sweep,
  }
}
