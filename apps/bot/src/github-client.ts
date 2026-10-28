import type { GitHubAccount } from "@narumitw/sumire-contracts"
import { readResponseBytes, safeFetch } from "@narumitw/sumire-url-reader/network"

export interface GitHubToken {
  accessToken: string
  scopes: string[]
  expiresIn?: number
  refreshToken?: string
  refreshExpiresIn?: number
}

export interface DeviceGrant {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DeviceExchange = GitHubToken | { error: string; interval?: number }

export interface GitHubTransport {
  device(clientId: string, signal: AbortSignal): Promise<DeviceGrant>
  exchange(clientId: string, deviceCode: string, signal: AbortSignal): Promise<DeviceExchange>
  refresh(clientId: string, refreshToken: string, signal: AbortSignal): Promise<GitHubToken>
  account(accessToken: string, signal: AbortSignal): Promise<GitHubAccount>
}

const deviceEndpoint = "https://github.com/login/device/code"
const tokenEndpoint = "https://github.com/login/oauth/access_token"
const accountEndpoint = "https://api.github.com/user"
const verificationUri = "https://github.com/login/device"
const maxResponseBytes = 64 * 1024
const maxDeviceSeconds = 15 * 60
const maxTokenSeconds = 365 * 24 * 60 * 60
const tokenFields = [
  "access_token",
  "token_type",
  "scope",
  "expires_in",
  "refresh_token",
  "refresh_token_expires_in",
]
const deviceErrors = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "token_expired",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "access_denied",
  "device_flow_disabled",
])

const githubFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer()
  request.signal.throwIfAborted()
  return safeFetch(
    request.url,
    {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
      redirect: "error",
    },
    { signal: request.signal },
  )
}

function fail(): never {
  throw new Error("GitHub request failed")
}

/** Opaque OAuth values use the Bearer token alphabet, not a GitHub token prefix. */
function credential(value: unknown, maxLength = 8192): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  )
}

function seconds(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function scopes(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 4096 || /[^\x20-\x7e]/.test(value)) fail()
  if (!value.trim()) return []
  const values = value.trim().split(/[ ,]+/)
  if (
    values.length > 64 ||
    values.some((scope) => scope.length > 128 || !/^[a-z][a-z0-9_:]*$/.test(scope))
  )
    fail()
  return [...new Set(values)]
}

function token(value: Record<string, unknown>): GitHubToken {
  if (
    Object.hasOwn(value, "error") ||
    !credential(value.access_token) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer"
  )
    fail()
  const result: GitHubToken = { accessToken: value.access_token, scopes: scopes(value.scope) }
  const expiring = ["expires_in", "refresh_token", "refresh_token_expires_in"].some((key) =>
    Object.hasOwn(value, key),
  )
  if (!expiring) return result
  if (
    !seconds(value.expires_in, maxTokenSeconds) ||
    !credential(value.refresh_token) ||
    !seconds(value.refresh_token_expires_in, maxTokenSeconds) ||
    value.refresh_token_expires_in < value.expires_in
  )
    fail()
  return {
    ...result,
    expiresIn: value.expires_in,
    refreshToken: value.refresh_token,
    refreshExpiresIn: value.refresh_token_expires_in,
  }
}

export class GitHubClient implements GitHubTransport {
  constructor(private readonly fetcher: typeof fetch = githubFetch) {}

  async device(clientId: string, signal: AbortSignal): Promise<DeviceGrant> {
    if (!credential(clientId, 128)) fail()
    const value = await this.post(
      deviceEndpoint,
      { client_id: clientId, scope: "repo read:org" },
      signal,
    )
    const interval = Object.hasOwn(value, "interval") ? value.interval : 5
    if (
      Object.hasOwn(value, "error") ||
      !credential(value.device_code) ||
      !credential(value.user_code, 64) ||
      value.verification_uri !== verificationUri ||
      !seconds(value.expires_in, maxDeviceSeconds) ||
      !seconds(interval, maxDeviceSeconds) ||
      interval > value.expires_in
    )
      fail()
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri,
      expiresIn: value.expires_in,
      interval,
    }
  }

  async exchange(
    clientId: string,
    deviceCode: string,
    signal: AbortSignal,
  ): Promise<DeviceExchange> {
    if (!credential(clientId, 128) || !credential(deviceCode)) fail()
    const value = await this.post(
      tokenEndpoint,
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
      signal,
    )
    if (!Object.hasOwn(value, "error")) return token(value)
    if (
      typeof value.error !== "string" ||
      !deviceErrors.has(value.error) ||
      tokenFields.some((key) => Object.hasOwn(value, key))
    )
      fail()
    if (!Object.hasOwn(value, "interval")) return { error: value.error }
    if (value.error !== "slow_down" || !seconds(value.interval, maxDeviceSeconds)) fail()
    return { error: value.error, interval: value.interval }
  }

  async refresh(clientId: string, refreshToken: string, signal: AbortSignal): Promise<GitHubToken> {
    if (!credential(clientId, 128) || !credential(refreshToken)) fail()
    return token(
      await this.post(
        tokenEndpoint,
        { client_id: clientId, refresh_token: refreshToken, grant_type: "refresh_token" },
        signal,
      ),
    )
  }

  async account(accessToken: string, signal: AbortSignal): Promise<GitHubAccount> {
    if (!credential(accessToken)) fail()
    const value = await this.request(
      accountEndpoint,
      { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
      signal,
    )
    if (
      Object.hasOwn(value, "error") ||
      !Number.isSafeInteger(value.id) ||
      typeof value.id !== "number" ||
      value.id <= 0 ||
      typeof value.login !== "string" ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value.login)
    )
      fail()
    return { id: value.id, login: value.login }
  }

  private post(url: string, values: Record<string, string>, signal: AbortSignal) {
    return this.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(values),
      },
      signal,
    )
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response | undefined
    try {
      signal.throwIfAborted()
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      response = await this.fetcher(url, {
        ...init,
        headers: { Accept: "application/json", "User-Agent": "sumire", ...init.headers },
        redirect: "error",
        signal: requestSignal,
      })
      requestSignal.throwIfAborted()
      if (!response.ok || response.redirected || (response.url && response.url !== url)) fail()
      const bytes = await readResponseBytes(response, maxResponseBytes, requestSignal)
      requestSignal.throwIfAborted()
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      if (!value || typeof value !== "object" || Array.isArray(value)) fail()
      return value as Record<string, unknown>
    } catch {
      void response?.body?.cancel().catch(() => {})
      // Fetch, JSON, stream, and abort errors can contain credentials or upstream response data.
      fail()
    }
  }
}
