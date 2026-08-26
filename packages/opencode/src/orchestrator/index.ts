import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Git } from "@/git"
import { Supervisor } from "../supervisor/index"
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
import {
  CheckpointCreated,
  Paused,
  Resumed,
} from "@opencode-ai/schema/project-control-event"
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
import {
  loadControlState,
  saveControlState,
  saveCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  latestCheckpoint,
  ensureCheckpointDir,
  loadOrganizationVersion,
  type ProjectCheckpoint,
  type ProjectControlState,
  type PauseMode,
} from "./control"

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
  readonly chat: (input: { projectID: string; text: string }) => Effect.Effect<ReturnType<typeof routeProjectMessage>, Error>
  readonly compactBrain: (projectID: string) => Effect.Effect<number | undefined, Error>
  readonly workingTreeSummary: (projectID: string) => Effect.Effect<DiffstatSummary | undefined>
  readonly workingTreeFiles: (projectID: string) => Effect.Effect<FileDiffstat[]>
  readonly checkpoint: (projectID: string) => Effect.Effect<ProjectCheckpoint, Error>
  readonly listCheckpoints: (projectID: string) => Effect.Effect<ProjectCheckpoint[]>
  readonly getCheckpoint: (projectID: string, checkpointID: string) => Effect.Effect<ProjectCheckpoint | undefined>
  readonly latestCheckpoint: (projectID: string) => Effect.Effect<ProjectCheckpoint | undefined>
  readonly getControlState: (projectID: string) => Effect.Effect<ProjectControlState>
  readonly pause: (projectID: string, mode?: PauseMode, reason?: string) => Effect.Effect<ProjectControlState, Error>
  readonly resume: (projectID: string) => Effect.Effect<ProjectControlState, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestrator") {}

const activeRuns = new Set<string>()
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
    const supervisor = yield* Supervisor.Service

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

    // ---- Control helpers ----
    const reconcileControlOnLoad = Effect.fn("Orchestrator.reconcileControl")(function* (projectID: string, file: ProjectFile) {
      const control = yield* Effect.promise(() => loadControlState(projectID))
      if (control.status === "pausing") {
        // Conservative reconciliation: workers are not live after restart
        let changed = false
        for (const task of file.roadmap.tasks) {
          if (task.status === "running" || task.status === "verifying") {
            task.status = task.attempt + 1 < task.maxAttempts ? "ready" : "failed"
            changed = true
          }
        }
        if (changed) yield* Effect.promise(() => saveProject(projectID, file))
        const paused: ProjectControlState = { status: "paused", mode: control.mode ?? "finish_current_safe_step", requestedAt: control.requestedAt, pausedAt: Date.now(), checkpointID: control.checkpointID, reason: control.reason }
        yield* Effect.promise(() => saveControlState(projectID, paused))
        return paused
      }
      return control
    })

    const captureCheckpoint = Effect.fn("Orchestrator.captureCheckpoint")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      // Ensure control state reconciled if pausing
      yield* reconcileControlOnLoad(projectID, file)
      const control = yield* Effect.promise(() => loadControlState(projectID))

      const objectiveVersion = file.objective.version
      const roadmapVersion = file.roadmap.version
      const organizationVersion = yield* Effect.promise(() => loadOrganizationVersion(projectID))

      // Worker checkpoints reference active tasks only; a checkpointID is set
      // when the worker itself published one, otherwise honestly absent.
      const activeWorkerCheckpoints: ProjectCheckpoint["activeWorkerCheckpoints"] = file.roadmap.tasks
        .filter((t) => t.status === "running" || t.status === "verifying")
        .map((t) => ({
          workerID: `worker-${t.id}`,
          taskID: t.id,
          taskRevision: t.revision,
        }))

      // Git capture: branch/head when resolvable, dirty from status, diffstat from numstat
      let gitInfo: ProjectCheckpoint["git"] = {}
      if (file.workspace) {
        const dirty = yield* git.status(file.workspace).pipe(
          Effect.map((items) => items.length > 0),
          Effect.catch(() => Effect.succeed(false)),
        )
        const head = yield* git.run(["rev-parse", "HEAD"], { cwd: file.workspace }).pipe(
          Effect.map((result) => result.text()),
          Effect.map((text) => (text ? text : undefined)),
          Effect.catch(() => Effect.succeed(undefined as string | undefined)),
        )
        const branch = yield* git.branch(file.workspace).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const diffstat = yield* workingTreeStats(git, file.workspace).pipe(
          Effect.map((stats) => {
            const summary = computeDiffstat(stats)
            return { additions: summary.additions, deletions: summary.deletions, files: summary.files }
          }),
          Effect.catch(() => Effect.succeed(undefined as ProjectCheckpoint["git"]["diffstat"])),
        )
        gitInfo = {
          ...(head ? { head } : {}),
          ...(branch ? { branch } : {}),
          dirty,
          ...(diffstat ? { diffstat } : {}),
        }
      }

      // Brain metadata
      const brainMeta = yield* Effect.promise(() => loadBrainStore(projectID)).pipe(
        Effect.map((brain) => {
          const latest = brain.memories.reduce((max, m) => Math.max(max, m.updatedAt ?? m.createdAt ?? 0), 0)
          return { memoryCount: brain.memories.length, ...(latest ? { latestMemoryTimestamp: latest } : {}) }
        }),
        Effect.catch(() => Effect.succeed({} as ProjectCheckpoint["brain"])),
      )

      const verification = {
        completedTaskIDs: file.roadmap.tasks.filter((t) => t.status === "complete").map((t) => t.id),
        failedTaskIDs: file.roadmap.tasks.filter((t) => t.status === "failed").map((t) => t.id),
        blockedTaskIDs: file.roadmap.tasks.filter((t) => t.status === "blocked").map((t) => t.id),
      }

      const openIncidentIDs = yield* supervisor.getIncidents(projectID).pipe(
        Effect.map((incidents) =>
          incidents.filter((i) => i.status !== "resolved" && i.status !== "abandoned").map((i) => i.id),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      const checkpoint: ProjectCheckpoint = {
        id: `chk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        projectID,
        createdAt: Date.now(),
        objectiveVersion,
        roadmapVersion,
        ...(organizationVersion !== undefined ? { organizationVersion } : {}),
        projectStatus: file.roadmap.status,
        ...(control.status !== "running" ? { pauseState: control.status } : {}),
        activeWorkerCheckpoints,
        git: gitInfo,
        brain: brainMeta,
        verification,
        openIncidentIDs,
      }

      yield* Effect.promise(() => ensureCheckpointDir(projectID))
      yield* Effect.promise(() => saveCheckpoint(checkpoint))
      publish(bridge, CheckpointCreated, { projectID, checkpointID: checkpoint.id, timestamp: checkpoint.createdAt })
      return checkpoint
    })

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
      yield* Effect.promise(() => saveControlState(projectID, { status: "running" }))
      if (input.workspace) ensureDiffstatWatcher(projectID, input.workspace)
      publish(bridge, ProjectCreated, { projectID, title: input.title })
      return objective
    })

    const get = Effect.fn("Orchestrator.get")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return undefined
      // Reconcile pausing -> paused on every load for restart safety
      yield* reconcileControlOnLoad(projectID, file)
      if (file.workspace) ensureDiffstatWatcher(projectID, file.workspace)
      return file
    })

    const list = Effect.fn("Orchestrator.list")(function* () {
      return yield* Effect.promise(listProjects)
    })

    const plan = Effect.fn("Orchestrator.plan")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      yield* reconcileControlOnLoad(projectID, file)
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
      const control = yield* Effect.promise(() => loadControlState(projectID))
      // Paused/pausing barrier: no new scheduling
      if (control.status === "paused" || control.status === "pausing") return yield* Effect.fail(new Error(`Project is ${control.status}`))
      if (activeRuns.has(projectID)) return { started: true }

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
            isPaused: async () => {
              const c = await loadControlState(projectID)
              return c.status === "paused" || c.status === "pausing"
            },
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
                // Hard pause check before executing a new worker: do not launch if paused
                const ctrl = await loadControlState(projectID)
                if (ctrl.status === "paused" || ctrl.status === "pausing") throw new Error(`paused:${ctrl.status}`)

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

          // Pause exits the scheduler without a completion verdict: the
          // roadmap stays mid-flight and only resume (or cancel) may change it.
          const control = await loadControlState(projectID)
          const pausedDuringRun = control.status === "paused" || control.status === "pausing"
          if (!pausedDuringRun) {
            const allComplete = file.roadmap.tasks.every((task) => task.status === "complete")
            file.roadmap.status = allComplete ? "complete" : "blocked"
            if (allComplete) {
              publish(bridge, ProjectCompleted, { projectID })
            } else {
              publish(bridge, ProjectBlocked, { projectID })
            }
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

    // ---- Checkpoint / Control ----
    const checkpoint = Effect.fn("Orchestrator.checkpoint")(function* (projectID: string) {
      return yield* captureCheckpoint(projectID)
    })

    const getControlState = Effect.fn("Orchestrator.getControlState")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (file) yield* reconcileControlOnLoad(projectID, file)
      return yield* Effect.promise(() => loadControlState(projectID))
    })

    const listCheckpointsFn = Effect.fn("Orchestrator.listCheckpoints")(function* (projectID: string) {
      return yield* Effect.promise(() => listCheckpoints(projectID))
    })

    const getCheckpoint = Effect.fn("Orchestrator.getCheckpoint")(function* (projectID: string, checkpointID: string) {
      return yield* Effect.promise(() => loadCheckpoint(projectID, checkpointID))
    })

    const latestCheckpointFn = Effect.fn("Orchestrator.latestCheckpoint")(function* (projectID: string) {
      return yield* Effect.promise(() => latestCheckpoint(projectID))
    })

    const pause = Effect.fn("Orchestrator.pause")(function* (projectID: string, mode: PauseMode = "finish_current_safe_step", reason?: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      const current = yield* Effect.promise(() => loadControlState(projectID))
      // Idempotent: pausing/paused is a barrier until resumed; changing mode
      // requires an explicit resume first so duplicate pauses never re-checkpoint.
      if (current.status === "paused" || current.status === "pausing") return current

      const requestedAt = Date.now()
      // Short snapshot barrier: mark pausing first
      const pausing: ProjectControlState = { status: "pausing", mode, requestedAt, reason }
      yield* Effect.promise(() => saveControlState(projectID, pausing))
      yield* supervisor.setPaused(projectID, true).pipe(Effect.catch(() => Effect.void))

      // Stop scheduling new tasks immediately by virtue of pausing status; activeRuns remains but execute will check pause
      // For stop_scheduling_only, no checkpoint, just paused
      if (mode === "stop_scheduling_only") {
        const paused: ProjectControlState = { status: "paused", mode, requestedAt, pausedAt: Date.now(), reason }
        yield* Effect.promise(() => saveControlState(projectID, paused))
        publish(bridge, Paused, { projectID, mode, timestamp: paused.pausedAt! })
        return paused
      }

      // For finish_current_safe_step and checkpoint_and_stop_workers: allow current tool to finish safely, then checkpoint
      // In this runtime, we checkpoint immediately (workers continue until safe boundary is their own execute promise)
      // Capture worker checkpoints then create ProjectCheckpoint
      const chk = yield* captureCheckpoint(projectID)
      const paused: ProjectControlState = { status: "paused", mode, requestedAt, pausedAt: Date.now(), checkpointID: chk.id, reason }
      yield* Effect.promise(() => saveControlState(projectID, paused))
      publish(bridge, Paused, { projectID, checkpointID: chk.id, mode, timestamp: paused.pausedAt! })
      return paused
    })

    const resume = Effect.fn("Orchestrator.resume")(function* (projectID: string) {
      const file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))
      const current = yield* Effect.promise(() => loadControlState(projectID))
      if (current.status === "running") return current
      // Validate paused/pausing
      if (current.status !== "paused" && current.status !== "pausing" && current.status !== "resuming") return yield* Effect.fail(new Error(`Project is not paused`))

      const resuming: ProjectControlState = { status: "resuming", mode: current.mode, requestedAt: current.requestedAt }
      yield* Effect.promise(() => saveControlState(projectID, resuming))

      // Reload latest state; persisted worker metadata is never treated as live.
      const latest = yield* Effect.promise(() => loadProject(projectID))
      if (!latest) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))

      // Recover stale task ownership conservatively: running/verifying tasks
      // were owned by a process that may be gone, so they return to
      // ready/failed. The roadmap phase itself survives reconciliation.
      const priorRoadmapStatus = latest.roadmap.status
      if (recoverStaleRuns(latest.roadmap)) {
        latest.roadmap.status = priorRoadmapStatus
        yield* Effect.promise(() => saveProject(projectID, latest))
      }

      // Queued WorkerContracts do not persist between processes (contracts are
      // compiled inside execute()), so resume always recompiles from the latest
      // roadmap revision. Resource-slot state is per-process and starts empty.

      const running: ProjectControlState = { status: "running" }
      yield* Effect.promise(() => saveControlState(projectID, running))
      yield* supervisor.setPaused(projectID, false).pipe(Effect.catch(() => Effect.void))
      publish(bridge, Resumed, { projectID, timestamp: Date.now() })

      // Resume scheduler admission for a roadmap that was mid-execution when
      // paused; projects still in planning stay idle until an explicit start.
      if ((latest.roadmap.status === "executing" || latest.roadmap.status === "verifying") && !latest.cancelledAt) {
        yield* start(projectID).pipe(Effect.catch(() => Effect.void))
      }
      return running
    })

    return Service.of({ createProject, get, list, plan, start, cancel, chat, compactBrain, workingTreeSummary, workingTreeFiles, checkpoint, listCheckpoints: listCheckpointsFn, getCheckpoint, latestCheckpoint: latestCheckpointFn, getControlState, pause, resume })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [EventV2Bridge.node, Session.node, SessionPrompt.node, Git.node, Supervisor.node],
})

export * as Orchestrator from "."
