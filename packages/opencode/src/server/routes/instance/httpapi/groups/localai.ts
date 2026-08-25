import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const GpuProfile = Schema.Struct({
  vendor: Schema.String,
  model: Schema.String,
  vramBytes: Schema.optionalKey(Schema.Number),
  architecture: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiGpuProfile" })

const HardwareProfile = Schema.Struct({
  os: Schema.Struct({ platform: Schema.String, arch: Schema.String }),
  cpu: Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    physicalCores: Schema.optionalKey(Schema.Number),
    logicalCores: Schema.optionalKey(Schema.Number),
  }),
  memory: Schema.Struct({
    totalBytes: Schema.Number,
    availableBytes: Schema.optionalKey(Schema.Number),
  }),
  gpus: Schema.Array(GpuProfile),
}).annotate({ identifier: "LocalAiHardwareProfile" })

const RuntimeDetection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiRuntimeDetection" })

const InstalledModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.optionalKey(Schema.Number),
  quantization: Schema.optionalKey(Schema.String),
  parameterCount: Schema.optionalKey(Schema.Number),
  family: Schema.optionalKey(Schema.String),
  contextLength: Schema.optionalKey(Schema.Number),
  toolCalling: Schema.optionalKey(Schema.Boolean),
  vision: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LocalAiInstalledModel" })

const ModelVariantInfo = Schema.Struct({
  id: Schema.String,
  runtimeTag: Schema.optionalKey(Schema.String),
  quantization: Schema.optionalKey(Schema.String),
  downloadSizeBytes: Schema.optionalKey(Schema.Number),
  estimatedWeightBytes: Schema.optionalKey(Schema.Number),
  qualityMultiplier: Schema.optionalKey(Schema.Number),
  speedMultiplier: Schema.optionalKey(Schema.Number),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "LocalAiModelVariant" })

const WorkingSetEstimate = Schema.Struct({
  weightsBytes: Schema.Number,
  kvCacheBytes: Schema.Number,
  overheadBytes: Schema.Number,
  reserveBytes: Schema.Number,
  totalBytes: Schema.Number,
  vramBytes: Schema.Number,
  ramBytes: Schema.optionalKey(Schema.Number),
  contextLength: Schema.Number,
  comfortableMaximumContext: Schema.optionalKey(Schema.Number),
  headroomBytes: Schema.optionalKey(Schema.Number),
  downloadBytes: Schema.optionalKey(Schema.Number),
})

const VariantEvaluation = Schema.Struct({
  variant: ModelVariantInfo,
  runtimeTag: Schema.optionalKey(Schema.String),
  score: Schema.Number,
  compatibility: Schema.Literals(["excellent", "good", "usable", "not_recommended"]),
  offload: Schema.Literals(["none", "partial", "heavy", "cpu_dominant"]),
  reasons: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  estimated: WorkingSetEstimate,
  recommended: Schema.Boolean,
  measuredTokensPerSecond: Schema.optionalKey(Schema.Number),
  metricSource: Schema.Literals(["estimated", "measured"]),
}).annotate({ identifier: "LocalAiVariantEvaluation" })

const Recommendation = Schema.Struct({
  model: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    family: Schema.optionalKey(Schema.String),
    parameterCount: Schema.optionalKey(Schema.Number),
    capabilities: Schema.Struct({
      coding: Schema.optionalKey(Schema.Number),
      reasoning: Schema.optionalKey(Schema.Number),
      toolCalling: Schema.optionalKey(Schema.Boolean),
      vision: Schema.optionalKey(Schema.Boolean),
      agentCompatible: Schema.optionalKey(Schema.Boolean),
    }),
    contextLength: Schema.optionalKey(Schema.Number),
    runtimes: Schema.Struct({ ollama: Schema.optionalKey(Schema.String) }),
  }),
  variant: ModelVariantInfo,
  score: Schema.Number,
  compatibility: Schema.Literals(["excellent", "good", "usable", "not_recommended"]),
  offload: Schema.Literals(["none", "partial", "heavy", "cpu_dominant"]),
  confidence: Schema.Literals(["high", "medium", "low"]),
  reasons: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  estimated: Schema.optionalKey(WorkingSetEstimate),
  installed: Schema.optionalKey(Schema.Boolean),
  alternatives: Schema.Array(VariantEvaluation),
  readinessScore: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: "LocalAiRecommendation" })

const BenchmarkInfo = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  tokensPerSecond: Schema.optionalKey(Schema.Number),
  promptTokensPerSecond: Schema.optionalKey(Schema.Number),
  timeToFirstTokenMs: Schema.optionalKey(Schema.Number),
  testedAt: Schema.Number,
}).annotate({ identifier: "LocalAiBenchmark" })

const ReadinessSummary = Schema.Struct({
  score: Schema.Number,
  testedAt: Schema.Number,
}).annotate({ identifier: "LocalAiReadinessSummary" })

export const LocalAiStateResponse = Schema.Struct({
  hardware: HardwareProfile,
  runtimes: Schema.Array(RuntimeDetection),
  installed: Schema.Record(Schema.String, Schema.Array(InstalledModel)),
  recommendations: Schema.Array(Recommendation),
  benchmarks: Schema.Record(Schema.String, BenchmarkInfo),
  readiness: Schema.Record(Schema.String, ReadinessSummary),
}).annotate({ identifier: "LocalAiState" })

export const LocalAiStateQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  preset: Schema.optionalKey(Schema.Literals(["overall", "coding", "agent", "speed", "memory", "context"])),
})

export class LocalAiApiError extends Schema.ErrorClass<LocalAiApiError>("LocalAiError")(
  {
    name: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export const InstallPayload = Schema.Struct({
  profileID: Schema.String,
  variantID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiInstallInput" })

export const ModelPayload = Schema.Struct({
  modelID: Schema.String,
}).annotate({ identifier: "LocalAiModelInput" })

export const JobResponse = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["install", "benchmark", "readiness"]),
  modelID: Schema.optionalKey(Schema.String),
  runtimeTag: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["running", "done", "error", "cancelled"]),
  status: Schema.optionalKey(Schema.String),
  percent: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  startedAt: Schema.Number,
}).annotate({ identifier: "LocalAiJob" })

export const LocalAiPaths = {
  state: "/localai/state",
  install: "/localai/install",
  remove: "/localai/remove",
  benchmark: "/localai/benchmark",
  readiness: "/localai/readiness",
  job: "/localai/job/:jobID",
  jobCancel: "/localai/job/:jobID/cancel",
} as const

export const LocalAiApi = HttpApi.make("localai")
  .add(
    HttpApiGroup.make("localai")
      .add(
        HttpApiEndpoint.get("state", LocalAiPaths.state, {
          query: LocalAiStateQuery,
          success: described(LocalAiStateResponse, "Hardware, runtimes and recommendations"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.state",
            summary: "Get local AI state",
            description:
              "Detect local hardware and runtimes, list installed models, and get hardware-aware model recommendations including per-variant evaluations.",
          }),
        ),
        HttpApiEndpoint.post("install", LocalAiPaths.install, {
          query: WorkspaceRoutingQuery,
          payload: InstallPayload,
          success: described(JobResponse, "Install job"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.install",
            summary: "Install a recommended model variant",
            description:
              "Start downloading a catalog model through Ollama. The selected variant resolves to its own runtime tag. Poll the returned job for progress.",
          }),
        ),
        HttpApiEndpoint.post("remove", LocalAiPaths.remove, {
          query: WorkspaceRoutingQuery,
          payload: ModelPayload,
          success: described(Schema.Boolean, "Removal success"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.remove",
            summary: "Remove an installed model",
            description: "Delete a locally installed model from the runtime.",
          }),
        ),
        HttpApiEndpoint.post("benchmark", LocalAiPaths.benchmark, {
          query: WorkspaceRoutingQuery,
          payload: ModelPayload,
          success: described(JobResponse, "Benchmark job"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.benchmark",
            summary: "Benchmark an installed model",
            description:
              "Measure real generation speed of an installed local model. Results are stored per exact runtime tag. Poll the returned job.",
          }),
        ),
        HttpApiEndpoint.post("readiness", LocalAiPaths.readiness, {
          query: WorkspaceRoutingQuery,
          payload: ModelPayload,
          success: described(JobResponse, "Readiness job"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.readiness",
            summary: "Run agent readiness test",
            description:
              "Probe chat, streaming, tool calling and structured output support of a local model. Results feed agent-preset recommendations.",
          }),
        ),
        HttpApiEndpoint.get("job", LocalAiPaths.job, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(JobResponse, "Job status"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.job.get",
            summary: "Get job status",
            description: "Poll the status of an install, benchmark or readiness job.",
          }),
        ),
        HttpApiEndpoint.post("jobCancel", LocalAiPaths.jobCancel, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Cancellation requested"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.job.cancel",
            summary: "Cancel a running job",
            description: "Request cancellation of a running install or benchmark. The job enters the cancelled state.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "localai",
          description: "Experimental HttpApi routes for the local AI manager.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
