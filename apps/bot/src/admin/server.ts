import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import type {
  ChatResponse,
  DurableInspectionQuery,
  DurableInspectionResponse,
  ImportReport,
  Inventory,
} from "@narumitw/sumire-contracts"
import { decodeImage } from "@narumitw/sumire-imagegen"
import {
  analysisCancelSchema,
  analysisRequestSchema,
  analysisSelectionSchema,
  feedbackSchema,
  issueDeletionSchema,
  issueMutationSchema,
  issueState,
  MAX_SCREENSHOT_BYTES,
} from "@narumitw/sumire-issues"
import { AnalysisStore } from "@narumitw/sumire-issues/analysis-store"
import { IssueError, IssueStore } from "@narumitw/sumire-issues/store"
import { effectivePolicy, policySchema } from "@narumitw/sumire-policy"
import { z } from "zod"
import type { IssueAnalysisRuntime } from "../issues/runtime.js"
import { accessTokenPattern, ChatAccess } from "./access.js"
import { auditFilters } from "./audit-query.js"
import { type AdminConfig, PasskeyAdminLogin } from "./auth.js"
import { parseChatQuery } from "./chat-query.js"
import { parseDurableInspectionQuery } from "./durable-inspector.js"
import type { GitHubAuth } from "./github-auth.js"
import { handleIssueMcp } from "./issue-mcp.js"
import {
  authorizationMetadataPath,
  IssueMcpOAuth,
  issueMcpPath,
  OAuthError,
  oauthPath,
  opaqueId,
  resourceMetadataPath,
  writeScope,
} from "./issue-mcp-oauth.js"
import type { McpAdmin } from "./mcp.js"
import type { ProviderAdmin } from "./providers.js"
import type { RuntimeConfigAdmin } from "./runtime-config.js"
import { AdminError, type AdminStore, digest, sessionMaxAgeMs } from "./store.js"

interface AdminServices {
  store: AdminStore
  providers: ProviderAdmin
  mcp: McpAdmin
  runtime?: RuntimeConfigAdmin
  github?: GitHubAuth
  analysis?: IssueAnalysisRuntime
  apply(): Promise<void>
  tools(): string[]
  toolAvailability?(): Promise<Inventory["toolAvailability"]>
  skills?(): Inventory["skills"]
  inspectDurable?(
    chatId: number,
    query: DurableInspectionQuery,
    signal: AbortSignal,
  ): Promise<DurableInspectionResponse>
}
const cookie = (
  name: string,
  value: string,
  seconds: number,
  sameSite: "Strict" | "Lax" = "Strict",
) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${seconds}`
const oauthBrowserCookie = "__Host-sumire-issues-oauth"
const readCookie = (req: IncomingMessage, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? ""
const offset = (url: URL) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .parse(url.searchParams.get("offset") ?? 0)

async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > limit) throw new AdminError(413, "Request is too large")
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString()
}

async function body(req: IncomingMessage, limit = 262144) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new AdminError(415, "JSON is required")
  const input = await readBody(req, limit)
  try {
    return JSON.parse(input) as unknown
  } catch {
    throw new AdminError(400, "Invalid JSON")
  }
}

function oauthParameters(params: URLSearchParams) {
  const values = Object.create(null) as Record<string, string>
  for (const [name, value] of params) {
    if (Object.hasOwn(values, name)) throw new OAuthError("invalid_request")
    values[name] = value
  }
  return values
}

async function oauthForm(req: IncomingMessage) {
  if (
    req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    throw new OAuthError("invalid_request")
  if (req.headers.authorization !== undefined) throw new OAuthError("invalid_client")
  return oauthParameters(new URLSearchParams(await readBody(req, 4096)))
}

const reply = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(value))
}

export function createAdminServer(config: AdminConfig, services: AdminServices) {
  const { store, providers, mcp } = services
  services.github?.configure(services.apply, () => Boolean(mcp.probes.size))
  const issues = new IssueStore(
    store.db,
    (actor, operation, id) =>
      store.audit(actor, operation, store.snapshot().revision, "completed", `issue:${id}`),
    () => store.snapshot().revision,
  )
  const analyses = services.analysis?.analyses ?? new AnalysisStore(store.db)
  const issueOAuth = new IssueMcpOAuth(store, config.origin)
  const login = new PasskeyAdminLogin(config, store)
  const access = new ChatAccess(store)
  const buckets = new Map<string, { start: number; count: number }>()
  const limited = (key: string, max: number) => {
    const now = Date.now()
    for (const [k, v] of buckets) if (v.start < now - 60_000) buckets.delete(k)
    const bucket = buckets.get(key) ?? { start: now, count: 0 }
    if (buckets.size >= 1024 && !buckets.has(key)) throw new AdminError(429, "Too many requests")
    bucket.count++
    buckets.set(key, bucket)
    if (bucket.count > max) throw new AdminError(429, "Too many requests")
  }
  const handlers = new Set<Promise<void>>()
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 15_000, headersTimeout: 10_000 },
    (req, res) => {
      res.setHeader("cache-control", "no-store")
      res.setHeader("x-content-type-options", "nosniff")
      res.setHeader("referrer-policy", "no-referrer")
      if (new URL(config.origin).protocol === "https:")
        res.setHeader("strict-transport-security", "max-age=31536000")
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
      const handled = handle(req, res)
        .catch((error: unknown) => {
          if (res.headersSent) {
            res.destroy()
            return
          }
          if (error instanceof OAuthError) {
            reply(res, error.status, { error: error.code })
            return
          }
          const status =
            error instanceof AdminError || error instanceof IssueError
              ? error.status
              : error instanceof z.ZodError
                ? 400
                : 500
          if (status === 429) res.setHeader("retry-after", "60")
          if (status === 413) {
            // With unread body bytes, flush the error then let HTTP close the socket, never reuse it.
            res.shouldKeepAlive = false
            res.setHeader("connection", "close")
          }
          reply(res, status, {
            error:
              error instanceof AdminError || error instanceof IssueError
                ? error.message
                : status === 400
                  ? "Invalid request"
                  : "Operation failed",
          })
        })
        .finally(() => {
          handlers.delete(handled)
        })
      handlers.add(handled)
    },
  )
  const inspectionShutdown = new AbortController()
  let stopping = false
  let closing: Promise<void> | undefined
  server.keepAliveTimeout = 5000
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (stopping) throw new AdminError(503, "Server is stopping")
    const url = new URL(req.url ?? "/", config.origin)
    const method = req.method ?? "GET"
    if (url.origin !== config.origin || req.headers.host !== new URL(config.origin).host)
      throw new AdminError(400, "Invalid host")
    if (!["GET", "POST", "PUT", "DELETE"].includes(method))
      throw new AdminError(405, "Method not allowed")
    limited(`all:${req.socket.remoteAddress}`, 240)
    if (url.pathname === "/healthz" && method === "GET") {
      reply(res, 200, { ok: true })
      return
    }
    if (url.pathname === resourceMetadataPath || url.pathname === authorizationMetadataPath) {
      if (!issueOAuth.endpoint || url.search) throw new AdminError(404, "Not found")
      if (method !== "GET") throw new AdminError(405, "Method not allowed")
      const metadata =
        url.pathname === resourceMetadataPath
          ? issueOAuth.resourceMetadata()
          : issueOAuth.authorizationMetadata()
      reply(res, 200, metadata)
      return
    }
    if (url.pathname.startsWith(`${oauthPath}/`)) {
      if (!issueOAuth.endpoint) throw new AdminError(404, "Not found")
      if (url.pathname === `${oauthPath}/authorize` && method === "GET") {
        if (req.headers["sec-fetch-mode"] && req.headers["sec-fetch-mode"] !== "navigate")
          throw new OAuthError("invalid_request")
        if ((req.url?.length ?? 0) > 4096) throw new OAuthError("invalid_request")
        limited(`issues-oauth-authorize:${req.socket.remoteAddress}`, 20)
        const request = issueOAuth.begin(
          oauthParameters(url.searchParams),
          readCookie(req, oauthBrowserCookie),
        )
        if (request.kind === "error") {
          res.writeHead(303, { location: request.redirect }).end()
          return
        }
        res.setHeader(
          "set-cookie",
          cookie(oauthBrowserCookie, request.browser, request.seconds, "Lax"),
        )
        res.writeHead(303, { location: `/#issues-mcp=${request.id}` }).end()
        return
      }
      if (method !== "POST" || url.search) throw new OAuthError("invalid_request")
      if (
        (req.headers.origin !== undefined && req.headers.origin !== config.origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new OAuthError("invalid_request", 403)
      if (url.pathname === `${oauthPath}/register`) {
        limited(`issues-oauth-register:${req.socket.remoteAddress}`, 12)
        reply(res, 201, issueOAuth.register(await body(req, 8192)))
      } else if (url.pathname === `${oauthPath}/token`) {
        limited(`issues-oauth-token:${req.socket.remoteAddress}`, 40)
        res.setHeader("pragma", "no-cache")
        reply(res, 200, issueOAuth.exchange(await oauthForm(req)))
      } else if (url.pathname === `${oauthPath}/revoke`) {
        limited(`issues-oauth-token:${req.socket.remoteAddress}`, 40)
        issueOAuth.revoke(await oauthForm(req))
        res.writeHead(200).end()
      } else throw new AdminError(404, "Not found")
      return
    }
    if (url.pathname === issueMcpPath) {
      if (!issueOAuth.endpoint || url.search) throw new AdminError(404, "Not found")
      if (
        (req.headers.origin !== undefined && req.headers.origin !== config.origin) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new AdminError(403, "Invalid MCP request origin")
      const authenticate = () => issueOAuth.authenticate(req.headers.authorization)
      const requireAccess = () => {
        const credential = authenticate()
        if (!credential) {
          res.setHeader(
            "www-authenticate",
            issueOAuth.challenge(req.headers.authorization ? "invalid_token" : undefined),
          )
          throw new AdminError(401, "An Issues MCP OAuth access token is required")
        }
        return credential
      }
      requireAccess()
      if (method !== "POST") {
        res.setHeader("allow", "POST")
        throw new AdminError(405, "Method not allowed")
      }
      const input = await body(req, 16384)
      const credential = requireAccess()
      limited(`issues-mcp:${credential.scope}`, 60)
      if (Array.isArray(input)) throw new AdminError(400, "MCP batch requests are not supported")
      const request = z
        .object({
          jsonrpc: z.literal("2.0"),
          method: z.literal("tools/call"),
          params: z.object({ name: z.enum(["update_issue", "delete_issue"]) }),
        })
        .safeParse(input)
      if (request.success && credential.scope !== writeScope) {
        res.setHeader("www-authenticate", issueOAuth.challenge("insufficient_scope"))
        throw new AdminError(403, "Issues MCP write access is required")
      }
      await handleIssueMcp(req, res, input, {
        issues,
        scope: credential.scope,
        authenticate,
        changed: async (id) => services.analysis?.changed(id),
        limitScreenshot: () => limited(`issues-mcp-screenshot:${credential.scope}`, 20),
      })
      return
    }
    const passkeyRoute = /^\/auth\/passkey\/(register|authenticate)\/(options|verify)$/.exec(
      url.pathname,
    )
    if (passkeyRoute) {
      if (method !== "POST") throw new AdminError(405, "Method not allowed")
      if (req.headers.origin !== config.origin || req.headers["sec-fetch-site"] === "cross-site")
        throw new AdminError(403, "Request verification failed")
      const starting = passkeyRoute[2] === "options"
      limited(`${starting ? "login" : "verify"}:${req.socket.remoteAddress}`, starting ? 10 : 20)
      const input = await body(req, 32768)
      const registering = passkeyRoute[1] === "register"
      if (starting) {
        if (!registering) z.object({}).strict().parse(input)
        const start = registering
          ? await login.beginRegistration(
              z
                .object({ setup: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
                .strict()
                .parse(input).setup,
            )
          : await login.beginAuthentication()
        res.setHeader("set-cookie", cookie("__Host-sumire-passkey", start.browser, 300))
        reply(res, 200, start.options)
        return
      }
      const response = z
        .object({ response: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(input).response
      const browser = readCookie(req, "__Host-sumire-passkey")
      const actor = registering
        ? await login.finishRegistration(
            browser,
            response as unknown as import("@simplewebauthn/server").RegistrationResponseJSON,
          )
        : await login.finishAuthentication(
            browser,
            response as unknown as import("@simplewebauthn/server").AuthenticationResponseJSON,
          )
      const old = readCookie(req, "__Host-sumire-session")
      store.revoke(old)
      await providers.cancelOwner(digest(old))
      await services.github?.cancelOwner(digest(old))
      const session = store.createSession(actor)
      store.audit(actor, "admin.login", store.snapshot().revision, "completed", "administrator")
      res.setHeader("set-cookie", [
        cookie("__Host-sumire-session", session.value, sessionMaxAgeMs / 1000),
        cookie("__Host-sumire-passkey", "", 0),
      ])
      reply(res, 200, { csrf: session.csrf, actor })
      return
    }
    if (!url.pathname.startsWith("/api/")) {
      if (method !== "GET") throw new AdminError(405, "Method not allowed")
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
      if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css|svg))$/.test(name))
        throw new AdminError(404, "Not found")
      const file = path.join(config.assets, name)
      const metadata = await stat(file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          throw new AdminError(404, "Not found")
        throw error
      })
      if (metadata.size > 4 * 1024 * 1024) throw new AdminError(500, "Asset exceeds limit")
      const data = await readFile(file)
      res.writeHead(200, {
        "content-type": name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html; charset=utf-8",
      })
      res.end(data)
      return
    }
    const sessionToken = readCookie(req, "__Host-sumire-session")
    const session = store.session(sessionToken)
    if (!session) {
      await providers.cancelOwner(digest(sessionToken))
      await services.github?.cancelOwner(digest(sessionToken))
      throw new AdminError(401, "Sign in with a passkey")
    }
    const owner = digest(sessionToken)
    const assertCurrentSession = () => {
      if (!store.sessionDeadline(owner)) throw new AdminError(401, "Administrator session expired")
    }
    if (method !== "GET") {
      if (req.headers.origin !== config.origin || req.headers["x-csrf-token"] !== session.csrf)
        throw new AdminError(403, "Request verification failed")
      limited(`write:${owner}`, 60)
    }
    if (url.pathname === "/api/issues-mcp/consent") {
      const browser = readCookie(req, oauthBrowserCookie)
      if (method === "GET") {
        const { requestId } = z
          .strictObject({ requestId: opaqueId })
          .parse(oauthParameters(url.searchParams))
        reply(res, 200, issueOAuth.review(requestId, browser, session.actor))
      } else if (method === "POST") {
        const { requestId, approve } = z
          .strictObject({ requestId: opaqueId, approve: z.boolean() })
          .parse(await body(req, 1024))
        assertCurrentSession()
        reply(res, 200, issueOAuth.decide(requestId, browser, session.actor, approve))
      } else throw new AdminError(405, "Method not allowed")
      return
    }
    if (url.pathname === "/api/issues-mcp/grants") {
      if (method === "GET") reply(res, 200, issueOAuth.grants(session.actor))
      else if (method === "DELETE") {
        const { id } = z.strictObject({ id: opaqueId }).parse(await body(req, 1024))
        assertCurrentSession()
        reply(res, 200, issueOAuth.revokeGrant(id, session.actor))
      } else throw new AdminError(405, "Method not allowed")
      return
    }
    if (url.pathname === "/api/issues" || url.pathname.startsWith("/api/issues/")) {
      if (url.pathname === "/api/issues") {
        if (method === "GET") {
          for (const key of url.searchParams.keys())
            if (!["before", "state"].includes(key) || url.searchParams.getAll(key).length !== 1)
              throw new AdminError(400, "Invalid issue filter")
          const before = url.searchParams.has("before")
            ? z.coerce.number().int().positive().safe().parse(url.searchParams.get("before"))
            : undefined
          const state = url.searchParams.has("state")
            ? issueState.parse(url.searchParams.get("state"))
            : undefined
          reply(res, 200, issues.list(before, state))
          return
        }
        if (method !== "POST") throw new AdminError(405, "Method not allowed")
        limited(`issue:${session.actor}`, 10)
        const input = feedbackSchema.parse(await body(req, 3 * 1024 * 1024))
        assertCurrentSession()
        let image: ReturnType<typeof decodeImage> | undefined
        if (input.screenshot) {
          try {
            image = decodeImage(input.screenshot, {
              maxBytes: MAX_SCREENSHOT_BYTES,
              maxDimension: 4096,
              maxPixels: 4_194_304,
            })
          } catch {
            throw new AdminError(
              400,
              "Use a valid PNG, JPEG or WebP screenshot up to 2 MiB and 4 megapixels",
            )
          }
        }
        assertCurrentSession()
        const result = issues.create(
          input,
          session.actor,
          image ? { bytes: image.bytes, mime: image.mimeType } : undefined,
        )
        void services.analysis?.wake()
        reply(res, result.created ? 201 : 200, result.issue)
        return
      }
      const route =
        /^\/api\/issues\/([1-9]\d*)(\/(?:screenshot|analysis(?:\/(?:cancel|select))?))?$/.exec(
          url.pathname,
        )
      if (!route) throw new AdminError(404, "Not found")
      const id = z.coerce.number().int().positive().safe().parse(route[1])
      if (route[2]?.startsWith("/analysis")) {
        if (route[2] === "/analysis" && method === "GET") {
          reply(res, 200, {
            available: services.analysis?.available ?? false,
            analyses: analyses.list(id),
          })
          return
        }
        if (method !== "POST") throw new AdminError(405, "Method not allowed")
        if (route[2] === "/analysis") {
          if (!services.analysis?.available)
            throw new AdminError(503, "Issue analysis worker is unavailable")
          limited(`issue-analysis:${session.actor}`, 6)
          const input = analysisRequestSchema.parse(await body(req, 16384))
          assertCurrentSession()
          services.analysis.request(id, input, session.actor)
        } else if (route[2] === "/analysis/cancel") {
          const input = analysisCancelSchema.parse(await body(req, 4096))
          assertCurrentSession()
          if (services.analysis)
            await services.analysis.cancel(id, input.analysisId, input.revision, session.actor)
          else analyses.cancel(id, input.analysisId, input.revision, session.actor)
          assertCurrentSession()
        } else {
          const input = analysisSelectionSchema.parse(await body(req, 4096))
          assertCurrentSession()
          analyses.select(id, input.analysisId, input.revision, input.proposal, session.actor)
        }
        reply(res, 200, {
          available: services.analysis?.available ?? false,
          analyses: analyses.list(id),
        })
      } else if (route[2]) {
        if (method !== "GET") throw new AdminError(405, "Method not allowed")
        const attachment = issues.attachment(id)
        res.writeHead(200, {
          "content-type": attachment.mime,
          "content-length": attachment.bytes.byteLength,
          "content-disposition": 'inline; filename="feedback"',
        })
        res.end(attachment.bytes)
      } else if (method === "GET") reply(res, 200, issues.get(id))
      else if (method === "PUT") {
        const input = issueMutationSchema.parse(await body(req, 4096))
        assertCurrentSession()
        const issue = issues.update(id, input.revision, input.state, session.actor)
        if (input.state === "closed") await services.analysis?.changed(id)
        assertCurrentSession()
        reply(res, 200, issue)
      } else if (method === "DELETE") {
        const input = issueDeletionSchema.parse(await body(req, 4096))
        assertCurrentSession()
        issues.delete(id, input.revision, session.actor)
        await services.analysis?.changed(id)
        assertCurrentSession()
        reply(res, 200, { ok: true })
      } else throw new AdminError(405, "Method not allowed")
      return
    }
    if (url.pathname === "/api/session" && method === "GET") {
      reply(res, 200, { csrf: session.csrf, actor: session.actor })
      return
    }
    if (url.pathname === "/api/logout" && method === "POST") {
      store.revoke(sessionToken)
      store.audit(
        session.actor,
        "admin.logout",
        store.snapshot().revision,
        "revoked",
        "administrator",
      )
      await providers.cancelOwner(owner)
      await services.github?.cancelOwner(owner)
      res.setHeader("set-cookie", cookie("__Host-sumire-session", "", 0))
      reply(res, 200, { ok: true })
      return
    }
    if (
      ["/api/access/resolve", "/api/access/approve"].includes(url.pathname) &&
      method === "POST"
    ) {
      const approving = url.pathname === "/api/access/approve"
      const schema = z.object({ token: z.string().regex(accessTokenPattern) })
      if (approving) {
        const input = schema
          .extend({ revision: z.number().int().positive() })
          .strict()
          .parse(await body(req, 4096))
        access.approve(input.token, config.origin, input.revision, session.actor)
        await services.apply()
        reply(res, 200, store.snapshot())
      } else {
        const input = schema.strict().parse(await body(req, 4096))
        reply(res, 200, {
          ...access.resolve(input.token, config.origin),
          revision: store.snapshot().revision,
        })
      }
      return
    }
    if (url.pathname.startsWith("/api/github/")) {
      const github = services.github
      if (!github) throw new AdminError(503, "GitHub authentication is unavailable")
      if (url.pathname === "/api/github/connection") {
        if (method !== "GET") throw new AdminError(405, "Method not allowed")
        reply(res, 200, github.connection(owner))
        return
      }
      if (url.pathname === "/api/github/oauth") {
        if (method !== "POST") throw new AdminError(405, "Method not allowed")
        const input = z
          .object({ revision: z.number().int().positive(), replace: z.boolean() })
          .strict()
          .parse(await body(req, 4096))
        assertCurrentSession()
        reply(res, 200, await github.start(owner, input.revision, input.replace))
        return
      }
      if (url.pathname === "/api/github/connection/disconnect") {
        if (method !== "POST") throw new AdminError(405, "Method not allowed")
        const input = z
          .object({ revision: z.number().int().positive(), confirm: z.literal(true) })
          .strict()
          .parse(await body(req, 4096))
        if (!services.runtime) throw new AdminError(503, "Runtime configuration is unavailable")
        if (mcp.probes.size) throw new AdminError(409, "Wait for the MCP connection test to finish")
        const references = [
          ...new Set([...mcp.references("GH_TOKEN"), ...mcp.references("GITHUB_OAUTH_STATE")]),
        ]
        if (references.length)
          throw new AdminError(409, `Referenced by MCP servers: ${references.join(", ")}`)
        assertCurrentSession()
        services.runtime.disconnectGitHub(input.revision, session.actor)
        github.invalidate()
        const saved = store.snapshot().revision
        try {
          await services.apply()
        } catch {
          const current = store.snapshot()
          if (
            current.revision === saved &&
            (current.status !== "applied" || current.applied !== saved)
          )
            store.applied(saved, false)
        }
        reply(res, 200, github.connection(owner))
        return
      }
      const flow = /^\/api\/github\/oauth\/([A-Za-z0-9_-]{43})(?:\/(complete|cancel))?$/.exec(
        url.pathname,
      )
      if (!flow) throw new AdminError(404, "Not found")
      if (!flow[2]) {
        if (method !== "GET") throw new AdminError(405, "Method not allowed")
        reply(res, 200, github.state(flow[1] as string, owner))
      } else {
        if (method !== "POST") throw new AdminError(405, "Method not allowed")
        z.object({})
          .strict()
          .parse(await body(req, 4096))
        assertCurrentSession()
        reply(
          res,
          200,
          await (flow[2] === "complete"
            ? github.complete(flow[1] as string, owner)
            : github.cancel(flow[1] as string, owner)),
        )
      }
      return
    }
    const runtimeRoute = /^\/api\/runtime-config(?:\/([^/]+))?$/.exec(url.pathname)
    if (runtimeRoute) {
      const name = runtimeRoute[1]
      if ((!name && method !== "GET") || (name && method !== "PUT" && method !== "DELETE"))
        throw new AdminError(405, "Method not allowed")
      const runtime = services.runtime
      if (!runtime) throw new AdminError(503, "Runtime configuration is unavailable")
      if (!name) {
        reply(res, 200, runtime.snapshot())
        return
      }
      const input = await body(req, 65536)
      assertCurrentSession()
      if (mcp.probes.size) throw new AdminError(409, "Wait for the MCP connection test to finish")
      if (method === "PUT") {
        const mutation = z
          .object({
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            kind: z.enum(["secret", "variable"]),
            value: z.string(),
          })
          .strict()
          .parse(input)
        runtime.save(name, mutation, session.actor)
      } else {
        const deletion = z
          .object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
          .strict()
          .parse(input)
        const references = mcp.references(name)
        if (references.length)
          throw new AdminError(409, `Referenced by MCP servers: ${references.join(", ")}`)
        runtime.remove(name, deletion.revision, session.actor)
      }
      services.github?.invalidate()
      const revision = runtime.snapshot().revision
      try {
        await services.apply()
      } catch {
        // Persistence has committed. Report saved state, not an ambiguous write failure.
        const current = store.snapshot()
        if (
          current.revision === revision &&
          (current.status !== "applied" || current.applied !== revision)
        )
          store.applied(revision, false)
      }
      reply(res, 200, runtime.snapshot())
      return
    }
    if (url.pathname === "/api/settings" && method === "GET") {
      reply(res, 200, store.snapshot())
      return
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const input = z
        .object({ revision: z.number().int().positive(), policy: z.unknown() })
        .strict()
        .parse(await body(req))
      const policy = policySchema.parse(input.policy)
      const previous = store.snapshot().policy
      if (
        [...providers.logins.values()].some((state) => state.status === "pending") &&
        JSON.stringify(previous.providers) !== JSON.stringify(policy.providers)
      )
        throw new AdminError(409, "Cancel the pending provider login before editing providers")
      for (const p of previous.providers)
        if (
          (!policy.providers.some((next) => next.id === p.id) ||
            (p.baseUrl && !policy.providers.find((next) => next.id === p.id)?.baseUrl)) &&
          policy.models.some((ref) => ref.startsWith(`${p.id}/`))
        )
          throw new AdminError(409, "Provider or custom endpoint is still referenced")
      await providers.validate(policy)
      store.save(policy, input.revision, session.actor)
      await services.apply()
      reply(res, 200, store.snapshot())
      return
    }
    if (url.pathname === "/api/apply" && method === "POST") {
      await services.apply()
      reply(res, 200, store.snapshot())
      return
    }
    const durableRoute = /^\/api\/chats\/(-?[1-9]\d*)\/durable$/.exec(url.pathname)
    if (durableRoute) {
      if (method !== "GET") throw new AdminError(405, "Durable inspection is read-only")
      const chatId = Number(durableRoute[1])
      if (!Number.isSafeInteger(chatId)) throw new AdminError(400, "Invalid chat ID")
      const query = parseDurableInspectionQuery(url.searchParams)
      if (!services.inspectDurable) throw new AdminError(503, "Durable inspection is unavailable")
      const remaining = session.created + sessionMaxAgeMs - Date.now()
      if (remaining <= 0) throw new AdminError(401, "Administrator session expired")
      const disconnected = new AbortController()
      const signal = AbortSignal.any([
        disconnected.signal,
        inspectionShutdown.signal,
        AbortSignal.timeout(Math.min(5000, remaining)),
      ])
      const abort = () => disconnected.abort()
      const close = () => {
        if (!res.writableEnded) abort()
      }
      req.once("aborted", abort)
      res.once("close", close)
      try {
        let result: DurableInspectionResponse
        try {
          result = await services.inspectDurable(chatId, query, signal)
        } catch (error) {
          if (!store.session(sessionToken))
            throw new AdminError(401, "Administrator session expired")
          if (stopping) throw new AdminError(503, "Server is stopping")
          if (signal.aborted)
            throw new AdminError(408, "Durable inspection was cancelled or expired")
          throw error
        }
        if (!store.session(sessionToken)) throw new AdminError(401, "Administrator session expired")
        if (stopping) throw new AdminError(503, "Server is stopping")
        if (signal.aborted) throw new AdminError(408, "Durable inspection was cancelled or expired")
        if (!res.destroyed) reply(res, 200, result)
      } finally {
        req.off("aborted", abort)
        res.off("close", close)
      }
      return
    }
    if (url.pathname === "/api/chats" && method === "GET") {
      const { offset, ...filters } = parseChatQuery(url.searchParams)
      const { policy } = store.snapshot()
      reply(
        res,
        200,
        store.listChats(offset, filters).map(
          (c): ChatResponse => ({
            ...c,
            effective: effectivePolicy(policy, c.id),
          }),
        ),
      )
      return
    }
    if (url.pathname === "/api/audit" && method === "GET") {
      reply(res, 200, store.listAudit(offset(url), auditFilters(url.searchParams)))
      return
    }
    if (url.pathname === "/api/inventory" && method === "GET") {
      reply(res, 200, {
        tools: [
          ...new Set([...services.tools(), ...mcp.inventory().flatMap((entry) => entry.tools)]),
        ],
        builtInTools: services.tools(),
        toolAvailability: await services.toolAvailability?.(),
        skills: services.skills?.(),
        providers: await providers.inventory(),
        mcp: mcp.inventory(),
      } satisfies Inventory)
      return
    }
    if (url.pathname === "/api/imports" && method === "GET") {
      reply(res, 200, [
        ...store.db
          .prepare("SELECT name,report FROM imports ORDER BY name")
          .all()
          .map((row) => ({ name: row.name as string, report: JSON.parse(String(row.report)) })),
        ...store.db
          .prepare(
            "SELECT revision,actor,reviewed,decisions FROM access_reviews ORDER BY reviewed DESC,revision DESC LIMIT 10",
          )
          .all()
          .map((row) => ({
            name: `environment-access:${row.revision}`,
            report: { ...row, decisions: JSON.parse(String(row.decisions)) },
          })),
      ] satisfies ImportReport[])
      return
    }
    const discoveryRoute = /^\/api\/mcp\/([A-Za-z0-9_-]{1,64})\/discover$/.exec(url.pathname)
    if (discoveryRoute && method === "POST") {
      reply(res, 200, await mcp.discover(discoveryRoute[1] as string))
      return
    }
    const mcpRoute = /^\/api\/mcp\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)
    if (mcpRoute && method === "DELETE") {
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await body(req))
      mcp.remove(mcpRoute[1] as string, input.revision, session.actor)
      await services.apply()
      reply(res, 200, { ok: true })
      return
    }
    if (mcpRoute && method === "PUT") {
      const input = z
        .object({ revision: z.number().int().positive(), config: z.unknown() })
        .strict()
        .parse(await body(req))
      mcp.save(mcpRoute[1] as string, input.config, input.revision, session.actor)
      await services.apply()
      reply(res, 200, { ok: true })
      return
    }
    const providerRoute =
      /^\/api\/providers\/([a-z][a-z0-9-]{0,63})\/(credential|test|discover|oauth)$/.exec(
        url.pathname,
      )
    if (providerRoute && method === "POST") {
      const id = providerRoute[1] as string
      const action = providerRoute[2]
      if (action === "credential") {
        if (
          [...providers.logins.values()].some(
            (state) => state.status === "pending" && state.provider === id,
          )
        )
          throw new AdminError(409, "Cancel the pending OAuth login first")
        const input = z
          .object({ key: z.string().max(8192).nullable(), revision: z.number().int().positive() })
          .strict()
          .parse(await body(req))
        providers.validateCredential(id, input.key)
        const revision = store.save(
          store.snapshot().policy,
          input.revision,
          session.actor,
          "provider.credential",
          `provider:${id}`,
        ).revision
        try {
          await providers.credential(id, input.key)
          await services.apply()
        } catch {
          store.applied(revision, false)
          throw new AdminError(500, "Provider credential change or application failed")
        }
        reply(res, 200, { ok: true })
        return
      }
      if (action === "test") {
        reply(res, 200, await providers.test(id))
        return
      }
      if (action === "discover") {
        reply(res, 200, await providers.discover(id))
        return
      }
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(await body(req))
      if (input.revision !== store.snapshot().revision)
        throw new AdminError(409, "Settings changed; reload before login")
      reply(res, 200, {
        id: providers.startLogin(
          id,
          owner,
          Math.min(session.created + sessionMaxAgeMs, Date.now() + 30 * 60_000),
        ),
      })
      return
    }
    const oauthRoute = /^\/api\/oauth\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)
    if (oauthRoute) {
      const state = providers.loginState(oauthRoute[1] as string, owner)
      if (method === "GET") {
        reply(res, 200, { status: state.status, event: state.event, prompt: state.prompt })
        return
      }
      if (method === "POST") {
        const input = z
          .object({ answer: z.string().max(8192).optional(), cancel: z.boolean().optional() })
          .strict()
          .parse(await body(req))
        if (input.cancel) state.controller.abort()
        else if (state.answer && input.answer !== undefined) state.answer(input.answer)
        else throw new AdminError(409, "No pending prompt")
        reply(res, 200, { ok: true })
        return
      }
    }
    throw new AdminError(404, "Not found")
  }
  return {
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(config.port, config.host, () => {
          server.off("error", reject)
          resolve()
        })
      })
      services.analysis?.start()
    },
    stop() {
      closing ??= (async () => {
        stopping = true
        inspectionShutdown.abort()
        const drained = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeIdleConnections()
        })
        const tasks = [
          () => providers.cancelOwner(),
          () => services.github?.close(),
          () => services.analysis?.close(),
          () => mcp.close(),
        ]
        const results = await Promise.allSettled([...tasks.map(async (close) => close()), drained])
        // An admitted handler can still use storage after its client disconnects.
        results.push(...(await Promise.allSettled(handlers)))
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        )
        if (failures.length) throw new AggregateError(failures, "Admin shutdown failed")
      })()
      return closing
    },
  }
}
