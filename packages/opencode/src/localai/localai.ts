import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { detectHardware, type HardwareProfile } from "./hardware"
import { LOCAL_MODEL_CATALOG, findCatalogProfile, findCatalogVariant, variantRuntimeTag } from "./catalog"
import { recommendModels, type ModelRecommendation, type RecommendationPreset } from "./recommend"
import type {
  LocalInstalledModel,
  LocalRuntimeAdapter,
  ModelBenchmark,
  RuntimeCapabilities,
  RuntimeDetectionResult,
  RuntimeHealth,
} from "./runtime-types"
import { detectAllRuntimes, getRuntimeAdapter } from "./runtime-registry"
import { matchCatalogVariant, normalizeInstances, type RuntimeModelInstance } from "./identity"
import {
  chooseRuntime,
  RUNTIME_PREFERENCES,
  type RuntimeCandidate,
  type RuntimePreference,
} from "./runtime-choice"
import type { ModelVariant } from "./catalog"
import type { ReadinessResult } from "./readiness"
import { checkDiskSpace, resolveOllamaModelsDir } from "./disk"

const HARDWARE_CACHE_TTL_MS = 5 * 60_000

export interface InstallJob {
  id: string
  kind: "install" | "benchmark" | "readiness"
  modelID?: string
  /** Runtime identifier this job operates on (variant-specific for installs) */
  runtimeTag?: string
  runtimeID?: string
  state: "running" | "done" | "error" | "cancelled"
  status?: string
  percent?: number
  error?: string
  result?: unknown
  startedAt: number
}

export function isAbortError(error: unknown) {
  return error instanceof Error && (error as DOMException).name === "AbortError"
}

/** Map a job failure to its terminal state - aborts mean cancelled, not broken. */
export function classifyJobFailure(error: unknown): "cancelled" | "error" {
  return isAbortError(error) ? "cancelled" : "error"
}

export interface RuntimeStatus extends RuntimeDetectionResult {
  capabilities: RuntimeCapabilities
  health: RuntimeHealth
  modelCount: number
}

export interface ReadinessSummary {
  score: number
  testedAt: number
  toolCalling?: boolean
}

/** Cross-runtime view for one logical model instance */
export interface NormalizedModelGroup {
  key: string
  modelID?: string
  variantID?: string
  label: string
  instances: { runtimeID: string; runtimeModelID: string; quantization?: string }[]
}

export interface LocalAiState {
  hardware: HardwareProfile
  runtimes: RuntimeStatus[]
  installed: Record<string, LocalInstalledModel[]>
  recommendations: ModelRecommendation[]
  /** Benchmark results keyed [runtimeID][runtimeModelID] */
  benchmarks: Record<string, Record<string, ModelBenchmark>>
  readiness: Record<string, Record<string, ReadinessSummary>>
  preference: RuntimePreference
  normalized: NormalizedModelGroup[]
}

type ReadinessAdapter = LocalRuntimeAdapter & {
  probeReadiness?(modelID: string, options?: { signal?: AbortSignal }): Promise<ReadinessResult>
}

export interface Interface {
  readonly hardware: (options?: { refresh?: boolean }) => Effect.Effect<HardwareProfile>
  readonly state: (preset?: RecommendationPreset) => Effect.Effect<LocalAiState>
  readonly install: (input: { profileID: string; variantID?: string }) => Effect.Effect<InstallJob, InstallError>
  readonly remove: (input: { modelID: string }) => Effect.Effect<boolean, InstallError>
  readonly startBenchmark: (input: { modelID: string; runtimeID?: string }) => Effect.Effect<InstallJob, InstallError>
  readonly startReadiness: (input: { modelID: string; runtimeID?: string }) => Effect.Effect<InstallJob, InstallError>
  readonly job: (jobID: string) => Effect.Effect<InstallJob | undefined>
  readonly cancel: (jobID: string) => Effect.Effect<boolean>
  readonly setPreference: (input: { runtime: RuntimePreference }) => Effect.Effect<RuntimePreference, InstallError>
}

export class InstallError extends Error {}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocalAI") {}

interface AtlasStoreFile {
  benchmarks?: Record<string, Record<string, ModelBenchmark>>
  readiness?: Record<string, Record<string, ReadinessSummary>>
  preferences?: { runtime?: RuntimePreference }
}

function storeFilePath() {
  return path.join(Global.Path.state, "localai-benchmarks.json")
}

async function readStore(): Promise<AtlasStoreFile> {
  try {
    const raw = await Bun.file(storeFilePath()).json()
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AtlasStoreFile
    return {}
  } catch {
    return {}
  }
}

async function writeStore(file: AtlasStoreFile) {
  try {
    await Bun.write(storeFilePath(), JSON.stringify(file, null, 2))
  } catch {}
}

function successfulBenchmarks(record: Record<string, ModelBenchmark> | undefined): Record<string, ModelBenchmark> {
  if (!record) return {}
  return Object.fromEntries(Object.entries(record).filter(([, benchmark]) => benchmark.success && benchmark.tokensPerSecond))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let cachedHardware: HardwareProfile | undefined
    let cachedAt = 0
    const jobs = new Map<string, JobExecution>()

    interface JobExecution {
      info: InstallJob
      controller?: AbortController
    }

    function startJob(job: InstallJob, options: { controller?: AbortController }, run: (job: InstallJob) => Promise<void>) {
      jobs.set(job.id, { info: job, ...(options.controller ? { controller: options.controller } : {}) })
      void run(job)
        .then(() => {
          if (jobs.has(job.id)) {
            jobs.set(job.id, {
              info: { ...job, state: "done", status: undefined, percent: undefined },
              ...(options.controller ? { controller: options.controller } : {}),
            })
          }
        })
        .catch((error) => {
          if (!jobs.has(job.id)) return
          if (classifyJobFailure(error) === "cancelled") {
            jobs.set(job.id, {
              info: {
                ...job,
                state: "cancelled",
                status: "Cancelled",
                percent: undefined,
              },
              ...(options.controller ? { controller: options.controller } : {}),
            })
            return
          }
          jobs.set(job.id, {
            info: {
              ...job,
              state: "error",
              error: error instanceof Error ? error.message : String(error),
            },
            ...(options.controller ? { controller: options.controller } : {}),
          })
        })
      return job
    }

    let jobCounter = 0
    function newJob(kind: InstallJob["kind"], fields: { modelID?: string; runtimeTag?: string; runtimeID?: string }): InstallJob {
      jobCounter += 1
      return {
        id: `${kind}-${Date.now().toString(36)}-${jobCounter}`,
        kind,
        ...(fields.modelID !== undefined ? { modelID: fields.modelID } : {}),
        ...(fields.runtimeTag !== undefined ? { runtimeTag: fields.runtimeTag } : {}),
        ...(fields.runtimeID !== undefined ? { runtimeID: fields.runtimeID } : {}),
        state: "running",
        startedAt: Date.now(),
      }
    }

    async function listInstalledPerRuntime(available: LocalRuntimeAdapter[]): Promise<Record<string, LocalInstalledModel[]>> {
      const entries = await Promise.all(
        available.map(async (adapter): Promise<[string, LocalInstalledModel[]] | undefined> => {
          try {
            return [adapter.id, await adapter.listModels()]
          } catch {
            return undefined
          }
        }),
      )
      return Object.fromEntries(entries.filter((entry): entry is [string, LocalInstalledModel[]] => entry !== undefined))
    }

    const hardware = Effect.fn("LocalAI.hardware")(function* (options?: { refresh?: boolean }) {
      const fresh = cachedHardware && !options?.refresh && Date.now() - cachedAt < HARDWARE_CACHE_TTL_MS
      if (fresh) return cachedHardware!
      const profile = yield* Effect.promise(() => detectHardware())
      cachedHardware = profile
      cachedAt = Date.now()
      return profile
    })

    // Resolves the concrete runtime model id serving a catalog variant on a
    // runtime. Ollama tags match exactly; other runtimes use strict identity
    // matching and stay unmatched when uncertain.
    function resolveInstanceID(
      adapter: LocalRuntimeAdapter,
      models: LocalInstalledModel[] | undefined,
      profile: ModelRecommendation["model"],
      variant: ModelVariant,
    ): string | undefined {
      if (!models?.length) return undefined
      if (adapter.id === "ollama") {
        return models.find((entry) => entry.id === variant.runtimeTag)?.id
      }
      const matched = models.find((entry) =>
        matchCatalogVariant({ id: entry.id, quantization: entry.quantization, parameterCount: entry.parameterCount }, profile, variant),
      )
      return matched?.id
    }

    const state = Effect.fn("LocalAI.state")(function* (preset?: RecommendationPreset) {
      const profile = yield* hardware()
      const detection = yield* Effect.promise(() => detectAllRuntimes())
      const installed = yield* Effect.promise(() => listInstalledPerRuntime(detection.available)).pipe(
        Effect.catch(() => Effect.succeed({} as Record<string, LocalInstalledModel[]>)),
      )
      const store = yield* Effect.promise(readStore)

      const runtimes: RuntimeStatus[] = yield* Effect.promise(() =>
        Promise.all(
          detection.all.map(async (adapter): Promise<RuntimeStatus> => {
            const detectionResult = detection.runtimes.find((entry) => entry.id === adapter.id)!
            const health =
              adapter.health !== undefined
                ? await adapter.health().catch(() => ({ state: "unavailable" as const }))
                : detectionResult.available
                  ? ({ state: "available" as const })
                  : ({ state: "unavailable" as const, detail: "not running" })
            return {
              ...detectionResult,
              capabilities: adapter.capabilities,
              health,
              modelCount: (installed[adapter.id] ?? []).length,
            }
          }),
        ),
      )

      const ollamaTags = new Set((installed["ollama"] ?? []).map((model) => model.id))
      const benchmarkEntries = Object.entries(successfulBenchmarks(store.benchmarks?.["ollama"])).filter(([tag]) =>
        ollamaTags.has(tag),
      )
      const readinessEntries = Object.entries(store.readiness?.["ollama"] ?? {}).filter(
        ([, entry]) => typeof entry.score === "number",
      )

      const baseRecommendations = recommendModels({
        hardware: profile,
        profiles: LOCAL_MODEL_CATALOG,
        installedTags: ollamaTags,
        preset,
        measuredTokensPerSecond: new Map(benchmarkEntries.map(([tag, benchmark]) => [tag, benchmark.tokensPerSecond!])),
        readinessScores: new Map(readinessEntries.map(([tag, entry]) => [tag, entry.score])),
      })

      const preference = store.preferences?.runtime ?? "auto"
      const upAdapters = new Set(detection.available.map((adapter) => adapter.id))

      // Evidence-based runtime choice for each recommendation's selected variant
      const recommendations: ModelRecommendation[] = baseRecommendations.map((recommendation) => {
        const candidates: RuntimeCandidate[] = detection.all
          .filter((adapter) => upAdapters.has(adapter.id))
          .flatMap((adapter) => {
            const models = installed[adapter.id]
            const instanceID = resolveInstanceID(adapter, models, recommendation.model, recommendation.variant)
            if (!instanceID) return []
            const benchmark = store.benchmarks?.[adapter.id]?.[instanceID]
            const readiness = store.readiness?.[adapter.id]?.[instanceID]
            return [
              {
                runtimeID: adapter.id,
                capabilities: adapter.capabilities,
                usable: true,
                installed: true,
                ...(benchmark?.success ? { benchmark } : {}),
                ...(readiness ? { readinessScore: readiness.score } : {}),
                ...(readiness?.toolCalling !== undefined ? { readinessToolCallingPass: readiness.toolCalling } : {}),
              },
            ]
          })
        const choice = chooseRuntime(candidates, {
          preference,
          ...(preset === "agent" ? { requireTools: true } : {}),
        })
        if (!choice.runtimeID) return recommendation
        return {
          ...recommendation,
          runtime: {
            id: choice.runtimeID,
            source: choice.source,
            reasons: choice.reasons.map((reason) => ({ kind: reason.kind, text: reason.text })),
          },
        }
      })

      // Group identical models across runtimes for the UI. Uncertain
      // identities stay separate instead of being merged.
      const instances: RuntimeModelInstance[] = Object.entries(installed).flatMap(([runtimeID, models]) =>
        models.map((model) => ({ runtimeID, runtimeModelID: model.id, model })),
      )
      const normalized: NormalizedModelGroup[] = normalizeInstances(instances).map((group) => {
        const profile = group.instances[0].modelID
          ? LOCAL_MODEL_CATALOG.find((entry) => entry.id === group.instances[0].modelID)
          : undefined
        return {
          key: group.key,
          ...(group.instances[0].modelID ? { modelID: group.instances[0].modelID } : {}),
          ...(group.instances[0].variantID ? { variantID: group.instances[0].variantID } : {}),
          label: profile?.name ?? group.instances[0].model.name,
          instances: group.instances.map((instance) => ({
            runtimeID: instance.runtimeID,
            runtimeModelID: instance.runtimeModelID,
            ...(instance.model.quantization ? { quantization: instance.model.quantization } : {}),
          })),
        }
      })

      return {
        hardware: profile,
        runtimes,
        installed,
        recommendations,
        benchmarks: Object.fromEntries(
          Object.entries(store.benchmarks ?? {}).map(([runtime, record]) => [runtime, successfulBenchmarks(record)]),
        ),
        readiness: Object.fromEntries(
          Object.entries(store.readiness ?? {}).map(([runtime, record]) => [
            runtime,
            Object.fromEntries(Object.entries(record).filter(([, entry]) => typeof entry.score === "number")),
          ]),
        ),
        preference,
        normalized,
      }
    })

    const install = Effect.fn("LocalAI.install")(function* (input: { profileID: string; variantID?: string }) {
      const profile = findCatalogProfile(input.profileID)
      if (!profile) return yield* Effect.fail(new InstallError(`Unknown model: ${input.profileID}`))
      const variant = findCatalogVariant(profile, input.variantID)
      const tag = variantRuntimeTag(profile, variant)
      if (!tag) return yield* Effect.fail(new InstallError(`No Ollama package for ${profile.name}`))

      const ollama = getRuntimeAdapter("ollama")
      if (!ollama?.installModel) return yield* Effect.fail(new InstallError("Ollama runtime is unavailable"))
      const detection = yield* Effect.promise(() => ollama.detect())
      if (!detection.available) {
        return yield* Effect.fail(new InstallError("Ollama is not running. Start it or install it from https://ollama.com"))
      }

      const disk = yield* Effect.promise(() =>
        checkDiskSpace({ directory: resolveOllamaModelsDir(), downloadBytes: variant.downloadSizeBytes }),
      )
      if (!disk.ok) {
        return yield* Effect.fail(new InstallError(disk.message ?? "Not enough free disk space"))
      }

      const controller = new AbortController()
      const job = newJob("install", { modelID: tag, runtimeTag: tag, runtimeID: "ollama" })
      return yield* Effect.sync(() =>
        startJob(job, { controller }, (current) =>
          ollama.installModel!(
            { id: tag },
            {
              signal: controller.signal,
              onProgress: (progress) => {
                current.status = progress.status
                current.percent = progress.percent
              },
            },
          ),
        ),
      )
    })

    const remove = Effect.fn("LocalAI.remove")(function* (input: { modelID: string }) {
      const removeModel = getRuntimeAdapter("ollama")?.removeModel
      if (!removeModel) return yield* Effect.fail(new InstallError("Ollama runtime is unavailable"))
      yield* Effect.promise(() => removeModel(input.modelID)).pipe(
        Effect.catch(() => Effect.fail(new InstallError(`Failed to remove ${input.modelID}`))),
      )
      return true
    })

    // Benchmarks/readiness target one runtime explicitly or default to the
    // first capable runtime.
    function resolveTargetRuntime(runtimeID: string | undefined, capability: "benchmarkModel" | "probeReadiness") {
      const adapters = createAllCached()
      if (runtimeID) {
        return adapters.find((adapter) => adapter.id === runtimeID && adapter[capability])
      }
      return adapters.find((adapter) => adapter[capability] !== undefined)
    }

    let cachedAdapters: LocalRuntimeAdapter[] | undefined
    function createAllCached(): ReadinessAdapter[] {
      if (!cachedAdapters) {
        cachedAdapters = [
          getRuntimeAdapter("ollama"),
          getRuntimeAdapter("lmstudio"),
          getRuntimeAdapter("llamacpp"),
          getRuntimeAdapter("mlx"),
        ].filter((adapter): adapter is LocalRuntimeAdapter => adapter !== undefined)
      }
      return cachedAdapters
    }

    const startBenchmark = Effect.fn("LocalAI.startBenchmark")(function* (input: { modelID: string; runtimeID?: string }) {
      const adapter = resolveTargetRuntime(input.runtimeID, "benchmarkModel")
      if (!adapter?.benchmarkModel) return yield* Effect.fail(new InstallError(`No benchmark-capable runtime${input.runtimeID ? `: ${input.runtimeID}` : ""}`))
      const detection = yield* Effect.promise(() => adapter.detect())
      if (!detection.available) {
        return yield* Effect.fail(new InstallError(`${adapter.name} is not running`))
      }
      const controller = new AbortController()
      const job = newJob("benchmark", { modelID: input.modelID, runtimeID: adapter.id })
      return yield* Effect.sync(() =>
        startJob(job, { controller }, async (current) => {
          current.status = "Generating sample output..."
          const benchmark = await adapter.benchmarkModel!(input.modelID, { signal: controller.signal })
          const store = await readStore()
          const runtime = { ...store.benchmarks?.[adapter.id] }
          runtime[input.modelID] = benchmark
          await writeStore({ ...store, benchmarks: { ...store.benchmarks, [adapter.id]: runtime } })
          current.result = benchmark
          if (!benchmark.success) throw new Error(benchmark.error ?? "Benchmark failed")
        }),
      )
    })

    const startReadiness = Effect.fn("LocalAI.startReadiness")(function* (input: { modelID: string; runtimeID?: string }) {
      const adapter = resolveTargetRuntime(input.runtimeID, "probeReadiness") as ReadinessAdapter | undefined
      if (!adapter?.probeReadiness) return yield* Effect.fail(new InstallError(`No readiness-capable runtime${input.runtimeID ? `: ${input.runtimeID}` : ""}`))
      const detection = yield* Effect.promise(() => adapter.detect())
      if (!detection.available) {
        return yield* Effect.fail(new InstallError(`${adapter.name} is not running`))
      }
      const job = newJob("readiness", { modelID: input.modelID, runtimeID: adapter.id })
      return yield* Effect.sync(() =>
        startJob(job, {}, async (current) => {
          current.status = "Testing agent compatibility..."
          const readiness: ReadinessResult = await adapter.probeReadiness!(input.modelID)
          if (!readiness.success) throw new Error(readiness.error ?? "Readiness test failed")
          const toolCheck = readiness.checks.find((check) => check.id === "tool-calling")
          const store = await readStore()
          const runtime = { ...store.readiness?.[adapter.id] }
          runtime[input.modelID] = {
            score: readiness.score,
            testedAt: readiness.testedAt,
            ...(toolCheck ? { toolCalling: toolCheck.pass } : {}),
          }
          await writeStore({ ...store, readiness: { ...store.readiness, [adapter.id]: runtime } })
          current.result = readiness
        }),
      )
    })

    const getJob = Effect.fn("LocalAI.job")((jobID: string) =>
      Effect.sync(() => {
        const execution = jobs.get(jobID)
        return execution?.info
      }),
    )

    const cancel = Effect.fn("LocalAI.cancel")((jobID: string) =>
      Effect.sync(() => {
        const execution = jobs.get(jobID)
        if (!execution || execution.info.state !== "running") return false
        execution.info.status = "Cancelling..."
        execution.controller?.abort(new DOMException("Cancelled by user", "AbortError"))
        return true
      }),
    )

    const setPreference = Effect.fn("LocalAI.setPreference")(function* (input: { runtime: RuntimePreference }) {
      if (!RUNTIME_PREFERENCES.includes(input.runtime)) {
        return yield* Effect.fail(new InstallError(`Unknown runtime preference: ${input.runtime}`))
      }
      const store = yield* Effect.promise(readStore)
      yield* Effect.promise(() =>
        writeStore({ ...store, preferences: { ...(store.preferences ?? {}), runtime: input.runtime } }),
      )
      return input.runtime
    })

    return Service.of({
      hardware,
      state,
      install,
      remove,
      startBenchmark,
      startReadiness,
      job: getJob,
      cancel,
      setPreference,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer.pipe(Layer.orDie), deps: [] })

export * as LocalAI from "./localai"
