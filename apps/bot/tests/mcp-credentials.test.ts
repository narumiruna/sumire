import { describe, expect, it } from "vitest"
import { mcpCredentialKind } from "../src/agent/mcp-credentials.js"

describe("MCP credential name classification", () => {
  it.each([
    "Authorization",
    "Authentication",
    "X-Auth",
    "x-auth",
    "XAuth",
    "PROXY_AUTHORIZATION",
    "authToken",
  ])("recognizes auth variant %s", (name) => expect(mcpCredentialKind(name)).toBe("auth"))
  it.each(["Cookie", "Set-Cookie", "setCookie"])("recognizes cookie variant %s", (name) =>
    expect(mcpCredentialKind(name)).toBe("cookie"),
  )
  it.each([
    "SECRET_KEY",
    "API_KEY",
    "apiKey",
    "PRIVATEKEY",
    "ACCESS_TOKEN",
    "refreshToken",
    "clientSecret",
    "signature",
  ])("recognizes credential name %s", (name) => expect(mcpCredentialKind(name)).toBe("secret"))
  it.each([
    "MONKEY",
    "AUTHOR",
    "KEYBOARD",
    "TOKENIZER",
    "AUTHORS",
    "PUBLIC_DESCRIPTION",
    "NETWORK_SETTINGS",
    "ROOT_PATH",
  ])("does not match ordinary substring name %s", (name) =>
    expect(mcpCredentialKind(name)).toBeUndefined(),
  )
})
