import { type Feedback, type Issue, MAX_SCREENSHOT_BYTES } from "@narumitw/sumire-issues"
import { Button } from "@react-spectrum/s2/Button"
import { Content, Dialog, DialogContainer, Footer, Heading } from "@react-spectrum/s2/Dialog"
import { InlineAlert } from "@react-spectrum/s2/InlineAlert"
import Camera from "@react-spectrum/s2/icons/Camera"
import Chat from "@react-spectrum/s2/icons/Chat"
import Crop from "@react-spectrum/s2/icons/Crop"
import Edit from "@react-spectrum/s2/icons/Edit"
import Upload from "@react-spectrum/s2/icons/Upload"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { Text } from "@react-spectrum/s2/Text"
import { TextArea } from "@react-spectrum/s2/TextArea"
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import {
  type ComponentRef,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { Check } from "./check.js"
import "./spectrum-issue-controls.css"
import { ApiError, request } from "./api.js"
import {
  captureViewport,
  drawFeedback,
  encodeFeedback,
  imagePoint,
  loadScreenshot,
  type Mark,
  type Point,
  type Rectangle,
  rectangle,
} from "./feedback-image.js"
import { t } from "./i18n.js"

type Tool = "pen" | "box" | "redact" | "crop"
const surface = style({
  font: "body",
  color: "body",
  "--feedback-surface": { type: "backgroundColor", value: "layer-2" },
  "--feedback-border": { type: "borderColor", value: "gray-400" },
  "--feedback-shadow": { type: "backgroundColor", value: "transparent-black-300" },
})
const actions = style({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 })
const footer = style({ display: "flex", justifyContent: "end", flexWrap: "wrap", gap: 12 })
const smallText = style({ font: "body-sm", margin: 0 })
const fullWidth = style({ width: "full" })

export function FeedbackWidget({
  csrf,
  section,
  onCreated,
  onExpired,
}: {
  csrf: string
  section: string
  onCreated(issue: Issue): void
  onExpired(): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<HTMLCanvasElement>()
  const [metadata, setMetadata] = useState<Feedback["source"]>()
  const [description, setDescription] = useState("")
  const [analyzeAfterSubmit, setAnalyzeAfterSubmit] = useState(false)
  const [marks, setMarks] = useState<Mark[]>([])
  const [tool, setTool] = useState<Tool>("pen")
  const [crop, setCrop] = useState<Rectangle>()
  const [selection, setSelection] = useState<Rectangle>()
  const [review, setReview] = useState<string>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const launcher = useRef<ComponentRef<typeof Button>>(null)
  const restoreLauncher = useRef(false)
  const descriptionId = useId()
  const dialogDescriptionRef = useCallback((paragraph: HTMLParagraphElement | null) => {
    if (paragraph || !restoreLauncher.current) return
    restoreLauncher.current = false
    // The toolbar action that opened the dialog has unmounted. Return to its launcher.
    requestAnimationFrame(() => launcher.current?.focus())
  }, [])
  const start = useRef<Point | undefined>(undefined)
  const activePointer = useRef<number | undefined>(undefined)
  const submission = useRef<AbortController | undefined>(undefined)
  const viewportVersion = useRef(0)
  const gesture = useRef<Mark | undefined>(undefined)
  const submitted = useRef<Feedback | undefined>(undefined)
  const live = useRef(true)
  const pageVersion = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Page changes invalidate in-flight local captures.
  useEffect(() => {
    pageVersion.current++
  }, [section])
  const controller = useRef(new AbortController())
  useEffect(() => {
    const resized = () => {
      viewportVersion.current++
    }
    window.addEventListener("resize", resized)
    return () => window.removeEventListener("resize", resized)
  }, [])
  const blockedCapture = ["Secrets & variables", "Durable"].includes(section)
  useEffect(
    () => () => {
      live.current = false
      controller.current.abort()
    },
    [],
  )
  useEffect(() => {
    if (open && !review && source && canvas.current)
      drawFeedback(canvas.current, source, marks, undefined, selection ?? crop)
  }, [source, marks, crop, selection, open, review])
  useEffect(() => {
    if (!open || (!source && !description)) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [open, source, description])
  function reset() {
    setOpen(false)
    setExpanded(false)
    setSource(undefined)
    setDescription("")
    setAnalyzeAfterSubmit(false)
    setMarks([])
    setCrop(undefined)
    setSelection(undefined)
    setReview(undefined)
    setError("")
    setUncertain(false)
    submitted.current = undefined
    start.current = undefined
    gesture.current = undefined
    activePointer.current = undefined
  }
  function close() {
    if (busy) return
    if (
      (source || description) &&
      !window.confirm(
        uncertain
          ? "提交結果尚未確認，回饋可能已儲存。仍要關閉並丟棄本機草稿嗎？"
          : "要丟棄尚未送出的回饋嗎？",
      )
    )
      return
    restoreLauncher.current = true
    reset()
  }
  function context() {
    return {
      section,
      viewport: {
        width: Math.min(10000, window.innerWidth),
        height: Math.min(10000, window.innerHeight),
      },
    }
  }
  async function prepare(
    capture: (viewport: Feedback["source"]["viewport"]) => Promise<HTMLCanvasElement>,
  ) {
    setBusy(true)
    setError("")
    const origin = context()
    const version = pageVersion.current
    const viewport = viewportVersion.current
    try {
      const image = await capture(origin.viewport)
      if (
        viewport !== viewportVersion.current ||
        origin.viewport.width !== window.innerWidth ||
        origin.viewport.height !== window.innerHeight
      )
        throw new Error("擷取期間視窗大小已變更，請重新擷取。")
      if (version !== pageVersion.current)
        throw new Error("擷取期間頁面已變更，請在目前頁面重新擷取。")
      if (live.current) {
        setSource(image)
        setMetadata(origin)
        setOpen(true)
        setExpanded(false)
      }
    } catch (error) {
      if (live.current)
        setError(
          error instanceof Error ? error.message : "無法擷取畫面，請改用上傳圖片或文字回饋。",
        )
    } finally {
      if (live.current) setBusy(false)
    }
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return imagePoint(
      { x: event.clientX, y: event.clientY },
      { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
      event.currentTarget.width,
      event.currentTarget.height,
    )
  }
  function down(event: PointerEvent<HTMLCanvasElement>) {
    if (
      busy ||
      activePointer.current !== undefined ||
      uncertain ||
      !source ||
      (tool !== "crop" && marks.length >= 100) ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    activePointer.current = event.pointerId
    const position = point(event)
    start.current = position
    gesture.current =
      tool === "pen"
        ? { kind: "pen", points: [position] }
        : tool === "crop"
          ? undefined
          : { kind: tool, from: position, to: position }
    const initial = gesture.current
    if (initial) setMarks((current) => [...current, initial])
  }
  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!start.current || activePointer.current !== event.pointerId) return
    const position = point(event)
    if (tool === "crop") setSelection(rectangle(start.current, position))
    else if (gesture.current) {
      const mark = gesture.current
      gesture.current =
        mark.kind === "pen"
          ? { ...mark, points: [...mark.points.slice(-4999), position] }
          : { ...mark, to: position }
      const next = gesture.current
      setMarks((current) => [...current.slice(0, -1), next])
    }
  }
  function up(event: PointerEvent<HTMLCanvasElement>) {
    if (!start.current || activePointer.current !== event.pointerId) return
    move(event)
    if (tool === "crop") {
      const area = rectangle(start.current, point(event))
      if (area.width >= 2 && area.height >= 2) setCrop(area)
      setSelection(undefined)
    }
    start.current = undefined
    gesture.current = undefined
    activePointer.current = undefined
  }
  async function submit() {
    if (submission.current) return
    const attempt = new AbortController()
    submission.current = attempt
    const deadline = setTimeout(() => attempt.abort(), 30000)
    const previouslyUncertain = uncertain
    setBusy(true)
    setError("")
    try {
      const value = submitted.current ?? {
        requestId: crypto.randomUUID(),
        description,
        source: metadata ?? context(),
        ...(review ? { screenshot: review } : {}),
        ...(analyzeAfterSubmit ? { analyze: true } : {}),
      }
      submitted.current = value
      const issue = await request<Issue>(
        "issues",
        csrf,
        value,
        "POST",
        AbortSignal.any([controller.current.signal, attempt.signal]),
      )
      if (live.current) {
        reset()
        onCreated(issue)
      }
    } catch (error) {
      if (!live.current) return
      if (error instanceof ApiError && error.status === 401) {
        reset()
        onExpired()
        return
      }
      const unknownOutcome =
        previouslyUncertain || !(error instanceof ApiError) || error.status >= 500
      setUncertain(unknownOutcome)
      if (!unknownOutcome) submitted.current = undefined
      setError(
        unknownOutcome
          ? "提交結果尚未確認。請重試相同內容；重試不會重複新增。也可以先至 Issues 確認。"
          : error instanceof Error
            ? error.message
            : "送出失敗。",
      )
    } finally {
      clearTimeout(deadline)
      if (submission.current === attempt) submission.current = undefined
      if (live.current) setBusy(false)
    }
  }
  return (
    <>
      <div className={`feedback-launcher ${surface}`} data-feedback-ui>
        {expanded && (
          <fieldset className="feedback-toolbar" aria-label="回饋工具">
            <span
              title={
                blockedCapture ? "此頁包含敏感內容，請使用文字或經遮蔽的圖片。" : "截取目前畫面"
              }
            >
              <Button
                variant="secondary"
                fillStyle="outline"
                isDisabled={busy || blockedCapture}
                onPress={() => void prepare(captureViewport)}
              >
                <Camera />
                <Text>截圖</Text>
              </Button>
            </span>
            <Button
              variant="secondary"
              fillStyle="outline"
              isDisabled={busy}
              onPress={() => file.current?.click()}
            >
              <Upload />
              <Text>上傳</Text>
            </Button>
            <Button
              variant="secondary"
              fillStyle="outline"
              isDisabled={busy}
              onPress={() => {
                setMetadata(context())
                setOpen(true)
                setExpanded(false)
              }}
            >
              <Edit />
              <Text>文字</Text>
            </Button>
            {blockedCapture && <p className={smallText}>敏感頁面不提供自動截圖。</p>}
          </fieldset>
        )}
        {busy && !open && (
          <p className={smallText} role="status">
            正在處理圖片，請勿切換頁面…
          </p>
        )}
        {!open && error && (
          <InlineAlert variant="negative">
            <Content>{error}</Content>
          </InlineAlert>
        )}
        <Button
          ref={launcher}
          size="L"
          variant="accent"
          aria-label="回報問題"
          aria-expanded={expanded}
          isDisabled={busy || open}
          onPress={() => setExpanded(!expanded)}
        >
          <Chat />
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const value = event.target.files?.[0]
            event.target.value = ""
            if (value) void prepare(() => loadScreenshot(value))
          }}
        />
      </div>
      <DialogContainer onDismiss={close}>
        {open && (
          <Dialog
            size="XL"
            isDismissible={!busy}
            isKeyboardDismissDisabled={busy}
            aria-describedby={descriptionId}
            data-feedback-ui
            UNSAFE_className="feedback-dialog "
          >
            <Heading slot="title">回報問題</Heading>
            <Content UNSAFE_className={`feedback-editor ${surface} `}>
              <p ref={dialogDescriptionRef} id={descriptionId} className={smallText}>
                標註不滿意的地方，裁切或遮蔽敏感內容後送出。文字描述可不填。
              </p>
              <p className={smallText}>
                來源：{metadata?.section}。僅儲存送出後的圖片與描述，不收集網址參數、DOM
                或表單值。圖片可能仍含私人內容，請檢查。
              </p>
              {source && !review && (
                <>
                  <fieldset className={`feedback-image-tools ${actions}`} aria-label="圖片標註工具">
                    {(
                      [
                        ["pen", "畫筆"],
                        ["box", "方框"],
                        ["redact", "遮蔽"],
                        ["crop", "裁切"],
                      ] as const
                    ).map(([value, label]) => (
                      <ToggleButton
                        key={value}
                        autoFocus={value === "pen"}
                        isSelected={tool === value}
                        isEmphasized
                        isDisabled={busy || uncertain}
                        onChange={() => setTool(value)}
                      >
                        {value === "crop" && <Crop />}
                        <Text>{label}</Text>
                      </ToggleButton>
                    ))}
                    <Button
                      variant="secondary"
                      fillStyle="outline"
                      isDisabled={busy || uncertain || !marks.length}
                      onPress={() => setMarks((current) => current.slice(0, -1))}
                    >
                      復原標註
                    </Button>
                    <Button
                      variant="secondary"
                      fillStyle="outline"
                      isDisabled={busy || uncertain || !crop}
                      onPress={() => setCrop(undefined)}
                    >
                      取消裁切
                    </Button>
                  </fieldset>
                  <p className={smallText}>
                    拖曳圖片來標註／裁切。最多 100 個標註。觸控或無法繪圖時，也可只填文字描述。
                  </p>
                  <canvas
                    ref={canvas}
                    className="feedback-canvas"
                    aria-label="回饋圖片標註區"
                    onPointerDown={down}
                    onPointerMove={move}
                    onPointerUp={up}
                    onPointerCancel={(event) => {
                      if (activePointer.current !== event.pointerId) return
                      activePointer.current = undefined
                      start.current = undefined
                      gesture.current = undefined
                      setSelection(undefined)
                    }}
                  />
                  <Button
                    variant="secondary"
                    fillStyle="outline"
                    isDisabled={busy || uncertain}
                    onPress={() => {
                      try {
                        const encoded = encodeFeedback(source, marks, crop)
                        activePointer.current = undefined
                        start.current = undefined
                        gesture.current = undefined
                        setSelection(undefined)
                        setReview(encoded)
                        setError("")
                      } catch (error) {
                        setError(error instanceof Error ? error.message : "無法處理圖片。")
                      }
                    }}
                  >
                    預覽送出圖片
                  </Button>
                </>
              )}
              {review && (
                <>
                  <img
                    className="feedback-preview"
                    src={`data:image/png;base64,${review}`}
                    alt="即將送出的裁切與標註圖片"
                  />
                  <Button
                    variant="secondary"
                    fillStyle="outline"
                    isDisabled={busy || uncertain}
                    onPress={() => setReview(undefined)}
                  >
                    返回編輯圖片
                  </Button>
                </>
              )}
              <TextArea
                id="feedback-description"
                label="文字描述（選填）"
                value={description}
                maxLength={8000}
                isDisabled={busy || uncertain}
                autoFocus={!source}
                styles={fullWidth}
                onChange={setDescription}
                placeholder="哪裡不符合預期？希望如何改善？"
              />
              <Check
                checked={analyzeAfterSubmit}
                disabled={busy || uncertain}
                onChange={setAnalyzeAfterSubmit}
                label={t("issues.analyzeConsent")}
              />
              <p className={smallText}>
                附件上限 {MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB。{t("issues.feedbackHelp")}
              </p>
              {error && (
                <InlineAlert variant="negative">
                  <Content>{error}</Content>
                </InlineAlert>
              )}
            </Content>
            <Footer>
              <div className={footer}>
                {busy && (
                  <Button
                    variant="secondary"
                    fillStyle="outline"
                    onPress={() => submission.current?.abort()}
                  >
                    {t("issues.stopWaiting")}
                  </Button>
                )}
                <Button variant="secondary" fillStyle="outline" isDisabled={busy} onPress={close}>
                  取消
                </Button>
                <Button
                  variant="accent"
                  isDisabled={
                    busy || Boolean(source && !review) || (!review && !description.trim())
                  }
                  onPress={() => void submit()}
                >
                  {busy ? "送出中…" : uncertain ? "重試相同提交" : "送出回饋"}
                </Button>
              </div>
            </Footer>
          </Dialog>
        )}
      </DialogContainer>
    </>
  )
}
