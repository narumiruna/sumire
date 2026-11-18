import { MAX_SCREENSHOT_BYTES } from "@narumitw/sumire-issues"
import { toCanvas } from "html-to-image"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureViewport, encodeFeedback, imagePoint, rectangle } from "./feedback-image.js"

vi.mock("html-to-image", () => ({ toCanvas: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

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

it("maps exact image edges to bitmap edges when the canvas uses an outline", () => {
  const bounds = { x: 10, y: 20, width: 400, height: 200 }
  expect(imagePoint({ x: 10, y: 20 }, bounds, 1000, 500)).toEqual({ x: 0, y: 0 })
  expect(imagePoint({ x: 410, y: 220 }, bounds, 1000, 500)).toEqual({ x: 1000, y: 500 })
})
it("uses the supplied viewport snapshot even if dimensions change during lazy import", async () => {
  const browser = { innerWidth: 1200, innerHeight: 800, scrollX: 12, scrollY: 34 }
  vi.stubGlobal("window", browser)
  vi.stubGlobal("document", { body: {} })
  const canvas = { width: 1200, height: 800 } as HTMLCanvasElement
  vi.mocked(toCanvas).mockResolvedValue(canvas)
  const result = captureViewport({ width: 1200, height: 800 })
  browser.innerWidth = 900
  browser.innerHeight = 600
  browser.scrollX = 50
  browser.scrollY = 100
  expect(await result).toBe(canvas)
  expect(toCanvas).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      width: 1200,
      height: 800,
      pixelRatio: 1,
      style: { transform: "translate(-12px, -34px)", transformOrigin: "top left" },
    }),
  )
})
it.each([MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_BYTES + 1])(
  "checks exact PNG bytes rather than rounded Base64 length: %s",
  (size) => {
    const context = { fillRect: vi.fn(), translate: vi.fn(), drawImage: vi.fn() }
    const canvas = {
      getContext: () => context,
      toDataURL: () => `data:image/png;base64,${Buffer.alloc(size).toString("base64")}`,
    }
    vi.stubGlobal("document", { createElement: () => canvas })
    const encode = () => encodeFeedback({ width: 10, height: 10 } as HTMLCanvasElement, [])
    if (size === MAX_SCREENSHOT_BYTES) expect(encode()).toHaveLength(4 * Math.ceil(size / 3))
    else expect(encode).toThrow("圖片超過 2 MiB")
  },
)
