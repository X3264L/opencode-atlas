import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
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
  ProjectSessionCreated,
  ProjectSessionReconciled,
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
import type { ProjectObjective, Roadmap, PrivacyPolicy } from "./types"
import { applyChangeSet, type RoadmapChangeSet } from "./changeset"
import { planObjective } from "./planner"
import { compileContract, contractToPrompt } from "./compiler"
import { scheduleRoadmap } from "./scheduler"
import {
  loadProject,
  recoverStaleRuns,
  saveProject,
  writeProjectStrict,
  listProjects,
  type ProjectFile,
} from "./store"
import { classifyInstruction, detectSupersession, type ProjectInstruction } from "./instructions"
import type { ProjectIdea } from "./ideas"
import { InstructionEvent } from "@opencode-ai/schema/instruction-event"
import { distillWorkerCompletion, compactMemories } from "./distill"
import { routeProjectMessage } from "./project-message"
import type { ProjectMemory } from "../brain/types"
import {
  extractJsonObject,
} from "./model-intelligence"
import { computeDiffstat, toFileDiffstats, type DiffstatSummary, type FileDiffstat } from "./diffstat"
import { createDiffstatWatcher } from "./diffstat-watcher"
import { workingTreeStats } from "./working-tree"
import { loadBrain as loadBrainStore, saveBrain as saveBrainStore } from "../brain/store"
import { MessageID, PartID } from "@/session/schema"
import { addInterruptionBarrier, removeInterruptionBarrier, setToolLifecycleHooks } from "@/session/interruption-barrier"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { AtlasRouter } from "@/router/index"
import {
  classifierContextText,
  collectDistilledItems,
  parseClassification,
  replannerContextText,
  requireOperationsArray,
  runRoutedCompletion,
  runValidatedDistillation,
  sessionDistillerPrompt,
  toDerivedMemories,
  workerDistillerPrompt,
  type RoutedDeps,
} from "./model-intelligence"
import { analyzeImpact } from "./impact"
import { WorkerInterruptionCoordinator, type InterruptCause, type WorkerInterruption } from "./interruption"
import { createHandoff, handoffToPromptText } from "./handoff"
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
  /** Backward compatibility: an existing session to adopt as root. Normal callers omit it. */
  sessionID?: string
  workspace?: string
}

export interface ProjectChatResult {
  intent: string
  /** Canonical root project conversation session the message was persisted into */
  rootSessionID: string
  instructionText?: string
  queryText?: string
  ideaText?: string
  reason: string
  /** Instruction Inbox disposition status when intent was an instruction */
  instructionStatus?: "queued" | "superseded" | "rejected" | "applied" | "failed"
  replannerApplied?: boolean
  replannerAttempts?: number
}

export interface Interface {
  readonly createProject: (input: CreateInput) => Effect.Effect<ProjectObjective, Error>
  readonly get: (projectID: string) => Effect.Effect<ProjectFile | undefined, Error>
  readonly list: () => Effect.Effect<string[]>
  readonly plan: (projectID: string) => Effect.Effect<Roadmap, Error>
  readonly start: (projectID: string) => Effect.Effect<{ started: boolean }, Error>
  readonly cancel: (projectID: string) => Effect.Effect<boolean, Error>
  readonly chat: (input: { projectID: string; text: string }) => Effect.Effect<ProjectChatResult, Error>
  readonly compactBrain: (projectID: string) => Effect.Effect<number | undefined, Error>
  readonly workingTreeSummary: (projectID: string) => Effect.Effect<DiffstatSummary | undefined>
  readonly workingTreeFiles: (projectID: string) => Effect.Effect<FileDiffstat[]>
  readonly checkpoint: (projectID: string) => Effect.Effect<ProjectCheckpoint, Error>
  readonly listCheckpoints: (projectID: string) => Effect.Effect<ProjectCheckpoint[]>
  readonly getCheckpoint: (projectID: string, checkpointID: string) => Effect.Effect<ProjectCheckpoint | undefined>
  readonly latestCheckpoint: (projectID: string) => Effect.Effect<ProjectCheckpoint | undefined>
  readonly getControlState: (projectID: string) => Effect.Effect<ProjectControlState>
  readonly pause: (projectID: string, mode?: PauseMode, reason?: string) => Effect.Effect<ProjectControlState, Error>
  readonly interruptWorker: (projectID: string, taskID: string, cause: InterruptCause) => Effect.Effect<string | null, Error>
  readonly resume: (projectID: string) => Effect.Effect<ProjectControlState, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestrator") {}

const activeRuns = new Set<string>()
const diffstatWatchers = new Map<string, ReturnType<typeof createDiffstatWatcher>>()
const DIFFSTAT_POLL_MS = 2_000

// Model-backed intelligence thresholds. Deterministic paths stay the fast /
// default path; these gates keep model calls rare and purposeful.
export const MODEL_REPLANNER_MAX_REPAIRS = 2

// Per-project admission lock: concurrent opens of the same legacy project
// must never race two root sessions into existence.
const rootSessionLock = KeyedMutex.makeUnsafe<string>()
const brainWriteLock = KeyedMutex.makeUnsafe<string>()

function publish(
  bridge: typeof EventV2Bridge.Service.Service,
  definition: Parameters<typeof bridge.publish>[0],
  data: Record<string, unknown>,
) {
  void Effect.runPromise(bridge.publish(definition, data as never) as Effect.Effect<unknown>).catch(() => {})
}

// Tunable gates keeping model calls rare; deterministic paths stay default.
export const intelligenceThresholds = {
  workerMinChars: 1200,
  failureDetailMinChars: 400,
  checkpointMinBytes: 6000,
  sessionEveryMessages: 6,
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const promptService = yield* SessionPrompt.Service
    const git = yield* Git.Service
    const bridge = yield* EventV2Bridge.Service
    const supervisor = yield* Supervisor.Service
    const router = yield* AtlasRouter.Service

    const routedDeps: RoutedDeps = { router, sessions, promptService }

    const interruptionCoordinator = new WorkerInterruptionCoordinator((event) => {
      // Publish interruption lifecycle events through the existing bridge
      if (event.type === "atlas.worker.interruption.requested") {
        publish(bridge, InstructionEvent.WorkerInterruptionRequested, {
          projectID: event.projectID,
          taskID: event.taskID,
        })
      } else if (event.type === "atlas.worker.interrupted") {
        publish(bridge, InstructionEvent.WorkerInterrupted, {
          projectID: event.projectID,
          taskID: event.taskID,
        })
      }
    })

    const persistInterruptions = (targetProjectID: string) => {
      const records = [...interruptionCoordinator.getPendingByProject(targetProjectID)]
      void WorkerInterruptionCoordinator.persist(targetProjectID, records).catch(() => {})
    }

    setToolLifecycleHooks(
      (sessionID, callID, tool, interruptionClass) => {
        const reg = interruptionCoordinator.getWorkerBySession(sessionID)
        if (reg) interruptionCoordinator.trackToolStart(reg.workerID, callID, tool, interruptionClass)
      },
      (sessionID, callID, tool) => {
        const reg = interruptionCoordinator.getWorkerBySession(sessionID)
        if (reg) interruptionCoordinator.trackToolSettled(reg.workerID, callID)
      },
    )

    // Wire real tool lifecycle: subscribe to session part updates via the bridge.
    // Tool part status changes indicate tool start/settle for worker-owned sessions.
    yield* bridge.listen((event) => {
      const payload = event.data as Record<string, unknown>
      if (payload?.type !== "tool") return Effect.void
      const sessionID = String((payload as Record<string, unknown>).sessionID ?? "")
      if (!sessionID) return Effect.void
      const reg = interruptionCoordinator.getWorkerBySession(sessionID)
      if (!reg) return Effect.void
      const state = (payload as { state?: { status?: string } }).state
      const callID = String((payload as Record<string, unknown>).callID ?? "")
      if (state?.status === "pending") {
        interruptionCoordinator.trackToolStart(reg.workerID, callID, String((payload as Record<string, unknown>).tool ?? "unknown"))
      } else if (state?.status === "done" || state?.status === "error") {
        interruptionCoordinator.trackToolSettled(reg.workerID, callID)
      }
      return Effect.void
    })

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

    // ---- Root project conversation session ----

    /** Appends a human message (role=user + text part) into a session without model invocation */
    const appendRootMessage = Effect.fn("Orchestrator.appendRootMessage")(function* (rootSessionID: string, text: string) {
      const messageID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: rootSessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "atlas", modelID: "project-conversation" },
        tools: {},
        mode: "",
      } as never)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: rootSessionID,
        messageID,
        type: "text",
        text,
        synthetic: false,
      } as never)
    })

    const createRootSessionFor = Effect.fn("Orchestrator.createRootSession")(function* (file: ProjectFile) {
      return yield* sessions.create({
        title: `[Atlas Project] ${file.objective.title}`,
        ...(file.workspace ? { metadata: { atlasProjectWorkspace: file.workspace } } : {}),
      })
    })

    const persistRoot = Effect.fn("Orchestrator.persistRoot")(function* (projectID: string, file: ProjectFile) {
      yield* Effect.promise(() => writeProjectStrict(projectID, file))
    })

    type RootSessionOutcome =
      | { kind: "reused"; sessionID: string }
      | { kind: "created"; sessionID: string }
      | { kind: "reconciled"; sessionID: string; previousSessionID: string }

    /** Durable session projection is asynchronous: poll briefly before declaring an ID invalid */
    const findSessionEventually = Effect.fn("Orchestrator.findSessionEventually")(function* (sessionID: string) {
      let found = yield* sessions.get(sessionID as never).pipe(Effect.option)
      let attempt = 0
      while (found._tag === "None" && attempt < 24) {
        attempt += 1
        yield* Effect.sleep("50 millis")
        found = yield* sessions.get(sessionID as never).pipe(Effect.option)
      }
      return found
    })

    /**
     * Invariant: every loaded project ends with exactly one canonical root
     * conversation session. Existing valid IDs are reused verbatim; missing or
     * invalid IDs are reconciled once under a per-project keyed mutex, so two
     * concurrent openers of the same legacy project cannot create two roots.
     */
    const ensureRootSession = Effect.fn("Orchestrator.ensureRootSession")(function* (projectID: string) {
      return yield* rootSessionLock.withLock(projectID)(
        Effect.gen(function* () {
          // Fresh read inside the lock so concurrent migrations converge.
          const current = yield* Effect.promise(() => loadProject(projectID))
          if (!current) return yield* Effect.fail(new Error(`Unknown project: ${projectID}`))

          if (current.sessionID) {
            const previousSessionID = current.sessionID
            // Confirmed roots are trusted without re-probing the (possibly
            // async) session projection; only unconfirmed/legacy IDs verify.
            if (typeof current.rootSessionConfirmedAt === "number") {
              return { kind: "reused" as const, sessionID: previousSessionID }
            }
            const existing = yield* findSessionEventually(previousSessionID)
            if (existing._tag === "Some") {
              current.rootSessionConfirmedAt = Date.now()
              yield* persistRoot(projectID, current)
              return { kind: "reused" as const, sessionID: previousSessionID }
            }
            // Stored record is gone/corrupt → reconcile to one replacement root
            const replacement = yield* createRootSessionFor(current)
            current.sessionID = replacement.id
            current.rootSessionConfirmedAt = Date.now()
            yield* persistRoot(projectID, current)
            publish(bridge, ProjectSessionReconciled, { projectID, sessionID: replacement.id, previousSessionID })
            return { kind: "reconciled" as const, sessionID: replacement.id, previousSessionID }
          }

          const created = yield* createRootSessionFor(current)
          current.sessionID = created.id
          current.rootSessionConfirmedAt = Date.now()
          yield* persistRoot(projectID, current)
          publish(bridge, ProjectSessionCreated, { projectID, sessionID: created.id })
          return { kind: "created" as const, sessionID: created.id }
        }),
      )
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

      // Large-checkpoint trigger: distill a concise derived snapshot memory.
      const snapshotBytes = JSON.stringify(checkpoint).length
      if (snapshotBytes >= intelligenceThresholds.checkpointMinBytes && !file.cancelledAt) {
        const evidenceIDs = new Set<string>([checkpoint.id, projectID, ...checkpoint.verification.completedTaskIDs])
        const slice = [
          `objective=${file.objective.title}`,
          `complete=${verification.completedTaskIDs.length}`,
          `failed=${verification.failedTaskIDs.length}`,
          `blocked=${verification.blockedTaskIDs.length}`,
        ]
        const memoriesResult = yield* Effect.exit(
          runValidatedDistillation(routedDeps, {
            purpose: "session_distiller",
            userText:
              sessionDistillerPrompt({
                messages: [`[msg:0] Release/snapshot state: ${slice.join("; ")}`],
                objective: file.objective.title,
                constraints: file.objective.constraints,
                decisions: [],
                openQuestions: [],
              }),
            evidenceIDs,
            estimatedInputTokens: estimateTokensFor(String(snapshotBytes)),
            ...(privacyOf(file) !== "standard" ? { privacy: privacyOf(file) } : {}),
          }),
        )
        if (
          memoriesResult._tag === "Success" &&
          memoriesResult.value.items.length > 0
        ) {
          yield* persistDistilledMemories(
            projectID,
            toDerivedMemories(memoriesResult.value.items, { projectID, roadmapVersion }),
          )
        }
      }
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
        ...(input.workspace ? { workspace: input.workspace } : {}),
      }

      // Root conversation session is created by default; an explicit sessionID
      // argument is only honored for backward compatibility when it exists.
      let createdSessionID: string | undefined
      if (input.sessionID) {
        const existing = yield* findSessionEventually(input.sessionID)
        if (existing._tag === "Some") {
          file.sessionID = existing.value.id
          file.rootSessionConfirmedAt = Date.now()
        }
      }
      if (!file.sessionID) {
        const info = yield* createRootSessionFor(file)
        file.sessionID = info.id
        // New roots are trusted immediately: they were created by this very
        // context, so no visibility polling is required before confirming.
        file.rootSessionConfirmedAt = Date.now()
        createdSessionID = info.id
      }

      // Avoid orphan state: if the project identity cannot be committed, a
      // just-created root session is removed and creation fails clearly.
      const committed = yield* Effect.exit(Effect.promise(() => writeProjectStrict(projectID, file)))
      if (committed._tag === "Failure") {
        if (createdSessionID) {
          yield* sessions.remove(createdSessionID as never).pipe(Effect.catch(() => Effect.void))
        }
        return yield* Effect.fail(new Error(`Failed to persist project ${projectID}`))
      }

      yield* Effect.promise(() => saveControlState(projectID, { status: "running" }))
      if (input.workspace) ensureDiffstatWatcher(projectID, input.workspace)
      if (createdSessionID) {
        publish(bridge, ProjectSessionCreated, { projectID, sessionID: createdSessionID })
      }
      publish(bridge, ProjectCreated, { projectID, title: input.title })
      return objective
    })

    const get = Effect.fn("Orchestrator.get")(function* (projectID: string) {
      const probe = yield* Effect.promise(() => loadProject(projectID))
      if (!probe) return undefined
      // Reconcile persisted interruptions on project load.
      yield* Effect.promise(() =>
        WorkerInterruptionCoordinator.reconcileProject(
        projectID,
        async (sessionID, toolCallID) => {
          // Inspect the durable Session tool-part state for TERMINAL result.
          // Terminal statuses: "completed" | "error" (done state).
          // Non-terminal: "pending" | "running".
          // Missing: no matching tool part found.
          try {
            const msgs = (await Effect.runPromise(
              sessions.messages({ sessionID: sessionID as never }),
            )) as unknown as { parts: { type: string; id?: string; state?: { status?: string } }[] }[]
            for (const entry of msgs) {
              for (const part of entry.parts) {
                if (part.type !== "tool") continue
                const toolPart = part as unknown as { id?: string; state?: { status?: string } }
                if (toolPart.id !== toolCallID) continue
                const status = toolPart.state?.status ?? ""
                if (status === "completed" || status === "error") return "terminal"
                if (status === "pending" || status === "running") return "non_terminal"
              }
            }
            return "missing"
          } catch {
            return "missing"
          }
        },
        (interruption, action) => {
          if (action === "admit_replacement") {
            publish(bridge, InstructionEvent.WorkerInterruptionRequested, {
              projectID,
              taskID: interruption.taskID,
            })
          }
        }),
      ).pipe(Effect.catch(() => Effect.void))
      // One canonical root session per project; legacy/missing IDs migrate here.
      yield* ensureRootSession(projectID)
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
      let file = yield* Effect.promise(() => loadProject(projectID))
      if (!file) {
        // Transient FS jitter guard: retry once before failing
        yield* Effect.sleep("120 millis")
        file = yield* Effect.promise(() => loadProject(projectID))
      }
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
      // Workers must be children of the canonical root; callers bypassing
      // get() still land on the migrated root before any session is spawned.
      if (!file.sessionID) {
        yield* ensureRootSession(projectID)
        const migrated = yield* Effect.promise(() => loadProject(projectID))
        if (migrated?.sessionID) file.sessionID = migrated.sessionID
      }
      const control = yield* Effect.promise(() => loadControlState(projectID))
      // Paused/pausing barrier: no new scheduling
      if (control.status === "paused" || control.status === "pausing") return yield* Effect.fail(new Error(`Project is ${control.status}`))
      if (activeRuns.has(projectID)) return { started: true }

      if (recoverStaleRuns(file.roadmap)) yield* Effect.promise(() => saveProject(projectID, file))

      file.roadmap.status = "executing"
      activeRuns.add(projectID)
      if (file.workspace) ensureDiffstatWatcher(projectID, file.workspace)
      yield* Effect.promise(() => saveProject(projectID, file))

      // The scheduling loop runs detached from the request fiber; carry the
      // instance/workspace context explicitly so worker sessions stay bound
      // to the project instance that started them.
      const instance = yield* InstanceRef
      const workspaceID = yield* WorkspaceRef
      const detached = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
        let provided = effect
        if (instance) provided = Effect.provideService(InstanceRef, instance)(provided)
        if (workspaceID) provided = Effect.provideService(WorkspaceRef, workspaceID)(provided)
        return provided
      }

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
                    // Dense failure prose triggers model distillation of lessons;
                    // deterministic state is untouched on any failure.
                    if (event.detail && event.detail.length >= intelligenceThresholds.failureDetailMinChars) {
                      const failedTask = file.roadmap.tasks.find((t) => t.id === event.taskID)
                      if (failedTask && !file.cancelledAt) {
                        void Effect.runPromise(
                          detached(
                            modelDistillWorker({
                              projectID,
                              file,
                              contractTaskID: failedTask.id,
                              taskRevision: failedTask.revision,
                              instructionSummary: file.objective.title,
                              summary: `Worker for ${failedTask.title} failed: ${event.detail}`,
                              blockers: [event.detail ?? ""].filter(Boolean),
                              artifactRefs: [],
                            }),
                          ),
                        ).catch(() => {})
                      }
                    }
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
                const previousWorker = interruptionCoordinator.getWorkerByTask(task.id)
                const previousToolOutput = previousWorker
                  ? (await Effect.runPromise(
                      detached(sessions.messages({ sessionID: previousWorker.sessionID as never })),
                    ))
                      .flatMap((message) => message.parts)
                      .filter((part) => part.type === "tool")
                      .map((part) => part as unknown as { state?: { status?: string; output?: unknown } })
                      .filter((part) => part.state?.status === "completed")
                      .map((part) => String(part.state?.output ?? ""))
                      .find(Boolean)
                  : undefined
                const handoff = previousToolOutput
                  ? createHandoff({
                      fromWorkerID: previousWorker?.workerID,
                      toRoleID: contract.workerProfile ?? "general",
                      taskID: task.id,
                      taskRevision: task.revision,
                      priorResult: {
                        taskID: task.id,
                        status: "completed",
                        summary: previousToolOutput,
                        artifacts: [],
                        startedAt: 0,
                        finishedAt: Date.now(),
                      },
                      reasonCode: "worker_replacement",
                    })
                  : undefined
                const child = await Effect.runPromise(
                  detached(
                    sessions.create({
                      title: `[orchestrator] ${task.id}`,
                      ...(file.sessionID ? { parentID: file.sessionID as never } : {}),
                    }),
                  ),
                )
                interruptionCoordinator.register(projectID, child.id, child.id, task.id, task.revision)
                const response = await Effect.runPromise(
                  detached(
                    promptService.prompt({
                      sessionID: child.id,
                      parts: [
                        {
                          type: "text",
                          text: [contractToPrompt(contract), handoff && handoffToPromptText(handoff)]
                            .filter(Boolean)
                            .join("\n\n"),
                        },
                      ],
                    }),
                  ),
                )
                const filesChanged = file.workspace
                  ? await Effect.runPromise(
                      git.status(file.workspace).pipe(
                        Effect.map((items) => items.map((item) => item.file)),
                        Effect.catch(() => Effect.succeed([] as string[])),
                      ),
                    )
                  : []
                let lastText: { text?: string } | undefined
                {
                  const fromReply = [...response.parts]
                    .reverse()
                    .find((part) => part.type === "text" && (part as unknown as { text?: string }).text)
                  if (fromReply) {
                    lastText = fromReply as unknown as { text?: string }
                  } else {
                    let transcript: { parts: { type: string; text?: string }[] }[] = []
                    try {
                      transcript = (await Effect.runPromise(
                        detached(sessions.messages({ sessionID: child.id })),
                      )) as unknown as { parts: { type: string; text?: string }[] }[]
                    } catch {}
                    lastText = [...transcript]
                      .reverse()
                      .flatMap((entry) => entry.parts)
                      .find((part) => part.type === "text" && (part as unknown as { text?: string }).text)
                  }
                }
                // Fence check BEFORE any downstream side effect: brain write,
                // artifact write, model distill, verification. Stale workers
                // retain their tool result for audit but perform no writes.
                if (interruptionCoordinator.isStale(task.id, child.id)) {
                  const pendingInterruptions = interruptionCoordinator.getPendingByProject(projectID)
                  const staleInterruptionID = pendingInterruptions.find((i) => i.taskID === task.id)?.id
                  publish(bridge, InstructionEvent.WorkerResultStale, {
                    projectID,
                    taskID: task.id,
                    contractRoadmapVersion: task.revision,
                    currentRoadmapVersion: file.roadmap.version,
                    ...(staleInterruptionID ? { interruptionID: staleInterruptionID } : {}),
                  })
                  return {
                    taskID: task.id,
                    status: "cancelled" as const,
                    summary: "stale worker result rejected",
                    artifacts: [],
                    startedAt: Date.now(),
                    finishedAt: Date.now(),
                    blockers: ["stale_worker_result"],
                  }
                }
                const workerResult = {
                  taskID: task.id,
                  status: "completed" as const,
                  summary:
                    ((lastText as unknown as { text?: string })?.text ?? "").slice(0, 2000) || "Task completed",
                  artifacts: (task.expectedArtifacts ?? []).map((label, index) => ({                    id: `${task.id}-artifact-${index + 1}`,
                    taskID: task.id,
                    kind: /test/i.test(label) ? "test_result" : "code_patch",
                    label,
                  })),
                  ...(filesChanged.length > 0 ? { filesChanged } : {}),
                  startedAt: Date.now(),
                  finishedAt: Date.now(),
                  blockers: [] as string[],
                }
                const distilled = distillWorkerCompletion({
                  contract, result: workerResult, projectID, roadmapVersion: file.roadmap.version,
                })
                if (distilled.length > 0) {
                  file.artifacts.push(...workerResult.artifacts)
                  const brain = await loadBrainStore(projectID)
                  brain.memories.push(...distilled)
                  await saveBrainStore(projectID, brain)
                }
                // Model-backed distillation only when the deterministic pass is
                // insufficient (dense prose). Failure here keeps deterministic memories.
                if (
                  !file.cancelledAt &&
                  workerResult.summary.length >= intelligenceThresholds.workerMinChars
                ) {
                  try {
                    await Effect.runPromise(
                      detached(
                        modelDistillWorker({
                          projectID,
                          file,
                          contractTaskID: contract.taskID,
                          taskRevision: task.revision,
                          instructionSummary: contract.objectiveSummary,
                          summary: workerResult.summary,
                          blockers: [...(workerResult.blockers ?? [])],
                          artifactRefs: workerResult.artifacts.map((a) => ({ id: a.id, label: a.label })),
                          ...(filesChanged.length > 0 ? { filesChanged } : {}),
                        }),
                      ),
                    )
                  } catch (e) {
                  }
                }
                // Fence check: reject stale worker results after replacement.
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

    const interruptWorker = Effect.fn("Orchestrator.interruptWorker")(function* (targetProjectID: string, targetTaskID: string, cause: InterruptCause) {
      const reg = interruptionCoordinator.getWorkerByTask(targetTaskID)
      if (!reg || reg.projectID !== targetProjectID) return null
      const id = interruptionCoordinator.interrupt(targetProjectID, reg.workerID, cause)
      if (id) {
        addInterruptionBarrier(reg.sessionID)
        persistInterruptions(targetProjectID)
      }

      // If the safety class allows immediate cancellation, cancel the worker's prompt turn.
      const interruption = interruptionCoordinator.getInterruption(id!)
      if (interruption?.status === "cancelling") {
        yield* promptService.cancel(reg.sessionID as never).pipe(Effect.catch(() => Effect.void))
      }
      return id
    })

    // ---- Model-backed intelligence closures ----

    const privacyOf = (file: ProjectFile): PrivacyPolicy => file.privacy ?? "standard"
    const estimateTokensFor = (text: string): number => Math.max(64, Math.ceil(text.length / 4))
    const replannerContextSizeChars = (file: ProjectFile) =>
      file.objective.title.length + file.roadmap.tasks.reduce((sum, task) => sum + task.title.length + 80, 0)

    function extractJsonObjectSafe(text: string): unknown {
      try {
        return extractJsonObject(text)
      } catch {
        return {}
      }
    }

    /** Selective model replanner: propose → validate via applyChangeSet → apply atomically.
     * Bounded repair loop (max 2 repairs). Roadmap untouched unless a proposal validates. */
    const runModelReplanner = Effect.fn("Orchestrator.runModelReplanner")(function* (
      projectID: string,
      file: ProjectFile,
      instruction: ProjectInstruction,
    ) {
      const brain = yield* Effect.promise(() => loadBrainStore(projectID))
      const decisions = brain.memories.filter((m) => m.kind === "decision").map((m) => m.title)
      const contracts = brain.memories.filter((m) => m.kind === "architecture_contract").map((m) => m.title)

      const affectedContext = file.roadmap.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        revision: task.revision,
        dependencies: [...task.dependencies],
        acceptanceCriteria: [...task.acceptanceCriteria],
      }))

      let previousError: string | undefined
      for (let attempt = 0; attempt <= MODEL_REPLANNER_MAX_REPAIRS; attempt++) {
        if (file.cancelledAt) return { ok: false, attempts: attempt }
        const proposalResult = yield* Effect.option(
          runRoutedCompletion(routedDeps, {
            purpose: "selective_replanner",
            userText: replannerContextText({
              instruction: instruction.text,
              objectiveSummary: file.objective.title,
              objectiveVersion: file.objective.version,
              roadmapVersion: file.roadmap.version,
              affectedTasks: affectedContext,
              constraints: file.objective.constraints,
              decisions,
              contracts,
              ...(previousError ? { previousError } : {}),
            }),
            estimatedInputTokens: estimateTokensFor(String(replannerContextSizeChars(file))),
            ...(privacyOf(file) !== "standard" ? { privacy: privacyOf(file) } : {}),
          }),
        )
        if (proposalResult._tag === "None") break

        let operations
        try {
          operations = requireOperationsArray(extractJsonObjectSafe(proposalResult.value.text))
        } catch (error) {
          previousError = error instanceof Error ? error.message : String(error)
          continue
        }

        const runningTaskIDs = new Set(file.roadmap.tasks.filter((task) => task.status === "running").map((task) => task.id))
        const impact = analyzeImpact(file.roadmap, operations, runningTaskIDs)
        const changeset: RoadmapChangeSet = {
          id: `cs-model-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          projectID,
          instructionID: instruction.id,
          baseRoadmapVersion: file.roadmap.version,
          baseObjectiveVersion: file.objective.version,
          operations,
          impact,
          risk: impact.risk,
          status: "proposed" as const,
          createdAt: Date.now(),
        }
        const applied = applyChangeSet(changeset, file.roadmap, file.objective)
        if (!applied.ok || !applied.roadmap || !applied.objective) {
          previousError = applied.error ?? "apply failed"
          continue
        }
        // Atomically accepted only once persisted: mutate authoritative copies then save.
        file.roadmap = applied.roadmap
        file.objective = applied.objective
        file.changesets = [...(file.changesets ?? []), { ...changeset, status: "applied" as const }]
        yield* Effect.promise(() => writeProjectStrict(projectID, file))

        // Interrupt active workers whose tasks were invalidated by the mutation.
        for (const taskID of impact.interruptTaskIDs) {
          yield* interruptWorker(projectID, taskID, "roadmap_mutation").pipe(Effect.catch(() => Effect.void))
        }

        return { ok: true, attempts: attempt + 1 }
      }
      // Failure policy: no roadmap mutation; instruction remains failed.
      return { ok: false, attempts: MODEL_REPLANNER_MAX_REPAIRS + 1 }
    })

    const persistDistilledMemories = Effect.fn("Orchestrator.persistDistilledMemories")(function* (
      projectID: string,
      memories: ProjectMemory[],
    ) {
      if (memories.length === 0) return 0
      const brain = yield* Effect.promise(() => loadBrainStore(projectID))
      const existingKeys = new Set(brain.memories.map((m) => `${m.kind}:${m.title}:${m.content}`))
      const fresh = memories.filter((m) => !existingKeys.has(`${m.kind}:${m.title}:${m.content}`))
      brain.memories.push(...fresh)
      yield* Effect.promise(() => saveBrainStore(projectID, brain))
      return fresh.length
    })

    /** Worker-completion model distillation when deterministic extraction is insufficient. */
    const modelDistillWorker = Effect.fn("Orchestrator.modelDistillWorker")(function* (input: {
      projectID: string
      file: ProjectFile
      contractTaskID: string
      taskRevision: number
      instructionSummary: string
      summary: string
      blockers: string[]
      artifactRefs: { id: string; label: string }[]
      filesChanged?: string[]
    }) {
      if (input.file.cancelledAt) return 0
      const evidenceIDs = new Set<string>([
        input.contractTaskID,
        ...input.artifactRefs.map((a) => a.id),
        ...(input.filesChanged ?? []),
      ])
      const distillEffect = runValidatedDistillation(routedDeps, {
        purpose: "worker_distiller",
        userText:
          workerDistillerPrompt({
            instructionSummary: input.instructionSummary,
            taskID: input.contractTaskID,
            taskRevision: input.taskRevision,
            summary: input.summary,
            blockers: input.blockers,
            artifactRefs: input.artifactRefs,
            verificationRefs: [],
            ...(input.filesChanged ? { filesChanged: input.filesChanged } : {}),
          }),
        evidenceIDs,
        estimatedInputTokens: estimateTokensFor(input.summary),
        ...(privacyOf(input.file) !== "standard" ? { privacy: privacyOf(input.file) } : {}),
      })
      const result = yield* Effect.exit(distillEffect)
      if (result._tag === "Failure") {
        const cause0 = (result.cause as { failures?: { error?: unknown }[] }).failures?.[0]
        return 0
      }
      const memories = toDerivedMemories(result.value.items, { projectID: input.projectID })
      return yield* brainWriteLock.withLock(input.projectID)(persistDistilledMemories(input.projectID, memories))
    })

    /** Root-conversation session distillation when the conversation grows past
     * the threshold: decisions/corrections/constraints/ideas become Brain memories. */
    const modelDistillSession = Effect.fn("Orchestrator.modelDistillSession")(function* (input: {
      projectID: string
      file: ProjectFile
      rootSessionID: string
      userTexts: string[]
    }) {
      if (input.file.cancelledAt) return 0
      const brain = yield* Effect.promise(() => loadBrainStore(input.projectID))
      const evidenceIDs = new Set<string>(input.userTexts.map((_, index) => `msg:${index}`))
      const distillEffect = runValidatedDistillation(routedDeps, {
        purpose: "session_distiller",
        userText:
          sessionDistillerPrompt({
            messages: input.userTexts,
            objective: input.file.objective.title,
            constraints: input.file.objective.constraints,
            decisions: brain.memories.filter((m) => m.kind === "decision").map((m) => m.title),
            openQuestions: brain.memories.filter((m) => m.kind === "open_question").map((m) => m.title),
          }),
        evidenceIDs,
        estimatedInputTokens: estimateTokensFor(input.userTexts.join(" ")),
        ...(privacyOf(input.file) !== "standard" ? { privacy: privacyOf(input.file) } : {}),
      })
      const result = yield* Effect.exit(distillEffect)
      if (result._tag === "Failure") {
        return 0 // deterministic fallback; nothing partial written
      }
      const memories = toDerivedMemories(result.value.items, { projectID: input.projectID })
      return yield* brainWriteLock.withLock(input.projectID)(persistDistilledMemories(input.projectID, memories))
    })

    const chat = Effect.fn("Orchestrator.chat")(function* (input: { projectID: string; text: string }) {
      // Project conversation resolves through the canonical root session:
      // projectID → rootSessionID → routing. Workers are never addressed here.
      yield* ensureRootSession(input.projectID)
      const file = yield* Effect.promise(() => loadProject(input.projectID))
      if (!file?.sessionID) return yield* Effect.fail(new Error(`Unknown project: ${input.projectID}`))
      const rootSessionID = file.sessionID
      const privacy = file.privacy ?? "standard"
      const cancelled = () => Boolean(file.cancelledAt)

      let route = routeProjectMessage(input.text)


      // Ambiguous deterministic routes escalate once to the model-backed
      // classifier through the real routed stack; any failure falls straight
      // back to the safe deterministic route.
      let modelRouted: { providerID: string; modelID: string } | undefined
      if (route.ambiguous && !cancelled()) {
        const classificationEffect = Effect.gen(function* () {
          const rawReply = yield* runRoutedCompletion(routedDeps, {
            purpose: "project_message_classifier",
            userText:
              classifierContextText({
                message: input.text,
                objectiveTitle: file.objective.title,
                objectiveVersion: file.objective.version,
                roadmapVersion: file.roadmap.version,
                constraints: file.objective.constraints,
                taskIDsAndTitles: file.roadmap.tasks.map((task) => ({ id: task.id, title: task.title })),
              }) + "\n\n(valid referencedTaskIDs are only IDs from Known tasks)",
            ...(privacy !== "standard" ? { privacy } : {}),
          })
          const parsedYield = yield* Effect.try({
            try: () =>
              parseClassification(
                extractJsonObjectSafe(rawReply.text),
                new Set(file.roadmap.tasks.map((task) => task.id)),
              ),
            catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
          })
          return { parsed: parsedYield, reply: rawReply }
        })
        const attempted = yield* classificationEffect.pipe(Effect.option)
        if (attempted._tag === "Some") {
          const parsed = attempted.value.parsed
          if (parsed.confidence >= 0.5) {
            switch (parsed.intent) {
              case "instruction":
              case "direct_project_command":
                route = { intent: "instruction", instructionText: input.text, reason: `model:${parsed.reasonCode}` }
                break
              case "memory_correction":
                route = { intent: "memory_correction", instructionText: input.text, reason: `model:${parsed.reasonCode}` }
                break
              case "idea":
                route = { intent: "idea", instructionText: input.text, reason: `model:${parsed.reasonCode}` }
                break
              case "status_request":
                route = { intent: "status_request", queryText: input.text, reason: `model:${parsed.reasonCode}` }
                break
              default:
                route = { intent: "question", queryText: input.text, reason: `model:${parsed.reasonCode}` }
            }
          }
        }
      }

      let instructionStatus: ProjectChatResult["instructionStatus"]
      let appliedChangeSetOk: boolean | undefined
      let appliedChangeSetAttempts: number | undefined

      if ((route.intent === "instruction" || route.intent === "memory_correction" || route.intent === "direct_project_command") && route.instructionText) {
        const knownTaskIDs = file.roadmap.tasks.map((task) => task.id)
        const knownTaskTitles = file.roadmap.tasks.map((task) => task.title)
        const activeRunningTasks = file.roadmap.tasks.filter((task) => task.status === "running").map((task) => task.id)
        const classified = classifyInstruction(route.instructionText, {
          knownTaskIDs,
          knownTaskTitles,
          ...(activeRunningTasks.length > 0 ? { activeRunningTasks } : {}),
        })
        const existing = file.instructions ?? []
        const supersession = detectSupersession(route.instructionText, existing)

        let instruction: ProjectInstruction | undefined
        if (supersession.duplicateOfID) {
          instructionStatus = "rejected"
        } else {
          if (supersession.supersedesID) {
            for (const prior of existing) {
              if (prior.id === supersession.supersedesID) prior.status = "superseded"
            }
          }
          const now = Date.now()
          instruction = {
            id: `ins-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            projectID: input.projectID,
            text: route.instructionText,
            source: "user",
            status: "queued",
            urgency: "normal",
            roadmapVersionReceived: file.roadmap.version,
            objectiveVersionReceived: file.objective.version,
            createdAt: now,
            updatedAt: now,
            disposition: {
              kind: classified.kind,
              summary: route.instructionText.slice(0, 200),
              affectedTaskIDs: [...classified.taskIDs],
              affectedArtifactIDs: [],
              requiresRoadmapMutation: !["idea", "no_change", "clarification"].includes(classified.kind),
              requiresWorkerInterruption: false,
              requiresClarification: classified.kind === "clarification",
              confidence: classified.confidence,
              reasonCodes: [...classified.reasonCodes],
            },
          }
          existing.push(instruction)
          file.instructions = existing
          instructionStatus = supersession.supersedesID ? "superseded" : "queued"
        }

        // Complex instructions (architecture-level) escalate to the selective
        // model replanner; the deterministic ChangeSet validator remains the
        // only mutation authority and simple edits never invoke a model.
        const requiresMutation = !["idea", "no_change", "clarification"].includes(classified.kind)
        const complexInstruction =
          /\b(architecture|strategy|migrate|boundary|boundaries)\b/i.test(route.instructionText ?? "") ||
          /,\s*(but|while|without)\b/i.test(route.instructionText ?? "") ||
          /\b(but|while) .*?(keep|without|avoid)/i.test(route.instructionText ?? "")
        if (
          (classified.kind === "architecture_change" || complexInstruction) &&
          !cancelled() &&
          instruction &&
          instructionStatus !== "rejected"
        ) {
          const outcome = yield* runModelReplanner(input.projectID, file, instruction)
          appliedChangeSetOk = outcome.ok
          appliedChangeSetAttempts = outcome.attempts
          instruction.status = outcome.ok ? "applied" : "failed"
          instruction.updatedAt = Date.now()
          instructionStatus = outcome.ok ? "applied" : "failed"
        }
      } else if (route.intent === "idea" && route.ideaText) {
        const now = Date.now()
        const idea: ProjectIdea = {
          id: `idea-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          projectID: input.projectID,
          text: route.ideaText,
          sourceInstructionID: "",
          status: "captured",
          createdAt: now,
        }
        file.ideas = [...(file.ideas ?? []), idea]
      }

      // Human message persists in the root session through the normal Session
      // subsystem; ledger updates persist with the project state.
      if (instructionStatus !== "rejected") {
        yield* appendRootMessage(rootSessionID, input.text)
      }
      yield* Effect.promise(() => saveProject(input.projectID, file))

      // Conversation threshold trigger for model-backed session distillation:
      // every Nth user message distills a bounded recent slice into Brain memories.
      if (!cancelled()) {
        const history = yield* sessions
          .messages({ sessionID: rootSessionID as never, limit: 50 })
          .pipe(Effect.option)
        if (history._tag === "Some") {
          const userTexts = history.value
            .filter((entry) => entry.info.role === "user")
            .map((entry) =>
              entry.parts
                .filter((part) => part.type === "text")
                .map((part) => (part as unknown as { text?: string }).text ?? "")
                .join(" "),
            )
            .filter((text) => text.length > 0)
          if (userTexts.length > 0 && userTexts.length % intelligenceThresholds.sessionEveryMessages === 0) {
            const slice = userTexts.slice(-intelligenceThresholds.sessionEveryMessages)
            yield* modelDistillSession({ projectID: input.projectID, file, rootSessionID, userTexts: slice }).pipe(
              Effect.map(() => undefined),
              Effect.catch(() => Effect.void),
            )
          }
        }
      }

      return {
        intent: route.intent,
        rootSessionID,
        ...(route.instructionText ? { instructionText: route.instructionText } : {}),
        ...(route.queryText ? { queryText: route.queryText } : {}),
        ...(route.ideaText ? { ideaText: route.ideaText } : {}),
        reason: route.reason,
        ...(instructionStatus ? { instructionStatus } : {}),
        ...(appliedChangeSetOk !== undefined ? { replannerApplied: appliedChangeSetOk, replannerAttempts: appliedChangeSetAttempts } : {}),
      }
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
      for (const worker of interruptionCoordinator.getWorkersByProject(projectID)) {
        removeInterruptionBarrier(worker.sessionID)
      }
      publish(bridge, Resumed, { projectID, timestamp: Date.now() })

      // Resume scheduler admission for a roadmap that was mid-execution when
      // paused; projects still in planning stay idle until an explicit start.
      if ((latest.roadmap.status === "executing" || latest.roadmap.status === "verifying") && !latest.cancelledAt) {
        yield* start(projectID).pipe(Effect.catch(() => Effect.void))
      }
      return running
    })

    return Service.of({ createProject, get, list, plan, start, cancel, chat, compactBrain, workingTreeSummary, workingTreeFiles, checkpoint, listCheckpoints: listCheckpointsFn, getCheckpoint, latestCheckpoint: latestCheckpointFn, getControlState, pause, resume, interruptWorker })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [EventV2Bridge.node, Session.node, SessionPrompt.node, Git.node, Supervisor.node, AtlasRouter.node],
})

export * as Orchestrator from "."
export type { InterruptCause } from "./interruption"
