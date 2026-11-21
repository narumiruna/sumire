import { expect, it } from "vitest"
import {
  isIssuesMcpCallback,
  readIssuesMcpRequest,
  validateIssuesMcpRedirect,
} from "./issues-mcp-oauth.js"

const origin = "https://admin.example.test"
const callback = "http://127.0.0.1:8787/callback"
const query = `?iss=${encodeURIComponent(origin)}&state=opaque%20state`

it("accepts only a single exact request identifier in the consent fragment", () => {
  const id = `${"a_-".repeat(14)}a`
  expect(readIssuesMcpRequest(`#issues-mcp=${id}`)).toBe(id)
  expect(readIssuesMcpRequest("#setup=foo")).toBeNull()
  for (const hash of ["#issues-mcp", "#issues-mcp=", `#issues-mcp=${id}&x=1`, `#issues-mcp=${id}.`])
    expect(readIssuesMcpRequest(hash)).toBe("")
})

it("accepts canonical explicit-port loopback callbacks only", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(isIssuesMcpCallback(`http://${host}:8787/callback`)).toBe(true)
  for (const invalid of [
    "https://127.0.0.1:8787/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:08787/callback",
    "http://user@127.0.0.1:8787/callback",
    "http://127.0.0.1.example.test:8787/callback",
    "http://127.1:8787/callback",
    "http://127.0.0.1:8787/foo/../callback",
    "http://127.0.0.1:8787//other",
    `${callback}?`,
    `${callback}#`,
  ])
    expect(isIssuesMcpCallback(invalid), invalid).toBe(false)
})

it("accepts only matching callbacks with a single issuer, state and expected OAuth result", () => {
  const success = `${callback}${query}&code=code`
  const failure = `${callback}${query}&error=access_denied`
  expect(validateIssuesMcpRedirect(callback, success, true, origin)).toBe(success)
  expect(validateIssuesMcpRedirect(callback, failure, false, origin)).toBe(failure)
  for (const invalid of [
    failure,
    `${callback}?iss=${encodeURIComponent(origin)}&state=&code=code`,
    `${callback}?iss=https%3A%2F%2Fother.example.test&state=state&code=code`,
    success.replace("&state=opaque%20state", ""),
    success.replace("&code=code", "&code="),
    success.replace(":8787", ":8788"),
    success.replace("/callback", "/other"),
    `${success}&code=again`,
    `${success}&state=again`,
    `${success}&error=access_denied`,
    `${success}#`,
  ])
    expect(validateIssuesMcpRedirect(callback, invalid, true, origin), invalid).toBeUndefined()
  expect(validateIssuesMcpRedirect(callback, success, false, origin)).toBeUndefined()
})
