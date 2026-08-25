import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LocalAI } from "@/localai/localai"
import { getManagedLlamaCppManager } from "@/localai/process-manager"
import { Provider } from "@/provider/provider"
import { RoutingEvent } from "@opencode-ai/schema/routing-event"
import { buildCloudCandidates, buildLocalCandidates } from "./candidates"
import { route } from "./route"
import { effectivePolicy, readRoutingPrefs, writeRoutingPrefs, type RoutingPrefsFile } from "./store"
import type { AtlasRoutingMode, PrivacyPolicy, RoutingCandidate, RoutingDecision, RoutingRequest } from "./types"

// The Router resolves provider/model identity only. Execution always flows
// through OpenCode's existing provider stack - this is a decision plane, not
// an inference stack.

export interface DecideInput {
  surface?: string
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  fileCount?: number
  requiresTools?: boolean
  requiresStructuredOutput?: boolean
  requiresVision?: boolean
  requiresLongContext?: boolean
  workspacePrivacy?: PrivacyPolicy
  explicitModel?: { providerID: string; modelID: string }
}

export interface Interface {
  readonly state: () => Effect.Effect<{ mode: AtlasRoutingMode; policy: ReturnType<typeof effectivePolicy> }>
  readonly setMode: (input: { mode: AtlasRoutingMode }) => Effect.Effect<AtlasRoutingMode>
  readonly setPolicy: (input: Partial<Omit<RoutingPrefsFile, "mode">>) => Effect.Effect<void>
  /** Evaluate a routing request against current live candidates */
  readonly decide: (input: DecideInput) => Effect.Effect<RoutingDecision>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AtlasRouter") {}

function mergePolicy(base: ReturnType<typeof effectivePolicy>, input: DecideInput): RoutingRequest["policy"] {
  return {
    ...base,
    ...(input.workspacePrivacy !== undefined ? { workspacePrivacy: input.workspacePrivacy } : {}),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const localai = yield* LocalAI.Service
    const providers = yield* Provider.Service
    const bridge = yield* EventV2Bridge.Service

    const state = Effect.fn("AtlasRouter.state")(function* () {
      const prefs = yield* Effect.promise(readRoutingPrefs)
      return { mode: prefs.mode ?? "auto", policy: effectivePolicy(prefs) }
    })

    const setMode = Effect.fn("AtlasRouter.setMode")(function* (input: { mode: AtlasRoutingMode }) {
      const prefs = yield* Effect.promise(readRoutingPrefs)
      yield* Effect.promise(() => writeRoutingPrefs({ ...prefs, mode: input.mode }))
      return input.mode
    })

    const setPolicy = Effect.fn("AtlasRouter.setPolicy")(function* (input: Partial<Omit<RoutingPrefsFile, "mode">>) {
      const prefs = yield* Effect.promise(readRoutingPrefs)
      yield* Effect.promise(() => writeRoutingPrefs({ ...prefs, ...input }))
    })

    const decide = Effect.fn("AtlasRouter.decide")(function* (input: DecideInput) {
      const prefs = yield* Effect.promise(readRoutingPrefs)
      const policy = mergePolicy(effectivePolicy(prefs), input)

      let candidates: RoutingCandidate[] = []
      if (policy.mode !== "cloud") {
        // Local candidates come from the live Local AI snapshot
        const aiState = yield* localai.state()
        const manager = getManagedLlamaCppManager()
        const artifacts = manager.getArtifacts()
        const lifecycleFor = (_runtimeID: string, runtimeModelID: string): "warm" | "cold" | "not_installed" => {
          for (const instance of manager.listInstances()) {
            if (instance.state !== "running") continue
            const artifact = artifacts.find((entry) => entry.id === instance.artifactID)
            if (!artifact) continue
            if (
              artifact.displayName === runtimeModelID ||
              runtimeModelID.endsWith(artifact.displayName) ||
              runtimeModelID.includes(artifact.displayName)
            ) {
              return "warm"
            }
          }
          return "cold"
        }
        candidates.push(...buildLocalCandidates({ state: aiState, lifecycleFor }))
      }
      if (policy.allowCloud && policy.mode !== "local") {
        const providerList = yield* providers.list()
        const connected = Object.entries(providerList)
          .filter(([, info]) => info.key !== undefined && info.key !== "local")
          .map(([id]) => id)
        candidates.push(...buildCloudCandidates(providerList, { connectedProviders: connected }))
      }

      const request: RoutingRequest = {
        surface: input.surface ?? "unknown",
        estimatedInputTokens: input.estimatedInputTokens,
        estimatedOutputTokens: input.estimatedOutputTokens,
        fileCount: input.fileCount,
        requiresTools: input.requiresTools,
        requiresStructuredOutput: input.requiresStructuredOutput,
        requiresVision: input.requiresVision,
        requiresLongContext: input.requiresLongContext,
        workspacePrivacy: input.workspacePrivacy,
        explicitModel: input.explicitModel,
        policy,
      }

      const decision = route(request, candidates)

      if (!decision.bypassed && decision.selected) {
        yield* bridge
          .publish(RoutingEvent.Decision, {
            mode: decision.mode,
            source: decision.selected.source,
            providerID: decision.selected.providerID,
            modelID: decision.selected.modelID,
            runtimeID: decision.selected.runtimeID,
            bypassed: false,
            confidence: decision.confidence,
            reasonCodes: decision.reasons.map((reason) => reason.code),
            ...(decision.estimatedCloudCost !== undefined ? { estimatedCloudCost: decision.estimatedCloudCost } : {}),
          })

      }

      return decision
    })

    return Service.of({ state, setMode, setPolicy, decide })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [LocalAI.node, Provider.node, EventV2Bridge.node],
})

export * as AtlasRouter from "."
