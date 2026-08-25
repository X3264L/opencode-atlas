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

const RuntimeCapabilities = Schema.Struct({
  discovery: Schema.Boolean,
  modelListing: Schema.Boolean,
  modelInstall: Schema.Boolean,
  modelRemoval: Schema.Boolean,
  streaming: Schema.Boolean,
  toolCalling: Schema.Boolean,
  structuredOutput: Schema.Boolean,
  embeddings: Schema.optionalKey(Schema.Boolean),
  vision: Schema.optionalKey(Schema.Boolean),
  benchmark: Schema.Boolean,
  cancellation: Schema.Boolean,
  externalModelFiles: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LocalAiRuntimeCapabilities" })

const RuntimeHealth = Schema.Struct({
  state: Schema.Literals(["available", "unavailable", "degraded", "unsupported"]),
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiRuntimeHealth" })

const RuntimeStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  capabilities: RuntimeCapabilities,
  health: RuntimeHealth,
  modelCount: Schema.Number,
}).annotate({ identifier: "LocalAiRuntimeStatus" })

/** One runnable model on one concrete runtime */
const ModelInstanceRef = Schema.Struct({
  runtimeID: Schema.String,
  runtimeModelID: Schema.String,
  quantization: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiModelInstanceRef" })

/** Logical model grouped across runtimes; uncertain identities stay separate */
const NormalizedModelGroup = Schema.Struct({
  key: Schema.String,
  modelID: Schema.optionalKey(Schema.String),
  variantID: Schema.optionalKey(Schema.String),
  label: Schema.String,
  instances: Schema.Array(ModelInstanceRef),
}).annotate({ identifier: "LocalAiNormalizedModelGroup" })

export const RUNTIME_IDS = ["auto", "ollama", "lmstudio", "llamacpp", "mlx"] as const

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
  runtime: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      source: Schema.Literals(["measured", "preference", "heuristic", "none"]),
      reasons: Schema.Array(
        Schema.Struct({ kind: Schema.Literals(["positive", "caveat"]), text: Schema.String }),
      ),
    }).annotate({ identifier: "LocalAiRuntimeChoice" }),
  ),
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
  toolCalling: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "LocalAiReadinessSummary" })

export const LocalAiStateResponse = Schema.Struct({
  hardware: HardwareProfile,
  runtimes: Schema.Array(RuntimeStatus),
  installed: Schema.Record(Schema.String, Schema.Array(InstalledModel)),
  recommendations: Schema.Array(Recommendation),
  /** Benchmark results keyed [runtimeID][runtimeModelID] */
  benchmarks: Schema.Record(Schema.String, Schema.Record(Schema.String, BenchmarkInfo)),
  readiness: Schema.Record(Schema.String, Schema.Record(Schema.String, ReadinessSummary)),
  preference: Schema.Literals(["auto", "ollama", "lmstudio", "llamacpp", "mlx"]),
  normalized: Schema.Array(NormalizedModelGroup),
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
  /** Target a specific runtime; defaults to the first capable one */
  runtimeID: Schema.optionalKey(Schema.Literals(["ollama", "lmstudio", "llamacpp", "mlx"])),
}).annotate({ identifier: "LocalAiModelInput" })

export const PreferencePayload = Schema.Struct({
  runtime: Schema.Literals(["auto", "ollama", "lmstudio", "llamacpp", "mlx"]),
}).annotate({ identifier: "LocalAiPreferenceInput" })

export const GgufRegisterPayload = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "LocalAiGgufRegisterInput" })

export const ExecutablePathPayload = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiExecutablePathInput" })

const ManagedInstanceInfo = Schema.Struct({
  id: Schema.String,
  artifactID: Schema.String,
  state: Schema.Literals(["starting", "running", "stopping", "stopped", "crashed", "failed"]),
  endpoint: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  lastError: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LocalAiManagedInstance" })

const GgufArtifactInfo = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  displayName: Schema.String,
  modelID: Schema.optionalKey(Schema.String),
  variantID: Schema.optionalKey(Schema.String),
  quantization: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  parameterCount: Schema.optionalKey(Schema.Number),
  sizeBytes: Schema.optionalKey(Schema.Number),
  launchOverrides: Schema.optionalKey(
    Schema.Struct({
      contextSize: Schema.optionalKey(Schema.Number),
      gpuLayers: Schema.optionalKey(Schema.Number),
      threads: Schema.optionalKey(Schema.Number),
    }),
  ),
  registeredAt: Schema.String,
}).annotate({ identifier: "LocalAiGgufArtifact" })

const ManagedArtifactInfo = Schema.Struct({
  artifact: GgufArtifactInfo,
  fileExists: Schema.Boolean,
  recommendedContext: Schema.optionalKey(Schema.Number),
  instance: Schema.optionalKey(ManagedInstanceInfo),
}).annotate({ identifier: "LocalAiManagedArtifact" })

export const ManagedStateResponse = Schema.Struct({
  executable: Schema.Struct({
    found: Schema.Boolean,
    path: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.Literals(["configured", "path-lookup", "common-location"])),
    reason: Schema.optionalKey(Schema.String),
  }),
  configuredPath: Schema.optionalKey(Schema.String),
  artifacts: Schema.Array(ManagedArtifactInfo),
}).annotate({ identifier: "LocalAiManagedState" })

export const ManagedLogsResponse = Schema.Struct({
  lines: Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      source: Schema.Literals(["stdout", "stderr"]),
      line: Schema.String,
    }),
  ),
}).annotate({ identifier: "LocalAiManagedLogs" })

export const ManagedPaths = {
  managedState: "/localai/managed",
  managedRegister: "/localai/managed/register",
  managedArtifact: "/localai/managed/artifact/:artifactID",
  managedStart: "/localai/managed/artifact/:artifactID/start",
  managedStop: "/localai/managed/instance/:instanceID/stop",
  managedRestart: "/localai/managed/instance/:instanceID/restart",
  managedLogs: "/localai/managed/instance/:instanceID/logs",
  managedExecutable: "/localai/managed/executable",
} as const

export const JobResponse = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["install", "benchmark", "readiness"]),
  modelID: Schema.optionalKey(Schema.String),
  runtimeTag: Schema.optionalKey(Schema.String),
  runtimeID: Schema.optionalKey(Schema.String),
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
  preference: "/localai/preference",
  ...ManagedPaths,
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
        HttpApiEndpoint.post("preference", LocalAiPaths.preference, {
          query: WorkspaceRoutingQuery,
          payload: PreferencePayload,
          success: described(Schema.Literals(["auto", "ollama", "lmstudio", "llamacpp", "mlx"]), "Stored runtime preference"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.preference.set",
            summary: "Set preferred local runtime",
            description:
              "Store the user's runtime preference. 'auto' lets Atlas choose based on measured evidence; a specific runtime is honored whenever it can serve the model.",
          }),
        ),
        HttpApiEndpoint.get("managedState", LocalAiPaths.managedState, {
          query: WorkspaceRoutingQuery,
          success: described(ManagedStateResponse, "Managed llama.cpp ownership state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.state",
            summary: "Get managed llama.cpp state",
            description:
              "Registered GGUF artifacts (by reference - files are never copied or modified), executable discovery status, and per-artifact instance state.",
          }),
        ),
        HttpApiEndpoint.post("managedRegister", LocalAiPaths.managedRegister, {
          query: WorkspaceRoutingQuery,
          payload: GgufRegisterPayload,
          success: described(ManagedArtifactInfo, "Registered artifact"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.register",
            summary: "Register a local GGUF file",
            description:
              "Validates an existing .gguf file and stores a lightweight registration referencing it. The file is never copied, moved, or modified.",
          }),
        ),
        HttpApiEndpoint.delete("managedRemove", LocalAiPaths.managedArtifact, {
          params: { artifactID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Removal success"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.remove",
            summary: "Remove a GGUF registration",
            description: "Removes the Atlas registration. Running instances must be stopped first; the GGUF file itself is never deleted.",
          }),
        ),
        HttpApiEndpoint.post("managedStart", LocalAiPaths.managedStart, {
          params: { artifactID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ManagedInstanceInfo, "Instance state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.start",
            summary: "Start a managed llama.cpp instance",
            description:
              "Launches llama-server on a free loopback port with hardware-recommended context and waits for health. Only loopback binding is supported.",
          }),
        ),
        HttpApiEndpoint.post("managedStop", LocalAiPaths.managedStop, {
          params: { instanceID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ManagedInstanceInfo, "Instance state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.stop",
            summary: "Stop a managed instance",
            description: "Gracefully terminates an Atlas-owned instance; only processes spawned by Atlas are ever signalled.",
          }),
        ),
        HttpApiEndpoint.post("managedRestart", LocalAiPaths.managedRestart, {
          params: { instanceID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ManagedInstanceInfo, "Instance state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.restart",
            summary: "Restart a managed instance",
            description: "Stops the owned instance and starts it again with the same launch configuration.",
          }),
        ),
        HttpApiEndpoint.get("managedLogs", LocalAiPaths.managedLogs, {
          params: { instanceID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ManagedLogsResponse, "Recent process logs"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.logs",
            summary: "Get managed instance logs",
            description: "Returns the most recent bounded stdout/stderr lines captured from an Atlas-owned process.",
          }),
        ),
        HttpApiEndpoint.post("managedExecutable", LocalAiPaths.managedExecutable, {
          query: WorkspaceRoutingQuery,
          payload: ExecutablePathPayload,
          success: described(ManagedStateResponse, "Updated managed state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "localai.managed.executable",
            summary: "Configure llama-server executable path",
            description:
              "Stores or clears the explicit llama-server path. Atlas validates the file exists; binaries are never downloaded automatically.",
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
