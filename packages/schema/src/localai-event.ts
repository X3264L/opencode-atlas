export * as LocalAiEvent from "./localai-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"

export const InstanceState = Schema.Literals(["starting", "running", "stopping", "stopped", "crashed", "failed"])
export type InstanceState = typeof InstanceState.Type

export const InstancePhase = Schema.Literals([
  "port_selected",
  "spawning",
  "loading_model",
  "health_wait",
  "ready",
  "cancelled",
])
export type InstancePhase = typeof InstancePhase.Type

export const Lifecycle = Event.define({
  type: "localai.instance.lifecycle",
  schema: {
    runtimeID: Schema.String,
    instanceID: Schema.String,
    artifactID: optional(Schema.String),
    state: InstanceState,
    phase: optional(InstancePhase),
    /** Monotonic per-artifact launch counter - stale older generations are ignored */
    generation: NonNegativeInt,
    exitCode: optional(Schema.Int),
    reason: optional(Schema.String),
    stderrTail: optional(Schema.Array(Schema.String)),
  },
})

export const LogLines = Schema.Struct({
  at: Schema.Number,
  source: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
})
export type LogLine = typeof LogLines.Type

export const InstanceLog = Event.define({
  type: "localai.instance.log",
  schema: {
    runtimeID: Schema.String,
    instanceID: Schema.String,
    lines: Schema.Array(LogLines),
  },
})

export const HealthChanged = Event.define({
  type: "localai.health.changed",
  schema: {
    runtimeID: Schema.String,
    health: Schema.Literals(["available", "unavailable", "degraded", "unsupported"]),
    detail: optional(Schema.String),
  },
})

export const ArtifactChanged = Event.define({
  type: "localai.managed.artifact",
  schema: {
    artifactID: Schema.String,
    change: Schema.Literals(["registered", "removed", "file_missing", "file_restored"]),
  },
})

export const ExecutableChanged = Event.define({
  type: "localai.executable.changed",
  schema: {
    found: Schema.Boolean,
    path: optional(Schema.String),
    reason: optional(Schema.String),
  },
})

export const BenchmarkStatus = Event.define({
  type: "localai.benchmark.status",
  schema: {
    runtimeID: Schema.String,
    modelID: Schema.String,
    status: Schema.Literals(["started", "completed", "failed", "cancelled"]),
    tokensPerSecond: optional(Schema.Number),
    promptTokensPerSecond: optional(Schema.Number),
    timeToFirstTokenMs: optional(Schema.Number),
    error: optional(Schema.String),
  },
})

export const ReadinessCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  pass: Schema.Boolean,
})
export type ReadinessCheck = typeof ReadinessCheck.Type

export const ReadinessStatus = Event.define({
  type: "localai.readiness.status",
  schema: {
    runtimeID: Schema.String,
    modelID: Schema.String,
    status: Schema.Literals(["started", "check_completed", "completed", "failed", "cancelled"]),
    check: optional(ReadinessCheck),
    score: optional(Schema.Number),
    error: optional(Schema.String),
  },
})

export const InstallStatus = Event.define({
  type: "localai.install.status",
  schema: {
    jobID: Schema.String,
    runtimeID: optional(Schema.String),
    runtimeModelID: optional(Schema.String),
    status: Schema.Literals(["started", "progress", "verifying", "completed", "cancelled", "failed"]),
    percent: optional(Schema.Number),
    message: optional(Schema.String),
    error: optional(Schema.String),
  },
})

export const ProviderChanged = Event.define({
  type: "localai.provider.changed",
  schema: {
    runtimeID: Schema.String,
    endpoint: optional(Schema.String),
    available: Schema.Boolean,
  },
})

export const Definitions = Event.inventory(
  Lifecycle,
  InstanceLog,
  HealthChanged,
  ArtifactChanged,
  ExecutableChanged,
  BenchmarkStatus,
  ReadinessStatus,
  InstallStatus,
  ProviderChanged,
)
