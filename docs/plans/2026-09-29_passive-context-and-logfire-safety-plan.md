# 修正群組旁聽訊息錯置與 Logfire 憑證曝露

## Goal

讓每次 Pi 回合以當前使用者請求為準，不因同 chat 的群組旁聽訊息回答其他人的問題；確保 Logfire 不再輸出 Telegram bot token 或其他含憑證的 HTTP URL，並處置已曝露的憑證。

## Context

- 2026-09-29 10:21:23 UTC，Logfire trace `01a0ecaeed0f3ecbcf1affbad008724a` 的 `telegram.request` / `pi.submit` 對應 Airbus URL；`reply_branch_restored=false`，該回合沒有 `url.load`。Pi session JSONL 中，Airbus 使用者訊息後、模型回覆前插入六則 `telegram-passive-context`，最後一則是其他 bot 要重新查詢 Codex reset；模型回答了該問題。後續 `/f` 的另一個 trace 才成功載入 Airbus URL。
- `apps/bot/src/telegram/bot.ts` 將未定址的群組訊息透過 `inSubmissionOrder` 傳至 `appendPassiveContext`；`apps/bot/src/agent/session-registry.ts` 以 Pi `sendCustomMessage({ display: false }, { triggerTurn: false, deliverAs: "nextTurn" })` 提交。現有 `FakeSession` 只記錄呼叫，沒有模擬 Pi 的 pending message 注入順序。`instructions/SYSTEM.md` 已要求 URL-only 請求先讀取當前網址；單靠該指令未阻止這次錯誤。
- `apps/bot/src/logging.ts` 只對明確寫入的日誌做遮蔽；Logfire 自動 HTTP spans 仍在 `attributes.url.full` 記錄 Telegram API URL 中的 bot token。`apps/bot/README.md` 已警告 HTTP spans 可能記錄 URL，但實際已包含憑證。

## Plan

- [ ] **先做生產環境圍堵與取證：**由有權限的維運者確認 Logfire 存取範圍及曝露期間，暫停含敏感 HTTP URL 的遙測匯出（必要時暫停 `LOGFIRE_TOKEN`），記下保留／刪除歷史 traces 的處置決定；以不輸出 token 的設定與 Logfire 查詢結果驗收。不要將 trace 原文或憑證寫入 repo、測試快照或工單。**待維運執行：**目前 PR 尚未合併，上線設定由 GitHub Actions `deploy.yml` 在 `main` push 時產生；停用既有遙測與調查 Logfire 存取紀錄涉及生產操作，尚未做，不能視為圍堵完成。
- [x] **確認 Pi 的 pending custom-message 語義：**用目前鎖定的 `@earendil-works/pi-coding-agent` 版本建立無外部模型依賴的最小重現，驗證 `deliverAs: "nextTurn"`、串流中到達的旁聽訊息、`prompt`、`steer`、`followUp` 與 branch restoration 的實際先後；以能重現「Airbus user → Codex passive → assistant」的測試或紀錄驗收，再選定不改寫 Pi 回合控制權的修法。證據：`apps/bot/tests/pi-passive-context.test.ts` 使用 Pi 0.87.1 與本機假模型，證實 `nextTurn` 在當前 URL 後、`triggerTurn: false` 在當前 URL 前；`session-registry.test.ts` 與既有 reply-tree／steer／followUp 測試通過。
- [x] **修正 bot 對被動上下文的排程：**修改 `apps/bot/src/telegram/bot.ts`／`apps/bot/src/agent/session-registry.ts`，讓同 chat 的旁聽訊息僅作為已標記、非指令的背景資料，不能排在當前使用者請求後成為最後待回答內容；維持 per-chat 順序、跨 chat 隔離、取消／重設及原生 Pi reply-tree 行為。以回合訊息順序與當前 prompt 保留情況驗收，不以模型輸出文字比對作為唯一判準。證據：`session-registry.ts` 不再使用 `deliverAs: "nextTurn"`，真實 Pi session 及 bot 路由測試驗證順序。
- [x] **補足上下文回歸測試：**在 `apps/bot/tests/session-registry.test.ts` 與 `apps/bot/tests/bot.test.ts` 覆蓋網址請求前後的其他 bot 旁聽訊息、併發到達／串流中到達、首次建 session、回覆舊分支、`/cancel`／`/reset`；驗證當前請求不被替換，普通網址仍交由 Pi 決定是否呼叫 `load_public_url`，`/f` 仍只預載自身來源。執行 bot workspace 測試驗收。證據：bot workspace 全部 415 項通過（含新真實 Pi、本機模型、Telegram 群組與 reset 測試）；現有 /f、reply-tree、取消與順序測試持續通過。
- [x] **查明並關閉 Logfire HTTP URL 洩漏來源：**查核目前 `@pydantic/logfire-node` 的自動 instrumentation 設定與 `grammy`／`fetch` 路徑，選擇在匯出前不收集敏感 HTTP spans／屬性、但保留 `telegram.request`、`pi.submit`、`url.load` 等必要安全的手動 spans 的最小實作；不要依賴對模型輸出或上游警告的字串修補。以 SDK 實際設定或整合測試證明不再有含憑證的 `url.full` 等 HTTP 屬性。證據：Logfire 0.18.26 的 HTTP／undici instrumentation 均設定 `enabled: false`；`logging-instrumentation.test.ts` 以本機 HTTP server 驗證 fetch／http.get 不匯出敏感 URL、Authorization，仍保有手動 span；`logging.ts` 的 callback 包裝會攔截原始錯誤，僅將固定的 `operation.outcome=error` 傳給 SDK，並在 SDK 結束後向呼叫者重拋原始錯誤。
- [x] **加入遙測安全測試並更新文件：**在 `apps/bot/tests/logging.test.ts`（必要時另加整合測試）覆蓋 Telegram API token URL、Authorization 與含機密 query 的外部 URL；確認 Logfire records 不含原文，手動 span 與本機 stderr 遮蔽仍有效。更新 `apps/bot/README.md` 中 HTTP spans 的保證與殘餘風險，以測試及文件 diff 驗收。證據：`logging.test.ts` 檢查 SDK 設定，整合測試覆蓋 fake token、fake Authorization、含機密 query；README 記錄停用範圍、例外處理及既有 trace 風險；SDK 整合測試亦檢查拋出含敏感 URL 的例外不進入 span events/status，日誌單元測試檢查不認得的 query 密鑰所屬 URL 也整段遮蔽。
- [ ] **完成變更與版控檢查：**為受影響的 private `@narumitw/sumire` 加 `.changeset/` 版本項；從 repo root 執行 `npm ci`、`npm run format`、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`；以全數通過或逐項記錄失敗原因驗收。證據：Node 26、`npm ci`、`npm run format`、`format:check`、`lint`、`typecheck`、`npm test`（417+4+256+33）、`build` 全通過；`.changeset/fix-passive-context-logfire-safety.md` 為 bot patch。
- [ ] **部署、安全復原與驗證：**在安全修補上線且確認不再輸出憑證後，由維運者輪替 Telegram bot token 並撤銷舊 token；處理 Logfire 中的歷史敏感 records（刪除／縮短保留期及限制存取，記錄結果）。用測試群組發送「另一 bot 的 Codex 討論 → Airbus URL → /f」，查驗同一回合沒有錯答、該 URL 的工具載入與安全的 trace 欄位；確認 Telegram 投遞、reply-tree、既有 Pi session 均正常。**待合併及維運操作：**上線需備份 state volume；BotFather token 輪替／撤銷及 Logfire 歷史資料處置無法僅由程式碼 PR 驗收，故本項保持未完成。

審查時另發現：即使停用 HTTP 自動 spans，Logfire 手動 span 的 callback 若拋出含 URL 的例外，SDK 仍會自動匯出原始例外文字；現已將錯誤轉成固定 span outcome，在 SDK 外重拋，並加入失敗／延後 callback 的回歸測試。

## Rollback / Recovery

生產部署前備份 `.telegramagent` state volume；不要執行 `docker compose down -v`，也不要用 `/reset` 清除舊對話來迴避錯誤。若回歸，先停用有憑證洩漏的 Logfire 匯出，再回退 bot image／設定並保留 session state；不可回退到會持續輸出 token 的舊遙測設定。已輪替的 token 不得恢復使用；對舊 traces 的存取控制與清理仍須完成。

## Completion Checklist

- [x] 群組旁聽的重現與修正有可重跑的測試證據；目前請求不會被旁聽訊息奪走焦點，並保留取消、reply-tree 與一般 URL 工具路徑。見本計畫 Pi／bot 測試、全 repo 測試結果。
- [ ] Logfire 實際匯出紀錄不含 bot token 或帶密鑰的 URL；舊 token 已撤銷，歷史紀錄已有明確處置結果。
- [ ] Bot 文件、changeset、上述 workspace／全 repo 檢查及生產測試群組驗證皆有結果；若需外部維運操作，待其完成才宣告整體解決。
