import { inherited } from "@narumitw/sumire-policy"
import { expect, test } from "@playwright/test"
import { adminFixture, navigate, sectionLabel } from "./admin-fixture.js"
import { durableFixture } from "./durable-fixture.js"
import { remediationFixture } from "./remediation-fixture.js"

test("Shared defaults exposes direct controls and shows a bottom bar only for actual edits", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await adminFixture(page)
  await navigate(page, "Defaults")
  await expect(
    page.getByRole("combobox", { name: "Shared default model", exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toBeVisible()
  await expect(page.getByRole("region", { name: "Pending changes", exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("shared-defaults-desktop.png"), fullPage: true })
  await page.getByRole("button", { name: "Clear shared default model", exact: true }).click()
  await page.getByRole("button", { name: "Clear default in draft", exact: true }).click()
  const changes = page.getByRole("region", { name: "Pending changes", exact: true })
  await expect(changes).toContainText("2 unsaved changes")
  const bounds = await changes.boundingBox()
  expect(bounds && Math.round(bounds.y + bounds.height)).toBe(1000)
  await page.screenshot({ path: info.outputPath("shared-defaults-pending.png"), fullPage: true })
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard settings changes", exact: true }).click()
  await expect(changes).toHaveCount(0)
})

test("two default edits retain their draft after failure and preserve explicit chat overrides on retry", async ({
  page,
}) => {
  const state = await remediationFixture(page)
  const policy = state.policy()
  policy.models = ["fixture/test", "fixture/other"]
  policy.defaults.models = [...policy.models]
  policy.chats["43"] = {
    ...inherited,
    enabled: true,
    model: "fixture/test",
    thinking: "off",
    models: ["fixture/test"],
    tools: [],
    skills: [],
  }
  const other = state.inventory.providers[0]?.models[1]
  if (!other) throw new Error("Missing fixture model")
  other.thinking = ["off", "high"]
  const overrides = structuredClone(policy.chats)
  await page.reload()
  await navigate(page, "Defaults")
  await page.getByRole("combobox", { name: "Shared default model", exact: true }).click()
  await page.getByRole("option", { name: "Other", exact: true }).click()
  await page.getByRole("combobox", { name: "Shared default thinking", exact: true }).click()
  await page.getByRole("option", { name: "high", exact: true }).click()
  const changes = page.getByRole("region", { name: "Pending changes", exact: true })
  await expect(changes).toContainText("2 unsaved changes")
  state.fail()
  await changes.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Settings changed; reload")
  await expect(
    page.getByRole("combobox", { name: "Shared default model", exact: true }),
  ).toHaveAttribute("title", "fixture/other")
  await expect(
    page.getByRole("combobox", { name: "Shared default thinking", exact: true }),
  ).toContainText("high")
  await expect(changes).toContainText("2 unsaved changes")
  expect(state.policy().defaults.model).toBe("fixture/test")
  state.fail(false)
  await changes.getByRole("button", { name: "Review and save changes", exact: true }).click()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(changes).toHaveCount(0)
  expect(state.policy().defaults.model).toBe("fixture/other")
  expect(state.policy().defaults.thinking).toBe("high")
  expect(state.policy().chats).toEqual(overrides)
  expect(state.writes[0]?.body).toEqual(state.writes[1]?.body)
})

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`direction B populated pages and expanded content at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport)
    const state = await remediationFixture(page)
    const skills = [
      { name: "url-guide", description: "Read public pages with the configured URL tools." },
      {
        name: "review-project-documents",
        description: "Review project documents and report the source for each conclusion. ".repeat(
          8,
        ),
      },
      { name: "technical-notes", description: "Write concise technical notes." },
    ]
    state.inventory.skills = skills
    state.policy().skills = skills.map((skill) => skill.name)
    state.policy().defaults.skills = skills.slice(0, 2).map((skill) => skill.name)
    const tools = [
      "read_url_content",
      "bash",
      "read",
      "write",
      "edit",
      "tool_with_a_long_identifier_for_layout_and_copy_checks",
    ]
    state.inventory.tools = tools
    state.inventory.builtInTools = tools
    state.policy().tools = tools
    state.policy().defaults.tools = tools
    const chat = {
      id: 42,
      name: "Example project discussion with a long chat name for layout checks",
      type: "private",
    }
    await page.route("**/api/chats?*", (route) => route.fulfill({ json: [chat] }))
    await page.reload()
    await page
      .getByRole("list", { name: "Chats on this page", exact: true })
      .getByRole("button")
      .first()
      .click()
    for (const section of [
      "Defaults",
      "Model Providers",
      "Tool permissions",
      "Skills",
      "MCP connections",
      "Chats",
      "Access",
      "Audit",
    ]) {
      await navigate(page, section)
      await expect(page.locator("#current-section-heading")).toHaveText(sectionLabel(section))
      if (section === "Chats")
        await expect(page.getByRole("heading", { name: chat.name, exact: true })).toBeVisible()
      if (section === "Tool permissions")
        await page.getByRole("button", { name: "Expand all", exact: true }).click()
      await page.evaluate(() => window.scrollTo(0, 0))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: info.outputPath(`${section.toLowerCase().replaceAll(" ", "-")}.png`),
        fullPage: true,
      })
      if (section === "Skills") {
        const skill = page.getByRole("region", {
          name: "Skill review-project-documents",
          exact: true,
        })
        await skill.getByText("Full description", { exact: true }).click()
        await expect(
          skill.getByText(skills[1]?.description ?? "", { exact: true }).last(),
        ).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        await page.screenshot({ path: info.outputPath("skills-expanded.png"), fullPage: true })
      }
    }
    expect(state.writes).toEqual([])
    const records = await durableFixture(
      page,
      "/?section=Durable&chat=42&view=entries&conversationId=7&objectId=70",
    )
    records.chats = [chat]
    records.entryContent = {
      truncated: false,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Use Node.js 26 or newer. Run npm ci to install dependencies, then run npm run build.\n\nThe Telegram bot runs through Docker Compose from the repository root.",
            },
          ],
        },
      ],
    }
    await page.reload()
    await expect(page.locator(".durable-summary-header")).toContainText(chat.name)
    await expect(
      page.getByRole("region", { name: "Selected item details", exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath("conversation-records.png"), fullPage: true })
    expect(records.methods.every((method) => method === "GET")).toBe(true)
  })
}
