import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import type { Issue, IssueAnalyses } from "@narumitw/sumire-issues"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { IssueAnalysisRuntime } from "../src/issues/runtime.js"
import { issueFixtureRuntime } from "./helpers/issue-analysis-runtime.js"
import { report } from "./helpers/issue-report.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

let f: Awaited<ReturnType<typeof createPiFixture>>
let worker: IssueAnalysisRuntime
let server: ReturnType<typeof createAdminServer>
let session: { value: string; csrf: string }
const headers = () => ({
  cookie: `__Host-sumire-session=${session.value}`,
  origin: "https://admin.example.test",
  "x-csrf-token": session.csrf,
  "content-type": "application/json",
})
function call(
  url: string,
  method = "GET",
  data?: unknown,
  auth: Record<string, string> = headers(),
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: (server.server.address() as AddressInfo).port,
        path: url,
        method,
        headers: {
          host: "admin.example.test",
          ...(data === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(JSON.stringify(data))) }),
          ...auth,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    request.on("error", reject)
    if (data !== undefined) request.write(JSON.stringify(data))
    request.end()
  })
}
const feedback = () => ({
  requestId: randomUUID(),
  description: "改善操作",
  source: { section: "Chats", viewport: { width: 1000, height: 800 } },
})
async function create() {
  const response = await call("/api/issues", "POST", feedback())
  expect(response.status).toBe(201)
  return JSON.parse(response.body) as Issue
}
const read = async (id: number) =>
  JSON.parse((await call(`/api/issues/${id}/analysis`)).body) as IssueAnalyses
beforeEach(async () => {
  f = await createPiFixture()
  const store = f.factory.control
  const snapshot = store.snapshot()
  snapshot.policy.defaults.thinking = "off"
  snapshot.policy.providers = [{ id: "openai", enabled: true, models: [] }]
  store.save(snapshot.policy, snapshot.revision, "7")
  store.applied(store.snapshot().revision, true)
  session = store.createSession("7")
  worker = new IssueAnalysisRuntime({
    store,
    runtime: issueFixtureRuntime(f),
    directory: path.join(f.root, "issue-api-sessions"),
  })
  server = createAdminServer(
    { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: f.root },
    {
      store,
      analysis: worker,
      providers: new ProviderAdmin(f.modelRuntime, store),
      mcp: new McpAdmin(store, f.root),
      tools: () => [],
      apply: async () => {},
    },
  )
  await server.start()
})
afterEach(async () => {
  await server.stop()
  await f.cleanup()
})
it("requires admin authentication and exact Origin/CSRF for analysis and selection", async () => {
  const issue = await create()
  expect((await call(`/api/issues/${issue.id}/analysis`, "GET", undefined, {})).status).toBe(401)
  for (const endpoint of ["analysis", "analysis/cancel", "analysis/select"]) {
    expect(
      (
        await call(
          `/api/issues/${issue.id}/${endpoint}`,
          "POST",
          {},
          { ...headers(), "x-csrf-token": "bad" },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          `/api/issues/${issue.id}/${endpoint}`,
          "POST",
          {},
          { ...headers(), origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403)
  }
  expect(f.requests).toHaveLength(0)
})
it("creates an actual empty session but does not send feedback without analysis consent", async () => {
  const issue = await create()
  await worker.wake()
  const response = await read(issue.id)
  expect(response).toMatchObject({
    available: true,
    analyses: [
      {
        sessionId: expect.any(String),
        conversationId: expect.any(Number),
        state: "idle",
        submissionId: null,
      },
    ],
  })
  expect(f.requests).toHaveLength(0)
  const json = JSON.stringify(response)
  for (const field of ['"actor"', '"context"', '"policyRevision"', '"directory"'])
    expect(json).not.toContain(field)
  expect((await call("/api/issues/999/analysis")).status).toBe(404)
})
it("admits structured analysis and stores a version-bound choice without implementing anything", async () => {
  const issue = await create()
  f.enqueue("publish_issue_proposals", report, false)
  const input = { requestId: randomUUID(), revision: issue.revision, context: "只需概念方案" }
  expect((await call(`/api/issues/${issue.id}/analysis`, "POST", input)).status).toBe(200)
  await worker.wake()
  expect((await call(`/api/issues/${issue.id}/analysis`, "POST", input)).status).toBe(200)
  const result = await read(issue.id)
  const analysis = result.analyses[0]
  expect(analysis).toMatchObject({ state: "completed", report, selectedProposal: null })
  if (!analysis) throw new Error("Missing report")
  const selection = { analysisId: analysis.id, revision: analysis.revision, proposal: 0 }
  expect(
    (
      await call(`/api/issues/${issue.id}/analysis/select`, "POST", {
        ...selection,
        implement: true,
      })
    ).status,
  ).toBe(400)
  const selected = await call(`/api/issues/${issue.id}/analysis/select`, "POST", selection)
  expect(selected.status).toBe(200)
  expect((JSON.parse(selected.body) as IssueAnalyses).analyses[0]?.selectedProposal).toBe(0)
  expect((await call(`/api/issues/${issue.id}/analysis/select`, "POST", selection)).status).toBe(
    409,
  )
  expect(f.requests).toHaveLength(1)
  expect((await call(`/api/issues/${issue.id}/implement`, "POST", selection)).status).toBe(404)
})
it("scopes analysis identifiers to their issue and rejects client-supplied sessions or capabilities", async () => {
  const issue = await create()
  const other = await create()
  await worker.wake()
  const analysis = (await read(issue.id)).analyses[0]
  if (!analysis) throw new Error("Missing analysis")
  expect(
    (
      await call(`/api/issues/${other.id}/analysis/cancel`, "POST", {
        analysisId: analysis.id,
        revision: analysis.revision,
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call(`/api/issues/${issue.id}/analysis`, "POST", {
        requestId: randomUUID(),
        revision: 1,
        sessionId: "fake",
        tools: ["bash"],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call(`/api/issues/${issue.id}/analysis`, "POST", {
        requestId: randomUUID(),
        revision: 0,
      })
    ).status,
  ).toBe(400)
  expect(f.requests).toHaveLength(0)
})
it("cancels queued/blocked work, and deletion removes session artifacts as well as reports", async () => {
  const snapshot = f.factory.control.snapshot()
  snapshot.policy.providers = []
  f.factory.control.save(snapshot.policy, snapshot.revision, "7")
  f.factory.control.applied(f.factory.control.snapshot().revision, true)
  const issue = await create()
  expect(
    (
      await call(`/api/issues/${issue.id}/analysis`, "POST", {
        requestId: randomUUID(),
        revision: 1,
      })
    ).status,
  ).toBe(200)
  await worker.wake()
  const analysis = (await read(issue.id)).analyses[0]
  if (!analysis) throw new Error("Missing analysis")
  expect(analysis.state).toBe("blocked")
  expect(
    (
      await call(`/api/issues/${issue.id}/analysis/cancel`, "POST", {
        analysisId: analysis.id,
        revision: analysis.revision,
      })
    ).status,
  ).toBe(200)
  expect((await read(issue.id)).analyses[0]?.state).toBe("cancelled")
  const gc = vi.spyOn(worker.analyses, "collected")
  expect((await call(`/api/issues/${issue.id}`, "DELETE", { revision: 1 })).status).toBe(200)
  await worker.wake()
  expect(gc).toHaveBeenCalledWith(analysis.id)
  expect((await call(`/api/issues/${issue.id}/analysis`)).status).toBe(404)
  expect(f.requests).toHaveLength(0)
})

it("starts analysis after collection only when the submission explicitly requests it", async () => {
  f.enqueue("publish_issue_proposals", report, false)
  const response = await call("/api/issues", "POST", { ...feedback(), analyze: true })
  expect(response.status).toBe(201)
  const issue = JSON.parse(response.body) as Issue
  await worker.wake()
  expect((await read(issue.id)).analyses[0]).toMatchObject({ state: "completed", report })
  expect(f.requests).toHaveLength(1)
})
