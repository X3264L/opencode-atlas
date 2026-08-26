import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Git } from "@/git"
import { computeDiffstat, toFileDiffstats } from "@/orchestrator/diffstat"
import { workingTreeStats } from "@/orchestrator/working-tree"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Git.node, CrossSpawnSpawner.node])))

const write = (directory: string, name: string, content: string | Uint8Array) =>
  Effect.promise(() => {
    const location = path.join(directory, name)
    return typeof content === "string" ? Bun.write(location, content) : Bun.write(location, content)
  })

describe("working-tree diffstats from real git", () => {
  it.instance(
    "clean tree produces an empty summary",
    () =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const dir = (yield* TestInstance).directory
        const stats = yield* workingTreeStats(git, dir)
        expect(stats).toEqual([])
        expect(computeDiffstat(stats)).toEqual({ additions: 0, deletions: 0, files: 0 })
      }),
    { git: true },
  )

  it.instance(
    "tracked edits, untracked text and untracked binaries all count exactly",
    () =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const dir = (yield* TestInstance).directory

        yield* write(dir, "tracked.txt", "first\nsecond\n")
        // Commit the baseline so the tree starts clean
        yield* git.run(["add", "."], { cwd: dir })
        const commit = yield* git.run(["commit", "-m", "base"], { cwd: dir })
        expect(commit.exitCode).toBe(0)

        yield* write(dir, "tracked.txt", "first\nsecond\nthird\n")
        yield* write(dir, "new.txt", "hello\nworld\n")
        yield* write(dir, "logo.bin", new Uint8Array([0x00, 0x01, 0xff]))

        const stats = yield* workingTreeStats(git, dir)
        const byPath = new Map(stats.map((stat) => [stat.file, stat]))

        expect(byPath.get("tracked.txt")).toMatchObject({ additions: 1, deletions: 0 })
        expect(byPath.get("new.txt")?.additions).toBe(2)
        expect(byPath.get("logo.bin")?.binary).toBe(true)

        const files = toFileDiffstats(stats)
        expect(files.find((file) => file.path === "logo.bin")).toEqual({ path: "logo.bin", binary: true })
        expect(files.find((file) => file.path === "new.txt")).toEqual({
          path: "new.txt",
          additions: 2,
          deletions: 0,
          binary: false,
        })

        const summary = computeDiffstat(stats)
        expect(summary.files).toBe(3)
        expect(summary.additions).toBe(3)

        // Reverting back to a clean tree yields nothing again
        const reset = yield* git.run(["checkout", "--", "."], { cwd: dir })
        expect(reset.exitCode).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "a directory without git degrades to an honest empty diffstat",
    () =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const dir = (yield* TestInstance).directory
        const stats = yield* workingTreeStats(git, dir)
        expect(stats).toEqual([])
      }),
  )
})
