import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { detectHardware, type HardwareProfile } from "./hardware"
import { LOCAL_MODEL_CATALOG, findCatalogProfile } from "./catalog"
import { recommendModels, type ModelRecommendation, type RecommendationPreset } from "./recommend"
import type { LocalInstalledModel, RuntimeDetectionResult } from "./runtime-types"
import { createOllamaAdapter } from "./runtime/ollama"
import { createLMStudioAdapter } from "./runtime/lmstudio"
import { runReadinessTest, type ReadinessResult } from "./readiness"
import type { ModelBenchmark } from "./runtime-types"

const HARDWARE_CACHE_TTL_MS = 5 * 60_000

export interface InstallJob {
  id: string
  kind: "install" | "benchmark" | "readiness"
  modelID?: string
  state: "running" | "done" | "error"
  status?: string
  percent?: number
  error?: string
  result?: unknown
  startedAt: number
}

export interface LocalAiState {
  hardware: HardwareProfile
  runtimes: RuntimeDetectionResult[]
  installed: Record<string, LocalInstalledModel[]>
  recommendations: ModelRecommendation[]
  benchmarks: Record<string, ModelBenchmark>
}

export interface Interface {
  readonly hardware: (options?: { refresh?: boolean }) => Effect.Effect<HardwareProfile>
  readonly state: (preset?: RecommendationPreset) => Effect.Effect<LocalAiState>
  readonly install: (input: { profileID: string; variantID?: string }) => Effect.Effect<InstallJob, InstallError>
  readonly remove: (input: { modelID: string }) => Effect.Effect<boolean, InstallError>
  readonly startBenchmark: (input: { modelID: string }) => Effect.Effect<InstallJob, InstallError>
  readonly startReadiness: (input: { modelID: string }) => Effect.Effect<InstallJob, InstallError>
  readonly job: (jobID: string) => Effect.Effect<InstallJob | undefined>
}

export class InstallError extends Error {}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocalAI") {}

type BenchmarksFile = Record<string, Record<string, ModelBenchmark>>

function benchmarkFilePath() {
  return path.join(Global.Path.state, "localai-benchmarks.json")
}

async function readBenchmarks(): Promise<BenchmarksFile> {
  try {
    return await Bun.file(benchmarkFilePath()).json()
  } catch {
    return {}
  }
}

async function writeBenchmarks(file: BenchmarksFile) {
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
    }

    function startJob(job: InstallJob, run: (job: InstallJob) => Promise<void>) {
      jobs.set(job.id, { info: job })
      void run(job)
        .then(() => {
          if (jobs.has(job.id)) {
            jobs.set(job.id, { info: { ...job, state: "done", status: undefined, percent: undefined } })
          }
        })
        .catch((error) => {
          if (jobs.has(job.id)) {
            jobs.set(job.id, {
              info: {
                ...job,
                state: "error",
                error: error instanceof Error ? error.message : String(error),
              },
            })
          }
        })
      return job
    }

    let jobCounter = 0
    function newJob(kind: InstallJob["kind"], modelID?: string): InstallJob {
      jobCounter += 1
      return {
        id: `${kind}-${Date.now().toString(36)}-${jobCounter}`,
        kind,
        ...(modelID !== undefined ? { modelID } : {}),
        state: "running",
        startedAt: Date.now(),
      }
    }

    async function detectRuntimes(): Promise<RuntimeDetectionResult[]> {
      return Promise.all([ollama.detect(), lmstudio.detect()])
    }

    async function listInstalled(): Promise<Record<string, LocalInstalledModel[]>> {
      const detections = await Promise.all([
        ollama.detect().then((d) => d.available),
        lmstudio.detect().then((d) => d.available),
      ])
      const results: Record<string, LocalInstalledModel[]> = {}
      await Promise.all([
        detections[0]
          ? ollama.listModels().then((models) => {
              results["ollama"] = models
            })
          : Promise.resolve(),
        detections[1]
          ? lmstudio.listModels().then((models) => {
              results["lmstudio"] = models
            })
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
      const [runtimes, installed, benchmarks] = yield* Effect.all([
        Effect.promise(detectRuntimes),
        Effect.promise(listInstalled).pipe(
          Effect.catch(() => Effect.succeed({} as Record<string, LocalInstalledModel[]>)),
        ),
        Effect.promise(readBenchmarks),
      ])
      const installedTags = new Set((installed["ollama"] ?? []).map((model) => model.id))
      const recommendations = recommendModels({
        hardware: profile,
        profiles: LOCAL_MODEL_CATALOG,
        installedTags,
        preset,
        measuredTokensPerSecond: benchmarks["ollama"]
          ? new Map(
              Object.entries(benchmarks["ollama"])
                .filter(([, benchmark]) => benchmark.success && benchmark.tokensPerSecond)
                .map(([modelID, benchmark]) => [modelID, benchmark.tokensPerSecond!]),
            )
          : undefined,
      })
      return { hardware: profile, runtimes, installed, recommendations, benchmarks: benchmarks["ollama"] ?? {} }
    })

    const install = Effect.fn("LocalAI.install")(function* (input: { profileID: string; variantID?: string }) {
      const profile = findCatalogProfile(input.profileID)
      if (!profile) return yield* Effect.fail(new InstallError(`Unknown model: ${input.profileID}`))
      const tag = profile.runtimes.ollama
      if (!tag) return yield* Effect.fail(new InstallError(`No Ollama package for ${profile.name}`))

      const detection = yield* Effect.promise(() => ollama.detect())
      if (!detection.available) {
        return yield* Effect.fail(
          new InstallError("Ollama is not running. Start it or install it from https://ollama.com"),
        )
      }

      const job = newJob("install", tag)
      return yield* Effect.sync(() =>
        startJob(job, (current) =>
          ollama.installModel!(
            { id: tag },
            {
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
      const job = newJob("benchmark", input.modelID)
      return yield* Effect.sync(() =>
        startJob(job, async (current) => {
          current.status = "Generating sample output..."
          const benchmark = await ollama.benchmarkModel!(input.modelID)
          const file = await readBenchmarks()
          file["ollama"] = { ...file["ollama"], [input.modelID]: benchmark }
          await writeBenchmarks(file)
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
      const job = newJob("readiness", input.modelID)
      return yield* Effect.sync(() =>
        startJob(job, async (current) => {
          current.status = "Testing agent compatibility..."
          const readiness: ReadinessResult = await runReadinessTest(input.modelID, {
            endpoint: ollama.endpoint!,
          })
          const file = await readBenchmarks()
          file["ollama"] = {
            ...file["ollama"],
            [input.modelID]: {
              success: readiness.success,
              tokensPerSecond: file["ollama"]?.[input.modelID]?.tokensPerSecond,
              testedAt: Date.now(),
              ...(readiness.score < 60 ? { error: "Readiness score low" } : {}),
            },
          }
          await writeBenchmarks(file)
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

    return Service.of({
      hardware,
      state,
      install,
      remove,
      startBenchmark,
      startReadiness,
      job: getJob,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer.pipe(Layer.orDie), deps: [] })

export * as LocalAI from "./localai"
