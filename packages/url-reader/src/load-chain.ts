import {
  type FailureDiagnostic,
  FirecrawlApiHttpError,
  getFailureDiagnostic,
  LoaderContentError,
  LoaderError,
  LoaderNotApplicableError,
  LoaderTimeoutError,
  MissingRequirementError,
  TargetHttpError,
} from "./core/errors.js"
import {
  recordAttempt,
  remainingMilliseconds,
  withAttemptSink,
  withDeadline,
} from "./core/execution.js"
import {
  type FirecrawlCredentialOptions,
  resolveFirecrawlApiKey,
} from "./core/firecrawl-credentials.js"
import { retainInterruptedAttempts, runBounded } from "./core/interruption.js"
import type { LoaderFactory } from "./core/loader.js"
import { type AttemptRecord, AttemptStatus, type LoadResult } from "./core/results.js"
import { getLoaderContentType, getLoaderFactory, getLoaderRequirements } from "./loader-registry.js"
import {
  ContentContract,
  type ContentContract as ContentContractValue,
  ContentType,
  type ContentType as ContentTypeValue,
  GENERIC_HTML_LOADERS,
  planForUrl,
} from "./pipelines/catalog.js"

export type Admission = (
  loaderName: string,
  operation: () => Promise<string>,
  signal?: AbortSignal,
) => Promise<string>
export type RequirementsLookup = (loaderName: string) => readonly string[]
export type ContentTypeLookup = (loaderName: string) => string

export const DEFAULT_FALLBACK_LOADERS = GENERIC_HTML_LOADERS

export class LoadChainExplanation {
  constructor(
    public readonly url: string,
    public readonly pipeline: string | undefined,
    public readonly contentType: ContentTypeValue,
    public readonly targetedLoaders: readonly string[],
    public readonly fallbackLoaders: readonly string[],
    public readonly executionPlan: readonly string[],
    public readonly requirements: readonly string[] = [],
    public readonly missingRequirements: readonly string[] = [],
    public readonly eligibleLoaders: readonly string[] = [],
    public readonly unavailableLoaders: readonly string[] = [],
    public readonly contentContract: ContentContractValue = ContentContract.GenericHtml,
  ) {}

  toObject(): Record<string, unknown> {
    return {
      url: this.url,
      pipeline: this.pipeline ?? null,
      content_type: this.contentType,
      targeted_loaders: [...this.targetedLoaders],
      fallback_loaders: [...this.fallbackLoaders],
      execution_plan: [...this.executionPlan],
      requirements: [...this.requirements],
      missing_requirements: [...this.missingRequirements],
      eligible_loaders: [...this.eligibleLoaders],
      unavailable_loaders: [...this.unavailableLoaders],
    }
  }
}

interface LoadChainOptions extends FirecrawlCredentialOptions {
  getFactory: (name: string) => LoaderFactory
  explanation: LoadChainExplanation
  getRequirements: RequirementsLookup
  getContentType: ContentTypeLookup
  admit?: Admission
  automaticGeneric?: boolean
}

export class LoadChain {
  readonly getFactory: (name: string) => LoaderFactory
  readonly explanation: LoadChainExplanation
  readonly getRequirements: RequirementsLookup
  readonly getContentType: ContentTypeLookup
  readonly admit?: Admission
  readonly automaticGeneric: boolean
  private readonly firecrawlApiKey: string | null

  constructor(options: LoadChainOptions) {
    this.firecrawlApiKey = resolveFirecrawlApiKey(options.firecrawlApiKey)
    this.getFactory = options.getFactory
    this.explanation = options.explanation
    this.getRequirements = options.getRequirements
    this.getContentType = options.getContentType
    this.admit = options.admit
    this.automaticGeneric = options.automaticGeneric ?? false
  }

  async loadDetailed(signal?: AbortSignal): Promise<LoadResult> {
    const attempts: AttemptRecord[] = []
    try {
      return await withAttemptSink(attempts, () => this.executeDetailed(attempts, signal))
    } catch (error) {
      retainInterruptedAttempts(error, attempts, this.explanation.url)
      throw error
    }
  }

  private async executeDetailed(
    attempts: AttemptRecord[],
    signal?: AbortSignal,
  ): Promise<LoadResult> {
    const errors: string[] = []
    for (const [index, plannedLoaderName] of this.explanation.executionPlan.entries()) {
      if (signal?.aborted) throw signal.reason
      const missing = missingRequirements(
        this.getRequirements(plannedLoaderName),
        this.firecrawlApiKey,
      )
      if (missing.length > 0) {
        const message = `Missing requirement(s): ${missing.join(", ")}`
        errors.push(`${plannedLoaderName}: Skipped (${message})`)
        recordAttempt({
          loaderId: plannedLoaderName,
          status: AttemptStatus.Skipped,
          elapsedSeconds: 0,
          errorType: "MissingRequirementError",
          diagnostic: { code: "configuration_missing" },
          message,
        })
        continue
      }

      const remaining = remainingMilliseconds()
      if (remaining !== undefined && remaining <= 0) {
        recordAttempt({
          loaderId: plannedLoaderName,
          status: AttemptStatus.Timeout,
          elapsedSeconds: 0,
          errorType: "TimeoutError",
          diagnostic: { code: "deadline_exceeded", phase: "loading" },
          message: "Deadline expired",
        })
        errors.push(`${plannedLoaderName}: Deadline expired before attempt`)
        break
      }

      if (
        this.automaticGeneric &&
        plannedLoaderName === "firecrawl" &&
        remaining !== undefined &&
        remaining < 1_000
      ) {
        appendAttempt(
          plannedLoaderName,
          AttemptStatus.Skipped,
          performance.now(),
          undefined,
          "Insufficient remaining time for external fallback",
        )
        continue
      }
      const alternatives = this.explanation.executionPlan
        .slice(index)
        .filter(
          (name) =>
            missingRequirements(this.getRequirements(name), this.firecrawlApiKey).length === 0,
        ).length
      const budget = this.automaticGeneric
        ? Math.min(
            genericAttemptLimit(plannedLoaderName),
            remaining === undefined ? Infinity : remaining / alternatives,
          )
        : remaining
      const localTimeout = budget !== undefined && (remaining === undefined || budget < remaining)
      const started = performance.now()
      try {
        const result = await runBounded(
          async (activeSignal) => {
            const operation = async () => {
              activeSignal.throwIfAborted()
              const loader = await this.getFactory(plannedLoaderName)()
              activeSignal.throwIfAborted()
              return loader.load(this.explanation.url, activeSignal)
            }
            return withDeadline(budget === undefined ? undefined : started + budget, () =>
              this.admit ? this.admit(plannedLoaderName, operation, activeSignal) : operation(),
            )
          },
          budget,
          signal,
          localTimeout
            ? new LoaderTimeoutError(plannedLoaderName, this.explanation.url, (budget ?? 0) / 1_000)
            : new DOMException("Deadline expired", "TimeoutError"),
        )
        signal?.throwIfAborted()
        if (remainingMilliseconds() === 0)
          throw new DOMException("Deadline expired", "TimeoutError")
        if (!result.trim()) {
          errors.push(`${plannedLoaderName}: Empty result`)
          appendAttempt(plannedLoaderName, AttemptStatus.Empty, started, undefined, "Empty result")
          continue
        }

        const actualType = this.getContentType(plannedLoaderName) as ContentTypeValue
        if (
          this.explanation.contentContract === ContentContract.SourceRequired &&
          actualType !== this.explanation.contentType
        ) {
          errors.push(`${plannedLoaderName}: Rejected content type ${actualType}`)
          appendAttempt(
            plannedLoaderName,
            AttemptStatus.Rejected,
            started,
            undefined,
            "Result did not satisfy source content contract",
          )
          continue
        }

        appendAttempt(plannedLoaderName, AttemptStatus.Success, started)
        return {
          content: result,
          loaderId: plannedLoaderName,
          contentType: actualType,
          downgraded:
            this.explanation.contentType !== ContentType.GenericWeb &&
            actualType === ContentType.GenericWeb,
          attempts: [...attempts],
        }
      } catch (error) {
        if (signal?.aborted) {
          appendAttempt(
            plannedLoaderName,
            signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
              ? AttemptStatus.Timeout
              : AttemptStatus.Cancelled,
            started,
            signal.reason instanceof Error ? signal.reason : undefined,
            "Load interrupted",
            {
              code:
                signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
                  ? "deadline_exceeded"
                  : "cancelled",
              phase: "loading",
            },
          )
          throw signal.reason
        }
        if (error instanceof LoaderNotApplicableError) {
          const message = error.reason ?? "not applicable"
          errors.push(`${plannedLoaderName}: Not applicable (${message})`)
          appendAttempt(plannedLoaderName, AttemptStatus.NotApplicable, started, error, message)
          continue
        }
        if (error instanceof LoaderTimeoutError) {
          errors.push(`${plannedLoaderName}: Timeout after ${error.timeoutSeconds}s`)
          appendAttempt(
            plannedLoaderName,
            AttemptStatus.Timeout,
            started,
            error,
            "Loader timed out",
          )
          continue
        }
        if (isDeadlineError(error)) {
          errors.push(`${plannedLoaderName}: Shared deadline expired`)
          appendAttempt(
            plannedLoaderName,
            AttemptStatus.Timeout,
            started,
            error,
            "Deadline expired",
          )
          break
        }
        if (error instanceof LoaderContentError) {
          errors.push(`${plannedLoaderName}: Content extraction failed - ${error.reason}`)
          appendAttempt(
            plannedLoaderName,
            AttemptStatus.Failed,
            started,
            error,
            "Content extraction failed",
          )
          continue
        }
        const typed = error instanceof Error ? error : new Error(String(error))
        errors.push(`${plannedLoaderName}: ${typed.name}: ${typed.message}`)
        appendAttempt(plannedLoaderName, AttemptStatus.Failed, started, typed, "Loader failed")
      }
    }
    throw new LoaderError(this.explanation.url, errors, [...attempts])
  }

  async load(signal?: AbortSignal): Promise<string> {
    return (await this.loadDetailed(signal)).content
  }
}

function appendAttempt(
  loaderId: string,
  status: AttemptRecord["status"],
  started: number,
  error?: Error,
  message?: string,
  diagnostic?: FailureDiagnostic,
): void {
  const errorCode = error ? classifyFailure(error) : undefined
  diagnostic ??= error
    ? getFailureDiagnostic(error)
    : status === AttemptStatus.Empty
      ? { code: "empty_content", phase: "loading" }
      : undefined
  recordAttempt({
    loaderId,
    status,
    elapsedSeconds: Math.round(Math.max(0, performance.now() - started) * 1_000) / 1_000_000,
    ...(error ? { errorType: error.name } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(message ? { message } : {}),
  })
}

function classifyFailure(error: Error): string | undefined {
  if (error instanceof FirecrawlApiHttpError) return `firecrawl_api_http_${error.status}`
  if (error instanceof TargetHttpError) return `target_http_${error.status}`
  if (error instanceof LoaderContentError && error.loaderName === "CurlCffiLoader") {
    // Preserve the legacy provenance code; new factual diagnostics are independent.
    const cause = error.cause
    if (
      cause instanceof Error &&
      (cause.name === "CertificateVerifyError" ||
        ("code" in cause && cause.code === "CURLE_PEER_FAILED_VERIFICATION"))
    )
      return "tls_certificate"
    return "transport_failure"
  }
  return undefined
}

function genericAttemptLimit(name: string): number {
  if (name === "playwright-fast") return 15_000
  if (name === "firecrawl") return 30_000
  return 20_000
}

function isDeadlineError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "TimeoutError"
}

function mergeUnique(groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())]
}

function missingRequirements(
  requirements: readonly string[],
  firecrawlApiKey: string | null,
): string[] {
  return requirements.filter((name) =>
    name === "FIRECRAWL_API_KEY" ? !firecrawlApiKey : !process.env[name],
  )
}

function buildExplanation(options: {
  url: string
  pipeline?: string
  contentType: ContentTypeValue
  contentContract: ContentContractValue
  targetedLoaders?: readonly string[]
  fallbackLoaders?: readonly string[]
  executionPlan?: readonly string[]
  getRequirements?: RequirementsLookup
  firecrawlApiKey: string | null
}): LoadChainExplanation {
  const targeted = options.targetedLoaders ?? []
  const fallback = options.fallbackLoaders ?? []
  const loaders = options.executionPlan ?? [...targeted, ...fallback]
  const lookup = options.getRequirements ?? getLoaderRequirements
  const requirements = mergeUnique(loaders.map((name) => lookup(name)))
  const eligible = loaders.filter(
    (name) => missingRequirements(lookup(name), options.firecrawlApiKey).length === 0,
  )
  return new LoadChainExplanation(
    options.url,
    options.pipeline,
    options.contentType,
    targeted,
    fallback,
    loaders,
    requirements,
    missingRequirements(requirements, options.firecrawlApiKey),
    eligible,
    loaders.filter((name) => !eligible.includes(name)),
    options.contentContract,
  )
}

function ensureAnyEligible(explanation: LoadChainExplanation): void {
  if (explanation.eligibleLoaders.length > 0) return
  if (explanation.missingRequirements.length > 0) {
    throw new MissingRequirementError(explanation.missingRequirements)
  }
}

export function explainLoadChain(
  url: string,
  options: FirecrawlCredentialOptions & {
    firecrawlFallback?: boolean
    getRequirements?: RequirementsLookup
  } = {},
): LoadChainExplanation {
  const plan = planForUrl(url, options)
  return buildExplanation({
    url,
    pipeline: plan.pipelineName,
    contentType: plan.contentType,
    contentContract: plan.contentContract,
    targetedLoaders: plan.targetedLoaders,
    fallbackLoaders: plan.fallbackLoaders,
    executionPlan: plan.executionPlan,
    getRequirements: options.getRequirements,
    firecrawlApiKey: resolveFirecrawlApiKey(options.firecrawlApiKey),
  })
}

export function resolveLoadChain(
  url: string,
  options: {
    firecrawlFallback?: boolean
    firecrawlApiKey?: string | null
    getFactory?: (name: string) => LoaderFactory
    getRequirements?: RequirementsLookup
    getContentType?: ContentTypeLookup
    admit?: Admission
  } = {},
): LoadChain {
  const firecrawlApiKey = resolveFirecrawlApiKey(options.firecrawlApiKey)
  const getRequirements = options.getRequirements ?? getLoaderRequirements
  const explanation = explainLoadChain(url, { ...options, firecrawlApiKey })
  ensureAnyEligible(explanation)
  return new LoadChain({
    firecrawlApiKey,
    getFactory:
      options.getFactory ?? ((name) => getLoaderFactory(name, undefined, { firecrawlApiKey })),
    explanation,
    automaticGeneric: explanation.pipeline === undefined,
    getRequirements,
    getContentType: options.getContentType ?? getLoaderContentType,
    ...(options.admit ? { admit: options.admit } : {}),
  })
}

export function resolveExplicitLoadChain(
  url: string,
  loaderNames: readonly string[],
  options: {
    firecrawlApiKey?: string | null
    getFactory?: (name: string) => LoaderFactory
    getRequirements?: RequirementsLookup
    getContentType?: ContentTypeLookup
    admit?: Admission
  } = {},
): LoadChain {
  if (loaderNames.length === 0) throw new Error("Load chain execution plan cannot be empty.")
  const firecrawlApiKey = resolveFirecrawlApiKey(options.firecrawlApiKey)
  const isDefaultFactory = options.getFactory === undefined
  const getRequirements =
    options.getRequirements ?? (isDefaultFactory ? getLoaderRequirements : () => [])
  const getContentType =
    options.getContentType ??
    (isDefaultFactory ? getLoaderContentType : () => ContentType.GenericWeb)
  const explanation = buildExplanation({
    url,
    contentType: ContentType.GenericWeb,
    contentContract: ContentContract.GenericHtml,
    executionPlan: loaderNames,
    getRequirements,
    firecrawlApiKey,
  })
  ensureAnyEligible(explanation)
  return new LoadChain({
    firecrawlApiKey,
    getFactory:
      options.getFactory ?? ((name) => getLoaderFactory(name, undefined, { firecrawlApiKey })),
    explanation,
    getRequirements,
    getContentType,
    ...(options.admit ? { admit: options.admit } : {}),
  })
}
