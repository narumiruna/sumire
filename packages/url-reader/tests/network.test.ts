import type { LookupAddress } from "node:dns"

import { describe, expect, it, vi } from "vitest"

import {
  assertPublicUrl,
  type PublicUrlResolver,
  readResponseBytes,
  safeFetch,
} from "../src/core/network.js"

function resolverFor(addresses: readonly LookupAddress[]): PublicUrlResolver {
  return async () => [...addresses]
}

describe("network safety", () => {
  it.each([
    "http://127.0.0.1/private",
    "http://10.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/private",
    "http://localhost/private",
  ])("rejects non-public target %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(/Local|Private|non-routable/u)
  })

  it("rejects hostnames that resolve to a private address", async () => {
    const resolve = resolverFor([{ address: "192.168.1.10", family: 4 }])
    await expect(assertPublicUrl("https://public.example/path", { resolve })).rejects.toThrow(
      "private",
    )
  })

  it("rejects DNS rebinding at the connection lookup", async () => {
    let calls = 0
    const resolve: PublicUrlResolver = async () => {
      calls += 1
      return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]
    }

    await expect(safeFetch("https://rebind.example/path", {}, { resolve })).rejects.toThrow(
      "private",
    )
    expect(calls).toBe(2)
  })

  it("returns redirects without following them in manual mode", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://other.example/final" } }),
    )
    const resolve = resolverFor([{ address: "93.184.216.34", family: 4 }])

    const response = await safeFetch(
      "https://public.example/start",
      { redirect: "manual" },
      { fetchImplementation, resolve },
    )
    expect(response.status).toBe(302)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it("validates every redirect before issuing the next request", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    )
    const resolve = resolverFor([{ address: "93.184.216.34", family: 4 }])

    await expect(
      safeFetch("https://public.example/start", {}, { fetchImplementation, resolve }),
    ).rejects.toThrow("Private")
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it.each([301, 302, 303, 307, 308])(
    "rejects a public HTTP redirect before issuing a downgraded request (status %s)",
    async (status) => {
      const fetchImplementation = vi.fn(async (input: string | URL) =>
        new URL(input).protocol === "https:"
          ? new Response(null, { status, headers: { location: "http://public.example/final" } })
          : new Response("downgraded content"),
      )
      const resolve = vi.fn(resolverFor([{ address: "93.184.216.34", family: 4 }]))
      await expect(
        safeFetch(
          "https://public.example/start",
          {},
          {
            allowedSchemes: new Set(["https"]),
            fetchImplementation,
            resolve,
          },
        ),
      ).rejects.toThrow("URL scheme is not allowed: http")
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
    },
  )

  it("allows relative HTTPS redirects under an HTTPS-only policy", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL) =>
      new URL(input).pathname === "/start"
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("secure content"),
    )
    const response = await safeFetch(
      "https://public.example/start",
      {},
      {
        allowedSchemes: new Set(["https"]),
        fetchImplementation,
        resolve: resolverFor([{ address: "93.184.216.34", family: 4 }]),
      },
    )
    expect(await response.text()).toBe("secure content")
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toBe("https://public.example/final")
  })

  it("continues to allow public HTTP redirects under the default policy", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL) =>
      new URL(input).protocol === "https:"
        ? new Response(null, { status: 302, headers: { location: "http://public.example/final" } })
        : new Response("public content"),
    )
    const response = await safeFetch(
      "https://public.example/start",
      {},
      {
        fetchImplementation,
        resolve: resolverFor([{ address: "93.184.216.34", family: 4 }]),
      },
    )
    expect(await response.text()).toBe("public content")
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("does not permit non-HTTP schemes even when the caller includes them", async () => {
    await expect(
      assertPublicUrl("ftp://8.8.8.8/file", {
        allowedSchemes: new Set(["ftp"]),
      }),
    ).rejects.toThrow("scheme")
  })

  it("stops reading a streamed response at the byte limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        },
      }),
    )
    await expect(readResponseBytes(response, 3)).rejects.toThrow("3 byte limit")
  })
})
