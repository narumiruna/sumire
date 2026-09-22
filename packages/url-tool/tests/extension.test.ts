import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import urlExtension, { createUrlExtension, createUrlTool } from "../src/index.js"

describe("URL tool Pi package", () => {
  it("registers only load_public_url with safe defaults", async () => {
    const registerTool = vi.fn()
    await urlExtension({ registerTool } as unknown as ExtensionAPI)
    expect(registerTool).toHaveBeenCalledOnce()
    const tool = registerTool.mock.calls[0]?.[0] as ToolDefinition
    expect(tool.name).toBe("load_public_url")
    await expect(
      tool.execute(
        "private",
        { url: "http://127.0.0.1/" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Private")
  })

  it("accepts host configuration without bot-specific settings", async () => {
    const registerTool = vi.fn()
    await createUrlExtension({ allowedSchemes: new Set(["https"]) })({
      registerTool,
    } as unknown as ExtensionAPI)
    const tool = registerTool.mock.calls[0]?.[0] as ToolDefinition
    await expect(
      tool.execute("scheme", { url: "http://8.8.8.8/" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("URL scheme is not allowed: http")
  })

  it("propagates loader failures through Pi's tool error path", async () => {
    const error = new Error("URL loading failed")
    const tool = createUrlTool({
      load: async () => {
        throw error
      },
    })
    await expect(
      tool.execute(
        "failure",
        { url: "https://example.com/" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toBe(error)
  })

  it("loads the compiled extension and bundled skill through its Pi manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-url-tool-"))
    const settingsManager = SettingsManager.inMemory({ packages: [path.resolve(".")] })
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    try {
      await resourceLoader.reload()
      expect(resourceLoader.getExtensions().errors).toEqual([])
      expect(resourceLoader.getSkills().diagnostics).toEqual([])
      expect(resourceLoader.getSkills().skills).toContainEqual(
        expect.objectContaining({
          name: "load-public-url",
          filePath: path.resolve("skills/load-public-url/SKILL.md"),
          sourceInfo: expect.objectContaining({ origin: "package" }),
        }),
      )
      const { session } = await createAgentSession({
        cwd: root,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(root),
        noTools: "builtin",
      })
      try {
        expect(session.getActiveToolNames()).toEqual(["load_public_url"])
      } finally {
        session.dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
