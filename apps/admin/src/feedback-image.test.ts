import { MAX_SCREENSHOT_BYTES } from "@narumitw/sumire-issues"
import { describe, expect, it, vi } from "vitest"
import { encodeFeedback, imagePoint, rectangle } from "./feedback-image.js"

describe("feedback image geometry", () => {
  it("normalizes backwards crop and rectangle gestures", () => {
    expect(rectangle({ x: 90, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 60,
    })
  })
  it("maps a scaled mobile canvas back into image pixels", () => {
    expect(
      imagePoint({ x: 110, y: 70 }, { x: 10, y: 20, width: 200, height: 100 }, 1000, 500),
    ).toEqual({ x: 500, y: 250 })
  })
  it("clamps captured pointers outside the canvas", () => {
    expect(
      imagePoint({ x: -20, y: 999 }, { x: 10, y: 20, width: 200, height: 100 }, 1000, 500),
    ).toEqual({ x: 0, y: 500 })
  })
})

it("accepts a PNG at the byte limit and rejects one byte over", () => {
  const atLimit = Buffer.alloc(MAX_SCREENSHOT_BYTES).toString("base64")
  const overLimit = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString("base64")
  const source = { width: 1, height: 1 } as HTMLCanvasElement
  const canvas = {
    getContext: () => ({ fillRect: vi.fn(), translate: vi.fn(), drawImage: vi.fn() }),
    toDataURL: vi
      .fn()
      .mockReturnValueOnce(`data:image/png;base64,${atLimit}`)
      .mockReturnValueOnce(`data:image/png;base64,${overLimit}`),
  }
  vi.stubGlobal("document", { createElement: () => canvas })
  try {
    expect(encodeFeedback(source, [])).toBe(atLimit)
    expect(() => encodeFeedback(source, [])).toThrow("圖片超過 2 MiB")
  } finally {
    vi.unstubAllGlobals()
  }
})
