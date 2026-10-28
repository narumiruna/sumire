import { describe, expect, it, vi } from "vitest"
import { allowsNotificationChat, createNotificationClient } from "../src/index.js"

const record = {
  id: "1",
  unread: true,
  reason: "mention",
  updated_at: "2026-01-01T00:00:00Z",
  repository: { full_name: "example/project", private: true },
  subject: {
    title: "Review this",
    type: "PullRequest",
    url: "https://api.github.com/repos/example/project/pulls/12",
  },
  secret_extra: "must-not-appear",
}
function setup(response = () => new Response(JSON.stringify([record]))) {
  const authorize = vi.fn()
  const token = vi.fn(() => "fixture-token")
  const fetcher = vi.fn<typeof fetch>(async () => response())
  return {
    authorize,
    token,
    fetcher,
    client: createNotificationClient({ authorize, token, fetch: fetcher }),
  }
}

describe("allowlist", () => {
  it("only admits exact positive private IDs from structured policy", () => {
    expect(allowsNotificationChat(1, [])).toBe(false)
    expect(allowsNotificationChat(1, [1])).toBe(true)
    expect(allowsNotificationChat(2, [1])).toBe(false)
    expect(allowsNotificationChat(-1, [1])).toBe(false)
    expect(allowsNotificationChat(0, [1])).toBe(false)
    expect(allowsNotificationChat(-1, [-1])).toBe(false)
    expect(allowsNotificationChat(1.5, [1.5])).toBe(false)
    expect(allowsNotificationChat(Number.MAX_SAFE_INTEGER + 1, [Number.MAX_SAFE_INTEGER + 1])).toBe(
      false,
    )
  })
})

it("makes exactly one GET with bounded options and projects metadata only", async () => {
  const { client, fetcher, authorize } = setup(
    () =>
      new Response(JSON.stringify([record]), {
        headers: { link: '<https://evil.invalid/>; rel="next"' },
      }),
  )
  const result = await client.list()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const call = fetcher.mock.calls[0]
  if (!call) throw new Error("Missing request")
  const [url, init] = call
  expect(String(url)).toBe(
    "https://api.github.com/notifications?page=1&per_page=20&all=false&participating=false",
  )
  expect(init).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { Authorization: "Bearer fixture-token" },
  })
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(result).toMatchObject({
    page: 1,
    perPage: 20,
    hasMore: true,
    notifications: [
      { title: "Review this", url: "https://github.com/example/project/pull/12", private: true },
    ],
  })
  expect(JSON.stringify(result)).not.toContain("must-not-appear")
  expect(JSON.stringify(result)).not.toContain("fixture-token")
})
it("passes explicit filters without altering notification state", async () => {
  const { client, fetcher } = setup()
  await client.list({ page: 2, perPage: 5, all: true, participating: true })
  expect(String(fetcher.mock.calls[0]?.[0])).toContain(
    "page=2&per_page=5&all=true&participating=true",
  )
})
it("rejects authorization before resolving a credential or making a request", async () => {
  const { client, authorize, token, fetcher } = setup()
  authorize.mockImplementation(() => {
    throw new Error("denied")
  })
  await expect(client.list()).rejects.toThrow("denied")
  expect(token).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})
it("rechecks revocation after the network request", async () => {
  const { client, authorize } = setup()
  authorize
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error("revoked")
    })
  await expect(client.list()).rejects.toThrow("revoked")
})
it.each([{ page: 0 }, { perPage: 51 }, { page: 1001 }, { perPage: 1.5 }])(
  "rejects invalid limits %j",
  async (query) => {
    const { client, fetcher, token } = setup()
    await expect(client.list(query)).rejects.toThrow("Invalid")
    expect(fetcher).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
  },
)
it.each([undefined, "", "token\nsecret", "token secret"])(
  "rejects absent/invalid tokens",
  async (value) => {
    const fetcher = vi.fn<typeof fetch>()
    const client = createNotificationClient({ authorize() {}, token: () => value, fetch: fetcher })
    await expect(client.list()).rejects.toThrow("secret is required")
    expect(fetcher).not.toHaveBeenCalled()
  },
)
it.each([401, 403, 429, 500, 302])("sanitizes HTTP %s without retrying", async (status) => {
  const { client, fetcher } = setup(
    () => new Response("credential-and-private-message", { status }),
  )
  await expect(client.list()).rejects.toThrow(
    `GitHub notifications request failed (HTTP ${status})`,
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it("does not surface network/redirect error details", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error("fixture-token private-url")
  })
  const client = createNotificationClient({
    authorize() {},
    token: () => "fixture-token",
    fetch: fetcher,
  })
  await expect(client.list()).rejects.toThrow("GitHub notifications request failed or timed out")
})
it.each([
  "not-json",
  "{}",
  JSON.stringify([{ ...record, unread: "true" }]),
  JSON.stringify([{ ...record, subject: { ...record.subject, title: "x".repeat(2049) } }]),
])("rejects malformed data", async (body) => {
  await expect(setup(() => new Response(body)).client.list()).rejects.toThrow(
    "invalid notification data",
  )
})
it("rejects a response with too many entries", async () => {
  await expect(
    setup(() => new Response(JSON.stringify([record, record]))).client.list({ perPage: 1 }),
  ).rejects.toThrow("invalid notification data")
})
it.each([false, true])("bounds response size, declared=%s", async (declared) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024 + 1))
      controller.close()
    },
  })
  const { client } = setup(
    () =>
      new Response(body, { headers: declared ? { "content-length": String(512 * 1024 + 1) } : {} }),
  )
  await expect(client.list()).rejects.toThrow("size limit")
})
it("preserves caller cancellation and avoids requests when already aborted", async () => {
  const { client, fetcher } = setup()
  const abort = new AbortController()
  abort.abort(new Error("cancelled by caller"))
  await expect(client.list({}, abort.signal)).rejects.toThrow("cancelled by caller")
  expect(fetcher).not.toHaveBeenCalled()
})
it("does not return results when caller cancels during the request", async () => {
  const abort = new AbortController()
  const { client } = setup(() => {
    abort.abort(new Error("stop"))
    return new Response(JSON.stringify([record]))
  })
  await expect(client.list({}, abort.signal)).rejects.toThrow("stop")
})
it.each([
  "https://evil.invalid/secret",
  "https://api.github.com/repos/another/repo/issues/1",
  "http://api.github.com/repos/example/project/issues/1",
])("omits unsafe subject URL %s", async (url) => {
  const { client } = setup(
    () => new Response(JSON.stringify([{ ...record, subject: { ...record.subject, url } }])),
  )
  expect((await client.list()).notifications[0]).not.toHaveProperty("url")
})
