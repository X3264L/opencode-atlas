import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const packageDirectory = path.join(import.meta.dir, "..")

test(
  "Node bundle contains no unresolved Bun imports",
  async () => {
    const child = Bun.spawn([process.execPath, "script/build-node.ts"], {
      cwd: packageDirectory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exitCode, stderr).toBe(0)

    const bundle = await readFile(path.join(packageDirectory, "dist", "node", "node.js"), "utf8")
    expect(bundle).not.toMatch(/(?:from\s+|require\(|import\()\s*["']bun["']/)
  },
  180_000,
)
