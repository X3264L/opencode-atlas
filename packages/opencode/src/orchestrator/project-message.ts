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
}

export function routeProjectMessage(text: string): ProjectMessageResult {
  const route: ProjectMessageRoute = classifyProjectMessage(text)
  switch (route.intent) {
    case "instruction":
      return { intent: route.intent, instructionText: text, reason: route.reason }
    case "question":
      return { intent: route.intent, queryText: text, reason: route.reason }
    case "status_request":
      return { intent: route.intent, queryText: text, reason: route.reason }
    case "idea":
      return { intent: route.intent, ideaText: text, reason: route.reason }
    case "memory_correction":
      return { intent: route.intent, instructionText: text, reason: route.reason }
    case "direct_project_command":
      return { intent: route.intent, instructionText: text, reason: route.reason }
    default:
      return { intent: route.intent, queryText: text, reason: route.reason }
  }
}
