import type { AuthInteraction } from "@earendil-works/pi-ai"
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"

import loginExtension from "../src/index.js"

afterEach(() => vi.restoreAllMocks())

function setup() {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {}
  let shutdown = () => {}
  const pi = {
    registerCommand: vi.fn((_name, options) => {
      handler = options.handler
    }),
    on: vi.fn((_event, callback) => {
      shutdown = callback
    }),
  }
  loginExtension(pi as unknown as ExtensionAPI)
  const ui = {
    notify: vi.fn(),
    input: vi.fn<ExtensionUIContext["input"]>(async () => "callback"),
    select: vi.fn(async () => "choice"),
  }
  const refresh = vi.fn(async () => undefined)
  const ctx = {
    cwd: "/test",
    hasUI: true,
    ui,
    modelRegistry: { refresh },
  } as unknown as ExtensionCommandContext
  const runtime = {
    login: vi.fn(async (_provider, _type, interaction: AuthInteraction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/test" })
      await interaction.prompt({
        type: "manual_code",
        message: "Callback",
        signal: interaction.signal,
      })
      return {
        type: "oauth",
        access: "private-test-access",
        refresh: "private-test-refresh",
        expires: 0,
      }
    }),
  }
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as unknown as ModelRuntime)
  vi.spyOn(SettingsManager, "create").mockReturnValue({
    getOrCreateDeviceId: () => "test-device",
  } as SettingsManager)
  return { pi, handler, shutdown, ctx, ui, runtime, refresh }
}

describe("login extension", () => {
  it("registers a distinct command and refreshes the host after login", async () => {
    const { pi, handler, ctx, ui, runtime, refresh } = setup()
    expect(pi.registerCommand).toHaveBeenCalledWith("provider-login", expect.any(Object))
    await handler("", ctx)
    expect(runtime.login).toHaveBeenCalledWith(
      "openai",
      "oauth",
      expect.any(Object),
      expect.any(Object),
    )
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false })
    expect(ui.notify).toHaveBeenCalledWith("OpenAI login completed.", "info")
    expect(JSON.stringify(ui.notify.mock.calls)).not.toContain("private-test-access")
  })

  it("does not initiate login without UI", async () => {
    const { handler, ctx, runtime } = setup()
    await handler("", { ...ctx, hasUI: false })
    expect(runtime.login).not.toHaveBeenCalled()
  })

  it("cancels UI dismissal and leaves provider failures private", async () => {
    const { handler, ctx, ui, runtime, refresh } = setup()
    ui.input.mockResolvedValue(undefined)
    await handler("", ctx)
    expect(ui.notify).toHaveBeenLastCalledWith("OAuth login cancelled", "warning")
    expect(refresh).not.toHaveBeenCalled()
    runtime.login.mockRejectedValueOnce(new Error("private-provider-body"))
    await handler("", ctx)
    expect(JSON.stringify(ui.notify.mock.calls)).not.toContain("private-provider-body")
  })

  it("prevents duplicate login and cancels on shutdown", async () => {
    const { handler, shutdown, ctx, ui } = setup()
    ui.input.mockImplementationOnce(
      async (_title, _placeholder, options) =>
        new Promise<string | undefined>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true })
        }),
    )
    const running = handler("", ctx)
    await vi.waitFor(() => expect(ui.input).toHaveBeenCalled())
    await handler("", ctx)
    expect(ui.notify).toHaveBeenCalledWith("An OAuth login is already running.", "warning")
    shutdown()
    await running
  })
})
