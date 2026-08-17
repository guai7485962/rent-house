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

## 現在狀態(2026-08-17)

- **F 批「打架看得見、門檻可達」已 commit 未 push**(兩個 commit)。步驟 1 先補量測:
  `scripts/conflict-freq-sim.ts`(分析腳本,**不列入 `run-all.ts`**)跑 60 遊戲日 × 4 人高摩擦滿房 ×
  三種壓力基準,舊門檻下 **打架 0 場**,漏斗 873→535(rel)→198(tension)→198(comp)→**0**(雙方 stress≥80)
  ⇒ 瓶頸 100% 在壓力門檻(壓力平衡點恆落在基準下方約 20 點,`baselines()` 上界 90,
  且 ≥90 會被 `isDeviation` 趕回房間 ⇒ [80,90) 窗口實質為零)
- **步驟 2／3**:門檻改成 `FIGHT_STRESS_SUM = 62` + `FIGHT_STRESS_EACH = 28`(中控拍板,其餘門檻與擲骰
  次數／順序一位元未動);演出 `pose: "hidden"` → 新的 `scuffle`(側面 sprite 面對面 + 既有 500ms frame
  做交替 ±1px 推擠,沿用既有 fight fx,**零新美術、非血腥**,三處註解 + 掃碼測試把關)。
  `npm test` **109/109**、typecheck、build 全綠、`balance-test` **零漂移**(未 `--update`);`SAVE_VERSION` 仍 10
- ⚠️ **62/28 只救得到高壓住戶**:改完後實跑 normal **0 場**／stressed **17 場**／extreme 22 場
  (自我抑制有效:同一對最短間隔 3 遊戲日,口角由 108 降到 78)。同法量到 55/24 → normal 1／stressed 14。
  **要不要再往下調待拍板**,連同另外三條新待辦見 `docs/待辦.md`
- **與 `origin/main` 同步(`04f65fe`)為止,C／D／E 三批已部署上線**:`git push origin main` 走 `32ee1b1..04f65fe`,production 回 **200**,
  線上 bundle 由 `index-CAWvNf_T.js` 換成 **`index-BGI7KZTp.js`**(**711,650 bytes**);ASCII 標記 `cafe_afterhours` ×2、
  `cafe_weekend_night` ×2、`regularCandidateDays` ×7、`regulars` ×32,CJK 標記(下載位元組再 UTF8 解碼 grep)`DAILY_CAFE_TEMPLATES` 三句各 ×1。
  ⚠️ **D 批的 worker 端(SYSTEM 兩條新規則、`clampCafeCtx()`)不可外部檢視**(`/api/narrate` 有同源守衛),靠 `worker-test.ts` 斷言擋著
- **C／D／E 三批(已部署)**:打烊後的租客聚會(獨立池 `CAFE_COMMUNITY_EVENTS`,不動 lounge／rooftop 機率)、
  讓 AI 看見咖啡廳(唯讀 `NarrateCtx.cafe`、**新增零個寫入面**、消毒三層、硬不變式「熟客名字 ∩ 租客名字 = ∅」)、
  常客候選人的鍵也消毒。三批 `npm test` 108/108、typecheck、build 全綠,`balance-test` 零漂移

## 近期已部署基線

- **咖啡廳聚會／AI context／鍵消毒**(`8296ed9`／`11a3d9a`／`04f65fe`):§4.12 + §4.13 + 安全小修
- **咖啡廳分區與常客**(`f56ef3b`／`05cc2ea`):四區機能差異(§4.10)+ 跨日常客(§4.11)。⚠️ A 批是唯一會咬既有存檔的改動(已核可):雇 4 人以上且吧台仍是贈品那座 ⇒ 產能 104→78
- **咖啡廳 P1～P4b**:逐客結帳、排隊/店員、庫存/研發/成長曲線、收支分頁與可收合面板均上線
- **內容**:店貓辣椒、月度事件鏈 3→8、姓名池 20→72、職業 15→24、職業目標 8→14
- **敘事**:本地劇情種子 10→16 條支線,可和 AI 主線並行;**送養合照** `PetPhoto.vue` 即時決定性重畫,不存圖片資料

## 下一步

- **打架門檻要不要從 62/28 再往下調(待拍板)**:現值只讓高壓住戶打得起來,一般住戶 60 遊戲日 0 場。
  實測替代值 55/24 → normal 1／stressed 14。更好的長解是改成相對各自基準線
  (`stress >= baselines(rt).stress - 10`),但要先把 `baselines()` 抽出共用模組解掉循環 import
- **實玩觀察(全部併成同一輪,跑十幾個遊戲日)**:用**舊存檔**開局(雇 4 人以上且吧台仍是開張贈品那座 ⇒
  會吃到 A 批的產能 nerf 104→78,確認「加寬吧台」提示夠明顯);同一輪看常客升格節奏、劇情弧多樣性、
  C 批聚會頻率(`CAFE_GATHER_CHANCE` 是單一常數好調),以及 **D 批會不會「蓋台」**——四位租客拿到同一份
  咖啡廳背景,若 AI 天天寫它,降級開關是 `lineHash("cafe-ctx|day") % N` 每日輪一位(單行改動,未做)

其餘可選項(依 `docs/待辦.md`):

- **牛奶／寵物鮮食的建議常備量**:開張期菜單根本用不到,建議值卻是 24 ⇒ 新手一開始就在買用不到的生鮮;
  要讓建議值跟著菜單走**會動到平衡**,未擅自動
- **第三層研發的高價品項**:`CAFE_MAX_AVG_TICKET` 已放寬到 $55,但菜單標價最高才 $42 ⇒ 餘裕沒被用掉,
  名店期客單價停在 ~$37,補高價品項才吃得到(純內容工作)
- **認養卡下拉的空白列**(🟢 小):`CafePanel.vue` 認養卡仍用空的 `v-model`,一旦有可認養寵物就會顯示
  空白列(租屋卡已修,做法見 `796643f`);其餘見 `docs/待辦.md`,🔴 項目一律先問使用者

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
