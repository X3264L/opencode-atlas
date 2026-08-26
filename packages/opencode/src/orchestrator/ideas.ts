import type { PrivacyPolicy } from "./types"

// Idea Ledger: lightweight persistent capture of future-scope ideas that
// should not mutate the current roadmap.

export interface ProjectIdea {
  id: string
  projectID: string
  text: string
  sourceInstructionID: string
  status: "captured" | "promoted" | "dismissed"
  createdAt: number
  promotedAt?: number
}

export type MutationPolicy = "auto_apply_safe" | "review_major" | "review_all"

export interface RoutingPrefsExtension {
  mutationPolicy?: MutationPolicy
}
