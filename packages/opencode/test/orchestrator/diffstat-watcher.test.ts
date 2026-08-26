import { describe, expect, test } from "bun:test"
import { computeDiffstat, formatDiffstat } from "@/orchestrator/diffstat"
import { createDiffstatWatcher } from "@/orchestrator/diffstat-watcher"

type Stat = { file: string; additions: number; deletions: number }

function stats(entries: [string, number, number][]): Stat[] {
  return entries.map(([file, additions, deletions]) => ({ file, additions, deletions }))
}

describe("diffstat computation", () => {
  test("computes real git numstat data", () => {
    const result = computeDiffstat(stats([
      ["src/auth.ts", 82, 11],
      ["src/session.ts", 41, 3],
      ["tests/auth.ts", 99, 22],
    ]))
    expect(result).toEqual({ additions: 222, deletions: 36, files: 3 })
  })

  test("clean tree → zero counts", () => {
    expect(computeDiffstat([])).toEqual({ additions: 0, deletions: 0, files: 0 })
  })

  test("binary files count but don't fabricate line deltas", () => {
    const result = computeDiffstat([
      { file: "logo.png", additions: -1, deletions: -1 },
      { file: "src/auth.ts", additions: 10, deletions: 5 },
    ])
    expect(result.additions).toBe(10)
    expect(result.deletions).toBe(5)
    expect(result.files).toBe(2)
  })

  test("duplicate file entries deduplicate by path", () => {
    const result = computeDiffstat([
      { file: "a.ts", additions: 10, deletions: 5 },
      { file: "a.ts", additions: 20, deletions: 3 },
    ])
    expect(result.files).toBe(1)
    expect(result.additions).toBe(30)
  })
})

describe("formatting", () => {
  test("Codex-style format", () => {
    expect(formatDiffstat({ additions: 428, deletions: 137, files: 12 })).toBe("+428 −137 · 12 files")
  })
})

// ---- Change-driven watcher ----

function makeWatcher(sequence: Stat[][], onChange: (s: import("@/orchestrator/diffstat").DiffstatSummary) => void) {
  let callIndex = 0
  return createDiffstatWatcher({
    projectID: "proj-test",
    getStats: async () => sequence[Math.min(callIndex++, sequence.length - 1)] ?? [],
    onChange,
  })
}

describe("change-driven diffstat publication", () => {
  test("emits only when summary actually changes", async () => {
    const events: { additions: number; deletions: number; files: number }[] = []
    const watcher = makeWatcher(
      [
        stats([["a.ts", 10, 5]]), // first read — seeds baseline
        stats([["a.ts", 10, 5]]), // unchanged — no event
        stats([["a.ts", 20, 8], ["b.ts", 3, 1]]), // changed
        stats([["a.ts", 20, 8], ["b.ts", 3, 1]]), // same as previous — no event
      ],
      (summary) => events.push(summary),
    )

    await watcher.poll() // seed baseline (no event)
    await watcher.poll() // unchanged → no event
    await watcher.poll() // changed → event
    await watcher.poll() // unchanged → no event

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ additions: 23, deletions: 9, files: 2 })
  })

  test("clean tree to dirty to clean produces two transitions", async () => {
    const events: { additions: number; files: number }[] = []
    let call = 0
    const sequences = [
      stats([]), // clean
      stats([["new.ts", 50, 10]]), // dirty
      stats([]), // clean again
    ]
    const watcher = createDiffstatWatcher({
      projectID: "proj-test",
      getStats: async () => sequences[Math.min(call++, sequences.length - 1)] ?? [],
      onChange: (summary) => events.push(summary),
    })

    await watcher.poll() // seed: clean (baseline, no emit)
    await watcher.poll() // dirty → emit
    await watcher.poll() // clean again → emit
    expect(events).toHaveLength(2)
    expect(events[0]?.additions).toBeGreaterThan(0)
    expect(events[1]?.additions).toBe(0)
  })
})
