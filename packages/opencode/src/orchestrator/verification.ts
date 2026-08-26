import type { VerificationEvidence, VerificationStep } from "./types"

// Command execution goes through the repo's typed Process runner (argv array,
// no shell string) with a conservative metacharacter guard. Planner-generated
// commands are only executed when they pass this validation.

export function isSafeCommand(command: string): boolean {
  if (command.trim().length === 0) return false
  return !/[;&|><]/.test(command)
}

export interface VerifyDeps {
  runCommand: (argv: string[]) => Promise<{ code: number; output: string }>
  fileExists: (path: string) => Promise<boolean>
  /** LLM/reviewer-backed criteria review; optional in P0 */
  review?: (criteria: string[]) => Promise<{ passed: boolean; detail?: string }>
}

function toArgv(command: string): string[] {
  // Split on whitespace; quoted segments preserved as single args
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return matches.map((arg) => arg.replace(/^"(.*)"$/, "$1"))
}

export async function runVerification(
  steps: VerificationStep[],
  deps: VerifyDeps,
): Promise<VerificationEvidence[]> {
  const evidence: VerificationEvidence[] = []
  for (const step of steps) {
    if (step.kind === "command" || step.kind === "test") {
      const command = step.kind === "test" && step.target ? `run test ${step.target}` : (step.command ?? "echo no-op")
      if (!isSafeCommand(command)) {
        evidence.push({ step, passed: false, detail: "command rejected by safety validation" })
        continue
      }
      try {
        const { code, output } = await deps.runCommand(toArgv(command))
        evidence.push({ step, passed: code === 0, detail: output.slice(-2000) })
      } catch (error) {
        evidence.push({ step, passed: false, detail: error instanceof Error ? error.message : String(error) })
      }
    } else if (step.kind === "file_exists") {
      const exists = await deps.fileExists(step.path ?? "")
      evidence.push({ step, passed: exists })
    } else if (step.kind === "review") {
      if (deps.review) {
        const verdict = await deps.review(step.criteria ?? [])
        evidence.push({ step, passed: verdict.passed, ...(verdict.detail ? { detail: verdict.detail } : {}) })
      }
      // Without a reviewer, review steps stay pending - they never auto-pass
    }
  }
  return evidence
}
