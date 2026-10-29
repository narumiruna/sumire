import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Snapshot } from "@narumitw/sumire-contracts"
import { createGithubMentionClient } from "@narumitw/sumire-github-notifications"
import { expect, it, vi } from "vitest"
import { createGithubReplyGenerator } from "../src/github/generation.js"
import { GithubMentionWorker } from "../src/github/runtime.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it.each(["body-activity", "deleted-comment", "uncertain-post"])(
  "keeps real-client outbox delivery safe across polls and restart: %s",
  async (scenario) => {
    const f = await createPiFixture()
    const policy = f.factory.control.snapshot().policy
    policy.githubNotifications.allowedUsernames = ["alice", "bob"]
    policy.defaults.thinking = "off"
    policy.providers = [{ id: "openai", enabled: true, models: [] }]
    const snapshot: Snapshot = { revision: 1, applied: 1, status: "applied", epoch: 1, policy }
    const account = { id: 42, login: "sumire-bot" }
    const time = "2030-01-01T11:59:30Z"
    const later = "2030-01-01T12:00:30Z"
    const firstPath = "/repos/owner/repo/issues/12"
    const secondPath = "/repos/owner/other/issues/13"
    const firstBody = "@sumire-bot First request."
    const firstComment = {
      id: 100,
      user: { id: 10, login: "alice" },
      body: firstBody,
      updated_at: time,
      issue_url: `https://api.github.com${firstPath}`,
    }
    const secondComment = {
      id: 200,
      user: { id: 20, login: "bob" },
      body: "@sumire-bot Second request.",
      updated_at: time,
      issue_url: `https://api.github.com${secondPath}`,
    }
    const firstIssue = {
      id: 12,
      user: { id: 10, login: "alice" },
      title: "First issue",
      body: scenario === "deleted-comment" ? "No body mention" : firstBody,
      updated_at: time,
    }
    let firstComments = scenario === "deleted-comment" ? [firstComment] : []
    const secondComments = [secondComment]
    const writes: string[] = []
    const logger = { warn: vi.fn() }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe("https://api.github.com")
      if (init?.method === "POST") {
        writes.push(url.pathname)
        const payload = JSON.parse(String(init.body)) as { body: string }
        const response = {
          ...firstComment,
          id: 900 + writes.length,
          user: account,
          body: payload.body,
          updated_at: later,
        }
        if (url.pathname === `${firstPath}/comments`) {
          firstComments.push(response)
          firstIssue.updated_at = later
          if (scenario === "uncertain-post") throw new Error("Synthetic lost POST response")
        } else if (url.pathname === `${secondPath}/comments`) secondComments.push(response)
        else throw new Error("Unexpected synthetic write destination")
        return Response.json({ id: response.id })
      }
      if (url.pathname === "/user") return Response.json(account)
      if (url.pathname === "/notifications")
        return Response.json(
          (scenario === "body-activity" ? [firstPath] : [firstPath, secondPath]).map(
            (issuePath, index) => ({
              id: `thread-${index}`,
              reason: "mention",
              repository: { full_name: issuePath === firstPath ? "owner/repo" : "owner/other" },
              subject: { type: "Issue", url: `https://api.github.com${issuePath}` },
            }),
          ),
        )
      if (url.pathname === firstPath) return Response.json(firstIssue)
      if (url.pathname === secondPath)
        return Response.json({
          id: 13,
          user: { login: "owner" },
          title: "Second issue",
          body: "Context",
          updated_at: time,
        })
      if (url.pathname === `${firstPath}/comments` || url.pathname === `${secondPath}/comments`) {
        const comments = url.pathname === `${firstPath}/comments` ? firstComments : secondComments
        const since = url.searchParams.get("since")
        return Response.json(
          comments.filter(
            (comment) => !since || Date.parse(comment.updated_at) > Date.parse(since),
          ),
        )
      }
      if (url.pathname === "/repos/owner/repo/issues/comments/100") {
        if (scenario === "deleted-comment") {
          firstComments = firstComments.filter((comment) => comment.id !== 100)
          return new Response("Synthetic deleted source", { status: 404 })
        }
        return Response.json(firstComment)
      }
      if (url.pathname === "/repos/owner/other/issues/comments/200")
        return Response.json(secondComment)
      throw new Error("Unexpected synthetic read destination")
    })
    const token = "synthetic-review-token"
    const client = createGithubMentionClient({
      authorize() {},
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
      store: { snapshot: () => structuredClone(snapshot) },
      runtime: { readSecret: () => token },
      modelRuntime: f.modelRuntime,
      logger,
      client,
      generate,
      now: () => Date.parse("2030-01-01T12:00:00Z"),
    }
    const statuses = () => {
      const db = new DatabaseSync(path.join(directory, "state.sqlite"), { readOnly: true })
      try {
        return db
          .prepare("SELECT status FROM mentions ORDER BY rowid")
          .all()
          .map((row) => row.status)
      } finally {
        db.close()
      }
    }
    let worker = new GithubMentionWorker(options)
    try {
      const generations = scenario === "body-activity" ? 1 : 2
      f.enqueueAnswer("First saved answer.")
      if (generations === 2) f.enqueueAnswer("Second saved answer.")
      await worker.poll()
      expect(statuses()).toEqual(
        scenario === "body-activity"
          ? ["sent"]
          : scenario === "deleted-comment"
            ? ["ignored", "sent"]
            : ["pending", "sent"],
      )
      await worker.close()
      worker = new GithubMentionWorker(options)
      await worker.poll()
      await worker.poll()
      expect(f.requests).toHaveLength(generations)
      expect(generate).toHaveBeenCalledTimes(generations)
      expect(writes.filter((destination) => destination === `${firstPath}/comments`)).toHaveLength(
        scenario === "deleted-comment" ? 0 : 1,
      )
      expect(writes.filter((destination) => destination === `${secondPath}/comments`)).toHaveLength(
        scenario === "body-activity" ? 0 : 1,
      )
      expect(statuses()).toEqual(
        scenario === "body-activity"
          ? ["sent"]
          : scenario === "deleted-comment"
            ? ["ignored", "sent"]
            : ["sent", "sent"],
      )
    } finally {
      await worker.close()
      await f.cleanup()
    }
  },
)
