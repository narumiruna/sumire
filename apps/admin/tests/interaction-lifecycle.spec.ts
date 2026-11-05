import { expect, test } from "@playwright/test"
import { adminFixture, navigate } from "./admin-fixture.js"

test("Skills maintenance closes on browser history without focus on a hidden trigger", async ({
  page,
}) => {
  const requests = await adminFixture(page)
  await navigate(page, "Skills")
  const trigger = page.getByRole("button", {
    name: "Installation instructions",
    exact: true,
    includeHidden: true,
  })
  await trigger.click()
  await expect(
    page.getByRole("dialog", { name: "Installation instructions", exact: true }),
  ).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "聊天管理", exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(trigger).not.toBeFocused()
  await navigate(page, "Skills")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await trigger.click()
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
})
