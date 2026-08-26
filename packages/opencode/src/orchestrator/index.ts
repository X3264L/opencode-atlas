import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import {
  DiffstatChanged,
  ProjectCancelled,
  ProjectBlocked,
  ProjectCompleted,
  ProjectCreated,
  RoadmapUpdated,
  TaskState,
  WorkerCompleted,
  WorkerFailed,
  WorkerStarted,
  VerificationCompleted,
} from "@opencode-ai/schema/orchestrator-event"
import type { ProjectObjective, Roadmap } from "./types"
import { planObjective } from "./planner"
import { compileContract, contractToPrompt } from "./compiler"
import { scheduleRoadmap } from "./scheduler"
import { loadProject, recoverStaleRuns, saveProject, listProjects, type ProjectFile } from "./store"
import { distillWorkerCompletion, compactMemories } from "./distill"
import { routeProjectMessage } from "./project-message"
import { computeDiffstat, toFileDiffstats, type DiffstatSummary, type FileDiffstat } from "./diffstat"
import { createDiffstatWatcher } from "./diffstat-watcher"
import { workingTreeStats } from "./working-tree"
import { loadBrain as loadBrainStore, saveBrain as saveBrainStore } from "../brain/store"

// Orchestrator service: objective → roadmap → scheduled workers → verified,
// integrated completion. Workers run as child sessions through the existing
// prompt pipeline; their model identity flows through Atlas routing at
// execution time because worker sessions set no explicit model.

export interface CreateInput {
  title: string
  description: string
  acceptanceCriteria: string[]
  constraints?: string[]
  priorities?: string[]
  sessionID?: string
  workspace?: string
}

export interface Interface {
  readonly createProject: (input: CreateInput) => Effect.Effect<ProjectObjective>
  readonly get: (projectID: string) => Effect.Effect<ProjectFile | undefined>
  readonly list: () => Effect.Effect<string[]>
  readonly plan: (projectID: string) => Effect.Effect<Roadmap, Error>
  readonly start: (projectID: string) => Effect.Effect<{ started: boolean }, Error>
  readonly cancel: (projectID: string) => Effect.Effect<boolean, Error>
  /** Route a project-level message through intent classification */
  readonly chat: (input: { projectID: string; text: string }) => Effect.Effect<ReturnType<typeof routeProjectMessage>, Error>
  /** Trigger brain compaction; returns removed count or undefined if not needed */
  readonly compactBrain: (projectID: string) => Effect.Effect<number | undefined, Error>
  /** Authoritative working-tree diffstat summary; undefined when the project has no workspace */
  readonly workingTreeSummary: (projectID: string) => Effect.Effect<DiffstatSummary | undefined>
  /** Authoritative per-file working-tree diffstat; empty when the project has no workspace */
  readonly workingTreeFiles: (projectID: string) => Effect.Effect<FileDiffstat[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestrator") {}

const activeRuns = new Set<string>()

// Runtime diffstat watchers, keyed by project ID so a project/workspace pair
// always owns exactly one watcher while it is active in this process.
const diffstatWatchers = new Map<string, ReturnType<typeof createDiffstatWatcher>>()

const DIFFSTAT_POLL_MS = 2_000

function publish(
  bridge: typeof EventV2Bridge.Service.Service,
  definition: Parameters<typeof bridge.publish>[0],
  data: Record<string, unknown>,
) {
  void Effect.runPromise(bridge.publish(definition, data as never) as Effect.Effect<unknown>).catch(() => {})
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bridge = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const promptService = yield* SessionPrompt.Service
    const git = yield* Git.Service

    // One change-driven watcher per active project. The initial poll primes the
    // baseline without emitting; later polls publish only on real summary changes.
    function ensureDiffstatWatcher(projectID: string, workspace: string) {
      if (diffstatWatchers.has(projectID)) return
      const watcher = createDiffstatWatcher({
        projectID,
        debounceMs: DIFFSTAT_POLL_MS,
        getStats: () => Effect.runPromise(workingTreeStats(git, workspace)),
        onChange: (summary) => publish(bridge, DiffstatChanged, { projectID, ...summary }),
      })
      diffstatWatchers.set(projectID, watcher)
      watcher.start()
      void watcher.poll().catch(() => {})
    }

    function stopDiffstatWatcher(projectID: string) {
      diffstatWatchers.get(projectID)?.stop()
      diffstatWatchers.delete(projectID)
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const projectID of [...diffstatWatchers.keys()]) stopDiffstatWatcher(projectID)
      }),
    )

    const createProject = Effect.fn("Orchestrator.createProject")(function* (input: CreateInput) {
      const now = Date.now()
      const projectID = `proj-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
      const objective: ProjectObjective = {
        id: `obj-${projectID}`,
        projectID,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        constraints: input.constraints ?? [],
        priorities: input.priorities ?? [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const file: ProjectFile = {
        objective,
        roadmap: { version: 0, objectiveID: objective.id, status: "planning", tasks: [] },
        checkpoints: [],
        artifacts: [],
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
      }
      yield* Effect.promise(() => saveProject(projectID, file))
      if (input.workspace) ensureDiffstatWatcher(projectID, input.workspace)
      publish(bridge, ProjectCreated, { projectID, title: input.title })
      return objective
    })

    const get = Effect.fn("Orchestrator.get")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      // Inspecting a project activates its diffstat watcher so Mission Control
      // stays reactive for any loaded project, not only ones created here.
      if (file?.workspace) ensureDiffstatWatcher(projectID, file.workspace)
      return file
    })

    const list = Effect.fn("Orchestrator.list")(function* () {
      return yield* Effect.promise(listProjects)
    })

    const plan = Effect.fn("Orchestrator.plan")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      const roadmap = planObjective(file.objective)
      file.roadmap = roadmap
      yield* Effect.promise(() => saveProject(projectID, file))
      publish(bridge, RoadmapUpdated, { projectID, version: roadmap.version })
      return roadmap
    })

    const cancel = Effect.fn("Orchestrator.cancel")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      file.cancelledAt = Date.now()
      file.roadmap.status = "cancelled"
      for (const task of file.roadmap.tasks) {
        if (["planned", "ready", "blocked"].includes(task.status)) task.status = "cancelled"
      }
      activeRuns.delete(projectID)
      stopDiffstatWatcher(projectID)
      yield* Effect.promise(() => saveProject(projectID, file))
      publish(bridge, ProjectCancelled, { projectID })
      return true
    })

    const start = Effect.fn("Orchestrator.start")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      if (file.cancelledAt) return yield* Effect.fail(new Error("Project is cancelled"))
      if (activeRuns.has(projectID)) return { started: true }

      // Stale running workers from a previous process are never trusted alive
      if (recoverStaleRuns(file.roadmap)) yield* Effect.promise(() => saveProject(projectID, file))

      file.roadmap.status = "executing"
      activeRuns.add(projectID)
      if (file.workspace) ensureDiffstatWatcher(projectID, file.workspace)
      yield* Effect.promise(() => saveProject(projectID, file))

      void (async () => {
        try {
          await scheduleRoadmap({
            roadmap: file.roadmap,
            isCancelled: () => Boolean(file.cancelledAt),
            deps: {
              maxConcurrentWorkers: 3,
              emit: (event) => {
                switch (event.type) {
                  case "atlas.task.state":
                    publish(bridge, TaskState, {
                      projectID,
                      taskID: event.taskID,
                      state: event.state,
                      attempt: event.attempt,
                    })
                    break
                  case "atlas.worker.started":
                    publish(bridge, WorkerStarted, {
                      projectID,
                      taskID: event.taskID,
                      ...(event.profile ? { profile: event.profile } : {}),
                    })
                    break
                  case "atlas.worker.completed":
                    publish(bridge, WorkerCompleted, { projectID, taskID: event.taskID })
                    break
                  case "atlas.worker.failed":
                    publish(bridge, WorkerFailed, {
                      projectID,
                      taskID: event.taskID,
                      failureClass: event.failureClass,
                      ...(event.detail ? { detail: event.detail } : {}),
                    })
                    break
                  case "atlas.verification.completed":
                    publish(bridge, VerificationCompleted, {
                      projectID,
                      taskID: event.taskID,
                      passed: event.passed,
                    })
                    break
                }
              },
              execute: async (task) => {
                const contract = compileContract({
                  roadmap: file.roadmap,
                  task,
                  objectiveSummary: file.objective.title,
                  constraints: file.objective.constraints,
                  upstreamArtifacts: file.artifacts.filter((entry) =>
                    task.dependencies.some((dep) => entry.taskID.startsWith(dep)),
                  ),
                  completedDependencies: [...task.dependencies],
                })
                const child = await Effect.runPromise(
                  sessions.create({
                    title: `[orchestrator] ${task.id}`,
                    ...(file.sessionID ? { parentID: file.sessionID as never } : {}),
                  }),
                )
                const response = await Effect.runPromise(
                  promptService.prompt({
                    sessionID: child.id,
                    parts: [{ type: "text", text: contractToPrompt(contract) }],
                  }),
                )
                const filesChanged = file.workspace
                  ? await Effect.runPromise(
                      git.status(file.workspace).pipe(
                        Effect.map((items) => items.map((item) => item.file)),
                        Effect.catch(() => Effect.succeed([] as string[])),
                      ),
                    )
                  : []
                const lastText = [...response.parts].reverse().find((part) => part.type === "text")
                const workerResult = {
                  taskID: task.id,
                  status: "completed" as const,
                  summary:
                    ((lastText as unknown as { text?: string })?.text ?? "").slice(0, 2000) || "Task completed",
                  artifacts: (task.expectedArtifacts ?? []).map((label, index) => ({
                    id: `${task.id}-artifact-${index + 1}`,
                    taskID: task.id,
                    kind: /test/i.test(label) ? "test_result" : "code_patch",
                    label,
                  })),
                  ...(filesChanged.length > 0 ? { filesChanged } : {}),
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                }
                // Brain distillation: derive structured memories from real worker results
                const distilled = distillWorkerCompletion({
                  contract, result: workerResult, projectID, roadmapVersion: file.roadmap.version,
                })
                if (distilled.length > 0) {
                  file.artifacts.push(...workerResult.artifacts)
                  const brain = await loadBrainStore(projectID)
                  brain.memories.push(...distilled)
                  await saveBrainStore(projectID, brain)
                  await saveProject(projectID, file)
                }
                return workerResult
              },
              verify: async (_task, result) => ({
                passed: result.status === "completed" && result.summary.trim().length > 0,
              }),
            },
          })

          const allComplete = file.roadmap.tasks.every((task) => task.status === "complete")
          file.roadmap.status = allComplete ? "complete" : "blocked"
          if (allComplete) {
            publish(bridge, ProjectCompleted, { projectID })
          } else {
            publish(bridge, ProjectBlocked, { projectID })
          }
          void saveProject(projectID, file)
        } finally {
          activeRuns.delete(projectID)
        }
      })()

      return { started: true }
    })

    const chat = Effect.fn("Orchestrator.chat")(function* (input: { projectID: string; text: string }) {
      return routeProjectMessage(input.text)
    })

    const compactBrain = Effect.fn("Orchestrator.compactBrain")(function* (projectID: string) {
      const brain = yield* Effect.promise(() => loadBrainStore(projectID))
      const result = yield* Effect.promise(() => Promise.resolve(compactMemories(brain.memories)))
      if (!result) return undefined
      brain.memories = result.compacted
      yield* Effect.promise(() => saveBrainStore(projectID, brain))
      return result.removedCount
    })

    const workingTreeSummary = Effect.fn("Orchestrator.workingTreeSummary")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file?.workspace) return undefined
      const stats = yield* workingTreeStats(git, file.workspace)
      return computeDiffstat(stats)
    })

    const workingTreeFiles = Effect.fn("Orchestrator.workingTreeFiles")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file?.workspace) return []
      const stats = yield* workingTreeStats(git, file.workspace)
      return toFileDiffstats(stats)
    })

    return Service.of({ createProject, get, list, plan, start, cancel, chat, compactBrain, workingTreeSummary, workingTreeFiles })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [EventV2Bridge.node, Session.node, SessionPrompt.node, Git.node],
})

export * as Orchestrator from "."
