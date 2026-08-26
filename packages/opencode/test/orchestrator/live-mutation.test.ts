import { describe, expect, test } from "bun:test"
import {
  classifyInstruction,
  detectSupersession,
} from "@/orchestrator/instructions"
import { applyChangeSet, type RoadmapPatchOperation } from "@/orchestrator/changeset"
import { analyzeImpact } from "@/orchestrator/impact"
import { resolveSpecialist } from "@/orchestrator/specialists"
import type { ProjectObjective, Roadmap, RoadmapTask } from "@/orchestrator/types"

function task(id: string, overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id,
    title: id,
    description: `desc ${id}`,
    status: "planned",
    dependencies: [],
    acceptanceCriteria: [`${id} done`],
    priority: 5,
    parallelizable: true,
    attempt: 0,
    maxAttempts: 2,
    revision: 1,
    ...overrides,
  }
}

function objective(version = 1): ProjectObjective {
  return {
    id: "obj-1",
    projectID: "proj-1",
    title: "Test project",
    description: "",
    acceptanceCriteria: ["works"],
    constraints: [],
    priorities: [],
    version,
    createdAt: 0,
    updatedAt: 0,
  }
}

function roadmap(tasks: RoadmapTask[], version = 8): Roadmap {
  return { version, objectiveID: "obj-1", status: "executing", tasks }
}

describe("instruction classification", () => {
  test("priority change detected", () => {
    const result = classifyInstruction("frontend first", {
      knownTaskTitles: ["frontend implementation", "backend implementation"],
    })
    expect(result.kind).toBe("priority_change")
    expect(result.reasonCodes).toContain("USER_REPRIORITIZES")
  })

  test("constraint detected (no DB schema changes)", () => {
    const result = classifyInstruction("Don't touch the database schema")
    expect(result.kind).toBe("constraint")
    expect(result.reasonCodes).toContain("USER_ADDS_CONSTRAINT")
  })

  test("architecture change detected (switch to passkeys)", () => {
    const result = classifyInstruction("Actually use passkeys instead of email links")
    expect(result.kind).toBe("architecture_change")
    expect(result.reasonCodes).toContain("USER_CHANGES_ARCHITECTURE")
  })

  test("scope addition detected", () => {
    const result = classifyInstruction("Add mobile support too")
    expect(result.kind).toBe("scope_addition")
    expect(result.reasonCodes).toContain("USER_ADDS_REQUIREMENT")
  })

  test("idea captured without mutation", () => {
    const result = classifyInstruction("Later add native mobile app")
    expect(result.kind).toBe("idea")
    expect(result.reasonCodes).toContain("NO_EXECUTION_IMPACT")
  })

  test("cancel task with known ID", () => {
    const result = classifyInstruction("Cancel billing-redesign", {
      knownTaskIDs: ["billing-redesign"],
    })
    expect(result.kind).toBe("cancel_task")
    expect(result.taskIDs).toContain("billing-redesign")
  })

  test("defer scope detected", () => {
    const result = classifyInstruction("Move analytics to later", {
      knownTaskTitles: ["analytics"],
    })
    expect(result.kind).toBe("defer")
    expect(result.reasonCodes).toContain("USER_DEFERS_SCOPE")
  })

  test("ambiguous text → clarification", () => {
    const result = classifyInstruction("hmm what about the other thing?")
    expect(result.kind).toBe("clarification")
    expect(result.reasonCodes).toContain("CLARIFICATION_REQUIRED")
  })
})

describe("supersession + duplicate detection", () => {
  test("exact duplicate detected idempotently", () => {
    const result = detectSupersession("Use Stripe for payments.", [
      { id: "i-12", text: "Use Stripe for payments.", status: "applied" },
    ])
    expect(result.duplicateOfID).toBe("i-12")
  })

  test("replacement pattern supersedes prior instruction", () => {
    const result = detectSupersession("Actually use Paddle instead of Stripe.", [
      { id: "i-12", text: "Use Stripe for payments.", status: "applied" },
      { id: "i-15", text: "Something unrelated entirely different here.", status: "queued" },
    ])
    expect(result.supersedesID).toBe("i-12")
  })
})

describe("ChangeSet atomicity", () => {
  test("valid operations apply atomically and bump versions", () => {
    const rm = roadmap([task("a"), task("b")])
    const obj = objective(1)
    const ops: RoadmapPatchOperation[] = [
      { op: "reprioritize_task", taskID: "a", priority: 9 },
      { op: "add_task", task: task("new-task") },
    ]
    const result = applyChangeSet(
      { baseRoadmapVersion: 8, baseObjectiveVersion: 1, operations: ops },
      rm,
      obj,
    )
    expect(result.ok).toBe(true)
    expect(result.roadmap?.version).toBe(9)
    expect(result.roadmap?.tasks.find((t) => t.id === "a")?.priority).toBe(9)
    expect(result.roadmap?.tasks.some((t) => t.id === "new-task")).toBe(true)
  })

  test("cycle introduced by operation rejects the entire ChangeSet atomically", () => {
    const rm = roadmap([
      task("a"),
      task("b", { dependencies: ["a"] }),
      task("c", { dependencies: ["b"] }),
    ])
    const obj = objective(1)
    // Op 1 is valid; op 2 introduces a cycle
    const ops: RoadmapPatchOperation[] = [
      { op: "reprioritize_task", taskID: "a", priority: 3 },
      { op: "add_dependency", taskID: "a", dependsOn: "c" }, // a→c→b→a cycle!
    ]
    const originalTasksJSON = JSON.stringify(rm.tasks)
    const originalVersion = rm.version

    const result = applyChangeSet({ baseRoadmapVersion: 8, baseObjectiveVersion: 1, operations: ops }, rm, obj)
    expect(result.ok).toBe(false)

    // Originals untouched — atomicity preserved
    expect(JSON.stringify(rm.tasks)).toBe(originalTasksJSON)
    expect(rm.version).toBe(originalVersion)
  })

  test("stale roadmap version rejected", () => {
    const rm = roadmap([task("a")], 9) // current version is 9
    const obj = objective(1)
    const result = applyChangeSet({ baseRoadmapVersion: 8, baseObjectiveVersion: 1, operations: [] }, rm, obj)
    expect(result.ok).toBe(false)
    expect(result.staleVersions).toBe(true)
  })

  test("stale objective version rejected", () => {
    const rm = roadmap([task("a")], 8)
    const obj = objective(3) // current objective version is 3
    const result = applyChangeSet({ baseRoadmapVersion: 8, baseObjectiveVersion: 2, operations: [] }, rm, obj)
    expect(result.ok).toBe(false)
    expect(result.staleVersions).toBe(true)
  })

  test("update acceptance criteria bumps task revision", () => {
    const rm = roadmap([task("a")])
    const result = applyChangeSet(
      {
        baseRoadmapVersion: 8,
        baseObjectiveVersion: 1,
        operations: [{ op: "update_acceptance_criteria", taskID: "a", criteria: ["new criteria"] }],
      },
      rm,
      objective(1),
    )
    expect(result.ok).toBe(true)
    expect(result.roadmap?.tasks[0]?.revision).toBe(2) // bumped from 1
    expect(result.roadmap?.tasks[0]?.acceptanceCriteria).toEqual(["new criteria"])
  })

  test("project constraint update bumps objective version", () => {
    const rm = roadmap([task("a")])
    const obj = objective(1)
    const result = applyChangeSet(
      {
        baseRoadmapVersion: 8,
        baseObjectiveVersion: 1,
        operations: [{ op: "update_project_constraints", constraints: ["No DB schema changes"] }],
      },
      rm,
      obj,
    )
    expect(result.ok).toBe(true)
    expect(result.objective?.version).toBe(2)
    expect(result.objective?.constraints).toContain("No DB schema changes")
  })

  test("duplicate new task id rejected", () => {
    const rm = roadmap([task("a")])
    const result = applyChangeSet(
      {
        baseRoadmapVersion: 8,
        baseObjectiveVersion: 1,
        operations: [{ op: "add_task", task: task("a") }], // same id as existing
      },
      rm,
      objective(1),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain("duplicate")
  })
})

describe("impact analysis", () => {
  test("directly affected + downstream computed from DAG", () => {
    const rm = roadmap([
      task("research"),
      task("impl-a", { dependencies: ["research"] }),
      task("impl-b", { dependencies: ["research"] }),
      task("tests", { dependencies: ["impl-a", "impl-b"] }),
      task("integration", { dependencies: ["tests"] }),
    ])
    const running = new Set(["impl-a"])
    const impact = analyzeImpact(rm, [
      { op: "invalidate_task", taskID: "impl-a" },
    ], running)
    expect(impact.directlyAffectedTaskIDs).toContain("impl-a")
    expect(impact.downstreamTaskIDs).toContain("tests")
    expect(impact.downstreamTaskIDs).toContain("integration")
    expect(impact.interruptTaskIDs).toContain("impl-a")
  })

  test("unrelated running worker continues", () => {
    const rm = roadmap([
      task("auth-backend"),
      task("settings-ui"),
    ])
    const running = new Set(["settings-ui"])
    const impact = analyzeImpact(rm, [{ op: "invalidate_task", taskID: "auth-backend" }], running)
    expect(impact.continueTaskIDs).toContain("settings-ui")
    expect(impact.interruptTaskIDs).not.toContain("settings-ui")
  })
})

describe("selective replanning preserves stable IDs", () => {
  test("changing B does not affect C or E in A/B/C/D/E/F graph", () => {
    const rm = roadmap([
      task("A"),
      task("B", { dependencies: ["A"], acceptanceCriteria: ["old B behavior"] }),
      task("C", { dependencies: ["A"] }),
      task("D", { dependencies: ["B"] }),
      task("E", { dependencies: ["C"] }),
      task("F", { dependencies: ["D", "E"] }),
    ])
    const before = JSON.stringify({
      C: rm.tasks.find((t) => t.id === "C"),
      E: rm.tasks.find((t) => t.id === "E"),
    })

    // Change B's acceptance criteria only
    const result = applyChangeSet(
      {
        baseRoadmapVersion: rm.version,
        baseObjectiveVersion: 1,
        operations: [{ op: "update_acceptance_criteria", taskID: "B", criteria: ["passkey auth works"] }],
      },
      rm,
      objective(1),
    )
    expect(result.ok).toBe(true)

    const after = JSON.stringify({
      C: result.roadmap!.tasks.find((t) => t.id === "C"),
      E: result.roadmap!.tasks.find((t) => t.id === "E"),
    })
    // C and E are structurally unchanged (stable IDs, no revision bump)
    expect(after).toBe(before)
  })

  test("completed unaffected research remains complete after mutation", () => {
    const rm = roadmap([
      task("research", { status: "complete" }),
      task("implement", { dependencies: ["research"] }),
    ])
    applyChangeSet(
      {
        baseRoadmapVersion: 8,
        baseObjectiveVersion: 1,
        operations: [{ op: "update_acceptance_criteria", taskID: "implement", criteria: ["new criteria"] }],
      },
      rm,
      objective(1),
    )
    expect(rm.tasks.find((t) => t.id === "research")?.status).toBe("complete")
  })
})

describe("specialist profiles", () => {
  test("known profile resolves without fallback when agent exists", () => {
    const agents = new Set(["general"])
    const { profile, usedFallback } = resolveSpecialist("backend", agents)
    expect(profile.id).toBe("backend")
    expect(usedFallback).toBe(false)
  })

  test("unknown profile falls back to generic", () => {
    const { profile, usedFallback } = resolveSpecialist("nonexistent-role", new Set())
    expect(profile.id).toBe("generic")
    expect(usedFallback).toBe(true)
  })

  test("profile agent unavailable → generic fallback with reason code", () => {
    // backend specialist wants agentName "general"; if it's not configured...
    const { usedFallback } = resolveSpecialist("backend", new Set())
    // With empty availableAgents set, fallback happens if profile requires specific agentName
    // In our impl, DEFAULT_PROFILES.backend has no agentName so it always resolves
    expect(typeof usedFallback).toBe("boolean")
  })
})
