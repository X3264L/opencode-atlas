import { describe, expect, test } from "bun:test"
import { classifyTask } from "@/router/classify"
import { buildCloudCandidates, buildLocalCandidates } from "@/router/candidates"
import { estimateCloudCost } from "@/router/filter"
import {
  fallbackForContextExceeded,
  mayFallback,
  route,
} from "@/router/route"
import { classifyFailureFromMessage } from "@/router/types"
import type { AtlasRoutingPolicy, RoutingCandidate, RoutingRequest } from "@/router/types"

function policy(overrides: Partial<AtlasRoutingPolicy> = {}): AtlasRoutingPolicy {
  return {
    mode: "auto",
    privacy: "standard",
    allowCloud: true,
    preferLocal: true,
    allowManagedAutoStart: false,
    maxFallbackAttempts: 2,
    latencyPreference: "balanced",
    ...overrides,
  }
}

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    surface: "chat",
    estimatedInputTokens: 4_000,
    estimatedOutputTokens: 1_000,
    policy: policy(),
    ...overrides,
  }
}

function localCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    source: "local",
    providerID: "ollama",
    modelID: "qwen2.5-coder-14b",
    runtimeID: "ollama",
    runtimeModelID: "qwen2.5-coder:14b-q6_K",
    capabilities: { chat: true, tools: true },
    contextWindow: 32_768,
    effectiveRecommendedContext: 32_768,
    health: "available",
    performance: { tokensPerSecond: 60, measured: true },
    lifecycle: "warm",
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    ...overrides,
  }
}

function cloudCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    source: "cloud",
    providerID: "anthropic",
    modelID: "claude-strong",
    capabilities: { chat: true, tools: true, vision: true },
    contextWindow: 200_000,
    health: "available",
    performance: { measured: false },
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    ...overrides,
  }
}

const reasonsOf = (decision: ReturnType<typeof route>) => decision.selected ? decision.reasons.map((r) => r.code) : []
const altReasonCodes = (decision: ReturnType<typeof route>, source: string) =>
  decision.alternatives.filter((a) => a.candidate.source === source).flatMap((a) => a.reasons.map((r) => r.code))

describe("task classification", () => {
  test("tiny edits classify as trivial", () => {
    const result = classifyTask(request({ surface: "edit", estimatedInputTokens: 500 }))
    expect(result.taskClass).toBe("tiny_edit")
    expect(result.difficulty).toBeLessThan(0.2)
  })

  test("agentic tool tasks are demanding", () => {
    const result = classifyTask(request({ surface: "agent.tool", requiresTools: true, fileCount: 6 }))
    expect(result.taskClass).toBe("agentic_tool_task")
    expect(result.difficulty).toBeGreaterThan(0.4)
  })

  test("vision requirement wins classification", () => {
    const result = classifyTask(request({ requiresVision: true }))
    expect(result.taskClass).toBe("vision_task")
  })

  test("long context is recognized structurally", () => {
    const result = classifyTask(request({ estimatedInputTokens: 120_000 }))
    expect(result.taskClass).toBe("long_context_analysis")
  })
})

describe("routing modes", () => {
  test("LOCAL picks local even when cloud is stronger", () => {
    const decision = route(
      request({
        policy: policy({ mode: "local" }),
        requiresTools: true,
        estimatedInputTokens: 20_000,
      }),
      [
        localCandidate(),
        cloudCandidate({ contextWindow: 200_000, pricing: { inputPerMillion: 0.01, outputPerMillion: 0.03 } }),
      ],
    )
    expect(decision.selected?.source).toBe("local")
    expect(altReasonCodes(decision, "cloud")).toContain("CLOUD_DISABLED")
  })

  test("LOCAL with no capable local fails without any cloud selection", () => {
    const decision = route(
      request({ policy: policy({ mode: "local" }), requiresTools: true }),
      [cloudCandidate()],
    )
    expect(decision.selected).toBeUndefined()
    expect(decision.alternatives.every((a) => a.candidate.source !== "cloud" || a.rejected)).toBe(true)
    expect(decision.fallbackPlan).toHaveLength(0)
    expect(decision.reasons.map((r) => r.code)).toContain("NO_CAPABLE_CANDIDATE")
  })

  test("CLOUD excludes automatic local candidates even when warm and fast", () => {
    const decision = route(
      request({ policy: policy({ mode: "cloud" }) }),
      [localCandidate(), cloudCandidate()],
    )
    expect(decision.selected?.source).toBe("cloud")
    expect(altReasonCodes(decision, "local")).toContain("CLOUD_MODE_LOCAL_EXCLUDED")
  })

  test("HYBRID prefers capable local primary with cloud in fallback plan", () => {
    const decision = route(
      request({ policy: policy({ mode: "hybrid" }), requiresTools: true }),
      [localCandidate({ readiness: { score: 90, tools: true } }), cloudCandidate()],
    )
    expect(decision.selected?.source).toBe("local")
    expect(decision.fallbackPlan.some((c) => c.source === "cloud")).toBe(true)
  })

  test("AUTO selects warm capable local for small tasks", () => {
    const decision = route(request(), [localCandidate(), cloudCandidate()])
    expect(decision.selected?.source).toBe("local")
    expect(reasonsOf(decision)).toContain("MODEL_WARM")
    expect(reasonsOf(decision)).toContain("LOCAL_FREE")
  })

  test("AUTO can select cloud when evidence favors it (no capable local)", () => {
    const decision = route(
      request({ requiresTools: true }),
      [
        localCandidate({ readiness: { score: 20, tools: false }, performance: { tokensPerSecond: 3, measured: true } }),
        cloudCandidate(),
      ],
    )
    // Local tool readiness FAILED -> hard rejected; only cloud survives
    expect(decision.selected?.source).toBe("cloud")
    expect(altReasonCodes(decision, "local")).toContain("READINESS_FAILED")
  })
})

describe("hard capability filtering", () => {
  test("tools required + failed tool readiness rejects local candidate", () => {
    const decision = route(
      request({ requiresTools: true, policy: policy({ mode: "hybrid" }) }),
      [localCandidate({ readiness: { score: 30, tools: false } }), cloudCandidate()],
    )
    expect(decision.selected?.source).toBe("cloud")
  })

  test("vision required + text-only candidate is hard-rejected", () => {
    const decision = route(request({ requiresVision: true }), [
      localCandidate({ capabilities: { chat: true, tools: true, vision: false } }),
      cloudCandidate(),
    ])
    expect(decision.selected?.source).toBe("cloud")
    expect(altReasonCodes(decision, "local")).toContain("CAPABILITY_VISION_MISSING")
  })

  test("context larger than effective capacity rejects local", () => {
    const decision = route(
      request({ estimatedInputTokens: 28_000 }),
      [
        // model max 128K but machine only recommends 16K
        localCandidate({ contextWindow: 128_000, effectiveRecommendedContext: 16_000 }),
        cloudCandidate(),
      ],
    )
    expect(decision.selected?.source).toBe("cloud")
    expect(altReasonCodes(decision, "local")).toContain("CONTEXT_TOO_LARGE")
  })

  test("unavailable runtime is rejected before scoring matters", () => {
    const decision = route(request(), [
      localCandidate({ health: "unavailable", performance: { tokensPerSecond: 999, measured: true } }),
      cloudCandidate(),
    ])
    expect(decision.selected?.source).toBe("cloud")
    expect(altReasonCodes(decision, "local")).toContain("RUNTIME_UNAVAILABLE")
  })
})

describe("privacy enforcement", () => {
  test("workspace local_only + hybrid + local failure = zero cloud selection", () => {
    const decision = route(
      request({
        policy: policy({ mode: "hybrid" }),
        workspacePrivacy: "local_only",
        requiresTools: true,
      }),
      [
        // The ONLY local candidate cannot do tools
        localCandidate({ readiness: { score: 10, tools: false } }),
        cloudCandidate(),
      ],
    )
    expect(decision.selected).toBeUndefined()
    expect(decision.alternatives.filter((a) => a.candidate.source === "cloud").every((a) => a.rejected)).toBe(true)
    expect(decision.fallbackPlan.filter((c) => c.source === "cloud")).toHaveLength(0)
    expect(decision.reasons.some((r) => r.code === "PRIVACY_LOCAL_ONLY")).toBe(true)
  })

  test("allowCloud=false kills every cloud candidate even in AUTO", () => {
    const decision = route(
      request({ policy: policy({ allowCloud: false }) }),
      [cloudCandidate(), localCandidate({ lifecycle: "not_installed" as never })],
    )
    expect(decision.selected?.source).toBe("local")
  })
})

describe("cost model", () => {
  test("candidate over budget cap is rejected", () => {
    const expensive = cloudCandidate({ pricing: { inputPerMillion: 10, outputPerMillion: 60 } })
    const costRequest = request({ estimatedInputTokens: 30_000, estimatedOutputTokens: 4_000 })
    const decision = route(
      { ...costRequest, policy: policy({ maxCloudCostPerRequest: 0.05 }) },
      [expensive, localCandidate()],
    )
    // 30k*10/M + 4k*60/M = $0.54 - far over the $0.05 cap
    expect(estimateCloudCost(expensive, costRequest)).toBeGreaterThan(0.05)
    expect(decision.selected?.source).toBe("local")
    expect(altReasonCodes(decision, "cloud")).toContain("COST_OVER_BUDGET")
  })

  test("unknown price is never treated as free", () => {
    const mystery = cloudCandidate({ pricing: undefined })
    const cost = estimateCloudCost(mystery, request())
    expect(cost).toBe("unknown")

    const decision = route(request(), [mystery])
    expect(decision.confidence).not.toBe("high")
    expect(decision.alternatives[0]?.reasons.map((r) => r.code)).toContain("UNKNOWN_COST")
  })
})

describe("warm / cold state", () => {
  test("warm local beats cold local", () => {
    const warm = localCandidate()
    const cold = localCandidate({ providerID: "llamacpp", runtimeModelID: "other.gguf", lifecycle: "cold" as never, performance: { tokensPerSecond: 60, measured: true } })
    const decision = route(request(), [cold, warm])
    expect(decision.selected?.lifecycle).toBe("warm")
  })

  test("stopped managed model with auto-start disabled stays cold but usable", () => {
    const stopped = localCandidate({
      providerID: "llamacpp",
      lifecycle: "cold" as never,
      performance: undefined,
    })
    const decision = route(request({ policy: policy({ allowManagedAutoStart: false }) }), [stopped])
    expect(decision.selected?.source).toBe("local")
    expect(reasonsOf(decision).concat(decision.alternatives.flatMap((a) => a.reasons.map((r) => r.code)))).toContain("MODEL_COLD")
  })
})

describe("manual override", () => {
  test("explicit model bypasses routing entirely", () => {
    const decision = route(
      request({
        explicitModel: { providerID: "openai", modelID: "gpt-small" },
        requiresTools: true,
        requiresVision: true,
      }),
      [localCandidate(), cloudCandidate()],
    )
    expect(decision.bypassed).toBe(true)
    expect(decision.selected?.providerID).toBe("openai")
    expect(decision.selected?.modelID).toBe("gpt-small")
    expect(decision.reasons.map((r) => r.code)).toContain("USER_EXPLICIT_MODEL")
    expect(decision.fallbackPlan).toHaveLength(0)
  })
})

describe("fallback classification and bounds", () => {
  test("user cancellation never falls back", () => {
    const verdict = mayFallback("user_cancelled", request({ policy: policy({ mode: "hybrid" }) }))
    expect(verdict.allowed).toBe(false)
  })

  test("local-only workspace blocks cloud fallback even on runtime crash", () => {
    const verdict = mayFallback(
      "runtime_crashed",
      request({ policy: policy({ mode: "hybrid" }), workspacePrivacy: "local_only" }),
    )
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain("workspace policy")
  })

  test("hybrid allows bounded cloud fallback after runtime crash", () => {
    const verdict = mayFallback("runtime_crashed", request({ policy: policy({ mode: "hybrid" }) }))
    expect(verdict.allowed).toBe(true)
  })

  test("context failures only fall back to strictly larger contexts", () => {
    const plan = [
      localCandidate({ effectiveRecommendedContext: 16_000 }),
      cloudCandidate({ contextWindow: 200_000 }),
      cloudCandidate({ providerID: "other", contextWindow: 8_000 }),
    ]
    const viable = fallbackForContextExceeded(plan, 24_000)
    expect(viable).toHaveLength(1)
    expect(viable[0]?.contextWindow).toBe(200_000)
  })

  test("failure classifier maps messages to stable kinds", () => {
    expect(classifyFailureFromMessage("Request aborted by user").kind).toBe("user_cancelled")
    expect(classifyFailureFromMessage("HTTP 401 unauthorized").kind).toBe("provider_auth_error")
    expect(classifyFailureFromMessage("429 too many requests").kind).toBe("provider_rate_limited")
    expect(classifyFailureFromMessage("context length exceeded").kind).toBe("context_exceeded")
    expect(classifyFailureFromMessage("llama-server crashed unexpectedly").kind).toBe("runtime_crashed")
    expect(classifyFailureFromMessage("connection refused").kind).toBe("runtime_unavailable")
  })
})

describe("trace quality", () => {
  test("decision carries alternatives with scores, rejection reasons and confidence", () => {
    const decision = route(
      request({ requiresTools: true, policy: policy({ mode: "hybrid" }) }),
      [
        localCandidate(),
        cloudCandidate(),
        localCandidate({ providerID: "lmstudio", runtimeModelID: "x", capabilities: { chat: true, tools: false }, health: "available" }),
      ],
    )
    expect(decision.mode).toBe("hybrid")
    expect(decision.selected).toBeDefined()
    expect(["high", "medium", "low"]).toContain(decision.confidence)
    expect(decision.alternatives.length).toBe(3)
    for (const alternative of decision.alternatives) {
      if (alternative.rejected) expect(alternative.reasons.length).toBeGreaterThan(0)
      else expect(typeof alternative.score).toBe("number")
    }
    expect(decision.classification.taskClass.length).toBeGreaterThan(0)
  })
})

describe("candidate normalization adapters", () => {
  test("buildLocalCandidates maps installed models to candidates", () => {
    const candidates = buildLocalCandidates({
      state: {
        runtimes: [{ id: "ollama", available: true }],
        installed: { ollama: [{ id: "qwen2.5-coder:14b-q6_K", quantization: "Q6_K", toolCalling: true }] },
        benchmarks: { ollama: { "qwen2.5-coder:14b-q6_K": { success: true, tokensPerSecond: 51.7 } } },
        readiness: { ollama: { "qwen2.5-coder:14b-q6_K": { score: 96, toolCalling: true } } },
        recommendations: [],
      },
      lifecycleFor: () => "warm",
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      source: "local",
      runtimeModelID: "qwen2.5-coder:14b-q6_K",
      lifecycle: "warm",
    })
    expect(candidates[0]?.performance?.tokensPerSecond).toBe(51.7)
    expect(candidates[0]?.readiness?.score).toBe(96)
  })

  test("buildCloudCandidates skips injected-local providers and unauthenticated ones", () => {
    const candidates = buildCloudCandidates(
      {
        ollama: { id: "ollama", key: "local", models: { "x": { limit: { context: 8192 } } } },
        anthropic: {
          id: "anthropic",
          key: "sk-test",
          models: { "claude": { capabilities: { toolcall: true }, cost: { input: 3, output: 15 }, limit: { context: 200_000 } } },
        },
        broken: { id: "broken", models: {} },
      },
      { connectedProviders: ["anthropic"] },
    )
    const ids = candidates.map((candidate) => `${candidate.providerID}/${candidate.modelID}`)
    expect(ids).toEqual(["anthropic/claude"])
    expect(candidates[0]?.health).toBe("available")
  })
})
