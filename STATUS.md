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

## 現在狀態(2026-08-28)

- 🔴 **咖啡廳建議層 bug 修復(未 push)**:`cafeBottleneck()` 判定末行寫
  `cap.idleStaff > 0 ? "stations" : "staff"`,而 `idleStaff = staffCount − min(staffCount, stations)`
  ⇒ **剛好站滿**(`staffCount === stations`,成熟期典型的 **3 店員 / 3 服務位**)時 `idleStaff` 恆為 **0**
  ⇒ 掉進 `staff`,面板叫玩家「到『人力』雇一位(−$260／日)就多 26 單」。**這句是假的**:新人站不上
  吧台(`activeStaff` 仍是 `stations`),產能一單不動,實測 Δ **−$260/日**;要等玩家已經浪費過錢
  (`idleStaff` 變 1)遊戲才改口。已有玩家回報「咖啡廳好幾天不賺錢」。
- **改法**:條件改成 `staffCount >= stations`(`stations === null` = 沒餵吧台幾何才退回 `staff`);
  `cafeBottleneckAdvice()` 的 `stations` 分支加 `idleStaff === 0` 變體(講明**先加寬吧台才雇得下人**,
  舊變體逐字未動);`cafe-bottleneck-test.ts` 加 7 條回歸鎖(1/1~6/6 都必須是 `stations`、
  `staff` ⇔ 吧台真有空位、文案連「雇」字都不得出現)。地雷紀錄已收錄(`docs/系統總覽.md` §四)。
- **純建議層、零平衡影響**:已確認 `cafeBottleneck()` 只餵 `CafePanel.vue` 顯示與 `cafeInvestOutlook()`
  的 `demand`/`seats`/`both` 文案分支,**不進任何產能／客流／金流計算**;一個數字都沒動。
- 驗證:`npm test` **116/116**(`cafe-bottleneck` 103 → **111**)、typecheck、build、`smoke:save` 全綠;
  `balance-test` **零漂移、未 `--update`**;無 `.vue`,`SAVE_VERSION` **不動**。

## 近期已部署基線

- **規則事件復活(`7d09071`,已 push = 目前 `origin/main`,線上已驗證)**:病根是「所有懲罰都是脈衝而
  四條數值全有回歸 ⇒ 脈衝被抹平」。`maintenance.ts` 新增 `neglectPoints()` 0~6(零新存檔欄位),掛上
  **倍率完全不同**的四條管道(🔴 絕不可共用常數);冷卻 2 → **4 日**。四則 `0/0.016/0/0.673` →
  **`0.40/0.53/0.26/0.35`**、續集全部 0 → 都 > 0;`balance-test` 已 `--update`。⚠️ `dissatisfied` 0.264 仍
  低於規格(與 AI 機會日**結構性互斥**,見設計文件附錄 §5)。

- **咖啡廳互動密度(`a3e9647`,已 push)**:聚會 `need` 3→2、`CAFE_SIT_WINDOW_DAYS`、補掉三條把 `at_cafe` 傳送回樓上的路徑;實測同框率種子局 **0% → 25%**、4 人局 **≈0% → 50%**。
- **顧客互卡修復(08-26)**:根因是 `detourGrid()` 把移動中的人排除在障礙外,而卡死的人 `moving` 恆為 true;四層修法後門檻掃描 100 格 **44 格卡死 → 0**。
- **可見性批次(08-25)/ 分區規則進 UI(08-23)**:`cafe.ts` 五支純函式 + 投資文案用**差分**再呼叫一次真公式 ⇒ 不可能漂開(設計文件 §9);三個 UI 落點共讀 `cafeZoneGuide.ts`。
- **G 批 互動目錄 18 → 28 / H 批 AI 日記卡死修復**:主/次池抽籤(零新 RNG);戀愛線安全靠 `tier` 的 `rel.romantic` + `both_adult`;`narrateDay()` 45s 逾時 + `deferredRun` 8 分鐘 watchdog
- **I 批 白畫面根因修復**(`2689311`):部署刪舊雜湊資產 + iOS 抓著舊 `index.html` ⇒ 404(修法見地雷紀錄)。**F 批 打架看得見**(門檻 50/22 + `scuffle` 演出)、三角關係(吃醋)、咖啡廳 P1～P4b、店貓辣椒、月度事件鏈 3→8、姓名池 20→72、職業 15→24

## 下一步

- 🔴 **規則事件實玩驗收(用舊存檔)**:① 讓一間房的故障**故意拖 3~6 個遊戲日**,確認滿意度/壓力/
  健康/好感四條真的一起惡化、且 Feed 看得出因果;② 修好之後確認**立刻停止**惡化(可逆);
  ③ 四則事件的文案在真的觸發時讀起來對不對;④ 事件冷卻拉到 4 日後,AI 事件是否明顯變多。
- 🔴 **咖啡廳建議層實玩驗收**:把店擺成 **3 店員 / 3 服務位**,確認 TODAY 卡那句改講「吧台寬度」
  且**不再叫玩家雇人**;再擺一座點餐吧台之後應改回「人手」。
- 🔴 **咖啡廳互動密度實玩驗收**:開新局→開張→快轉到第 11 遊戲日,確認 ① 租客下樓坐 **14:00**、
  ② 同框日兩人真的同時在一樓、③ 那一小時 sprite **沒被拉回樓上**、④ 不再疊格。嫌吵就調
  `CAFE_SIT_GAP_DAYS`(**勿動 WINDOW**)。
- 🔴 **實玩觀察**:① 日記／雙人弧是否全程為房東第三人稱;② 房東抉擇是否都可由房東執行;
  ③ Console 跑 `rentDebug.narrateStatus()`;④ 第三層研發**成熟期仍只有 71%**,缺口在產能與客流。
- 長線衝突項:壓力門檻改成相對各自基準線,要先把 `baselines()` 抽出共用模組解掉循環 import。
  其餘可選項見 `docs/待辦.md`(🔴 一律先問使用者)。

## 待使用者決策(不要自行動工)

- **`dissatisfied` 頻率要不要再拉高** — 真正該解的是「規則事件與 AI 事件共用 `lastEventDay`」,
  不是調係數;拆成兩個冷卻槽會改變事件節奏,**需要先拍板**(現況與兩個端點的實測見設計文件附錄 §5)
- **「租客撿到寵物」要不要再補規則事件**(已**部分解決**,優先度低):`stray_litter` 已給了一條
  不靠 AI 的領養路徑;再加規則事件會改變 `rollEvent()` 比對序 ⇒ 可能要重建基準。
- **AI context 快取 C-9** — 只剩 worker 端快取;免費層 + 有模板 fallback,是否值得做
  **待使用者決定是否直接結案**(`docs/待辦.md` 第一節)
- **家具 tier 第三階段**(沙發/電視/浴缸/書桌的恢復乘數)— 種子局這些活動全踩 premium 家具,
  一接就整片改變 balance 快照,**必須跑 `balance-test --update` 重建基準**
- **跨裝置雲端存檔 / 共享世界互訪 / 玩家自帶 Gemini key**(都需要帳號 + DB)

## 已知阻塞 / 環境限制

- `.ui-lab/compose.yaml` 的 **NBA 8000 埠映射被註解**(Windows 保留埠吃掉 8000)——**屬工作區根的
  別的 lease,不可覆蓋**;rent 的截圖流程不受影響
- **開發機互動式瀏覽器自動化不穩**(wmux browser / Chrome MCP 曾壞掉)——UI 驗證走 `ui:shot -- rent`
- **Bash 的 curl 在此機沙盒無網路**——部署驗證改用 PowerShell `Invoke-WebRequest`;中文字串要取
  bytes 再 UTF8 解碼才搜得到(`-match`／`Contains` 對 CJK 會假陰性)
- **遊戲的「一天」綁瀏覽器本地時區**(設計基準 UTC+8)——跑測試需 `TZ=Asia/Taipei`
- 所有玩家共用同一把 Gemini 免費 key;`/api/*` 尚未設 Cloudflare Dashboard rate limit

## 文件地圖(以下都不需要預先讀,按需查閱)

| 我想知道… | 讀這個 |
|---|---|
| 現在做到哪、下一步是什麼 | **本檔**(唯一必讀) |
| 有什麼待辦 / 技術債 / 驗收錨點 | `docs/待辦.md` — 待辦的**唯一權威清單**,每條 `- [ ]` 都帶可 grep 的 🔍 錨點 |
| 這個 repo 已經有什麼系統、程式碼從哪進 | `docs/系統總覽.md` — 已完成系統(A～U)、**地雷紀錄**、檔案地圖 |
| 怎麼跑測試 / 部署 / 驗證 | `工作日誌.md` 第一節「如何執行 / 驗證」 |
| 最近幾天／更早發生什麼事 | `工作日誌.md` 第二節(08-01 起)/ `docs/工作日誌-封存.md`(07-12～07-31)— **grep 查,別通讀** |
| 咖啡廳怎麼設計的 | `docs/一樓寵物咖啡廳-設計.md`(第一版)/ `docs/咖啡廳經營玩法-重設計.md`(**現行**;§9 可見性、§10 第三層研發) |
| 規則事件為什麼曾經全部死掉 | `docs/設計檢討與優化.md` **附錄 2026-08-28**(虧待度管道、四條數值的倍率表、量測腳本的坑) |
| 某個 CAFE-xx 工作項要做什麼 | `docs/一樓寵物咖啡廳-工作分解.md` — 22 個工作項的規格與驗收 |
| AI 觀察回饋機制怎麼設計的 | `docs/AI觀察回饋設計.md` |
| 協作規則、硬規則、提交前檢查 | `CLAUDE.md`(Claude Code)/ `AGENTS.md`(Codex)— 內容相同 |

## 常用指令

```powershell
npm test; npm run typecheck; npm run build
npx tsx scripts/balance-test.ts       # 刻意改平衡才審核後加 --update
npm run smoke:save                    # 動到 src/ 或 worker/ 必跑(既有存檔啟動打包產物)
npx tsx scripts/event-freq-sim.ts     # 規則事件觸發頻率實測(只印數字、不入回歸集;約 12 分鐘)
npx tsx scripts/cafe-growth-sim.ts    # 咖啡廳四階段成長曲線的量測(只印數字、不入回歸集)
# UI 改動另從 workspace 根跑 npm run ui:shot -- rent，並檢查 PNG/report.json
```

---

## 本檔的維護規則

1. **每個會改動受 Git 追蹤檔案的 commit,都要同步更新本檔的「現在狀態」與「下一步」**,
   且與程式碼放在**同一個 commit**。
2. 本檔是**導航**,不是內容。嚴禁在此放:完整待辦清單、技術債細節、逐日紀錄、系統設計說明。
3. 目標長度 **≤120 行**。超過就是有內容跑錯地方了,搬回對應檔案。
4. 「待使用者決策」與「已知阻塞」兩節只在狀態真的改變時動;決策拍板後把該條刪掉,
   並在 `docs/待辦.md` 留下結論。
