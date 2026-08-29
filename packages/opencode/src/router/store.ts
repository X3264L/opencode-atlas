import path from "path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { DEFAULT_POLICY, type AtlasRoutingMode, type AtlasRoutingPolicy } from "./types"

// Persisted routing preferences. Declarative only - the policy object itself
// stays code-owned; users persist mode plus a few typed overrides.

export interface RoutingPrefsFile {
  mode?: AtlasRoutingMode
  privacyOverride?: AtlasRoutingPolicy["privacy"]
  preferLocal?: boolean
  allowCloud?: boolean
  allowManagedAutoStart?: boolean
  maxCloudCostPerRequest?: number
  latencyPreference?: AtlasRoutingPolicy["latencyPreference"]
}

function storePath() {
  return path.join(Global.Path.state, "routing.json")
}

export function effectivePolicy(prefs: RoutingPrefsFile): AtlasRoutingPolicy {
  return {
    ...DEFAULT_POLICY,
    ...(prefs.mode ? { mode: prefs.mode } : {}),
    ...(prefs.privacyOverride ? { privacy: prefs.privacyOverride } : {}),
    ...(prefs.preferLocal !== undefined ? { preferLocal: prefs.preferLocal } : {}),
    ...(prefs.allowCloud !== undefined ? { allowCloud: prefs.allowCloud } : {}),
    ...(prefs.allowManagedAutoStart !== undefined ? { allowManagedAutoStart: prefs.allowManagedAutoStart } : {}),
    ...(prefs.maxCloudCostPerRequest !== undefined ? { maxCloudCostPerRequest: prefs.maxCloudCostPerRequest } : {}),
    ...(prefs.latencyPreference ? { latencyPreference: prefs.latencyPreference } : {}),
  }
}

export async function readRoutingPrefs(): Promise<RoutingPrefsFile> {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RoutingPrefsFile) : {}
  } catch {
    return {}
  }
}

export async function writeRoutingPrefs(prefs: RoutingPrefsFile) {
  try {
    const filePath = storePath()
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(prefs, null, 2))
  } catch {}
}
