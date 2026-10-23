import { mkdtempSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { inherited } from "@narumitw/sumire-policy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatAccess } from "../src/admin/access.js"
import { createPasskeySetup } from "../src/admin/auth.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

import { createPasskeyFixture } from "./helpers/passkey-fixture.js"

let directory: string
let store: AdminStore
let server: ReturnType<typeof createAdminServer>
let value: string
let csrf: string
let runtime: ModelRuntime
const skills = vi.fn(() => [{ name: "fixture-skill", description: "Use the fixture skill." }])
const toolAvailability = vi.fn(async () => ({
  generate_image: { available: false, reason: "Requires compatible openai-codex OAuth." },
}))
const apply = vi.fn(async () => {
  store.applied(store.snapshot().revision, true)
})
function call(url: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: (server.server.address() as AddressInfo).port,
          path: url,
          method,
          headers: {
            host: "admin.example.test",
            ...(data === undefined
              ? {}
              : {
                  "content-length": String(
                    Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data)),
                  ),
                }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk) => chunks.push(chunk))
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        },
      )
      req.on("error", reject)
      if (data !== undefined) req.write(typeof data === "string" ? data : JSON.stringify(data))
      req.end()
    },
  )
}
const auth = () => ({
  cookie: `__Host-sumire-session=${value}`,
  origin: "https://admin.example.test",
  "x-csrf-token": csrf,
  "content-type": "application/json",
})
beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-admin-http-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  store.applied(1, true)
  const session = store.createSession("42")
  value = session.value
  csrf = session.csrf
  runtime = {
    getProviders: () => [],
    getProvider: (id: string) =>
      id === "fixture" ? { auth: { apiKey: { login: true } } } : undefined,
    login: vi.fn(async () => ({})),
    getRegisteredProviderIds: () => [],
    getModels: () => [],
    getModel: () => undefined,
  } as unknown as ModelRuntime
  server = createAdminServer(
    {
      origin: "https://admin.example.test",
      host: "127.0.0.1",
      port: 0,
      assets: directory,
    },
    {
      store,
      providers: new ProviderAdmin(runtime, store),
      mcp: new McpAdmin(store, directory),
      apply,
      tools: () => ["read"],
      toolAvailability,
      skills,
    },
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe("admin HTTP security", () => {
  it("returns provider capability diagnostics only to authenticated administrators without changing policy", async () => {
    toolAvailability.mockClear()
    const before = store.snapshot()
    expect((await call("/api/inventory")).status).toBe(401)
    expect(toolAvailability).not.toHaveBeenCalled()
    const response = await call("/api/inventory", "GET", undefined, auth())
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).toolAvailability).toEqual({
      generate_image: { available: false, reason: "Requires compatible openai-codex OAuth." },
    })
    expect(toolAvailability).toHaveBeenCalledOnce()
    expect(store.snapshot()).toEqual(before)
  })
  it("returns skill metadata only to authenticated administrators", async () => {
    skills.mockClear()
    const denied = await call("/api/inventory")
    expect(denied.status).toBe(401)
    expect(denied.body).not.toContain("fixture-skill")
    expect(skills).not.toHaveBeenCalled()
    const allowed = await call("/api/inventory", "GET", undefined, auth())
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body).skills).toEqual([
      { name: "fixture-skill", description: "Use the fixture skill." },
    ])
    expect(skills).toHaveBeenCalledOnce()
  })
  it("searches the persisted directory before pagination and supports exact off-page metadata lookup", async () => {
    for (let id = 1; id <= 205; id++) store.observe(id, "private", `Chat ${id}`)
    store.observe(201, "private", "Duplicate Name")
    store.observe(202, "private", "Duplicate Name")
    store.observe(203, "private", "Literal %_\\ name")
    store.db.prepare("UPDATE chats SET name='205' WHERE id=205").run()
    store.observe(-1001234567890, "supergroup", "Named group")
    store.observe(-200, "channel", "Named channel")
    store.observe(-300, "", "Unknown type")
    const policy = store.snapshot().policy
    policy.privateUsers = [42, 201, 202]
    policy.chats["202"] = { ...inherited, enabled: false }
    store.save(policy, store.snapshot().revision, "42")
    const before = store.snapshot()
    const get = async (suffix = "") => {
      const response = await call(`/api/chats${suffix}`, "GET", undefined, auth())
      expect(response.status).toBe(200)
      return JSON.parse(response.body) as Array<{
        id: number
        name: string
        effective: { enabled: boolean }
      }>
    }
    const first = await get()
    expect(Array.isArray(first)).toBe(true)
    expect(first).toHaveLength(100)
    expect(first.some((chat) => chat.id === 201)).toBe(false)
    expect(await get("?q=duplicate%20NAME")).toEqual([
      expect.objectContaining({ id: 201, name: "Duplicate Name" }),
      expect.objectContaining({ id: 202, name: "Duplicate Name" }),
    ])
    expect(await get("?q=%25_")).toEqual([expect.objectContaining({ id: 203 })])
    expect(await get("?q=%5C")).toEqual([expect.objectContaining({ id: 203 })])
    expect(await get("?q=-1001234567890")).toEqual([
      expect.objectContaining({ id: -1001234567890 }),
    ])
    expect(await get("?q=-100123")).toEqual([])
    expect(await get("?q=205")).toEqual([expect.objectContaining({ id: 205 })])
    expect((await get("?q=20")).some((chat) => chat.id === 205)).toBe(false)
    expect(await get("?q=absent")).toEqual([])
    expect(await get("?q=%27%20OR%201%3D1--")).toEqual([])
    expect(await get("?id=201")).toEqual([
      expect.objectContaining({ id: 201, effective: expect.objectContaining({ enabled: true }) }),
    ])
    expect(await get("?id=-1001234567890")).toEqual([
      expect.objectContaining({ name: "Named group" }),
    ])
    expect(await get("?id=99999")).toEqual([])
    store.observe(204, "private", "測試名稱")
    expect(await get(`?q=${encodeURIComponent("測試")}`)).toEqual([
      expect.objectContaining({ id: 204 }),
    ])
    store.observe(204, "private", "Müller")
    expect(await get(`?q=${encodeURIComponent("MÜLLER")}`)).toEqual([
      expect.objectContaining({ id: 204, name: "Müller" }),
    ])
    expect((await get("?id=202"))[0]?.effective.enabled).toBe(false)
    const pages = await Promise.all([get("?offset=100"), get("?q=duplicate"), get("?id=-200")])
    expect(pages[0]).toHaveLength(100)
    expect(pages[1]).toHaveLength(2)
    expect(pages[2]).toEqual([expect.objectContaining({ id: -200 })])
    expect(await get("?offset=1000")).toEqual([])
    expect(await get("?q=%20%20")).toEqual(first)
    expect(store.snapshot()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
  })

  it("validates directory parameters and requires authentication for all query forms", async () => {
    for (const query of ["q=secret", "id=-100", "offset=100"]) {
      expect((await call(`/api/chats?${query}`)).status).toBe(401)
    }
    for (const query of [
      "q=x&q=y",
      "id=1&id=2",
      "offset=0&offset=1",
      "type=group&type=channel",
      "access=all&access=allowed",
      "q=%00",
      `q=${"x".repeat(129)}`,
      "unknown=1",
      "id=0",
      "id=-0",
      "id=01",
      "id=%2B1",
      "id=1.5",
      "id=9007199254740992",
      "id=",
      "id=NaN",
      "id=1&q=",
      "id=1&type=group",
      "id=1&access=allowed",
      "id=1&offset=1",
      "offset=-1",
      "offset=1001",
      "offset=1.5",
      "offset=Infinity",
      "offset=01",
      "offset=",
      "type=invalid",
      "access=invalid",
      "__proto__=x",
    ])
      expect((await call(`/api/chats?${query}`, "GET", undefined, auth())).status, query).toBe(400)
    for (let id = 1; id <= 1001; id++) store.observe(id, "private", `Bounded ${id}`)
    const get = async (offset: number) =>
      JSON.parse(
        (await call(`/api/chats?offset=${offset}`, "GET", undefined, auth())).body,
      ) as unknown[]
    expect(await get(0)).toHaveLength(100)
    expect(await get(900)).toHaveLength(100)
    expect(await get(1000)).toEqual([])
    expect(JSON.parse((await call("/api/chats?id=1001", "GET", undefined, auth())).body)).toEqual(
      [],
    )
  })

  it("filters all retained audit records with bounded, inclusive, parameterized queries", async () => {
    store.db.exec("DELETE FROM audit")
    const insert = store.db.prepare(
      "INSERT INTO audit(actor,time,operation,revision,outcome,target) VALUES (?,?,?,?,?,?)",
    )
    for (let i = 0; i < 205; i++) insert.run("42", 1000, "settings.apply", 2, "failed", "settings")
    insert.run("system", 1000, "settings.apply", 2, "failed", "settings")
    insert.run("42", 999, "settings.apply", 2, "failed", "settings")
    insert.run("42", 1001, "settings.apply", 2, "failed", "settings")
    insert.run("42", 1000, "settings.update", 2, "saved", "settings")
    const query = "/api/audit?actor=42&operation=settings.apply&outcome=failed&from=1000&to=1000"
    const first = JSON.parse((await call(query, "GET", undefined, auth())).body) as {
      id: number
      time: number
      actor: string
    }[]
    const second = JSON.parse((await call(`${query}&offset=100`, "GET", undefined, auth())).body)
    const last = JSON.parse((await call(`${query}&offset=200`, "GET", undefined, auth())).body)
    expect(first).toHaveLength(100)
    expect(second).toHaveLength(100)
    expect(last).toHaveLength(5)
    expect(new Set([...first, ...second, ...last].map((entry) => entry.id)).size).toBe(205)
    expect(first[0]?.id).toBeGreaterThan(second[0].id)
    expect(first.every((entry) => entry.time === 1000 && entry.actor === "42")).toBe(true)
    expect(
      JSON.parse((await call("/api/audit?actor=absent", "GET", undefined, auth())).body),
    ).toEqual([])
    expect(
      JSON.parse(
        (
          await call(
            `/api/audit?actor=${encodeURIComponent("' OR 1=1 --")}`,
            "GET",
            undefined,
            auth(),
          )
        ).body,
      ),
    ).toEqual([])
    expect(
      JSON.parse((await call("/api/audit?offset=0", "GET", undefined, auth())).body),
    ).toHaveLength(100)
    for (const suffix of [
      "actor=",
      "actor=42&actor=system",
      `actor=${"x".repeat(129)}`,
      "from=-1",
      "from=NaN",
      "from=1.5",
      "from=1001&to=1000",
      "from=9007199254740992",
      "offset=10001",
      "outcome=%00",
    ]) {
      expect((await call(`/api/audit?${suffix}`, "GET", undefined, auth())).status, suffix).toBe(
        400,
      )
    }
    expect((await call(query)).status).toBe(401)
  })

  it("withdraws reconciliation mutations but retains authenticated historical reports", async () => {
    store.db
      .prepare("INSERT INTO access_reviews VALUES (?,?,?,?,?)")
      .run("fixture-review", 1, "42", 1, '[{"id":-100,"decision":"retain-denial"}]')
    const before = store.snapshot()
    expect((await call("/api/access/reconciliation", "GET", undefined, auth())).status).toBe(404)
    expect(
      (await call("/api/access/reconciliation", "POST", { selected: [99], revision: 1 }, auth()))
        .status,
    ).toBe(404)
    expect((await call("/api/imports")).status).toBe(401)
    const reports = await call("/api/imports", "GET", undefined, auth())
    expect(JSON.parse(reports.body)).toContainEqual({
      name: "environment-access:1",
      report: {
        revision: 1,
        actor: "42",
        reviewed: 1,
        decisions: [{ id: -100, decision: "retain-denial" }],
      },
    })
    expect(store.snapshot()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
  })

  it("requires authenticated same-origin CSRF-protected review and approval of the stored chat", async () => {
    const access = new ChatAccess(store)
    const link = access.issue(
      { id: -100, type: "group", name: "<target>" },
      "https://admin.example.test",
    )
    if (link.approved) throw new Error("Expected request")
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("allow")
    const route = "/api/access/resolve"
    expect((await call(route, "POST", { token })).status).toBe(401)
    expect(
      (await call(route, "POST", { token }, { ...auth(), "x-csrf-token": "wrong" })).status,
    ).toBe(403)
    expect(
      (await call(route, "POST", { token }, { ...auth(), origin: "https://other.test" })).status,
    ).toBe(403)
    expect((await call(route, "POST", { token }, { ...auth(), host: "other.test" })).status).toBe(
      400,
    )
    expect((await call(route, "GET", undefined, auth())).status).toBe(404)
    expect((await call(route, "POST", { token, chatid: -200 }, auth())).status).toBe(400)
    expect((await call(route, "POST", { token: "a".repeat(64) }, auth())).status).toBe(410)
    expect((await call(route, "POST", { token: "bad" }, auth())).status).toBe(400)
    expect((await call(route, "POST", "x".repeat(4097), auth())).status).toBe(413)
    const resolved = await call(route, "POST", { token }, auth())
    expect(JSON.parse(resolved.body)).toMatchObject({
      id: -100,
      type: "group",
      name: "<target>",
      revision: 1,
    })
    expect(store.snapshot().revision).toBe(1)
    expect(apply).not.toHaveBeenCalled()
    const approve = "/api/access/approve"
    expect((await call(approve, "POST", { token, revision: 1 })).status).toBe(401)
    expect(
      (await call(approve, "POST", { token, revision: 1 }, { ...auth(), "x-csrf-token": "wrong" }))
        .status,
    ).toBe(403)
    expect((await call(approve, "POST", { token, revision: 2 }, auth())).status).toBe(409)
    expect((await call(approve, "POST", { token, revision: 1, chatid: -200 }, auth())).status).toBe(
      400,
    )
    expect((await call(approve, "POST", { token, revision: 1 }, auth())).status).toBe(200)
    expect(apply).toHaveBeenCalledOnce()
    expect(store.allows(-100)).toBe(true)
    expect(store.allows(-200)).toBe(false)
    expect((await call(approve, "POST", { token, revision: 2 }, auth())).status).toBe(410)
    expect(store.snapshot().revision).toBe(2)
    expect(JSON.stringify(store.listAudit(0))).not.toContain(token)
  })
  it("rejects expired, replaced, and wrong-origin links without policy mutations", async () => {
    const audit = store.listAudit(0)
    const access = new ChatAccess(store)
    const issue = (origin = "https://admin.example.test") => {
      const link = access.issue({ id: -100, type: "group", name: "Target" }, origin)
      if (link.approved) throw new Error("Expected request")
      return new URLSearchParams(new URL(link.url).hash.slice(1)).get("allow")
    }
    const expired = issue()
    store.db.exec("UPDATE chat_access_requests SET expires=0")
    for (const route of ["resolve", "approve"]) {
      const data = { token: expired, ...(route === "approve" ? { revision: 1 } : {}) }
      expect((await call(`/api/access/${route}`, "POST", data, auth())).status).toBe(410)
    }
    const replaced = issue()
    store.db.exec("UPDATE chat_access_requests SET created=created-60000")
    const wrongOrigin = issue("https://other.example.test")
    expect((await call("/api/access/resolve", "POST", { token: replaced }, auth())).status).toBe(
      410,
    )
    expect(
      (await call("/api/access/approve", "POST", { token: wrongOrigin, revision: 1 }, auth()))
        .status,
    ).toBe(410)
    expect(store.snapshot().revision).toBe(1)
    expect(store.listAudit(0)).toEqual(audit)
    expect(apply).not.toHaveBeenCalled()
  })
  it("keeps committed approval failed-closed and consumed when runtime application fails", async () => {
    const link = new ChatAccess(store).issue(
      { id: -100, type: "group", name: "Target" },
      "https://admin.example.test",
    )
    if (link.approved) throw new Error("Expected request")
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("allow")
    apply.mockImplementationOnce(async () => {
      store.applied(store.snapshot().revision, false)
      throw new Error("fixture")
    })
    expect((await call("/api/access/approve", "POST", { token, revision: 1 }, auth())).status).toBe(
      500,
    )
    expect(store.snapshot().status).toBe("failed")
    expect(store.allows(-100)).toBe(false)
    expect((await call("/api/access/approve", "POST", { token, revision: 2 }, auth())).status).toBe(
      410,
    )
    expect((await call("/api/apply", "POST", {}, auth())).status).toBe(200)
    expect(store.allows(-100)).toBe(true)
  })
  it("revision-checks credential writes and reports upstream failures without secrets", async () => {
    const route = "/api/providers/fixture/credential"
    const success = await call(route, "POST", { key: "literal-fixture", revision: 1 }, auth())
    expect(success.status).toBe(200)
    expect(success.body).not.toContain("literal-fixture")
    expect(store.snapshot().revision).toBe(2)
    expect((await call(route, "POST", { key: "stale-fixture", revision: 1 }, auth())).status).toBe(
      409,
    )
    expect((await call(route, "POST", { key: "!command", revision: 2 }, auth())).status).toBe(400)
    expect(store.snapshot().revision).toBe(2)
    vi.mocked(runtime.login).mockRejectedValueOnce(new Error("upstream-secret-fixture"))
    const failed = await call(route, "POST", { key: "replacement-fixture", revision: 2 }, auth())
    expect(failed.status).toBe(500)
    expect(failed.body).not.toContain("upstream-secret-fixture")
    expect(failed.body).not.toContain("replacement-fixture")
    expect(store.snapshot().status).toBe("failed")
    expect(store.allows(42)).toBe(false)
    expect((await call("/api/session", "GET", undefined, auth())).status).toBe(200)
    expect(JSON.stringify(store.listAudit(0))).not.toContain("literal-fixture")
    expect(JSON.stringify(store.listAudit(0))).not.toContain("replacement-fixture")
    expect(store.listAudit(0)).toContainEqual(
      expect.objectContaining({ target: "provider:fixture" }),
    )
  })
  it("authenticates, revision-checks, audits, and applies MCP deletion", async () => {
    const route = "/api/mcp/fixture"
    expect(
      (
        await call(
          route,
          "PUT",
          {
            revision: 1,
            config: { command: "node", enabled: false, env: { KEY: "delete-secret" } },
          },
          auth(),
        )
      ).status,
    ).toBe(200)
    apply.mockClear()
    const before = store.snapshot()
    expect((await call(route, "DELETE", { revision: 2 })).status).toBe(401)
    expect((await call(route, "DELETE", { revision: 2 }, { cookie: auth().cookie })).status).toBe(
      403,
    )
    expect(
      (
        await call(
          route,
          "DELETE",
          { revision: 2 },
          { ...auth(), origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403)
    expect((await call(route, "DELETE", { revision: 1 }, auth())).status).toBe(409)
    expect((await call(route, "DELETE", {}, auth())).status).toBe(400)
    expect(store.snapshot()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
    const result = await call(route, "DELETE", { revision: 2 }, auth())
    expect(result.status).toBe(200)
    expect(result.body).not.toContain("delete-secret")
    expect(apply).toHaveBeenCalledOnce()
    expect(store.snapshot()).toMatchObject({ revision: 3, applied: 3, status: "applied" })
    const inventory = JSON.parse((await call("/api/inventory", "GET", undefined, auth())).body)
    expect(inventory.mcp).toEqual([])
    expect(inventory.builtInTools).toEqual(["read"])
    expect(inventory.tools).toEqual(["read"])
    expect(store.listAudit(0)).toContainEqual(
      expect.objectContaining({ operation: "mcp.delete", target: "mcp:fixture" }),
    )
  })
  it("bounds login starts and total requests without trusting forwarded client addresses", async () => {
    for (let i = 0; i < 10; i++)
      expect((await call("/auth/passkey/authenticate/options", "POST", {}, auth())).status).toBe(
        200,
      )
    expect((await call("/auth/passkey/authenticate/options", "POST", {}, auth())).status).toBe(429)
    let response = await call("/healthz")
    for (let i = 0; i < 240; i++)
      response = await call("/healthz", "GET", undefined, {
        "x-forwarded-for": `198.51.100.${i % 255}`,
      })
    expect(response.status).toBe(429)
    expect(response.headers["retry-after"]).toBe("60")
  })
  it("requires authentication across management routes", async () => {
    for (const route of [
      "settings",
      "session",
      "inventory",
      "chats",
      "audit",
      "providers/openai/test",
      "mcp/demo",
      "oauth/unknown",
    ])
      expect((await call(`/api/${route}`)).status).toBe(401)
  })
  it("requires Origin and CSRF for all mutations", async () => {
    for (const route of [
      "settings",
      "logout",
      "apply",
      "providers/openai/credential",
      "providers/openai/oauth",
      "mcp/demo",
    ]) {
      expect((await call(`/api/${route}`, "POST", {}, { cookie: auth().cookie })).status).toBe(403)
      expect(
        (await call(`/api/${route}`, "POST", {}, { ...auth(), origin: "https://attacker.invalid" }))
          .status,
      ).toBe(403)
    }
  })
  it("ignores forged proxy headers and requires the registered host", async () => {
    expect(
      (
        await call("/api/settings", "GET", undefined, {
          ...auth(),
          host: "attacker.invalid",
          "x-forwarded-host": "admin.example.test",
        })
      ).status,
    ).toBe(400)
    expect((await call("/api/settings", "GET", undefined, auth())).status).toBe(200)
  })
  it("saves valid settings, applies them, and rejects stale revisions", async () => {
    const policy = store.snapshot().policy
    policy.privateUsers.push(43)
    const first = await call("/api/settings", "PUT", { revision: 1, policy }, auth())
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toMatchObject({ revision: 2, applied: 2, status: "applied" })
    expect((await call("/api/settings", "PUT", { revision: 1, policy }, auth())).status).toBe(409)
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it("rejects oversized and malformed bodies without leaking input", async () => {
    expect((await call("/api/settings", "PUT", "x".repeat(262145), auth())).status).toBe(413)
    const malformed = await call("/api/settings", "PUT", '{"credential":"fixture-value"', auth())
    expect(malformed.status).toBe(400)
    expect(malformed.body).not.toContain("fixture-value")
  })
  it("registers and authenticates through one-use passkey challenges and rotates secure sessions", async () => {
    const link = createPasskeySetup(store, "https://admin.example.test") as string
    const setup = new URLSearchParams(new URL(link).hash.slice(1)).get("setup")
    const fixture = createPasskeyFixture()
    const started = await call("/auth/passkey/register/options", "POST", { setup }, auth())
    expect(started.status).toBe(200)
    const options = JSON.parse(started.body)
    const cookies = String(started.headers["set-cookie"])
    expect(cookies).toContain("__Host-sumire-passkey=")
    expect(cookies).toContain("HttpOnly; Secure; SameSite=Strict")
    const headers = { ...auth(), cookie: `${auth().cookie}; ${cookies.split(";")[0]}` }
    const response = fixture.registration(options.challenge)
    const registered = await call("/auth/passkey/register/verify", "POST", { response }, headers)
    expect(registered.status).toBe(200)
    expect(store.session(value)).toBeUndefined()
    expect(JSON.parse(registered.body)).toMatchObject({ actor: "42", csrf: expect.any(String) })
    expect(
      (await call("/auth/passkey/register/verify", "POST", { response }, headers)).status,
    ).toBe(403)
    const next = await call("/auth/passkey/authenticate/options", "POST", {}, auth())
    const signed = fixture.authentication(JSON.parse(next.body).challenge, options.user.id)
    const loggedIn = await call(
      "/auth/passkey/authenticate/verify",
      "POST",
      { response: signed },
      { ...auth(), cookie: String(next.headers["set-cookie"]).split(";")[0] as string },
    )
    expect(loggedIn.status).toBe(200)
    expect(loggedIn.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^__Host-sumire-session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/,
        ),
      ]),
    )
    const sessionCookie = (loggedIn.headers["set-cookie"] as string[])
      .find((item) => item.startsWith("__Host-sumire-session="))
      ?.split(";")[0] as string
    expect((await call("/api/session", "GET", undefined, { cookie: sessionCookie })).status).toBe(
      200,
    )
  })
  it("keeps passkey, Host, Origin, and session checks on the local HTTP origin", async () => {
    await server.stop()
    const origin = "http://localhost:17465"
    server = createAdminServer(
      { origin, host: "127.0.0.1", port: 0, assets: directory },
      {
        store,
        providers: new ProviderAdmin(runtime, store),
        mcp: new McpAdmin(store, directory),
        apply,
        tools: () => [],
      },
    )
    await server.start()
    const headers = { ...auth(), host: "localhost:17465", origin }
    const health = await call("/healthz", "GET", undefined, headers)
    expect(health.status).toBe(200)
    expect(health.headers["strict-transport-security"]).toBeUndefined()
    expect((await call("/healthz")).status).toBe(400)
    expect((await call("/api/settings", "GET", undefined, { host: headers.host })).status).toBe(401)
    expect(
      (
        await call(
          "/auth/passkey/authenticate/options",
          "POST",
          {},
          { ...headers, origin: "http://attacker.invalid" },
        )
      ).status,
    ).toBe(403)
    const link = createPasskeySetup(store, origin) as string
    const setup = new URLSearchParams(new URL(link).hash.slice(1)).get("setup")
    const started = await call("/auth/passkey/register/options", "POST", { setup }, headers)
    expect(started.status).toBe(200)
    expect(JSON.parse(started.body).rp.id).toBe("localhost")
    expect(String(started.headers["set-cookie"])).toContain("HttpOnly; Secure; SameSite=Strict")
    const response = createPasskeyFixture().registration(JSON.parse(started.body).challenge, {
      origin,
      rpID: "localhost",
    })
    const registered = await call(
      "/auth/passkey/register/verify",
      "POST",
      { response },
      {
        ...headers,
        cookie: String(started.headers["set-cookie"]).split(";")[0] as string,
      },
    )
    expect(registered.status).toBe(200)
    expect(JSON.parse(registered.body).actor).toBe("42")
  })

  it("rejects cross-origin, unbound, oversized, and legacy login requests", async () => {
    expect((await call("/auth/telegram")).status).toBe(404)
    expect((await call("/auth/callback?code=fixture")).status).toBe(404)
    expect((await call("/auth/passkey/authenticate/options")).status).toBe(405)
    expect((await call("/auth/passkey/authenticate/options", "POST", {}, {})).status).toBe(403)
    expect(
      (
        await call(
          "/auth/passkey/authenticate/options",
          "POST",
          {},
          { ...auth(), origin: "https://other.example.test" },
        )
      ).status,
    ).toBe(403)
    expect(
      (await call("/auth/passkey/register/options", "POST", { setup: "x".repeat(43) }, auth()))
        .status,
    ).toBe(403)
    expect(
      (await call("/auth/passkey/authenticate/options", "POST", "x".repeat(32769), auth())).status,
    ).toBe(413)
    expect(
      (await call("/auth/passkey/authenticate/verify", "POST", { response: {} }, auth())).status,
    ).toBe(403)
  })
  it("revokes the session on logout and adds security headers", async () => {
    const response = await call("/api/logout", "POST", {}, auth())
    expect(response.status).toBe(200)
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(response.headers["referrer-policy"]).toBe("no-referrer")
    expect((await call("/api/session", "GET", undefined, auth())).status).toBe(401)
  })
})
