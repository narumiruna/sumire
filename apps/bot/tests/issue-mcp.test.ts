import { createHash, randomBytes, randomUUID } from "node:crypto"
import { request } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { arrayBuffer } from "node:stream/consumers"
import {
  completeMcpSignIn,
  MemoryOAuthStateStore,
  parseWwwAuthenticate,
  startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth"
import {
  discoverOAuthServerInfo,
  extractResourceMetadataUrl,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Issue } from "@narumitw/sumire-issues"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PNG } from "../../../packages/imagegen/tests/fixtures.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { IssueAnalysisRuntime } from "../src/issues/runtime.js"
import { deferred } from "./helpers/github-fixture.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const origin = "https://admin.example.test"
const mcpPath = "/mcp/issues"
const resource = `${origin}${mcpPath}`
const resourceMetadataPath = `/.well-known/oauth-protected-resource${mcpPath}`
const serverMetadataPath = "/.well-known/oauth-authorization-server"
const oauthPath = "/oauth/issues"
const consentPath = "/api/issues-mcp/consent"
const grantsPath = "/api/issues-mcp/grants"
const mcpHeaders = { accept: "application/json, text/event-stream" }
const loopbackCallback = "http://127.0.0.1:12345/callback"
const registration = {
  client_name: "Fixture",
  redirect_uris: [loopbackCallback],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
}
type Scope = "issues:read" | "issues:write"
type OAuthClient = { clientId: string; redirectUri: string }
type TokenResponse = { access_token: string; refresh_token: string; token_type: string }
let fixture: Awaited<ReturnType<typeof createPiFixture>>
let server: ReturnType<typeof createAdminServer>
let session: { value: string; csrf: string }
let clients: Client[]
let adminOrigin: string

async function start(configuredOrigin: string, analysis?: IssueAnalysisRuntime) {
  const store = fixture.factory.control
  adminOrigin = configuredOrigin
  server = createAdminServer(
    { origin: configuredOrigin, host: "127.0.0.1", port: 0, assets: fixture.root },
    {
      store,
      analysis,
      providers: new ProviderAdmin(fixture.modelRuntime, store),
      mcp: new McpAdmin(store, fixture.root),
      tools: () => [],
      apply: async () => {},
    },
  )
  await server.start()
}

beforeEach(async () => {
  fixture = await createPiFixture()
  session = fixture.factory.control.createSession("7")
  clients = []
  await start(origin)
})
afterEach(async () => {
  const attempts = await Promise.allSettled(clients.map(async (client) => client.close()))
  const errors: unknown[] = attempts.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  )
  for (const cleanup of [() => server.stop(), () => fixture.cleanup()]) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, "Issues MCP fixture cleanup failed")
})

function endpoint(pathname: string) {
  return new URL(pathname, `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`)
}
async function backendFetch(input: string | URL | Request, init?: RequestInit) {
  const incoming = new Request(input, init)
  const url = new URL(incoming.url)
  const backend = endpoint("/")
  if (url.origin !== adminOrigin && url.origin !== backend.origin)
    throw new Error(`Unexpected fixture request origin: ${url.origin}`)
  backend.pathname = url.pathname
  backend.search = url.search
  const headers = new Headers(incoming.headers)
  // Model the backend hop from the HTTPS reverse proxy, with its original Host header.
  if (!headers.has("host")) headers.set("host", new URL(adminOrigin).host)
  const body = Buffer.from(await incoming.arrayBuffer())
  if (body.length) headers.set("content-length", String(body.length))
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      backend,
      {
        method: incoming.method,
        headers: Object.fromEntries(headers),
        signal: incoming.signal,
      },
      (response) => {
        void (async () => {
          const data = await arrayBuffer(response)
          resolve(
            new Response(data.byteLength ? data : null, {
              status: response.statusCode,
              headers: Object.entries(response.headers).flatMap(([name, value]) =>
                value === undefined ? [] : [[name, String(value)]],
              ),
            }),
          )
        })().catch(reject)
      },
    )
    outgoing.once("error", reject)
    outgoing.end(body)
  })
}
function passkey() {
  return {
    origin: adminOrigin,
    cookie: `__Host-sumire-session=${session.value}`,
    "x-csrf-token": session.csrf,
  }
}
function call(pathname: string, method: string, data?: unknown, headers?: Record<string, string>) {
  return backendFetch(endpoint(pathname), {
    method,
    headers: {
      ...(data === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
}
function form(pathname: string, fields: Record<string, string>) {
  return backendFetch(endpoint(pathname), {
    method: "POST",
    body: new URLSearchParams(fields),
  })
}
async function expectOAuthError(response: Response) {
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: expect.any(String) })
}
async function register(redirectUri = loopbackCallback): Promise<OAuthClient> {
  const response = await call(`${oauthPath}/register`, "POST", {
    ...registration,
    redirect_uris: [redirectUri],
  })
  expect(response.status).toBe(201)
  const { client_id: clientId } = (await response.json()) as { client_id: string }
  expect(clientId).toEqual(expect.any(String))
  expect(clientId).not.toBe("")
  return { clientId, redirectUri }
}
function authorization(client: OAuthClient, scope?: Scope) {
  const verifier = randomBytes(32).toString("base64url")
  const state = randomUUID()
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    resource,
  })
  if (scope) params.set("scope", scope)
  return { params, verifier, state }
}
function authorize(params: URLSearchParams) {
  return call(`${oauthPath}/authorize?${params}`, "GET")
}
async function beginAuthorization(client: OAuthClient, scope?: Scope) {
  const { params, verifier, state } = authorization(client, scope)
  const response = await authorize(params)
  expect(response.status).toBe(303)
  const location = response.headers.get("location") ?? ""
  expect(location).toMatch(/^\/#issues-mcp=[\w-]{43}$/)
  const requestId = location.slice("/#issues-mcp=".length)
  const setCookie = response.headers.get("set-cookie") ?? ""
  const [cookie = ""] = setCookie.split(";")
  expect(cookie).toMatch(/^__Host-sumire-issues-oauth=.+$/)
  expect(setCookie).toMatch(/;\s*Secure(?:;|$)/i)
  expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/i)
  return { requestId, cookie, verifier, state }
}
type PendingAuthorization = Awaited<ReturnType<typeof beginAuthorization>>

function consentHeaders(pending: PendingAuthorization) {
  const headers = passkey()
  return { ...headers, cookie: `${headers.cookie}; ${pending.cookie}` }
}
function decide(
  pending: PendingAuthorization,
  approve: boolean,
  headers = consentHeaders(pending),
) {
  return call(consentPath, "POST", { requestId: pending.requestId, approve }, headers)
}
async function callback(response: Response, client: OAuthClient, pending: PendingAuthorization) {
  expect(response.status).toBe(200)
  const { redirect } = (await response.json()) as { redirect: string }
  // Inspect the loopback callback without performing a request to it.
  const url = new URL(redirect)
  expect(`${url.origin}${url.pathname}`).toBe(client.redirectUri)
  expect(url.searchParams.get("state")).toBe(pending.state)
  expect(url.searchParams.get("iss")).toBe(origin)
  return url.searchParams
}
async function authorizeCode(client: OAuthClient, scope?: Scope) {
  const pending = await beginAuthorization(client, scope)
  const params = await callback(await decide(pending, true), client, pending)
  const code = params.get("code") ?? ""
  expect(code).not.toBe("")
  expect(params.has("error")).toBe(false)
  return {
    grant_type: "authorization_code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_verifier: pending.verifier,
    code,
    resource,
  }
}
async function readTokens(response: Response): Promise<TokenResponse> {
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const tokens = (await response.json()) as TokenResponse
  expect(tokens).toMatchObject({
    access_token: expect.stringMatching(/\S/),
    refresh_token: expect.stringMatching(/\S/),
    token_type: expect.stringMatching(/^Bearer$/i),
  })
  return tokens
}
async function issueTokens(client: OAuthClient, scope?: Scope) {
  return readTokens(await form(`${oauthPath}/token`, await authorizeCode(client, scope)))
}
function refreshGrant(client: OAuthClient, token: string) {
  return {
    grant_type: "refresh_token",
    client_id: client.clientId,
    refresh_token: token,
    resource,
  }
}
function bearer(token: string) {
  return { ...mcpHeaders, authorization: `Bearer ${token}` }
}
async function connect(token: string) {
  const client = new Client({ name: "issue-fixture", version: "1.0.0" })
  clients.push(client)
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    fetch: backendFetch,
    requestInit: { headers: bearer(token) },
  })
  await client.connect(transport)
  expect(transport.sessionId).toBeUndefined()
  expect(client.getServerVersion()?.name).toBe("sumire-issues")
  return client
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
}

it("lets the MCP SDK discover OAuth and register a public loopback client", async () => {
  const unauthorized = await call(mcpPath, "POST", initialize, mcpHeaders)
  expect(unauthorized.status).toBe(401)
  const resourceMetadataUrl = extractResourceMetadataUrl(unauthorized)
  expect(resourceMetadataUrl?.href).toBe(`${origin}${resourceMetadataPath}`)
  const discovery = await discoverOAuthServerInfo(resource, {
    resourceMetadataUrl,
    fetchFn: backendFetch,
  })
  expect(discovery.authorizationServerUrl).toBe(origin)
  expect(discovery.resourceMetadata).toMatchObject({
    resource,
    authorization_servers: [origin],
    scopes_supported: expect.arrayContaining(["issues:read", "issues:write"]),
    bearer_methods_supported: ["header"],
  })
  expect(discovery.authorizationServerMetadata).toMatchObject({
    issuer: origin,
    authorization_endpoint: `${origin}${oauthPath}/authorize`,
    token_endpoint: `${origin}${oauthPath}/token`,
    registration_endpoint: `${origin}${oauthPath}/register`,
    revocation_endpoint: `${origin}${oauthPath}/revoke`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: expect.arrayContaining(["authorization_code", "refresh_token"]),
    response_types_supported: ["code"],
  })
  const client = await registerClient(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata,
    clientMetadata: registration,
    fetchFn: backendFetch,
  })
  expect(client.client_id).toEqual(expect.any(String))
  expect(client).not.toHaveProperty("client_secret")
  await beginAuthorization({ clientId: client.client_id, redirectUri: loopbackCallback })
})

it("gets Pi write access on fresh sign-in even when the challenge asks for read", async () => {
  const response = await call(mcpPath, "POST", initialize, mcpHeaders)
  expect(response.status).toBe(401)
  const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"))
  expect(challenge?.scope).toBe("issues:read")
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(backendFetch)
  try {
    const store = Object.assign(new MemoryOAuthStateStore(), {
      withRefreshLock: <T>(work: () => Promise<T>) => work(),
    })
    const options = {
      serverUrl: resource,
      store,
      clientName: "Pi fixture",
      redirectUrl: loopbackCallback,
      settings: { scope: "issues:write" },
      challenge,
    }
    const authorization = await startMcpSignIn(options)
    if (authorization.kind !== "redirect") throw new Error("Expected a fresh sign-in")
    expect(new Set(authorization.scope?.split(" "))).toEqual(
      new Set(["issues:read", "issues:write"]),
    )
    const redirect = await backendFetch(authorization.authorizationUrl)
    expect(redirect.status).toBe(303)
    const requestId = (redirect.headers.get("location") ?? "").slice("/#issues-mcp=".length)
    const [cookie = ""] = (redirect.headers.get("set-cookie") ?? "").split(";")
    const headers = passkey()
    headers.cookie += `; ${cookie}`
    const consent = await call(`${consentPath}?requestId=${requestId}`, "GET", undefined, headers)
    expect(await consent.json()).toMatchObject({ scope: "issues:write" })
    const approved = await call(consentPath, "POST", { requestId, approve: true }, headers)
    expect(approved.status).toBe(200)
    const { redirect: callback } = (await approved.json()) as { redirect: string }
    const params = new URL(callback).searchParams
    await completeMcpSignIn({
      ...options,
      authorization,
      response: {
        code: params.get("code") ?? "",
        state: params.get("state") ?? "",
        iss: params.get("iss") ?? "",
      },
    })
    const tokens = store.load()?.tokens
    expect(tokens?.scope).toBe("issues:write")
    if (!tokens?.access_token) throw new Error("Expected a Pi access token")
    const client = await connect(tokens.access_token)
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain("update_issue")
  } finally {
    fetch.mockRestore()
  }
})

it("requires public registration claims and rejects unauthorized callback paths and hosts", async () => {
  const ipv4 = await register()
  const localhost = await register("http://localhost:12345/callback")
  const ipv6 = await register("http://[::1]:12345/callback")
  expect(new Set([ipv4.clientId, localhost.clientId, ipv6.clientId]).size).toBe(3)
  for (const invalid of [
    { redirect_uris: ["http://external.example.test:12345/callback"] },
    { redirect_uris: ["http://127.0.0.1/callback"] },
    { redirect_uris: ["https://127.0.0.1:12345/callback"] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["implicit"] },
    { response_types: ["token"] },
  ]) {
    await expectOAuthError(
      await call(`${oauthPath}/register`, "POST", { ...registration, ...invalid }),
    )
  }

  for (const [key, value] of [
    ["redirect_uri", "http://localhost:12345/callback"],
    ["redirect_uri", "http://127.0.0.1:12345/other"],
    ["redirect_uri", "http://external.example.test:12345/callback"],
    ["client_id", randomBytes(32).toString("base64url")],
  ] as const) {
    const { params } = authorization(ipv4, "issues:read")
    params.set(key, value)
    const response = await authorize(params)
    await expectOAuthError(response)
    expect(response.headers.has("location")).toBe(false)
  }
  const { params } = authorization({ ...localhost, redirectUri: "http://localhost:12346/callback" })
  await expectOAuthError(await authorize(params))
})

it("returns OAuth errors only after validating the registered callback", async () => {
  const client = await register()
  for (const [key, value, error] of [
    ["response_type", "token", "unsupported_response_type"],
    ["code_challenge_method", "plain", "invalid_request"],
    ["resource", origin, "invalid_target"],
    ["scope", "unknown", "invalid_scope"],
    ["state", `${"a".repeat(507)}&x=ä +`, "invalid_request"],
    ["state", "", "invalid_request"],
  ] as const) {
    const { params } = authorization(client)
    params.set(key, value)
    const state = params.get("state")
    const response = await authorize(params)
    expect(response.status).toBe(303)
    expect(response.headers.has("set-cookie")).toBe(false)
    const callback = new URL(response.headers.get("location") ?? "")
    expect(`${callback.origin}${callback.pathname}`).toBe(client.redirectUri)
    expect(Object.fromEntries(callback.searchParams)).toEqual({ state, iss: origin, error })
  }
})

it("reclaims idle registrations without evicting pending consent, live grants, or approved codes", async () => {
  const db = fixture.factory.control.db
  const granted = await register()
  const tokens = await issueTokens(granted)
  const approved = await register()
  const code = await authorizeCode(approved)
  const reviewing = await register()
  const pending = await beginAuthorization(reviewing)
  const provisional = db.prepare("INSERT INTO issues_oauth_clients VALUES (?,?,?,?,?)")
  const oldest = randomBytes(32).toString("base64url")
  const now = Date.now()
  db.prepare("UPDATE issues_oauth_clients SET expires=? WHERE id=?").run(
    now + 60_000,
    reviewing.clientId,
  )
  for (let i = 0; i < 255; i++) {
    provisional.run(
      i === 0 ? oldest : randomBytes(32).toString("base64url"),
      origin,
      "Provisional",
      JSON.stringify([loopbackCallback]),
      now + 300_000 + i,
    )
  }
  await register()
  await register()
  const fresh = await register()
  expect(db.prepare("SELECT id FROM issues_oauth_clients WHERE id=?").get(oldest)).toBeUndefined()
  await beginAuthorization(fresh)
  const review = await call(
    `${consentPath}?requestId=${pending.requestId}`,
    "GET",
    undefined,
    consentHeaders(pending),
  )
  expect(review.status).toBe(200)
  expect((await callback(await decide(pending, true), reviewing, pending)).has("code")).toBe(true)
  await readTokens(await form(`${oauthPath}/token`, code))
  expect((await call(mcpPath, "POST", initialize, bearer(tokens.access_token))).status).toBe(200)
})

it("rejects another registration when every provisional slot has pending consent", async () => {
  const db = fixture.factory.control.db
  const reviewing = await register()
  const pending = await beginAuthorization(reviewing)
  const expires = Date.now() + 60_000
  const addClient = db.prepare("INSERT INTO issues_oauth_clients VALUES (?,?,?,?,?)")
  const addPending = db.prepare(`INSERT INTO issues_oauth_requests
    (id,browser,client,actor,redirect,challenge,scope,state,expires) VALUES (?,?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 255; i++) {
    const id = randomUUID()
    addClient.run(id, origin, "Pending fixture", JSON.stringify([loopbackCallback]), expires)
    addPending.run(
      randomUUID(),
      "browser-fixture",
      id,
      "7",
      loopbackCallback,
      "challenge-fixture",
      "issues:read",
      "state-fixture",
      expires,
    )
  }
  const response = await call(`${oauthPath}/register`, "POST", registration)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: "temporarily_unavailable" })
  expect((await callback(await decide(pending, false), reviewing, pending)).get("error")).toBe(
    "access_denied",
  )
  await register()
})

it("limits pending consent per client without using or deleting an approved code", async () => {
  const client = await register()
  const code = await authorizeCode(client)
  const other = await register()
  for (let i = 0; i < 4; i++) await beginAuthorization(client)
  const { params, state } = authorization(client)
  const response = await authorize(params)
  expect(response.status).toBe(303)
  const callback = new URL(response.headers.get("location") ?? "")
  expect(callback.searchParams.get("error")).toBe("temporarily_unavailable")
  expect(callback.searchParams.get("state")).toBe(state)
  await beginAuthorization(other)
  await readTokens(await form(`${oauthPath}/token`, code))
})

it.each(["127.0.0.1", "[::1]"])(
  "allows a new native loopback port on %s but binds the code to that port",
  async (host) => {
    const registered = await register(`http://${host}:12345/callback`)
    const redirectUri = `http://${host}:12346/callback`
    const code = await authorizeCode({ ...registered, redirectUri })
    await expectOAuthError(
      await form(`${oauthPath}/token`, { ...code, redirect_uri: registered.redirectUri }),
    )
    await readTokens(await form(`${oauthPath}/token`, code))
  },
)

it("defaults to read and requires the pending browser cookie, Passkey session and CSRF for consent", async () => {
  const client = await register()
  const pending = await beginAuthorization(client)
  const otherBrowser = await beginAuthorization(client)
  expect(otherBrowser.cookie).not.toBe(pending.cookie)
  const headers = consentHeaders(pending)
  const consentUrl = `${consentPath}?requestId=${pending.requestId}`
  expect((await call(consentUrl, "GET", undefined, { cookie: pending.cookie })).status).toBe(401)
  expect((await decide(pending, true, { ...headers, cookie: pending.cookie })).status).toBe(401)
  for (const wrong of [passkey(), consentHeaders(otherBrowser)]) {
    expect((await call(consentUrl, "GET", undefined, wrong)).status).toBeOneOf([400, 403, 404])
    expect((await decide(pending, true, wrong)).status).toBeOneOf([400, 403, 404])
  }
  expect((await decide(pending, true, { ...headers, "x-csrf-token": "wrong" })).status).toBe(403)
  expect(
    (await decide(pending, true, { ...headers, origin: "https://elsewhere.example" })).status,
  ).toBe(403)
  const details = await call(consentUrl, "GET", undefined, headers)
  expect(details.status).toBe(200)
  expect(await details.json()).toEqual({
    clientName: registration.client_name,
    redirectUri: client.redirectUri,
    scope: "issues:read",
  })

  const denied = await callback(await decide(pending, false), client, pending)
  expect(denied.get("error")).toBe("access_denied")
  expect(denied.has("code")).toBe(false)
  expect((await decide(pending, true)).status).toBeOneOf([400, 403, 404])
  expect(await (await call(grantsPath, "GET", undefined, passkey())).json()).toMatchObject({
    grants: [],
  })
})

it("binds each code to its PKCE verifier, resource, client and exact redirect URI, and disallows replay", async () => {
  const client = await register()
  const otherClient = await register()
  for (const invalid of [
    { code_verifier: randomBytes(32).toString("base64url") },
    { resource: origin },
    { client_id: otherClient.clientId },
    { redirect_uri: "http://127.0.0.1:12345/other" },
  ]) {
    const code = await authorizeCode(client, "issues:read")
    await expectOAuthError(await form(`${oauthPath}/token`, { ...code, ...invalid }))
  }
  const code = await authorizeCode(client, "issues:read")
  const tokens = await readTokens(await form(`${oauthPath}/token`, code))
  expect((await call(mcpPath, "POST", initialize, bearer(tokens.access_token))).status).toBe(200)
  await expectOAuthError(await form(`${oauthPath}/token`, code))
})

it("rotates refresh tokens and revokes the grant on refresh token reuse", async () => {
  const client = await register()
  const first = await issueTokens(client)
  const refresh = refreshGrant(client, first.refresh_token)
  await expectOAuthError(await form(`${oauthPath}/token`, { ...refresh, scope: "issues:write" }))
  await expectOAuthError(await form(`${oauthPath}/token`, { ...refresh, resource: origin }))
  const second = await readTokens(
    await form(`${oauthPath}/token`, { ...refresh, scope: "issues:read" }),
  )
  expect(second.access_token).not.toBe(first.access_token)
  expect(second.refresh_token).not.toBe(first.refresh_token)
  expect((await call(mcpPath, "POST", initialize, bearer(second.access_token))).status).toBe(200)

  await expectOAuthError(await form(`${oauthPath}/token`, refresh))
  expect((await call(mcpPath, "POST", initialize, bearer(first.access_token))).status).toBe(401)
  expect((await call(mcpPath, "POST", initialize, bearer(second.access_token))).status).toBe(401)
  await expectOAuthError(
    await form(`${oauthPath}/token`, refreshGrant(client, second.refresh_token)),
  )
})

it("revokes individual grants via the OAuth endpoint or the Passkey-protected grants API", async () => {
  const readClient = await register()
  const writeClient = await register("http://localhost:12345/callback")
  const reader = await issueTokens(readClient)
  const writer = await issueTokens(writeClient, "issues:write")
  const writeAuth = bearer(writer.access_token)
  expect((await call(grantsPath, "GET", undefined, writeAuth)).status).toBe(401)
  const list = await call(grantsPath, "GET", undefined, passkey())
  expect(list.status).toBe(200)
  const { grants } = (await list.json()) as { grants: { id: string; scope: Scope }[] }
  expect(grants).toHaveLength(2)
  expect(grants).toEqual(
    expect.arrayContaining([
      {
        id: expect.any(String),
        clientName: registration.client_name,
        redirectUri: readClient.redirectUri,
        scope: "issues:read",
        expiresAt: expect.any(Number),
      },
      {
        id: expect.any(String),
        clientName: registration.client_name,
        redirectUri: writeClient.redirectUri,
        scope: "issues:write",
        expiresAt: expect.any(Number),
      },
    ]),
  )
  const id = grants.find((grant) => grant.scope === "issues:write")?.id
  expect(id).toBeDefined()
  expect((await call(grantsPath, "DELETE", { id }, writeAuth)).status).toBe(401)
  expect(
    (await call(grantsPath, "DELETE", { id }, { ...passkey(), "x-csrf-token": "wrong" })).status,
  ).toBe(403)
  expect((await call(grantsPath, "DELETE", { id }, passkey())).status).toBeOneOf([200, 204])
  expect((await call(mcpPath, "POST", initialize, writeAuth)).status).toBe(401)
  await expectOAuthError(
    await form(`${oauthPath}/token`, refreshGrant(writeClient, writer.refresh_token)),
  )
  expect((await call(mcpPath, "POST", initialize, bearer(reader.access_token))).status).toBe(200)

  expect(
    (
      await form(`${oauthPath}/revoke`, {
        client_id: readClient.clientId,
        token: reader.refresh_token,
      })
    ).status,
  ).toBe(200)
  expect((await call(mcpPath, "POST", initialize, bearer(reader.access_token))).status).toBe(401)
  await expectOAuthError(
    await form(`${oauthPath}/token`, refreshGrant(readClient, reader.refresh_token)),
  )
  expect(await (await call(grantsPath, "GET", undefined, passkey())).json()).toMatchObject({
    grants: [],
  })
})

it("works with the MCP SDK client and leaves original feedback intact when editing metadata", async () => {
  const screenshot = PNG.toString("base64")
  const response = await call(
    "/api/issues",
    "POST",
    {
      requestId: randomUUID(),
      description: "原始回饋\n保留這段文字",
      screenshot,
      source: { section: "Chats", viewport: { width: 1000, height: 800 } },
    },
    passkey(),
  )
  expect(response.status).toBe(201)
  const issue = (await response.json()) as Issue
  const client = await register()
  const reader = await connect((await issueTokens(client)).access_token)
  const writer = await connect((await issueTokens(client, "issues:write")).access_token)
  expect((await reader.listTools()).tools.map(({ name }) => name)).toEqual([
    "list_issues",
    "get_issue",
    "get_issue_screenshot",
  ])
  const tools = (await writer.listTools()).tools
  expect(tools.find(({ name }) => name === "delete_issue")?.annotations?.destructiveHint).toBe(true)
  const input = { id: issue.id, revision: issue.revision }
  expect(
    (await reader.callTool({ name: "list_issues", arguments: { state: "open" } }))
      .structuredContent,
  ).toMatchObject({ issues: [{ id: issue.id, hasScreenshot: true }], next: null })
  expect(
    (await reader.callTool({ name: "list_issues", arguments: { before: issue.id } }))
      .structuredContent,
  ).toEqual({ issues: [], next: null })
  expect(
    (await reader.callTool({ name: "get_issue", arguments: { id: issue.id } })).structuredContent,
  ).toEqual(issue)
  expect(
    (await reader.callTool({ name: "get_issue_screenshot", arguments: { id: issue.id } })).content,
  ).toEqual([{ type: "image", mimeType: "image/png", data: screenshot }])
  const forbidden = await reader
    .callTool({ name: "update_issue", arguments: { ...input, state: "closed" } })
    .catch((error: unknown) => {
      expect(error).toMatchObject({ code: 403 })
      return { isError: true }
    })
  expect(forbidden.isError).toBe(true)
  expect(
    (await reader.callTool({ name: "get_issue", arguments: { id: issue.id } })).structuredContent,
  ).toEqual(issue)
  expect(
    (
      await writer.callTool({
        name: "update_issue",
        arguments: { ...input, description: "overwrite" },
      })
    ).isError,
  ).toBe(true)
  expect(
    (
      await writer.callTool({
        name: "update_issue",
        arguments: { ...input, title: "New title", state: "closed" },
      })
    ).structuredContent,
  ).toMatchObject({
    title: "New title",
    state: "closed",
    description: issue.description,
    revision: 2,
    hasScreenshot: true,
  })
  expect(
    (await reader.callTool({ name: "get_issue_screenshot", arguments: { id: issue.id } })).content,
  ).toEqual([{ type: "image", mimeType: "image/png", data: screenshot }])
  const analysis = await (
    await call(`/api/issues/${issue.id}/analysis`, "GET", undefined, passkey())
  ).json()
  expect(analysis).toMatchObject({ analyses: [{ state: "cancelled", reason: "issue_closed" }] })
  expect(
    (
      await writer.callTool({
        name: "update_issue",
        arguments: { ...input, title: "Stale revision" },
      })
    ).isError,
  ).toBe(true)
  expect(
    (await writer.callTool({ name: "delete_issue", arguments: { id: issue.id, revision: 2 } }))
      .isError,
  ).toBe(true)
  expect(
    (await writer.callTool({ name: "delete_issue", arguments: { ...input, confirmDelete: true } }))
      .isError,
  ).toBe(true)
  expect(
    (
      await writer.callTool({
        name: "delete_issue",
        arguments: { id: issue.id, revision: 2, confirmDelete: true },
      })
    ).structuredContent,
  ).toEqual({ id: issue.id, deleted: true })
  expect((await call(`/api/issues/${issue.id}`, "GET", undefined, passkey())).status).toBe(404)
  expect(
    (await reader.callTool({ name: "get_issue_screenshot", arguments: { id: issue.id } })).isError,
  ).toBe(true)
  expect(fixture.requests).toHaveLength(0)
})

it.each(["close", "delete"] as const)(
  "reports a committed %s after the access token rotates",
  async (action) => {
    await server.stop()
    const worker = new IssueAnalysisRuntime({
      store: fixture.factory.control,
      runtime: fixture.modelRuntime,
      directory: path.join(fixture.root, "issue-mcp-sessions"),
    })
    const entered = deferred<void>()
    const finish = deferred<void>()
    vi.spyOn(worker, "changed").mockImplementation(async () => {
      entered.resolve()
      await finish.promise
    })
    await start(origin, worker)
    const issue = (await (
      await call(
        "/api/issues",
        "POST",
        {
          requestId: randomUUID(),
          description: "Private feedback",
          source: { section: "Chats", viewport: { width: 1000, height: 800 } },
        },
        passkey(),
      )
    ).json()) as Issue
    const oauth = await register()
    const tokens = await issueTokens(oauth, "issues:write")
    const writer = await connect(tokens.access_token)
    const input = { id: issue.id, revision: issue.revision }
    const result = writer.callTool(
      action === "close"
        ? { name: "update_issue", arguments: { ...input, state: "closed" } }
        : { name: "delete_issue", arguments: { ...input, confirmDelete: true } },
    )
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("Write did not reach the analysis worker")
        }),
      ])
      await readTokens(await form(`${oauthPath}/token`, refreshGrant(oauth, tokens.refresh_token)))
    } finally {
      finish.resolve()
    }
    const receipt = await result
    expect(receipt.isError).not.toBe(true)
    expect(receipt.structuredContent).toEqual(
      action === "close" ? { id: issue.id, updated: true } : { id: issue.id, deleted: true },
    )
    expect(JSON.stringify(receipt)).not.toContain("Private feedback")
    const current = await call(`/api/issues/${issue.id}`, "GET", undefined, passkey())
    if (action === "close") expect(await current.json()).toMatchObject({ state: "closed" })
    else expect(current.status).toBe(404)
  },
)

it("requires a Bearer token and an allowed origin on the stateless MCP transport", async () => {
  const unauthenticated = await call(mcpPath, "POST", initialize, { ...mcpHeaders, ...passkey() })
  expect(unauthenticated.status).toBe(401)
  const challenge = unauthenticated.headers.get("www-authenticate")
  expect(challenge).toMatch(/^Bearer\b/i)
  expect(challenge).toContain(`resource_metadata="${origin}${resourceMetadataPath}"`)
  expect(challenge).toContain('scope="issues:read"')
  const { access_token } = await issueTokens(await register(), "issues:read")
  const auth = bearer(access_token)
  const response = await call(mcpPath, "POST", initialize, { ...auth, origin })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(
    (await call(mcpPath, "POST", initialize, { ...auth, origin: "https://elsewhere.example" }))
      .status,
  ).toBe(403)
  expect(
    (await call(mcpPath, "POST", initialize, { ...auth, "sec-fetch-site": "cross-site" })).status,
  ).toBe(403)
  expect(
    (await call(mcpPath, "POST", initialize, { ...auth, host: "elsewhere.example" })).status,
  ).toBe(400)
  expect((await call("/api/issues", "GET", undefined, auth)).status).toBe(401)
  expect((await call(mcpPath, "GET", undefined, auth)).status).toBe(405)
  expect((await call(mcpPath, "POST", [initialize], auth)).status).toBe(400)
  expect((await call(mcpPath, "POST", { data: "x".repeat(16_384) }, auth)).status).toBe(413)
  expect(
    (await call(`${mcpPath}?access_token=${access_token}`, "POST", initialize, mcpHeaders)).status,
  ).toBe(404)
})

it("does not expose OAuth discovery or MCP for a local HTTP admin origin", async () => {
  await server.stop()
  await start("http://localhost:17465")
  expect((await call(resourceMetadataPath, "GET")).status).toBe(404)
  expect((await call(serverMetadataPath, "GET")).status).toBe(404)
  expect((await call(`${oauthPath}/register`, "POST", registration)).status).toBe(404)
  expect((await call(mcpPath, "POST", initialize, mcpHeaders)).status).toBe(404)
})
