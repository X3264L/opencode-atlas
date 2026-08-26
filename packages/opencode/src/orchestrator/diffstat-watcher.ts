import type { Stat } from "../git"
import { computeDiffstat, type DiffstatSummary } from "./diffstat"

// Change-driven diffstat watcher. Emits atlas.diffstat.changed only when the
// computed summary actually differs from the previous snapshot. No event is
// emitted on unchanged reads.

export interface DiffstatWatcherDeps {
  getStats: () => Promise<Stat[]>
  projectID: string
  onChange: (summary: DiffstatSummary) => void
  debounceMs?: number
}

export interface DiffstatWatcher {
  /** Force one immediate poll; returns new summary if changed */
  poll(): Promise<DiffstatSummary | undefined>
  start(): void
  stop(): void
}

export function createDiffstatWatcher(deps: DiffstatWatcherDeps): DiffstatWatcher {
  let previous: DiffstatSummary | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function computeAndCompare(): Promise<DiffstatSummary | undefined> {
    const stats = await deps.getStats()
    const current = computeDiffstat(stats)
    if (
      previous &&
      previous.additions === current.additions &&
      previous.deletions === current.deletions &&
      previous.files === current.files
    ) {
      return undefined // unchanged — no event
    }
    const changed = previous !== undefined
    previous = current
    if (changed) deps.onChange(current)
    return current
  }

  return {
    async poll() {
      if (stopped) return undefined
      return computeAndCompare()
    },
    start() {
      if (timer || stopped) return
      const intervalMs = deps.debounceMs ?? 5_000
      timer = setInterval(() => void computeAndCompare().catch(() => {}), intervalMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      stopped = true
    },
  }
}
