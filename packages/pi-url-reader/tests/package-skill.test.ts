import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent"
import { expect, it } from "vitest"

import { urlReaderSkillsPath } from "../src/resources.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

it("discovers only the URL tool skill from the Pi package manifest", async () => {
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
    expect(
      resourceLoader.getSkills().skills.filter((skill) => skill.sourceInfo?.origin === "package"),
    ).toEqual([
      expect.objectContaining({
        name: "load-public-url",
        filePath: path.join(urlReaderSkillsPath, "load-public-url", "SKILL.md"),
      }),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
