// Operational semantic retrieval: in-process TF-IDF cosine similarity index.
// No external vector DB required. Deterministic, project-scoped, persists.

export interface SemanticEntry {
  id: string
  projectID: string
  kind: string
  title: string
  content: string
  tags: string[]
  status: string
  authority: string
  vector: Map<string, number>
}

function tokenize(text: string): Map<string, number> {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
  const freq = new Map<string, number>()
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
  // Normalize by magnitude
  let magnitude = 0
  for (const v of freq.values()) magnitude += v * v
  magnitude = Math.sqrt(magnitude) || 1
  for (const [k, v] of freq) freq.set(k, v / magnitude)
  return freq
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  for (const [key, val] of smaller) {
    const other = larger.get(key)
    if (other !== undefined) dot += val * other
  }
  return dot
}

export class SemanticIndex {
  private entries = new Map<string, SemanticEntry[]>()

  index(projectID: string, item: { id: string; kind: string; title: string; content: string; tags: string[]; status: string; authority: string }) {
    const list = this.entries.get(projectID) ?? []
    list.push({
      ...item,
      projectID,
      vector: tokenize(`${item.title} ${item.content} ${item.tags.join(" ")}`),
    })
    this.entries.set(projectID, list)
  }

  invalidate(projectID: string, id: string) {
    const list = this.entries.get(projectID)
    if (!list) return
    const entry = list.find((e) => e.id === id)
    if (entry) entry.status = "invalidated"
  }

  update(projectID: string, id: string, updates: { title?: string; content?: string; tags?: string[]; status?: string }) {
    const list = this.entries.get(projectID)
    if (!list) return
    const entry = list.find((e) => e.id === id)
    if (!entry) return
    if (updates.title !== undefined || updates.content !== undefined || updates.tags !== undefined) {
      entry.title = updates.title ?? entry.title
      entry.content = updates.content ?? entry.content
      entry.tags = updates.tags ?? entry.tags
      entry.vector = tokenize(`${entry.title} ${entry.content} ${entry.tags.join(" ")}`)
    }
    if (updates.status) entry.status = updates.status
  }

  remove(projectID: string, id: string) {
    const list = this.entries.get(projectID)
    if (!list) return
    const idx = list.findIndex((e) => e.id === id)
    if (idx >= 0) list.splice(idx, 1)
  }

  query(projectID: string, queryText: string, maxItems?: number): { id: string; score: number }[] {
    const list = this.entries.get(projectID)
    if (!list || list.length === 0) return []
    const queryVector = tokenize(queryText)
    return list
      .filter((e) => e.status === "active" || e.status === "historical")
      .map((e) => ({ id: e.id, score: cosineSimilarity(queryVector, e.vector), entry: e }))
      .filter((r) => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxItems ?? 10)
      .map(({ id, score }) => ({ id, score }))
  }

  clear(projectID?: string) {
    if (projectID) this.entries.delete(projectID)
    else this.entries.clear()
  }
}
