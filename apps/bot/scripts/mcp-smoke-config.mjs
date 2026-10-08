import assert from "node:assert/strict"

export function selectSmokeConfig(input, { chromeOnly = false, firecrawlOnly = false } = {}) {
  assert.ok(!(chromeOnly && firecrawlOnly), "Choose only one server filter")
  assert.ok(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      input.mcpServers &&
      typeof input.mcpServers === "object" &&
      !Array.isArray(input.mcpServers),
    "MCP smoke configuration must contain a server map",
  )
  const names = chromeOnly
    ? ["chrome-devtools"]
    : firecrawlOnly
      ? ["firecrawl"]
      : ["chrome-devtools", "firecrawl"]
  const mcpServers = Object.fromEntries(
    names
      .filter(
        (name) =>
          Object.hasOwn(input.mcpServers, name) && input.mcpServers[name]?.enabled !== false,
      )
      .map((name) => [name, input.mcpServers[name]]),
  )
  assert.ok(
    Object.keys(mcpServers).length > 0,
    chromeOnly || firecrawlOnly
      ? `Requested smoke server ${names[0]} is missing or disabled`
      : "No enabled default MCP servers are configured for the smoke test",
  )
  return { ...input, mcpServers }
}
