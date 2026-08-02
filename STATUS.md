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

## 現在狀態(2026-08-02)

- **與 `origin/main` 同步,無未 push 的 commit,工作樹乾淨**
- **最新驗證(全綠)**:`npm test` **83/83**(新增 `cafe-rent-intent-test.ts` 26 條)、
  app + worker typecheck 通過、`npm run build` 成功、balance 快照**零漂移**(未用 `--update`)
- **存檔版本**:`SAVE_VERSION = 6`(`src/sim/persistence.ts:28`;改存檔結構從 `MIGRATIONS[6]` 往上加)
  ——CAFE-19 只在 `Applicant` 加兩個選填欄位,不需要升版
- **已上線**:一樓寵物咖啡廳 **CAFE-01～18B + CAFE-22 全部已部署至 production**
  (含研發線:CAFE-16 研發倒數、CAFE-17 菜單與客單價上限 $38、CAFE-18 研發面板、
  CAFE-18B 背景結算),以及積怨自然口角、房間隔音折抵噪音口角、每日衝突額度收斂
- **CAFE-19 租屋意圖 → 招租**:模擬層已完成並進 repo(`acceptCafeGuestApplicant()`,`recruit.ts:385`,
  26 條測試),但 ⚠️ **UI 未接線,因此被 Rollup tree-shake,production bundle 裡沒有這段程式碼**
  ——線上行為與部署前完全相同。**接線(顧客氣泡 → 選房 → 呼叫入口 → 成功後移除顧客)才會真的上線**

## 下一步

**CAFE-20 `at_cafe` visualState**(⚠️ 必須設 `CAFE_FIRST_DAY` 閘門,否則 balance 快照會漂移)
或 **CAFE-21 `groupScene` cafe venue**(文件註明優先讓 Codex 認養)。
規格與驗收條件見 `docs/一樓寵物咖啡廳-工作分解.md` 對應條目;
CAFE-19 的 UI 接線(顧客氣泡 → 選房 → 呼叫入口)可另開一條小工作項。

咖啡廳只剩這兩項未開始:CAFE-20、CAFE-21(其餘 CAFE-01～19、CAFE-22 皆已完成)。

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
| 咖啡廳怎麼設計的 | `docs/一樓寵物咖啡廳-設計.md` |
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
