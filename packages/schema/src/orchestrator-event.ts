export * as OrchestratorEvent from "./orchestrator-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const ProjectCreated = Event.define({
  type: "atlas.project.created",
  schema: { projectID: Schema.String, title: Schema.String },
})

export const RoadmapUpdated = Event.define({
  type: "atlas.roadmap.updated",
  schema: { projectID: Schema.String, version: Schema.Number },
})

export const TaskState = Event.define({
  type: "atlas.task.state",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    state: Schema.String,
    attempt: Schema.Number,
  },
})

export const WorkerStarted = Event.define({
  type: "atlas.worker.started",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    profile: optional(Schema.String),
  },
})

export const WorkerCompleted = Event.define({
  type: "atlas.worker.completed",
  schema: { projectID: Schema.String, taskID: Schema.String },
})

export const WorkerFailed = Event.define({
  type: "atlas.worker.failed",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    failureClass: Schema.String,
    detail: optional(Schema.String),
  },
})

export const VerificationCompleted = Event.define({
  type: "atlas.verification.completed",
  schema: { projectID: Schema.String, taskID: Schema.String, passed: Schema.Boolean },
})

export const ProjectCompleted = Event.define({
  type: "atlas.project.completed",
  schema: { projectID: Schema.String },
})

export const ProjectBlocked = Event.define({
  type: "atlas.project.blocked",
  schema: { projectID: Schema.String, reason: optional(Schema.String) },
})

export const ProjectCancelled = Event.define({
  type: "atlas.project.cancelled",
  schema: { projectID: Schema.String },
})

export const DiffstatChanged = Event.define({
  type: "atlas.diffstat.changed",
  schema: {
    projectID: Schema.String,
    additions: Schema.Number,
    deletions: Schema.Number,
    files: Schema.Number,
  },
})

export const ProjectSessionCreated = Event.define({
  type: "atlas.project.session.created",
  schema: { projectID: Schema.String, sessionID: Schema.String },
})

export const ProjectSessionReconciled = Event.define({
  type: "atlas.project.session.reconciled",
  schema: {
    projectID: Schema.String,
    sessionID: Schema.String,
    previousSessionID: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(
  ProjectCreated,
  RoadmapUpdated,
  TaskState,
  WorkerStarted,
  WorkerCompleted,
  WorkerFailed,
  VerificationCompleted,
  ProjectCompleted,
  ProjectBlocked,
  ProjectCancelled,
  DiffstatChanged,
  ProjectSessionCreated,
  ProjectSessionReconciled,
)
