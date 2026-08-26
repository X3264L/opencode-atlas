import type { BrainQuery, ProjectMemory, ScoredMemory } from "./types"
import { AUTHORITY_ORDER } from "./types"

// Authority-ranked retrieval: structured filters first, then lexical scoring,
// then authority/recency boost. Current truth beats similar stale history.

/**
 * Ranks memories for a query. Hard-filters wrong project/invalidated items,
 * then scores by: lexical match, authority, status/currentness, recency.
 */
export function retrieveMemories(
  allMemories: ProjectMemory[],
  query: BrainQuery,
): ScoredMemory[] {
  const lower = query.query.toLowerCase()
  const queryWords = new Set(lower.split(/\s+/).filter((w) => w.length >= 3))

  const results: ScoredMemory[] = []

  for (const memory of allMemories) {
    // Hard filter: project boundary
    if (memory.projectID !== query.projectID) continue

    // Hard filter: invalidated/superseded unless historical explicitly requested
    if (!query.includeHistorical && (memory.status === "invalidated" || memory.status === "superseded")) continue

    // Hard filter: kind filter
    if (query.kinds && !query.kinds.includes(memory.kind)) continue

    // Hard filter: task filter
    if (query.taskIDs && !query.taskIDs.includes(memory.taskID ?? "")) continue

    const reasons: string[] = []
    let score = 0

    // Lexical relevance
    const searchable = `${memory.title} ${memory.content} ${memory.tags.join(" ")}`.toLowerCase()
    let lexicalMatches = 0
    for (const word of queryWords) {
      if (searchable.includes(word)) lexicalMatches += 1
    }
    if (queryWords.size > 0) {
      score += (lexicalMatches / queryWords.size) * 30
      if (lexicalMatches > 0) reasons.push(`lexical:${lexicalMatches}/${queryWords.size}`)
    }

    // Authority ranking
    const authorityScore = AUTHORITY_ORDER[memory.authority] / 6
    score += authorityScore * 25
    if (memory.authority === "user") reasons.push("authority:user")
    if (memory.authority === "source_state") reasons.push("authority:source_state")

    // Status/currentness
    if (memory.status === "active") score += 20
    else if (memory.status === "stale") score -= 10
    else if (memory.status === "historical") score += 5

    // Recency boost (newer is better, capped)
    const ageMs = Date.now() - memory.updatedAt
    const ageHours = ageMs / 3_600_000
    const recencyBoost = Math.max(0, Math.min(10, 10 - ageHours))
    score += recencyBoost

    // Confidence
    score += memory.confidence * 15

    // Exact task ID match
    if (query.taskIDs?.some((id) => memory.taskID === id)) {
      score += 25
      reasons.push("task_match")
    }
  }

  return results
}

/**
 * Full retrieval implementation that actually populates results.
 */
export function retrieve(
  allMemories: ProjectMemory[],
  query: BrainQuery,
): ScoredMemory[] {
  const lower = query.query.toLowerCase()
  const queryWords = new Set(lower.split(/\s+/).filter((w) => w.length >= 3))

  const scored: ScoredMemory[] = []

  for (const memory of allMemories) {
    // ---- hard filters ----
    if (memory.projectID !== query.projectID) continue
    if (!query.includeHistorical && (memory.status === "invalidated" || memory.status === "superseded")) continue
    if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(memory.kind)) continue
    if (query.taskIDs && query.taskIDs.length > 0) {
      if (!memory.taskID || !query.taskIDs.includes(memory.taskID)) continue
    }

    const reasons: string[] = []
    let score = 0

    // ---- lexical scoring ----
    const searchable = `${memory.title} ${memory.content} ${memory.tags.join(" ")}`.toLowerCase()
    let lexicalHits = 0
    for (const word of queryWords) {
      if (searchable.includes(word)) lexicalHits += 1
    }
    if (queryWords.size > 0) {
      const lexicalRatio = lexicalHits / queryWords.size
      score += lexicalRatio * 30
      if (lexicalHits > 0) reasons.push(`lexical:${lexicalHits}`)
    }

    // ---- authority ----
    const authOrder = AUTHORITY_ORDER[memory.authority] ?? 1
    score += (authOrder / 6) * 25
    if (authOrder >= 5) reasons.push("high_authority")

    // ---- status currentness ----
    switch (memory.status) {
      case "active":
        score += 20
        break
      case "historical":
        score += 5
        break
      case "stale":
        score -= 10
        break
      case "invalidated":
      case "superseded":
        score -= 20
        break
    }

    // ---- recency ----
    const ageH = (Date.now() - memory.updatedAt) / 3_600_000
    score += Math.max(0, Math.min(10, 10 - ageH))

    // ---- confidence ----
    score += memory.confidence * 15

    // ---- exact task/artifact match ----
    if (query.taskIDs?.length && memory.taskID && query.taskIDs.includes(memory.taskID)) {
      score += 25
      reasons.push("exact_task")
    }

    scored.push({ memory, score: Math.round(score * 100) / 100, matchReasons: reasons })
  }

  scored.sort((a, b) => b.score - a.score)

  const max = query.maxItems ?? 20
  return scored.slice(0, max)
}
