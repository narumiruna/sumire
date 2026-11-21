import { expect, type Locator } from "@playwright/test"

// Open only the target's ancestor disclosures, from the outermost to the innermost.
// Targets inside closed disclosures must use CSS, text, or includeHidden role locators.
export async function reveal(target: Locator): Promise<Locator> {
  await expect(target).toHaveCount(1)
  const ancestors = target.locator("xpath=ancestor::details")
  const targetElement = await target.elementHandle()
  for (const disclosure of await ancestors.all()) {
    const summary = disclosure.locator(":scope > summary")
    // A summary is already visible when its own disclosure is closed.
    if (await summary.evaluate((element, target) => element.contains(target), targetElement))
      continue
    if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
      await summary.click()
  }
  return target
}

export async function openDisclosure(disclosure: Locator): Promise<void> {
  await reveal(disclosure)
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
    await disclosure.locator(":scope > summary").click()
}

export function rawTab(scope: Locator, name: string): Locator {
  return scope.locator(".durable-raw-collections [role=tab]").filter({
    has: scope.page().getByText(name, { exact: true }),
  })
}

export function recordLink(scope: Locator, id: number): Locator {
  return scope.locator(".durable-record-link").filter({
    has: scope.page().getByText(`#${id}`, { exact: true }),
  })
}

export async function click(target: Locator): Promise<void> {
  await reveal(target)
  await target.click()
}
