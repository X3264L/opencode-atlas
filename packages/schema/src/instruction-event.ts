export * as InstructionEvent from "./instruction-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const Received = Event.define({
  type: "atlas.instruction.received",
  schema: { projectID: Schema.String, instructionID: Schema.String, text: Schema.String },
})

export const Classified = Event.define({
  type: "atlas.instruction.classified",
  schema: {
    projectID: Schema.String,
    instructionID: Schema.String,
    kind: Schema.String,
    reasonCodes: Schema.Array(Schema.String),
    confidence: Schema.String,
  },
})

export const Applied = Event.define({
  type: "atlas.instruction.applied",
  schema: {
    projectID: Schema.String,
    instructionID: Schema.String,
    changesetID: Schema.String,
    roadmapVersionAfter: Schema.Number,
  },
})

export const Deferred = Event.define({
  type: "atlas.instruction.deferred",
  schema: {
    projectID: Schema.String,
    instructionID: Schema.String,
    reason: optional(Schema.String),
  },
})

export const Failed = Event.define({
  type: "atlas.instruction.failed",
  schema: {
    projectID: Schema.String,
    instructionID: Schema.String,
    error: Schema.String,
  },
})

export const ChangesetProposed = Event.define({
  type: "atlas.roadmap.changeset.proposed",
  schema: {
    projectID: Schema.String,
    changesetID: Schema.String,
    risk: Schema.String,
    operationCount: Schema.Number,
  },
})

export const ChangesetApplied = Event.define({
  type: "atlas.roadmap.changeset.applied",
  schema: {
    projectID: Schema.String,
    changesetID: Schema.String,
    roadmapVersionAfter: Schema.Number,
  },
})

export const TaskInvalidated = Event.define({
  type: "atlas.roadmap.task.invalidated",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    instructionID: Schema.String,
  },
})

export const WorkerInterruptionRequested = Event.define({
  type: "atlas.worker.interruption.requested",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    sessionID: optional(Schema.String),
  },
})

export const WorkerInterrupted = Event.define({
  type: "atlas.worker.interrupted",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    sessionID: optional(Schema.String),
  },
})

export const WorkerResultStale = Event.define({
  type: "atlas.worker.result.stale",
  schema: {
    projectID: Schema.String,
    taskID: Schema.String,
    contractRoadmapVersion: Schema.Number,
    currentRoadmapVersion: Schema.Number,
  },
})

export const ArtifactInvalidated = Event.define({
  type: "atlas.artifact.invalidated",
  schema: {
    projectID: Schema.String,
    artifactID: Schema.String,
    instructionID: optional(Schema.String),
  },
})

export const ArtifactSuperseded = Event.define({
  type: "atlas.artifact.superseded",
  schema: {
    projectID: Schema.String,
    oldArtifactID: Schema.String,
    newArtifactID: Schema.String,
  },
})

export const Definitions = Event.inventory(
  Received,
  Classified,
  Applied,
  Deferred,
  Failed,
  ChangesetProposed,
  ChangesetApplied,
  TaskInvalidated,
  WorkerInterruptionRequested,
  WorkerInterrupted,
  WorkerResultStale,
  ArtifactInvalidated,
  ArtifactSuperseded,
)
