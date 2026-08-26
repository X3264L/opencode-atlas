export * as ProjectControlEvent from "./project-control-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const CheckpointCreated = Event.define({
  type: "atlas.project.checkpoint.created",
  schema: {
    projectID: Schema.String,
    checkpointID: Schema.String,
    timestamp: Schema.Number,
  },
})

export const Paused = Event.define({
  type: "atlas.project.paused",
  schema: {
    projectID: Schema.String,
    checkpointID: optional(Schema.String),
    mode: Schema.String,
    timestamp: Schema.Number,
  },
})

export const Resumed = Event.define({
  type: "atlas.project.resumed",
  schema: {
    projectID: Schema.String,
    timestamp: Schema.Number,
  },
})

export const Definitions = Event.inventory(
  CheckpointCreated,
  Paused,
  Resumed,
)
