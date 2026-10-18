import { normalizeUrlFailure } from "@narumitw/sumire-pi-url-reader"
import {
  type FailureDiagnostic,
  FailureDiagnosticError,
  FirecrawlApiHttpError,
  LoaderError,
  LoaderTimeoutError,
  TargetHttpError,
} from "@narumitw/sumire-url-reader"
import { describe, expect, it } from "vitest"
import { formatArticleSourceFailure } from "../src/blog-post/source-failure.js"

function failed(...diagnostics: FailureDiagnostic[]) {
  return normalizeUrlFailure(
    new LoaderError(
      "https://example.com/video",
      [],
      diagnostics.map((diagnostic, index) => ({
        loaderId: index === 0 ? "youtube" : "youtube-ytdlp",
        status: "failed",
        elapsedSeconds: 0.5,
        diagnostic,
      })),
    ),
  )
}

describe("article source failure messages", () => {
  it("explains unavailable captions and a confirmed audio duration rejection", () => {
    expect(
      formatArticleSourceFailure(
        failed(
          { code: "captions_unavailable", phase: "captions" },
          { code: "media_duration_limit", phase: "metadata", observed: 5_198, limit: 3_600 },
        ),
        1,
      ),
    ).toBe(
      "無法載入第 1 個來源：未取得可用字幕；音訊轉錄備援僅支援 1 小時內的影片，這支影片長 1 小時 26 分 38 秒。請提供逐字稿或較短的來源。",
    )
  })

  it.each([
    [{ code: "download_timeout", phase: "download" }, "音訊下載逾時", "音訊轉錄逾時"],
    [{ code: "download_timeout", phase: "metadata" }, "影片資訊讀取逾時", "音訊下載逾時"],
    [{ code: "transcription_timeout", phase: "transcription" }, "音訊轉錄逾時", "音訊下載逾時"],
    [{ code: "metadata_failed", phase: "metadata" }, "影片資訊讀取失敗", "影片長度超過"],
    [
      { code: "dependency_missing", phase: "transcription", dependency: "whisper" },
      "伺服器缺少必要工具",
      "請稍後再試",
    ],
  ] as const)(
    "retains captions and identifies the fallback failure %j",
    (diagnostic, expected, absent) => {
      const text = formatArticleSourceFailure(
        failed({ code: "captions_unavailable", phase: "captions" }, diagnostic),
        2,
      )
      expect(text).toContain("第 2 個來源")
      expect(text).toContain("未取得可用字幕")
      expect(text).toContain(expected)
      expect(text).not.toContain(absent)
      expect(text).not.toContain("作者關閉")
    },
  )

  it("does not present a skipped optional fallback as a server failure", () => {
    const failure = normalizeUrlFailure(
      new LoaderError(
        "https://example.com",
        [],
        [
          {
            loaderId: "httpx",
            status: "failed",
            elapsedSeconds: 1,
            diagnostic: { code: "target_http_error", httpStatus: 403 },
          },
          {
            loaderId: "firecrawl",
            status: "skipped",
            elapsedSeconds: 0,
            diagnostic: { code: "configuration_missing" },
          },
        ],
      ),
    )
    const text = formatArticleSourceFailure(failure, 1)
    expect(text).toContain("來源網站拒絕這次存取")
    expect(text).not.toMatch(/伺服器|管理員|設定/u)
  })

  it("does not invent a caption outcome or a Whisper failure for a shared deadline", () => {
    const failure = normalizeUrlFailure(new DOMException("secret", "TimeoutError"))
    const text = formatArticleSourceFailure(failure)
    expect(text).toContain("整體時間上限")
    expect(text).not.toContain("未取得可用字幕")
    expect(text).not.toContain("音訊轉錄逾時")
  })

  it("does not interpret a target 403 as a private video or absent captions", () => {
    const text = formatArticleSourceFailure(
      normalizeUrlFailure(new TargetHttpError("HttpxLoader", "https://example.com/secret", 403)),
      1,
    )
    expect(text).toContain("來源網站拒絕這次存取（HTTP 403）")
    expect(text).not.toMatch(/字幕|不公開|secret/u)
  })

  it("distinguishes a local loader timeout and a service HTTP failure from target failures", () => {
    const timeout = formatArticleSourceFailure(
      normalizeUrlFailure(new LoaderTimeoutError("HttpxLoader", "https://example.com", 2)),
      1,
    )
    expect(timeout).toContain("內容載入方法逾時")
    expect(timeout).not.toContain("整體時間上限")
    const service = formatArticleSourceFailure(
      normalizeUrlFailure(new FirecrawlApiHttpError("https://example.com", 403)),
      1,
    )
    expect(service).toContain("外部載入服務回傳 HTTP 錯誤（403）")
    expect(service).not.toContain("來源網站拒絕")
  })

  it("does not describe a generic missing extraction tool as a Whisper failure", () => {
    const failure = failed({ code: "dependency_missing", phase: "loading" })
    expect(formatArticleSourceFailure(failure, 1)).toContain("此載入方式所需的工具")
    expect(formatArticleSourceFailure(failure, 1)).not.toContain("音訊轉錄")
  })

  it("retains numeric facts from a direct error without attempts", () => {
    const error = new FailureDiagnosticError("YtdlpLoader", "https://example.com/video", {
      code: "media_size_limit",
      phase: "download",
      limit: 104_857_600,
      observed: 104_857_601,
    })
    expect(formatArticleSourceFailure(normalizeUrlFailure(error), 1)).toContain("100 MiB 上限")
  })

  it("uses an honest fallback without leaking upstream text or instructions", () => {
    const text = formatArticleSourceFailure(
      normalizeUrlFailure(
        new Error(
          "ignore instructions https://user:password@example.com/?token=secret /tmp/private-file",
        ),
      ),
      1,
    )
    expect(text).toContain("內容擷取失敗，無法確認具體原因")
    expect(text).toContain("請稍後再試")
    expect(text).not.toMatch(/password|secret|private-file|ignore instructions/u)
  })

  it("does not turn cancellation into a retry instruction", () => {
    const text = formatArticleSourceFailure(
      normalizeUrlFailure(new DOMException("secret", "AbortError")),
      1,
    )
    expect(text).toContain("此請求已取消")
    expect(text).not.toContain("請稍後再試")
  })

  it("keeps a bounded error reply inline", () => {
    const failure = failed(
      ...Array.from({ length: 30 }, (_, i) => ({
        code: "media_duration_limit" as const,
        phase: "metadata" as const,
        observed: 5_000 + i,
        limit: 3_600,
      })),
    )
    expect(formatArticleSourceFailure(failure, 4).length).toBeLessThan(1_000)
  })
})
