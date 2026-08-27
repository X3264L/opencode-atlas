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

// ---- Intelligent routing ----------------------------------------------------

export const RoutingStateResponse = Schema.Struct({
  mode: Schema.Literals(["auto", "local", "hybrid", "cloud"]),
}).annotate({ identifier: "AtlasRoutingState" })

export const RoutingModePayload = Schema.Struct({
  mode: Schema.Literals(["auto", "local", "hybrid", "cloud"]),
}).annotate({ identifier: "AtlasRoutingModeInput" })

const RoutingCandidateInfo = Schema.Struct({
  source: Schema.Literals(["local", "cloud"]),
  providerID: Schema.String,
  modelID: Schema.String,
  runtimeID: Schema.optionalKey(Schema.String),
  runtimeModelID: Schema.optionalKey(Schema.String),
  variantID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasRoutingCandidate" })

const RoutingReasonInfo = Schema.Struct({
  code: Schema.String,
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasRoutingReason" })

const RoutingAlternativeInfo = Schema.Struct({
  candidate: RoutingCandidateInfo,
  score: Schema.optionalKey(Schema.Number),
  rejected: Schema.Boolean,
  reasons: Schema.Array(RoutingReasonInfo),
}).annotate({ identifier: "AtlasRoutingAlternative" })

export const RoutingDecisionResponse = Schema.Struct({
  mode: Schema.Literals(["auto", "local", "hybrid", "cloud"]),
  selected: Schema.optionalKey(RoutingCandidateInfo),
  confidence: Schema.Literals(["high", "medium", "low"]),
  bypassed: Schema.Boolean,
  reasons: Schema.Array(RoutingReasonInfo),
  alternatives: Schema.Array(RoutingAlternativeInfo),
  estimatedCloudCost: Schema.optionalKey(Schema.Number),
  fallbackPlan: Schema.Array(RoutingCandidateInfo),
  classification: Schema.Struct({
    taskClass: Schema.String,
    difficulty: Schema.Number,
    reasons: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "AtlasRoutingDecision" })

export const RoutingDecidePayload = Schema.Struct({
  surface: Schema.optionalKey(Schema.String),
  estimatedInputTokens: Schema.optionalKey(Schema.Number),
  estimatedOutputTokens: Schema.optionalKey(Schema.Number),
  fileCount: Schema.optionalKey(Schema.Number),
  requiresTools: Schema.optionalKey(Schema.Boolean),
  requiresStructuredOutput: Schema.optionalKey(Schema.Boolean),
  requiresVision: Schema.optionalKey(Schema.Boolean),
  requiresLongContext: Schema.optionalKey(Schema.Boolean),
  workspacePrivacy: Schema.optionalKey(Schema.Literals(["standard", "prefer_local", "local_only"])),
  explicitProviderID: Schema.optionalKey(Schema.String),
  explicitModelID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasRoutingDecideInput" })

export const RoutingPaths = {
  routingState: "/router/state",
  routingMode: "/router/mode",
  routingDecide: "/router/decide",
} as const

// ---- Project Brain -----------------------------------------------------------

export const BrainQueryPayload = Schema.Struct({
  query: Schema.String,
  kinds: Schema.optionalKey(Schema.Array(Schema.String)),
  includeHistorical: Schema.optionalKey(Schema.Boolean),
  maxItems: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: "AtlasBrainQueryInput" })

export const BrainMemoryInfo = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  content: Schema.String,
  status: Schema.String,
  authority: Schema.String,
  confidence: Schema.Number,
}).annotate({ identifier: "AtlasBrainMemory" })

export const BrainAnswer = Schema.Struct({
  text: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  sourceMemoryIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "AtlasBrainAnswer" })

export const BrainPaths = {
  brainQuery: "/orchestrator/projects/:projectID/brain/query",
  brainMemories: "/orchestrator/projects/:projectID/brain/memories",
} as const

// ---- Mission Control / Release Autopilot ---------------------------------------

const DiffstatSummaryInfo = Schema.Struct({
  additions: Schema.Number,
  deletions: Schema.Number,
  files: Schema.Number,
}).annotate({ identifier: "AtlasDiffstatSummary" })

export const FileDiffstatRow = Schema.Struct({
  path: Schema.String,
  /** Absent for binary files; git reports no line counts for them */
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
  binary: Schema.Boolean,
}).annotate({ identifier: "AtlasFileDiffstat" })

const MissionControlResponse = Schema.Struct({
  projectID: Schema.String,
  roadmapVersion: Schema.Number,
  roadmapStatus: Schema.String,
  totalTasks: Schema.Number,
  completeTasks: Schema.Number,
  failedTasks: Schema.Number,
  blockedTasks: Schema.Number,
  health: Schema.Literals(["healthy", "degraded", "recovering", "blocked"]),
  criticalPathLength: Schema.Number,
  /** Working-tree diffstat versus HEAD; omitted when the project has no workspace */
  diffstat: Schema.optionalKey(DiffstatSummaryInfo),
}).annotate({ identifier: "AtlasMissionControlSnapshot" })

export const ReleaseCheckResult = Schema.Struct({
  releaseID: Schema.String,
  status: Schema.Literals(["ready", "blocked"]),
  roadmapVersion: Schema.Number,
  gates: Schema.Array(Schema.Struct({
    gateID: Schema.String,
    label: Schema.String,
    status: Schema.Literals(["pass", "fail", "unknown", "skipped"]),
    required: Schema.Boolean,
  })),
}).annotate({ identifier: "AtlasReleaseCheckResult" })

export const MissionControlPaths = {
  missionControl: "/orchestrator/projects/:projectID/mission-control",
  releaseCheck: "/orchestrator/projects/:projectID/release/check",
  fileDiffstat: "/orchestrator/projects/:projectID/file-diffstat",
} as const

// ---- Supervisor ---------------------------------------------------------------

export const SupervisorHealthInfo = Schema.Struct({
  projectID: Schema.String,
  health: Schema.String,
  previousHealth: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasSupervisorHealth" })

export const SupervisorIncidentInfo = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  taskID: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  severity: Schema.String,
  status: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "AtlasSupervisorIncident" })

export const SupervisorPaths = {
  supervisorHealth: "/supervisor/:projectID/health",
  supervisorIncidents: "/supervisor/:projectID/incidents",
  supervisorIncident: "/supervisor/:projectID/incidents/:incidentID",
} as const

// ---- Project orchestrator ----------------------------------------------------

export const OrchestratorCreatePayload = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  priorities: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "AtlasOrchestratorCreateInput" })

export const OrchestratorTaskInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals([
    "planned",
    "ready",
    "running",
    "blocked",
    "verifying",
    "complete",
    "failed",
    "cancelled",
  ]),
  dependencies: Schema.Array(Schema.String),
  acceptanceCriteria: Schema.Array(Schema.String),
  workerProfile: Schema.optionalKey(Schema.String),
  priority: Schema.Number,
  attempt: Schema.Number,
  maxAttempts: Schema.Number,
}).annotate({ identifier: "AtlasOrchestratorTask" })

export const OrchestratorRoadmap = Schema.Struct({
  version: Schema.Number,
  objectiveID: Schema.String,
  status: Schema.Literals(["planning", "executing", "verifying", "complete", "blocked", "cancelled"]),
  tasks: Schema.Array(OrchestratorTaskInfo),
}).annotate({ identifier: "AtlasOrchestratorRoadmap" })

export const OrchestratorProject = Schema.Struct({
  projectID: Schema.String,
  objective: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    description: Schema.String,
    acceptanceCriteria: Schema.Array(Schema.String),
  }),
  roadmap: OrchestratorRoadmap,
  /** Canonical root project conversation session; auto-created/reconciled on open */
  rootSessionID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasOrchestratorProject" })

export const ProjectChatPayload = Schema.Struct({
  text: Schema.String,
}).annotate({ identifier: "AtlasProjectChatInput" })

export const ProjectChatResponse = Schema.Struct({
  intent: Schema.String,
  rootSessionID: Schema.String,
  instructionText: Schema.optionalKey(Schema.String),
  queryText: Schema.optionalKey(Schema.String),
  ideaText: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  instructionStatus: Schema.optionalKey(Schema.Literals(["queued", "superseded", "rejected"])),
}).annotate({ identifier: "AtlasProjectChatResult" })

export const OrchestratorPaths = {
  projects: "/orchestrator/projects",
  project: "/orchestrator/projects/:projectID",
  projectPlan: "/orchestrator/projects/:projectID/plan",
  projectStart: "/orchestrator/projects/:projectID/start",
  projectCancel: "/orchestrator/projects/:projectID/cancel",
  projectRoadmap: "/orchestrator/projects/:projectID/roadmap",
  projectChat: "/orchestrator/projects/:projectID/chat",
} as const

// ---- Project Control (Checkpoint / Pause / Resume) ---------------------------

export const ProjectCheckpointInfo = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  createdAt: Schema.Number,
  objectiveVersion: Schema.Number,
  roadmapVersion: Schema.Number,
  organizationVersion: Schema.optionalKey(Schema.Number),
  projectStatus: Schema.String,
  pauseState: Schema.optionalKey(Schema.String),
  activeWorkerCheckpoints: Schema.Array(Schema.Struct({
    workerID: Schema.String,
    taskID: Schema.String,
    taskRevision: Schema.Number,
    checkpointID: Schema.optionalKey(Schema.String),
  })),
  git: Schema.Struct({
    branch: Schema.optionalKey(Schema.String),
    head: Schema.optionalKey(Schema.String),
    base: Schema.optionalKey(Schema.String),
    dirty: Schema.optionalKey(Schema.Boolean),
    diffstat: Schema.optionalKey(Schema.Struct({ additions: Schema.Number, deletions: Schema.Number, files: Schema.Number })),
  }),
  brain: Schema.Struct({
    memoryCount: Schema.optionalKey(Schema.Number),
    latestMemoryTimestamp: Schema.optionalKey(Schema.Number),
    snapshotRef: Schema.optionalKey(Schema.String),
  }),
  verification: Schema.Struct({
    completedTaskIDs: Schema.Array(Schema.String),
    failedTaskIDs: Schema.Array(Schema.String),
    blockedTaskIDs: Schema.Array(Schema.String),
  }),
  openIncidentIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "AtlasProjectCheckpoint" })

export const ProjectControlStateInfo = Schema.Struct({
  status: Schema.Literals(["running", "pausing", "paused", "resuming"]),
  mode: Schema.optionalKey(Schema.Literals(["stop_scheduling_only", "finish_current_safe_step", "checkpoint_and_stop_workers"])),
  requestedAt: Schema.optionalKey(Schema.Number),
  pausedAt: Schema.optionalKey(Schema.Number),
  checkpointID: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasProjectControlState" })

export const PausePayload = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["stop_scheduling_only", "finish_current_safe_step", "checkpoint_and_stop_workers"])),
  reason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "AtlasPauseInput" })

export const ProjectControlPaths = {
  checkpoint: "/orchestrator/projects/:projectID/checkpoint",
  checkpoints: "/orchestrator/projects/:projectID/checkpoints",
  checkpointByID: "/orchestrator/projects/:projectID/checkpoints/:checkpointID",
  pause: "/orchestrator/projects/:projectID/pause",
  resume: "/orchestrator/projects/:projectID/resume",
  controlState: "/orchestrator/projects/:projectID/control-state",
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
  ...RoutingPaths,
  ...OrchestratorPaths,
  ...BrainPaths,
  ...MissionControlPaths,
  ...SupervisorPaths,
  ...ProjectControlPaths,
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
        HttpApiEndpoint.get("routingState", LocalAiPaths.routingState, {
          query: WorkspaceRoutingQuery,
          success: described(RoutingStateResponse, "Current intelligent-routing mode"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.routing.state",
            summary: "Get routing mode",
            description: "Returns the persisted Atlas routing mode (auto/local/hybrid/cloud).",
          }),
        ),
        HttpApiEndpoint.post("routingMode", LocalAiPaths.routingMode, {
          query: WorkspaceRoutingQuery,
          payload: RoutingModePayload,
          success: described(RoutingStateResponse, "Updated routing mode"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.routing.mode",
            summary: "Set routing mode",
            description:
              "Persists the routing mode. Manual concrete model selection still overrides routing for that request.",
          }),
        ),
        HttpApiEndpoint.post("routingDecide", LocalAiPaths.routingDecide, {
          query: WorkspaceRoutingQuery,
          payload: RoutingDecidePayload,
          success: described(RoutingDecisionResponse, "Routing decision with trace"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.routing.decide",
            summary: "Resolve execution path",
            description:
              "Runs the deterministic Atlas router over current local/cloud candidates and returns the selected provider/model with reason codes, alternatives, and a bounded fallback plan. Never executes inference.",
          }),
        ),
        HttpApiEndpoint.post("orchestratorProjects", LocalAiPaths.projects, {
          query: WorkspaceRoutingQuery,
          payload: OrchestratorCreatePayload,
          success: described(OrchestratorProject, "Created project"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.create",
            summary: "Create a project objective",
            description:
              "Registers a typed project objective (goal, acceptance criteria, constraints, priorities). Planning and execution are separate steps.",
          }),
        ),
        HttpApiEndpoint.get("orchestratorProject", LocalAiPaths.project, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OrchestratorProject, "Project with roadmap"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.get",
            summary: "Get project state",
            description: "Returns the persisted objective, roadmap IR, task states, artifacts and checkpoints.",
          }),
        ),
        HttpApiEndpoint.post("orchestratorPlan", LocalAiPaths.projectPlan, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OrchestratorRoadmap, "Validated roadmap"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.plan",
            summary: "Plan the project roadmap",
            description: "Decomposes the objective into validated roadmap IR with a dependency DAG.",
          }),
        ),
        HttpApiEndpoint.post("orchestratorStart", LocalAiPaths.projectStart, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Struct({ started: Schema.Boolean }), "Start accepted"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.start",
            summary: "Start roadmap execution",
            description:
              "Schedules workers over the dependency DAG with bounded concurrency. Workers execute as child sessions; models come from Atlas routing.",
          }),
        ),
        HttpApiEndpoint.post("orchestratorCancel", LocalAiPaths.projectCancel, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Cancellation accepted"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.cancel",
            summary: "Cancel a project",
            description:
              "Stops scheduling, cancels active workers, preserves checkpoints/artifacts, and marks remaining tasks cancelled.",
          }),
        ),
        HttpApiEndpoint.get("orchestratorRoadmap", LocalAiPaths.projectRoadmap, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OrchestratorRoadmap, "Project roadmap IR"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.roadmap",
            summary: "Get project roadmap",
            description: "Returns the versioned roadmap IR including per-task status and dependencies.",
          }),
        ),
        HttpApiEndpoint.post("orchestratorChat", LocalAiPaths.projectChat, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ProjectChatPayload,
          success: described(ProjectChatResponse, "Routed project conversation result"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.orchestrator.chat",
            summary: "Send a project conversation message",
            description:
              "Delivers a human message to the canonical root project conversation session and routes it by intent (question → Brain Q&A, instruction → Instruction Inbox, idea → Idea Ledger).",
          }),
        ),
        HttpApiEndpoint.post("brainQuery", LocalAiPaths.brainQuery, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: BrainQueryPayload,
          success: described(BrainAnswer, "Evidence-grounded project answer"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.brain.query",
            summary: "Query the Project Brain",
            description:
              "Retrieves evidence-grounded answers from the project brain with source citations. Deterministic status queries are answered without model invocation.",
          }),
        ),
        HttpApiEndpoint.get("brainMemories", LocalAiPaths.brainMemories, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(BrainMemoryInfo), "Project memories"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.brain.memories",
            summary: "List project memories",
            description: "Returns all persisted brain memory items for this project.",
          }),
        ),
        HttpApiEndpoint.get("missionControl", LocalAiPaths.missionControl, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MissionControlResponse, "Mission Control snapshot"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.missionControl.snapshot",
            summary: "Get Mission Control snapshot",
            description:
              "Aggregated read-only view of project health, task counts, critical path and roadmap state. Computed from authoritative subsystems.",
          }),
        ),
        HttpApiEndpoint.get("fileDiffstat", LocalAiPaths.fileDiffstat, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(FileDiffstatRow), "Working-tree file-by-file diffstat"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.missionControl.fileDiffstat",
            summary: "Get file-by-file diffstat",
            description:
              "Per-file additions/deletions of the current working tree versus HEAD, computed from real git numstat. Binary files report binary=true without line counts.",
          }),
        ),
        HttpApiEndpoint.post("releaseCheck", LocalAiPaths.releaseCheck, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ReleaseCheckResult, "Release readiness check result"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.release.check",
            summary: "Check release readiness",
            description:
              "Evaluates release gates against the current roadmap state. Ready only when all required gates pass with evidence.",
          }),
        ),
        HttpApiEndpoint.get("supervisorHealth", LocalAiPaths.supervisorHealth, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(SupervisorHealthInfo, "Supervisor health"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.supervisor.health",
            summary: "Get supervisor health",
            description: "Read-only supervisor health for a project. Does not emit events.",
          }),
        ),
        HttpApiEndpoint.get("supervisorIncidents", LocalAiPaths.supervisorIncidents, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SupervisorIncidentInfo), "Supervisor incidents"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.supervisor.incidents",
            summary: "List supervisor incidents",
            description: "Read-only list of supervisor incidents for a project. Does not emit events.",
          }),
        ),
        HttpApiEndpoint.get("supervisorIncident", LocalAiPaths.supervisorIncident, {
          params: { projectID: Schema.String, incidentID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(SupervisorIncidentInfo, "Supervisor incident"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.supervisor.incident",
            summary: "Get supervisor incident",
            description: "Read-only supervisor incident detail. Does not emit events.",
          }),
        ),
        HttpApiEndpoint.post("createCheckpoint", LocalAiPaths.checkpoint, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProjectCheckpointInfo, "Project checkpoint"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.checkpoint.create",
            summary: "Create project checkpoint",
            description: "Captures objective/roadmap versions, worker refs, git, brain and incidents into a persisted checkpoint and emits atlas.project.checkpoint.created.",
          }),
        ),
        HttpApiEndpoint.get("listCheckpoints", LocalAiPaths.checkpoints, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ProjectCheckpointInfo), "Project checkpoints"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.checkpoint.list",
            summary: "List project checkpoints",
            description: "Read-only list of persisted checkpoints. Does not emit events.",
          }),
        ),
        HttpApiEndpoint.get("getCheckpoint", LocalAiPaths.checkpointByID, {
          params: { projectID: Schema.String, checkpointID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProjectCheckpointInfo, "Project checkpoint"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.checkpoint.get",
            summary: "Get project checkpoint",
            description: "Read-only checkpoint detail. Does not emit events.",
          }),
        ),
        HttpApiEndpoint.post("pauseProject", LocalAiPaths.pause, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: PausePayload,
          success: described(ProjectControlStateInfo, "Project control state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.pause",
            summary: "Pause project",
            description: "Transitions project to paused via the selected mode and emits atlas.project.paused.",
          }),
        ),
        HttpApiEndpoint.post("resumeProject", LocalAiPaths.resume, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProjectControlStateInfo, "Project control state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.resume",
            summary: "Resume project",
            description: "Revalidates latest state, discards stale contracts and emits atlas.project.resumed.",
          }),
        ),
        HttpApiEndpoint.get("getControlState", LocalAiPaths.controlState, {
          params: { projectID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ProjectControlStateInfo, "Project control state"),
          error: LocalAiApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "atlas.project.control",
            summary: "Get project control state",
            description: "Read-only control state. Does not emit events.",
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
