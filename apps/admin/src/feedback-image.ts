import { MAX_SCREENSHOT_BYTES } from "@narumitw/sumire-issues"

export interface Point {
  x: number
  y: number
}
export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}
export type Mark =
  | { kind: "pen"; points: Point[] }
  | { kind: "box" | "redact"; from: Point; to: Point }
export function rectangle(from: Point, to: Point): Rectangle {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }
}
export function imagePoint(client: Point, bounds: Rectangle, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width, ((client.x - bounds.x) * width) / bounds.width)),
    y: Math.max(0, Math.min(height, ((client.y - bounds.y) * height) / bounds.height)),
  }
}
export function captureFilter(node: HTMLElement): boolean {
  if (!(node instanceof Element)) return true
  if (node instanceof HTMLElement && node.hidden) return false
  if (
    node.closest(
      "[data-feedback-private], [data-feedback-ui], input, textarea, select, [contenteditable], iframe, video, audio, script, style, link",
    )
  )
    return false
  if (node instanceof HTMLImageElement) {
    const url = new URL(node.currentSrc || node.src, window.location.href)
    if (url.origin !== window.location.origin && url.protocol !== "data:") return false
  }
  return true
}
export async function captureViewport(viewport: {
  width: number
  height: number
}): Promise<HTMLCanvasElement> {
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const { toCanvas } = await import("html-to-image")
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const canvas = await Promise.race([
      toCanvas(document.body, {
        width: viewport.width,
        height: viewport.height,
        pixelRatio: Math.min(1, 2000 / viewport.width, 2000 / viewport.height),
        skipFonts: true,
        filter: captureFilter,
        fetchRequestInit: { signal: controller.signal },
        style: {
          transform: `translate(${-scrollX}px, ${-scrollY}px)`,
          transformOrigin: "top left",
        },
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error("截圖逾時，請改用上傳圖片或文字回饋。"))
        }, 15000)
      }),
    ])
    return fitCanvas(canvas)
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
function fitCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const scale = Math.min(1, 2000 / source.width, 2000 / source.height)
  if (scale === 1) return source
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}
export async function loadScreenshot(file: File): Promise<HTMLCanvasElement> {
  if (file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("請選擇 8 MiB 以下的 PNG、JPEG 或 WebP 圖片。")
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16_777_216)
      throw new Error("圖片過大，請先縮小到 1600 萬像素以下。")
    const scale = Math.min(1, 2000 / bitmap.width, 2000 / bitmap.height)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    bitmap.close()
  }
}
export function drawFeedback(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  marks: Mark[],
  crop?: Rectangle,
  selection?: Rectangle,
) {
  const context = target.getContext("2d")
  if (!context) throw new Error("無法開啟圖片編輯器。")
  const area = crop ?? { x: 0, y: 0, width: source.width, height: source.height }
  target.width = Math.max(1, Math.round(area.width))
  target.height = Math.max(1, Math.round(area.height))
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, target.width, target.height)
  context.translate(-area.x, -area.y)
  context.drawImage(source, 0, 0)
  context.strokeStyle = "#dc2626"
  context.lineWidth = Math.max(3, source.width / 400)
  context.lineJoin = "round"
  context.lineCap = "round"
  // Redactions always render last, so annotations cannot reveal hidden image pixels.
  for (const mark of [
    ...marks.filter((item) => item.kind !== "redact"),
    ...marks.filter((item) => item.kind === "redact"),
  ]) {
    if (mark.kind === "pen") {
      context.beginPath()
      for (const [index, point] of mark.points.entries()) {
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      }
      context.stroke()
    } else {
      const box = rectangle(mark.from, mark.to)
      if (mark.kind === "redact") {
        context.fillStyle = "#111111"
        context.fillRect(box.x, box.y, box.width, box.height)
      } else context.strokeRect(box.x, box.y, box.width, box.height)
    }
  }
  if (selection) {
    context.strokeStyle = "#0d9488"
    context.setLineDash([8, 4])
    context.strokeRect(selection.x, selection.y, selection.width, selection.height)
  }
}
export function encodeFeedback(source: HTMLCanvasElement, marks: Mark[], crop?: Rectangle): string {
  const canvas = document.createElement("canvas")
  drawFeedback(canvas, source, marks, crop)
  const data = canvas.toDataURL("image/png").split(",")[1] ?? ""
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  const bytes = (data.length / 4) * 3 - padding
  if (!data || bytes > MAX_SCREENSHOT_BYTES)
    throw new Error("圖片超過 2 MiB，請裁切成較小範圍再送出。")
  return data
}
