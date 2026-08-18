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

## 現在狀態(2026-08-18)

- 🔴 **H 批(AI 敘事韌性)完成,已 commit 未 push** —— 修使用者回報的「當日觀察都沒有 AI 說明、
  狀態都是掛機補進度」。真因是升級管線**無聲卡死**:`narrateDay()` 的 fetch **沒有逾時**,只要一次
  不回來 ⇒ `deferredRun` 永不 settle ⇒ 之後每次 `resumeDeferredDiaries()` 都在第一行 return,
  一路卡到重新整理。修法:① fetch 加 `AbortController` + **45 秒**逾時(`narrateTiming.timeoutMs`),
  `finally` 保證清計時器、promise 一定 settle;② `deferredRun` 掛超過 **8 分鐘**判定卡死、放生重來
  (token 防兩輪同時跑);③ 四個原本**靜默 break** 的提早退出各自把原因寫進佇列最前面那篇 ⇒ 新增
  標籤 `timeout`／`busy`／`hidden`／`budget`／`internal`(既有標籤字面全未動;兩個 Feed 元件的
  對照表由測試釘住必須一致);④ `produceDiaryFor()` 全段 try/catch + `safeNarrateCtx()` 降級,
  `buildNarrateCtx` 的 `GROWTH_TAGS[id]` 改安全查表 —— 舊檔的未知 id 會丟 TypeError **炸穿
  `hourlyTick()`**,讓它後面的收租/額度重置/心願/樓層鏈/`save()` 全部不執行(`tick.ts` 的
  `diaryPass` 呼叫點與 `DIRECTIVES[id]` 一併補防禦);⑤ 新增唯讀診斷 `rentDebug.narrateStatus()`
- ⚠️ **「掛機補進度」不是錯誤標籤**,是 `live===false` 的離線補算。`SCALE=7` ⇒ 離開 >17 分鐘回來
  就是離線補算 ⇒ 真實玩家幾乎抽不到即時 AI 日記,**AI 敘事全靠事後升級**。本批**未動**
  `SCALE`／`live` 門檻／`DEFERRED_DAILY_BUDGET`(先讓它可見,要不要調另議);worker 端刻意未動
- **G 批(互動目錄 18 → 28)+ G-5 安全一致性全部完成,已 commit 未 push**:主池/次池零稀釋抽籤
  (主池非空時逐位元相同、**零新 `Math.random()`**)、雙人繪製管線與 `confess`／`kiss`／`cheers`
  pose、日常友誼 6 種 + 戀愛線 4 種。🔴 戀愛線四種是全年齡看得見、**絕不可標 `adult: true`**,
  安全靠 `tier`(`rel.romantic` 只經 `canBecomeCouple()` ⇒ 成年 + 取向雙檢)+ 各掛成年雙檢當雙保險;
  AI 白名單維持 12 個,戀愛線不進。零稀釋實證見 `scripts/interaction-freq-sim.ts`(core +1.2%)
- ⚠️ **已知行為(中控已接受)**:`first_kiss` 冷卻 ≈ 一遊戲年 ⇒ 舊存檔的老情侶載入後會補演一次初吻
- `npm test` **112/112**、typecheck／build 全綠、**balance 零漂移(未 `--update`)**;`SAVE_VERSION` 仍 10
- **F 批「打架看得見」已部署上線**(`c90f3ff`～`bdc6c8e`):門檻 50/22、`hidden`→`scuffle`(非血腥),
  並肩率 69.8% → 90.6%。⚠️ `scufflePushOffset` 在 bundle 中被最小化改名 ⇒ 掃碼命中 **0 是預期的**

## 近期已部署基線

- **咖啡廳**:聚會／AI context／鍵消毒(`8296ed9`／`11a3d9a`／`04f65fe`,§4.12+§4.13)、分區與常客(`f56ef3b`／`05cc2ea`,§4.10+§4.11)、P1～P4b(逐客結帳、排隊/店員、庫存/研發/成長曲線、收支分頁與可收合面板)全部上線。⚠️ A 批是唯一會咬既有存檔的改動(已核可):雇 4 人以上且吧台仍是贈品那座 ⇒ 產能 104→78
- **內容**:店貓辣椒、月度事件鏈 3→8、姓名池 20→72、職業 15→24、職業目標 8→14、本地劇情種子 10→16;**送養合照** `PetPhoto.vue` 即時決定性重畫,不存圖片資料

## 下一步

- 🔴 **H 批可驗收:push + deploy(由中控處理)**,連同 G 批共 6 個 commit 未 push、未部署
- 🔴 **部署後請使用者實測根因**:在遊戲頁 console 打 `rentDebug.narrateStatus()`,看 `lastExit.reason`
  與 `deferredRunStale`。chip 長期停在 `AI 回應逾時`／`AI 暫時無回應` ⇒ 嫌疑轉向 worker 端
  (D 批 worker 半邊,本批刻意未動);停在 `免費額度已滿` ⇒ 共用 key 被打爆
- **實玩觀察(併成同一輪,跑十幾個遊戲日)**:看 **F 批打架**觀感與 **G 批新互動**頻率;用**舊存檔**
  開局(吃到 A 批產能 nerf 104→78);同一輪看常客升格節奏、劇情弧多樣性、C 批聚會頻率,以及
  **D 批會不會「蓋台」**(降級開關 `lineHash("cafe-ctx|day") % N` 每日輪一位,單行改動未做)
- 長線衝突項:壓力門檻改成相對各自基準線,要先把 `baselines()` 抽出共用模組解掉循環 import

其餘可選項(依 `docs/待辦.md`,🔴 項目一律先問使用者):**牛奶/寵物鮮食建議常備量**(開張期用不到卻
建議 24,跟著菜單走**會動到平衡**);**第三層研發高價品項**(`CAFE_MAX_AVG_TICKET` 已放寬到 $55、菜單
最高才 $42 ⇒ 名店期客單價停在 ~$37);**認養卡下拉空白列**(🟢 小,`CafePanel.vue` 仍用空 `v-model`)

## 待使用者決策(不要自行動工)

- **「租客撿到寵物」要不要再補規則事件**(已**部分解決**,優先度低):`adopt_cat` 只由 AI 事件選項
  帶進來、`data/events.json` 一則都沒有 ⇒ 離線/模板 fallback 時永不發生;月度事件鏈 `stray_litter`
  已給了一條**完全不靠 AI** 的領養路徑。再加規則事件會改變 `rollEvent()` 比對序 ⇒ 可能要重建基準。
- **AI context 快取 C-9** — 裁剪那半早已實作,只剩 worker 端快取;免費層 + 有模板 fallback,
  是否值得做**待使用者決定是否直接結案**(`docs/待辦.md` 第一節)
- **家具 tier 第三階段**(沙發/電視/浴缸/書桌的恢復乘數)— 種子局這些活動全踩 premium 家具,
  一接就整片改變 balance 快照,**必須跑 `balance-test --update` 重建基準**
- **咖啡廳掛機節奏是否加回主動性**(已**實質回應**:分區要決定家具擺哪一區、常客給了跨日可追的對象;是否結案待拍板)
- **跨裝置雲端存檔 / 共享世界互訪 / 玩家自帶 Gemini key**(都需要帳號 + DB)

## 已知阻塞 / 環境限制

- `.ui-lab/compose.yaml` 的 **NBA 8000 埠映射被註解**(Windows 保留埠 7912-8011 吃掉 8000)——
  **屬工作區根的別的 lease,不可覆蓋**;rent 的截圖流程不受影響
- **開發機互動式瀏覽器自動化不穩**(wmux browser / Chrome MCP 曾壞掉)——UI 驗證一律走
  `npm run ui:shot -- rent` 無頭截圖。**Bash 的 curl 在此機沙盒無網路**,部署驗證改用 PowerShell
  `Invoke-WebRequest`;中文字串要取 bytes 再 UTF8 解碼才搜得到(`-match`／`Contains` 對 CJK 假陰性)
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
