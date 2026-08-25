import type { RoutingCandidate } from "./types"

// Normalization adapters: local models (Local AI state) and cloud models
// (OpenCode provider registry) become one comparable candidate shape.

interface LocalStateLike {
  runtimes?: { id: string; available: boolean; health?: { state: string } }[]
  installed?: Record<string, { id: string; quantization?: string; toolCalling?: boolean; vision?: boolean }[]>
  benchmarks?: Record<string, Record<string, { success: boolean; tokensPerSecond?: number; timeToFirstTokenMs?: number }>>
  readiness?: Record<string, Record<string, { score?: number; toolCalling?: boolean }>>
  recommendations?: {
    model: { id: string }
    variant: { id?: string; runtimeTag?: string; contextLength?: number }
    estimated?: { contextLength?: number }
    runtime?: { id: string }
  }[]
}

/**
 * Builds local candidates from the Local AI snapshot. Only models actually
 * installed on an AVAILABLE runtime become candidates - warm/installed
 * lifecycle comes from the managed manager + ollama tags.
 */
export function buildLocalCandidates(input: {
  state: LocalStateLike
  /** runtimeModelID → "warm" | "cold" for known instances */
  lifecycleFor?: (runtimeID: string, runtimeModelID: string) => "warm" | "cold" | "not_installed"
  /** Atlas hardware-recommended context per catalog model id, when known */
  recommendedContext?: Record<string, number>
}): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = []
  const healthByRuntime = new Map<string, "available" | "degraded" | "unavailable">()
  for (const runtime of input.state.runtimes ?? []) {
    const raw = runtime.health?.state ?? (runtime.available ? "available" : "unavailable")
    healthByRuntime.set(
      runtime.id,
      raw === "available" || raw === "degraded" ? (raw as "available" | "degraded") : "unavailable",
    )
  }

  // Recommendation gives the best catalog-matched variant per model
  const recommendationByTag = new Map<string, (NonNullable<LocalStateLike["recommendations"]>[number])>()
  for (const recommendation of input.state.recommendations ?? []) {
    const tag = recommendation.variant.runtimeTag
    if (tag) recommendationByTag.set(tag, recommendation)
  }

  for (const [runtimeID, models] of Object.entries(input.state.installed ?? {})) {
    const health = healthByRuntime.get(runtimeID) ?? "unavailable"
    if (health === "unavailable") continue
    for (const model of models) {
      const benchmark = input.state.benchmarks?.[runtimeID]?.[model.id]
      const readiness = input.state.readiness?.[runtimeID]?.[model.id]
      const recommendation = recommendationByTag.get(model.id)
      const contextWindow =
        recommendation?.estimated?.contextLength ??
        (recommendation?.variant.contextLength !== undefined && recommendation.variant.contextLength > 0
          ? Math.min(recommendation.variant.contextLength, 262_144)
          : undefined)

      candidates.push({
        source: "local",
        providerID: runtimeID,
        modelID: recommendation?.model.id ?? model.id,
        runtimeID,
        runtimeModelID: model.id,
        ...(recommendation?.variant.id ? { variantID: recommendation.variant.id } : {}),
        capabilities: {
          chat: true,
          tools: model.toolCalling,
          vision: model.vision,
          structuredOutput: readiness?.score !== undefined ? readiness.score >= 40 : undefined,
        },
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(recommendation?.estimated?.contextLength !== undefined
          ? { effectiveRecommendedContext: recommendation.estimated.contextLength }
          : {}),
        health,
        ...(readiness
          ? {
              readiness: {
                ...(readiness.score !== undefined ? { score: readiness.score } : {}),
                tools: readiness.toolCalling,
              },
            }
          : {}),
        ...(benchmark?.success && benchmark.tokensPerSecond
          ? {
              performance: {
                tokensPerSecond: benchmark.tokensPerSecond,
                ...(benchmark.timeToFirstTokenMs !== undefined
                  ? { timeToFirstTokenMs: benchmark.timeToFirstTokenMs }
                  : {}),
                measured: true,
              },
            }
          : {}),
        lifecycle: input.lifecycleFor?.(runtimeID, model.id) ?? "warm",
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      })
    }
  }
  return candidates
}

interface ProviderInfoLike {
  id: string
  key?: string
  connected?: boolean
  models: Record<
    string,
    {
      capabilities?: { toolcall?: boolean; attachment?: boolean; input?: { image?: boolean }; reasoning?: boolean }
      cost?: { input?: number; output?: number }
      limit?: { context?: number; output?: number }
      status?: string
    }
  >
}

/**
 * Builds cloud candidates from OpenCode's provider registry. Providers marked
 * with the local sentinel key are skipped (those are injected local runtimes).
 * Auth availability decides health: a provider without credentials is
 * unavailable rather than a risky maybe.
 */
export function buildCloudCandidates(
  providers: Record<string, ProviderInfoLike>,
  options?: { connectedProviders?: string[] },
): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = []
  for (const [providerID, info] of Object.entries(providers)) {
    if (info.key === "local") continue // injected local runtime, handled by buildLocalCandidates
    const connected = options?.connectedProviders ? options.connectedProviders.includes(providerID) : Boolean(info.key) || Boolean(info.connected)
    for (const [modelID, model] of Object.entries(info.models ?? {})) {
      if (model.status === "deprecated") continue
      const inputImage = model.capabilities?.input?.image === true
      const pricingInput = model.cost?.input
      const pricingOutput = model.cost?.output
      candidates.push({
        source: "cloud",
        providerID,
        modelID,
        capabilities: {
          chat: true,
          tools: model.capabilities?.toolcall,
          vision: inputImage || model.capabilities?.attachment === true ? true : inputImage,
          structuredOutput: model.capabilities?.toolcall === true ? true : undefined,
        },
        ...(model.limit?.context !== undefined ? { contextWindow: model.limit.context } : {}),
        health: connected ? "available" : "unavailable",
        performance: { measured: false },
        ...(pricingInput !== undefined && pricingOutput !== undefined
          ? { pricing: { inputPerMillion: pricingInput, outputPerMillion: pricingOutput } }
          : {}),
      })
    }
  }
  return candidates
}
