import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LocalAI } from "@/localai/localai"
import { InstanceHttpApi } from "../api"
import {
  InstallPayload,
  LocalAiApiError,
  ModelPayload,
  LocalAiStateQuery,
  PreferencePayload,
} from "../groups/localai"

export const localaiHandlers = HttpApiBuilder.group(InstanceHttpApi, "localai", (handlers) =>
  Effect.gen(function* () {
    const localai = yield* LocalAI.Service

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
  }),
)
