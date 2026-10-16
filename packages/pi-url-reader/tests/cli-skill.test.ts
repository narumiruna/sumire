import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { urlReaderSkillsPath } from "../src/resources.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("Pi URL reader CLI skill", () => {
  it("discovers both skills and runs the dependency CLI outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-url-reader-"))
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
      const skills = resourceLoader.getSkills().skills
      for (const name of ["load-public-url", "load-url-content"]) {
        expect(skills.filter((skill) => skill.name === name)).toEqual([
          expect.objectContaining({
            name,
            filePath: path.join(urlReaderSkillsPath, name, "SKILL.md"),
            sourceInfo: expect.objectContaining({ origin: "package" }),
          }),
        ])
      }

      const cli = path.join(urlReaderSkillsPath, "load-url-content/scripts/read-url.mjs")
      const result = spawnSync(process.execPath, [cli, "--list"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("httpx -")

      const failure = spawnSync(process.execPath, [cli, "--unknown-option"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(failure.error).toBeUndefined()
      expect(failure.status).toBe(1)
      expect(failure.stderr).toContain("Unknown option: --unknown-option")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
