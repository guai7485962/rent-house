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

## 現在狀態(2026-08-14)

- **與 `origin/main` 同步(`cdda5df`),已部署上線**(劇情弧多樣性第一階段);
  線上 bundle `assets/index-P2IM9tDx.js` 已驗到 `pastArcThemes`、`arcHistory`(8 處)與
  `seedId`,`/api/narrate` 回 403(同源守衛正常、worker 存活)。
  **worker 端的 prompt 與 provider 順序無法從外部檢視**,只能靠上線後實際生成觀察
- **這批做了什麼**:① 有進行中的弧時 narrate 改由 Gemini 優先(平日無弧無事件仍走免費
  Workers AI);② Workers AI 回的 `arcUpdate` 只准推進、不准開新弧也不准發 `growthTag`;
  ③ 新增 `TenantRuntime.arcHistory`(選填、上限 8)把演過的主題餵回 prompt 明令不得重複,
  並補主題類型清單 12 類、把「平淡日不要硬開」改成「久未連載優先開新弧」、maxStage 統一 2~6
- **最新驗證(全綠)**:`npm test` **103/103**(新增 `scripts/arc-variety-test.ts` 30 條)、
  app + worker typecheck 通過、`npm run build` 成功、balance 快照**零漂移**(未用 `--update`);
  無 `.vue` 變更故未跑 UI Lab
- **存檔版本**:`SAVE_VERSION = 10` 不變(`arcHistory` 是選填欄位,舊存檔載入補 `[]`)

## 🎉 咖啡廳經營玩法重設計 P1～P4b 全數完成並部署

設計文件:`docs/咖啡廳經營玩法-重設計.md`(含四階段成長曲線與實測回填)。
核心主張是**畫面上發生的事就是帳本上發生的事** —— 每一筆結帳都對應一位真的走進來的顧客。

| 玩家現在可以 | |
|---|---|
| 開張 $22,000 | 免費附贈吧台 ×1 + 桌 ×3 + 椅 ×6 |
| 看店員在吧台結帳 | 點餐泡泡顯示商品 + 價格,`+$XX` 浮字,顧客走去坐下 |
| 從**銷售排行**決定補什麼料 | 每列直接寫「要補 咖啡豆 · 每份 ×4,這 26 單共差 104 單位」 |
| 靠**排隊**判斷該不該雇人 | 不用讀數字,吧台前排長龍就是產能不足 |
| 一路長成主業 | 招牌 Lv1→Lv4、席次、員工;名店期全設備 **$1,358/日 = 淨租金 125%** |
| 也可能虧錢 | 備太多 −$23、備錯料 −$124、放著不管 −$346、過度擴張 −$254 |

其他已完成並部署:**店貓「辣椒」**(白底虎斑,全樓溜達,不送養、不佔寄養名額)、
**月度事件鏈 3 → 8 條**(資料已抽到 `src/content/floorChains.ts`,補文本不必動 sim)、
姓名池 20 → 72、應徵者帶寵物率 0.22 → 0.45、排太久放棄離開。

**底部版面(2026-08-09)**:咖啡廳營運面板的入口已**併進底部導覽的「💰 收支」**
(兩者是同一顆按鈕的兩個分頁,共用 `src/components/OpsTabs.vue`;在 1F 開啟時預選咖啡廳分頁);
空出的位置給樓層切換鈕 ⇒ 樓層頁只剩兩排按鈕(動作列四顆 + 底部導覽四顆)。
咖啡廳分頁的九個區塊改成**可收合**(預設只展開「營運觀察」與「常備量」,面板高度 4319 → 1800px),
**常備量每列加 −5／−1／+1／+5 快捷**(動草稿,仍要按「套用常備量」才寫存檔)。

**角色與敘事擴充(2026-08-09)**:職業 **15 → 24**(`sim/recruit.ts` 的 `ARCHETYPES`,一律 append)、
職業目標 **8 → 14**(`sim/wishes.ts`;新的六條各掛**不同的玩家槓桿**:收納+品味家具／隔音家具／
精力壓力／現金與欠租／整潔／鄰居關係)、劇情弧新增**本地種子目錄** 10 條
(`src/content/storyArcs.ts` + `src/sim/localArc.ts`)——在此之前弧只有 AI 生得出來,
**離線或免費額度用完就永遠沒有連載**;現在 AI 有額度時仍由 AI 主導,沒額度才由本地規則接手。
balance 快照因此重建:唯一漂移是本地弧的 mood/stress 脈衝(money 59921→59919、陳的錢包 +$2),
**新增職業與新增心願本身零漂移**(已隔離驗證)。

**送養合照(2026-08-10)**:🐾 面板「幸福新家」每筆送養紀錄都有一張**寵物 + 新飼主的像素合照**
(`src/floor/petPhoto.ts` + `src/components/PetPhoto.vue`)。照片**不進存檔**——每次開啟即時重畫,
存檔只多 `adopterName?`/`adopterAppearance?` 兩個選填欄位,缺的時候依紀錄 id 決定性推導,
所以舊紀錄打開也有照片。咖啡廳認養會留下那位顧客的真實外觀。

## 下一步

- **觀察第一階段的實際效果**:改的是 prompt 與模型分工,要跑幾個遊戲日、生成幾輪才看得出
  主題是否真的變多樣;若仍重複,再考慮把 `arcHistory` 的近義比對從 prompt 自律改成程式把關
- **劇情弧多樣性第二／三階段**(記憶標籤淘汰優先丟低 intensity、`[經歷:*]` 獨立額度;
  弧 stall 逾時、主線+支線並行、本地種子擴充)—— 會漂移 balance 快照,動工前先確認

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
