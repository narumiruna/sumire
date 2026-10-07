import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { McpCapability } from "../dist/agent/mcp-capability.js"
import { loadMcpConfig } from "../dist/agent/mcp-config.js"

assert.ok(process.env.FIRECRAWL_API_KEY, "FIRECRAWL_API_KEY is required for the live smoke")
const firecrawlOnly = process.argv.includes("--firecrawl-only")
const directory = await mkdtemp("/tmp/sumire-mcp-smoke-")
let capability
try {
  const input = JSON.parse(await readFile("/app/mcp.json", "utf8"))
  let chromium
  if (firecrawlOnly) {
    input.mcpServers["chrome-devtools"].enabled = false
  } else {
    chromium = (await readdir("/ms-playwright")).find((name) => /^chromium-\d+$/.test(name))
    assert.ok(chromium, "A Playwright Chromium installation is required")
    const platform = (await readdir(path.join("/ms-playwright", chromium))).find((name) =>
      name.startsWith("chrome-linux"),
    )
    assert.ok(platform, "A Chromium executable directory is required")
    const executable = path.join("/ms-playwright", chromium, platform, "chrome")
    // Container-only override: keep the tracked user config unchanged and retain Chrome's sandbox.
    input.mcpServers["chrome-devtools"].args.push(
      "--headless",
      "--isolated",
      "--executablePath",
      executable,
      "--no-page-id-routing",
      "--no-usage-statistics",
      "--no-performance-crux",
    )
  }
  const file = path.join(directory, "mcp.json")
  await writeFile(file, JSON.stringify(input), { mode: 0o600 })
  const config = await loadMcpConfig(
    { botMcpEnabled: true, botMcpConfigPath: file },
    { warn: (text) => console.error(text) },
  )
  assert.equal(config.servers.length, firecrawlOnly ? 1 : 2)
  capability = new McpCapability(
    config,
    directory,
    path.join(directory, "sessions"),
    { warn: (text) => console.error(text) },
    () => {},
  )
  await capability.ready()
  for (
    let attempt = 0;
    !firecrawlOnly &&
    !capability.tools.some((t) => t.name.startsWith("mcp__chrome_devtools__")) &&
    attempt < 5;
    attempt++
  )
    await capability.ready()
  const call = async (name, args) => {
    const tool = capability.tools.find((t) => t.name === name)
    assert.ok(tool, `Missing tool ${name}`)
    const result = await tool.execute(
      "live-smoke",
      args,
      AbortSignal.timeout(60000),
      undefined,
      undefined,
    )
    if (result.isError && name.startsWith("mcp__chrome_devtools__"))
      console.error(config.redact(JSON.stringify(result.content)).slice(0, 1500))
    assert.equal(result.isError, false, `${name} returned an error (details withheld)`)
    return result
  }
  if (!firecrawlOnly) {
    await call("mcp__chrome_devtools__new_page", { url: "https://example.com" })
    const snapshot = await call("mcp__chrome_devtools__take_snapshot", {})
    assert.match(JSON.stringify(snapshot.content), /Example Domain/)
    const screenshot = await call("mcp__chrome_devtools__take_screenshot", {
      format: "jpeg",
      quality: 50,
    })
    assert.ok(screenshot.content.some((block) => block.type === "image"))
    console.log(
      `Chrome smoke passed: ${chromium}; non-root uid=${process.getuid()}; sandbox retained; public-page snapshot and screenshot`,
    )
  }
  await call("mcp__firecrawl__firecrawl_search", { query: "example.com Example Domain", limit: 1 })
  console.log(
    "Firecrawl smoke passed: Streamable HTTP; one search with limit=1; credentials and content withheld",
  )
} finally {
  await capability?.close()
  await rm(directory, { recursive: true, force: true })
}
