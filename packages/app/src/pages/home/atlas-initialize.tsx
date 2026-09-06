import { type Accessor, createMemo, createSignal, Show } from "solid-js"
import type { HomeProjectSelection } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"

interface AtlasProjectResponse {
  projectID: string
  rootSessionID?: string
  objective?: {
    title?: string
  }
}

function projectName(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project"
}

function errorDetail(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (value && typeof value === "object") {
    if ("message" in value && typeof value.message === "string") return value.message
    if ("error" in value && typeof value.error === "string") return value.error
  }
  return "Atlas initialization failed."
}

async function responseError(response: Response) {
  const text = await response.text().catch(() => "")
  if (!text) return `Atlas initialization failed (${response.status}).`
  try {
    return errorDetail(JSON.parse(text))
  } catch {
    return text
  }
}

export function AtlasInitialize(props: {
  selection: Accessor<HomeProjectSelection>
  servers: Accessor<ServerConnection.Any[]>
}) {
  const platform = usePlatform()
  const [initializing, setInitializing] = createSignal(false)
  const [initialized, setInitialized] = createSignal<string>()

  const target = createMemo(() => {
    const selection = props.selection()
    if (!selection.directory) return
    const server = props.servers().find((candidate) => ServerConnection.key(candidate) === selection.server)
    if (!server) return
    return { server, directory: selection.directory }
  })

  async function initialize() {
    const current = target()
    if (!current || initializing()) return

    setInitializing(true)
    setInitialized(undefined)
    const { server, directory } = current
    const name = projectName(directory)
    const url = new URL("/orchestrator/projects", server.http.url)
    url.searchParams.set("directory", directory)

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    }
    if (server.http.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: server.http.username,
        password: server.http.password,
      })}`
    }

    console.info("[atlas] initialize requested", { directory, server: server.http.url })

    try {
      const fetcher = platform.fetch ?? globalThis.fetch
      const response = await fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: name,
          description: `Initialize Atlas project state for ${name}. Preserve the existing repository and wait for an explicit user objective before planning or execution.`,
          acceptanceCriteria: [
            "Atlas project state is created for the selected workspace.",
            "A canonical project conversation is available.",
            "No roadmap execution starts during initialization.",
          ],
          constraints: [
            "Do not modify project files during initialization.",
            "Do not start workers until explicitly requested by the user.",
          ],
          priorities: ["Preserve repository state", "Make Atlas project controls available"],
        }),
      })

      if (!response.ok) throw new Error(await responseError(response))
      const project = (await response.json()) as AtlasProjectResponse
      if (!project.projectID) throw new Error("Atlas returned no project ID.")

      setInitialized(project.projectID)
      console.info("[atlas] initialized", { projectID: project.projectID, directory })
      showToast({
        title: "Atlas initialized",
        description: `${name} is ready as ${project.projectID}.`,
      })
    } catch (cause) {
      console.error("[atlas] initialization failed", { directory, cause })
      showToast({
        title: "Atlas initialization failed",
        description: errorDetail(cause),
      })
    } finally {
      setInitializing(false)
    }
  }

  return (
    <Show when={target()}>
      <div class="mx-auto flex w-full max-w-[1080px] justify-end px-3 pt-3 lg:px-6">
        <button
          type="button"
          data-action="initialize-atlas"
          class="h-8 rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 text-sm text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-02 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={initializing() || !!initialized()}
          onClick={() => void initialize()}
        >
          {initializing() ? "Initializing Atlas…" : initialized() ? "Atlas Initialized" : "Initialize Atlas"}
        </button>
      </div>
    </Show>
  )
}
