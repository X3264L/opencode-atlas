import type { LocalInstalledModel, LocalRuntimeAdapter, RuntimeDetectionResult } from "../runtime-types"

export const LMSTUDIO_DEFAULT_ENDPOINT = "http://127.0.0.1:1234"

// LM Studio exposes an OpenAI-compatible server on port 1234 and a richer
// REST API under /api/v0 which reports per-model context length and state.
interface LMStudioModel {
  id: string
  object?: string
  context_length?: number
  state?: string
  max_context_length?: number
  loaded_context_length?: number
}

interface FetchLike {
  (input: string, init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string> }): Promise<Response>
}

export function createLMStudioAdapter(options?: { endpoint?: string; fetch?: FetchLike }): LocalRuntimeAdapter {
  const endpoint = options?.endpoint ?? LMSTUDIO_DEFAULT_ENDPOINT
  const doFetch = options?.fetch ?? fetch

  async function request(pathname: string, timeoutMs = 2_000): Promise<Response> {
    return doFetch(`${endpoint}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
  }

  function extractModels(value: unknown): LMStudioModel[] {
    if (!value || typeof value !== "object") return []
    const data = Object.values(value).length > 0 && "data" in value ? (value as { data?: unknown }).data : undefined
    if (!Array.isArray(data)) return []
    return data.filter(
      (item): item is LMStudioModel =>
        !!item && typeof item === "object" && typeof (item as LMStudioModel).id === "string",
    )
  }

  return {
    id: "lmstudio",
    name: "LM Studio",
    endpoint,

    async detect(): Promise<RuntimeDetectionResult> {
      try {
        const res = await request("/v1/models")
        if (!res.ok) throw new Error(String(res.status))
        return { id: "lmstudio", name: "LM Studio", available: true, endpoint }
      } catch {
        return { id: "lmstudio", name: "LM Studio", available: false, endpoint, detail: "not running" }
      }
    },

    async listModels(): Promise<LocalInstalledModel[]> {
      const res = await request("/api/v0/models")
      let items: LMStudioModel[]
      if (res.ok) {
        items = extractModels(await res.json())
      } else {
        // Older builds only expose the OpenAI-compatible listing
        const fallback = await request("/v1/models")
        if (!fallback.ok) throw new Error(`LM Studio /v1/models failed with ${fallback.status}`)
        items = extractModels(await fallback.json())
      }
      return items
        .filter((item) => item.id)
        .map((item) => ({
          id: item.id,
          name: item.id,
          ...(item.max_context_length ? { contextLength: item.loaded_context_length ?? item.max_context_length } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    },
  }
}
