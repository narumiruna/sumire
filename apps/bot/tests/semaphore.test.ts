import { describe, expect, it, vi } from "vitest"

import { Semaphore } from "../src/semaphore.js"

describe("Semaphore", () => {
  it("keeps each instance's capacity separate", async () => {
    const audio = new Semaphore(1)
    const documents = new Semaphore(2)
    const releaseAudio = await audio.acquire()
    const audioAdmitted = vi.fn()
    const queuedAudio = audio.acquire().then((release) => {
      audioAdmitted()
      return release
    })
    const releaseDocument = await documents.acquire()
    const releaseOtherDocument = await documents.acquire()

    expect(audioAdmitted).not.toHaveBeenCalled()
    releaseAudio()
    const releaseQueuedAudio = await queuedAudio
    expect(audioAdmitted).toHaveBeenCalledOnce()
    releaseQueuedAudio()
    releaseDocument()
    releaseOtherDocument()
  })

  it("hands slots to waiters in FIFO order before new arrivals", async () => {
    const semaphore = new Semaphore(1)
    const releaseFirst = await semaphore.acquire()
    const admitted: string[] = []
    const queued = semaphore.acquire().then((release) => {
      admitted.push("queued")
      return release
    })
    const next = semaphore.acquire().then((release) => {
      admitted.push("next")
      return release
    })

    releaseFirst()
    // This arrival precedes the queued acquisition's continuation.
    const arriving = semaphore.acquire().then((release) => {
      admitted.push("arriving")
      return release
    })
    const releaseQueued = await queued
    expect(admitted).toEqual(["queued"])
    releaseQueued()
    const releaseNext = await next
    expect(admitted).toEqual(["queued", "next"])
    releaseNext()
    const releaseArriving = await arriving
    expect(admitted).toEqual(["queued", "next", "arriving"])
    releaseArriving()
  })

  it("ignores repeated releases during handoff and after becoming idle", async () => {
    const semaphore = new Semaphore(1)
    const releaseFirst = await semaphore.acquire()
    const queued = semaphore.acquire()
    releaseFirst()
    releaseFirst()
    const releaseQueued = await queued
    const admitted = vi.fn()
    const next = semaphore.acquire().then((release) => {
      admitted()
      return release
    })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releaseQueued()
    const releaseNext = await next
    releaseNext()
    releaseNext()

    const releaseCurrent = await semaphore.acquire()
    admitted.mockClear()
    const last = semaphore.acquire().then((release) => {
      admitted()
      return release
    })
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    releaseCurrent()
    const releaseLast = await last
    expect(admitted).toHaveBeenCalledOnce()
    releaseLast()
  })
})
