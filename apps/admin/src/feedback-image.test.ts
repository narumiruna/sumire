import { describe, expect, it } from "vitest"
import { imagePoint, rectangle } from "./feedback-image.js"

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
