import type { Stat } from "../git"

// Codex-style diffstat summary computed from real git data.
// No fabricated line counts; binary files contribute file count only.

export interface DiffstatSummary {
  additions: number
  deletions: number
  files: number
}

export interface FileDiffstat {
  path: string
  /** Absent for binary files; git numstat reports no line counts for them */
  additions?: number
  deletions?: number
  binary: boolean
}

export function computeDiffstat(stats: readonly { file: string; additions: number; deletions: number }[]): DiffstatSummary {
  let additions = 0
  let deletions = 0
  const files = new Set<string>()
  for (const stat of stats) {
    files.add(stat.file)
    // Binary/untracked files may have -1 sentinel values from some git outputs
    if (stat.additions >= 0) additions += stat.additions
    if (stat.deletions >= 0) deletions += stat.deletions
  }
  return { additions, deletions, files: files.size }
}

export function formatDiffstat(summary: DiffstatSummary): string {
  return `+${summary.additions} −${summary.deletions} · ${summary.files} files`
}

export function toFileDiffstats(stats: readonly Stat[]): FileDiffstat[] {
  return stats.map((stat) => ({
    path: stat.file,
    ...(stat.binary ? {} : { additions: stat.additions, deletions: stat.deletions }),
    binary: stat.binary === true,
  }))
}
