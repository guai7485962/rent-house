# 《房東監視中》— 現況入口

> 🧭 **新 session 只需要讀這一份。** 其餘文件按下方「文件地圖」**按需查閱**,
> 一律不需要預先通讀(尤其 `工作日誌.md` 與 `docs/工作日誌-封存.md`,那是考古用檔案)。

一款「異步掛機觀察型」直式手機模擬遊戲:玩家是房東,透過俯視娃娃屋觀察租客生活、
佈置家具、招租收租;劇情由 **AI(Gemini)依歷史即時生成**,並能影響走向。
一樓是**寵物咖啡廳**(經營 + 認養),租客住三樓。

- **遊戲網址(手機可玩)**:https://rent-house.guai7485962.workers.dev
- **Repo**:github.com/guai7485962/rent-house(push 到 `main` → Cloudflare 自動 build + deploy)
- **架構**:靜態前端(Vue 3 + Vite + TS)+ Cloudflare Worker(同時服務網站與 `/api/narrate`、`/api/invite`);
  AI 金鑰存 Worker Secret `GEMINI_API_KEY`。沒金鑰/離線/超額時自動 fallback 成模板,遊戲照跑。

---

## 現在狀態(2026-08-16)

- **領先 `origin/main` 兩個未 push 的 commit(C 批 §4.12、D 批 §4.13)**
- **D 批:讓 AI 看見咖啡廳(§4.13,安全敏感)**。`NarrateCtx` 新增唯讀 `cafe?:`
  (`brief` / `trend` / `regulars` ≤2 / `ops` / `pets`),送給**全體在住租客**;素材由 `cafe.ts`
  §17 四支新純函式算出(零新狀態、零亂數、仍不 import `placements`)。**新增零個寫入面**:
  `NarrateResult` 不動、`applyDiaryEffects()` 一行未改、AI 輸出 schema 不新增 key,四項都有
  原始碼掃描斷言。順手補掉一條**既有注入路徑**:`cafe.regulars[].name` 原本只檢查非空,
  現收緊成 NFKC + 字元白名單 + 夾 12 字(`CAFE_REGULAR_NAME_MAX`)
- **消毒三層 + 一條硬不變式**:新的 `sanitizeContextLine()`(`narrativeQuality.ts`,**app 與
  worker 共用同一份**)去換行、去 `[ ] 【 】`;worker 端 `clampCafeCtx()` 再夾一次(理由具體:
  `pendingDiaries[].ctx` 載入時不消毒就原封 POST)。新不變式「**熟客名字 ∩ 租客名字 = ∅**」
  ⇒ `applyRelNudge` 的「名字出現在 todayLog」永遠無法被 `ctx.cafe` 滿足。`clampStr` 不去換行
  是**全域既有缺口**,已另立 `docs/待辦.md` 一條(未擴及既有欄位,避免改動既有 prompt 內容)
- **平衡未動**:快照局永遠不開張 ⇒ `ctx.cafe` 全程 `undefined` ⇒ `templateDiary()` 的 pool
  長度不變、抽樣序列位元相同(有明文測試)。`npm test` **108/108**(新增
  `cafe-narrate-ctx-test.ts` 60 項)、typecheck、build、`balance-test` **零漂移**(未 `--update`);
  本批不動 `.vue` ⇒ 未跑 UI Lab。`SAVE_VERSION` 仍 10(姓名消毒是收緊,載入時冪等,不需 migration)
- **C 批(§4.12)**:CAFE-21 的 `cafe` 場地做好了卻**零呼叫者**,補了內容端 —— `community.ts`
  獨立池 `CAFE_COMMUNITY_EVENTS`(平日 `cafe_afterhours` / 週末 `cafe_weekend_night`,
  **都在打烊後 21:00**,此時顧客與店員 agent 已清場,不會與人龍搶格);咖啡廳事件**不進**
  `COMMUNITY_EVENTS`,只在「當天沒有其他社群事件」時補抽(`rollCafeGathering()` 機率 0.3)
  ⇒ lounge／rooftop 的絕對與相對機率完全不變
- **與 `origin/main` 同步(`05cc2ea`)**:咖啡廳 A 批(地板分區機能差異)與 B 批(常客系統)已
  push 並部署,production 回 **200**;線上 bundle 由 `index-sSFUhi4o.js` 換成 `index-CAWvNf_T.js`
  (703,605 字元,前一版 685,536),逐項驗到 `regularCandidateDays` ×7、`regularCandidates` ×7、
  `regulars` ×27、`cafe_back` ×7、`cafe_counter` ×15,`sideArc` ×21 不變(劇情弧改動未被波及)
- **A 批(§4.10)**:家具擺對區才有機能效果(後場→庫存容量、寵物區→停留與認養、吧台區→同時
  服務人數),擺錯區只剩氛圍。**⚠️ 唯一會咬既有存檔的改動**(已核可):雇 4 人以上且吧台仍是
  贈品那座 ⇒ 產能 104→78,面板提示「加寬吧台」
- **B 批(§4.11)**:6 位顧客變成跨日認得出來的人,**身分鍵是姓名**、3 個來訪日升格、每營業小時
  18% 抽籤回訪(**不乘客流** ⇒ 開張期與名店期都約 2 位/日);效果為老樣子、好感 ≥60 留 $3 小費、
  好感 ≥80 帶朋友(該小時 `abandonCount −1`,不多生客人)。姓名池 32→64(append-only)
- **界線未破**:`cafeAmbiancePoints()` 一行未改(客流乘數零漂移)、`cafe.ts` 仍不 import
  `placements`;常客不進 `runtimes`/`relationships`、不參與戀愛線(`cafe-regular-test.ts` 有掃碼斷言)
- **本機驗證(全綠)**:`npm test` **106/106**、typecheck、build、`balance-test` **零漂移**(未
  `--update`)、`ui:shot -- rent` 18 張 0 error;`SAVE_VERSION` 仍 10,B 批三欄位 additive、舊檔補空值

## 近期已部署基線

- **咖啡廳分區與常客**(`f56ef3b`／`05cc2ea`):四區機能差異(§4.10)+ 跨日常客(§4.11)已上線
- **咖啡廳 P1～P4b**:逐客結帳、排隊/店員、庫存/研發/成長曲線、收支分頁與可收合面板均上線；
  詳見 `docs/咖啡廳經營玩法-重設計.md`
- **內容**:店貓辣椒、月度事件鏈 3→8、姓名池 20→72、職業 15→24、職業目標 8→14
- **敘事**:本地劇情種子原 10 條，本批擴為 16 條支線並可和 AI 主線並行
- **送養合照**:`PetPhoto.vue` 即時決定性重畫，不存圖片資料；舊紀錄也相容

## 下一步

- **實玩觀察(三件事併成同一輪,跑十幾個遊戲日)**:拿一份**舊存檔**開局——雇 4 人以上且吧台仍是
  開張贈品那座的檔會吃到 A 批的產能 nerf(104→78),先確認面板的「加寬吧台」提示夠明顯、玩家
  看得懂怎麼補救,而不是只覺得營收莫名變差;同一輪順著看常客升格節奏(姓名池已擴到 64,預估
  3~4 個遊戲週填滿 6 個名額),第一位是否約第 4~5 天出現、回訪不太密也不太疏、好感不亂掉;劇情
  面則確認 AI 主線與本地支線並行、5 日 stall 收束不突兀、16 條種子輪替自然(仍重複再改程式把關);
  同一輪順便看 C 批的打烊後聚會頻率(估每 8~10 個遊戲日一場)是稀疏得剛好還是太少,
  以及 **D 批會不會蓋台**——四位租客都拿到咖啡廳背景,若 AI 天天寫它,降級開關是
  改成 `lineHash("cafe-ctx|day") % N` 每日輪一位(單行改動,本批刻意未做)

其餘可選項(依 `docs/待辦.md`):

- **牛奶／寵物鮮食的建議常備量**:開張期菜單根本用不到它們,建議值卻是 24 ⇒ 新手一開始
  就在買用不到的生鮮。要讓建議值跟著菜單走**會動到平衡**,未擅自動
- **第三層研發的高價品項**:`CAFE_MAX_AVG_TICKET` 已放寬到 $55,但菜單標價最高才 $42 ⇒
  餘裕沒被用掉,名店期客單價停在 ~$37。補高價品項才吃得到(純內容工作)
- **認養卡下拉的空白列**(🟢 小):`CafePanel.vue` 認養卡仍用空的 `v-model`,
  一旦有可認養寵物就會顯示空白列(租屋卡已修,做法見 `796643f`)
- 其餘見 `docs/待辦.md`;🔴 項目一律先問使用者

## 待使用者決策(不要自行動工)

- **「租客撿到寵物」要不要再補規則事件**(已**部分解決**,優先度低):`adopt_cat` 原本只由
  AI 生成事件的選項帶進來,`data/events.json` 一則都沒提供 ⇒ 離線/模板 fallback 時永不發生。
  月度事件鏈 `stray_litter`(後巷的一窩小貓)已給了一條**完全不靠 AI** 的領養路徑。
  還要不要另外加規則事件?那會改變 `rollEvent()` 的比對序 ⇒ 可能要 `--update` 重建基準。
- **AI context 快取 C-9** — 裁剪那半早已實作,只剩 worker 端快取;免費層 + 有模板 fallback,
  是否值得做**待使用者決定是否直接結案**(`docs/待辦.md` 第一節)
- **家具 tier 第三階段**(沙發/電視/浴缸/書桌的恢復乘數)— 種子局這些活動全踩 premium 家具,
  一接就整片改變 balance 快照,**必須跑 `balance-test --update` 重建基準**
- **咖啡廳掛機節奏是否加回主動性**(已**實質回應**:分區要決定家具擺哪一區、常客給了跨日可追的對象;是否結案待拍板)
- **跨裝置雲端存檔 / 共享世界互訪 / 玩家自帶 Gemini key**(都需要帳號 + DB)

## 已知阻塞 / 環境限制

- `.ui-lab/compose.yaml` 的 **NBA 8000 埠映射被註解**(Windows 保留埠 7912-8011 吃掉 8000)——
  **屬工作區根的別的 lease,不可覆蓋**;rent 的截圖流程不受影響
- **開發機互動式瀏覽器自動化不穩**(wmux browser / Chrome MCP 曾壞掉)——
  UI 驗證一律走 `npm run ui:shot -- rent` 無頭截圖
- **Bash 的 curl 在此機沙盒無網路**——部署驗證改用 PowerShell `Invoke-WebRequest`;
  中文字串要取 bytes 再 UTF8 解碼才搜得到(`-match`／`Contains` 對 CJK 會假陰性)
- **遊戲的「一天」綁瀏覽器本地時區**(設計基準 UTC+8)——跑測試需 `TZ=Asia/Taipei`
- 所有玩家共用同一把 Gemini 免費 key;`/api/*` 尚未設 Cloudflare Dashboard rate limit

## 文件地圖(以下都不需要預先讀,按需查閱)

| 我想知道… | 讀這個 |
|---|---|
| 現在做到哪、下一步是什麼 | **本檔**(唯一必讀) |
| 有什麼待辦 / 技術債 / 驗收錨點 | `docs/待辦.md` — 待辦的**唯一權威清單**,每條 `- [ ]` 都帶可 grep 的 🔍 錨點 |
| 這個 repo 已經有什麼系統、程式碼從哪進 | `docs/系統總覽.md` — 已完成系統(A～U)、**地雷紀錄**、檔案地圖 |
| 怎麼跑測試 / 部署 / 驗證 | `工作日誌.md` 第一節「如何執行 / 驗證」 |
| 最近幾天發生什麼事 | `工作日誌.md` 第二節(2026-08-01 起的逐日紀錄) |
| 更早以前發生什麼事 | `docs/工作日誌-封存.md`(2026-07-12～07-31)— **用 grep 查日期,不要通讀** |
| 咖啡廳怎麼設計的 | `docs/一樓寵物咖啡廳-設計.md`(第一版)/ `docs/咖啡廳經營玩法-重設計.md`(**現行**,P1/P2/P3 已完成) |
| 某個 CAFE-xx 工作項要做什麼 | `docs/一樓寵物咖啡廳-工作分解.md` — 22 個工作項的規格與驗收 |
| 原始設計檢討與各節完成度 | `docs/設計檢討與優化.md` |
| AI 觀察回饋機制怎麼設計的 | `docs/AI觀察回饋設計.md` |
| 協作規則、硬規則、提交前檢查 | `CLAUDE.md`(Claude Code)/ `AGENTS.md`(Codex)— 內容相同 |

## 常用指令

```powershell
npm test; npm run typecheck; npm run build
npx tsx scripts/balance-test.ts       # 刻意改平衡才審核後加 --update
# UI 改動另從 workspace 根跑 npm run ui:shot -- rent，並檢查 PNG/report.json
```

---

## 本檔的維護規則

1. **每個會改動受 Git 追蹤檔案的 commit,都要同步更新本檔的「現在狀態」與「下一步」**,
   且與程式碼放在**同一個 commit**。
2. 本檔是**導航**,不是內容。嚴禁在此放:完整待辦清單、技術債細節、逐日紀錄、系統設計說明。
   那些各有歸屬檔案(見文件地圖),本檔只放指標。
3. 目標長度 **≤120 行**。超過就是有內容跑錯地方了,搬回對應檔案。
4. 「待使用者決策」與「已知阻塞」兩節只在狀態真的改變時動;決策拍板後把該條刪掉,
   並在 `docs/待辦.md` 留下結論。
