import { Effect } from "effect"
import type { Git } from "../git"

// Authoritative working-tree diffstat source shared by the runtime watcher and
// the Mission Control read endpoints, so summary, drilldown rows and published
// events can never diverge. Tracked changes come from `git diff --numstat HEAD`
// (staged + unstaged); untracked files are appended via per-file numstat.

export type StatsSource = Pick<Git.Interface, "hasHead" | "stats" | "status" | "statUntracked">

export const workingTreeStats = Effect.fn("Atlas.workingTreeStats")(function* (git: StatsSource, cwd: string) {
  const head = yield* git.hasHead(cwd)
  const tracked = head ? yield* git.stats(cwd, "HEAD") : []
  const status = yield* git.status(cwd)
  const untracked = yield* Effect.forEach(
    status.filter((item) => item.code === "??"),
    (item) => git.statUntracked(cwd, item.file),
  )
  return [...tracked, ...untracked.flatMap((stat) => (stat ? [stat] : []))]
})

export * as WorkingTree from "./working-tree"
