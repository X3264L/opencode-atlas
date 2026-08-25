import type { LocalInstalledModel } from "./runtime-types"
import { LOCAL_MODEL_CATALOG, type LocalModelProfile, type ModelVariant } from "./catalog"

// Normalized identity for local models. The same logical model may exist on
// several runtimes under different ids. Matching is deliberately STRICT -
// uncertain identities are displayed separately rather than merged.

/** A model served by one concrete runtime */
export interface RuntimeModelInstance {
  runtimeID: string
  /** Identifier the runtime itself uses */
  runtimeModelID: string
  model: LocalInstalledModel
  /** Set only when confidently matched to the catalog */
  modelID?: string
  variantID?: string
}

const normalizeQuant = (value: string | undefined) => value?.toUpperCase().replace(/[._\s-]/g, "_")

function nameTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2),
  )
}

/**
 * Confidently decides whether a runtime-served model IS a catalog variant.
 * Requires ALL of: matching quantization label, parameter count within 15%,
 * and a shared FAMILY token. Generic tokens like sizes ("14b") never count -
 * they would merge unrelated families of the same scale.
 */
export function matchCatalogVariant(
  instance: { id: string; quantization?: string; parameterCount?: number },
  profile: LocalModelProfile,
  variant: ModelVariant,
): boolean {
  const instanceQuant = normalizeQuant(instance.quantization)
  const variantQuant = normalizeQuant(variant.quantization)
  // The default variant has no explicit quantization label in filenames;
  // require explicit quant agreement whenever the variant declares one.
  if (variantQuant && instanceQuant !== variantQuant) return false

  if (instance.parameterCount !== undefined && profile.parameterCount !== undefined) {
    const ratio = instance.parameterCount / profile.parameterCount
    if (ratio < 0.85 || ratio > 1.15) return false
  }

  const familyReference = profile.family ? nameTokens(profile.family) : undefined
  const reference = familyReference && familyReference.size > 0 ? familyReference : nameTokens(profile.name)
  const candidate = nameTokens(instance.id)
  for (const token of reference) {
    if (candidate.has(token)) return true
  }
  return false
}

/**
 * Groups runtime instances into stable logical identities. Confident catalog
 * matches collapse under `<modelID>/<variantID>`; everything else keeps its
 * own entry so unrelated models are never merged away.
 */
export function normalizeInstances(instances: RuntimeModelInstance[]): {
  key: string
  instances: RuntimeModelInstance[]
}[] {
  const groups = new Map<string, RuntimeModelInstance[]>()
  for (const instance of instances) {
    let matched = false
    for (const profile of LOCAL_MODEL_CATALOG) {
      for (const variant of profile.variants) {
        if (!matchCatalogVariant({ ...instance.model, id: instance.runtimeModelID }, profile, variant)) continue
        const key = `${profile.id}/${variant.id}`
        const existing = groups.get(key)
        if (existing) existing.push(instance)
        else groups.set(key, [instance])
        instance.modelID = profile.id
        instance.variantID = variant.id
        matched = true
        break
      }
      if (matched) break
    }
    if (!matched) {
      const key = `raw/${instance.runtimeID}/${instance.runtimeModelID}`
      const existing = groups.get(key)
      if (existing) existing.push(instance)
      else groups.set(key, [instance])
    }
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, instances: grouped }))
}

