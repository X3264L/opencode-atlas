import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LocalAI } from "@/localai/localai"
import { AtlasRouter } from "@/router/index"
import { InstanceHttpApi } from "../api"
import {
  InstallPayload,
  LocalAiApiError,
  ModelPayload,
  LocalAiStateQuery,
  PreferencePayload,
  GgufRegisterPayload,
  ExecutablePathPayload,
} from "../groups/localai"

export const localaiHandlers = HttpApiBuilder.group(InstanceHttpApi, "localai", (handlers) =>
  Effect.gen(function* () {
    const localai = yield* LocalAI.Service
    const router = yield* AtlasRouter.Service

    const mapError = (error: unknown) =>
      new LocalAiApiError({
        name: error instanceof LocalAI.InstallError ? "LocalAiInstallError" : "LocalAiError",
        message: error instanceof Error ? error.message : String(error),
      })

    return handlers
      .handle("state", (ctx: { query: typeof LocalAiStateQuery.Type }) =>
        localai.state(ctx.query.preset).pipe(Effect.mapError(mapError)),
      )
      .handle("install", (ctx: { payload: typeof InstallPayload.Type }) =>
        localai
          .install({
            profileID: ctx.payload.profileID,
            ...(ctx.payload.variantID ? { variantID: ctx.payload.variantID } : {}),
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("remove", (ctx: { payload: typeof ModelPayload.Type }) =>
        localai.remove({ modelID: ctx.payload.modelID }).pipe(Effect.mapError(mapError)),
      )
      .handle("benchmark", (ctx: { payload: typeof ModelPayload.Type }) =>
        localai
          .startBenchmark({
            modelID: ctx.payload.modelID,
            ...(ctx.payload.runtimeID ? { runtimeID: ctx.payload.runtimeID } : {}),
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("readiness", (ctx: { payload: typeof ModelPayload.Type }) =>
        localai
          .startReadiness({
            modelID: ctx.payload.modelID,
            ...(ctx.payload.runtimeID ? { runtimeID: ctx.payload.runtimeID } : {}),
          })
          .pipe(Effect.mapError(mapError)),
      )
      .handle("job", (ctx: { params: { jobID: string } }) =>
        Effect.gen(function* () {
          const job = yield* localai.job(ctx.params.jobID)
          if (!job) {
            return yield* Effect.fail(
              new LocalAiApiError({ name: "LocalAiJobNotFound", message: `Unknown job: ${ctx.params.jobID}` }),
            )
          }
          return job
        }),
      )
      .handle("jobCancel", (ctx: { params: { jobID: string } }) => localai.cancel(ctx.params.jobID))
      .handle("preference", (ctx: { payload: typeof PreferencePayload.Type }) =>
        localai.setPreference({ runtime: ctx.payload.runtime }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedState", () => localai.managedState().pipe(Effect.mapError(mapError)))
      .handle("managedRegister", (ctx: { payload: typeof GgufRegisterPayload.Type }) =>
        localai.registerManagedArtifact({ path: ctx.payload.path }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedRemove", (ctx: { params: { artifactID: string } }) =>
        localai.removeManagedArtifact({ artifactID: ctx.params.artifactID }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedStart", (ctx: { params: { artifactID: string } }) =>
        localai.startManaged({ artifactID: ctx.params.artifactID }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedStop", (ctx: { params: { instanceID: string } }) =>
        localai.stopManaged({ instanceID: ctx.params.instanceID }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedRestart", (ctx: { params: { instanceID: string } }) =>
        localai.restartManaged({ instanceID: ctx.params.instanceID }).pipe(Effect.mapError(mapError)),
      )
      .handle("managedLogs", (ctx: { params: { instanceID: string } }) => localai.managedLogs({ instanceID: ctx.params.instanceID }))
      .handle("routingState", () => router.state().pipe(Effect.map(({ mode }) => ({ mode })), Effect.mapError(mapError)))
      .handle("routingMode", (ctx: { payload: { mode: "auto" | "local" | "hybrid" | "cloud" } }) =>
        router.setMode({ mode: ctx.payload.mode }).pipe(Effect.map((mode) => ({ mode })), Effect.mapError(mapError)),
      )
      .handle("routingDecide", (ctx: { payload: Record<string, unknown> }) =>
        router
          .decide({
            surface: typeof ctx.payload.surface === "string" ? ctx.payload.surface : undefined,
            estimatedInputTokens: typeof ctx.payload.estimatedInputTokens === "number" ? ctx.payload.estimatedInputTokens : undefined,
            estimatedOutputTokens: typeof ctx.payload.estimatedOutputTokens === "number" ? ctx.payload.estimatedOutputTokens : undefined,
            fileCount: typeof ctx.payload.fileCount === "number" ? ctx.payload.fileCount : undefined,
            requiresTools: ctx.payload.requiresTools === true,
            requiresStructuredOutput: ctx.payload.requiresStructuredOutput === true,
            requiresVision: ctx.payload.requiresVision === true,
            requiresLongContext: ctx.payload.requiresLongContext === true,
            workspacePrivacy: (typeof ctx.payload.workspacePrivacy === "string"
              ? (ctx.payload.workspacePrivacy as "standard" | "prefer_local" | "local_only")
              : undefined),
            explicitModel:
              typeof ctx.payload.explicitProviderID === "string" && typeof ctx.payload.explicitModelID === "string"
                ? { providerID: ctx.payload.explicitProviderID, modelID: ctx.payload.explicitModelID }
                : undefined,
          })
          .pipe(Effect.mapError(mapError)),
      )      .handle("managedExecutable", (ctx: { payload: typeof ExecutablePathPayload.Type }) =>
        localai
          .setLlamaServerExecutable({ ...(ctx.payload.path !== undefined ? { path: ctx.payload.path } : {}) })
          .pipe(
            Effect.andThen(localai.managedState()),
            Effect.mapError(mapError),
          ),
      )
  }),
)
