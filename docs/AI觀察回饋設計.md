# AI 觀察回饋系統設計(2026-07-16)

> 需求:使用者認為「AI 當日觀察只是流水帳」,希望 AI 觀察/AI 事件能回饋到劇情——
> 調整房客數值、讓房客產生不同行為。本文件是設計提案,尚未實作。

## 一、問題診斷

目前 AI 每日回傳 `diary / newMemory / event / summaryUpdate / arcUpdate` 五樣,
真正會回饋到模擬的只有兩條窄路:

| 通道 | 回饋 | 限制 |
|---|---|---|
| `newMemory` | 記憶標籤 → memoryEffects 每日漂移 | 被動、量小、玩家無感 |
| `event` | 數值/指令/跨租客效果 | 要玩家拍板;冷卻 3 天;prompt 明令「平淡日填 null」 |
| `diary` | **無**(純文字) | — |
| `summaryUpdate` | **無**(只回餵 AI) | — |
| `arcUpdate` | **無**(純敘事骨架) | — |

→ 大多數日子 AI 輸出對遊戲零影響,觀感自然是流水帳。

## 二、設計原則(沿用專案硬規則)

1. AI 只能從**白名單**選,不能發明機制(比照 sanitizeDirective)。
2. 一切數值是 **delta 且嚴格夾值**(比照 cleanEffect)。
3. **不增加 API 呼叫**:全部搭在既有每日 narrate 的回應上,零額外成本。
4. **balance 快照不受影響**:AI 成功路徑不進 headless 測試的固定種子 RNG 序。
5. 錢、驅逐、正式戀愛轉變(couple/breakup)**仍只走玩家拍板的 event**;
   自動通道只碰情緒類數值與行為,守住「房東才有代理權」的邊界。

## 三、三層設計

### 第一層:每日情緒微調 statNudge——「日記寫什麼,人就受影響」

narrate 回應新增 `observation` 欄位:

```json
"observation": {
  "nudge": { "mood": -2, "stress": 3, "energy": 0, "wellbeing": 0, "affinity": 0 },
  "reason": "連兩天被搶洗衣機,悶氣還沒消"
}
```

- **夾值**:mood/stress/energy/wellbeing 各 ±3;affinity ±2(它進租金公式
  `(affinity-50)×0.3%`,量級對齊既有收租涓流 +0.6~1/日);
  **satisfaction 不開放**(衍生公式算出,直接改會被下一輪覆蓋)、**money 不開放**。
- **每租客每日一次**:掛在 `applyDiaryEffects()`,天然一篇一次。
- **因果可見**:reason 截 60 字,寫進日誌
  「🔮 觀察影響:連兩天被搶洗衣機,悶氣還沒消(心情 -2、壓力 +3)」。
- **prompt 指示**:nudge 代表「對今天素材的情緒解讀」,只在素材支持時才給;
  平淡日全 0。禁止逐日往同方向堆(素材去重已擋舊日報回灌)。
- **防失控**:homeostasis 每小時 6% 回歸性格基準 → nudge 是「推一把」不是永久位移。

### 第二層:自發行為 selfBehavior——「觀察讓房客行為看得見地改變」

現有 directive 白名單 6 種只能掛在事件選項、等玩家拍板。新增「自發行為」通道:
AI 可直接讓房客改變 1~2 天行為,**不需玩家同意**——設定上這是「房客自己的決定」,
房東本來就只是觀察者;玩家拍板保留給「房東的介入」。

規則(消毒層全擋):

- 復用 `TenantRuntime.directive` 槽位與白名單,`ActiveDirective` 加
  `source: "choice" | "ai"`(存檔 additive,`?? "choice"`)。
- days 夾 **1~2**(玩家拍板的維持 1~7)。
- 已有進行中 directive(不論來源)→ 直接丟棄,玩家拍板的永遠優先。
- 每租客冷卻 3 遊戲日:`TenantRuntime.lastSelfBehaviorDay`(存檔 `?? -99`)。
- 生效寫重要日誌:「🌀 因為昨晚的爭吵,他決定這兩天避開交誼廳」(AI 附 reason)。
- deferred 補寫路徑:若補寫成功時 `gameDayIndex() - 原日 > 1`,selfBehavior 丟棄
  (過時的行為反應不補套),statNudge 照套(遲到但一致)。

白名單擴充 4 個(全是既有 visualState/作息/props 的組合,照 hermit/social 模式接
`tick.applyHour`):

| id | 行為 | 接點 |
|---|---|---|
| `comfort_seek` 找摯友談心 | 休閒時段串門機率 15%→60%,優先挑關係最高的朋友 | 既有 `rollRoomVisit` |
| `overtime` 加班晚歸 | 工作時段 +2h、晚歸;stress/energy 走既有 EFFECT 表 | 作息位移(照 night_owl 模式) |
| `self_care` 好好照顧自己 | 提前 1h 睡、傍晚休閒改自房休息 | 作息位移 + 目標改寫 |
| `sulk` 悶悶不樂 | 休閒改自房發呆/追劇、不主動社交(只擋主動,被動拜訪仍接受,與 hermit 區隔) | 目標改寫 |

prompt 使用時機指引(附在白名單清單旁):吵架/冷戰翌日 → hermit 或 sulk;
失戀/挫折 → comfort_seek;連日高壓 → self_care 或 overtime(依性格);
熱戀/得意 → social。

### 第三層:劇情弧接上機制 arc tone——「連載不只是文字」

`arcUpdate` 加可選 `tone` 欄位,**enum 白名單** `"up" | "down" | "tense"`
(未知值忽略,退回純敘事,舊行為不變):

- **推進(advance)**:up = mood+3;down = mood−3;tense = stress+4。
- **收束(finish)**:up = mood+8、stress−6;down = mood−8;tense = stress−8(如釋重負);
  記憶標籤照既有邏輯留。

效果:一條「準備證照考試」的弧,推進期間壓力真的逐段上升,考過收束時整個人
明顯放鬆——玩家從數值曲線就能看到連載劇情,弧不再是裝飾。

## 四、防呆與平衡

- **雙重計算疑慮**:sim 已依活動算過數值,AI 再 nudge 會放大?→ 量級 ±3 遠小於
  單日活動總量;prompt 定位為「情緒解讀」;homeostasis 回歸兜底。
- **balance-test / sim-trace 不受影響**:headless 測試走 mock/模板,三層效果都只在
  `result.ai === true` 路徑套用,不消耗模擬 RNG、不進固定種子序;快照零漂移。
- **存檔**:全部 additive 欄位(`source ?? "choice"`、`lastSelfBehaviorDay ?? -99`、
  arc tone 可選),不升 SAVE_VERSION、不需遷移。
- **消毒單點**:新增 `sanitizeObservation()` 統一夾值+白名單,照 event 慣例
  「Worker 透傳、前端消毒」,兩端測試都涵蓋。

## 五、變更檔案地圖

- `src/sim/observationEffects.ts`(新):sanitizeObservation / applyObservation。
- `src/sim/directives.ts`:白名單 +4、`ActiveDirective.source`、self 消毒(days 1~2)。
- `src/sim/tick.ts`:4 個新 directive 的作息/目標分支;到期恢復沿用既有。
- `src/sim/narration.ts`:`applyDiaryEffects()` 接 observation;deferred 過期丟棄 selfBehavior。
- `src/sim/arcs.ts`:sanitizeArcUpdate 加 tone enum;applyArcUpdate 套脈衝。
- `worker/index.ts`:prompt 輸出格式 + observation 使用規則;parseResult 透傳。
- UI:日誌顯示 🔮 觀察影響行;房間細看 directive chip 標示「(自發)」。
- 測試:`observation-effects-test.ts`(新,加進 run-all REGRESSION)、
  `worker-test.ts` +(透傳/格式)、`directive-test.ts` +(source 優先權/冷卻)、
  `arc-test.ts` +(tone 脈衝/未知 tone 忽略)。

## 六、分期建議

1. **第一期(小)**:statNudge + 🔮 日誌——最小改動,立刻讓日記「有感」。
2. **第二期(中)**:selfBehavior + 白名單擴充 4 種——行為看得見地改變。
3. **第三期(小)**:arc tone——連載劇情接上數值曲線。

三期互相獨立、可分批上線;每期照慣例:全套測試 → build → 工作日誌同 commit →
push → PowerShell 驗證部署。
