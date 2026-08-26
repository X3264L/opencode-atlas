import type { ProjectObjective, Roadmap, RoadmapTask } from "./types"
import { validateRoadmap, type DagValidation } from "./dag"

// Deterministic heuristic planner: decomposes the objective into a
// research → per-criterion implementation → tests → integration → final
// verification shape. An LLM-backed planner can later produce candidate IR;
// it must pass through the same validation/normalization here.

let counter = 0
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

function task(input: Partial<RoadmapTask> & { id: string; title: string; description: string }): RoadmapTask {
  return {
    status: "planned",
    dependencies: [],
    acceptanceCriteria: [],
    priority: 5,
    parallelizable: true,
    attempt: 0,
    maxAttempts: 2,
    ...input,
  }
}

/** One constrained normalization pass over planner output */
export function normalizeRoadmap(roadmap: Roadmap): Roadmap {
  const seen = new Set<string>()
  for (const task of roadmap.tasks) {
    let id = task.id || uid("task")
    while (seen.has(id)) id = `${id}-x`
    seen.add(id)
    task.id = id
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      task.acceptanceCriteria = [`Work for "${task.title}" is demonstrably present`]
    }
    if (!Number.isFinite(task.priority)) task.priority = 5
    if (!(task.maxAttempts >= 1)) task.maxAttempts = 2
    task.attempt ??= 0
    task.status = "planned"
  }
  // Remap unknown dependency ids to nothing rather than executing garbage
  const ids = new Set(roadmap.tasks.map((task) => task.id))
  for (const task of roadmap.tasks) {
    task.dependencies = task.dependencies.filter((dep) => ids.has(dep) && dep !== task.id)
  }
  roadmap.version += 1
  return roadmap
}

export interface PlanDeps {
  validate?: (roadmap: Roadmap) => DagValidation
}

/**
 * Heuristic objective → roadmap. Produces:
 *   research (inspect relevant architecture)
 *   one implementation task per acceptance criterion group
 *   tests task depending on implementations
 *   integration task depending on impls + tests
 *   final verification depending on integration
 */
export function planObjective(objective: ProjectObjective, deps?: PlanDeps): Roadmap {
  const tasks: RoadmapTask[] = []
  const validate = deps?.validate ?? validateRoadmap

  tasks.push(
    task({
      id: "research",
      title: `Inspect current architecture for: ${objective.title}`,
      description: `Investigate the existing code related to this objective and record findings as reusable context.\n\n${objective.description}`,
      acceptanceCriteria: [
        "Relevant files/modules identified",
        "A short written summary of the current approach exists",
      ],
      affectedAreas: ["docs/research"],
      workerProfile: "research",
      preferredCapabilities: ["read", "search"],
      priority: 9,
    }),
  )

  const criteria = objective.acceptanceCriteria.length > 0 ? objective.acceptanceCriteria : [objective.title]
  const implIds: string[] = []
  criteria.forEach((criterion, index) => {
    const id = `impl-${index + 1}`
    implIds.push(id)
    tasks.push(
      task({
        id,
        title: `Implement: ${criterion}`,
        description: `Implement the work needed to satisfy: ${criterion}\n\nConstraints:\n${objective.constraints.map((entry) => `- ${entry}`).join("\n") || "- none"}`,
        dependencies: ["research"],
        acceptanceCriteria: [criterion],
        workerProfile: "backend",
        preferredCapabilities: ["edit", "tools"],
        priority: 7 - Math.min(index, 3),
      }),
    )
  })

  tasks.push(
    task({
      id: "tests",
      title: "Add/adjust tests covering the new behavior",
      description: "Cover each acceptance criterion with deterministic tests.",
      dependencies: [...implIds],
      acceptanceCriteria: ["Tests exist and pass locally"],
      affectedAreas: ["tests"],
      workerProfile: "tests",
      preferredCapabilities: ["test"],
      priority: 4,
    }),
    task({
      id: "integration",
      title: "Integrate cross-task changes",
      description: "Check combined diffs, interface compatibility and cross-task assumptions.",
      dependencies: [...implIds, "tests"],
      acceptanceCriteria: ["No conflicting changes remain", "Combined build/typecheck passes"],
      affectedAreas: ["*"],
      workerProfile: "integration",
      parallelizable: false,
      priority: 3,
    }),
    task({
      id: "final-verify",
      title: "Final project verification",
      description: "Verify the objective's acceptance criteria end-to-end.",
      dependencies: ["integration"],
      acceptanceCriteria: [...objective.acceptanceCriteria],
      workerProfile: "review",
      parallelizable: false,
      priority: 10,
    }),
  )

  // Attach objective priorities/constraints to every task contract source
  for (const t of tasks) {
    ;(t as RoadmapTask & { objectivePriorities?: string[] }).objectivePriorities = objective.priorities
  }

  let roadmap: Roadmap = {
    version: 1,
    objectiveID: objective.id,
    status: "planning",
    tasks,
  }

  // One constrained repair pass for near-miss planner output; invalid IR is
  // still never executed.
  const preCheck = validate(roadmap)
  if (!preCheck.ok) {
    roadmap = normalizeRoadmap(roadmap)
  }
  const check = validate(roadmap)
  if (!check.ok) throw new Error(`Planner produced invalid roadmap: ${check.errors.join("; ")}`)
  return roadmap
}
