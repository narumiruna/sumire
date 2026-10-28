import { safeFetch } from "@narumitw/sumire-url-reader/network"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type DeviceExchange,
  type DeviceGrant,
  GitHubClient,
  type GitHubToken,
  type GitHubTransport,
} from "../src/github-client.js"

vi.mock("@narumitw/sumire-url-reader/network", async (importOriginal) => {
  const original = await importOriginal<typeof import("@narumitw/sumire-url-reader/network")>()
  return { ...original, safeFetch: vi.fn() }
})

const grant = {
  device_code: "synthetic-device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}
const legacyToken = {
  access_token: "synthetic-access-secret",
  token_type: "bearer",
  scope: "repo,read:org",
}
const expiringToken = {
  ...legacyToken,
  expires_in: 28_800,
  refresh_token: "synthetic-refresh-secret",
  refresh_token_expires_in: 15_552_000,
}
const sensitive = [
  grant.device_code,
  legacyToken.access_token,
  expiringToken.refresh_token,
  "synthetic-client-secret",
  "upstream-sensitive-description",
]

function signal() {
  return new AbortController().signal
}

function fixture(value: unknown) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(value))
  return { client: new GitHubClient(fetcher), fetcher }
}

function exchange(value: unknown) {
  return fixture(value).client.exchange("public-client", grant.device_code, signal())
}

async function expectSafeFailure(result: Promise<unknown>) {
  const error: unknown = await result.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected a safe GitHub failure")
  expect(error.message).toBe("GitHub request failed")
  expect(error.cause).toBeUndefined()
  for (const value of sensitive) {
    expect(`${error.stack}\n${JSON.stringify(error)}`).not.toContain(value)
  }
}

function fakeDeadline() {
  vi.useFakeTimers()
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("upstream-sensitive-description")), milliseconds)
    return controller.signal
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("fixed GitHub OAuth transport", () => {
  it("requests only repo and read:org at the fixed device endpoint", async () => {
    const { client, fetcher } = fixture(grant)
    const result: DeviceGrant = await client.device("public-client", signal())
    expect(result).toEqual({
      deviceCode: grant.device_code,
      userCode: grant.user_code,
      verificationUri: grant.verification_uri,
      expiresIn: 900,
      interval: 5,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input).toBe("https://github.com/login/device/code")
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    })
    const request = new Request(input as string, init)
    expect(request.headers.get("accept")).toBe("application/json")
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      client_id: "public-client",
      scope: "repo read:org",
    })
  })

  it("defaults an absent device polling interval to five seconds", async () => {
    const { interval: _interval, ...withoutInterval } = grant
    await expect(
      fixture(withoutInterval).client.device("public-client", signal()),
    ).resolves.toEqual({
      deviceCode: grant.device_code,
      userCode: grant.user_code,
      verificationUri: grant.verification_uri,
      expiresIn: 900,
      interval: 5,
    })
  })

  it("exchanges an opaque device code without a client secret or extra scopes", async () => {
    const { client, fetcher } = fixture(legacyToken)
    const result: DeviceExchange = await client.exchange(
      "public-client",
      grant.device_code,
      signal(),
    )
    expect(result).toEqual({ accessToken: legacyToken.access_token, scopes: ["repo", "read:org"] })
    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input).toBe("https://github.com/login/oauth/access_token")
    const request = new Request(input as string, init)
    expect(request.method).toBe("POST")
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      client_id: "public-client",
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
  })

  it("retains expiring access and refresh credentials and their lifetimes", async () => {
    const result: GitHubToken | { error: string; interval?: number } = await exchange(expiringToken)
    expect(result).toEqual({
      accessToken: legacyToken.access_token,
      scopes: ["repo", "read:org"],
      expiresIn: 28_800,
      refreshToken: expiringToken.refresh_token,
      refreshExpiresIn: 15_552_000,
    })
  })

  it("refreshes once without a client secret, device code, or scope request", async () => {
    const { client, fetcher } = fixture(expiringToken)
    const result: GitHubToken = await client.refresh(
      "public-client",
      expiringToken.refresh_token,
      signal(),
    )
    expect(result.refreshToken).toBe(expiringToken.refresh_token)
    expect(fetcher).toHaveBeenCalledOnce()
    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input).toBe("https://github.com/login/oauth/access_token")
    const request = new Request(input as string, init)
    expect(request.method).toBe("POST")
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({
      client_id: "public-client",
      refresh_token: expiringToken.refresh_token,
      grant_type: "refresh_token",
    })
  })

  it("verifies the account at the fixed endpoint and returns only public identity fields", async () => {
    const { client, fetcher } = fixture({
      id: 42,
      login: "octo-user",
      name: "Untrusted account text",
      email: "synthetic@example.com",
      access_token: legacyToken.access_token,
    })
    await expect(client.account(legacyToken.access_token, signal())).resolves.toEqual({
      id: 42,
      login: "octo-user",
    })
    const [input, init] = fetcher.mock.calls[0] ?? []
    expect(input).toBe("https://api.github.com/user")
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal),
    })
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${legacyToken.access_token}`)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("user-agent")).toBeTruthy()
    expect(init?.body).toBeUndefined()
  })

  it("supports structural transport fixtures without a GitHubClient instance", async () => {
    const transport: GitHubTransport = {
      device: async () => ({
        deviceCode: grant.device_code,
        userCode: grant.user_code,
        verificationUri: grant.verification_uri,
        expiresIn: 900,
        interval: 5,
      }),
      exchange: async () => ({ error: "authorization_pending" }),
      refresh: async () => ({ accessToken: "opaque-token", scopes: [] }),
      account: async () => ({ id: 42, login: "octocat" }),
    }
    await expect(transport.exchange("public-client", grant.device_code, signal())).resolves.toEqual(
      {
        error: "authorization_pending",
      },
    )
  })

  it("uses safeFetch by default with the same bounded signal and rejected redirects", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(Response.json(grant))
    await new GitHubClient().device("public-client", signal())
    expect(safeFetch).toHaveBeenCalledOnce()
    const [url, init, options] = vi.mocked(safeFetch).mock.calls[0] ?? []
    expect(url).toBe("https://github.com/login/device/code")
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    })
    expect(options?.signal).toBe(init?.signal)
    expect(new Headers(init?.headers).get("accept")).toBe("application/json")
    expect(
      Object.fromEntries(new URLSearchParams(Buffer.from(init?.body as ArrayBuffer).toString())),
    ).toEqual({
      client_id: "public-client",
      scope: "repo read:org",
    })
  })
})

describe("structured GitHub device responses", () => {
  it.each([
    "http://github.com/login/device",
    "https://github.com/login/device/",
    "https://github.com/login/device?code=secret",
    "https://github.com/login/device#secret",
    "https://github.com:443/login/device",
    "https://GITHUB.COM/login/device",
    "https://github.com/login/%64evice",
    "https://user:secret@github.com/login/device",
    "https://github.com.evil.example/login/device",
    "https://127.0.0.1/login/device",
    "javascript:alert(1)",
  ])("rejects the noncanonical verification URI %s", async (verification_uri) => {
    await expectSafeFailure(
      fixture({ ...grant, verification_uri }).client.device("public-client", signal()),
    )
  })

  it.each([
    { name: "missing device code", change: { device_code: undefined } },
    { name: "empty device code", change: { device_code: "" } },
    { name: "control in device code", change: { device_code: "device\nsecret" } },
    { name: "missing user code", change: { user_code: undefined } },
    { name: "oversized user code", change: { user_code: "A".repeat(65) } },
    { name: "control in user code", change: { user_code: "ABCD\rEFGH" } },
    { name: "missing expiry", change: { expires_in: undefined } },
    { name: "zero expiry", change: { expires_in: 0 } },
    { name: "negative expiry", change: { expires_in: -1 } },
    { name: "fractional expiry", change: { expires_in: 1.5 } },
    { name: "string expiry", change: { expires_in: "900" } },
    { name: "oversized expiry", change: { expires_in: 901 } },
    { name: "null expiry", change: { expires_in: null } },
    { name: "zero interval", change: { interval: 0 } },
    { name: "negative interval", change: { interval: -1 } },
    { name: "fractional interval", change: { interval: 1.5 } },
    { name: "string interval", change: { interval: "5" } },
    { name: "oversized interval", change: { interval: 901 } },
    { name: "null interval", change: { interval: null } },
    { name: "interval after expiry", change: { expires_in: 5, interval: 6 } },
    { name: "mixed success and error", change: { error: "device_flow_disabled" } },
  ])("rejects $name", async ({ change }) => {
    await expectSafeFailure(
      fixture({ ...grant, ...change }).client.device("public-client", signal()),
    )
  })

  it.each([
    "authorization_pending",
    "expired_token",
    "token_expired",
    "unsupported_grant_type",
    "incorrect_client_credentials",
    "incorrect_device_code",
    "access_denied",
    "device_flow_disabled",
  ])("returns only the allowlisted device error %s", async (error) => {
    await expect(
      exchange({
        error,
        error_description: "upstream-sensitive-description",
        error_uri: "http://127.0.0.1",
      }),
    ).resolves.toEqual({ error })
  })

  it("preserves a valid slow_down interval and permits its absence", async () => {
    await expect(exchange({ error: "slow_down", interval: 12 })).resolves.toEqual({
      error: "slow_down",
      interval: 12,
    })
    await expect(exchange({ error: "slow_down" })).resolves.toEqual({ error: "slow_down" })
  })

  it.each([0, -1, 1.5, 901, "10", null])(
    "rejects an invalid slow_down interval %s",
    async (interval) => {
      await expectSafeFailure(exchange({ error: "slow_down", interval }))
    },
  )

  it.each([
    { error: legacyToken.access_token },
    { error: "unknown_error", error_description: "upstream-sensitive-description" },
    { error: "bad_refresh_token" },
    { error: null },
    { error: 42 },
    { error: "authorization_pending", interval: 5 },
    { error: "slow_down", access_token: legacyToken.access_token },
    { ...legacyToken, error: "authorization_pending" },
  ])("does not return unknown or mixed protocol errors %#", async (value) => {
    await expectSafeFailure(exchange(value))
  })
})

describe("structured GitHub tokens and accounts", () => {
  it("accepts opaque Bearer tokens without GitHub prefixes and normalizes actual granted scopes", async () => {
    await expect(
      exchange({
        ...legacyToken,
        access_token: "opaque.value_+~/-==",
        token_type: "BeArEr",
        scope: " repo, read:org repo user:email ",
      }),
    ).resolves.toEqual({
      accessToken: "opaque.value_+~/-==",
      scopes: ["repo", "read:org", "user:email"],
    })
    await expect(exchange({ ...legacyToken, scope: "" })).resolves.toEqual({
      accessToken: legacyToken.access_token,
      scopes: [],
    })
  })

  it.each([
    { name: "missing access token", value: { token_type: "bearer", scope: "repo" } },
    { name: "invalid access token", value: { ...legacyToken, access_token: "a\r\nb" } },
    { name: "missing token type", value: { access_token: "opaque", scope: "repo" } },
    { name: "non-Bearer token", value: { ...legacyToken, token_type: "mac" } },
    { name: "padded token type", value: { ...legacyToken, token_type: " bearer" } },
    { name: "missing scope", value: { access_token: "opaque", token_type: "bearer" } },
    { name: "array scope", value: { ...legacyToken, scope: ["repo"] } },
    { name: "control in scope", value: { ...legacyToken, scope: "repo\nread:org" } },
    { name: "unsafe scope", value: { ...legacyToken, scope: "<script>" } },
    { name: "oversized scope", value: { ...legacyToken, scope: "a".repeat(4097) } },
    { name: "expiry without refresh", value: { ...legacyToken, expires_in: 28_800 } },
    { name: "refresh without expiry", value: { ...legacyToken, refresh_token: "opaque" } },
    { name: "refresh expiry alone", value: { ...legacyToken, refresh_token_expires_in: 100 } },
    { name: "missing refresh token", value: { ...expiringToken, refresh_token: undefined } },
    {
      name: "missing refresh expiry",
      value: { ...expiringToken, refresh_token_expires_in: undefined },
    },
    { name: "null refresh token", value: { ...expiringToken, refresh_token: null } },
    { name: "invalid refresh token", value: { ...expiringToken, refresh_token: "a\nb" } },
    { name: "zero access lifetime", value: { ...expiringToken, expires_in: 0 } },
    { name: "negative access lifetime", value: { ...expiringToken, expires_in: -1 } },
    { name: "fractional access lifetime", value: { ...expiringToken, expires_in: 1.5 } },
    { name: "string access lifetime", value: { ...expiringToken, expires_in: "28800" } },
    { name: "oversized access lifetime", value: { ...expiringToken, expires_in: 31_536_001 } },
    { name: "zero refresh lifetime", value: { ...expiringToken, refresh_token_expires_in: 0 } },
    {
      name: "fractional refresh lifetime",
      value: { ...expiringToken, refresh_token_expires_in: 1.5 },
    },
    {
      name: "oversized refresh lifetime",
      value: { ...expiringToken, refresh_token_expires_in: 31_536_001 },
    },
    {
      name: "refresh expires before access",
      value: { ...expiringToken, refresh_token_expires_in: 28_799 },
    },
    { name: "explicit null expiry", value: { ...legacyToken, expires_in: null } },
  ])("rejects $name", async ({ value }) => {
    await expectSafeFailure(exchange(value))
  })

  it.each([
    "bad_refresh_token",
    "authorization_pending",
    "slow_down",
    "unknown_error",
    legacyToken.access_token,
  ])("throws a fixed refresh failure for %s without retrying", async (error) => {
    const { client, fetcher } = fixture({
      error,
      error_description: "upstream-sensitive-description",
    })
    await expectSafeFailure(client.refresh("public-client", expiringToken.refresh_token, signal()))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    { id: 0, login: "octocat" },
    { id: -1, login: "octocat" },
    { id: 1.5, login: "octocat" },
    { id: Number.MAX_SAFE_INTEGER + 1, login: "octocat" },
    { id: "42", login: "octocat" },
    { id: 42, login: "" },
    { id: 42, login: "a".repeat(40) },
    { id: 42, login: "a\nb" },
    { id: 42, login: "<script>" },
    { id: 42, login: "-octocat" },
    { id: 42, login: null },
    { id: 42 },
    { id: 42, login: "octocat", error: "upstream-sensitive-description" },
  ])("rejects malformed account identity %#", async (value) => {
    await expectSafeFailure(fixture(value).client.account(legacyToken.access_token, signal()))
  })

  it.each([
    "",
    "a b",
    "a\tb",
    "a\nb",
    "a\rb",
    "a\u0000b",
    "a\u007fb",
    "a\u0085b",
    "é",
    "a=b=c",
    "a".repeat(8193),
  ])(
    "rejects invalid credentials before request headers or bodies are created %#",
    async (value) => {
      const { client, fetcher } = fixture(grant)
      await expectSafeFailure(client.account(value, signal()))
      await expectSafeFailure(client.exchange("public-client", value, signal()))
      await expectSafeFailure(client.refresh("public-client", value, signal()))
      await expectSafeFailure(client.device(value, signal()))
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("bounds the public client ID before issuing a request", async () => {
    const { client, fetcher } = fixture(grant)
    await expectSafeFailure(client.device("a".repeat(257), signal()))
    await expectSafeFailure(client.exchange("a".repeat(257), grant.device_code, signal()))
    await expectSafeFailure(client.refresh("a".repeat(257), expiringToken.refresh_token, signal()))
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe("bounded GitHub responses and safe failures", () => {
  it.each([
    "",
    "not-json",
    '{"access_token":"synthetic-access-secret"',
    "null",
    "[]",
    '"text"',
    "42",
  ])("rejects malformed JSON or a non-object response %#", async (body) => {
    const client = new GitHubClient(async () => new Response(body))
    await expectSafeFailure(client.exchange("public-client", grant.device_code, signal()))
  })

  it("rejects malformed UTF-8 instead of silently replacing bytes", async () => {
    const body = Buffer.concat([
      Buffer.from(JSON.stringify(grant).slice(0, -1)),
      Buffer.from(',"unknown":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ])
    await expectSafeFailure(
      new GitHubClient(async () => new Response(body)).device("public-client", signal()),
    )
  })

  it.each([301, 302, 303, 307, 308, 400, 401, 403, 429, 500])(
    "rejects HTTP %s without exposing the response or following redirects",
    async (status) => {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.redirect).toBe("error")
        return new Response(body, {
          status,
          statusText: "upstream-sensitive-description",
          headers: { location: "http://127.0.0.1/synthetic-access-secret" },
        })
      })
      await expectSafeFailure(new GitHubClient(fetcher).device("public-client", signal()))
      expect(fetcher).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it("rejects a successful response that was redirected or has an unexpected final URL", async () => {
    const redirected = Response.json(grant)
    Object.defineProperty(redirected, "redirected", { value: true })
    await expectSafeFailure(
      new GitHubClient(async () => redirected).device("public-client", signal()),
    )
    const wrongUrl = Response.json(grant)
    Object.defineProperty(wrongUrl, "url", { value: "https://evil.example/device" })
    await expectSafeFailure(
      new GitHubClient(async () => wrongUrl).device("public-client", signal()),
    )
  })

  it("accepts exactly 64 KiB and rejects a larger declared response before reading it", async () => {
    const text = JSON.stringify(grant)
    const body = `${text}${" ".repeat(64 * 1024 - Buffer.byteLength(text))}`
    await expect(
      new GitHubClient(async () => new Response(body)).device("public-client", signal()),
    ).resolves.toMatchObject({
      userCode: grant.user_code,
    })
    const cancel = vi.fn()
    const pull = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    await expectSafeFailure(
      new GitHubClient(
        async () => new Response(stream, { headers: { "content-length": "65537" } }),
      ).device("public-client", signal()),
    )
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([undefined, "1"])(
    "bounds streamed bytes with Content-Length %s",
    async (contentLength) => {
      const cancel = vi.fn()
      const chunks = [new Uint8Array(32 * 1024), new Uint8Array(32 * 1024), new Uint8Array([1])]
      let index = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[index++]
            if (chunk) controller.enqueue(chunk)
            else controller.close()
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      const headers = contentLength ? { "content-length": contentLength } : undefined
      await expectSafeFailure(
        new GitHubClient(async () => new Response(stream, { headers })).device(
          "public-client",
          signal(),
        ),
      )
      expect(cancel).toHaveBeenCalledOnce()
      expect(index).toBe(3)
    },
  )

  it("counts UTF-8 bytes rather than string characters", async () => {
    const body = JSON.stringify({ ...grant, unknown: "é".repeat(40_000) })
    expect(body.length).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024)
    await expectSafeFailure(
      new GitHubClient(async () => new Response(body)).device("public-client", signal()),
    )
  })

  it("does not expose network errors, their causes, or body stream errors", async () => {
    const error = new Error(sensitive.join(" "), { cause: new Error(expiringToken.refresh_token) })
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw error
    })
    await expectSafeFailure(new GitHubClient(fetcher).account(legacyToken.access_token, signal()))
    expect(fetcher).toHaveBeenCalledOnce()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error)
      },
    })
    await expectSafeFailure(
      new GitHubClient(async () => new Response(stream)).device("public-client", signal()),
    )
  })

  it("does not issue requests for an already aborted caller", async () => {
    const { client, fetcher } = fixture(grant)
    const controller = new AbortController()
    controller.abort(new Error(legacyToken.access_token))
    await expectSafeFailure(client.device("public-client", controller.signal))
    await expectSafeFailure(client.exchange("public-client", grant.device_code, controller.signal))
    await expectSafeFailure(
      client.refresh("public-client", expiringToken.refresh_token, controller.signal),
    )
    await expectSafeFailure(client.account(legacyToken.access_token, controller.signal))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects and cancels a late response after caller cancellation", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    let finish: ((value: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const failure = expectSafeFailure(
      new GitHubClient(fetcher).device("public-client", controller.signal),
    )
    controller.abort(new Error(expiringToken.refresh_token))
    finish?.(new Response(body))
    await failure
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it("cancels a stalled body read when the caller aborts", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const getReader = vi.spyOn(body, "getReader")
    const controller = new AbortController()
    const failure = expectSafeFailure(
      new GitHubClient(async () => new Response(body)).device("public-client", controller.signal),
    )
    await vi.waitFor(() => expect(getReader).toHaveBeenCalledOnce())
    controller.abort(new Error(grant.device_code))
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("enforces the ten-second deadline on the upstream fetch", async () => {
    const timeout = fakeDeadline()
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        }),
    )
    let settled = false
    const failure = expectSafeFailure(
      new GitHubClient(fetcher).device("public-client", signal()),
    ).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000)
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it("keeps the same deadline active while reading the response body", async () => {
    fakeDeadline()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const failure = expectSafeFailure(
      new GitHubClient(async () => new Response(body)).device("public-client", signal()),
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await failure
    expect(cancel).toHaveBeenCalledOnce()
  })
})
