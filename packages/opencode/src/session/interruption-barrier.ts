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
