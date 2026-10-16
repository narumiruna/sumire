import { describe, expect, it } from "vitest"

import { listLoaderNames } from "../src/loader-registry.js"

const KABIGON_0_19_6_LOADERS = [
  "ptt",
  "twitter",
  "truthsocial",
  "reddit",
  "youtube",
  "reel",
  "youtube-ytdlp",
  "pdf",
  "pi-session",
  "github",
  "bbc",
  "cnn",
  "ltn",
  "playwright-networkidle",
  "playwright-fast",
  "playwright",
  "curl-cffi",
  "httpx",
  "firecrawl",
  "ytdlp",
] as const

const SUMIRE_ONLY_LOADERS = ["anydoc", "threads", "google-docs"] as const

describe("Kabigon loader registry parity", () => {
  it("retains every Kabigon 0.19.6 loader ID and documents Sumire-only loaders separately", () => {
    const names = listLoaderNames()
    const baseline = new Set<string>(KABIGON_0_19_6_LOADERS)

    expect(names.filter((name) => baseline.has(name))).toEqual(KABIGON_0_19_6_LOADERS)
    expect(names.filter((name) => !baseline.has(name))).toEqual(SUMIRE_ONLY_LOADERS)
    expect(new Set(names).size).toBe(names.length)
  })
})
