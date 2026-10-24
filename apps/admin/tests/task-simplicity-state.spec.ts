import { expect, test } from "@playwright/test"
import { navigate, openDisclosure } from "./admin-fixture.js"
import { remediationFixture as fixture } from "./remediation-fixture.js"

for (const width of [390, 1440]) {
  test.describe(`${width}px task safeguards`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })

    test("paged access, signed approval, cancellation, and failure keep one exact transaction", async ({
      page,
    }) => {
      const state = await fixture(page)
      state.policy().privateUsers = [42, ...Array.from({ length: 99 }, (_, index) => 1000 + index)]
      const original = structuredClone(state.policy())
      await page.reload()
      await navigate(page, "Access")
      await page
        .getByRole("button", { name: "Next private-message access page", exact: true })
        .click()
      await expect(page.getByText("21–40 of 100", { exact: true })).toBeVisible()
      const search = page.getByRole("textbox", {
        name: "Search private-message access",
        exact: true,
      })
      await search.fill("1098")
      await expect(page.locator("#access-users-list tbody tr")).toHaveCount(1)
      await page.getByRole("button", { name: "Revoke access for ID 1098", exact: true }).click()
      await expect(page.locator("#access-users-list tbody tr")).toContainText("Pending revocation")
      await search.fill("")
      await expect(page.locator("#access-users-list tbody tr")).toHaveCount(20)
      const input = page.getByRole("textbox", { name: "Telegram ID to approve", exact: true })
      await input.fill("-246")
      await input.press("Enter")
      const review = page.getByRole("alertdialog")
      await expect(review).toContainText("revoke 1098")
      await expect(review).toContainText("approve -246")
      await expect(review).toContainText("Active work will be cancelled")
      await expect(review).toContainText("cannot undo completed external actions")
      await review.getByRole("button", { name: "Cancel", exact: true }).click()
      expect(state.writes).toEqual([])
      expect(state.policy()).toEqual(original)
      state.fail()
      await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await review.getByRole("button", { name: "Save changes", exact: true }).click()
      await expect(page.getByRole("alert").first()).toContainText("Settings changed; reload")
      expect(state.policy()).toEqual(original)
      state.fail(false)
      await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await expect(review).toContainText("approve -246")
      await review.getByRole("button", { name: "Save changes", exact: true }).click()
      const expected = {
        ...original,
        privateUsers: original.privateUsers.filter((id) => id !== 1098),
        groups: [...original.groups, -246],
      }
      await expect.poll(() => state.policy()).toEqual(expected)
      expect(state.writes).toEqual([
        { path: "/api/settings", body: { revision: 1, policy: expected } },
        { path: "/api/settings", body: { revision: 1, policy: expected } },
      ])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    })

    test("direct approval respects unfinished input and does not save connection or model drafts", async ({
      page,
    }) => {
      const state = await fixture(page)
      const original = structuredClone(state.policy())
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await page.getByLabel("MCP server name", { exact: true }).fill("connection-draft")
      await navigate(page, "Model Providers")
      await page.getByRole("button", { name: "Model", exact: true }).click()
      await page.getByRole("option", { name: /Other/ }).click()
      await openDisclosure(page, "Custom endpoint")
      await page.getByLabel("Provider ID", { exact: true }).fill("unfinished-endpoint")
      await navigate(page, "Access")
      const input = page.getByLabel("Telegram ID to approve", { exact: true })
      await input.fill("-246")
      await input.press("Enter")
      const review = page.getByRole("alertdialog")
      await expect(review.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled()
      expect(state.writes).toEqual([])
      await review
        .getByRole("button", {
          name: "Continue editing: Model providers — Custom endpoint",
          exact: true,
        })
        .click()
      await expect(page.getByLabel("Provider ID", { exact: true })).toBeFocused()
      await expect(page.getByLabel("Provider ID", { exact: true })).toHaveValue(
        "unfinished-endpoint",
      )
      await page.getByRole("button", { name: "Discard custom endpoint draft", exact: true }).click()
      await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await review.getByRole("button", { name: "Save changes", exact: true }).click()
      await expect
        .poll(() => state.policy())
        .toEqual({ ...original, groups: [...original.groups, -246] })
      await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeEnabled()
      await navigate(page, "MCP connections")
      await expect(page.getByLabel("MCP server name", { exact: true })).toHaveValue(
        "connection-draft",
      )
      await navigate(page, "Model Providers")
      await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Other")
      await expect(
        page.getByRole("button", { name: "Save model availability", exact: true }),
      ).toBeDisabled()
      expect(state.writes.map((write) => write.path)).toEqual(["/api/settings"])
    })

    test("HTTP creation retries unchanged basic fields without exposing patch controls", async ({
      page,
    }) => {
      const state = await fixture(page)
      await navigate(page, "MCP connections")
      await page.getByRole("button", { name: "Add connection", exact: true }).click()
      await page.getByLabel("MCP server name", { exact: true }).fill("http-example")
      await page.getByRole("combobox", { name: "Connection type", exact: true }).click()
      await page.getByRole("option", { name: "HTTP endpoint", exact: true }).click()
      const url = page.getByLabel("Connection URL", { exact: true })
      await url.fill("https://example.com/mcp")
      await expect(page.getByLabel("Server configuration JSON", { exact: true })).toBeHidden()
      const advancedField = page.locator('[aria-label="Edit MCP description"]')
      await expect(advancedField).toHaveCount(1)
      await expect(advancedField).not.toHaveAttribute("aria-describedby")
      state.fail()
      await page.getByRole("button", { name: "Save connection", exact: true }).click()
      await expect(page.getByRole("alert").first()).toContainText("Settings changed; reload")
      await expect(url).toHaveValue("https://example.com/mcp")
      await page.getByRole("button", { name: "Close connection editor", exact: true }).click()
      await page.getByRole("button", { name: "Resume connection draft", exact: true }).click()
      await expect(page.getByLabel("MCP server name", { exact: true })).toBeFocused()
      await expect(url).toHaveValue("https://example.com/mcp")
      state.fail(false)
      await page.getByRole("button", { name: "Save connection", exact: true }).click()
      await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
      expect(state.writes).toEqual([
        {
          path: "/api/mcp/http-example",
          body: {
            revision: 1,
            config: {
              args: [],
              type: "http",
              enabled: true,
              exposure: "codemode",
              url: "https://example.com/mcp",
            },
          },
        },
        {
          path: "/api/mcp/http-example",
          body: {
            revision: 1,
            config: {
              args: [],
              type: "http",
              enabled: true,
              exposure: "codemode",
              url: "https://example.com/mcp",
            },
          },
        },
      ])
    })

    test("source search preserves expansion, draft selections, and server restrictions", async ({
      page,
    }) => {
      const state = await fixture(page)
      const server = state.inventory.mcp.find((item) => item.name === "fixture")
      if (!server) throw new Error("Missing fixture MCP server")
      server.tools = ["mcp__fixture__read"]
      state.policy().tools.push("mcp__fixture__read")
      state.policy().defaults.tools?.push("mcp__fixture__read")
      const original = structuredClone(state.policy())
      await page.reload()
      await navigate(page, "Tool permissions")
      const defaults = page.getByRole("checkbox", {
        name: "Default chat permission for tool read_url_content",
        exact: true,
      })
      await defaults.uncheck()
      await page.getByRole("button", { name: "Collapse all", exact: true }).click()
      const search = page.getByRole("textbox", { name: "Search tools and servers", exact: true })
      await search.fill("FIXTURE")
      const row = page
        .getByRole("listitem")
        .filter({ has: page.getByText("mcp__fixture__read", { exact: true }) })
      await expect(row).toContainText("Blocked by global or default server permission")
      await expect(
        row.getByRole("checkbox", {
          name: "Default chat permission for tool mcp__fixture__read",
          exact: true,
        }),
      ).toBeChecked()
      await expect(
        page.getByRole("checkbox", { name: "Globally allow tool mcp__fixture__read", exact: true }),
      ).toBeHidden()
      await search.fill("no-such-tool")
      await expect(page.locator(".permission-row:visible")).toHaveCount(0)
      await search.fill("")
      await expect(defaults).toBeHidden()
      await expect(
        page.getByRole("button", { name: "MCP: fixture · 1 tool", exact: true }),
      ).toHaveAttribute("aria-expanded", "false")
      await search.fill("read_url_content")
      await expect(defaults).not.toBeChecked()
      await page.getByRole("button", { name: "Review and save changes", exact: true }).click()
      await expect(
        page
          .getByRole("alertdialog")
          .getByRole("list", { name: "Settings changes to save", exact: true })
          .getByRole("listitem"),
      ).toHaveCount(1)
      expect(state.policy()).toEqual(original)
      expect(state.writes).toEqual([])
    })
  })
}

test("credential refresh keeps the authentication controls open and restores keyboard focus", async ({
  page,
}) => {
  const state = await fixture(page)
  const provider = state.inventory.providers.find((item) => item.id === "fixture")
  if (!provider) throw new Error("Missing fixture provider")
  provider.configured = false
  await page.reload()
  await navigate(page, "Model Providers")
  await page.route("**/api/providers/fixture/credential", async (route) => {
    provider.configured = true
    await route.fulfill({ json: { ok: true } })
  })
  const configure = page.getByRole("button", { name: "Configure authentication", exact: true })
  await configure.click()
  await page.getByLabel("API key", { exact: true }).fill("synthetic-key-for-focus-test")
  await page.getByRole("button", { name: "Save API key", exact: true }).click()
  await expect(configure).toBeVisible()
  await expect(configure).toBeFocused()
  await expect(page.locator(".provider-authentication")).toHaveAttribute("open", "")
  expect(state.writes).toEqual([])
})

test("invalid or duplicate signed IDs do not stage approval or bypass validation", async ({
  page,
}) => {
  const state = await fixture(page)
  await navigate(page, "Access")
  const input = page.getByLabel("Telegram ID to approve", { exact: true })
  for (const value of ["0", "-0", "42.5", "42,43", "invalid", "9007199254740993", "42", "-100"]) {
    await input.fill(value)
    await input.press("Enter")
    await expect(input).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByRole("alert")).toBeVisible()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toHaveCount(0)
  }
  await page.getByRole("button", { name: "Clear ID input", exact: true }).click()
  await expect(page.locator('#save-status[data-compact="true"]')).toBeVisible()
  expect(state.writes).toEqual([])
})

for (const { width, zoom } of [
  { width: 320, zoom: 1 },
  { width: 640, zoom: 2 },
]) {
  test(`approval and search reflow with keyboard input at ${width}px and ${zoom}x zoom`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await fixture(page)
    await page.evaluate((value) => {
      document.body.style.zoom = String(value)
    }, zoom)
    await navigate(page, "Access")
    const input = page.getByLabel("Telegram ID to approve", { exact: true })
    await input.fill("43")
    await input.press("Enter")
    await expect(page.getByRole("alertdialog")).toContainText("approve 43")
    await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await expect(
      page.getByRole("button", { name: "Review and save changes", exact: true }),
    ).toBeFocused()
    await navigate(page, "Tool permissions")
    const search = page.getByLabel("Search tools and servers", { exact: true })
    await search.fill("read_url_content")
    await expect(search).toBeFocused()
    await expect(page.locator(".permission-row:visible")).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(state.writes).toEqual([])
  })
}
