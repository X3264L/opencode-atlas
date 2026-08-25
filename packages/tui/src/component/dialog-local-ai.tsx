import { createMemo, createSignal, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import type { JSX } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useTheme } from "../context/theme"
import type { LocalAiJob, LocalAiRecommendation, LocalAiState } from "@opencode-ai/sdk/v2/types"

type VariantEvaluation = LocalAiRecommendation["alternatives"][number]

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

export function DialogLocalAi() {
  const sdk = useSDK()
  const dialog = useDialog()
  const [state, setState] = createSignal<LocalAiState>()
  const [error, setError] = createSignal<string>()
  const [presetIndex, setPresetIndex] = createSignal(0)

  const load = async (preset?: Preset) => {
    setError(undefined)
    try {
      const result = await sdk.client.localai.state(preset ? { preset } : {})
      if (result.data) setState(result.data)
      else setError(result.error?.message ?? "Failed to detect local AI state")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to detect local AI state")
    }
  }

  onMount(() => void load(PRESETS[presetIndex()].id))
  const refresh = () => void load(PRESETS[presetIndex()].id)

  const cyclePreset = async () => {
    const next = (presetIndex() + 1) % PRESETS.length
    setPresetIndex(next)
    await load(PRESETS[next].id)
  }

  const openRecommendation = (recommendation: LocalAiRecommendation) => {
    dialog.replace(() => <LocalAiModelDetails recommendation={recommendation} state={state()} onBack={refresh} />)
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
              command: "local.ai.refresh",
              title: "Refresh",
              side: "left",
              onTrigger: refresh,
            },
          ]}
          onSelect={(option) => {
            const value = option.value as { type?: string; recommendation?: LocalAiRecommendation }
            if (value.type === "recommended" && value.recommendation) openRecommendation(value.recommendation)
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

function pollJob(sdk: ReturnType<typeof useSDK>["client"], jobID: string, onUpdate: (job: LocalAiJob) => void) {
  let stopped = false
  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const result = await sdk.localai.job.get({ jobID })
      if (result.data && !stopped) onUpdate(result.data)
    } catch {}
  }, 700)
  return () => {
    stopped = true
    clearInterval(timer)
  }
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
    local.model.set({ providerID: "ollama", modelID: modelTag }, { recent: true })
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

function LocalAiInstallProgress(props: { jobID: string; modelTag?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const local = useLocal()
  const { theme } = useTheme()
  const [job, setJob] = createSignal<LocalAiJob>()

  onMount(() => {
    const stop = pollJob(sdk.client, props.jobID, (value) => {
      setJob(value)
      if (value.state !== "running") stop()
      if (value.state === "done") {
        setTimeout(() => {
          const modelTag = props.modelTag
          if (modelTag) {
            local.model.set({ providerID: "ollama", modelID: modelTag }, { recent: true })
          }
          dialog.clear()
        }, 900)
      }
    })
    onCleanup(stop)
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
  const { theme } = useTheme()
  const [job, setJob] = createSignal<LocalAiJob>()

  onMount(() => {
    const stop = pollJob(sdk.client, props.jobID, (value) => {
      setJob(value)
      if (value.state !== "running") stop()
    })
    onCleanup(stop)
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

  const finished = () => job()?.state === "done" || job()?.state === "error"

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
