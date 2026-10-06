# Sumire codemode 支援計畫

## Goal

讓 allowlisted Telegram 使用者能透過 Pi 原生 codemode 批次呼叫工具、串接操作及篩選輸出，同時保留既有取消、進度、圖片及 reply-tree 行為。首次發布採 opt-in，不另寫 agent loop。

實作與自動化驗收已完成；live endpoint／Telegram 驗收或明確接受延後仍待處理，尚未部署正式環境。

## Context

以下為 `8c04a63` 的研究基線；實作與驗收進度見 Evidence。

- `apps/bot/package.json` 與 `package-lock.json` 已固定 Pi `1.0.2`，包含 codemode 及 QuickJS 依賴，不需升級 Pi。
- `apps/bot/src/agent/pi-session-factory.ts` 使用 `DefaultResourceLoader` 的具名 inline factories，但未載入 codemode，`defaultTools` 也未啟用它。保留 `noExtensions: true` 仍能加入明確指定的 inline factory。
- Factory 目前未呼叫 `session.bindExtensions({})`。`packages/progress/src/progress-extension.ts` 依靠 `session_start` 初始化 session ownership；同版 Pi 的離線 PoC 已重現未初始化時 progress 執行失敗。
- `packages/progress/src/progress-state.ts` 只從獨立的 `update_progress` tool result 還原狀態。Pi nested calls 有執行事件，但不獨立寫入 transcript，因此不能只靠既有 listener 還原 nested progress。
- `apps/bot/src/agent/read-image.ts` 回傳文字及 image blocks，沒有 `outputSchema`。codemode 對這種工具只取得文字，不能取代直接圖片讀取。
- 研究階段以同版 Pi、現有 progress 原始碼及 mock Chat Completions endpoint，驗證了 native tools、平行結果、參數驗證、取消、script deadline、store 持久化及分支還原。PoC 尚未納入 repository；仍需用本 repository 的 lockfile 重建測試。
- 參考：[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#codemode-mcp)、[Codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)。以上 API 判斷以研究時的 `1.0.2` 為準。

## Architecture

- Pi `AgentSession` 繼續擁有 model turns、tool loop、retry、compaction、transcript 與 codemode store；Bot 只負責明確載入能力、host deadline、Telegram transport 及既有 orchestration。
- 在 `apps/bot/src/agent/codemode.ts` 集中 Bot 的 codemode policy，使用公開 `createCodemodeExtension` API，固定 `mode: "on"`、`models: false`。不匯入 Pi 私有執行器、不複製 sandbox，也不開放 filesystem extension discovery。
- 新增 `BOT_CODEMODE_ENABLED=false` 與 `BOT_CODEMODE_TIMEOUT_SECONDS=300`。Timeout 接受 0.1–3,600 秒；由 host 合併原始 cancellation signal 與 deadline signal，限制整段 script，不依靠模型填寫 `// @options:`。模型指定較短期限仍可生效，較長期限不能繞過 host 上限。
- `update_progress` 與 Bot 的 `read_image` 設為 `exposure: "model-only"`，保留模型直接呼叫，禁止從 codemode nested 呼叫。`read` 等 coding tools 保持直接可用；讀取圖片時必須走直接工具呼叫。
- `load_public_url` 維持原工具及安全檢查。它目前回傳 JSON 文字，script 可對工具結果做 `JSON.parse`；第一版不改變 URL tool 的公開結果契約。
- Session 不論是否啟用 codemode，都要在回傳前完成 `bindExtensions({})`。初始化失敗時 dispose 尚未交付的 session，並接入既有 logger 的 extension error 回報。

## Non-Goals

- 不整合 MCP、classifier、image generation 或 Telegram 圖片輸出。
- 不新增 Telegram 指令、keyword routing、第二套 agent loop 或新的 session store。
- 不改變 whitelist、sender role、URL public-target validation 或現有 coding-tool 權限。QuickJS 不是 `bash` 的權限隔離層。
- 不採用 `mode: "only"`，不改寫既有 transcripts，也不從 codemode 輸出文字解析進度。

## Plan

- [x] 驗證 Pi `1.0.2` 的公開 factory 包裝方式能限制 tool execution，同時保留 `defaultActive`、`exposure`、`prepareLoadout`、schema、constrained sampling 及 prompt metadata；以 repository 依賴下的離線測試證明 host signal 能終止 CPU-bound script 與 nested Bash。若公開 API 無法滿足要求，先修訂方案，不改用私有 import。
- [x] 修正 `pi-session-factory.ts` 的 extension lifecycle，在交付 session 前初始化 extensions；factory 整合測試須證明直接 progress 首次呼叫及 resumed session 均成功，初始化失敗會 dispose 並回報錯誤。
- [x] 將 progress 與 `read_image` 的 exposure 改為 model-only；更新 `packages/progress/tests/progress.test.ts`、`apps/bot/tests/read-image.test.ts` 及 Pi 整合測試，證明工具仍直接宣告、codemode discovery 不包含它們，progress 在 restart／branch navigation 後仍可還原，直接圖片結果仍含 image block。
- [x] 在 `apps/bot/src/config/settings.ts` 加入 codemode enable flag 與 timeout；`apps/bot/tests/settings.test.ts` 須覆蓋預設停用、合法值、邊界及非法值，停用時不註冊或啟用 codemode。
- [x] 在 `apps/bot/src/agent/codemode.ts` 實作 bounded inline extension，並接入 factory 的 `extensionFactories` 與 `defaultTools`；`apps/bot/tests/codemode.test.ts` 及 factory 測試須證明保留 `noExtensions: true`、既有工具可用、host deadline 不可繞過，且 `models` 不可用。
- [x] 在 Bot workspace 加入 mock endpoint 的端到端 session 測試，證明 normal function calling 的 `{ code: string }` 契約、independent parallel calls、invalid arguments、原 URL 工具對 unsafe target 的拒絕、`/cancel`／`/reset`、store 跨 chat 隔離、reply-tree／restart 還原及停用 codemode 後既有 session resume 均正常；timeout 後同一 session 能接受下一次請求，失敗前已完成的工具操作不宣稱已回滾。
- [x] 更新 `.env.example`、`apps/bot/README.md` 與 `packages/progress/README.md`，明列 opt-in、整段 script deadline、direct-only progress／圖片、JSON 文字結果、不可回滾的副作用及既有 trusted-user 權限；保留 Pi 原有 memory／output bounds，不宣稱 nested results 會自動送給模型。
- [x] 新增 implementation changeset，至少 patch bump `@narumitw/sumire` 與 `@narumitw/sumire-progress`，並納入實際額外受影響的 package；若與計畫草稿同一 PR，取代 documentation-only empty changeset，不能只留下空 changeset。
- [ ] 執行完整驗收並記錄結果：先以 workspace-scoped checks 迭代，再跑下方 root checks；Docker smoke 使用 repository root 的 Compose 及隔離 test state，確認 production pruning 後 worker／WASM 仍可執行。不得啟動正式 Telegram polling；實際 provider／Telegram 試跑需另行授權。必要檢查失敗或無法執行時保持未勾選；實際 endpoint／Telegram 試跑可依下方驗收條件，由使用者明確接受延後。

## Evidence

- Base: `origin/main` (`8c04a63`); branch: `narumi/feat/codemode-support`。原有計畫與 empty changeset 已保留並納入本次工作。
- `npm ci` 通過，audit 無 vulnerabilities。
- Focused Bot checks: 5 test files／30 tests 通過；Bot 與 progress typecheck 通過；progress tests 4／4 通過。證據位於 `codemode.test.ts`、`codemode-session.test.ts`、`pi-session-factory.test.ts`、`settings.test.ts`、`read-image.test.ts` 及 progress tests。
- Root `format:check`、`lint`、`typecheck`、`test`、`build` 全數通過。Root tests：Bot 475、login 9、progress 4、URL content 283、URL tool 38，共 809 tests。初次 lint 的 array-type style 問題及新增 success test 對 optional `isError` 的錯誤假設已修正，完整 checks 已重跑通過。
- `.env.example`、Bot／progress README 已更新；`npx changeset status --since origin/main` 通過，列出 Bot 與 progress 的 patch bumps。首次執行時 changeset 尚未 staged，工具未偵測到它；staging 後已重跑確認。
- 隔離 `docker compose -p sumire-codemode-smoke -f compose.codemode-smoke.yaml run --build --rm sumire` 通過，exit 0；image `sha256:24e15101cd7bce770acaa7ebd862054be648200e5de74b764fb77d83c85a4c9d` 為 Linux amd64，使用者為 `app`。Fixture 驗證 dev dependencies 已 pruning、native Pi worker／WASM、native tools、直接 progress、store persistence、CPU-bound host deadline 與 recovery；沒有外部模型／Telegram 請求，沒有 credentials、polling 或正式 state mounts。
- 本機 compiled smoke 與 Compose config validation 亦通過。首次 build 超過 300 秒，已重新執行並等候 production dependencies 完成。Smoke container 已自動移除，隔離 project 的 `down`／`ps -a` 確認沒有殘留資源；沒有操作正式 project。
- 完整 source、test、文件與 Compose diff 已 review：保留 whitelist、原 URL defenses、streaming image byte limits、Pi 取消、branch-aware state 與原有 tool contract；沒有 secrets 或正式 runtime state 變更。
- Commit 使用 SSH signature，`git verify-commit` 通過；pre-commit 自動整理一處 import order 後已 review 並納入 commit，五項 root checks 重新全數通過。
- 正式 provider 與 Telegram credentials 在目前環境均不可用；live endpoint／Telegram 驗收尚未通過，也尚未獲接受延後。已提出提供受控 test credentials 或明確接受延後的選項；尚待回覆。所有自動化驗收已完成，但本計畫不能宣告完成或刪除，PR 必須保持 draft，enable flag 保持 false。

## Completion Checklist

- [ ] 公開 API／deadline discovery task 已通過；上述 implementation tasks 均有對應 diff、測試或明確驗收證據，沒有未處理的 material unknown。
- [x] `npm ci` 已從 repository root 完成；`npm test --workspace @narumitw/sumire`、`npm test --workspace @narumitw/sumire-progress` 及兩個 workspace 的 `npm run typecheck --workspace <package-name>` 均通過。
- [x] Root 的 `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 全數通過；失敗或無法執行的項目保持未勾選，並回報原因。
- [ ] 隔離 Docker smoke 通過；實際 endpoint／Telegram 相容性已有經授權的驗證，或使用者明確接受延後且記錄理由，正式 enable flag 保持 false。
- [x] 文件、package changeset 與安全 review 完成；review 確認 whitelist、URL defenses、圖片 byte limits、取消及 branch-aware state 未退化，沒有 secrets 或 runtime state 被提交。

只有所有任務與驗收均已勾選、material unknown 已解決或獲明確接受、交付工作完成後，才刪除本計畫並回報其路徑。不因草稿完成而刪除計畫。

## Rollback / Recovery

- 發布前先備份既有 session state。第一版沒有資料 migration，也不刪除或改寫既有 sessions。
- 出現 codemode 問題時設定 `BOT_CODEMODE_ENABLED=false` 並重啟 Bot，保留 lifecycle 修正及直接 progress／圖片能力。codemode custom entries 可以留在 session；需以停用後 resume 測試確認舊 transcript 仍可使用。
- 若須回退整個 release，改用上一個 image，保留 state volumes；不要執行 `docker compose down -v`，也不要以舊備份覆蓋仍可使用的新對話。
- Timeout、取消及失敗不撤銷已完成的檔案修改或發布。只能依工具記錄檢查副作用，再由使用者授權復原；不得自動重播可能有副作用的 script。
