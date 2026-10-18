import type { SafeFailureDiagnostic, UrlFailure } from "@narumitw/sumire-pi-url-reader"

/** Render only normalized facts. Never include upstream messages or URLs. */
export function formatArticleSourceFailure(failure: UrlFailure, sourceIndex?: number): string {
  const diagnostics = failure.attempts
    .filter(
      (attempt) =>
        attempt.status !== "success" &&
        attempt.status !== "not_applicable" &&
        attempt.status !== "skipped",
    )
    .flatMap((attempt) => (attempt.diagnostic ? [attempt.diagnostic] : []))
  if (failure.diagnostic && (diagnostics.length === 0 || failure.code === "deadline_exceeded"))
    diagnostics.push(failure.diagnostic)
  const reasons = [...new Set(diagnostics.map(describeDiagnostic))]
  if (reasons.length === 0) reasons.push(describeCode(failure.code))
  const prefix = sourceIndex ? `無法載入第 ${sourceIndex} 個來源：` : "無法載入文章來源網址："
  const codes = new Set([failure.code, ...diagnostics.map(({ code }) => code)])
  const action =
    codes.has("dependency_missing") || codes.has("configuration_missing")
      ? "請聯絡管理員，或提供來源文字／逐字稿。"
      : codes.has("media_duration_limit") || codes.has("media_size_limit")
        ? "請提供逐字稿或較短的來源。"
        : codes.has("unsafe_url") || codes.has("invalid_url")
          ? "請提供可公開存取、不含登入憑證的 HTTP(S) 網址。"
          : codes.has("cancelled")
            ? ""
            : "請稍後再試，或提供來源文字／逐字稿。"
  // Keep the reply below the bot's 1,000-character inline threshold.
  const reason = reasons.join("；")
  const bounded = reason.length > 750 ? `${reason.slice(0, 750)}…` : reason
  return `${prefix}${bounded}。${action}`
}

function duration(seconds: number): string {
  const total = Math.ceil(seconds)
  const parts = [
    [Math.floor(total / 3_600), "小時"],
    [Math.floor((total % 3_600) / 60), "分"],
    [total % 60, "秒"],
  ] as const
  return (
    parts
      .filter(([value]) => value > 0)
      .map(([value, unit]) => `${value} ${unit}`)
      .join(" ") || "0 秒"
  )
}

function describeDiagnostic(diagnostic: SafeFailureDiagnostic): string {
  const { code, phase, limit, observed, httpStatus } = diagnostic
  switch (code) {
    case "media_duration_limit":
      return limit !== undefined && observed !== undefined
        ? `音訊轉錄備援僅支援 ${duration(limit)}內的影片，這支影片長 ${duration(observed)}`
        : "影片長度超過音訊轉錄備援上限"
    case "media_size_limit":
      return limit !== undefined
        ? `音訊大小超過轉錄備援的 ${Math.ceil(limit / 1_048_576)} MiB 上限`
        : "音訊大小超過轉錄備援上限"
    case "download_timeout":
      return phase === "metadata" ? "影片資訊讀取逾時" : "音訊下載逾時"
    case "target_http_error":
      return httpStatus === 403
        ? "來源網站拒絕這次存取（HTTP 403）"
        : `來源網站回傳 HTTP 錯誤${httpStatus ? `（${httpStatus}）` : ""}`
    case "dependency_missing":
      return phase === "transcription" || phase === "download" || phase === "metadata"
        ? "伺服器缺少必要工具，音訊轉錄目前無法使用"
        : "伺服器缺少此載入方式所需的工具"
    case "service_http_error":
      return `外部載入服務回傳 HTTP 錯誤${httpStatus ? `（${httpStatus}）` : ""}`
    case "loader_timeout":
      return "內容載入方法逾時"
    case "empty_content":
      return phase === "transcription" ? "音訊轉錄結果為空" : "未擷取到可用內容"
    default:
      return describeCode(code)
  }
}

function describeCode(code: UrlFailure["code"]): string {
  switch (code) {
    case "captions_unavailable":
      return "未取得可用字幕"
    case "caption_language_unavailable":
      return "未取得所選語言的字幕"
    case "captions_empty":
      return "字幕擷取結果為空"
    case "caption_extraction_failed":
      return "字幕擷取失敗，無法確認具體原因"
    case "metadata_failed":
      return "影片資訊讀取失敗，無法確認影片長度"
    case "download_failed":
      return "音訊下載失敗，無法確認具體原因"
    case "transcription_failed":
      return "音訊轉錄失敗"
    case "transcription_timeout":
      return "音訊轉錄逾時"
    case "deadline_exceeded":
      return "網址載入超過整體時間上限；未完成的步驟無法確認結果"
    case "cancelled":
      return "此請求已取消"
    case "empty_content":
      return "未擷取到可用內容"
    case "configuration_missing":
      return "伺服器缺少此載入方式所需的設定"
    case "transport_failure":
      return "連線失敗，未能取得來源內容"
    case "tls_certificate":
      return "來源的 TLS 憑證驗證失敗"
    case "invalid_url":
      return "網址格式不正確或不支援此通訊協定"
    case "unsafe_url":
      return "網址或重新導向目標不符合公開網址的安全限制"
    case "unsupported_content_type":
      return "不支援來源回傳的內容格式"
    case "response_size_limit":
      return "來源內容超過可讀取的大小上限"
    case "redirect_limit":
      return "來源重新導向次數超過上限"
    default:
      return "內容擷取失敗，無法確認具體原因"
  }
}
