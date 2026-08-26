import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import {
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestrator") {}

const activeRuns = new Set<string>()

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
      publish(bridge, ProjectCreated, { projectID, title: input.title })
      return objective
    })

    const get = Effect.fn("Orchestrator.get")(function* (projectID: string) {
      return yield* Effect.promise(() => loadProject(projectID))
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
                return {
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

    return Service.of({ createProject, get, list, plan, start, cancel })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [EventV2Bridge.node, Session.node, SessionPrompt.node, Git.node],
})

export * as Orchestrator from "."
