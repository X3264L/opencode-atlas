import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { checkDiskSpace, freeDiskBytes, resolveOllamaModelsDir } from "@/localai/disk"

const GB = 1e9

describe("disk space checks", () => {
  test("detects free space on a real directory", async () => {
    const bytes = await freeDiskBytes(os.tmpdir())
    expect(bytes).toBeDefined()
    expect(bytes!).toBeGreaterThan(0)
  })

  test("returns undefined instead of throwing for bogus paths", async () => {
    const bytes = await freeDiskBytes(path.join(os.tmpdir(), "definitely-does-not-exist-xyz", "nested"))
    expect(bytes).toBeUndefined()
  })

  test("passes when plenty of space is available for a small download", async () => {
    const result = await checkDiskSpace({ directory: os.tmpdir(), downloadBytes: 0.001 * GB })
    expect(result.ok).toBe(true)
  })

  test("fails with a clear message when requirements exceed available space", async () => {
    const result = await checkDiskSpace({ directory: os.tmpdir(), downloadBytes: Number.MAX_SAFE_INTEGER / 2 })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("disk space")
  })

  test("skips the check entirely when the size is unknown", async () => {
    const result = await checkDiskSpace({ directory: path.join(os.tmpdir(), "does-not-exist-xyz") })
    expect(result.ok).toBe(true)
  })
})

describe("ollama models directory resolution", () => {
  test("honors OLLAMA_MODELS override then falls back to home directory", () => {
    expect(resolveOllamaModelsDir({ OLLAMA_MODELS: "D:\\models" })).toBe("D:\\models")
    const fallback = resolveOllamaModelsDir({})
    expect(fallback).toContain(".ollama")
    expect(fallback.startsWith(os.homedir())).toBe(true)
  })
})
