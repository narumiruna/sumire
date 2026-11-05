import { expect, test } from "@playwright/test"
import { adminFixture, navigate, openDisclosure } from "./admin-fixture.js"

const metadata = {
  revision: 1,
  applied: 1,
  status: "applied",
  secretStatus: "ready",
  entries: [
    { name: "TOKEN", kind: "secret", configured: true, updatedAt: 1790000000000, revision: 1 },
  ],
}

test("browser Back requires a decision and preserves the destination on cancel", async ({
  page,
}) => {
  await adminFixture(page)
  await page.route("**/api/runtime-config", (route) => route.fulfill({ json: metadata }))
  await navigate(page, "Secrets & variables")
  await page.getByRole("button", { name: "Add secret", exact: true }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused()
  await page.getByLabel("Runtime secret value", { exact: true }).fill("back-secret")
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.goBack()
  await expect(page).toHaveURL(/section=Secrets/)
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("back-secret")
  page.once("dialog", (dialog) => dialog.accept())
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Chats", exact: true })).toBeVisible()
  await expect(page.getByLabel("Runtime secret value")).toHaveCount(0)
  await navigate(page, "Secrets & variables")
  await page.getByRole("button", { name: "Add secret", exact: true }).click()
  await expect(page.getByLabel("Runtime secret value")).toHaveValue("")
})

test("policy drafts must be saved or discarded before runtime mutation", async ({ page }) => {
  await adminFixture(page)
  await page.route("**/api/runtime-config", (route) => route.fulfill({ json: metadata }))
  await navigate(page, "Tool permissions")
  const input = page.getByLabel("Additional approved tool name", { exact: true })
  await openDisclosure(page, "Approve an exact tool name")
  await input.fill("read_variable")
  await page.getByRole("button", { name: "Add tool to pending approval", exact: true }).click()
  await navigate(page, "Secrets & variables")
  await expect(page.getByText(/Save or discard pending policy, MCP/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Add secret", exact: true })).toBeDisabled()
})

test("MCP reference editor submits explicit binding text without stored plaintext", async ({
  page,
}) => {
  await adminFixture(page)
  await page.route("**/api/runtime-config", (route) => route.fulfill({ json: metadata }))
  let submitted: unknown
  await page.route("**/api/mcp/reference-server", async (route) => {
    submitted = route.request().postDataJSON()
    await route.fulfill({ json: {} })
  })
  await navigate(page, "MCP connections")
  await page.getByRole("button", { name: "Add connection", exact: true }).click()
  await page.getByLabel("MCP server name", { exact: true }).fill("reference-server")
  await page.getByLabel("Connection command", { exact: true }).fill("fixture-command")
  await openDisclosure(page, "Stored references (recommended)")
  await page.getByLabel("Binding scope", { exact: true }).click()
  await page.getByRole("option", { name: "env", exact: true }).click()
  await page.getByLabel("Binding field name", { exact: true }).fill("API_KEY")
  await page.getByLabel("Stored name", { exact: true }).fill("TOKEN")
  await page.getByRole("button", { name: "Stage stored reference", exact: true }).click()
  await page.getByRole("button", { name: "Save connection", exact: true }).click()
  await expect
    .poll(() => submitted)
    .toEqual({
      revision: 1,
      config: {
        command: "fixture-command",
        args: [],
        enabled: true,
        exposure: "codemode",
        env: { API_KEY: `\${TOKEN}` },
      },
    })
})
