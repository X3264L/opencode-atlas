import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import {
  HealthChanged,
  IncidentOpened,
  IncidentClassified,
  RecoveryStarted,
  RecoveryCompleted,
  RecoveryFailed,
} from "@opencode-ai/schema/supervisor-event"
import type { SupervisorHealth, SupervisorIncident, IncidentKind, IncidentSeverity, RecoveryAction } from "./types"

export interface OpenIncidentInput {
  projectID: string
  kind?: IncidentKind
  severity?: IncidentSeverity
  taskID?: string
  detail?: string
}

export interface ClassifyInput {
  projectID: string
  incidentID: string
  kind: IncidentKind
}

export interface RecoveryInput {
  projectID: string
  incidentID: string
  taskID?: string
  action: RecoveryAction
  attempt: number
  reason?: string
}

export interface Interface {
  readonly getHealth: (projectID: string) => Effect.Effect<SupervisorHealth>
  readonly getIncidents: (projectID: string) => Effect.Effect<SupervisorIncident[]>
  readonly getIncident: (projectID: string, incidentID: string) => Effect.Effect<SupervisorIncident | undefined>
  readonly setHealth: (projectID: string, health: SupervisorHealth) => Effect.Effect<SupervisorHealth>
  readonly openIncident: (input: OpenIncidentInput) => Effect.Effect<SupervisorIncident>
  readonly classifyIncident: (input: ClassifyInput) => Effect.Effect<SupervisorIncident, Error>
  readonly startRecovery: (input: RecoveryInput) => Effect.Effect<SupervisorIncident, Error>
  readonly completeRecovery: (input: RecoveryInput) => Effect.Effect<SupervisorIncident, Error>
  readonly failRecovery: (input: RecoveryInput) => Effect.Effect<SupervisorIncident, Error>
  readonly setPaused: (projectID: string, paused: boolean) => Effect.Effect<void>
  readonly isPaused: (projectID: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Supervisor") {}

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

    const healthByProject = new Map<string, SupervisorHealth>()
    const incidentsById = new Map<string, SupervisorIncident>()
    const incidentIdsByProject = new Map<string, Set<string>>()
    const pausedProjects = new Set<string>()

    const getHealthInternal = (projectID: string): SupervisorHealth => healthByProject.get(projectID) ?? "healthy"

    const setHealthInternal = (projectID: string, health: SupervisorHealth) => {
      const previous = getHealthInternal(projectID)
      if (previous === health) return health
      healthByProject.set(projectID, health)
      publish(bridge, HealthChanged, { projectID, health, ...(previous ? { previousHealth: previous } : {}) })
      return health
    }

    const getHealth = Effect.fn("Supervisor.getHealth")(function* (projectID: string) {
      return getHealthInternal(projectID)
    })

    const getIncidents = Effect.fn("Supervisor.getIncidents")(function* (projectID: string) {
      const ids = incidentIdsByProject.get(projectID)
      if (!ids) return []
      return [...ids].flatMap((id) => {
        const incident = incidentsById.get(id)
        return incident ? [incident] : []
      })
    })

    const getIncident = Effect.fn("Supervisor.getIncident")(function* (projectID: string, incidentID: string) {
      const incident = incidentsById.get(incidentID)
      if (!incident || incident.projectID !== projectID) return undefined
      return incident
    })

    const setHealth = Effect.fn("Supervisor.setHealth")(function* (projectID: string, health: SupervisorHealth) {
      return setHealthInternal(projectID, health)
    })

    const openIncident = Effect.fn("Supervisor.openIncident")(function* (input: OpenIncidentInput) {
      // Pause is a human policy barrier: intentionally stopped workers must
      // not surface as stall/lost false positives. True external failures
      // (provider/runtime/tool/build kinds) still open normally.
      if (pausedProjects.has(input.projectID) && (input.kind === "worker_stalled" || input.kind === "worker_lost")) {
        const suppressed: SupervisorIncident = {
          id: `suppressed-${Date.now().toString(36)}`,
          projectID: input.projectID,
          ...(input.taskID ? { taskID: input.taskID } : {}),
          kind: input.kind ?? "unknown",
          severity: input.severity ?? "error",
          status: "abandoned",
          evidenceRefs: [],
          ...(input.detail ? { detail: input.detail } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        return suppressed
      }
      const now = Date.now()
      const incidentID = `inc-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
      const incident: SupervisorIncident = {
        id: incidentID,
        projectID: input.projectID,
        ...(input.taskID ? { taskID: input.taskID } : {}),
        kind: input.kind ?? "unknown",
        severity: input.severity ?? "error",
        status: "open",
        evidenceRefs: [],
        ...(input.detail ? { detail: input.detail } : {}),
        createdAt: now,
        updatedAt: now,
      }
      incidentsById.set(incidentID, incident)
      const set = incidentIdsByProject.get(input.projectID) ?? new Set<string>()
      set.add(incidentID)
      incidentIdsByProject.set(input.projectID, set)

      // Health degrades on new incident
      const currentHealth = getHealthInternal(input.projectID)
      if (currentHealth === "healthy") setHealthInternal(input.projectID, "degraded")

      publish(bridge, IncidentOpened, {
        projectID: input.projectID,
        incidentID,
        kind: incident.kind,
        severity: incident.severity,
        status: incident.status,
        ...(incident.taskID ? { taskID: incident.taskID } : {}),
      })
      return incident
    })

    const classifyIncident = Effect.fn("Supervisor.classifyIncident")(function* (input: ClassifyInput) {
      const incident = incidentsById.get(input.incidentID)
      if (!incident || incident.projectID !== input.projectID) return yield* Effect.fail(new Error(`Unknown incident: ${input.incidentID}`))
      const previousKind = incident.kind
      incident.kind = input.kind
      incident.status = "diagnosing"
      incident.updatedAt = Date.now()
      publish(bridge, IncidentClassified, {
        projectID: input.projectID,
        incidentID: input.incidentID,
        kind: input.kind,
        ...(previousKind ? { previousKind } : {}),
      })
      return incident
    })

    const startRecovery = Effect.fn("Supervisor.startRecovery")(function* (input: RecoveryInput) {
      const incident = incidentsById.get(input.incidentID)
      if (!incident || incident.projectID !== input.projectID) return yield* Effect.fail(new Error(`Unknown incident: ${input.incidentID}`))
      incident.status = "recovering"
      incident.updatedAt = Date.now()
      setHealthInternal(input.projectID, "recovering")
      publish(bridge, RecoveryStarted, {
        projectID: input.projectID,
        incidentID: input.incidentID,
        ...(input.taskID ?? incident.taskID ? { taskID: input.taskID ?? incident.taskID! } : {}),
        action: input.action,
        attempt: input.attempt,
      })
      return incident
    })

    const completeRecovery = Effect.fn("Supervisor.completeRecovery")(function* (input: RecoveryInput) {
      const incident = incidentsById.get(input.incidentID)
      if (!incident || incident.projectID !== input.projectID) return yield* Effect.fail(new Error(`Unknown incident: ${input.incidentID}`))
      incident.status = "resolved"
      incident.updatedAt = Date.now()
      // If no other open incidents remain, restore health
      const siblings = [...(incidentIdsByProject.get(input.projectID) ?? [])].some((id) => {
        const other = incidentsById.get(id)
        return other && other.id !== incident.id && other.status !== "resolved" && other.status !== "abandoned"
      })
      if (!siblings) setHealthInternal(input.projectID, "healthy")
      publish(bridge, RecoveryCompleted, {
        projectID: input.projectID,
        incidentID: input.incidentID,
        action: input.action,
        attempt: input.attempt,
      })
      return incident
    })

    const failRecovery = Effect.fn("Supervisor.failRecovery")(function* (input: RecoveryInput) {
      const incident = incidentsById.get(input.incidentID)
      if (!incident || incident.projectID !== input.projectID) return yield* Effect.fail(new Error(`Unknown incident: ${input.incidentID}`))
      incident.status = "escalated"
      incident.updatedAt = Date.now()
      setHealthInternal(input.projectID, "blocked")
      publish(bridge, RecoveryFailed, {
        projectID: input.projectID,
        incidentID: input.incidentID,
        action: input.action,
        attempt: input.attempt,
        ...(input.reason ? { reason: input.reason } : {}),
      })
      return incident
    })

    const setPaused = Effect.fn("Supervisor.setPaused")(function* (projectID: string, paused: boolean) {
      if (paused) pausedProjects.add(projectID)
      else pausedProjects.delete(projectID)
    })

    const isPaused = Effect.fn("Supervisor.isPaused")(function* (projectID: string) {
      return pausedProjects.has(projectID)
    })

    return Service.of({
      getHealth,
      getIncidents,
      getIncident,
      setHealth,
      openIncident,
      classifyIncident,
      startRecovery,
      completeRecovery,
      failRecovery,
      setPaused,
      isPaused,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [EventV2Bridge.node],
})

export * as Supervisor from "."
