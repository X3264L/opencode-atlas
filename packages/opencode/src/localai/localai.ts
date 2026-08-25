import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { detectHardware, type HardwareProfile } from "./hardware"
import { LOCAL_MODEL_CATALOG, findCatalogProfile, findCatalogVariant, variantRuntimeTag } from "./catalog"
import { recommendModels, type ModelRecommendation, type RecommendationPreset } from "./recommend"
import type { LocalInstalledModel, RuntimeDetectionResult } from "./runtime-types"
import { createOllamaAdapter } from "./runtime/ollama"
import { createLMStudioAdapter } from "./runtime/lmstudio"
import { runReadinessTest, type ReadinessResult } from "./readiness"
import type { ModelBenchmark } from "./runtime-types"
import { checkDiskSpace, resolveOllamaModelsDir } from "./disk"

const HARDWARE_CACHE_TTL_MS = 5 * 60_000

export interface InstallJob {
  id: string
  kind: "install" | "benchmark" | "readiness"
  modelID?: string
  /** Runtime identifier this job operates on (variant-specific for installs) */
  runtimeTag?: string
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

export interface LocalAiState {
  hardware: HardwareProfile
  runtimes: RuntimeDetectionResult[]
  installed: Record<string, LocalInstalledModel[]>
  recommendations: ModelRecommendation[]
  benchmarks: Record<string, ModelBenchmark>
  readiness: Record<string, { score: number; testedAt: number }>
}

export interface Interface {
  readonly hardware: (options?: { refresh?: boolean }) => Effect.Effect<HardwareProfile>
  readonly state: (preset?: RecommendationPreset) => Effect.Effect<LocalAiState>
  readonly install: (input: { profileID: string; variantID?: string }) => Effect.Effect<InstallJob, InstallError>
  readonly remove: (input: { modelID: string }) => Effect.Effect<boolean, InstallError>
  readonly startBenchmark: (input: { modelID: string }) => Effect.Effect<InstallJob, InstallError>
  readonly startReadiness: (input: { modelID: string }) => Effect.Effect<InstallJob, InstallError>
  readonly job: (jobID: string) => Effect.Effect<InstallJob | undefined>
  readonly cancel: (jobID: string) => Effect.Effect<boolean>
}

export class InstallError extends Error {}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocalAI") {}

type LegacyBenchmarksFile = Record<string, Record<string, ModelBenchmark>>
interface BenchmarksFile {
  benchmarks?: Record<string, Record<string, ModelBenchmark>>
  readiness?: Record<string, Record<string, { score: number; testedAt: number }>>
}

function benchmarkFilePath() {
  return path.join(Global.Path.state, "localai-benchmarks.json")
}

async function readStore(): Promise<BenchmarksFile> {
  try {
    const raw = await Bun.file(benchmarkFilePath()).json()
    // Migrate the pre-quantization format which stored benchmarks directly
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if ("benchmarks" in raw || "readiness" in raw) return raw as BenchmarksFile
      const legacy = raw as LegacyBenchmarksFile
      if (!legacy["benchmarks"] && !legacy["readiness"]) {
        return { benchmarks: legacy }
      }
    }
    return {}
  } catch {
    return {}
  }
}

async function writeStore(file: BenchmarksFile) {
  try {
    await Bun.write(benchmarkFilePath(), JSON.stringify(file, null, 2))
  } catch {}
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let cachedHardware: HardwareProfile | undefined
    let cachedAt = 0
    const jobs = new Map<string, JobExecution>()

    const ollama = createOllamaAdapter()
    const lmstudio = createLMStudioAdapter()

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
    function newJob(kind: InstallJob["kind"], modelID?: string, runtimeTag?: string): InstallJob {
      jobCounter += 1
      return {
        id: `${kind}-${Date.now().toString(36)}-${jobCounter}`,
        kind,
        ...(modelID !== undefined ? { modelID } : {}),
        ...(runtimeTag !== undefined ? { runtimeTag } : {}),
        state: "running",
        startedAt: Date.now(),
      }
    }

    async function detectRuntimes(): Promise<RuntimeDetectionResult[]> {
      return Promise.all([ollama.detect(), lmstudio.detect()])
    }

    async function listInstalled(): Promise<Record<string, LocalInstalledModel[]>> {
      const detections = await Promise.all([
        ollama.detect().then((detection) => detection.available),
        lmstudio.detect().then((detection) => detection.available),
      ])
      const results: Record<string, LocalInstalledModel[]> = {}
      await Promise.all([
        detections[0]
          ? ollama
              .listModels()
              .then((models) => {
                results["ollama"] = models
              })
              .catch(() => {})
          : Promise.resolve(),
        detections[1]
          ? lmstudio
              .listModels()
              .then((models) => {
                results["lmstudio"] = models
              })
              .catch(() => {})
          : Promise.resolve(),
      ])
      return results
    }

    const hardware = Effect.fn("LocalAI.hardware")(function* (options?: { refresh?: boolean }) {
      const fresh = cachedHardware && !options?.refresh && Date.now() - cachedAt < HARDWARE_CACHE_TTL_MS
      if (fresh) return cachedHardware!
      const profile = yield* Effect.promise(() => detectHardware())
      cachedHardware = profile
      cachedAt = Date.now()
      return profile
    })

    const state = Effect.fn("LocalAI.state")(function* (preset?: RecommendationPreset) {
      const profile = yield* hardware()
      const [runtimes, installed, store] = yield* Effect.all([
        Effect.promise(detectRuntimes),
        Effect.promise(listInstalled).pipe(Effect.catch(() => Effect.succeed({} as Record<string, LocalInstalledModel[]>))),
        Effect.promise(readStore),
      ])
      const installedTags = new Set((installed["ollama"] ?? []).map((model) => model.id))
      const benchmarkEntries = Object.entries(store.benchmarks?.["ollama"] ?? {}).filter(
        ([, benchmark]) => benchmark.success && benchmark.tokensPerSecond,
      )
      const recommendations = recommendModels({
        hardware: profile,
        profiles: LOCAL_MODEL_CATALOG,
        installedTags,
        preset,
        measuredTokensPerSecond: new Map(benchmarkEntries.map(([tag, benchmark]) => [tag, benchmark.tokensPerSecond!])),
        readinessScores: new Map(
          Object.entries(store.readiness?.["ollama"] ?? {})
            .filter(([, entry]) => typeof entry.score === "number")
            .map(([tag, entry]) => [tag, entry.score]),
        ),
      })
      return {
        hardware: profile,
        runtimes,
        installed,
        recommendations,
        benchmarks: store.benchmarks?.["ollama"] ?? {},
        readiness: store.readiness?.["ollama"] ?? {},
      }
    })

    const install = Effect.fn("LocalAI.install")(function* (input: { profileID: string; variantID?: string }) {
      const profile = findCatalogProfile(input.profileID)
      if (!profile) return yield* Effect.fail(new InstallError(`Unknown model: ${input.profileID}`))
      const variant = findCatalogVariant(profile, input.variantID)
      const tag = variantRuntimeTag(profile, variant)
      if (!tag) return yield* Effect.fail(new InstallError(`No Ollama package for ${profile.name}`))

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
      const job = newJob("install", tag, tag)
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
      yield* Effect.promise(() => ollama.removeModel!(input.modelID)).pipe(
        Effect.catch(() => Effect.fail(new InstallError(`Failed to remove ${input.modelID}`))),
      )
      return true
    })

    const startBenchmark = Effect.fn("LocalAI.startBenchmark")(function* (input: { modelID: string }) {
      const detection = yield* Effect.promise(() => ollama.detect())
      if (!detection.available) {
        return yield* Effect.fail(new InstallError("Ollama is not running"))
      }
      const controller = new AbortController()
      const job = newJob("benchmark", input.modelID, input.modelID)
      return yield* Effect.sync(() =>
        startJob(job, { controller }, async (current) => {
          current.status = "Generating sample output..."
          const benchmark = await ollama.benchmarkModel!(input.modelID, { signal: controller.signal })
          const store = await readStore()
          const runtime = { ...(store.benchmarks?.["ollama"] ?? {}) }
          runtime[input.modelID] = benchmark
          await writeStore({
            ...store,
            benchmarks: { ...store.benchmarks, ollama: runtime },
          })
          current.result = benchmark
          if (!benchmark.success) throw new Error(benchmark.error ?? "Benchmark failed")
        }),
      )
    })

    const startReadiness = Effect.fn("LocalAI.startReadiness")(function* (input: { modelID: string }) {
      const detection = yield* Effect.promise(() => ollama.detect())
      if (!detection.available) {
        return yield* Effect.fail(new InstallError("Ollama is not running"))
      }
      const job = newJob("readiness", input.modelID, input.modelID)
      return yield* Effect.sync(() =>
        startJob(job, {}, async (current) => {
          current.status = "Testing agent compatibility..."
          const readiness: ReadinessResult = await runReadinessTest(input.modelID, {
            endpoint: ollama.endpoint!,
          })
          if (!readiness.success) throw new Error(readiness.error ?? "Readiness test failed")
          const store = await readStore()
          const runtime = { ...(store.readiness?.["ollama"] ?? {}) }
          runtime[input.modelID] = { score: readiness.score, testedAt: readiness.testedAt }
          await writeStore({
            ...store,
            readiness: { ...store.readiness, ollama: runtime },
          })
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

    return Service.of({
      hardware,
      state,
      install,
      remove,
      startBenchmark,
      startReadiness,
      job: getJob,
      cancel,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer.pipe(Layer.orDie), deps: [] })

export * as LocalAI from "./localai"

