export * as RoutingEvent from "./routing-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

/** Emitted whenever Atlas resolves an execution path automatically */
export const Decision = Event.define({
  type: "atlas.routing.decision",
  schema: {
    mode: Schema.Literals(["auto", "local", "hybrid", "cloud"]),
    source: Schema.Literals(["local", "cloud", "none"]),
    providerID: optional(Schema.String),
    modelID: optional(Schema.String),
    runtimeID: optional(Schema.String),
    bypassed: Schema.Boolean,
    confidence: Schema.Literals(["high", "medium", "low"]),
    reasonCodes: Schema.Array(Schema.String),
    estimatedCloudCost: optional(Schema.Number),
  },
})

/** Emitted when a failure triggers a policy-approved fallback attempt */
export const Fallback = Event.define({
  type: "atlas.routing.fallback",
  schema: {
    mode: Schema.Literals(["auto", "local", "hybrid", "cloud"]),
    fromSource: Schema.Literals(["local", "cloud"]),
    fromProviderID: optional(Schema.String),
    fromModelID: optional(Schema.String),
    toProviderID: optional(Schema.String),
    toModelID: optional(Schema.String),
    failureKind: Schema.String,
    reasonCodes: Schema.Array(Schema.String),
  },
})

export const Definitions = Event.inventory(Decision, Fallback)
