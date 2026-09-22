import { InvalidUrlError, LoaderNotApplicableError, UrlContentError } from "../core/errors.js"

export const ANYDOC_EXTENSIONS = [
  "doc",
  "docx",
  "docm",
  "ppt",
  "pps",
  "pot",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "csv",
  "pdf",
] as const

export const BBC_DOMAIN_SUFFIX = "bbc.com"
export const CNN_DOMAIN_SUFFIX = "cnn.com"
export const LTN_DOMAIN_SUFFIX = "ltn.com.tw"
export const OPENAI_WEB_HOSTS = [
  "openai.com",
  "www.openai.com",
  "help.openai.com",
  "platform.openai.com",
] as const
export const PI_SESSION_HOST = "pi.dev"
export const PI_SESSION_PATH = "/session"
export const PTT_HOSTS = ["www.ptt.cc"] as const
export const REDDIT_DOMAINS = [
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "m.reddit.com",
  "sh.reddit.com",
  "redd.it",
  "www.redd.it",
] as const
export const REEL_PREFIX = "https://www.instagram.com/reel"
export const THREADS_DOMAINS = [
  "threads.com",
  "www.threads.com",
  "threads.net",
  "www.threads.net",
] as const
export const TRUTHSOCIAL_DOMAINS = ["truthsocial.com", "www.truthsocial.com"] as const
export const TWITTER_DOMAINS = [
  "twitter.com",
  "x.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixvx.com",
  "twittpr.com",
  "api.fxtwitter.com",
  "fixupx.com",
] as const
export const RAW_GITHUB_HOST = "raw.githubusercontent.com"
const GITHUB_HOST = "github.com"
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org"])
const YOUTUBE_ALLOWED_HOSTS = new Set([
  "youtu.be",
  "m.youtube.com",
  "music.youtube.com",
  "youtube.com",
  "www.youtube.com",
  "www.youtube-nocookie.com",
  "vid.plus",
])

export class UnsupportedUrlSchemeError extends UrlContentError {
  constructor(public readonly scheme: string) {
    super(`unsupported URL scheme: ${scheme}`)
  }
}

export class UnsupportedUrlHostError extends UrlContentError {
  constructor(public readonly host: string) {
    super(`unsupported URL netloc: ${host}`)
  }
}

export class VideoIdError extends UrlContentError {
  constructor(public readonly videoId: string) {
    super(`invalid video ID: ${videoId}`)
  }
}

export class NoVideoIdFoundError extends UrlContentError {
  constructor(public readonly url: string) {
    super(`no video found in URL: ${url}`)
  }
}

export interface YouTubeVideoTarget {
  url: string
  videoId: string
}

export interface AnyDocTarget {
  url: string
  filename: string
}

export interface GoogleDocsTarget {
  url: string
  documentId: string
  exportUrl: string
}

export interface GitHubTarget {
  url: string
  rawUrl?: string
  isRawContent: boolean
}

export interface PiSessionTarget {
  url: string
  gistId: string
  fileName: string
  leafId?: string
  targetId?: string
}

export interface ThreadsTarget {
  url: string
  username: string
  shortcode: string
}

export interface TwitterTarget {
  url: string
  normalizedUrl: string
  statusId?: string
}

function parseHttpUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new InvalidUrlError(value, "valid HTTP(S)")
  }
}

export function requireLoaderApplicability<T>(
  loaderName: string,
  target: string,
  parseTarget: (value: string) => T,
): T {
  try {
    return parseTarget(target)
  } catch (error) {
    if (error instanceof LoaderNotApplicableError) throw error
    if (
      error instanceof InvalidUrlError ||
      error instanceof UnsupportedUrlSchemeError ||
      error instanceof UnsupportedUrlHostError ||
      error instanceof NoVideoIdFoundError ||
      error instanceof VideoIdError
    ) {
      throw new LoaderNotApplicableError(loaderName, target, error.message)
    }
    throw error
  }
}

export function parseYouTubeVideoTarget(url: string): YouTubeVideoTarget {
  const parsed = parseHttpUrl(url)
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== "http" && scheme !== "https") throw new UnsupportedUrlSchemeError(scheme)
  if (!YOUTUBE_ALLOWED_HOSTS.has(parsed.hostname)) throw new UnsupportedUrlHostError(parsed.host)

  let videoId: string | undefined
  if (parsed.pathname.endsWith("/watch")) videoId = parsed.searchParams.get("v") ?? undefined
  else videoId = parsed.pathname.split("/").filter(Boolean).at(-1)
  if (!videoId) throw new NoVideoIdFoundError(url)
  if (videoId.length !== 11) throw new VideoIdError(videoId)
  return { url, videoId }
}

export function isYouTubeVideoUrl(url: string): boolean {
  try {
    parseYouTubeVideoTarget(url)
    return true
  } catch {
    return false
  }
}

export function parseAnyDocTarget(url: string): AnyDocTarget {
  const parsed = parseHttpUrl(url)
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new InvalidUrlError(url, "public document")
  }
  let filename: string
  try {
    filename = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "")
  } catch {
    throw new InvalidUrlError(url, "document filename")
  }
  const extension = filename.split(".").at(-1)?.toLowerCase()
  if (!filename.includes(".") || !ANYDOC_EXTENSIONS.some((value) => value === extension)) {
    throw new InvalidUrlError(url, "AnyDoc-supported document")
  }
  return { url, filename }
}

export function isAnyDocUrl(url: string): boolean {
  try {
    parseAnyDocTarget(url)
    return true
  } catch {
    return false
  }
}

export function parseGoogleDocsTarget(url: string): GoogleDocsTarget {
  const parsed = parseHttpUrl(url)
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.hostname !== "docs.google.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new InvalidUrlError(url, "public Google Docs document")
  }
  const match =
    /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/(?:edit|view|preview|export))?\/?$/u.exec(
      parsed.pathname,
    )
  const documentId = match?.[1]
  if (!documentId) throw new InvalidUrlError(url, "Google Docs document")

  const exportUrl = new URL(`https://docs.google.com/document/d/${documentId}/export`)
  exportUrl.searchParams.set("format", "txt")
  for (const name of ["tab", "resourcekey"]) {
    const value = parsed.searchParams.get(name)
    if (value) exportUrl.searchParams.set(name, value)
  }
  return { url, documentId, exportUrl: exportUrl.toString() }
}

export function isGoogleDocsUrl(url: string): boolean {
  try {
    parseGoogleDocsTarget(url)
    return true
  } catch {
    return false
  }
}

export function parseGitHubTarget(url: string): GitHubTarget {
  const parsed = parseHttpUrl(url)
  if (parsed.hostname === RAW_GITHUB_HOST) return { url, rawUrl: url, isRawContent: true }
  if (parsed.hostname !== GITHUB_HOST) throw new InvalidUrlError(url, "GitHub")
  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts.length >= 5 && parts[2] === "blob") {
    const [owner, repo, , ...refAndPath] = parts
    if (!owner || !repo || refAndPath.length < 2) throw new InvalidUrlError(url, "GitHub blob file")
    const rawUrl = new URL(parsed)
    rawUrl.searchParams.set("raw", "1")
    return { url, rawUrl: rawUrl.toString(), isRawContent: true }
  }
  return { url, isRawContent: false }
}

export function parseGitHubRawContentTarget(url: string): GitHubTarget {
  const target = parseGitHubTarget(url)
  if (!target.rawUrl) throw new InvalidUrlError(url, "GitHub blob")
  return target
}

export function isGitHubUrl(url: string): boolean {
  try {
    parseGitHubTarget(url)
    return true
  } catch {
    return false
  }
}

export function parsePiSessionTarget(url: string): PiSessionTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LoaderNotApplicableError("PiSessionLoader", url, "Not a pi.dev shared session URL")
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== PI_SESSION_HOST
  ) {
    throw new LoaderNotApplicableError("PiSessionLoader", url, "Not a pi.dev shared session URL")
  }
  if (parsed.pathname.replace(/\/$/, "") !== PI_SESSION_PATH) {
    throw new LoaderNotApplicableError("PiSessionLoader", url, "Not a pi.dev shared session path")
  }

  const sharedPath = parsed.hash.slice(1) || parsed.search.slice(1)
  const separator = sharedPath.indexOf("&")
  const sessionPath = separator === -1 ? sharedPath : sharedPath.slice(0, separator)
  const rawParams = separator === -1 ? "" : sharedPath.slice(separator + 1)
  const slash = sessionPath.indexOf("/")
  const gistId = slash === -1 ? sessionPath : sessionPath.slice(0, slash)
  if (!gistId || !/^[0-9a-f]+$/iu.test(gistId)) {
    throw new LoaderNotApplicableError(
      "PiSessionLoader",
      url,
      "Missing or invalid shared session ID",
    )
  }
  const encodedFileName = slash === -1 ? "" : sessionPath.slice(slash + 1)
  const params = new URLSearchParams(rawParams)
  return {
    url,
    gistId,
    fileName: encodedFileName ? decodeURIComponent(encodedFileName) : "session.html",
    ...(params.get("leafId") ? { leafId: params.get("leafId") ?? undefined } : {}),
    ...(params.get("targetId") ? { targetId: params.get("targetId") ?? undefined } : {}),
  }
}

export function isPiSessionUrl(url: string): boolean {
  try {
    parsePiSessionTarget(url)
    return true
  } catch {
    return false
  }
}

export function parsePdfTarget(target: string): string {
  if (/^[a-z]:[\\/]/iu.test(target)) {
    if (!target.toLowerCase().endsWith(".pdf")) throw new InvalidUrlError(target, "PDF")
    return target
  }
  let parsed: URL | undefined
  try {
    parsed = new URL(target)
  } catch {
    parsed = undefined
  }
  if (parsed) {
    if (!["http:", "https:"].includes(parsed.protocol)) throw new InvalidUrlError(target, "PDF")
    const path = parsed.pathname.toLowerCase()
    if (
      !path.endsWith(".pdf") &&
      !(ARXIV_HOSTS.has(parsed.hostname.toLowerCase()) && path.startsWith("/pdf/"))
    ) {
      throw new InvalidUrlError(target, "PDF")
    }
    return target
  }
  if (!target.toLowerCase().endsWith(".pdf")) throw new InvalidUrlError(target, "PDF")
  return target
}

export function isPdfTarget(target: string): boolean {
  try {
    parsePdfTarget(target)
    return true
  } catch {
    return false
  }
}

function hostIn(url: string, hosts: readonly string[]): boolean {
  try {
    return hosts.some((host) => host.toLowerCase() === new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

function hostMatchesSuffix(url: string, suffix: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const normalized = suffix.toLowerCase().replace(/^\./u, "")
    return host === normalized || host.endsWith(`.${normalized}`)
  } catch {
    return false
  }
}

function parseDomainTarget(url: string, loaderName: string, label: string, suffix: string): string {
  if (!hostMatchesSuffix(url, suffix)) {
    throw new LoaderNotApplicableError(
      loaderName,
      url,
      `Not a ${label} URL. Expected domain ending with ${suffix}`,
    )
  }
  return url
}

export const parseBbcTarget = (url: string): string =>
  parseDomainTarget(url, "BBCLoader", "BBC", BBC_DOMAIN_SUFFIX)
export const parseCnnTarget = (url: string): string =>
  parseDomainTarget(url, "CNNLoader", "CNN", CNN_DOMAIN_SUFFIX)
export function parseLtnTarget(url: string): string {
  if (!hostMatchesSuffix(url, LTN_DOMAIN_SUFFIX)) {
    throw new LoaderNotApplicableError(
      "LTNLoader",
      url,
      `Not an LTN URL. Expected domain ending with ${LTN_DOMAIN_SUFFIX}`,
    )
  }
  const parts = new URL(url).pathname.split("/").filter(Boolean)
  const finalPart = parts.at(-1) ?? ""
  if (!parts.some((part) => part === "news" || part === "article") || !/^\d+$/u.test(finalPart)) {
    throw new LoaderNotApplicableError("LTNLoader", url, "Not an LTN article URL")
  }
  return url
}

export const isBbcUrl = (url: string): boolean => hostMatchesSuffix(url, BBC_DOMAIN_SUFFIX)
export const isCnnUrl = (url: string): boolean => hostMatchesSuffix(url, CNN_DOMAIN_SUFFIX)
export function isLtnUrl(url: string): boolean {
  try {
    parseLtnTarget(url)
    return true
  } catch {
    return false
  }
}
export const isOpenAiWebUrl = (url: string): boolean => hostIn(url, OPENAI_WEB_HOSTS)

export function parsePttTarget(url: string): string {
  if (!hostIn(url, PTT_HOSTS)) {
    throw new LoaderNotApplicableError(
      "PttLoader",
      url,
      `Not a PTT URL. Expected domains: ${PTT_HOSTS.join(", ")}`,
    )
  }
  if (!/^\/bbs\/[^/]+\/[A-Z]\.[^/]+\.html$/u.test(new URL(url).pathname)) {
    throw new LoaderNotApplicableError("PttLoader", url, "Not a PTT article URL")
  }
  return url
}
export function isPttUrl(url: string): boolean {
  try {
    parsePttTarget(url)
    return true
  } catch {
    return false
  }
}

export function parseRedditTarget(url: string): string {
  if (!hostIn(url, REDDIT_DOMAINS)) {
    throw new LoaderNotApplicableError(
      "RedditLoader",
      url,
      `Not a Reddit URL. Expected domains: ${REDDIT_DOMAINS.join(", ")}`,
    )
  }
  return url
}
export const isRedditUrl = (url: string): boolean => hostIn(url, REDDIT_DOMAINS)

export function parseReelTarget(url: string): string {
  if (!url.startsWith(REEL_PREFIX))
    throw new LoaderNotApplicableError("ReelLoader", url, "Not an Instagram Reel URL")
  return url
}
export const isReelUrl = (url: string): boolean => url.startsWith(REEL_PREFIX)

export function parseThreadsTarget(url: string): ThreadsTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LoaderNotApplicableError("ThreadsLoader", url, "URL is not a Threads post URL")
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !THREADS_DOMAINS.includes(parsed.hostname.toLowerCase() as (typeof THREADS_DOMAINS)[number])
  ) {
    throw new LoaderNotApplicableError("ThreadsLoader", url, "URL is not a Threads post URL")
  }
  const match = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)\/?$/u.exec(parsed.pathname)
  const username = match?.[1]
  const shortcode = match?.[2]
  if (!username || !shortcode) {
    throw new LoaderNotApplicableError("ThreadsLoader", url, "URL is not a Threads post URL")
  }
  return { url, username, shortcode }
}

export function isThreadsPostUrl(url: string): boolean {
  try {
    parseThreadsTarget(url)
    return true
  } catch {
    return false
  }
}

export function parseTruthSocialTarget(url: string): string {
  if (!hostIn(url, TRUTHSOCIAL_DOMAINS)) {
    throw new LoaderNotApplicableError("TruthSocialLoader", url, "Not a Truth Social URL")
  }
  return url
}
export const isTruthSocialUrl = (url: string): boolean => hostIn(url, TRUTHSOCIAL_DOMAINS)

export function parseTwitterTarget(url: string): TwitterTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new LoaderNotApplicableError("TwitterLoader", url, "URL is not a Twitter/X URL")
  }
  if (
    !TWITTER_DOMAINS.includes(parsed.hostname.toLowerCase() as (typeof TWITTER_DOMAINS)[number])
  ) {
    throw new LoaderNotApplicableError("TwitterLoader", url, "URL is not a Twitter/X URL")
  }
  const statusId = /\/status\/([0-9]+)(?:\/|$)/u.exec(parsed.pathname)?.[1]
  parsed.hostname = "x.com"
  return { url, normalizedUrl: parsed.toString(), ...(statusId ? { statusId } : {}) }
}

export function isTwitterStatusUrl(url: string): boolean {
  try {
    return parseTwitterTarget(url).statusId !== undefined
  } catch {
    return false
  }
}

export function isTwitterUrl(url: string): boolean {
  try {
    parseTwitterTarget(url)
    return true
  } catch {
    return false
  }
}
