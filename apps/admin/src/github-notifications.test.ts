import { initialPolicy } from "@narumitw/sumire-policy"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  GithubNotifications,
  mentionAuthorError,
  mentionBlockers,
  mentionConnection,
} from "./github-notifications.js"

function render(usernames: string[] = [], savedUsernames = usernames) {
  const policy = initialPolicy()
  policy.githubNotifications.allowedUsernames = usernames
  const saved = initialPolicy()
  saved.githubNotifications.allowedUsernames = savedUsernames
  return renderToStaticMarkup(
    createElement(GithubNotifications, {
      policy,
      saved,
      disabled: false,
      onChange: () => {},
      onPending: () => {},
      onNavigate: () => {},
    }),
  )
}

describe("GitHub mention administration", () => {
  it.each([
    "",
    "-cat",
    "cat-",
    "two--hyphens",
    "@someone",
    "cat.name",
    "cat_name",
    "two words",
    "猫",
    "a".repeat(40),
  ])("rejects invalid GitHub username %s before staging", (value) => {
    expect(mentionAuthorError(value, [])).toContain("Enter a GitHub username")
  })
  it("accepts valid usernames and checks case-insensitive duplicates and capacity", () => {
    expect(mentionAuthorError(" OctoCat ", [])).toBe("")
    expect(mentionAuthorError("a-1", [])).toBe("")
    expect(mentionAuthorError("9", [])).toBe("")
    expect(mentionAuthorError("a".repeat(39), [])).toBe("")
    expect(mentionAuthorError("OCTOCAT", ["octocat"])).toContain("already")
    expect(
      mentionAuthorError(
        "new-author",
        Array.from({ length: 1000 }, (_, index) => `user-${index}`),
      ),
    ).toContain("limit is 1,000")
  })
  it("explains GitHub replies, empty-list denial, token identity, and independent host trust", () => {
    const html = render()
    expect(html).toContain(
      "No usernames allowed. An empty saved allowlist disables automatic replies.",
    )
    expect(html).toContain("GH_TOKEN determines which GitHub account Sumire uses.")
    expect(html).toContain("Sumire replies on")
    expect(html).toContain("Mentions from other authors are")
    expect(html).toContain("Telegram chat access and tool permissions are not required.")
    expect(html).toContain("not a security sandbox")
    expect(html).not.toContain("Manage chat access")
    expect(html).not.toContain("Manage tool permissions")
    expect(html).not.toContain("read_github_notifications")
    expect(html).not.toContain("GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS")
  })
  it("reports saved policy, local application, and unmeasured health before the author editor", () => {
    const html = render(["pending"], [])
    expect(html).toContain("Saved author policy: automatic replies disabled")
    expect(html).toContain("Unsaved; saved policy still applies")
    expect(html).toContain("Remote verification and worker status: unavailable")
    expect(html.indexOf("GitHub mentions status")).toBeLessThan(
      html.indexOf("Mention author allowlist"),
    )
  })
  it("strips flow codes, raw failures, and credentials from mention metadata", () => {
    const connection = mentionConnection({
      revision: 3,
      applied: 2,
      status: "failed",
      secretStatus: "ready",
      mode: "oauth",
      reconnectRequired: false,
      account: { id: 7, login: "fixture-user" },
      flow: { userCode: "NEVER-RETAIN", token: "synthetic-secret" },
      accessToken: "synthetic-secret",
      error: "synthetic-secret",
    })
    expect(connection.account?.login).toBe("fixture-user")
    expect(connection.flow).toBeUndefined()
    expect(JSON.stringify(connection)).not.toMatch(/NEVER|synthetic-secret/)
    expect(mentionBlockers(initialPolicy(), connection, connection)).toEqual([
      "The saved author allowlist is empty; automatic replies are disabled.",
      "A shared default model must be selected and allowed for GitHub replies.",
      "Settings were saved but application failed.",
    ])
  })
  it("does not claim remote readiness when known local blockers are absent", () => {
    const saved = initialPolicy()
    saved.githubNotifications.allowedUsernames = ["octocat"]
    saved.models = ["fixture/model"]
    saved.defaults.models = ["fixture/model"]
    saved.defaults.model = "fixture/model"
    const connection = mentionConnection({
      revision: 1,
      applied: 1,
      status: "applied",
      secretStatus: "ready",
      mode: "manual",
      reconnectRequired: false,
    })
    expect(mentionBlockers(saved, connection, connection)).toEqual([])
    saved.providers = [{ id: "fixture", enabled: false, models: [] }]
    expect(mentionBlockers(saved, connection, connection)).toContain(
      "A shared default model must be selected and allowed for GitHub replies.",
    )
    expect(mentionBlockers(saved)).toContain("Local credential state is unknown.")
    expect(mentionBlockers(saved)).toContain("Application state is unknown.")
  })
  it("distinguishes staged additions and removals from saved authors", () => {
    const html = render(["octocat", "new-author"], ["octocat", "old-author"])
    expect(html).toContain("2 allowed usernames")
    expect(html).toContain("Pending addition")
    expect(html).toContain("Pending removal")
    expect(html).toContain('aria-label="Remove username new-author"')
    expect(html).toContain('aria-label="Restore username old-author"')
    expect(html).toContain("Saved")
  })
})
