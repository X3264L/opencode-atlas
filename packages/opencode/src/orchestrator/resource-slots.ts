// Hardware-aware resource slot enforcement for local workers.
// Prevents unsafe local model oversubscription.

export interface ResourceSlot {
  id: string
  taskID: string
  vramMB: number
  ramMB: number
  reservedAt: number
}

export interface ExecutionResourceBudget {
  maxWorkers: number
  maxLocalHeavyWorkers: number
  maxLocalLightWorkers: number
  maxCloudWorkers: number
  availableVRAMMB?: number
  availableRAMMB?: number
}

const RESERVED_VRAM_MB = 2_000 // OS + display reserve

export class ResourceSlotManager {
  private reservations = new Map<string, ResourceSlot>()
  private budget: ExecutionResourceBudget

  constructor(budget: ExecutionResourceBudget) {
    this.budget = budget
  }

  get activeReservations(): ResourceSlot[] {
    return [...this.reservations.values()]
  }

  get usedVRAMMB(): number {
    let total = RESERVED_VRAM_MB
    for (const slot of this.reservations.values()) total += slot.vramMB
    return total
  }

  canAdmit(taskID: string, vramMB: number, ramMB: number): { admitted: boolean; reason?: string } {
    if (this.reservations.has(taskID)) return { admitted: false, reason: "already reserved" }

    const currentVRAM = this.usedVRAMMB
    const projectedVRAM = currentVRAM + vramMB
    const maxVRAM = (this.budget.availableVRAMMB ?? Number.MAX_SAFE_INTEGER)

    if (maxVRAM !== Number.MAX_SAFE_INTEGER && projectedVRAM > maxVRAM) {
      return {
        admitted: false,
        reason: `VRAM: ${projectedVRAM}MB needed but only ${maxVRAM}MB available (${currentVRAM}MB in use)`,
      }
    }

    const currentRAM = [...this.reservations.values()].reduce((sum, s) => sum + s.ramMB, 0)
    const maxRAM = this.budget.availableRAMMB ?? Number.MAX_SAFE_INTEGER
    if (maxRAM !== Number.MAX_SAFE_INTEGER && currentRAM + ramMB > maxRAM) {
      return { admitted: false, reason: `RAM: ${currentRAM + ramMB}MB needed but only ${maxRAM}MB available` }
    }

    return { admitted: true }
  }

  reserve(taskID: string, vramMB: number, ramMB: number): boolean {
    const check = this.canAdmit(taskID, vramMB, ramMB)
    if (!check.admitted) return false
    this.reservations.set(taskID, {
      id: `slot-${taskID}`,
      taskID,
      vramMB,
      ramMB,
      reservedAt: Date.now(),
    })
    return true
  }

  release(taskID: string) {
    this.reservations.delete(taskID)
  }
}
