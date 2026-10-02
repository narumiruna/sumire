import type { AuthInteraction } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import { createOAuthLogin, OAuthLoginError } from "../src/index.js"

const credential = {
  type: "oauth" as const,
  access: "test-access",
  refresh: "test-refresh",
  expires: 0,
}

function interaction(signal?: AbortSignal): AuthInteraction {
  return { signal, notify: vi.fn(), prompt: vi.fn(async () => "callback-code") }
}

function waitingRuntime(): Pick<ModelRuntime, "login"> {
  return {
    login: vi.fn(async (_provider, _type, ui) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("private upstream response"))
        ui.signal?.addEventListener("abort", abort, { once: true })
        if (ui.signal?.aborted) abort()
      })
      return credential
    }),
  }
}

describe("createOAuthLogin", () => {
  it("delegates OAuth and device identity to Pi without returning credentials", async () => {
    const getDeviceId = () => "test-device"
    const ui = interaction()
    const runtime = { login: vi.fn(async () => credential) }
    const client = createOAuthLogin(runtime, { getDeviceId })

    await expect(client.login(ui)).resolves.toBeUndefined()
    expect(runtime.login).toHaveBeenCalledWith(
      "openai",
      "oauth",
      expect.objectContaining({
        prompt: ui.prompt,
        notify: ui.notify,
        signal: expect.any(AbortSignal),
      }),
      { getDeviceId },
    )
  })

  it("does not attach raw provider errors or tokens to safe failures", async () => {
    const runtime = {
      login: vi.fn(async () => {
        throw new Error("test-access callback-code")
      }),
    }
    const error = await createOAuthLogin(runtime)
      .login(interaction())
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(OAuthLoginError)
    expect(error.kind).toBe("failed")
    expect(error.cause).toBeUndefined()
    expect(error.stack).not.toContain("test-access")
    expect(error.stack).not.toContain("callback-code")
  })

  it("cancels a pending flow", async () => {
    const controller = new AbortController()
    const runtime = waitingRuntime()
    const result = createOAuthLogin(runtime).login(interaction(controller.signal))
    controller.abort()
    await expect(result).rejects.toMatchObject({ kind: "cancelled" })
  })

  it("does not invoke Pi when already cancelled", async () => {
    const runtime = waitingRuntime()
    await expect(
      createOAuthLogin(runtime).login(interaction(AbortSignal.abort())),
    ).rejects.toMatchObject({ kind: "cancelled" })
    expect(runtime.login).not.toHaveBeenCalled()
  })

  it("bounds login duration without retrying", async () => {
    const runtime = waitingRuntime()
    const result = createOAuthLogin(runtime, { timeoutMs: 10 }).login(interaction())
    // AbortSignal.timeout is unref'ed; keep the test process alive until it fires.
    await Promise.all([
      expect(result).rejects.toMatchObject({ kind: "timeout" }),
      new Promise((resolve) => setTimeout(resolve, 20)),
    ])
    expect(runtime.login).toHaveBeenCalledTimes(1)
  })
})
