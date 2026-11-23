import {
  type Issue,
  type IssueAnalyses,
  type IssueAnalysis,
  MAX_ANALYSIS_ATTEMPTS,
  type Proposal,
  renderProposalSvg,
} from "@narumitw/sumire-issues"
import { Badge } from "@react-spectrum/s2/Badge"
import { Button } from "@react-spectrum/s2/Button"
import { Content, Dialog, DialogContainer, Footer, Heading } from "@react-spectrum/s2/Dialog"
import { InlineAlert } from "@react-spectrum/s2/InlineAlert"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }
import { TextArea } from "@react-spectrum/s2/TextArea"
import { ToggleButton } from "@react-spectrum/s2/ToggleButton"
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react"
import "./spectrum-issue-controls.css"
import { ApiError, request } from "./api.js"
import { t } from "./i18n.js"

const panelStyles = style({
  color: "body",
  font: "body",
  "--analysis-border": { type: "borderColor", value: "gray-300" },
  "--analysis-surface": { type: "backgroundColor", value: "layer-2" },
  "--analysis-disclosure": { type: "backgroundColor", value: "gray-75" },
  "--analysis-focus": {
    type: "outlineColor",
    value: { default: "focus-ring", forcedColors: "Highlight" },
  },
})
const headingRow = style({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 12,
})
const actions = style({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 })
const footer = style({ display: "flex", justifyContent: "end" })
const title = style({ font: "heading-sm", color: "title", margin: 0 })
const subtitle = style({ font: "heading-xs", color: "title", margin: 0 })
const smallText = style({ font: "body-sm", margin: 0 })
const muted = style({ color: "neutral-subdued" })
const note = style({
  backgroundColor: "gray-75",
  borderColor: "gray-300",
  borderStyle: "solid",
  borderWidth: 1,
  borderRadius: "default",
  font: "body",
  margin: 0,
  padding: 12,
})
const fullWidth = style({ width: "full" })

export function IssueAnalysisPanel({
  issue,
  csrf,
  onExpired,
}: {
  issue: Issue
  csrf: string
  onExpired(): void
}) {
  const [data, setData] = useState<IssueAnalyses>()
  const [extra, setExtra] = useState("")
  const [preview, setPreview] = useState<Proposal>()
  const previewDescriptionId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [readError, setReadError] = useState("")
  const [uncertain, setUncertain] = useState(false)
  const [readAt, setReadAt] = useState<number>()
  const pending = useRef<{ requestId: string; revision: number; context: string } | undefined>(
    undefined,
  )
  const controller = useRef(new AbortController())
  const alive = useRef(true)
  const reads = useRef(0)
  const polls = useRef(0)
  const onExpiredRef = useRef(onExpired)
  onExpiredRef.current = onExpired
  const accept = useCallback((value: IssueAnalyses) => {
    if (alive.current) {
      reads.current++
      setData(value)
      setReadError("")
      setReadAt(Date.now())
    }
  }, [])
  const fail = useCallback((error: unknown, showError: (message: string) => void) => {
    if (!alive.current || controller.current.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) onExpiredRef.current()
    else showError(error instanceof Error ? error.message : t("issues.failed"))
  }, [])
  const load = useCallback(async () => {
    const version = ++reads.current
    try {
      const value = await request<IssueAnalyses>(
        `issues/${issue.id}/analysis`,
        undefined,
        undefined,
        "GET",
        controller.current.signal,
      )
      if (alive.current && reads.current === version) accept(value)
    } catch (error) {
      if (reads.current === version) fail(error, setReadError)
    }
  }, [issue.id, accept, fail])
  useEffect(
    () => () => {
      alive.current = false
      controller.current.abort()
    },
    [],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: Closing or reopening feedback invalidates analysis state.
  useEffect(() => {
    void load()
  }, [load, issue.state])
  const current = data?.analyses?.[0]
  useEffect(() => {
    const shouldPoll =
      data?.available &&
      !busy &&
      current &&
      (current.state === "queued" ||
        current.state === "running" ||
        (current.state === "idle" && !current.sessionId))
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    function schedule() {
      clearTimeout(timer)
      if (stopped || !shouldPoll || polls.current >= 120 || document.visibilityState !== "visible")
        return
      timer = setTimeout(() => {
        if (document.visibilityState !== "visible") return
        polls.current++
        void load().then(schedule)
      }, 3000)
    }
    function refresh() {
      clearTimeout(timer)
      if (document.visibilityState === "visible") void load().then(schedule)
    }
    schedule()
    document.addEventListener("visibilitychange", refresh)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [current, data?.available, busy, load])
  async function mutate(work: () => Promise<IssueAnalyses>) {
    if (busy) return
    setBusy(true)
    setError("")
    reads.current++
    try {
      accept(await work())
    } catch (error) {
      fail(error, setError)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function analyze() {
    const input = pending.current ?? {
      requestId: crypto.randomUUID(),
      revision: issue.revision,
      context: extra,
    }
    pending.current = input
    await mutate(async () => {
      try {
        const value = await request<IssueAnalyses>(
          `issues/${issue.id}/analysis`,
          csrf,
          input,
          "POST",
          controller.current.signal,
        )
        if (alive.current) {
          pending.current = undefined
          setUncertain(false)
          setExtra("")
          polls.current = 0
        }
        return value
      } catch (error) {
        if (alive.current) {
          const unknown = uncertain || !(error instanceof ApiError) || error.status >= 500
          setUncertain(unknown)
          if (!unknown) pending.current = undefined
        }
        throw error
      }
    })
  }
  function cancel(analysis: IssueAnalysis) {
    return request<IssueAnalyses>(
      `issues/${issue.id}/analysis/cancel`,
      csrf,
      { analysisId: analysis.id, revision: analysis.revision },
      "POST",
      controller.current.signal,
    )
  }
  const active = current && ["idle", "queued", "running", "blocked"].includes(current.state)
  const canRequest =
    data?.available &&
    issue.state === "open" &&
    current &&
    !["queued", "running"].includes(current.state) &&
    (current.state === "idle" || current.attempt < MAX_ANALYSIS_ATTEMPTS)
  const visibleError = error || readError
  const previous = data?.analyses?.slice(1) ?? []
  return (
    <section className={`issue-analysis ${panelStyles}`} aria-label={t("issues.analysis")}>
      <div className={headingRow}>
        <h3 className={title}>{t("issues.analysis")}</h3>
        <Button
          variant="secondary"
          fillStyle="outline"
          isDisabled={busy}
          onPress={() => {
            setError("")
            void load()
          }}
        >
          {t("issues.refresh")}
        </Button>
      </div>
      <p className={smallText}>{t("issues.analysisHelp")}</p>
      {readAt && (
        <p className={`${smallText} ${muted}`}>
          {t("issues.readAt", { time: new Date(readAt).toLocaleTimeString() })}
        </p>
      )}
      {data && !data.available && <p className={note}>{t("issues.unavailable")}</p>}
      {visibleError && (
        <InlineAlert variant="negative">
          <Content>{visibleError}</Content>
        </InlineAlert>
      )}
      {uncertain && <p role="status">{t("issues.uncertain")}</p>}
      {current && (
        <AnalysisAttempt
          analysis={current}
          onPreview={setPreview}
          selection={{
            disabled: busy || issue.state !== "open",
            select: (number) =>
              void mutate(() =>
                request<IssueAnalyses>(
                  `issues/${issue.id}/analysis/select`,
                  csrf,
                  {
                    analysisId: current.id,
                    revision: current.revision,
                    proposal: current.selectedProposal === number ? null : number,
                  },
                  "POST",
                  controller.current.signal,
                ),
              ),
          }}
        >
          <div className="issue-analysis-controls">
            <TextArea
              id={`issue-analysis-context-${issue.id}`}
              label={t("issues.context")}
              value={extra}
              maxLength={4000}
              isDisabled={busy || uncertain || !canRequest}
              styles={fullWidth}
              onChange={setExtra}
            />
            <p className={smallText}>{t("issues.consent")}</p>
            <div className={actions}>
              <Button
                variant="accent"
                isDisabled={busy || (!uncertain && !canRequest)}
                onPress={() => void analyze()}
              >
                {uncertain ? t("issues.retry") : t("issues.request")}
              </Button>
              {active && (
                <Button
                  variant="negative"
                  fillStyle="outline"
                  isDisabled={busy}
                  onPress={() => void mutate(() => cancel(current))}
                >
                  {t("issues.cancel")}
                </Button>
              )}
            </div>
            <p className={smallText}>{t("issues.limit", { max: MAX_ANALYSIS_ATTEMPTS })}</p>
          </div>
        </AnalysisAttempt>
      )}
      {previous.length > 0 && (
        <details className="issue-analysis-disclosure issue-analysis-history">
          <summary>{t("issues.previousAnalyses")}</summary>
          <div className="issue-analysis-disclosure-content">
            {previous.map((analysis) => (
              <AnalysisAttempt key={analysis.id} analysis={analysis} onPreview={setPreview} />
            ))}
          </div>
        </details>
      )}
      <DialogContainer onDismiss={() => setPreview(undefined)}>
        {preview && (
          <Dialog
            size="XL"
            isDismissible
            aria-describedby={previewDescriptionId}
            UNSAFE_className="issue-proposal-dialog "
          >
            <Heading slot="title">{preview.preview.title}</Heading>
            <Content>
              <p id={previewDescriptionId} className={smallText}>
                {t("issues.previewHelp")}
              </p>
              <div className="issue-preview-scroll">
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderProposalSvg(preview))}`}
                  alt={preview.preview.title}
                />
              </div>
            </Content>
            <Footer>
              <div className={footer}>
                <Button
                  autoFocus
                  variant="secondary"
                  fillStyle="outline"
                  onPress={() => setPreview(undefined)}
                >
                  {t("issues.closePreview")}
                </Button>
              </div>
            </Footer>
          </Dialog>
        )}
      </DialogContainer>
    </section>
  )
}

function AnalysisAttempt({
  analysis,
  onPreview,
  selection,
  children,
}: {
  analysis: IssueAnalysis
  onPreview(proposal: Proposal): void
  selection?: { disabled: boolean; select(index: number): void }
  children?: ReactNode
}) {
  const { report } = analysis
  return (
    <article
      className={
        selection ? "issue-analysis-attempt issue-analysis-current" : "issue-analysis-attempt"
      }
      aria-label={t("issues.attempt", { attempt: analysis.attempt })}
    >
      <div className={actions}>
        <h4 className={subtitle}>{t("issues.attempt", { attempt: analysis.attempt })}</h4>
        <Badge variant="neutral" fillStyle="subtle">
          {t(`issues.state.${analysis.state}`)}
        </Badge>
      </div>
      {analysis.reason && <p>{t(`issues.reason.${analysis.reason}`)}</p>}
      {report && (
        <>
          <p className="issue-description">{report.summary}</p>
          <p className={note}>{report.limitations}</p>
          {report.questions.length > 0 && (
            <>
              <h5 className={subtitle}>{t("issues.questions")}</h5>
              <ul>
                {report.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {children}
      <details key={analysis.id} className="issue-analysis-disclosure issue-analysis-run-details">
        <summary>{t("issues.runDetails")}</summary>
        <div className="issue-analysis-disclosure-content">
          <p className={smallText}>
            {t("issues.session")}:{" "}
            {analysis.sessionId ? <code>{analysis.sessionId}</code> : t("issues.sessionPending")}
          </p>
          {analysis.conversationId !== null && (
            <p className={smallText}>
              {t("issues.conversation", { id: analysis.conversationId })}
              {analysis.model ? ` · ${analysis.model}` : ""}
            </p>
          )}
        </div>
      </details>
      {report && (
        <div className="issue-proposals">
          {report.proposals.map((proposal, number) => (
            <article key={`${analysis.id}:${proposal.title}`} className="issue-proposal">
              <h5 className={subtitle}>
                {number + 1}. {proposal.title}
              </h5>
              <p>{proposal.rationale}</p>
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderProposalSvg(proposal))}`}
                alt={proposal.preview.title}
                className="issue-proposal-preview"
              />
              <Button variant="secondary" fillStyle="outline" onPress={() => onPreview(proposal)}>
                {t("issues.enlarge")}
              </Button>
              <p className={smallText}>{t("issues.previewHelp")}</p>
              <ul>
                {proposal.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
              <p>
                {t("issues.tradeoffs")}: {proposal.tradeoffs}
              </p>
              {selection && (
                <ToggleButton
                  isSelected={analysis.selectedProposal === number}
                  isEmphasized
                  isDisabled={selection.disabled}
                  onChange={() => selection.select(number)}
                >
                  {analysis.selectedProposal === number ? t("issues.selected") : t("issues.select")}
                </ToggleButton>
              )}
            </article>
          ))}
        </div>
      )}
    </article>
  )
}
