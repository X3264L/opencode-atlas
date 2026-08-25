import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { identifyGgufFromFilename, registerGgufArtifact, checkArtifactFile } from "@/localai/gguf"

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "atlas-gguf-"))
}

describe("gguf filename identity", () => {
  test("extracts quantization and parameter count", () => {
    expect(identifyGgufFromFilename("Qwen3-Coder-30B-Q6_K.gguf").quantization).toBe("Q6_K")
    expect(identifyGgufFromFilename("qwen2.5-coder-14b-q8_0.gguf").quantization).toBe("Q8_0")
    expect(identifyGgufFromFilename("model-14b.gguf").parameterCount).toBe(14_000_000_000)
  })

  test("unknown models stay unknown instead of being guessed", () => {
    const identity = identifyGgufFromFilename("my-experimental-finetune.gguf")
    expect(identity.quantization).toBeUndefined()
    expect(identity.modelID).toBeUndefined()
    expect(identity.variantID).toBeUndefined()
  })
})

describe("gguf registration", () => {
  test("registers a valid gguf by reference", async () => {
    const dir = await makeTmpDir()
    const filePath = path.join(dir, "qwen2.5-coder-14b-q6_K.gguf")
    await fs.writeFile(filePath, "tiny fixture")

    const result = await registerGgufArtifact(filePath)
    expect(result.ok).toBe(true)
    expect(result.artifact?.path).toBe(filePath)
    expect(result.artifact?.quantization).toBe("Q6_K")
    expect(result.artifact?.runtimeID).toBe("llamacpp")
    expect(result.artifact?.source).toBe("user-file")

    // Registration references but does NOT consume the file
    const stillThere = await checkArtifactFile(result.artifact!)
    expect(stillThere.exists).toBe(true)
    expect((await fs.stat(filePath)).isFile()).toBe(true)
  })

  test("paths with spaces are preserved verbatim", async () => {
    const dir = await makeTmpDir()
    const nested = path.join(dir, "My Models", "qwen 14b Q6_K.gguf")
    await fs.mkdir(path.dirname(nested), { recursive: true })
    await fs.writeFile(nested, "x")

    const result = await registerGgufArtifact(nested)
    expect(result.ok).toBe(true)
    expect(result.artifact?.path).toBe(nested)
  })

  test("rejects missing paths", async () => {
    const result = await registerGgufArtifact(path.join(os.tmpdir(), "does-not-exist-atlas.gguf"))
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not found")
  })

  test("rejects directories", async () => {
    const result = await registerGgufArtifact(os.tmpdir())
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a regular file")
  })

  test("rejects non-gguf extensions", async () => {
    const dir = await makeTmpDir()
    const filePath = path.join(dir, "model.bin")
    await fs.writeFile(filePath, "x")
    const result = await registerGgufArtifact(filePath)
    expect(result.ok).toBe(false)
    expect(result.error).toContain(".gguf")
  })

  test("missing-after-registration is reported without crashing", async () => {
    const dir = await makeTmpDir()
    const filePath = path.join(dir, "gone.gguf")
    await fs.writeFile(filePath, "x")
    const registered = await registerGgufArtifact(filePath)

    // Simulate a disconnected drive / deleted file
    await fs.unlink(filePath)
    const status = await checkArtifactFile(registered.artifact!)
    expect(status.exists).toBe(false)
  })
})
