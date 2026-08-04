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

- **咖啡廳經營玩法重設計 P1 → P2 → P3 → P4a 都完成。P1/P2/P3 已提交(HEAD `e28b6cd`),
  P4a 變更待提交。**
- **P4a(成長軸模擬層:招牌分級 + 員工/產能 + 客單價上限)** —— 只做模擬層,
  畫面(`staffAgents`)與人力面板留給 P4b:
  - **招牌 Lv1 → Lv4**:`cafeUpgrades.ts` **追加**兩個 id(`cafe_signboard_lv3` $60,000、
    `cafe_signboard_lv4` $110,000),**既有五項的 id、順序與價格一格未動** ⇒
    舊存檔零影響、不需要升 `SAVE_VERSION`。`CafeUpgrade.requires` 讓招牌必須逐級升。
  - 🔴 **產能公式換掉**:`CAFE_BASE_CAPACITY 26 + 14/台` → **`min(外帶底量 10 + 席次 × 5,
    員工數 × 每人 35 杯)`**。席次來自 P2 的 `cafeSeatSpots()`(玩家真的擺的椅子),
    第二台咖啡機改成加**每位員工** +10 杯。⇒ 只買椅子或只雇人都夾得住。
  - **員工**:`CafeState.extraStaff`(**額外**雇用數,不含開張費已含的首位店員),
    純函式 `hireCafeStaff()` / `fireCafeStaff()` / `cafeStaffWage()` 在 `cafe.ts`;
    薪資 $260/人/日 由 `cafeDailyPass()` 緊接固定開銷後扣(一天一次、淡季照付、離線一致)。
  - **客單價**:`CAFE_MAX_AVG_TICKET` $38 → **$55**(硬上限防呆保留),`avgTicket()`
    改成「目前菜單標價的平均」而不是手調里程碑表。⚠️ **餘裕目前是空的**——
    現行菜單標價平均就是 $38,要等第三層研發才用得到(詳見下方實測)。
  - 改動檔:`sim/cafe.ts`、`content/cafeUpgrades.ts`、`types.ts`、`sim/gameState.ts`、
    `sim/tick.ts` + 新測試 `scripts/cafe-p4a-growth-test.ts`(40 條)
    + 新實測腳本 `scripts/cafe-growth-sim.ts` + 六支既有咖啡廳測試跟著改語意。
    **未動 `CafePanel.vue`、`src/floor/*`、`sim/routine.ts`、`sim/persistence.ts`。**
- **§4.7 四階段成長曲線實測(`npx tsx scripts/cafe-growth-sim.ts`,28 天暖身 + 112 天量測)**:
  開張期 **+$166**(15%)/ 成長期 **+$501**(46%)/ 成熟期 **+$887**(82%)/
  名店期 **+$1,092**(**101%**);人力調到剛好夠用的 +3 人是 **+$1,256**(116%)、
  再買齊五項投資是 **+$1,543**(142%)。百分比對的是設計靶 $1,083/日(四房滿租淨租金)。
  **過度擴張**(成長期客流卻雇 4 人)**−$279** ⇒ 第五條虧損管道成立。
  ⚠️ 客單價停在 ~$37(設計表要 $53),因為菜單標價本身沒漲;名店期因此是 101% 而非 150%。
- **P3(進貨時機 + 損耗調校 + 銷售排行 + 一鍵建議常備量)**:
  - 🔴 **進貨從日結搬到開店前 09:00**(`tick.ts` 的 `cafeRestockPass`)。玩家**先付錢、後賺錢**,
    「備了料卻沒客人」與「沒備料所以賣不出去」兩個方向都變成真的損失。
    一天只扣一次靠 `CafeSalesDay.restocked` 旗標(**進存檔**,比照 P1 的 `settled`)⇒
    離線補進度、重讀存檔、同小時重入都不會重扣。
  - **損耗調校**:`SPOILAGE_FREE_UNITS` 15 → **23**、`SPOILAGE_RATE` 0.1 → **0.9**。
    因為日結看到的已經是「打烊後真正剩下的庫存」,才調得動而不誤傷懶人路線
    (建議常備量 24 ≤ 收斂上界 24 ⇒ **零損耗是數學保證**)。
  - **`CafePanel.vue` 新增「銷售排行」區塊**(過去 7 日各品項賣出杯數 + 紅色缺貨徽章)
    與「**依上週銷量建議**」按鈕(`ceil(7 日單日尖峰 × 1.15)`,無歷史時 fallback)。
  - 改動檔:`sim/tick.ts`、`sim/cafe.ts`、`types.ts`、`sim/gameState.ts`、
    `components/CafePanel.vue`、`scripts/cafe-opening-sim.ts` + 新測試
    `scripts/cafe-p3-economy-test.ts` + 三支既有咖啡廳測試跟著改語意。
    **未動 `src/floor/*`、未動 `sim/routine.ts`、未改五項投資與研發 id。**
- **最新驗證(全綠)**:`npm test` **92/92**、app + worker typecheck 通過、`npm run build` 成功、
  balance 快照**零漂移**(未用 `--update`)。UI 未動 ⇒ P4a 未重跑 `ui:shot`
  (最後一次是 P3 的 18 張 0 error + `artifacts/ui-lab/rent/cafe-p3-panel/` 6 張面板實拍)。
- **存檔版本**:`SAVE_VERSION = 10`(`src/sim/persistence.ts:28`)。P3 在 `cafe.sales[]`
  加了兩個選填欄位(`restocked` / `restockCost`)、P4a 加了 `cafe.extraStaff`,
  `sanitizeCafeState` 都有預設值與夾值 ⇒ **兩次都不需要升版**
  (慣例同 floorChain 的選填欄位)。舊檔讀進來 `extraStaff` 一律是 0。
- **§4.7 實測(P3 後,`npx tsx scripts/cafe-opening-sim.ts`,112 遊戲日、人氣固定)**:
  ① 補貨精準 **+$99** / ② 缺貨(只砍咖啡豆)**+$2** / ③ 備貨過量 **−$35** / ④ 放著不管 **−$346** /
  ⑤ 備錯料(咖啡豆 30% + 其餘多備 50%)**−$132**。
  ⇒ ③「備太多反而虧」已成立(P1 是 +$59);② 仍接近損益兩平是**結構性**的
  (常備訂單是「補到水位」,少備料等於少付錢),真正會痛的形狀是 ⑤。詳見重設計文件 §4.7。

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

- **提交 P4a**,然後 **P4b**:員工與產能的**畫面表現**(見重設計文件 §4.9)——
  `src/floor/staffAgents.ts`(吧台後的店員、結帳動作、**排隊 = 產能不足的視覺信號**)
  + `CafePanel.vue` 的「人力」區塊(👤 ×N・日薪合計、今日負荷進度條、雇用/資遣按鈕)。
  模擬層已經齊備:`cafeCapability(upgrades, { seats, extraStaff })` 直接給得出
  `capacity / seatCapacity / staffCapacity / staffCount / dailyWage`,
  雇用/資遣走 `hireCafeStaff()` / `fireCafeStaff()` 純函式。
  🔴 **`CafePanel.vue:307` 的「產能 N 單」目前讀的是沒帶席次的 `cafeCapability()`**
  (回的是「只有首位店員」的 35 杯),P4b 要把真實席次接進去。
- **使用者要拍板(P4a 新增)**:P4a 把開張期的產能天花板從 26 打開到 35 之後,
  §4.7 的「備太多反而虧」從 P3 的 −$35 回到 **+$74**(精準備貨 +$195,差距仍有 $121)。
  損耗旋鈕**已經頂到極限**(`(24 − 23) × 0.9 < 1` 是懶人路線零損耗的唯一解,`RATE` 不能 > 1),
  ⇒ 要不要為了維持「開張期只賺 $98」而回頭調(提高 `CAFE_FIXED_COST`、或降低氛圍加成上限),
  **P4a 刻意不擅自決定**,理由寫在重設計文件 §4.7 的 P4a 實測表下方。
- **使用者要拍板(承 P3)**:② 只砍一種原料仍接近損益兩平是**結構性**的
  (常備訂單是「補到水位」,少備料等於少付錢),真正會痛的形狀是 ⑤「備錯料」。
  要讓缺貨本身倒賠得改常備訂單語意,那會連帶打死懶人路線 ⇒ **未擅自動**
- 🔴 **客單價的餘裕還沒被用掉**:`CAFE_MAX_AVG_TICKET` 已放寬到 $55,但菜單標價
  平均仍是 $38 ⇒ 成長曲線的名店期只到淨租金的 101%(設計值 150%)。
  要補上這一段,得把**第三層研發**(季節限定豆、造型拿鐵、下午茶套餐)
  加進 `src/content/cafeResearch.ts`,那是 P4a 範圍外的新工作項
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
| 咖啡廳怎麼設計的 | `docs/一樓寵物咖啡廳-設計.md`(第一版)/ `docs/咖啡廳經營玩法-重設計.md`(**現行**,P1/P2/P3 已完成) |
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
