import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { urlContentSkillsPath } from "../src/resources.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("URL content Pi package", () => {
  it("discovers the bundled skill and runs the package-local CLI outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-url-content-pi-"))
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    try {
      await resourceLoader.reload()
      expect(resourceLoader.getSkills().diagnostics).toEqual([])
      expect(
        resourceLoader.getSkills().skills.filter((skill) => skill.name === "load-url-content"),
      ).toEqual([
        expect.objectContaining({
          name: "load-url-content",
          filePath: path.join(urlContentSkillsPath, "load-url-content/SKILL.md"),
          sourceInfo: expect.objectContaining({ origin: "package" }),
        }),
      ])

      const cli = path.resolve(urlContentSkillsPath, "load-url-content/../../dist/cli.js")
      const result = spawnSync(process.execPath, [cli, "--list"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("httpx -")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
