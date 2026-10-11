import { connect } from "node:net"

import { describe, expect, it, vi } from "vitest"

import { startPublicProxy } from "../src/core/public-proxy.js"

describe("public proxy", () => {
  it("rejects HTTP forwarding before DNS resolution under an HTTPS-only policy", async () => {
    const resolveTarget = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }])
    const proxy = await startPublicProxy({
      allowedSchemes: new Set(["https"]),
      resolve: resolveTarget,
    })
    try {
      const endpoint = new URL(proxy.url)
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(endpoint.port), endpoint.hostname)
        let content = ""
        socket.setEncoding("utf8")
        socket.on("connect", () => {
          socket.write(
            "GET http://public.example/final HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n",
          )
        })
        socket.on("data", (chunk: string) => {
          content += chunk
        })
        socket.on("end", () => resolve(content))
        socket.on("error", reject)
      })
      expect(response).toContain("502 Bad Gateway")
      expect(resolveTarget).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it("rejects CONNECT targets whose connection-time lookup is private", async () => {
    let resolutions = 0
    const proxy = await startPublicProxy({
      resolve: async () => {
        resolutions += 1
        return [{ address: "127.0.0.1", family: 4 }]
      },
    })
    try {
      const endpoint = new URL(proxy.url)
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(endpoint.port), endpoint.hostname)
        let content = ""
        socket.setEncoding("utf8")
        socket.on("connect", () => {
          socket.write(
            "CONNECT attacker.example:443 HTTP/1.1\r\nHost: attacker.example:443\r\n\r\n",
          )
        })
        socket.on("data", (chunk: string) => {
          content += chunk
        })
        socket.on("end", () => resolve(content))
        socket.on("error", reject)
      })
      expect(response).toContain("502 Bad Gateway")
      expect(resolutions).toBe(1)
    } finally {
      await proxy.close()
    }
  })
})
