import type { Emit, RoadmapTask, WorkerContract, WorkerResult } from "./types"
import { contractToPrompt } from "./compiler"

// Workers execute through EXISTING OpenCode primitives: a child session is
// created (parented to the project session), the scoped contract becomes its
// prompt, and Atlas routing picks the model via the normal execution-time
// hook (no explicit model set on worker prompts unless policy demands).

export interface WorkerDeps {
  emit: Emit
  createSession: (input: { parentID?: string; title?: string; agent?: string }) => Promise<{ id: string }>
  promptSession: (input: {
    sessionID: string
    parts: { type: "text"; text: string }[]
    agent?: string
    noReply?: boolean
  }) => Promise<{ text: string; tokens?: number }>
  gitStatusFiles: (cwd: string) => Promise<string[]>
  workspace?: string
}

const PROFILE_AGENTS: Record<string, string> = {
  research: "general",
  backend: "general",
  frontend: "general",
  database: "general",
  tests: "general",
  integration: "general",
  review: "general",
}

export async function executeWorker(
  contract: WorkerContract,
  task: RoadmapTask,
  deps: WorkerDeps,
): Promise<WorkerResult & { sessionID: string }> {
  const startedAt = Date.now()
  const agentName = PROFILE_AGENTS[contract.workerProfile ?? ""] ?? "general"

  const session = await deps.createSession({
    title: `[orchestrator] ${contract.taskID}: ${contract.title}`,
    ...(agentName ? { agent: agentName } : {}),
  })
  deps.emit({
    type: "atlas.worker.started",
    projectID: "",
    taskID: contract.taskID,
    ...(contract.workerProfile ? { profile: contract.workerProfile } : {}),
  })

  const promptText = contractToPrompt(contract)
  let summary = ""
  let failure: string | undefined
  try {
    const response = await deps.promptSession({
      sessionID: session.id,
      parts: [{ type: "text", text: promptText }],
      ...(agentName ? { agent: agentName } : {}),
    })
    summary = response.text
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  const filesChanged = await deps.gitStatusFiles(deps.workspace ?? process.cwd()).catch(() => [])

  if (failure !== undefined || /blocked|cannot proceed/i.test(summary)) {
    return {
      taskID: contract.taskID,
      status: failure !== undefined && /cancel/i.test(failure) ? "cancelled" : "failed",
      summary: failure ?? summary,
      artifacts: [],
      ...(filesChanged.length > 0 ? { filesChanged } : {}),
      blockers: failure !== undefined ? [failure] : [`worker reported blocked: ${summary.slice(0, 200)}`],
      startedAt,
      finishedAt: Date.now(),
      sessionID: session.id,
    }
  }

  // Expected artifacts become registry entries backed by the final summary
  const artifacts = contract.expectedArtifacts.map((label, index) => ({
    id: `${contract.taskID}-artifact-${index + 1}`,
    taskID: contract.taskID,
    kind: label.toLowerCase().includes("test") ? "test_result" : "code_patch",
    label,
    ...(summary ? { summary: summary.slice(0, 400) } : {}),
  }))

  return {
    taskID: contract.taskID,
    status: "completed",
    summary: summary.slice(0, 2_000),
    artifacts,
    ...(filesChanged.length > 0 ? { filesChanged } : {}),
    commandsRun: contract.verificationPlan
      .filter((step) => step.kind === "command")
      .map((step) => step.command!)
      .filter(Boolean),
    startedAt,
    finishedAt: Date.now(),
    sessionID: session.id,
  }
}

export function emptyResult(taskID: string, reason: string): WorkerResult {
  return {
    taskID,
    status: "failed",
    summary: reason,
    artifacts: [],
    startedAt: Date.now(),
    finishedAt: Date.now(),
  }
}
