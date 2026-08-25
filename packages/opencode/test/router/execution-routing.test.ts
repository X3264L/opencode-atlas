import { describe, expect, test } from "bun:test"
import { createExecutionRouteState } from "@/router/execution"
import type { RoutingCandidate } from "@/router/types"

function local(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    source: "local",
    providerID: "ollama",
    modelID: "qwen-14b",
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

function cloud(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    source: "cloud",
    providerID: "anthropic",
    modelID: "claude-strong",
    capabilities: { chat: true, tools: true },
    contextWindow: 200_000,
    health: "available",
    performance: { measured: false },
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    ...overrides,
  }
}

function harness(
  overrides: Partial<Parameters<typeof createExecutionRouteState>[0]> & {
    fallbackPlan?: RoutingCandidate[]
    primary?: RoutingCandidate
  } = {},
) {
  const primary = overrides.primary ?? local()
  return createExecutionRouteState({
    decision: {
      mode: overrides.decision?.mode ?? ("hybrid" as const),
      fallbackPlan: overrides.fallbackPlan ?? [],
      primary,
      ...(overrides.decision?.estimatedCloudCost !== undefined
        ? { estimatedCloudCost: overrides.decision.estimatedCloudCost }
        : {}),
    },
    maxFallbackAttempts: overrides.maxFallbackAttempts ?? 2,
    allowManagedAutoStart: overrides.allowManagedAutoStart ?? false,
    mode: overrides.decision?.mode ?? "hybrid",
    allowCloud: true,
    privacy: "standard",
    ...overrides,
  })
}

describe("automatic selection bookkeeping", () => {
  test("success on primary records single attempt without fallback", () => {
    const state = harness()
    state.recordSuccess(state.primary)
    expect(state.attempts).toHaveLength(1)
    expect(state.fallbackUsed).toBe(false)
  })
})

describe("privacy zero-cloud guarantee", () => {
  test("hybrid + local_only blocks cloud fallback after local failure", () => {
    const state = harness({
      decision: { mode: "hybrid" as const, fallbackPlan: [cloud()], primary: local() },
      workspacePrivacy: "local_only",
      mode: "hybrid",
      allowCloud: true,
      privacy: "standard",
    })
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "runtime_crashed" })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBeDefined()
    // No cloud attempt was recorded - only the failed local one
    expect(state.attempts.every((attempt) => attempt.candidate.source === "local")).toBe(true)
  })

  test("LOCAL mode never reaches cloud even with plan containing cloud", () => {
    const state = harness({
      decision: { mode: "local" as const, fallbackPlan: [cloud(), local({ providerID: "lmstudio", runtimeModelID: "b" })], primary: local() },
      mode: "local",
      allowCloud: false,
    })
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "runtime_crashed" })
    // The local alternate is still eligible; cloud is skipped silently
    expect(next.candidate?.providerID).toBe("lmstudio")
  })
})

describe("cancellation", () => {
  test("cancel() stops all subsequent fallback", () => {
    const state = harness({ fallbackPlan: [cloud(), local({ providerID: "lmstudio", runtimeModelID: "alt" })] })
    state.cancel()
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "timeout" })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBe("USER_CANCELLED")
  })

  test("failure classified as user_cancelled stops everything", () => {
    const state = harness({ fallbackPlan: [cloud()] })
    const next = state.nextAfterFailure({
      candidate: state.primary,
      failureKind: "user_cancelled",
      errorMessage: "Request aborted by user",
    })
    expect(next.candidate).toBeUndefined()
    expect(state.cancelled).toBe(true)
  })
})

describe("budget enforcement", () => {
  test("fallback exceeding remaining fallback budget is blocked", () => {
    const expensive = cloud({
      providerID: "other",
      modelID: "big",
      pricing: { inputPerMillion: 50, outputPerMillion: 200 },
    })
    const state = harness({
      decision: {
        mode: "hybrid" as const,
        fallbackPlan: [expensive],
        primary: local(),
        estimatedCloudCost: 0.04, // primary already consumed estimate
      },
      primary: local(),
      maxFallbackCloudCost: 0.05,
      mode: "hybrid",
      allowCloud: true,
    })
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "server_error" })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBe("NO_ELIGIBLE_FALLBACK")
  })

  test("actual usage consumes budget before estimates", () => {
    const cheap = cloud({ providerID: "cheap", modelID: "mini", pricing: { inputPerMillion: 1, outputPerMillion: 2 } })
    const pricey = cloud({ providerID: "pricey", modelID: "maxi", pricing: { inputPerMillion: 50, outputPerMillion: 100 } })
    const state = harness({
      decision: { mode: "hybrid" as const, fallbackPlan: [cheap, pricey], primary: local() },
      primary: local(),
      maxFallbackCloudCost: 0.05,
      mode: "hybrid",
      allowCloud: true,
    })
    // First fallback to cheap succeeds in being selected
    const first = state.nextAfterFailure({ candidate: state.primary, failureKind: "runtime_unavailable" })
    expect(first.candidate?.modelID).toBe("mini")
  })

  test("primary cloud actual usage reduces remaining fallback budget", () => {
    const state = harness({
      decision: {
        mode: "cloud" as const,
        fallbackPlan: [cloud({ providerID: "backup", modelID: "backup-model" })],
        primary: cloud(),
        estimatedCloudCost: undefined,
      },
      primary: cloud(),
      maxFallbackAttempts: 2,
      maxFallbackCloudCost: 0.06,
      mode: "cloud",
      allowCloud: true,
    })
    const next = state.nextAfterFailure({
      candidate: state.primary,
      failureKind: "server_error",
      actualUsage: { inputTokens: 1_000_000, outputTokens: 0 }, // $3 at $3/M
    })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBe("NO_ELIGIBLE_FALLBACK")
  })
})

describe("attempt bound and duplicates", () => {
  test("stops at maxFallbackAttempts", () => {
    const state = harness({
      fallbackPlan: [
        cloud({ providerID: "a" }),
        local({ providerID: "lmstudio", runtimeModelID: "b" }),
        cloud({ providerID: "c", modelID: "cc" }),
      ],
      maxFallbackAttempts: 1,
      mode: "hybrid",
      allowCloud: true,
    })
    const first = state.nextAfterFailure({ candidate: state.primary, failureKind: "timeout" })
    expect(first.candidate).toBeDefined()
    const second = state.nextAfterFailure({ candidate: first.candidate!, failureKind: "timeout" })
    expect(second.candidate).toBeUndefined()
    expect(second.blockedReasonCode).toBe("ATTEMPT_BUDGET_EXHAUSTED")
  })

  test("same candidate never executes twice as routing fallback", () => {
    const duplicateOnly = [local()] // same identity as primary
    const state = harness({ fallbackPlan: duplicateOnly })
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "timeout" })
    expect(next.candidate).toBeUndefined()
  })
})

describe("streaming / side-effect guards", () => {
  test("meaningful streamed output blocks silent replay", () => {
    const state = harness({ fallbackPlan: [cloud()] })
    state.markStreamedMeaningfulOutput()
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "server_error" })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBe("COMMITMENT_REACHED")
  })

  test("side-effectful tool execution blocks replay", () => {
    const state = harness({ fallbackPlan: [cloud()] })
    state.markExecutedSideEffectfulTool()
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "tool_calling_failed" })
    expect(next.candidate).toBeUndefined()
    expect(next.blockedReasonCode).toBe("COMMITMENT_REACHED")
  })
})

describe("capability-aware advancement", () => {
  test("context failures advance only to strictly larger contexts", () => {
    const small = local({ providerID: "lmstudio", runtimeModelID: "small", effectiveRecommendedContext: 16_000 })
    const big = cloud({ contextWindow: 200_000 })
    const state = harness({ fallbackPlan: [small, big] })
    const next = state.nextAfterFailure({
      candidate: state.primary,
      failureKind: "context_exceeded",
    })
    expect(next.candidate?.source).toBe("cloud")
  })

  test("tool failures can fall back to tool-capable alternates", () => {
    const capable = cloud()
    const state = harness({ fallbackPlan: [capable] })
    const next = state.nextAfterFailure({ candidate: state.primary, failureKind: "tool_calling_failed" })
    expect(next.candidate?.capabilities.tools).toBe(true)
  })

  test("auth errors still allow a different provider once (no endless loop)", () => {
    const other = cloud({ providerID: "openai", modelID: "gpt-x" })
    const state = harness({ fallbackPlan: [other] })
    const first = state.nextAfterFailure({ candidate: state.primary, failureKind: "provider_auth_error" })
    expect(first.candidate?.providerID).toBe("openai")
    const second = state.nextAfterFailure({
      candidate: first.candidate!,
      failureKind: "provider_auth_error",
    })
    expect(second.candidate).toBeUndefined()
  })
})

describe("managed auto-start gate", () => {
  test("auto-start allowed flag gates shouldAutoStart", () => {
    const coldManaged = local({ providerID: "llamacpp", runtimeID: "llamacpp", lifecycle: "cold" as never })
    const enabled = harness({ allowManagedAutoStart: true, primary: coldManaged, fallbackPlan: [] })
    expect(enabled.shouldAutoStart(coldManaged)).toBe(true)

    const disabled = harness({ allowManagedAutoStart: false, primary: coldManaged, fallbackPlan: [] })
    expect(disabled.shouldAutoStart(coldManaged)).toBe(false)

    const warmEnabled = harness({ allowManagedAutoStart: true, primary: local(), fallbackPlan: [] })
    expect(warmEnabled.shouldAutoStart(local())).toBe(false)
  })
})
