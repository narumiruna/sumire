import { isIP } from "node:net"
import { parseDocument, visit } from "yaml"
import { runBounded } from "../core/interruption.js"
import { type FetchImplementation, readResponseText } from "../core/network.js"

export interface WallhopRule {
  readonly domains: readonly string[]
  readonly paths: readonly string[]
}

export type WallhopRuleset = readonly WallhopRule[]
export type WallhopRulesetFetcher = (signal: AbortSignal) => Promise<string>

export interface WallhopRulesetProvider {
  current(): WallhopRuleset
  load(
    fetcher: WallhopRulesetFetcher,
    signal?: AbortSignal,
    waitMs?: number,
  ): Promise<WallhopRuleset>
}

export const WALLHOP_RULESET_URL = "https://wallhop.io/ruleset"
export const DEFAULT_WALLHOP_RULESET_TIMEOUT_MS = 2_000
export const MAX_WALLHOP_RULESET_BYTES = 256 * 1024
export const WALLHOP_RULESET_TTL_MS = 60 * 60 * 1_000
export const WALLHOP_RULESET_FAILURE_TTL_MS = 60 * 1_000

const EMPTY_RULESET: WallhopRuleset = Object.freeze([])
const YAML_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:map",
])
const MEDIA_TYPES = new Set([
  "text/plain",
  "text/yaml",
  "text/x-yaml",
  "application/yaml",
  "application/x-yaml",
])

function invalidRuleset(): never {
  throw new TypeError("Invalid Wallhop ruleset")
}

function normalizeDomain(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 254 ||
    /[\s%/\\:@?#[\]*]/u.test(value)
  ) {
    return invalidRuleset()
  }
  const hostname = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/u, "")
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    isIP(hostname) !== 0 ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    return invalidRuleset()
  }
  return hostname
}

/** Keep only bounded, literal routing data from the untrusted YAML document. */
export function parseWallhopRuleset(text: string): WallhopRuleset {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_WALLHOP_RULESET_BYTES) invalidRuleset()
    const document = parseDocument(text, { schema: "failsafe", uniqueKeys: true })
    if (document.errors.length || document.warnings.length) invalidRuleset()
    visit(document, {
      Alias: invalidRuleset,
      Node: (_key, node) => {
        if ("tag" in node && node.tag && !YAML_TAGS.has(node.tag)) invalidRuleset()
      },
    })
    const entries: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 })
    if (!Array.isArray(entries) || entries.length > 512) invalidRuleset()
    let totalDomains = 0
    const rules = entries.map((entry: unknown): WallhopRule => {
      if (!(entry instanceof Map)) return invalidRuleset()
      const domains: unknown[] = []
      if (entry.has("domain")) domains.push(entry.get("domain"))
      if (entry.has("domains")) {
        const values: unknown = entry.get("domains")
        if (!Array.isArray(values)) return invalidRuleset()
        domains.push(...values)
      }
      totalDomains += domains.length
      if (domains.length === 0 || domains.length > 64 || totalDomains > 2048) invalidRuleset()
      const paths: unknown = entry.has("paths") ? entry.get("paths") : []
      if (
        !Array.isArray(paths) ||
        paths.length > 128 ||
        paths.some(
          (path: unknown) =>
            typeof path !== "string" || !path.startsWith("/") || path.length > 2048,
        )
      ) {
        return invalidRuleset()
      }
      return Object.freeze({
        domains: Object.freeze(domains.map(normalizeDomain)),
        paths: Object.freeze(paths as string[]),
      })
    })
    return Object.freeze(rules)
  } catch {
    // YAML diagnostics can contain upstream text. Do not expose them to callers.
    return invalidRuleset()
  }
}

export function matchesWallhopRuleset(url: string, rules: WallhopRuleset): boolean {
  try {
    const target = new URL(url)
    if (
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      target.username ||
      target.password
    ) {
      return false
    }
    const hostname = normalizeDomain(target.hostname)
    return rules.some(
      (rule) =>
        rule.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) &&
        (rule.paths.length === 0 || rule.paths.some((path) => target.pathname.startsWith(path))),
    )
  } catch {
    return false
  }
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

export async function fetchWallhopRuleset(
  fetch: FetchImplementation,
  signal: AbortSignal,
): Promise<string> {
  return runBounded(
    async () => {
      const response = await fetch(WALLHOP_RULESET_URL, {
        headers: { Accept: [...MEDIA_TYPES].join(", ") },
        redirect: "error",
        signal,
      })
      if (signal.aborted) {
        cancelResponse(response)
        signal.throwIfAborted()
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      if (!response.ok || response.redirected || !mediaType || !MEDIA_TYPES.has(mediaType)) {
        cancelResponse(response)
        throw new Error("Unexpected Wallhop ruleset response")
      }
      return readResponseText(response, MAX_WALLHOP_RULESET_BYTES, signal)
    },
    undefined,
    signal,
  )
}

export class WallhopRulesetCache implements WallhopRulesetProvider {
  private snapshot: WallhopRuleset = EMPTY_RULESET
  private expiresAt = 0
  private retryAt = 0
  private refresh: Promise<WallhopRuleset> | undefined

  current(): WallhopRuleset {
    return Date.now() < this.expiresAt ? this.snapshot : EMPTY_RULESET
  }

  async load(
    fetcher: WallhopRulesetFetcher,
    signal?: AbortSignal,
    waitMs = DEFAULT_WALLHOP_RULESET_TIMEOUT_MS,
  ): Promise<WallhopRuleset> {
    signal?.throwIfAborted()
    if (Date.now() < this.expiresAt || Date.now() < this.retryAt) return this.current()
    if (!this.refresh) {
      this.refresh = runBounded(async (refreshSignal) => {
        const text = await fetcher(refreshSignal)
        refreshSignal.throwIfAborted()
        return parseWallhopRuleset(text)
      }, DEFAULT_WALLHOP_RULESET_TIMEOUT_MS)
        .then(
          (rules) => {
            this.snapshot = rules
            this.expiresAt = Date.now() + WALLHOP_RULESET_TTL_MS
            this.retryAt = 0
            return rules
          },
          () => {
            this.retryAt = Date.now() + WALLHOP_RULESET_FAILURE_TTL_MS
            return this.current()
          },
        )
        .finally(() => {
          this.refresh = undefined
        })
    }
    const refresh = this.refresh
    try {
      return await runBounded(() => refresh, waitMs, signal)
    } catch {
      signal?.throwIfAborted()
      return this.current()
    }
  }
}

export const sharedWallhopRuleset = new WallhopRulesetCache()
