import { initialPolicy } from "@narumitw/sumire-policy"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { GithubNotifications, notificationRecipientError } from "./github-notifications.js"

function render(ids: number[] = [], savedIds = ids) {
  const policy = initialPolicy()
  policy.githubNotifications.allowedUserIds = ids
  const saved = initialPolicy()
  saved.githubNotifications.allowedUserIds = savedIds
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

describe("GitHub notification administration", () => {
  it.each(["", "0", "-100", "@someone", "42.5", "1e3", "+42", "0042", "9007199254740992"])(
    "rejects invalid user ID %s before staging",
    (value) => {
      expect(notificationRecipientError(value, [])).toContain("positive Telegram user ID")
    },
  )
  it("accepts positive safe IDs and checks duplicate and capacity limits", () => {
    expect(notificationRecipientError(" 42 ", [])).toBe("")
    expect(notificationRecipientError(String(Number.MAX_SAFE_INTEGER), [])).toBe("")
    expect(notificationRecipientError("42", [42])).toContain("already")
    expect(
      notificationRecipientError(
        "1001",
        Array.from({ length: 1000 }, (_, index) => index + 1),
      ),
    ).toContain("limit is 1,000")
  })
  it("explains default denial and the shared token and host trust boundary", () => {
    const html = render()
    expect(html).toContain("No recipients selected. An empty saved list denies everyone.")
    expect(html).toContain("GH_TOKEN")
    expect(html).toContain("Groups are always denied")
    expect(html).toContain("administrators must also be listed")
    expect(html).toContain("not a security sandbox")
    expect(html).toContain("Manage chat access")
    expect(html).toContain("Manage tool permissions")
    expect(html).not.toContain("GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS")
  })
  it("distinguishes staged additions and revocations from saved recipients", () => {
    const html = render([42, 43], [42, 44])
    expect(html).toContain("2 selected recipients")
    expect(html).toContain("Pending addition")
    expect(html).toContain("Pending removal")
    expect(html).toContain('aria-label="Remove recipient 43"')
    expect(html).toContain('aria-label="Restore recipient 44"')
    expect(html).toContain("Saved")
  })
})
