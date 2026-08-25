import { Effect } from "effect"
import type { EventV2Bridge } from "@/event-v2-bridge"
import {
  ArtifactChanged,
  BenchmarkStatus,
  ExecutableChanged,
  HealthChanged,
  InstallStatus,
  Lifecycle as InstanceLifecycle,
  InstanceLog,
  ProviderChanged,
  ReadinessStatus,
} from "@opencode-ai/schema/localai-event"

// Thin sync-friendly facade over EventV2Bridge for Local AI producers. The
// process manager and health watcher are plain async code, so emissions are
// fire-and-forget: a failing publish must never break a lifecycle transition.

export type LocalAiEventSink = ReturnType<typeof createLocalAiEventPublisher>

type Bridge = typeof EventV2Bridge.Service.Service

function emit<A extends Parameters<Bridge["publish"]>>(bridge: Bridge, ...args: A) {
  void Effect.runPromise(bridge.publish(args[0]!, args[1]!) as Effect.Effect<unknown>).catch(() => {})
}

export function createLocalAiEventPublisher(bridge: Bridge) {
  return {
    instanceLifecycle(input: {
      runtimeID: string
      instanceID: string
      artifactID?: string
      state:
        | "starting"
        | "running"
        | "stopping"
        | "stopped"
        | "crashed"
        | "failed"
      phase?: "port_selected" | "spawning" | "loading_model" | "health_wait" | "ready" | "cancelled"
      generation: number
      exitCode?: number
      reason?: string
      stderrTail?: string[]
    }) {
      emit(
        bridge,
        InstanceLifecycle,
        {
          runtimeID: input.runtimeID,
          instanceID: input.instanceID,
          state: input.state,
          generation: input.generation,
          ...(input.artifactID ? { artifactID: input.artifactID } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.stderrTail ? { stderrTail: input.stderrTail } : {}),
        },
      )
    },

    instanceLogs(
      runtimeID: string,
      instanceID: string,
      lines: { at: number; source: "stdout" | "stderr"; line: string }[],
    ) {
      if (lines.length === 0) return
      emit(bridge, InstanceLog, { runtimeID, instanceID, lines })
    },

    healthChanged(runtimeID: string, health: "available" | "unavailable" | "degraded" | "unsupported", detail?: string) {
      emit(bridge, HealthChanged, { runtimeID, health, ...(detail ? { detail } : {}) })
    },

    artifactChanged(artifactID: string, change: "registered" | "removed" | "file_missing" | "file_restored") {
      emit(bridge, ArtifactChanged, { artifactID, change })
    },

    executableChanged(found: boolean, path?: string, reason?: string) {
      emit(bridge, ExecutableChanged, { found, ...(path ? { path } : {}), ...(reason ? { reason } : {}) })
    },

    benchmarkStatus(input: {
      runtimeID: string
      modelID: string
      status: "started" | "completed" | "failed" | "cancelled"
      tokensPerSecond?: number
      promptTokensPerSecond?: number
      timeToFirstTokenMs?: number
      error?: string
    }) {
      emit(bridge, BenchmarkStatus, input)
    },

    readinessStatus(input: {
      runtimeID: string
      modelID: string
      status: "started" | "check_completed" | "completed" | "failed" | "cancelled"
      check?: { id: string; label: string; pass: boolean }
      score?: number
      error?: string
    }) {
      emit(bridge, ReadinessStatus, input)
    },

    installStatus(input: {
      jobID: string
      runtimeID?: string
      runtimeModelID?: string
      status: "started" | "progress" | "verifying" | "completed" | "cancelled" | "failed"
      percent?: number
      message?: string
      error?: string
    }) {
      emit(bridge, InstallStatus, input)
    },

    providerChanged(runtimeID: string, available: boolean, endpoint?: string) {
      emit(bridge, ProviderChanged, { runtimeID, available, ...(endpoint ? { endpoint } : {}) })
    },
  }
}
