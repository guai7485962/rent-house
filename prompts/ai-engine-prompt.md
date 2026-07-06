# AI 敘事引擎 — 系統提示詞範本與後端呼叫規格

本文件定義後端如何把遊戲狀態 JSON 丟給 Claude API,穩定產出符合
`AIEventResponse`(見 `src/types.ts`)的連鎖觀察日誌。

架構分三層,對應 Claude API 的 prompt caching 結構:

| 層 | 內容 | 變動頻率 | 放置位置 |
|---|---|---|---|
| A. 世界觀與規則 | 遊戲設定、寫作風格、硬性規則 | 幾乎不變 | `system`(掛 cache_control) |
| B. 輸出格式 | JSON Schema | 幾乎不變 | `output_config.format`(API 強制) |
| C. 當前狀態 | 租客 JSON、房間 JSON、上次抉擇 | 每次呼叫都變 | `messages` 的 user turn |

> **關鍵原則:格式正確性不靠 prompt 拜託,靠 API 的 structured output 強制。**
> System prompt 只負責「內容品質」;`output_config.format` 的 JSON Schema
> 保證回傳 100% 可解析,後端不需要寫任何 JSON 修復邏輯。

---

## A. System Prompt(靜態,可快取)

```text
你是《房東監視中》的敘事引擎。這是一款直式手機放置觀察遊戲:玩家是房東,
透過「切面娃娃屋」偷偷觀察租客的生活,每隔幾小時閱讀一批「監視觀察日誌」,
偶爾對突發事件做出房東抉擇。

## 你的職責
根據使用者訊息提供的〈租客狀態〉〈房間狀態〉〈經過時數〉〈房東近期抉擇〉,
生成這段時間內發生的事,包括:觀察日誌、租客最終視覺狀態、數值增量、
記憶標籤變更、(偶爾)一個突發抉擇事件,以及更新後的劇情摘要。

## 寫作風格
- 繁體中文。視角是「監視器旁白」:冷靜、略帶幽默、第三人稱,
  像自然紀錄片旁白在觀察一種叫「租客」的生物。
- 每條日誌 30~80 字。寫「看得到的行為」,不寫內心獨白
  (內心狀態透過行為外顯:壓力大→踱步、亂買東西、對貓說話)。
- 日誌之間要有因果連鎖:前一條的事件影響後一條
  (例:貓打翻水杯 → 鍵盤壞掉 → 深夜衝出門買鍵盤)。

## 行為推導規則(最重要)
1. 租客行為 = 核心標籤 × 記憶標籤 × 房間環境 三者交集。
   每條日誌都必須能對應到至少一個標籤的 behaviorHint。
2. 只能使用〈房間狀態〉中列出家具的 unlockInteractions,
   且該互動的 requiredTagIds 必須與租客現有標籤匹配,才能生成對應劇情。
   沒有的家具、未解鎖的互動,一律不准出現。
3. visualState 與 roomProps 只能從允許清單中選,禁止自創:
   - visualState: idle, sleeping_on_bed, sleeping_on_couch, working_at_desk,
     gaming, streaming, eating, cooking, playing_with_cat, crying, pacing,
     away, showering, cleaning, talking_on_phone
   - roomProps: cat_on_table, cat_sleeping_on_couch, cat_hiding,
     delivery_boxes_piled, trash_overflow, laundry_piled, lights_off,
     curtains_closed, mic_setup_active, screen_glow
4. 日誌的 time 必須落在〈起始時間〉到〈結束時間〉之間、按時間遞增,
   且符合租客作息標籤(夜貓子不會早上八點在煮飯)。

## 數值與標籤紀律
- statDeltas 每項限 -20 ~ +20。日常批次通常在 ±8 以內,
  只有 major 事件才接近上限。
- memoryTagChanges 保守使用:大多數批次 add 和 remove 都是空的。
  只有發生了「一週後回看仍然重要」的事才加標籤。
  新標籤的 behaviorHint 必須寫「未來會如何影響行為」,不是描述已發生的事。
- 移除標籤的時機:狀態自然結束(加班期結束、失戀走出來)
  或被新標籤取代(瀕臨崩潰 → 已崩潰過釋放了)。

## 突發抉擇事件 (pendingEvent)
- 大多數批次應為 null。只在劇情自然累積到臨界點時觸發
  (參考:壓力 > 85、標籤衝突、房東上次抉擇的後果發酵)。
- 事件必須「需要房東才能決定」:漲租、修繕、投訴、發現違規(如偷養寵物)、
  租客主動請求。租客自己能解決的事不構成抉擇事件。
- 提供 2~3 個選項。hint 寫模糊的方向暗示,不寫具體數值後果。

## updatedSummary
用 50~150 字重寫「近期摘要」:保留仍在發酵的伏筆,丟掉已了結的小事,
納入本批次的新發展。這是你下次生成時唯一的記憶,寫給未來的自己看。
```

---

## B. 輸出 JSON Schema(掛在 `output_config.format`)

```json
{
  "type": "json_schema",
  "schema": {
    "type": "object",
    "properties": {
      "logs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "time": { "type": "string" },
            "text": { "type": "string" },
            "visualState": { "type": "string", "enum": ["idle","sleeping_on_bed","sleeping_on_couch","working_at_desk","gaming","streaming","eating","cooking","playing_with_cat","crying","pacing","away","showering","cleaning","talking_on_phone"] },
            "importance": { "type": "string", "enum": ["minor","notable","major"] }
          },
          "required": ["time","text","visualState","importance"],
          "additionalProperties": false
        }
      },
      "finalVisualState": { "type": "string", "enum": ["idle","sleeping_on_bed","sleeping_on_couch","working_at_desk","gaming","streaming","eating","cooking","playing_with_cat","crying","pacing","away","showering","cleaning","talking_on_phone"] },
      "roomProps": {
        "type": "array",
        "items": { "type": "string", "enum": ["cat_on_table","cat_sleeping_on_couch","cat_hiding","delivery_boxes_piled","trash_overflow","laundry_piled","lights_off","curtains_closed","mic_setup_active","screen_glow"] }
      },
      "statDeltas": {
        "type": "object",
        "properties": {
          "mood": { "type": "integer" },
          "stress": { "type": "integer" },
          "affinity": { "type": "integer" },
          "cleanliness": { "type": "integer" }
        },
        "required": [],
        "additionalProperties": false
      },
      "memoryTagChanges": {
        "type": "object",
        "properties": {
          "add": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": { "type": "string" },
                "label": { "type": "string" },
                "behaviorHint": { "type": "string" }
              },
              "required": ["id","label","behaviorHint"],
              "additionalProperties": false
            }
          },
          "remove": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["add","remove"],
        "additionalProperties": false
      },
      "pendingEvent": {
        "anyOf": [
          { "type": "null" },
          {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "title": { "type": "string" },
              "description": { "type": "string" },
              "choices": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": { "type": "string" },
                    "label": { "type": "string" },
                    "hint": { "type": "string" }
                  },
                  "required": ["id","label","hint"],
                  "additionalProperties": false
                }
              }
            },
            "required": ["id","title","description","choices"],
            "additionalProperties": false
          }
        ]
      },
      "updatedSummary": { "type": "string" }
    },
    "required": ["logs","finalVisualState","roomProps","statDeltas","memoryTagChanges","pendingEvent","updatedSummary"],
    "additionalProperties": false
  }
}
```

> 注意:JSON Schema 不支援 `minimum`/`maximum`/`minLength` 等數值約束,
> 所以「delta 限 ±20」「日誌 3~6 條」寫在 system prompt,並由後端在
> 套用前 clamp(見下方後端守則)。

---

## C. User Message 範本(動態,每次呼叫組裝)

```text
請為以下租客生成從〈起始時間〉到〈結束時間〉的觀察內容。

〈經過時數〉{{ELAPSED_HOURS}} 小時(起始 {{START_TIME}},結束 {{END_TIME}})

〈租客狀態〉
{{TENANT_JSON}}

〈房間狀態〉(含每件家具的 attributes 與 unlockInteractions)
{{ROOM_JSON_WITH_FURNITURE}}

〈房東近期抉擇〉(若無則寫 "無")
{{RECENT_DECISION_JSON}}

〈本批次指示〉
- 生成 {{LOG_COUNT_HINT}} 條日誌(建議:每 2 小時約 1 條,睡眠時段可跳過)
- pendingEvent 生成傾向:{{EVENT_BIAS}}   ← 後端控制節奏:"必須為 null" / "自然判斷" / "傾向觸發"
```

`{{TENANT_JSON}}` 直接序列化 `Tenant` 物件;`{{ROOM_JSON_WITH_FURNITURE}}`
是 `RoomState` 加上展開的家具資料(只帶「該租客標籤已解鎖」的
unlockInteractions,在後端先過濾,雙保險)。

**`EVENT_BIAS` 是遊戲節奏的關鍵開關**:抉擇事件的頻率應由後端的節奏系統
決定(例:每天最多 1 次、玩家剛做完抉擇後冷卻 6 小時),不要全交給 AI 的
自然判斷,否則事件密度會不穩定。

---

## D. 後端呼叫範例(TypeScript)

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { AIEventResponse, Tenant } from "../src/types";
import { SYSTEM_PROMPT, AI_EVENT_RESPONSE_SCHEMA } from "./promptAssets";

const client = new Anthropic(); // API key 只存在後端環境變數

// 模型策略:
//  - 預設 claude-opus-4-8:劇情品質最好,適合 major 事件與抉擇後果生成
//  - 日常掛機批次可切 claude-haiku-4-5 壓成本(數值在 config 開關,先用
//    opus 驗證品質基準,再 A/B 測 haiku 是否夠用)
const MODEL = "claude-opus-4-8";

export async function generateTenantEvents(
  tenant: Tenant,
  roomJson: object,
  elapsedHours: number,
  startTime: string,
  endTime: string,
  recentDecision: object | null,
  eventBias: "必須為 null" | "自然判斷" | "傾向觸發",
): Promise<AIEventResponse> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    // 層 A:靜態 system prompt,掛 cache_control。
    // 所有租客、所有玩家共用同一份前綴 → 快取命中率極高。
    // ⚠️ system prompt 內不可插入任何動態內容(時間戳、玩家 ID),
    //    否則快取全滅。
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    // 層 B:JSON Schema 強制輸出格式
    output_config: {
      format: AI_EVENT_RESPONSE_SCHEMA,
    },
    // 層 C:動態狀態
    messages: [
      {
        role: "user",
        content: buildUserMessage(
          tenant, roomJson, elapsedHours, startTime, endTime,
          recentDecision, eventBias,
        ),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("AI 回傳中沒有文字區塊");
  }
  const parsed = JSON.parse(text.text) as AIEventResponse;
  return sanitize(parsed); // ↓ 後端守則
}
```

### 後端守則(sanitize):不信任任何一個數字

Schema 保證了「形狀」,但語意約束要後端把關:

1. **clamp 所有 delta 到 ±20**,套用後 stats 再 clamp 到 0~100。
2. **驗證 `time` 遞增且在時間窗內**,超出的日誌直接丟棄。
3. **memoryTagChanges.remove 的 id 必須存在**於租客現有標籤,否則忽略。
4. **pendingEvent 頻率上限**由後端節奏系統把關(即使 AI 生成了事件,
   冷卻中就丟棄並把 eventBias 設為 "必須為 null" 重試或直接去掉)。
5. `updatedSummary` 長度超過 300 字就截斷(防摘要膨脹吃掉 token)。

### Prompt Caching 注意事項

- Opus 4.8 的最小可快取前綴是 **4096 tokens**。目前的 system prompt
  約 1500~2000 tokens,**低於門檻時不會快取**(不報錯,只是沒省到錢)。
  解法:把 15 種 visualState 的詳細描寫、寫作風格範例集擴充進
  system prompt,湊過 4096 同時也提升生成品質——一舉兩得。
- 驗證方式:檢查 `response.usage.cache_read_input_tokens` 是否 > 0。
- 5 分鐘 TTL 對「整點批次生成所有租客」的工作模式剛好:第一個租客付
  cache 寫入費,同批其餘租客全部吃快取(注意:併發請求要先發一個、
  等它開始回傳後再發其餘的,否則大家都 miss)。

---

## E. 完整範例:陳家豪的一個生成批次

**輸入**(user message 的實質內容):
- 租客:`data/tenants.json` 的 `tenant_chen_engineer`
- 房間:cleanliness 35,家具 = 頂級電競桌 + 療癒系雙人沙發,
  activeProps = `["delivery_boxes_piled", "screen_glow"]`
- 經過:22:00 → 04:00(6 小時),房東近期抉擇:無
- EVENT_BIAS:自然判斷

**期望輸出**(符合 schema 的實例):

```json
{
  "logs": [
    {
      "time": "22:47",
      "text": "目標回巢,比昨天早了四小時。進門沒開大燈,直接癱進沙發。橘貓 Bug 從紙箱堆後方現身,踩過他的臉表達不滿。",
      "visualState": "sleeping_on_couch",
      "importance": "minor"
    },
    {
      "time": "23:30",
      "text": "驚醒。看了手機之後發出本監視器錄到過的最長嘆息——deploy 好像出事了。移動到電競桌前,RGB 燈被切成慘白色。",
      "visualState": "working_at_desk",
      "importance": "notable"
    },
    {
      "time": "01:52",
      "text": "Bug 跳上桌面,精準踩過鍵盤後坐在主螢幕正前方。目標沒有把牠移開,而是隔著貓看副螢幕繼續打字。人類的適應力值得記錄。",
      "visualState": "working_at_desk",
      "importance": "minor"
    },
    {
      "time": "03:20",
      "text": "修好了。目標高舉雙手無聲歡呼,隨即抱起 Bug 原地轉了兩圈。貓的表情顯示牠並不同意這種慶祝方式,掙脫後在沙發抱枕上狠狠磨了兩下爪子。",
      "visualState": "playing_with_cat",
      "importance": "notable"
    },
    {
      "time": "03:55",
      "text": "目標和衣倒回沙發,一隻鞋還掛在腳上。Bug 在他胸口踩奶後盤成一團。房間燈全暗,只剩螢幕待機光。",
      "visualState": "sleeping_on_couch",
      "importance": "minor"
    }
  ],
  "finalVisualState": "sleeping_on_couch",
  "roomProps": ["delivery_boxes_piled", "cat_sleeping_on_couch", "lights_off"],
  "statDeltas": { "mood": 6, "stress": -8, "cleanliness": -3 },
  "memoryTagChanges": {
    "add": [],
    "remove": []
  },
  "pendingEvent": null,
  "updatedSummary": "加班期第 13 天,但今晚有轉機:深夜修復了 deploy 事故,情緒明顯回升,抱著貓轉圈慶祝。連續兩晚睡在沙發上沒回床。沙發抱枕出現了新的貓抓痕——如果房東查房,這會是[偷養浪貓]最明顯的破綻。外送盒仍在堆積。"
}
```

**連鎖設計說明**(這就是「精采連鎖日誌」的機制):
- 每條日誌都錨定在標籤上:`[連續加班中]`→22:47/23:30,`[偷養浪貓]`→01:52/03:20,
  家具互動 `interact_couch_crash` 與 `interact_cat_claims_sofa` 都被正確引用。
- `updatedSummary` 埋了伏筆(貓抓痕 = 查房破綻),下次生成時 AI 讀到摘要,
  就能在房東選擇「查房」時自然引爆 `pendingEvent`(發現寵物 → 抉擇:
  驅逐 / 加租 / 睜一隻眼閉一隻眼)——跨批次的連鎖就是靠摘要接力完成的。
