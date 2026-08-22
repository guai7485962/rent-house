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

## 現在狀態(2026-08-22)

- **與 `origin/main` 同步(`dd805bd`),三角關係(吃醋)系統已部署上線並完成 production 部署驗證**:
  bundle 由 `-DC6XAvpG` 換成 **`index-KAOr6hB_.js`**(728,470 bytes),線上逐項驗到玩家可見中文文案
  「暗戀落空」×1、「眼睜睜看著」×2(不會被最小化改名,是可靠佐證);`unrequitedSuitors` 命中 0
  是**識別字最小化改名**所致、非缺件,同 `scufflePushOffset` 等前例;回應 200、`no-store` 持續生效。
- **G/H 六批(`f141c77`～`9dc163e`)之前已逐批 push 並各自完成 production 部署驗證**(一次只推一批、
  線上確認才推下一批;08-18 回退的程式碼零改寫原樣重上,內容見下節「近期已部署基線」)
- 本機驗證(中控已核對):`npm test` **113/113**、typecheck(app+worker)、`build` 全綠、
  `balance-test` **零漂移未 `--update`**、`smoke:save` **49/0**;`SAVE_VERSION` 仍 10

## 近期已部署基線

- **G 批 互動目錄 18 → 28**:不稀釋的主池/次池抽籤(既有 18 種觸發率變 0.000%、零新 RNG)、租客雙人繪製
  管線(4 pose + 3 fx,`became_couple` 改告白演出)、日常/友誼 6 種 + 戀愛線 4 種(全 `pool:"extra"`、不進
  AI 白名單;🔴 安全靠 `tier` 的 `rel.romantic`——只可能經 `canBecomeCouple()` 建立,四種再一致掛 `both_adult`)
- **H 批 AI 日記卡死修復**:`narrateDay()` 45s 逾時 + `deferredRun` 8 分鐘 watchdog + 四個靜默退出改留標籤 + `safeNarrateCtx()` 降級 + `narrateStatus()` 唯讀診斷
- **I 批 白畫面根因修復**(`2689311`,與 G/H 六批的程式碼無關):部署刪舊雜湊資產 + iOS standalone 抓著快取的舊 `index.html` ⇒ 404;修法(`no-store` + 自救腳本)見 `docs/系統總覽.md` 地雷紀錄
- **F 批 打架看得見**(`c90f3ff`～`bdc6c8e`)門檻 50/22+`scuffle`演出+並肩走位;咖啡廳聚會／AI context／鍵
  消毒(`8296ed9`／`11a3d9a`／`04f65fe`);分區與常客(`f56ef3b`／`05cc2ea`)四區+跨日常客。⚠️ A 批唯一會咬存檔:雇 4 人以上且吧台仍贈品那座 ⇒ 產能 104→78
- **三角關係(吃醋)**:`unrequitedSuitors()` 零新持久化狀態即時推導,安全性繼承既有 `canRomance()`(與
  `canBecomeCouple`／`affairThird` 共用把關函式,`affairThird()` 同步重構);落選者一次性反應(固定文案
  +既有 heartbreak fx、零新 RNG)
- **更早**:咖啡廳 P1～P4b(逐客結帳、排隊/店員、庫存/研發/成長曲線、收支分頁與可收合面板)、店貓辣椒、
  月度事件鏈 3→8、姓名池 20→72、職業 15→24、職業目標 8→14、本地劇情種子 10→16 條支線、送養合照即時重畫

## 下一步

- 🔴 **實玩觀察(併成同一輪、跑十幾個遊戲日、用舊存檔開局)**,這輪四個觀察重點:
  ① **AI 當日觀察是否恢復**——在遊戲頁 Console 跑 `rentDebug.narrateStatus()` 讀 `lastExit.reason`:
  `timeout`／`upstream` ⇒ 問題在 worker 端、`quota` ⇒ 共用免費金鑰額度、`budget` ⇒ `DEFERRED_DAILY_BUDGET = 6`
  太低;② 新互動與雙人動作的實際觀感(`game_pair` 螢幕閃光、`confess` 告白彩紙、初吻);③ 打架門檻 50/22
  與並肩率 90.6% 的實玩手感;④ ⚠️ **舊存檔的老情侶會補演一次初吻,是已知行為不是 bug**(舊檔沒有「已接吻
  過」紀錄,見 `docs/設計檢討與優化.md` §10-2b)。同輪順帶看 A 批產能 nerf(104→78)、常客升格節奏、劇情弧
  多樣性、C 批聚會頻率(`CAFE_GATHER_CHANCE` 單一常數好調)、D 批會不會「蓋台」(降級開關是
  `lineHash("cafe-ctx|day") % N` 每日輪一位,單行改動、未做)
- 🔴 **三角關係實玩觀察重點**:① 落選者固定文案會不會顯得重複(刻意取捨,犧牲多樣性換零漂移,太單調
  可再開一批加變化但會使 balance 快照漂移、需另外審核);② AI 會不會自己從既有「與 X 曖昧」背景資料
  寫出單戀情節(AI context 本批未擴充);③ 只在「B 選定對象」那刻反應一次,無持續性吃醋(刻意限縮)
- 長線衝突項:壓力門檻改成相對各自基準線(`stress >= baselines(rt).stress - 10`),要先把 `baselines()`
  抽出共用模組解掉循環 import
- 其餘可選項(依 `docs/待辦.md`,🔴 項目一律先問使用者):牛奶／寵物鮮食建議常備量 24 對開張期菜單過高
  (跟著菜單走**會動到平衡**,未擅自動);第三層研發缺高價品項 ⇒ 名店期客單價卡在 ~$37
  (`CAFE_MAX_AVG_TICKET` 已放寬到 $55、菜單標價最高才 $42);認養卡下拉空白列(🟢 小,`CafePanel.vue`
  的空 `v-model`,租屋卡已修、做法見 `796643f`)

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
- **開發機互動式瀏覽器自動化不穩**(wmux browser / Chrome MCP 曾壞掉)——UI 驗證走 `ui:shot -- rent`
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
npm run smoke:save                    # 動到 src/ 或 worker/ 必跑(既有存檔啟動打包產物)
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
