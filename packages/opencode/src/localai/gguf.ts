import fs from "fs/promises"
import path from "path"
import { LOCAL_MODEL_CATALOG } from "./catalog"
import { parseGGUFQuantization } from "./runtime/llamacpp"

// Atlas-managed GGUF registrations. A registration is a lightweight REFERENCE
// to a user-owned model file - Atlas never copies, moves, modifies or deletes
// the underlying GGUF.

export interface ManagedGgufArtifact {
  id: string
  runtimeID: "llamacpp"
  /** Absolute path to the user's GGUF file */
  path: string

  /** Set only when confidently matched to the catalog */
  modelID?: string
  variantID?: string
  quantization?: string
  family?: string
  parameterCount?: number

  displayName: string
  sizeBytes?: number
  /** Advanced typed overrides - validated numerics only, never raw flags */
  launchOverrides?: { contextSize?: number; gpuLayers?: number; threads?: number }
  source: "user-file"
  registeredAt: string
}

export interface GgufRegistrationResult {
  ok: boolean
  error?: string
  artifact?: ManagedGgufArtifact
}

let artifactCounter = 0

function newArtifactId(): string {
  artifactCounter += 1
  return `gguf-${Date.now().toString(36)}-${artifactCounter}`
}

/** Canonical GGUF quantization parsing lives with the llama.cpp adapter */
export { parseGGUFQuantization } from "./runtime/llamacpp"

/** Strips path and extension for display; keeps recognizable names */
export function ggufDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw
  return base.replace(/\.gguf$/i, "")
}

function estimateParameterCount(raw: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(ggufDisplayName(raw))
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * 1e9)
}

/**
 * Filename-based identification. Returns undefined for every field it cannot
 * determine confidently - unknown GGUFs stay "Unknown GGUF model".
 */
export function identifyGgufFromFilename(filename: string): {
  quantization?: string
  parameterCount?: number
  modelID?: string
  variantID?: string
  family?: string
} {
  const quantization = parseGGUFQuantization(filename)
  const parameterCount = estimateParameterCount(filename)
  const tokens = new Set(
    filename
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  )
  for (const profile of LOCAL_MODEL_CATALOG) {
    if (!profile.family) continue
    const familyToken = profile.family.toLowerCase().split(/[^a-z0-9]+/).find((token) => token.length >= 3)
    if (!familyToken || !tokens.has(familyToken)) continue
    if (parameterCount !== undefined && profile.parameterCount !== undefined) {
      const ratio = parameterCount / profile.parameterCount
      if (ratio < 0.85 || ratio > 1.15) continue
    }
    const variant = profile.variants.find((candidate) => {
      if (!candidate.quantization) return false
      return candidate.quantization.toUpperCase().replace(/[._]/g, "_") === quantization?.toUpperCase()
    })
    if (!variant && quantization) continue
    return {
      ...(quantization ? { quantization } : {}),
      ...(parameterCount !== undefined ? { parameterCount } : {}),
      modelID: profile.id,
      ...(variant ? { variantID: variant.id } : {}),
      family: profile.family,
    }
  }
  return {
    ...(quantization ? { quantization } : {}),
    ...(parameterCount !== undefined ? { parameterCount } : {}),
  }
}

export interface ManagedStoreFile {
  artifacts?: ManagedGgufArtifact[]
  llamaServerPath?: string
}

/** Validates a user-provided path and builds a registration (no file copies). */
export async function registerGgufArtifact(
  rawPath: string,
  options?: { now?: () => string },
): Promise<GgufRegistrationResult> {
  const trimmed = rawPath.trim()
  if (!trimmed) return { ok: false, error: "Model file path is required" }

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(trimmed)
  } catch {
    return { ok: false, error: "File not found" }
  }
  if (!stat.isFile()) return { ok: false, error: "Path is not a regular file" }
  if (!trimmed.toLowerCase().endsWith(".gguf")) {
    return { ok: false, error: "Expected a .gguf model file" }
  }

  const identified = identifyGgufFromFilename(trimmed)
  const artifact: ManagedGgufArtifact = {
    id: newArtifactId(),
    runtimeID: "llamacpp",
    path: trimmed,
    displayName: ggufDisplayName(trimmed),
    source: "user-file",
    registeredAt: options?.now?.() ?? new Date().toISOString(),
    ...(identified.modelID ? { modelID: identified.modelID } : {}),
    ...(identified.variantID ? { variantID: identified.variantID } : {}),
    ...(identified.quantization ? { quantization: identified.quantization } : {}),
    ...(identified.family ? { family: identified.family } : {}),
    ...(identified.parameterCount !== undefined ? { parameterCount: identified.parameterCount } : {}),
    ...(stat.size > 0 ? { sizeBytes: stat.size } : {}),
  }
  return { ok: true, artifact }
}

/** A registration whose file has disappeared - kept visible, never auto-deleted */
export interface ArtifactFileStatus {
  exists: boolean
  sizeBytes?: number
}

export async function checkArtifactFile(artifact: ManagedGgufArtifact): Promise<ArtifactFileStatus> {
  try {
    const stat = await fs.stat(artifact.path)
    return { exists: stat.isFile(), ...(stat.size > 0 ? { sizeBytes: stat.size } : {}) }
  } catch {
    return { exists: false }
  }
}
