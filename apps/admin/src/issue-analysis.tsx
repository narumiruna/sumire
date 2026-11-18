import {
  type Issue,
  type IssueAnalyses,
  type IssueAnalysis,
  MAX_ANALYSIS_ATTEMPTS,
  type Proposal,
  renderProposalSvg,
} from "@narumitw/sumire-issues"
import {
  Badge,
  Button,
  Callout,
  Code,
  Dialog,
  Flex,
  Heading,
  Text,
  TextArea,
} from "@radix-ui/themes"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, request } from "./api.js"
import { t } from "./i18n.js"

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
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
      setReadAt(Date.now())
    }
  }, [])
  const fail = useCallback((error: unknown) => {
    if (!alive.current || controller.current.signal.aborted) return
    if (error instanceof ApiError && error.status === 401) onExpiredRef.current()
    else setError(error instanceof Error ? error.message : t("issues.failed"))
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
      fail(error)
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
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", refresh)
    return () => document.removeEventListener("visibilitychange", refresh)
  }, [load])
  const current = data?.analyses?.[0]
  useEffect(() => {
    if (
      !data?.available ||
      busy ||
      polls.current >= 120 ||
      !current ||
      !(
        current.state === "queued" ||
        current.state === "running" ||
        (current.state === "idle" && !current.sessionId)
      )
    )
      return
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") {
        polls.current++
        void load()
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [current, data?.available, busy, load])
  async function mutate(work: () => Promise<IssueAnalyses>) {
    if (busy) return
    setBusy(true)
    setError("")
    reads.current++
    try {
      accept(await work())
    } catch (error) {
      fail(error)
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
          const unknown = !(error instanceof ApiError) || error.status >= 500
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
  return (
    <section className="issue-analysis" aria-label={t("issues.analysis")}>
      <Flex justify="between" gap="3" align="center" wrap="wrap">
        <Heading as="h3" size="4">
          {t("issues.analysis")}
        </Heading>
        <Button
          variant="soft"
          disabled={busy}
          onClick={() => {
            setError("")
            void load()
          }}
        >
          {t("issues.refresh")}
        </Button>
      </Flex>
      <Text as="p" size="2">
        {t("issues.analysisHelp")}
      </Text>
      {readAt && (
        <Text as="p" size="2" color="gray">
          {t("issues.readAt", { time: new Date(readAt).toLocaleTimeString() })}
        </Text>
      )}
      {data && !data.available && (
        <Callout.Root>
          <Callout.Text>{t("issues.unavailable")}</Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {uncertain && (
        <Text as="p" role="status">
          {t("issues.uncertain")}
        </Text>
      )}
      {(data?.analyses ?? []).map((analysis, index) => (
        <article
          key={analysis.id}
          className="issue-analysis-attempt"
          aria-label={t("issues.attempt", { attempt: analysis.attempt })}
        >
          <Flex gap="2" align="center" wrap="wrap">
            <Heading as="h4" size="3">
              {t("issues.attempt", { attempt: analysis.attempt })}
            </Heading>
            <Badge>{t(`issues.state.${analysis.state}`)}</Badge>
            {index > 0 && <Text size="2">{t("issues.previous")}</Text>}
          </Flex>
          <Text as="p" size="2">
            {t("issues.session")}:{" "}
            {analysis.sessionId ? <Code>{analysis.sessionId}</Code> : t("issues.sessionPending")}
          </Text>
          {analysis.conversationId !== null && (
            <Text as="p" size="2">
              {t("issues.conversation", { id: analysis.conversationId })}
              {analysis.model ? ` · ${analysis.model}` : ""}
            </Text>
          )}
          {analysis.reason && <Text as="p">{t(`issues.reason.${analysis.reason}`)}</Text>}
          {analysis.report && (
            <>
              <p className="issue-description">{analysis.report.summary}</p>
              <Callout.Root>
                <Callout.Text>{analysis.report.limitations}</Callout.Text>
              </Callout.Root>
              {analysis.report.questions.length > 0 && (
                <>
                  <Heading as="h5" size="2">
                    {t("issues.questions")}
                  </Heading>
                  <ul>
                    {analysis.report.questions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="issue-proposals">
                {analysis.report.proposals.map((proposal, number) => (
                  <article key={`${analysis.id}:${proposal.title}`} className="issue-proposal">
                    <Heading as="h5" size="3">
                      {number + 1}. {proposal.title}
                    </Heading>
                    <p>{proposal.rationale}</p>
                    <img
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderProposalSvg(proposal))}`}
                      alt={proposal.preview.title}
                      className="issue-proposal-preview"
                    />
                    <Button variant="soft" onClick={() => setPreview(proposal)}>
                      {t("issues.enlarge")}
                    </Button>
                    <Text as="p" size="2">
                      {t("issues.previewHelp")}
                    </Text>
                    <ul>
                      {proposal.changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                    <Text as="p">
                      {t("issues.tradeoffs")}: {proposal.tradeoffs}
                    </Text>
                    {index === 0 && (
                      <Button
                        variant={analysis.selectedProposal === number ? "solid" : "soft"}
                        aria-pressed={analysis.selectedProposal === number}
                        disabled={busy || issue.state !== "open"}
                        onClick={() =>
                          void mutate(() =>
                            request<IssueAnalyses>(
                              `issues/${issue.id}/analysis/select`,
                              csrf,
                              {
                                analysisId: analysis.id,
                                revision: analysis.revision,
                                proposal: analysis.selectedProposal === number ? null : number,
                              },
                              "POST",
                              controller.current.signal,
                            ),
                          )
                        }
                      >
                        {analysis.selectedProposal === number
                          ? t("issues.selected")
                          : t("issues.select")}
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </article>
      ))}
      {current && (
        <>
          <label htmlFor={`issue-analysis-context-${issue.id}`}>{t("issues.context")}</label>
          <TextArea
            id={`issue-analysis-context-${issue.id}`}
            value={extra}
            maxLength={4000}
            disabled={busy || uncertain || !canRequest}
            onChange={(event) => setExtra(event.target.value)}
          />
          <Text as="p" size="2">
            {t("issues.consent")}
          </Text>
          <Flex gap="3" wrap="wrap">
            <Button disabled={busy || (!uncertain && !canRequest)} onClick={() => void analyze()}>
              {uncertain ? t("issues.retry") : t("issues.request")}
            </Button>
            {active && (
              <Button
                color="red"
                variant="soft"
                disabled={busy}
                onClick={() => void mutate(() => cancel(current))}
              >
                {t("issues.cancel")}
              </Button>
            )}
          </Flex>
          <Text as="p" size="2">
            {t("issues.limit", { max: MAX_ANALYSIS_ATTEMPTS })}
          </Text>
        </>
      )}
      <Dialog.Root
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined)
        }}
      >
        <Dialog.Content maxWidth="1100px">
          <Dialog.Title>{preview?.preview.title}</Dialog.Title>
          <Dialog.Description>{t("issues.previewHelp")}</Dialog.Description>
          {preview && (
            <div className="issue-preview-scroll">
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderProposalSvg(preview))}`}
                alt={preview.preview.title}
              />
            </div>
          )}
          <Dialog.Close>
            <Button variant="soft">{t("issues.closePreview")}</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>
    </section>
  )
}
