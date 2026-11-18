import { opendir, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { type AnalysisReason, analysisReportSchema } from "@narumitw/sumire-issues"
import { type AnalysisJob, AnalysisStore } from "@narumitw/sumire-issues/analysis-store"
import { IssueError, IssueStore } from "@narumitw/sumire-issues/store"
import { z } from "zod"
import type { AdminStore } from "../admin/store.js"
import { type AnalysisModel, openIssueSession, selectIssueModel } from "./session.js"

const MAX_SESSION_BYTES = 16 * 1024 * 1024
const MAX_SESSION_STORAGE = 512 * 1024 * 1024
class Blocked extends Error {
  constructor(readonly reason: AnalysisReason) {
    super(reason)
  }
}
export interface IssueAnalysisOptions {
  store: AdminStore
  runtime: ModelRuntime
  directory: string
  openSession?: typeof openIssueSession
}
/** One process and one serialized writer own issue session files. No Telegram session/tool inheritance. */
export class IssueAnalysisRuntime {
  readonly analyses: AnalysisStore
  readonly issues: IssueStore
  private work: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private active:
    | { id: string; issueId: number; controller: AbortController; done: Promise<void> }
    | undefined
  private closing = false
  private failed = false
  constructor(private readonly options: IssueAnalysisOptions) {
    const audit = (actor: string, operation: string, id: number) =>
      options.store.audit(
        actor,
        operation,
        options.store.snapshot().revision,
        "completed",
        `issue:${id}`,
      )
    this.analyses = new AnalysisStore(options.store.db, audit)
    this.issues = new IssueStore(options.store.db, audit, () => options.store.snapshot().revision)
  }
  get available() {
    return !this.closing && !this.failed
  }
  start() {
    if (!this.timer && !this.closing) {
      this.timer = setInterval(() => {
        void this.wake()
      }, 5000)
      this.timer.unref()
    }
    void this.wake()
  }
  wake(): Promise<void> {
    if (this.closing || this.failed) return this.work ?? Promise.resolve()
    this.work ??= this.drain()
      .catch(() => {
        this.failed = true
      })
      .finally(() => {
        this.work = undefined
      })
    return this.work
  }
  request(issueId: number, input: unknown, actor: string) {
    if (!this.available) throw new IssueError(503, "Issue analysis worker is unavailable")
    const analysis = this.analyses.request(
      issueId,
      input,
      actor,
      this.options.store.snapshot().revision,
    )
    void this.wake()
    return analysis
  }
  async cancel(issueId: number, id: string, revision: number, actor: string) {
    const result = this.analyses.cancel(issueId, id, revision, actor)
    const active = this.active
    if (active?.id === id) {
      active.controller.abort("cancelled")
      await active.done
    }
    return result
  }
  async changed(issueId: number) {
    const active = this.active
    if (active?.issueId === issueId) {
      active.controller.abort("cancelled")
      await active.done
    }
    await this.collect()
    void this.wake()
  }
  async close() {
    this.closing = true
    clearInterval(this.timer)
    this.active?.controller.abort("shutdown")
    await this.work
  }
  private guard(id: string): AnalysisModel {
    const job = this.analyses.job(id)
    if (job.actor !== String(this.options.store.adminId)) throw new Blocked("policy_changed")
    if (job.state !== "running" || this.issues.get(job.issueId).state !== "open")
      throw new Blocked("cancelled")
    if (job.deadline === null || Date.now() >= job.deadline) throw new Blocked("timeout")
    const snapshot = this.options.store.snapshot()
    if (
      snapshot.status !== "applied" ||
      snapshot.applied !== snapshot.revision ||
      snapshot.revision !== job.policyRevision
    )
      throw new Blocked("policy_changed")
    if (!job.model || !job.thinking) throw new Blocked("model_unavailable")
    let selected: ReturnType<typeof selectIssueModel>
    try {
      selected = selectIssueModel(snapshot.policy, this.options.runtime)
    } catch {
      throw new Blocked("model_unavailable")
    }
    if (selected.ref !== job.model || selected.thinking !== job.thinking)
      throw new Blocked("policy_changed")
    return {
      model: job.model,
      thinking: job.thinking as ModelThinkingLevel,
      policy: snapshot.policy,
    }
  }
  private async budget(id: string) {
    let bytes = 0
    let count = 0
    let sessionBytes = 0
    const directory = await opendir(this.options.directory).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined
      throw error
    })
    if (!directory) return
    for await (const entry of directory) {
      if (++count > 10000) throw new Blocked("storage_limit")
      if (!/^[a-f0-9-]{36}\.sqlite(?:-wal|-shm)?$/.test(entry.name)) continue
      if (!entry.isFile()) throw new Blocked("storage_limit")
      const size = (await stat(path.join(this.options.directory, entry.name))).size
      bytes += size
      if (entry.name.startsWith(id)) sessionBytes += size
      if (sessionBytes > MAX_SESSION_BYTES) throw new Blocked("storage_limit")
      if (bytes > MAX_SESSION_STORAGE) throw new Blocked("storage_limit")
    }
  }
  private async collect() {
    for (;;) {
      const ids = this.analyses.garbage()
      if (!ids.length) return
      for (const id of ids) {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid cleanup key")
        for (const suffix of ["", "-wal", "-shm"])
          await rm(path.join(this.options.directory, `${id}.sqlite${suffix}`), { force: true })
        this.analyses.collected(id)
      }
    }
  }
  private async drain() {
    await this.collect()
    while (!this.closing) {
      const job = this.analyses.next()
      if (!job) return
      const controller = new AbortController()
      let done!: () => void
      const settled = new Promise<void>((resolve) => {
        done = resolve
      })
      this.active = { id: job.id, issueId: job.issueId, controller, done: settled }
      let session: Awaited<ReturnType<typeof openIssueSession>> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      let policyWatch: ReturnType<typeof setInterval> | undefined
      try {
        await this.budget(job.id)
        if (
          job.sessionId &&
          !(await stat(path.join(this.options.directory, `${job.id}.sqlite`)).catch(
            () => undefined,
          ))
        )
          throw new Blocked("session_unavailable")
        session = await (this.options.openSession ?? openIssueSession)({
          directory: this.options.directory,
          id: job.id,
          runtime: this.options.runtime,
          guard: () => this.guard(job.id),
          signal: controller.signal,
        })
        if (
          job.sessionId &&
          (job.sessionId !== session.sessionId || job.conversationId !== session.conversationId)
        )
          throw new Blocked("session_unavailable")
        this.analyses.attach(job.id, session.sessionId, session.conversationId)
        let current: AnalysisJob = this.analyses.job(job.id)
        if (!["queued", "running"].includes(current.state)) continue
        if (current.state === "queued") {
          const snapshot = this.options.store.snapshot()
          if (
            current.policyRevision !== snapshot.revision ||
            snapshot.status !== "applied" ||
            snapshot.applied !== snapshot.revision
          )
            throw new Blocked("policy_changed")
          let selected: ReturnType<typeof selectIssueModel>
          try {
            selected = selectIssueModel(snapshot.policy, this.options.runtime)
          } catch {
            throw new Blocked("model_unavailable")
          }
          if (this.issues.get(job.issueId).hasScreenshot && !selected.model.input.includes("image"))
            throw new Blocked("image_unsupported")
          current = this.analyses.start(job.id, selected.ref, selected.thinking, snapshot.revision)
        }
        const model = this.guard(job.id)
        deadline = setTimeout(
          () => controller.abort("timeout"),
          Math.max(1, (current.deadline ?? 0) - Date.now()),
        )
        policyWatch = setInterval(() => {
          try {
            this.guard(job.id)
          } catch {
            controller.abort("policy_changed")
          }
        }, 500)
        if (
          !(await this.options.runtime.checkAuth(model.model.slice(0, model.model.indexOf("/")), {
            signal: controller.signal,
          }))
        )
          throw new Blocked("model_unavailable")
        this.guard(job.id)
        const issue = this.issues.get(job.issueId)
        const image = issue.hasScreenshot ? this.issues.attachment(issue.id) : undefined
        const previousQuestions =
          this.analyses
            .list(job.issueId)
            .find((prior) => prior.attempt < current.attempt && prior.report?.questions.length)
            ?.report?.questions ?? []
        const report = await session.analyze(
          issue,
          current.context,
          model,
          (id) => this.analyses.submitted(job.id, id),
          image,
          previousQuestions,
        )
        await this.budget(job.id)
        this.guard(job.id)
        this.analyses.finish(job.id, analysisReportSchema.parse(report))
      } catch (error) {
        if (!this.closing) {
          let reason: AnalysisReason =
            error instanceof Blocked
              ? error.reason
              : error instanceof z.ZodError
                ? "invalid_report"
                : "generation_failed"
          try {
            const current = this.analyses.job(job.id)
            if (current.deadline !== null && Date.now() >= current.deadline) reason = "timeout"
            else if (current.state === "running") {
              try {
                this.guard(job.id)
              } catch (guardError) {
                if (guardError instanceof Blocked) reason = guardError.reason
              }
            }
            this.analyses.stop(
              job.id,
              current.sessionId !== null &&
                [
                  "policy_changed",
                  "model_unavailable",
                  "image_unsupported",
                  "storage_limit",
                ].includes(reason)
                ? "blocked"
                : "failed",
              reason,
            )
          } catch (missing) {
            if (!(missing instanceof IssueError && missing.status === 404)) throw missing
          }
        }
      } finally {
        clearTimeout(deadline)
        clearInterval(policyWatch)
        try {
          await session?.close()
        } finally {
          this.active = undefined
          done()
        }
      }
      await this.collect()
    }
  }
}
