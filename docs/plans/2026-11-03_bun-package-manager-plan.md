# Bun Package Manager Migration

## Goal

以固定版本的 Bun 取代 repository 自有流程中的 npm 套件安裝與 script runner，讓本機、CI、Docker 使用同一套 lockfile 與命令。保留必要的 Node.js runtime、現有測試覆蓋、dependency script 信任限制，以及 production image 的隔離檢查。

已開始執行遷移；尚未部署 production。驗證證據記錄於 `docs/bun-package-manager-validation.md`。

## Context

- `Dockerfile` 目前以 npm 安裝、建置及 prune；只有 bot runtime 使用 Bun 1.4.4。`dependencies` stage 不含 Bun，不能只替換命令名稱。
- 根目錄 `package.json`、`package-lock.json` 管理所有 workspaces；根目錄及多個 workspace scripts 使用 npm，並依靠 prebuild、pretest、prepack 等 hooks。
- `.github/workflows/ci.yml`、`publish.yml` 使用 Node.js 26、npm cache 與 `npm ci`；CI path filters 追蹤 `package-lock.json`。
- Docker 的部分 build 使用 `npm --ignore-scripts run build`，因為依賴已在其他 stages 編譯；這些 stages 不包含完整依賴來源。
- `package.json` 的 `allowScripts` 包含明確拒絕項目，以及 `esbuild@0.28.2`、`koffi@3.3.1` 的版本限定核准。`.npmrc` 設定 `engine-strict=true`。
- Node.js 必須保留給 impers host、codemode 及相依工具。既有 Vitest suite 不能直接改成 `bun test`。
- 2026-11-03 在既有 image 內以 Bun 1.4.4 執行無網路 fixture：workspace script 失敗會回傳非零值；Node.js shebang 仍由 Node.js 執行；`bun run --ignore-scripts build` 仍執行 prebuild/postbuild。workspace 順序未證明符合依賴順序，不能據此移除既有依賴建置。

## Scope

- 固定 Bun 1.4.4，保留 Node.js 26 或更新版本；若需改變 Bun 版本，必須重新驗證本計畫的相容性證據。
- 根目錄以文字格式 `bun.lock` 作為唯一 dependency lockfile，不升級現有 dependencies。
- 遷移本機開發、workspace scripts、Docker、CI、Changesets version 流程及開發文件。
- 本機 bot dev/start 明確使用 Bun，並保留根目錄 `.env` 的載入範圍；測試與需要 Node.js 的工具不使用全域 `--bun`。
- 不修改 `/f`、URL 安全規則、impers 隔離、Pi Harness 邊界或其他功能行為。
- npm registry 名稱、第三方工具內部命令、consumer 安裝範例及歷史記錄可保留 npm；不批次改寫外部 MCP 的 `npx` 設定。
- 不發布套件、不建立 version tags、不觸發 release workflow、不部署 production。

## Plan

### 1. Resolve compatibility gates

- [x] 用 Bun 1.4.4 的獨立 fixture 確定 workspace 執行順序、pre/post hooks、缺少 scripts、非零退出及 Node.js shebang 行為；保存實際執行標記與退出碼，不以 help output 或單一 exit 0 判定成功。
- [x] 驗證 Bun 的 lifecycle trust、預設信任清單及 Node.js engine 檢查能維持現有安全限制；證據須包含被拒絕套件、未核准版本不能執行 scripts，以及不符 Node.js 版本不能繼續受支援的安裝流程。若不能等效，先記錄差異並停止受影響工作，不自行放寬限制。
- [x] 在 disposable checkout 匯入現有 lockfile，比對 dependency versions、integrity、peer/optional dependencies 及 workspace links；驗證 frozen dev/prod installs 不改寫 lockfile，不因本機平台刪除其他平台所需項目。
- [x] 驗證 Bun 的 production filtering、root dependencies 與 linker layout，選定能保留 workspace 解析且排除 devDependencies 的最簡方案；同時驗證 `capture-durable-comparison.ts` 的暫存 checkout 可解析 Vite 及其 dependencies。
- [x] 確認 Changesets/action、prepack、registry authentication、provenance 及 Dependabot 對 Bun lockfile 的支援；記錄必要的 npm 內部命令，不以未執行的 publish 宣稱發布已驗證。

### 2. Migrate dependency and script contracts

- [x] 在根目錄宣告固定 Bun package manager，產生並提交 `bun.lock`、移除 `package-lock.json`；以 dependency graph 比對及乾淨 frozen install 證明沒有套件升級或隱藏的第二份 lockfile。
- [x] 依第一階段證據設定必要的 lifecycle trust、linker 或 engine 檢查；檢查 `.npmrc` 每個設定是否仍需要，不加入未使用的設定或放寬安全政策。
- [x] 遷移根目錄及受影響 workspace 的 npm scripts，保留明確依賴順序、focused checks、generation checks、prepack 與 Husky prepare；以冷啟動 workspace build/test/typecheck 證明不依靠既有 `dist/` 或重複並行寫入。
- [x] 為 Docker 提供可直接執行的必要編譯入口，不依賴無效的 Bun `--ignore-scripts` 替代；以不含依賴來源的各 build stage 證明不重跑依賴 hooks。
- [x] 將 bot dev/start 對齊 Bun runtime；以虛構 env fixture 驗證根目錄 `.env`、缺少 `.env`、工作目錄與既有 environment precedence，不載入額外 workspace env files。保留 Docker `--no-env-file` 與 Compose 注入方式。
- [x] 維持 Vitest、Vite、Playwright 及需要 Node.js 的 scripts 在 Node.js 執行；以 runtime assertion 和實際測試數證明 `bun run test` 沒有變成 `bun test` 或強制 Bun 執行。

### 3. Migrate Docker and automation

- [x] 在 Docker 安裝及建置 stages 提供同版本 Bun，改用 frozen installs 與對應 cache；保留分層建置及 compiled-workspaces artifact 組裝，完成 `runtime-application` build。
- [x] 以已驗證的乾淨 production install 取代 npm prune，正確帶入 workspace links、巢狀 dependencies 及必要的 Bun store；檢查最終 image 不依賴 build-stage 絕對路徑，且不包含 root/admin 開發工具。
- [x] 遷移 CI 的安裝、workspace commands、browser 安裝命令、cache 及 lock/config path filters；保留 Node.js 26、browser flows、Durable comparison 與 Docker import checks，避免臨時下載未鎖定的 CLI。
- [x] 遷移 Changesets 的 version lockfile 更新與 workflow script runner，保留 auth、provenance、permissions 與 prepack 語意；在 disposable checkout 執行 version dry run，確認只更新預期 manifests、changelogs 與 `bun.lock`，不執行 publish。
- [x] 依確認的支援方式更新 Dependabot；以設定文件及 parser/CI 證據確認可更新 `bun.lock`，不將 ecosystem 名稱盲目改為 `bun`。

### 4. Documentation, tests and review

- [x] 更新根目錄及受影響 workspace READMEs、`AGENTS.md` 和必要設定說明，使安裝、focused checks、完整檢查、Node.js 保留原因及 lockfile 規則一致；修改 `AGENTS.md` 前載入 `write-agents-md` skill。列出刻意保留的 npm 用途。
- [x] 為命令執行、失敗傳播、lifecycle 限制及 production dependency closure 加入適當的回歸檢查；測試必須辨識未實際執行的命令，且不需要外網或真實 credentials。
- [x] 為所有受影響 packages 加入正確 changeset，包含 private packages；若僅有不需版本變更的 repository 工具修改，依實際 diff 說明空 changeset 的理由。
- [x] 從乾淨安裝執行 focused checks，再執行根目錄 `bun run format:check`、`bun run lint`、`bun run typecheck`、`bun run test`、`bun run build`；記錄命令、測試數與失敗或 skipped 路徑。遷移期間仍以現行 `AGENTS.md` 的 npm 檢查要求核對等效覆蓋。
- [ ] 執行 admin browser suite 與 base/current Durable comparison，保留 CI artifact 證據；確認暫存 checkout、Playwright webServer 及 Node.js `process.execPath` 行為沒有回歸。
- [ ] 建置 Linux arm64 的 final runtime，通過現有非 root、network-none 的所有 smoke checks，尤其真實 async curl I/O、codemode abort/close、SQLite、AnyDoc 及 Chromium；另外完成 CI 平台的 `runtime-application` checks，不將未驗證平台列為已支援。
- [x] 完整審查 diff 的 correctness、security、lifecycle、compatibility、regressions 及 scope；確認沒有 secrets、generated output、非預期 dependency 升級或削弱的 smoke checks。

## Evidence

- 已通過根目錄五項檢查：3,135 workspace tests 加上 28 script tests；一項本機 native test skipped，Linux arm64 image 內的真實 native smoke 已通過。
- 已確認 649 個套件 identity、integrity 與 requirements 未改變；78 種 Node.js engine ranges 與 npm semver 比對一致。
- Linux arm64 final runtime 與 uid 999 的 production closure 檢查通過；33 個 symlinks、九個 runtime workspace exports 均位於 `/app`。
- Changesets 在停用網路的 disposable checkout 通過 version 與 frozen recheck；registry resolutions 未改變，未執行 publish 或建立 tags。
- Linux browser suite 執行中。Linux amd64 本機 emulation 未通過 codemode VM-started assertion，保留原檢查與 timeout，等待 native CI 證據。
- Dependabot Bun 不支援自動 security-update PRs；現有 repository 的 security updates 與 vulnerability alerts 已停用，已記錄差異且未修改設定。

## Rollback / Recovery

- 本變更不包含資料格式遷移或 production 部署。
- 若 lockfile、native dependencies 或 release 相容性無法成立，保留失敗證據，將相關驗收維持未完成，不以取消安全檢查繼續。
- 回復時一併還原 manifests、原始 `package-lock.json`、scripts、CI、Dockerfile 與文件，避免混用兩種安裝流程。
- 以 disposable checkout 重新驗證原始 npm 安裝；不要清除使用者的工作目錄、runtime volumes 或 durable state。

## Completion Checklist

- [x] 第一階段未知項目皆有實測或上游支援證據，且沒有未處理的安全或相容性差異。
- [x] 本機、CI、Docker 固定同版本 Bun；唯一 lockfile 為 `bun.lock`，乾淨 frozen installs 可重現 dependencies。
- [x] scripts、env 範圍、Husky、Changesets version 與必要 Node.js tools 通過驗證，剩餘 npm 用途皆有明確理由。
- [ ] 根目錄五項檢查、focused regression tests、browser evidence 及指定 Docker checks 全部通過；任何 unavailable check 仍保持未完成。
- [ ] 將 intended changes 提交並推送至 `narumi/build/bun-package-manager`，建立 pull request，確認 native CI 證據、驗證摘要與風險說明完整。
- [x] 文件與 changeset 完成，完整 diff review 無未處理問題；交付僅包含遷移，不包含 package publish、tags 或 production rollout。
