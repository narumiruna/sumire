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
    expect(
      (tool.parameters as unknown as { properties: Record<string, unknown> }).properties.loader,
    ).toBeUndefined()
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

  it("accepts host configuration and exposes only its loader allowlist", async () => {
    const registerTool = vi.fn()
    await createUrlExtension({
      allowedSchemes: new Set(["https"]),
      selectableLoaders: ["built-in", "httpx"],
    })({ registerTool } as unknown as ExtensionAPI)
    const tool = registerTool.mock.calls[0]?.[0] as ToolDefinition
    const loaderSchema = (
      tool.parameters as unknown as {
        properties: { loader: { enum: string[] } }
      }
    ).properties.loader
    expect(loaderSchema.enum).toEqual(["built-in", "httpx"])
    await expect(
      tool.execute("scheme", { url: "http://8.8.8.8/" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("URL scheme is not allowed: http")
  })

  it("forwards approved loader selections and cancellation in an options object", async () => {
    const url = "https://example.com/"
    const load = vi.fn(async () => ({
      url,
      finalUrl: url,
      source: "url-content" as const,
      contentType: "generic_web",
      text: "content",
      truncated: false,
      loaderId: "httpx",
    }))
    const tool = createUrlTool({ load }, { selectableLoaders: ["built-in", "httpx"] })
    const signal = new AbortController().signal

    await expect(
      tool.execute("explicit", { url, loader: "httpx" }, signal, undefined, undefined as never),
    ).resolves.toMatchObject({ details: { loaderId: "httpx" } })
    expect(load).toHaveBeenCalledExactlyOnceWith(url, { loader: "httpx", signal })
  })

  it("rejects disallowed loader values before invoking the backend", async () => {
    const load = vi.fn()
    const tool = createUrlTool({ load }, { selectableLoaders: ["httpx"] })

    await expect(
      tool.execute(
        "disallowed",
        { url: "https://example.com/", loader: "firecrawl" } as never,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("URL loader is not selectable: firecrawl")
    expect(load).not.toHaveBeenCalled()
  })

  it("rejects malformed loader values before invoking the backend", async () => {
    const load = vi.fn()
    const tool = createUrlTool({ load }, { selectableLoaders: ["httpx"] })

    await expect(
      tool.execute(
        "malformed",
        { url: "https://example.com/", loader: 1 } as never,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("URL loader must be a string")
    expect(load).not.toHaveBeenCalled()
  })

  it("rejects unknown loader names during tool construction", () => {
    expect(() =>
      createUrlTool({ load: vi.fn() }, { selectableLoaders: ["definitely-not-a-loader"] }),
    ).toThrow("Unknown loader: definitely-not-a-loader")
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

  it("loads the compiled package through its Pi manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-url-tool-"))
    const settingsManager = SettingsManager.inMemory()
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      additionalExtensionPaths: [path.resolve(".")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    try {
      await resourceLoader.reload()
      expect(resourceLoader.getExtensions().errors).toEqual([])
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
