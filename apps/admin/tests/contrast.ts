import type { Locator } from "@playwright/test"

/** Composite translucent Radix tokens over the actual ancestor backgrounds. */
export async function contrast(locator: Locator) {
  return locator.evaluate((element) => {
    type Color = [number, number, number, number]
    const parse = (value: string): Color => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? []
      return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1]
    }
    const over = (front: Color, back: Color): Color => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]),
      1,
    ]
    let background: Color = [255, 255, 255, 1]
    const ancestors: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement)
      ancestors.unshift(current)
    for (const ancestor of ancestors)
      background = over(parse(getComputedStyle(ancestor).backgroundColor), background)
    const style = getComputedStyle(element)
    const foreground = over(parse(style.color), background)
    const luminance = (color: Color) =>
      color.slice(0, 3).reduce((sum, channel, index) => {
        const s = channel / 255
        return (
          sum +
          (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
            ([0.2126, 0.7152, 0.0722][index] ?? 0)
        )
      }, 0)
    const ratio = (front: Color, back: Color) =>
      (Math.max(luminance(front), luminance(back)) + 0.05) /
      (Math.min(luminance(front), luminance(back)) + 0.05)
    return {
      text: ratio(foreground, background),
      border: ratio(over(parse(style.borderTopColor), background), background),
      color: style.color,
      background,
      borderColor: style.borderTopColor,
      borderWidth: Number.parseFloat(style.borderTopWidth),
    }
  })
}
