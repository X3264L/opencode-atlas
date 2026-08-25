import { createMemo, createSignal, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import type { JSX } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useEvent } from "../context/event"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import type {
  LocalAiJob,
  LocalAiManagedArtifact,
  LocalAiManagedLogs,
  LocalAiRecommendation,
  LocalAiState,
} from "@opencode-ai/sdk/v2/types"

type VariantEvaluation = LocalAiRecommendation["alternatives"][number]

const RUNTIME_NAMES: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  mlx: "MLX",
}

const PREFERENCE_CYCLE = ["auto", "ollama", "lmstudio", "llamacpp", "mlx"] as const

type Preset = NonNullable<Parameters<ReturnType<typeof useSDK>["client"]["localai"]["state"]>[0]>["preset"]

// Generated SDK types encode JSON numbers as number | "-Infinity" | "NaN";
// normalize before doing math or formatting on them.
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const PRESETS: { id: Exclude<Preset, undefined>; label: string }[] = [
  { id: "overall", label: "Best overall" },
  { id: "coding", label: "Best coding" },
  { id: "agent", label: "Best agent / tool calling" },
  { id: "speed", label: "Fastest" },
  { id: "memory", label: "Lowest memory" },
  { id: "context", label: "Longest context" },
]

function formatBytes(bytes: number | undefined) {
  if (!bytes) return "?"
  const gb = bytes / 1e9
  if (gb >= 100) return `${Math.round(gb)} GB`
  return `${gb.toFixed(1)} GB`
}

function formatContext(tokens: number | undefined) {
  if (!tokens) return "?"
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`
  return String(tokens)
}

function stars(score: number) {
  const filled = Math.max(1, Math.min(5, Math.round(score / 20)))
  return `${"★".repeat(filled)}${"☆".repeat(5 - filled)}`
}

const COMPATIBILITY_LABEL = {
  excellent: "Excellent fit",
  good: "Good fit",
  usable: "Usable",
  not_recommended: "Not recommended",
} as const

const OFFLOAD_LABEL = {
  none: "Fully in GPU memory",
  partial: "Partial CPU offload",
  heavy: "Heavy CPU offload",
  cpu_dominant: "Mostly running on CPU",
} as const

function runtimeStatusIcon(state: string | undefined, available: boolean) {
  if (state === "unsupported") return "—"
  return available ? "✓" : "○"
}

export function DialogLocalAi() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const event = useEvent()
  const [state, setState] = createSignal<LocalAiState>()
  const [managed, setManaged] = createSignal<LocalAiManagedArtifact[]>()
  const [executable, setExecutable] = createSignal<{ found: boolean; path?: string; reason?: string }>()
  const [error, setError] = createSignal<string>()
  const [presetIndex, setPresetIndex] = createSignal(0)

  const load = async (preset?: Preset) => {
    setError(undefined)
    try {
      const [result, managedResult] = await Promise.all([
        sdk.client.localai.state(preset ? { preset } : {}),
        sdk.client.localai.managed.state(),
      ])
      if (result.data) setState(result.data)
      else setError(result.error?.message ?? "Failed to detect local AI state")
      if (managedResult.data) {
        setManaged(managedResult.data.artifacts)
        setExecutable(managedResult.data.executable)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detect local AI state")
    }
  }

  onMount(() => void load(PRESETS[presetIndex()].id))
  const refresh = () => void load(PRESETS[presetIndex()].id)

  // Reactive control plane: lifecycle events patch managed rows in place;
  // anything broader triggers one coalesced authoritative refetch.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = () => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refresh()
    }, 250)
  }

  onMount(() => {
    const disposers = [
      event.on("localai.instance.lifecycle", (payload) => {
        const list = managed()
        if (!list) return
        const entry = list.find((item) => item.artifact.id === payload.properties.artifactID)
        if (!entry) {
          scheduleRefresh()
          return
        }
        const terminalOrRunning =
          payload.properties.state === "running" || ["stopped", "crashed", "failed"].includes(payload.properties.state)
        entry.instance =
          terminalOrRunning || payload.properties.state === "starting" || payload.properties.state === "stopping"
            ? {
                id: payload.properties.instanceID,
                artifactID: payload.properties.artifactID ?? entry.artifact.id,
                state: payload.properties.state,
                ...(entry.instance?.endpoint ? { endpoint: entry.instance.endpoint } : {}),
              }
            : undefined
        setManaged([...list])
      }),
      event.on("localai.managed.artifact", () => scheduleRefresh()),
      event.on("localai.health.changed", () => scheduleRefresh()),
      event.on("localai.executable.changed", () => scheduleRefresh()),
      event.on("localai.provider.changed", () => scheduleRefresh()),
    ]
    onCleanup(() => disposers.forEach((dispose) => dispose()))
  })

  const cyclePreset = async () => {
    const next = (presetIndex() + 1) % PRESETS.length
    setPresetIndex(next)
    await load(PRESETS[next].id)
  }

  const cyclePreference = async () => {
    const current = state()?.preference ?? "auto"
    const index = PREFERENCE_CYCLE.indexOf(current as (typeof PREFERENCE_CYCLE)[number])
    const next = PREFERENCE_CYCLE[(index + 1) % PREFERENCE_CYCLE.length]
    try {
      await sdk.client.localai.preference.set({ localAiPreferenceInput: { runtime: next } })
    } catch {}
    await load(PRESETS[presetIndex()].id)
  }

  const openRecommendation = (recommendation: LocalAiRecommendation) => {
    dialog.replace(() => <LocalAiModelDetails recommendation={recommendation} state={state()} onBack={refresh} />)
  }

  const importGguf = () => {
    dialog.replace(
      () => (
        <DialogPrompt
          title="Import GGUF"
          placeholder="C:\Models\Qwen-Coder-14B-Q6_K.gguf"
          onConfirm={(value) => {
            void (async () => {
              try {
                const result = await sdk.client.localai.managed.register({ localAiGgufRegisterInput: { path: value.trim() } })
                if (!result.data) throw new Error(result.error?.message ?? "Registration failed")
                dialog.replace(() => <DialogLocalAi />)
                await load(PRESETS[presetIndex()].id)
              } catch (e) {
                toast.show({
                  title: "Import failed",
                  message: e instanceof Error ? e.message : "Could not register the GGUF file",
                  variant: "error",
                })
                dialog.replace(() => <DialogLocalAi />)
              }
            })()
          }}
          onCancel={() => dialog.replace(() => <DialogLocalAi />)}
        />
      ),
    )
  }

  const configureExecutable = () => {
    dialog.replace(
      () => (
        <DialogPrompt
          title="llama-server path"
          placeholder="C:\Tools\llama.cpp\llama-server.exe"
          value={executable()?.path}
          onConfirm={(value) => {
            void (async () => {
              try {
                await sdk.client.localai.managed.executable({ localAiExecutablePathInput: value.trim() ? { path: value.trim() } : {} })
              } catch {}
              dialog.replace(() => <DialogLocalAi />)
              await load(PRESETS[presetIndex()].id)
            })()
          }}
          onCancel={() => dialog.replace(() => <DialogLocalAi />)}
        />
      ),
    )
  }

  const openManagedArtifact = (artifactID: string) => {
    const artifact = managed()?.find((entry) => entry.artifact.id === artifactID)
    if (!artifact) return
    dialog.replace(() => (
      <LocalAiManagedDetails
        artifact={artifact}
        executable={executable()}
        onRemoved={async () => {
          dialog.replace(() => <DialogLocalAi />)
          await load(PRESETS[presetIndex()].id)
        }}
        onLeave={async () => {
          await load(PRESETS[presetIndex()].id)
        }}
      />
    ))
  }

  const options = createMemo(() => {
    const value = state()
    const rows: {
      title: string
      description?: string
      category?: string
      value: object
      disabled?: boolean
      footer?: JSX.Element | string
      onSelect?: () => void
    }[] = []

    if (!value) {
      rows.push({ title: error() ?? "Detecting hardware...", value: {}, disabled: true })
      return rows
    }

    const gpu = value.hardware.gpus.map((gpu) => {
      const vram = num(gpu.vramBytes)
      return `${gpu.model}${vram ? ` · ${formatBytes(vram)}` : ""}`
    })
    rows.push(
      {
        title: "GPU",
        description: gpu.length > 0 ? gpu.join(", ") : "None detected",
        category: "Hardware",
        value: {},
        disabled: true,
      },
      {
        title: "RAM",
        description: formatBytes(num(value.hardware.memory.totalBytes)),
        category: "Hardware",
        value: {},
        disabled: true,
      },
      {
        title: "CPU",
        description:
          [
            value.hardware.cpu.model,
            num(value.hardware.cpu.logicalCores) ? `${num(value.hardware.cpu.logicalCores)} cores` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "Unknown",
        category: "Hardware",
        value: {},
        disabled: true,
      },
      {
        title: "Runtime",
        description:
          value.runtimes.filter((runtime) => runtime.available).length > 0
            ? value.runtimes
                .filter((runtime) => runtime.available)
                .map((runtime) => `${runtime.name}${runtime.detail ? ` (${runtime.detail})` : ""}`)
                .join(", ")
            : "No local runtime detected",
        category: "Hardware",
        value: {},
        disabled: true,
      },
    )

    for (const runtime of value.runtimes) {
      const icon = runtimeStatusIcon(runtime.health?.state, runtime.available)
      const detail = [
        runtime.available ? `${runtime.modelCount} model${runtime.modelCount === 1 ? "" : "s"}` : undefined,
        runtime.detail ?? (runtime.health?.detail && !runtime.available ? runtime.health.detail : undefined),
      ]
        .filter(Boolean)
        .join(" · ")
      rows.push({
        title: `${icon} ${runtime.name}`,
        description: [detail, runtime.endpoint].filter(Boolean).join(" · ") || undefined,
        category: "Runtimes",
        value: {},
        disabled: true,
      })
    }

    for (const runtime of Object.keys(value.installed)) {
      for (const model of value.installed[runtime]) {
        const params = num(model.parameterCount)
        rows.push({
          title: model.name,
          description: [
            params ? `${(params / 1e9).toFixed(1)}B` : undefined,
            model.quantization,
            model.toolCalling === false ? "no tools" : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          category: `Installed (${runtime})`,
          value: { type: "installed" as const, model },
        })
      }
    }

    for (const artifact of managed() ?? []) {
      const instance = artifact.instance
      const stateText = !artifact.fileExists
        ? "Missing file"
        : instance
          ? `${instance.state}${instance.endpoint ? ` · ${instance.endpoint.replace("http://", "")}` : ""}`
          : "Stopped"
      rows.push({
        title: [
          artifact.artifact.displayName,
          artifact.artifact.quantization,
          !artifact.fileExists ? "(missing)" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        description: [
          stateText,
          num(artifact.recommendedContext) ? `${formatContext(num(artifact.recommendedContext))} recommended` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        category: "Atlas-managed (llama.cpp)",
        value: { type: "managed" as const, artifactID: artifact.artifact.id },
        footer: "Managed",
      })
    }

    value.recommendations.forEach((recommendation, index) => {
      const score = num(recommendation.score) ?? 0
      const ctx = formatContext(num(recommendation.estimated?.contextLength))
      const workingSet = formatBytes(num(recommendation.estimated?.totalBytes))
      const selectedMetric = recommendation.alternatives.find((a) => a.variant.id === recommendation.variant.id)
      const description = [
        recommendation.variant.quantization ?? "default quantization",
        COMPATIBILITY_LABEL[recommendation.compatibility],
        `${ctx} context`,
        `~${workingSet} working set`,
        selectedMetric?.metricSource === "measured"
          ? `${num(selectedMetric.measuredTokensPerSecond)} tok/s measured`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
      rows.push({
        title: index === 0 ? `★ ${recommendation.model.name}` : recommendation.model.name,
        description: `${stars(score)} · ${description}`,
        category:
          index === 0 ? "★ Best for your PC" : `Recommended - ${PRESETS[presetIndex()].label}`,
        value: { type: "recommended" as const, recommendation },
        footer: recommendation.installed
          ? "Installed"
          : formatBytes(num(recommendation.variant.downloadSizeBytes)),
      })
    })

    return rows
  })

  return (
    <Switch>
      <Match when={state()}>
        <DialogSelect
          title="Local AI"
          placeholder="Filter models"
          options={options()}
          actions={[
            {
              command: "local.ai.preset",
              title: `Preset: ${PRESETS[presetIndex()].label}`,
              side: "right",
              onTrigger: cyclePreset,
            },
            {
              command: "local.ai.runtime",
              title: `Runtime: ${RUNTIME_NAMES[state()?.preference ?? "auto"] ?? state()?.preference ?? "auto"}`,
              side: "right",
              onTrigger: () => void cyclePreference(),
            },
            {
              command: "local.ai.import-gguf",
              title: "Import GGUF",
              onTrigger: importGguf,
            },
            {
              command: "local.ai.llama-server-path",
              title: executable()?.found ? "llama-server path" : "Configure llama-server path",
              onTrigger: configureExecutable,
            },
            {
              command: "local.ai.refresh",
              title: "Refresh",
              side: "left",
              onTrigger: refresh,
            },
          ]}
          onSelect={(option) => {
            const value = option.value as { type?: string; recommendation?: LocalAiRecommendation; artifactID?: string }
            if (value.type === "recommended" && value.recommendation) openRecommendation(value.recommendation)
            if (value.type === "managed" && value.artifactID) openManagedArtifact(value.artifactID)
          }}
        />
      </Match>
      <Match when={true}>
        <DialogSelect
          title="Local AI"
          options={[{ title: error() ?? "Detecting hardware and runtimes...", value: {}, disabled: true }]}
        />
      </Match>
    </Switch>
  )
}

function ProgressBar(props: { percent: number }) {
  const filled = Math.round((props.percent / 100) * 24)
  return `${"█".repeat(filled)}${"░".repeat(24 - filled)} ${props.percent}%`
}

function LocalAiModelDetails(props: {
  recommendation: LocalAiRecommendation
  state?: LocalAiState
  onBack: () => void
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const local = useLocal()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal<string>()

  const rec = () => props.recommendation
  // The recommended variant may differ from the model's default package
  const tag = () => rec().variant.runtimeTag ?? rec().model.runtimes.ollama
  const installed = () => rec().installed
  const toast = useToast()

  const benchmark = () => (tag() ? props.state?.benchmarks?.[tag()!] : undefined)
  const selectedEvaluation = () => rec().alternatives.find((a) => a.variant.id === rec().variant.id)

  const back = () => {
    dialog.replace(() => <DialogLocalAi />)
    props.onBack()
  }

  const install = (evaluation?: VariantEvaluation) => {
    if (busy()) return
    setBusy("install")
    void (async () => {
      try {
        const target = evaluation ?? selectedEvaluation()
        const result = await sdk.client.localai.install({
          localAiInstallInput: {
            profileID: rec().model.id,
            ...(target ? { variantID: target.variant.id } : {}),
          },
        })
        if (!result.data) throw new Error(result.error?.message ?? "Failed to start install")
        const installTag = target?.runtimeTag ?? tag()
        dialog.replace(() => <LocalAiInstallProgress jobID={result.data.id} modelTag={installTag} />)
      } catch (e) {
        setBusy(undefined)
        toast.show({
          title: "Install failed",
          message: e instanceof Error ? e.message : "Could not reach the local runtime",
          variant: "error",
        })
      }
    })()
  }

  const useModel = () => {
    const modelTag = tag()
    if (!modelTag) return
    // Provider IDs mirror runtime IDs for local runtimes
    local.model.set({ providerID: rec().runtime?.id ?? "ollama", modelID: modelTag }, { recent: true })
    dialog.clear()
  }

  const runBenchmark = async () => {
    if (busy() || !tag()) return
    setBusy("benchmark")
    try {
      const result = await sdk.client.localai.benchmark({ localAiModelInput: { modelID: tag()! } })
      if (!result.data) throw new Error(result.error?.message ?? "Failed to start benchmark")
      dialog.replace(() => <LocalAiJobProgress jobID={result.data.id} kind="benchmark" onDone={back} />)
    } catch {
      setBusy(undefined)
    }
  }

  const runReadiness = async () => {
    if (busy() || !tag()) return
    setBusy("readiness")
    try {
      const result = await sdk.client.localai.readiness({ localAiModelInput: { modelID: tag()! } })
      if (!result.data) throw new Error(result.error?.message ?? "Failed to start readiness test")
      dialog.replace(() => <LocalAiJobProgress jobID={result.data.id} kind="readiness" onDone={back} />)
    } catch {
      setBusy(undefined)
    }
  }

  const rows = createMemo(() => {
    const value = rec()
    type Row = {
      title: string
      description?: string
      disabled?: boolean
      category?: string
      footer?: string
      value: object
    }
    const info: Row[] = []
    const push = (row: Omit<Row, "value"> & { value?: Row["value"] }) =>
      info.push({ ...row, value: row.value ?? {} })

    push({
      title: COMPATIBILITY_LABEL[value.compatibility],
      description: `${num(value.score) ?? 0}/100 match`,
      category: "Overview",
      disabled: true,
      footer: installed() ? "Installed" : formatBytes(num(value.variant.downloadSizeBytes)),
    })
    push({
      title: "Context",
      description: `${formatContext(num(value.estimated?.contextLength))} recommended locally${
        num(value.model.contextLength) ? ` · model supports ${formatContext(num(value.model.contextLength))}` : ""
      }`,
      category: "Overview",
      disabled: true,
    })
    push({
      title: "Memory",
      description: [
        num(value.estimated?.vramBytes) ? `~${formatBytes(num(value.estimated?.vramBytes))} VRAM` : undefined,
        num(value.estimated?.ramBytes) ? `~${formatBytes(num(value.estimated?.ramBytes))} system RAM` : undefined,
        value.variant.quantization,
      ]
        .filter(Boolean)
        .join(" · "),
      category: "Overview",
      disabled: true,
    })
    push({
      title: "Offload",
      description: OFFLOAD_LABEL[value.offload],
      category: "Overview",
      disabled: true,
    })
    const headroom = num(value.estimated?.headroomBytes)
    if (headroom) {
      push({
        title: "Headroom",
        description: `~${formatBytes(headroom)} of VRAM left free at the recommended context`,
        category: "Overview",
        disabled: true,
      })
    }
    push({
      title: "Capabilities",
      description: [
        `coding ${num(value.model.capabilities.coding) ?? "?"}/100`,
        value.model.capabilities.toolCalling ? "tool calling" : "no tool calling",
        value.model.capabilities.vision ? "vision" : undefined,
        `reasoning ${num(value.model.capabilities.reasoning) ?? "?"}/100`,
      ]
        .filter(Boolean)
        .join(" · "),
      category: "Overview",
      disabled: true,
    })

    for (const reason of value.reasons) {
      push({ title: `✓ ${reason}`, category: "Recommended because", disabled: true })
    }
    for (const warning of value.warnings) {
      push({ title: `⚠ ${warning}`, category: "Recommended because", disabled: true })
    }

    const evaluation = selectedEvaluation()
    const measuredTps = num(evaluation?.measuredTokensPerSecond)
    if (evaluation?.metricSource === "measured" && measuredTps) {
      push({
        title: `Measured on this machine: ${measuredTps} tokens/sec`,
        description: "Real benchmark of this exact quantization - overrides size estimates",
        category: "Performance",
        disabled: true,
      })
      const ttft = num(benchmark()?.timeToFirstTokenMs)
      if (ttft) {
        push({ title: `${ttft}ms to first token`, category: "Performance", disabled: true })
      }
    } else {
      push({
        title: "Estimated from model size and your hardware",
        description: "No local benchmark yet - run Benchmark for real numbers",
        category: "Performance",
        disabled: true,
      })
    }

    // Cross-runtime evidence for this exact model+variant
    const choice = value.runtime
    if (choice) {
      push({
        title: `Runtime: ${RUNTIME_NAMES[choice.id] ?? choice.id}`,
        description:
          choice.source === "preference"
            ? "Your preferred runtime"
            : choice.source === "measured"
              ? "Selected by measured benchmarks"
              : choice.source === "heuristic"
                ? "Selected without benchmarks yet"
                : undefined,
        category: "Runtime",
        disabled: true,
      })
    }
    const group = props.state?.normalized.find(
      (entry) => entry.modelID === value.model.id && (!entry.variantID || entry.variantID === value.variant.id),
    )
    for (const instance of group?.instances ?? []) {
      const bench = props.state?.benchmarks?.[instance.runtimeID]?.[instance.runtimeModelID]
      const readiness = props.state?.readiness?.[instance.runtimeID]?.[instance.runtimeModelID]
      const parts = [
        num(bench?.tokensPerSecond) !== undefined ? `${num(bench?.tokensPerSecond)} tok/s` : undefined,
        num(bench?.timeToFirstTokenMs) !== undefined ? `${num(bench?.timeToFirstTokenMs)}ms TTFT` : undefined,
        num(readiness?.score) !== undefined ? `readiness ${num(readiness?.score)}` : undefined,
      ]
      if (parts.length === 0) continue
      push({
        title: RUNTIME_NAMES[instance.runtimeID] ?? instance.runtimeID,
        description: parts.join(" · "),
        category: "Cross-runtime benchmarks",
        disabled: true,
      })
    }

    for (const reason of choice?.reasons ?? []) {
      push({
        title: `${reason.kind === "positive" ? "✓" : "○"} ${reason.text}`,
        category: "Why this runtime",
        disabled: true,
      })
    }

    for (const alternative of value.alternatives) {
      if (alternative.variant.id === value.variant.id) continue
      const altCtx = formatContext(num(alternative.estimated?.contextLength))
      push({
        title: alternative.variant.quantization ?? alternative.variant.id,
        description: [
          COMPATIBILITY_LABEL[alternative.compatibility],
          OFFLOAD_LABEL[alternative.offload],
          `${altCtx} context`,
          num(alternative.measuredTokensPerSecond) !== undefined
            ? `${num(alternative.measuredTokensPerSecond)} tok/s measured`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        category: "Other variants",
        footer: formatBytes(num(alternative.variant.downloadSizeBytes)),
        value: { type: "variant" as const, variantID: alternative.variant.id },
      })
    }

    return info
  })

  return (
    <DialogSelect
      title={rec().model.name}
      options={rows()}
      footer={
        <box paddingBottom={1}>
          <text style={{ fg: theme.textMuted }}>
            {tag() ? `Ollama package: ${tag()}` : "No Ollama package available"}
          </text>
        </box>
      }
      onSelect={(option) => {
        const value = option.value as { type?: string; variantID?: string }
        if (value.type === "variant" && value.variantID) {
          const evaluation = rec().alternatives.find((a) => a.variant.id === value.variantID)
          if (evaluation) install(evaluation)
        }
      }}
      actions={[
        {
          command: "local.ai.back",
          title: "Back",
          side: "left",
          onTrigger: back,
        },
        {
          command: "local.ai.install",
          title:
            busy() === "install"
              ? "Installing..."
              : `Install ${rec().variant.quantization ?? "Recommended"}`,
          hidden: !!installed(),
          disabled: !!busy(),
          onTrigger: () => install(),
        },
        {
          command: "local.ai.use",
          title: "Use model",
          hidden: !installed(),
          onTrigger: useModel,
        },
        {
          command: "local.ai.benchmark",
          title: busy() === "benchmark" ? "Benchmarking..." : "Benchmark",
          hidden: !installed(),
          disabled: !!busy(),
          onTrigger: () => void runBenchmark(),
        },
        {
          command: "local.ai.readiness",
          title: busy() === "readiness" ? "Testing..." : "Agent readiness test",
          hidden: !installed(),
          disabled: !!busy(),
          onTrigger: () => void runReadiness(),
        },
      ]}
    />
  )
}

function LocalAiManagedDetails(props: {
  artifact: LocalAiManagedArtifact
  executable?: { found: boolean; path?: string; reason?: string }
  onRemoved: () => Promise<void>
  onLeave?: () => Promise<void>
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const event = useEvent()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal<string>()
  const [instance, setInstance] = createSignal(props.artifact.instance)
  // Live log tail: initial history once, then appended from log events
  const [view, setView] = createSignal<"details" | "logs">("details")
  const [logLines, setLogLines] = createSignal<{ at: number; source: string; line: string }[]>([])
  const instanceID = () => instance()?.id

  onMount(() => {
    const dispose = event.on("localai.instance.log", (payload) => {
      if (view() !== "logs" || payload.properties.instanceID !== instanceID()) return
      setLogLines((current) => {
        const incoming: { at: number; source: string; line: string }[] = []
        for (const line of payload.properties.lines) {
          const at = num(line.at)
          if (at !== undefined) incoming.push({ at, source: line.source, line: line.line })
        }
        const next = [...current, ...incoming]
        return next.length > 400 ? next.slice(-400) : next
      })
    })
    onCleanup(dispose)
    // Live lifecycle events keep the state label current
    const lifecycle = event.on("localai.instance.lifecycle", (payload) => {
      if (payload.properties.instanceID !== instanceID()) return
      setInstance((current) =>
        current ? { ...current, state: payload.properties.state, ...(payload.properties.reason ? { lastError: payload.properties.reason } : {}) } : current,
      )
    })
    onCleanup(lifecycle)
  })

  const artifactID = () => props.artifact.artifact.id
  const running = () => instance()?.state === "running" || instance()?.state === "starting"

  const back = async () => {
    if (view() === "logs") {
      setView("details")
      return
    }
    dialog.replace(() => <DialogLocalAi />)
    await props.onLeave?.()
  }

  const runLifecycle = async (action: "start" | "stop" | "restart") => {
    if (busy()) return
    setBusy(action)
    try {
      const result =
        action === "start"
          ? await sdk.client.localai.managed.start({ artifactID: artifactID() })
          : action === "stop"
            ? await sdk.client.localai.managed.stop({ instanceID: instance()?.id ?? "" })
            : await sdk.client.localai.managed.restart({ instanceID: instance()?.id ?? "" })
      if (result.data) {
        setInstance(result.data)
        toast.show({
          title:
            result.data.state === "running"
              ? "Model running"
              : result.data.state === "failed" || result.data.state === "crashed"
                ? "Start failed"
                : "Stopped",
          message: result.data.lastError ?? result.data.endpoint ?? "",
          variant: result.data.state === "running" ? "success" : result.data.state === "stopped" ? "info" : "error",
        })
        if (result.data.state === "failed" || result.data.state === "crashed") setInstance(undefined)
      } else {
        throw new Error(result.error?.message ?? "Operation failed")
      }
    } catch (e) {
      toast.show({
        title: `${action} failed`,
        message: e instanceof Error ? e.message : "Operation failed",
        variant: "error",
      })
    } finally {
      setBusy(undefined)
    }
  }

  const showLogs = async () => {
    if (!instance()) return
    setBusy("logs")
    try {
      const result = await sdk.client.localai.managed.logs({ instanceID: instance()!.id })
      const incoming: { at: number; source: string; line: string }[] = []
      for (const line of (result.data as LocalAiManagedLogs | undefined)?.lines ?? []) {
        const at = num(line.at)
        if (at !== undefined) incoming.push({ at, source: line.source, line: line.line })
      }
      setLogLines(incoming)
      setView("logs")
    } finally {
      setBusy(undefined)
    }
  }

  const logRows = () =>
    logLines().slice(-60).map((entry) => ({
      title: `[${new Date(entry.at).toLocaleTimeString()}] [${entry.source}] ${entry.line}`,
      value: {},
      disabled: true,
    }))

  const rows = () => {
    if (view() === "logs") return logRows()
    const info = [
      {
        title: !props.artifact.fileExists ? "Missing file" : (instance()?.state ?? "Stopped"),
        description: props.artifact.fileExists
          ? props.artifact.artifact.path
          : "The registered GGUF path no longer exists",
        value: {},
        disabled: true,
        category: "Overview",
        footer: props.artifact.artifact.quantization,
      },
      {
        title: "Context",
        description: num(props.artifact.recommendedContext)
          ? `${formatContext(num(props.artifact.recommendedContext))} recommended for this hardware`
          : "Hardware recommendation unavailable",
        value: {},
        disabled: true,
        category: "Overview",
      },
      ...(num(props.artifact.artifact.sizeBytes)
        ? [
            {
              title: `~${formatBytes(num(props.artifact.artifact.sizeBytes))} on disk`,
              description: "Referenced in place - never copied by Atlas",
              value: {},
              disabled: true,
              category: "Overview",
            },
          ]
        : []),
      ...(!props.executable?.found
        ? [
            {
              title: "llama-server not found",
              description: props.executable?.reason,
              value: {},
              disabled: true,
              category: "Executable",
            },
          ]
        : [
            {
              title: `llama-server: ${props.executable.path}`,
              description: "Discovered or explicitly configured",
              value: {},
              disabled: true,
              category: "Executable",
            },
          ]),
    ]
    return info
  }

  return (
    <DialogSelect
      title={view() === "logs" ? "llama.cpp logs" : props.artifact.artifact.displayName}
      options={rows()}
      footer={
        <box paddingBottom={1}>
          <text style={{ fg: theme.textMuted }}>
            {view() === "logs"
              ? "Live tail of the Atlas-owned process."
              : running()
                ? `Owned process · ${instance()?.endpoint}`
                : "Atlas manages the process lifecycle only"}
          </text>
        </box>
      }
      actions={[
        {
          command: "local.ai.back",
          title: "Back",
          side: "left",
          onTrigger: () => void back(),
        },
        {
          command: "local.ai.start-managed",
          title: busy() === "start" ? "Starting..." : "Start",
          hidden: running(),
          disabled: !!busy() || !props.executable?.found || !props.artifact.fileExists,
          onTrigger: () => void runLifecycle("start"),
        },
        {
          command: "local.ai.stop-managed",
          title: busy() === "stop" ? "Stopping..." : "Stop",
          hidden: !running(),
          disabled: !!busy(),
          onTrigger: () => void runLifecycle("stop"),
        },
        {
          command: "local.ai.restart-managed",
          title: busy() === "restart" ? "Restarting..." : "Restart",
          hidden: !running(),
          disabled: !!busy(),
          onTrigger: () => void runLifecycle("restart"),
        },
        {
          command: "local.ai.logs",
          title: "Logs",
          hidden: !instance(),
          disabled: !!busy(),
          onTrigger: () => void showLogs(),
        },
        {
          command: "local.ai.remove-registration",
          title: "Remove registration",
          hidden: running(),
          disabled: !!busy(),
          onTrigger: () => {
            void (async () => {
              try {
                const result = await sdk.client.localai.managed.remove({ artifactID: artifactID() })
                if (!result.data) throw new Error(result.error?.message ?? "Failed to remove")
                await props.onRemoved()
              } catch (e) {
                toast.show({
                  title: "Remove failed",
                  message: e instanceof Error ? e.message : "Failed to remove registration",
                  variant: "error",
                })
              }
            })()
          },
        },
      ]}
    />
  )
}

function LocalAiInstallProgress(props: { jobID: string; modelTag?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const local = useLocal()
  const event = useEvent()
  const { theme } = useTheme()
  const [job, setJob] = createSignal<LocalAiJob>()

  // Authoritative snapshot first, then live deltas from the event stream
  onMount(() => {
    void sdk.client.localai.job.get({ jobID: props.jobID }).then((result) => {
      if (result.data) setJob(result.data)
    })
    const dispose = event.on("localai.install.status", (payload) => {
      if (payload.properties.jobID !== props.jobID) return
      const status = payload.properties.status
      setJob((previous) => ({
        ...(previous ?? { id: props.jobID, kind: "install" as const, state: "running" as const, startedAt: Date.now() }),
        state:
          status === "completed"
            ? "done"
            : status === "cancelled"
              ? "cancelled"
              : status === "failed"
                ? "error"
                : "running",
        percent: payload.properties.percent,
        status: payload.properties.message,
        error: payload.properties.error,
      }))
      if (status === "completed") {
        setTimeout(() => {
          const modelTag = props.modelTag
          if (modelTag) {
            local.model.set({ providerID: "ollama", modelID: modelTag }, { recent: true })
          }
          dialog.clear()
        }, 900)
      }
    })
    onCleanup(dispose)
  })

  const statusText = () => {
    const value = job()
    if (!value) return "Starting download..."
    if (value.state === "done") return "✓ Installed - selected as active model"
    if (value.state === "cancelled") return "Download cancelled"
    if (value.state === "error") return `✗ ${value.error ?? "Install failed"}`
    const percent = num(value.percent)
    return [value.status, percent !== undefined ? ProgressBar({ percent }) : undefined].filter(Boolean).join("\n")
  }

  const done = () => job()?.state === "done"
  const failed = () => job()?.state === "error"
  const cancelled = () => job()?.state === "cancelled"

  const cancelDownload = async () => {
    try {
      await sdk.client.localai.job.cancel({ jobID: props.jobID })
    } catch {}
  }

  const finished = () => done() || failed() || cancelled()

  return (
    <DialogSelect
      title={`Installing ${props.modelTag ?? "model"}`}
      options={[
        {
          title: done()
            ? "Installed"
            : failed()
              ? "Failed"
              : cancelled()
                ? "Cancelled"
                : "Downloading...",
          description: statusText(),
          value: {},
          disabled: true,
        },
      ]}
      actions={
        finished()
          ? [
              {
                command: "local.ai.close",
                title: "Close",
                onTrigger: () => dialog.clear(),
              },
            ]
          : [
              {
                command: "local.ai.cancel-download",
                title: "Cancel download",
                onTrigger: () => void cancelDownload(),
              },
            ]
      }
      footer={
        <box paddingBottom={1}>
          <Show
            when={!failed()}
            fallback={<text style={{ fg: theme.error }}>The download did not complete. Nothing was changed.</text>}
          >
            <Show when={!cancelled()} fallback={<text style={{ fg: theme.textMuted }}>Download stopped. You can restart it anytime.</text>}>
              <text style={{ fg: theme.textMuted }}>You can keep working while the model downloads.</text>
            </Show>
          </Show>
        </box>
      }
    />
  )
}

function LocalAiJobProgress(props: { jobID: string; kind: "benchmark" | "readiness"; onDone: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const event = useEvent()
  const { theme } = useTheme()
  const [job, setJob] = createSignal<LocalAiJob>()
  // Live readiness checks accumulate as check_completed events arrive
  const [liveChecks, setLiveChecks] = createSignal<{ id: string; label: string; pass: boolean }[]>([])
  const [liveScore, setLiveScore] = createSignal<number>()

  onMount(() => {
    // Authoritative snapshot once, then live deltas from the event stream
    void sdk.client.localai.job.get({ jobID: props.jobID }).then((result) => {
      if (result.data) setJob(result.data)
    })
    const disposers = [
      event.on("localai.benchmark.status", (payload) => {
        if (payload.properties.status === "started") return
        setJob((previous) => ({
          ...(previous ?? { id: props.jobID, kind: "benchmark" as const, state: "running" as const, startedAt: Date.now() }),
          state:
            payload.properties.status === "completed"
              ? "done"
              : payload.properties.status === "cancelled"
                ? "cancelled"
                : payload.properties.status === "failed"
                  ? "error"
                  : "running",
          error: payload.properties.error,
          result:
            payload.properties.status === "completed"
              ? {
                  success: true,
                  tokensPerSecond: payload.properties.tokensPerSecond,
                  promptTokensPerSecond: payload.properties.promptTokensPerSecond,
                  timeToFirstTokenMs: payload.properties.timeToFirstTokenMs,
                }
              : previous?.result,
        }))
      }),
      event.on("localai.readiness.status", (payload) => {
        if (payload.properties.status === "check_completed" && payload.properties.check) {
          const check = payload.properties.check
          setLiveChecks((current) => [...current.filter((entry) => entry.id !== check.id), check])
          return
        }
        if (payload.properties.status === "started") return
        setJob((previous) => ({
          ...(previous ?? { id: props.jobID, kind: "readiness" as const, state: "running" as const, startedAt: Date.now() }),
          state:
            payload.properties.status === "completed"
              ? "done"
              : payload.properties.status === "cancelled"
                ? "cancelled"
                : payload.properties.status === "failed"
                  ? "error"
                  : "running",
          error: payload.properties.error,
        }))
        if (payload.properties.score !== undefined) setLiveScore(num(payload.properties.score))
      }),
    ]
    onCleanup(() => disposers.forEach((dispose) => dispose()))
  })

  const readiness = () => {
    const raw: unknown = job()?.result
    if (!raw || typeof raw !== "object") return undefined
    const record = raw as Record<string, unknown>
    if (!Array.isArray(record.checks)) return undefined
    return {
      score: num(record.score) ?? 0,
      checks: record.checks as { label: string; pass: boolean }[],
    }
  }

  const rows = createMemo(() => {
    const value = job()
    if (!value || value.state === "running") {
      // Live readiness checks appear as the underlying probes complete
      if (props.kind === "readiness" && liveChecks().length > 0) {
        return [
          ...liveChecks().map((check) => ({
            title: check.pass ? `✓ ${check.label}` : `○ ${check.label}`,
            value: {},
            disabled: true,
          })),
          {
            title: "Testing agent compatibility...",
            value: {},
            disabled: true,
          },
        ]
      }
      return [
        {
          title: props.kind === "benchmark" ? "Measuring generation speed..." : "Testing agent compatibility...",
          description: value?.status,
          value: {},
          disabled: true,
        },
      ]
    }
    if (value.state === "error") {
      return [{ title: `✗ ${value.error ?? "Failed"}`, value: {}, disabled: true }]
    }
    if (value.state === "cancelled") {
      return [{ title: "Cancelled", value: {}, disabled: true }]
    }

    if (props.kind === "readiness" && readiness()?.checks) {
      const result = readiness()!
      return [
        ...result.checks.map((check) => ({
          title: check.pass ? `✓ ${check.label}` : `○ ${check.label}`,
          value: {},
          disabled: true,
        })),
        {
          title: `Readiness: ${result.score}/100`,
          description:
            result.score >= 60
              ? "This model should work with OpenCode agent mode"
              : "Low readiness - this model may struggle with agent mode tool calling",
          value: {},
          disabled: true,
        },
      ]
    }

    const raw: unknown = value.result
    const bench = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    return [
      {
        title: "Measured performance",
        description:
          [
            num(bench?.tokensPerSecond) !== undefined ? `${num(bench?.tokensPerSecond)} tokens/sec` : undefined,
            num(bench?.promptTokensPerSecond) !== undefined
              ? `${num(bench?.promptTokensPerSecond)} prompt tokens/sec`
              : undefined,
            num(bench?.timeToFirstTokenMs) !== undefined
              ? `${num(bench?.timeToFirstTokenMs)}ms to first token`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || "No measurements returned",
        value: {},
        disabled: true,
      },
    ]
  })

  const finished = () => {
    const state = job()?.state
    return state === "done" || state === "error" || state === "cancelled"
  }

  return (
    <DialogSelect
      title={props.kind === "benchmark" ? "Benchmark" : "OpenCode Readiness"}
      options={rows()}
      actions={
        finished()
          ? [
              {
                command: "local.ai.done",
                title: "Done",
                onTrigger: () => {
                  dialog.replace(() => <DialogLocalAi />)
                  props.onDone()
                },
              },
            ]
          : []
      }
      footer={
        <box paddingBottom={1}>
          <text style={{ fg: theme.textMuted }}>Measurements are taken on this machine.</text>
        </box>
      }
    />
  )
}
