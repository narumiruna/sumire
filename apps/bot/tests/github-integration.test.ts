import path from "node:path"
import type { Snapshot } from "@narumitw/sumire-contracts"
import { createGithubMentionClient } from "@narumitw/sumire-github-notifications"
import { expect, it, vi } from "vitest"
import { createGithubReplyGenerator } from "../src/github/generation.js"
import { GithubMentionWorker } from "../src/github/runtime.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it.each(["allowed", "denied", "uncertain-post"])(
  "runs notification discovery, durable generation, and GitHub delivery together: %s",
  async (scenario) => {
    const f = await createPiFixture()
    const policy = f.factory.control.snapshot().policy
    policy.githubNotifications.allowedUsernames = ["trusted-author"]
    policy.defaults.thinking = "off"
    policy.providers = [{ id: "openai", enabled: true, models: [] }]
    const snapshot: Snapshot = { revision: 1, applied: 1, status: "applied", epoch: 1, policy }
    const token = "synthetic-github-token"
    const account = { id: 42, login: "sumire-bot" }
    const time = "2030-01-01T11:59:30Z"
    const source = {
      id: 100,
      user: { id: 10, login: scenario === "denied" ? "stranger" : "TRUSTED-AUTHOR" },
      body: "@sumire-bot Explain this supplied example.",
      updated_at: time,
      issue_url: "https://api.github.com/repos/owner/repo/issues/12",
    }
    const comments = [source]
    let posted = 0
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe("https://api.github.com")
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
      expect(init?.redirect).toBe("error")
      let value: unknown
      if (init?.method === "POST") {
        expect(url.pathname).toBe("/repos/owner/repo/issues/12/comments")
        const payload = JSON.parse(String(init.body)) as { body: string }
        expect(payload.body).toContain("A generated **GitHub** reply.")
        expect(payload.body).toMatch(/<!-- sumire-mention:[a-f0-9]{64} -->/)
        posted++
        comments.push({ ...source, id: 101, user: account, body: payload.body })
        if (scenario === "uncertain-post") throw new Error(`Lost POST response: ${token}`)
        value = { id: 101 }
      } else if (url.pathname === "/user") value = account
      else if (url.pathname === "/notifications")
        value = [
          {
            id: "thread-1",
            reason: "mention",
            repository: { full_name: "owner/repo" },
            subject: { type: "Issue", url: "https://api.github.com/repos/owner/repo/issues/12" },
          },
        ]
      else if (url.pathname === "/repos/owner/repo/issues/12")
        value = {
          id: 12,
          title: "Example question",
          body: "Issue context",
          user: { login: "owner" },
          updated_at: time,
        }
      else if (url.pathname === "/repos/owner/repo/issues/12/comments") value = comments
      else if (url.pathname === "/repos/owner/repo/issues/comments/100") value = source
      else throw new Error(`Unexpected fixture endpoint ${url.pathname}`)
      return Response.json(value)
    })
    const store = { snapshot: () => structuredClone(snapshot) }
    const runtime = { readSecret: () => token }
    const client = createGithubMentionClient({
      authorize: () => {
        if (snapshot.status !== "applied" || snapshot.applied !== snapshot.revision)
          throw new Error("Not applied")
      },
      token: () => token,
      allowedUsernames: () => policy.githubNotifications.allowedUsernames,
      fetch: fetcher,
    })
    const directory = path.join(f.root, ".telegramagent", "github")
    const generate = vi.fn(
      createGithubReplyGenerator({
        directory,
        settings: f.settings,
        runtime: f.modelRuntime,
        policy: () => policy,
      }),
    )
    const options = {
      directory,
      store,
      runtime,
      github: { resolveToken: async () => token },
      modelRuntime: f.modelRuntime,
      logger: f.logger,
      client,
      generate,
      now: () => Date.parse("2030-01-01T12:00:00Z"),
    }
    let worker = new GithubMentionWorker(options)
    try {
      if (scenario !== "denied") f.enqueueAnswer("A generated **GitHub** reply.")
      await expect(worker.poll()).resolves.toBe(60)
      expect(f.requests).toHaveLength(scenario === "denied" ? 0 : 1)
      expect(posted).toBe(scenario === "denied" ? 0 : 1)
      expect(JSON.stringify(f.requests)).not.toContain(token)
      if (scenario !== "denied") expect(f.requests[0]?.tools ?? []).toEqual([])
      await worker.close()
      worker = new GithubMentionWorker(options)
      await worker.poll()
      expect(f.requests).toHaveLength(scenario === "denied" ? 0 : 1)
      expect(generate).toHaveBeenCalledTimes(scenario === "denied" ? 0 : 1)
      expect(posted).toBe(scenario === "denied" ? 0 : 1)
    } finally {
      await worker.close()
      await f.cleanup()
    }
  },
)
