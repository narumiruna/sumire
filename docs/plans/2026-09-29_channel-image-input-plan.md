# 頻道圖片輸入計畫

## Goal

讓 Sumire 在明確授權的 Telegram 頻道收到**新貼文**的圖片時，能在受控的觸發方式下把圖片交給現有 Pi 圖片輸入流程；未授權頻道與非圖片貼文不應觸發模型或下載。先確定處理時機與輸出位置，再實作，避免每則貼文自動執行具檔案系統權限的工具或在頻道洗版。

## Context

- `apps/bot/src/telegram/polling.ts` 只訂閱 `message`；`apps/bot/src/telegram/bot.ts` 只處理 `message`，並在若干處假設 `context.message` 存在。頻道新貼文是 `channel_post`，不是 `message`。
- `apps/bot/src/telegram/messages.ts` 已能從 `photo` 或圖片 `document` 選出圖片；`apps/bot/src/telegram/files.ts` 已透過 `getFile` 下載且逐塊執行 `BOT_IMAGE_MAX_BYTES` 限制；Pi model 註冊接受 image（`apps/bot/src/agent/pi-session-factory.ts`）。目前未被指向 bot 的群組圖片僅留下「未讀取圖片內容」標記。
- 現有 `BOT_WHITELIST` 允許 chat ID **或** sender ID；頻道貼文可能沒有 `from`。新增頻道路徑必須明確以頻道 chat ID 授權，不得因 sender ID 符合而接受任意頻道；現有 coding tools 可存取執行環境。
- Telegram 官方文件：[Update](https://core.telegram.org/bots/api#update)、[getUpdates](https://core.telegram.org/bots/api#getupdates)、[Bots FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)。Bot API 不提供任意讀取頻道歷史貼文的 `getMessage`；新更新最多保留 24 小時。

## Decisions (confirmed with user)

- 只被動索引明列於現有 `BOT_WHITELIST` 的頻道 `chat.id` 的新圖片貼文；頻道 `from.id` 即使白名單命中也不得授權。目標 ID 在部署時設定，不寫入儲存庫。
- `BOT_CHANNEL_IMAGE_INPUT_ENABLED=false` 預設停用，與 `BOT_IMAGE_INPUT_ENABLED` 一起控制索引、輪詢及工具註冊。貼文不呼叫 Pi、不下載、不主動發文。允許的使用者於既有私聊／群組提問時，由 Pi 選擇呼叫 `read_image` 查看近期索引及按頻道／訊息 ID 讀取圖片；答案只送回提問對話，無需頻道發文權限。
- 第一版只處理 `channel_post`，相簿逐則索引；沿用現有 `photo`／image `document`；不處理編輯或任意歷史。使用者明確接受無測試頻道，改以自動測試代替實測，部署時須另行驗證 Telegram 權限與實際投遞。
- 原先計畫要求在 `bot.ts` 將頻道圖片直接交給 Pi submission，經使用者改為 Pi 按需使用 agent tool；因此改為持久化有限的圖片 metadata，工具呼叫時才走既有安全下載與 Pi 圖片結果路徑。

## Plan

- [x] 確認使用者的觸發條件、目標頻道 ID、輸出位置與權限、是否處理編輯／相簿，並在本計畫記錄決策；驗收：見 Decisions；頻道 ID 由部署者放入 `BOT_WHITELIST`，新貼文僅索引，Pi 回應使用者提問時按需讀取並在原 chat 回答。
- [x] 設計頻道專用的授權與觸發邊界；驗收：使用者確認沿用 `BOT_WHITELIST`，但頻道僅查 `chat.id`；`BOT_CHANNEL_IMAGE_INPUT_ENABLED=false` 預設停用，權限與工具執行風險記於 `apps/bot/README.md`。
- [x] 調整 polling 的 `allowed_updates`；驗收：`apps/bot/tests/polling.test.ts` 驗證預設僅 `message`，啟用時 `message` 與 `channel_post`，無 edited updates。
- [x] 加入頻道路由、有限索引與 Pi `read_image`；驗收：bot、索引、tool、Pi factory 測試覆蓋授權、sender-ID 不放行、無 `from`、圖片文件／純文字／編輯、工具圖片結果與既有訊息行為。
- [x] 不在頻道發文，僅在原 chat 回覆；驗收：`bot.test.ts` 證明頻道更新與索引失敗均無 `sendMessage`、無 Pi submission；使用者提問送回原 chat，既有 chat 測試覆蓋 delivery。
- [x] 驗證邊界案例；驗收：files/read-image/channel-images/bot 測試涵蓋超大檔、串流超限、失敗、停用、排序、取消與重設；聚焦測試 168 passed。
- [x] 更新 `apps/bot/README.md`、`.env.example` 與 `.changeset/channel-image-tool.md`；驗收：記錄設定、讀取／無需發文權限、限制與測試方式，changeset 涵蓋 `@narumitw/sumire`。

## Completion Checklist

- [x] 從 repository root 執行 `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`；驗收：Node 22.23.2 上全部通過（bot 406、progress 4、url-content 256、url-tool 33 tests）。
- [x] 使用者選擇無實際測試頻道，明確接受自動測試代替；驗收：`bot.test.ts` 用新圖片、未授權頻道、非圖片與編輯更新驗證被動索引／無送訊／無 Pi，`read-image.test.ts` 驗證按需回傳圖片；實際 Telegram 更新、讀取權限及保留期限仍屬未驗證部署風險，記於 README／PR。
- [x] 審查完整 staged diff 與 `git diff --cached --check`；驗收：僅原始碼、測試、文件、changeset 與本計畫，無實際 token、私有圖片或忽略輸出；安全授權、索引上限、工具取消及相容性已檢視。

## Rollback / Recovery

- 部署前保留原設定與映像版本；若觸發錯誤或費用異常，先停用頻道功能並重啟，再回復先前映像。重新縮小 `allowed_updates` 只影響後續更新；已投遞的更新與已執行的 Pi turn 不會自動撤回。不要透過刪除資料卷回滾，避免遺失既有 Pi sessions。實際上線前確認停用開關、發文權限與費用上限的處置方式。
