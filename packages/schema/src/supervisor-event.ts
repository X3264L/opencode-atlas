export * as SupervisorEvent from "./supervisor-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const HealthChanged = Event.define({
  type: "atlas.supervisor.health.changed",
  schema: {
    projectID: Schema.String,
    health: Schema.String,
    previousHealth: optional(Schema.String),
  },
})

export const IncidentOpened = Event.define({
  type: "atlas.supervisor.incident.opened",
  schema: {
    projectID: Schema.String,
    incidentID: Schema.String,
    kind: Schema.String,
    severity: Schema.String,
    status: Schema.String,
    taskID: optional(Schema.String),
  },
})

export const IncidentClassified = Event.define({
  type: "atlas.supervisor.incident.classified",
  schema: {
    projectID: Schema.String,
    incidentID: Schema.String,
    kind: Schema.String,
    previousKind: optional(Schema.String),
  },
})

export const RecoveryStarted = Event.define({
  type: "atlas.supervisor.recovery.started",
  schema: {
    projectID: Schema.String,
    incidentID: Schema.String,
    taskID: optional(Schema.String),
    action: Schema.String,
    attempt: Schema.Number,
  },
})

export const RecoveryCompleted = Event.define({
  type: "atlas.supervisor.recovery.completed",
  schema: {
    projectID: Schema.String,
    incidentID: Schema.String,
    action: Schema.String,
    attempt: Schema.Number,
  },
})

export const RecoveryFailed = Event.define({
  type: "atlas.supervisor.recovery.failed",
  schema: {
    projectID: Schema.String,
    incidentID: Schema.String,
    action: Schema.String,
    attempt: Schema.Number,
    reason: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(
  HealthChanged,
  IncidentOpened,
  IncidentClassified,
  RecoveryStarted,
  RecoveryCompleted,
  RecoveryFailed,
)
