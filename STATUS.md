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

## 現在狀態(2026-08-04)

- **咖啡廳經營玩法重設計 P1(逐位顧客結帳)已完成,變更待提交**。營收不再是換日時
  `客流 × 平均客單價` 一條公式,改成**每個營業小時逐位顧客照配方點餐、扣料、結帳**
  (`tick.ts` 的 `cafeHourlyPass`);缺料就 $0 + 聲譽 −2 + 當場推日誌。
  改動檔:`sim/cafe.ts`、`content/cafeIngredients.ts`、`sim/tick.ts`、`types.ts`、
  `sim/gameState.ts`、`sim/persistence.ts` + 新測試 `scripts/cafe-per-guest-test.ts`
  + 實測腳本 `scripts/cafe-opening-sim.ts`;**未動任何 `.vue` 與 `src/floor/*`**(那是 P2/P3)
- **最新驗證(全綠)**:`npm test` **89/89**、app + worker typecheck 通過、`npm run build` 成功、
  balance 快照**零漂移**(未用 `--update`)
- **存檔版本**:`SAVE_VERSION = 9`(`src/sim/persistence.ts:28`;改存檔結構從 `MIGRATIONS[9]` 往上加)
  ——v9 新增 `cafe.sales`(逐日逐品項銷售紀錄,cap 14 天,給 P3 的銷售排行用);
  舊檔的 `standingOrders` / `stock` 原封保留(原料 id 一個都沒變)

## 🎉 一樓寵物咖啡廳 CAFE-01～22 全數完成並部署

玩家現在可以:花 **$22,000** 開張(免費附贈吧台 ×1 + 桌 ×3 + 椅 ×6)→ 設常備訂單自動補貨 →
每日結算客流營收 → 買五項永久投資 → 研發 10 項新品 → 接受顧客認養寵物 / 租屋詢問;
樓寵物與租客都會下樓。逐項規格與「未竟事項」見 `docs/一樓寵物咖啡廳-工作分解.md`。

**2026-08-03 實玩回報四修**(細節見 `工作日誌.md` 同日條目):
`.toast` 的 `z-index` 50 → **200**(面板 overlay 是 100～140,**先前任何面板開著時 toast 都看不到**,
是全 app 的 bug)、開張免費送整套家具、新增**氛圍加成**(一樓家具 `cozy + style` → 客流乘數,
上限 +20%)、開張費 **$12,000 → $22,000**(堵掉「開張後拆光賣掉穩賺 $7,700」的套利)。

**2026-08-03 家具商店分場地**:`FurnitureDef.venue`(選填,未標 = 租屋)把 12 件咖啡廳家具
從 8 個類別裡拆出來,商店改成「🏠 租屋樓層 49 / ☕ 咖啡廳 12」兩個分頁,在 1F 開商店預設
咖啡廳頁。**分類判準是顯式欄位不是 `cafe_` 前綴**(`espresso_machine` 就是反例)。

## 下一步

- **咖啡廳重設計 P2**(見 `docs/咖啡廳經營玩法-重設計.md` §六):開店/關店節奏 +
  顧客動線(店門 → 吧台 → 真的椅子)+ 點餐演出。⚠️ P2 與 P4b 共用 `guestAgents` 動線地基,
  P2 要把骨架一次做完。P1 已經把「錢」接好,P2 是把「畫面」接上去
- **使用者要拍板**:P1 實測顯示「缺貨」與「備貨過量」的痛感都比設計值弱
  (缺貨在 P1 是「賺不到」而非「倒賠」;備貨過量仍淨賺 +$59)。
  原因與可能的加碼方式已寫在重設計文件 §4.7 的實測表下方,**未擅自調參數**
- 🔴 **`PixelDollhouse` 在受限視窗高度下被壓成 2px**(本批截圖時發現,**與本批無關**,
  已用未改動的 baseline build 驗過是既有問題):`main` 是 `display:flex; flex-direction:column`
  且高度確定,`.pixel-room` 的 canvas 是 `height:auto` 的取代元素 ⇒ min-content 算 0
  → 被 flex-shrink 壓成只剩 2px 邊框,手機上等於**看不到房間細看的像素畫面**。
  修法:`.pixel-room { flex-shrink: 0 }` 或給 `min-height`。要動 `App.vue`,本批無 lease
- **認養卡下拉的空白列 bug**(🟢 小):`CafePanel.vue` 認養卡仍用空的 `v-model`,
  一旦有可認養寵物就會顯示空白列(租屋卡已修,做法見 `796643f`)
- 其餘見 `docs/待辦.md`;🔴 項目一律先問使用者

## 待使用者決策(不要自行動工)

- **AI context 快取 C-9** — 裁剪那半早已實作,只剩 worker 端快取;免費層 + 有模板 fallback,
  是否值得做**待使用者決定是否直接結案**(`docs/待辦.md` 第一節)
- **家具 tier 第三階段**(沙發/電視/浴缸/書桌的恢復乘數)— 種子局這些活動全踩 premium 家具,
  一接就整片改變 balance 快照,**必須跑 `balance-test --update` 重建基準**
- **咖啡廳掛機節奏是否加回主動性**
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
| 咖啡廳怎麼設計的 | `docs/一樓寵物咖啡廳-設計.md`(第一版)/ `docs/咖啡廳經營玩法-重設計.md`(**現行**,P1 已完成) |
| 某個 CAFE-xx 工作項要做什麼 | `docs/一樓寵物咖啡廳-工作分解.md` — 22 個工作項的規格與驗收 |
| 原始設計檢討與各節完成度 | `docs/設計檢討與優化.md` |
| AI 觀察回饋機制怎麼設計的 | `docs/AI觀察回饋設計.md` |
| 協作規則、硬規則、提交前檢查 | `CLAUDE.md`(Claude Code)/ `AGENTS.md`(Codex)— 內容相同 |

## 常用指令

```powershell
$env:Path = "C:\Program Files\nodejs;$env:Path"   # PowerShell 每個 session 要先補
cd C:\Users\User\claude_try\rent_house

npm test                              # 正式回歸集 + sim-trace(需 UTC+8 / TZ=Asia/Taipei)
npm run typecheck                     # app(vue-tsc)+ worker
npm run build                         # vite build,產出 dist/
npx tsx scripts/balance-test.ts       # 固定種子 10 天快照 diff
npx tsx scripts/balance-test.ts --update   # 只在「刻意的平衡改動」時用,並在日誌說明原因
```

```powershell
# UI 驗證(從工作區根 C:\Users\User\claude_try 執行,三種手機寬度無頭截圖)
npm run ui:shot -- rent
# 完成前必須檢查 artifacts/ui-lab/rent/ 內所有 PNG 與 report.json
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
