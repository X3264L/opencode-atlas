import type { ProjectMessageRoute } from "./project-chat"
import { classifyProjectMessage } from "./project-chat"

// Native project conversation: routes project-level messages to the correct
// subsystem. The project conversation is the human ↔ organization channel;
// worker child sessions remain separate.

export interface ProjectMessageInput {
  projectID: string
  text: string
  hasImages?: boolean
}

export interface ProjectMessageResult {
  intent: string
  /** For instructions: text forwarded to instruction inbox */
  instructionText?: string
  /** For questions/status: query forwarded to brain */
  queryText?: string
  /** For ideas: captured in idea ledger */
  ideaText?: string
  reason: string
  /** True when the deterministic classifier had no confident signal */
  ambiguous?: boolean
}

export function routeProjectMessage(text: string): ProjectMessageResult {
  const route = classifyProjectMessage(text)
  const base = {
    intent: route.intent,
    reason: route.reason,
    ...(route.ambiguous ? { ambiguous: true } : {}),
  }
  switch (route.intent) {
    case "instruction":
      return { ...base, instructionText: text }
    case "question":
    case "status_request":
      return { ...base, queryText: text }
    case "idea":
      return { ...base, ideaText: text }
    case "memory_correction":
    case "direct_project_command":
      return { ...base, instructionText: text }
    default:
      return { ...base, queryText: text }
  }
}
