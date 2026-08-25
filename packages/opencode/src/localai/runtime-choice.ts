import type { ModelBenchmark, RuntimeCapabilities } from "./runtime-types"

// Evidence-based runtime selection. Atlas never ranks runtimes by a fixed
// preference list - measured benchmarks, readiness results, install state and
// explicit user preference decide. When no measurements exist the heuristic
// fallback is transparent about its basis.

export type RuntimePreference = "auto" | "ollama" | "lmstudio" | "llamacpp" | "mlx"

export const RUNTIME_PREFERENCES: RuntimePreference[] = ["auto", "ollama", "lmstudio", "llamacpp", "mlx"]

export interface RuntimeCandidate {
  runtimeID: string
  capabilities: RuntimeCapabilities
  /** Runtime is up and serving this model right now */
  usable: boolean
  /** This exact model instance exists on the runtime */
  installed: boolean
  /** Measured benchmark for THIS model+variant on THIS runtime */
  benchmark?: ModelBenchmark
  readinessScore?: number
  readinessToolCallingPass?: boolean
}

export interface RuntimeChoiceReason {
  kind: "positive" | "caveat"
  text: string
}

export interface RuntimeChoice {
  runtimeID: string | undefined
  source: "measured" | "preference" | "heuristic" | "none"
  reasons: RuntimeChoiceReason[]
}

function tokensPerSecond(benchmark: ModelBenchmark | undefined): number | undefined {
  const value = benchmark?.tokensPerSecond
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Picks the runtime to use for one concrete model+variant. Preference wins
 * whenever it is valid; otherwise measured evidence decides; with no evidence
 * a transparent heuristic (install state + lifecycle completeness) applies.
 */
export function chooseRuntime(
  candidates: RuntimeCandidate[],
  options?: { preference?: RuntimePreference; requireTools?: boolean },
): RuntimeChoice {
  const usable = candidates.filter((candidate) => candidate.usable)
  if (usable.length === 0) {
    return { runtimeID: undefined, source: "none", reasons: [] }
  }

  // Explicit user preference overrides scoring when the chosen runtime can
  // actually serve this model. Unsupported or offline selections degrade.
  const preference = options?.preference ?? "auto"
  if (preference !== "auto") {
    const preferred = usable.find((candidate) => candidate.runtimeID === preference)
    if (preferred) {
      const reasons: RuntimeChoiceReason[] = [
        { kind: "positive", text: `You preferred ${preferred.runtimeID}` },
        ...reasonsFor(preferred),
      ]
      if (options?.requireTools && preferred.readinessToolCallingPass === false) {
        reasons.push({ kind: "caveat", text: `Tool calling did not pass readiness on ${preferred.runtimeID}` })
      }
      return { runtimeID: preferred.runtimeID, source: "preference", reasons }
    }
  }

  if (usable.length === 1) {
    const only = usable[0]
    const reasons: RuntimeChoiceReason[] = []
    // Surface an unhonored preference before the explanation of what was used
    if (preference !== "auto" && preference !== only.runtimeID) {
      reasons.push({ kind: "caveat", text: `${preference} is not running - selected the fastest available runtime` })
    }
    reasons.push({ kind: "positive", text: `${only.runtimeID} is the only available runtime for this model` })
    return {
      runtimeID: only.runtimeID,
      source: only.benchmark?.tokensPerSecond ? "measured" : "heuristic",
      reasons: [...reasons, ...reasonsFor(only)],
    }
  }

  if (preference !== "auto") {
    const unavailablePreference = candidates.find((candidate) => candidate.runtimeID === preference)
    if (unavailablePreference) {
      const winner = bestMeasured(usable, options)
      return {
        runtimeID: winner.runtimeID,
        source: winner.benchmark?.tokensPerSecond ? "measured" : "heuristic",
        reasons: [
          { kind: "caveat", text: `${preference} is not running - selected the fastest available runtime` },
          ...choiceReasons(winner, usable, options),
        ],
      }
    }
  }

  const winner = bestMeasured(usable, options)
  return {
    runtimeID: winner.runtimeID,
    source: winner.benchmark?.tokensPerSecond || winner.readinessScore !== undefined ? "measured" : "heuristic",
    reasons: [...choiceReasons(winner, usable, options)],
  }
}

/** Fastest by real measurement; ties and missing data fall back to heuristics */
function bestMeasured(usable: RuntimeCandidate[], options?: { requireTools?: boolean }): RuntimeCandidate {
  let pool = usable
  if (options?.requireTools) {
    const toolCapable = pool.filter(
      (candidate) =>
        candidate.capabilities.toolCalling &&
        candidate.readinessToolCallingPass !== false &&
        (candidate.readinessScore !== undefined || candidate.benchmark !== undefined || !anyReadiness(pool)),
    )
    if (toolCapable.length > 0) pool = toolCapable
  }

  const measured = pool
    .map((candidate) => ({ candidate, tps: tokensPerSecond(candidate.benchmark) }))
    .filter((entry): entry is { candidate: RuntimeCandidate; tps: number } => entry.tps !== undefined)
  if (measured.length > 0) {
    return measured.reduce((best, entry) => (entry.tps > best.tps ? entry : best)).candidate
  }

  // No measurements anywhere: documented heuristic, not a hidden ranking.
  return [...pool].sort((a, b) => heuristicScore(b) - heuristicScore(a))[0]
}

function anyReadiness(pool: RuntimeCandidate[]): boolean {
  return pool.some((candidate) => candidate.readinessScore !== undefined)
}

function choiceReasons(
  winner: RuntimeCandidate,
  all: RuntimeCandidate[],
  options?: { requireTools?: boolean },
): RuntimeChoiceReason[] {
  const reasons: RuntimeChoiceReason[] = []
  const winnerTps = tokensPerSecond(winner.benchmark)

  if (winnerTps !== undefined) {
    reasons.push({ kind: "positive", text: `Measured fastest on this machine: ${winnerTps} tok/s` })
    for (const other of all) {
      if (other.runtimeID === winner.runtimeID) continue
      const otherTps = tokensPerSecond(other.benchmark)
      if (otherTps !== undefined && otherTps < winnerTps) {
        const percent = Math.round(((winnerTps - otherTps) / otherTps) * 100)
        reasons.push({ kind: "positive", text: `${percent}% faster than ${other.runtimeID} in benchmarks` })
      }
    }
  } else {
    reasons.push({ kind: "caveat", text: "No cross-runtime benchmark yet" })
    if (winner.installed) reasons.push({ kind: "positive", text: "Model already available on this runtime" })
    if (winner.capabilities.modelInstall) {
      reasons.push({ kind: "positive", text: "Full lifecycle support through Atlas" })
    }
  }

  if (options?.requireTools && winner.readinessToolCallingPass === true) {
    reasons.push({ kind: "positive", text: "Tool calling passed readiness on this runtime" })
  }
  if (options?.requireTools && winner.capabilities.toolCalling === false) {
    reasons.push({ kind: "caveat", text: "Runtime does not expose tool schemas" })
  }
  return reasons
}

function reasonsFor(candidate: RuntimeCandidate): RuntimeChoiceReason[] {
  const reasons: RuntimeChoiceReason[] = []
  const tps = tokensPerSecond(candidate.benchmark)
  if (tps !== undefined) reasons.push({ kind: "positive", text: `Measured ${tps} tok/s here` })
  if (candidate.readinessScore !== undefined) {
    reasons.push({ kind: "positive", text: `Readiness ${candidate.readinessScore}/100` })
  }
  return reasons
}

function heuristicScore(candidate: RuntimeCandidate): number {
  let score = 0
  if (candidate.installed) score += 10
  if (candidate.capabilities.modelInstall) score += 3
  if (candidate.capabilities.modelRemoval) score += 1
  if (candidate.capabilities.toolCalling) score += 2
  return score
}
