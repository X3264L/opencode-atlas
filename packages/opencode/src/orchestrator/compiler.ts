import type { ContextReference, Roadmap, RoadmapTask, VerificationStep, WorkerArtifact, WorkerContract } from "./types"

/** Compiles a ready roadmap task into a scoped worker contract */
export function compileContract(input: {
  roadmap: Roadmap
  task: RoadmapTask
  objectiveSummary: string
  constraints: string[]
  upstreamArtifacts: WorkerArtifact[]
  completedDependencies: string[]
  extraContext?: ContextReference[]
}): WorkerContract {
  const { roadmap, task } = input
  const contextRefs: ContextReference[] = [
    ...input.upstreamArtifacts.map(
      (artifact): ContextReference => ({
        kind: "artifact",
        id: artifact.id,
        locator: artifact.locator,
        summary: artifact.summary ?? artifact.label,
      }),
    ),
    ...(input.extraContext ?? []),
  ]

  const verificationPlan: VerificationStep[] = [
    ...task.acceptanceCriteria.map((criterion) => ({
      kind: "review" as const,
      criteria: [criterion],
    })),
    ...task.affectedAreas
      ?.filter((area) => /\.(test|spec)\./i.test(area) || /test/i.test(area))
      .map((area) => ({ kind: "file_exists" as const, path: area })) ?? [],
  ]

  return {
    taskID: task.id,
    roadmapVersion: roadmap.version,
    objectiveSummary: input.objectiveSummary,
    title: task.title,
    description: task.description,
    completedDependencies: input.completedDependencies,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: input.constraints,
    contextRefs,
    expectedArtifacts: task.expectedArtifacts ?? [],
    workerProfile: task.workerProfile,
    preferredCapabilities: task.preferredCapabilities,
    verificationPlan,
  }
}

export function contractToPrompt(contract: WorkerContract): string {
  const lines = [
    `# Task: ${contract.title}`,
    "",
    `Objective: ${contract.objectiveSummary}`,
    "",
    "## Description",
    contract.description,
    "",
    "## Acceptance criteria",
    ...contract.acceptanceCriteria.map((entry) => `- ${entry}`),
  ]
  if (contract.constraints.length > 0) {
    lines.push("", "## Constraints", ...contract.constraints.map((entry) => `- ${entry}`))
  }
  if (contract.completedDependencies.length > 0) {
    lines.push("", "## Completed upstream tasks", ...contract.completedDependencies.map((entry) => `- ${entry}`))
  }
  if (contract.contextRefs.length > 0) {
    lines.push(
      "",
      "## Relevant context",
      ...contract.contextRefs.map((ref) => `- [${ref.kind}] ${ref.summary ?? ref.id}${ref.locator ? ` (${ref.locator})` : ""}`),
    )
  }
  if (contract.expectedArtifacts.length > 0) {
    lines.push("", "## Expected outputs", ...contract.expectedArtifacts.map((entry) => `- ${entry}`))
  }
  if (contract.verificationPlan.length > 0) {
    lines.push(
      "",
      "## Verification expectations",
      ...contract.verificationPlan.map((step) => {
        if (step.kind === "command") return `- command must succeed: \`${step.command}\``
        if (step.kind === "test") return `- tests must pass${step.target ? ` (${step.target})` : ""}`
        if (step.kind === "file_exists") return `- file must exist: ${step.path}`
        return `- review against: ${(step.criteria ?? []).join("; ")}`
      }),
    )
  }
  return lines.join("\n")
}
