// Session-level interruption barriers.
//
// The orchestrator sets a barrier on a worker's session when an interruption
// is pending. The session prompt loop checks the barrier before each model
// step and stops if set, preventing the next model inference from running.
// The orchestrator clears the barrier when the interruption completes.

const barriers = new Set<string>()

export function addInterruptionBarrier(sessionID: string): void {
  barriers.add(sessionID)
}

export function removeInterruptionBarrier(sessionID: string): void {
  barriers.delete(sessionID)
}

export function hasInterruptionBarrier(sessionID: string): boolean {
  return barriers.has(sessionID)
}

// ---- Tool lifecycle hooks for the interruption coordinator ----

type ToolInterruptionClass =
  | "read_only_cancellable"
  | "cancellable"
  | "side_effectful"
  | "non_cancellable"
  | "unknown"

type ToolLifecycleCallback = (
  sessionID: string,
  callID: string,
  tool: string,
  interruptionClass?: ToolInterruptionClass,
) => void

let toolStartHook: ToolLifecycleCallback | null = null
let toolSettledHook: ToolLifecycleCallback | null = null

/** The orchestrator registers these to feed the interruption coordinator. */
export function setToolLifecycleHooks(
  onStart: ToolLifecycleCallback | null,
  onSettled: ToolLifecycleCallback | null,
): void {
  toolStartHook = onStart
  toolSettledHook = onSettled
}

/** Called by the tool wrapper when a tool is about to execute. */
export function notifyToolStart(
  sessionID: string,
  callID: string,
  tool: string,
  interruptionClass?: ToolInterruptionClass,
): void {
  toolStartHook?.(sessionID, callID, tool, interruptionClass)
}

/** Called by the tool wrapper after a tool finishes (success, error, or cancel). */
export function notifyToolSettled(sessionID: string, callID: string, tool: string): void {
  toolSettledHook?.(sessionID, callID, tool)
}
