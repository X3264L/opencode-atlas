import { describe, expect, test } from "bun:test"
import { computeDiffstat, formatDiffstat } from "@/orchestrator/diffstat"

describe("diffstat computation", () => {
  test("computes additions/deletions/files from real stats", () => {
    const result = computeDiffstat([
      { file: "src/auth.ts", additions: 82, deletions: 11 },
      { file: "src/session.ts", additions: 41, deletions: 3 },
      { file: "tests/auth.ts", additions: 99, deletions: 22 },
    ])
    expect(result).toEqual({ additions: 222, deletions: 36, files: 3 })
  })

  test("empty stats → zero counts", () => {
    const result = computeDiffstat([])
    expect(result).toEqual({ additions: 0, deletions: 0, files: 0 })
  })

  test("binary files contribute file count without fabricated line counts", () => {
    const result = computeDiffstat([
      { file: "logo.png", additions: -1, deletions: -1 },
      { file: "src/auth.ts", additions: 10, deletions: 5 },
    ])
    // -1 sentinels are not added
    expect(result.additions).toBe(10)
    expect(result.deletions).toBe(5)
    expect(result.files).toBe(2) // both files counted; binary just has no line deltas
  })

  test("same file appearing twice is counted once", () => {
    const result = computeDiffstat([
      { file: "src/a.ts", additions: 10, deletions: 5 },
      { file: "src/a.ts", additions: 20, deletions: 3 },
    ])
    expect(result.files).toBe(1)
    expect(result.additions).toBe(30)
  })
})

describe("diffstat formatting", () => {
  test("formats Codex-style output", () => {
    expect(formatDiffstat({ additions: 428, deletions: 137, files: 12 })).toBe("+428 −137 · 12 files")
  })

  test("zero state formats correctly", () => {
    expect(formatDiffstat({ additions: 0, deletions: 0, files: 0 })).toBe("+0 −0 · 0 files")
  })
})
