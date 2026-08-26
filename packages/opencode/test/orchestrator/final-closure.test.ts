import { describe, expect, test } from "bun:test"
import type { RoadmapTask } from "@/orchestrator/types"
import type { ProjectMemory } from "@/brain/types"
import { SemanticIndex } from "@/brain/semantic"
import { countTokens } from "@/supervisor/tokenizer"
import { ResourceSlotManager } from "@/orchestrator/resource-slots"
import { createHandoff, handoffToPromptText } from "@/orchestrator/handoff"
import { routeProjectMessage } from "@/orchestrator/project-message"
import type { WorkerResult, WorkerContract } from "@/orchestrator/types"
import { distillWorkerCompletion } from "@/orchestrator/distill"

// ---- 1. Semantic retrieval ----

describe("semantic retrieval", () => {
  const index = new SemanticIndex()

  test("indexes and retrieves by semantic similarity", () => {
    index.index("p1", {
      id: "d1", kind: "decision", title: "Use passkeys for auth",
      content: "We chose WebAuthn passkeys over email links for authentication.",
      tags: ["auth", "passkey"], status: "active", authority: "source_state",
    })
    index.index("p1", {
      id: "c1", kind: "constraint", title: "No DB schema changes",
      content: "The project explicitly prohibits modifying the database schema.",
      tags: ["db", "schema"], status: "active", authority: "user",
    })

    // Exact keyword match
    let results = index.query("p1", "passkey authentication")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.id).toBe("d1")

    // Paraphrased query (different words, same concept)
    results = index.query("p1", "webauthn credential login method")
    expect(results.length).toBeGreaterThan(0)
  })

  test("cross-project isolation", () => {
    const results = index.query("other-project", "passkey")
    expect(results).toHaveLength(0)
  })

  test("invalidated memory excluded from current retrieval", () => {
    index.invalidate("p1", "c1")
    const results = index.query("p1", "database schema changes prohibited")
    expect(results.every((r) => r.id !== "c1")).toBe(true)
  })
})

// ---- 2. Tokenizer hierarchy ----

describe("tokenizer hierarchy", () => {
  test("model-family tokenizer path for known families", () => {
    const result = countTokens("function foo() { return 42; }", "qwen2.5-coder-14b-q6_K")
    expect(result.method).toBe("model_family_tokenizer")
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.confidence).toBe("medium")
  })

  test("conservative fallback for unknown models", () => {
    const result = countTokens("some text here", undefined)
    expect(result.method).toBe("local_tokenizer")
    expect(result.tokens).toBeGreaterThan(0)
  })

  test("empty text returns zero tokens", () => {
    const result = countTokens("", undefined)
    expect(result.tokens).toBe(0)
  })

  test("long identifiers get extra tokens", () => {
    const short = countTokens("hello world", undefined)
    const long = countTokens("hello world this-is-a-very-long-descriptive-identifier-name-here", undefined)
    expect(long.tokens).toBeGreaterThan(short.tokens)
  })
})

// ---- 3. Hardware-aware resource slots ----

describe("hardware resource slots", () => {
  test("16GB VRAM: 12GB worker starts, second 12GB worker waits", () => {
    const mgr = new ResourceSlotManager({
      maxWorkers: 4,
      maxLocalHeavyWorkers: 2,
      maxLocalLightWorkers: 2,
      maxCloudWorkers: 10,
      availableVRAMMB: 16_000,
    })
    expect(mgr.reserve("task-a", 12_000, 8_000)).toBe(true)
    const check = mgr.canAdmit("task-b", 12_000, 8_000)
    expect(check.admitted).toBe(false)
    expect(check.reason).toContain("VRAM")
  })

  test("two 4GB workers fit concurrently in 16GB VRAM", () => {
    const mgr = new ResourceSlotManager({
      maxWorkers: 4,
      maxLocalHeavyWorkers: 2,
      maxLocalLightWorkers: 2,
      maxCloudWorkers: 10,
      availableVRAMMB: 16_000,
    })
    expect(mgr.reserve("a", 4_000, 2_000)).toBe(true)
    expect(mgr.reserve("b", 4_000, 2_000)).toBe(true)
    expect(mgr.activeReservations).toHaveLength(2)
  })

  test("release frees VRAM for next worker", () => {
    const mgr = new ResourceSlotManager({
      maxWorkers: 4,
      maxLocalHeavyWorkers: 2,
      maxLocalLightWorkers: 2,
      maxCloudWorkers: 10,
      availableVRAMMB: 16_000,
    })
    mgr.reserve("a", 14_000, 8_000)
    mgr.release("a")
    expect(mgr.reserve("b", 14_000, 8_000)).toBe(true)
  })
})

// ---- 4. Structured worker handoff ----

describe("worker handoff", () => {
  test("handoff marks all artifacts stale on failed worker (conservative safety)", () => {
    const priorResult: WorkerResult = {
      taskID: "backend-auth", status: "failed",
      summary: "Failed after implementing partial passkey support",
      artifacts: [
        { id: "art-valid-1", taskID: "backend-auth", kind: "code_patch", label: "partial implementation" },
        { id: "art-stale-1", taskID: "backend-auth", kind: "api_contract", label: "outdated API spec" },
      ],
      blockers: ["missing WebAuthn library"],
      startedAt: Date.now() - 5000, finishedAt: Date.now(),
    }
    const handoff = createHandoff({
      toRoleID: "backend",
      taskID: "backend-auth",
      taskRevision: 3,
      priorResult,
      reasonCode: "reassign_specialist_after_failure",
    })
    // Conservative: on failure ALL artifacts are stale until proven otherwise
    expect(handoff.validArtifactIDs).toHaveLength(0)
    expect(handoff.staleArtifactIDs).toContain("art-valid-1")
    expect(handoff.staleArtifactIDs).toContain("art-stale-1")
    expect(handoff.blockers).toContain("missing WebAuthn library")
    expect(handoff.reasonCode).toBe("reassign_specialist_after_failure")
  })

  test("handoff renders as prompt context for replacement worker", () => {
    const handoff = createHandoff({
      toRoleID: "backend",
      taskID: "t-1",
      taskRevision: 2,
      reasonCode: "retry_new_session",
    })
    handoff.blockers.push("previous attempt hit timeout")
    handoff.validArtifactIDs.push("artifact-42")

    const text = handoffToPromptText(handoff)
    expect(text).toContain("Handoff from previous worker")
    expect(text).toContain("- artifact-42")
    expect(text).toContain("- previous attempt hit timeout")
  })
})

// ---- 5. Distillation produces brain memories ----

describe("distillation → brain memories", () => {
  test("worker completion with artifacts + evidence produces multiple memories", () => {
    const contract: WorkerContract = {
      taskID: "impl-passkey", roadmapVersion: 5,
      objectiveSummary: "Auth upgrade", title: "Passkey backend",
      description: "", completedDependencies: [],
      acceptanceCriteria: ["Registration works"], constraints: ["No DB changes"],
      contextRefs: [], expectedArtifacts: ["API endpoint"],
      verificationPlan: [{ kind: "review", criteria: ["Registration works"] }],
    }
    const result: WorkerResult = {
      taskID: "impl-passkey", status: "completed",
      summary: "Implemented POST /auth/passkey/register",
      artifacts: [{ id: "art-1", taskID: "impl-passkey", kind: "code_patch", label: "API endpoint" }],
      filesChanged: ["src/auth/passkey.ts"],
      verificationEvidence: [{ step: { kind: "review", criteria: ["Registration works"] }, passed: true }],
      startedAt: Date.now() - 5000, finishedAt: Date.now(),
    }
    const memories = distillWorkerCompletion({ contract, result, projectID: "proj-1", roadmapVersion: 5 })
    const kinds = memories.map((m) => m.kind)
    expect(kinds).toContain("worker_outcome")
    expect(kinds).toContain("artifact_summary")
    expect(kinds).toContain("verification_evidence")
    expect(memories.every((m) => m.projectID === "proj-1")).toBe(true)
  })

  test("failed worker produces failure + blocker memories", () => {
    const contract: WorkerContract = {
      taskID: "t-f", roadmapVersion: 3, objectiveSummary: "", title: "",
      description: "", completedDependencies: [], acceptanceCriteria: ["ok"],
      constraints: [], contextRefs: [], expectedArtifacts: [], verificationPlan: [],
    }
    const result: WorkerResult = {
      taskID: "t-f", status: "failed", summary: "Build failed on Windows",
      artifacts: [], blockers: ["Windows path separator issue"],
      startedAt: 0, finishedAt: Date.now(),
    }
    const memories = distillWorkerCompletion({ contract, result, projectID: "p1", roadmapVersion: 3 })
    expect(memories.some((m) => m.kind === "blocker" && m.content.includes("Windows"))).toBe(true)
  })
})
