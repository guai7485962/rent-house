/**
 * 樓外世界錨點:讓「外出」不再只是一間空房間。
 *
 * 兩段式,風險等級刻意分開:
 *
 * 1) **目的地文本(零漂移,不設閘門,立即生效)**
 *    `outingSpot()` 決定性地算出「這個人這個時段大概在哪」,
 *    generate.ts 在 `state === "away"` 時改從對應的目的地句池取句。
 *    ⚠️ 只換句池,不改日誌筆數、不改 `Math.random` 呼叫次數 ⇒ balance 快照零漂移
 *    (快照沒有文字欄位)。**本檔任何路徑都不得新增 RNG 呼叫。**
 *
 * 2) **樓外巧遇(會多推日誌 + 動關係,必須設閘門)**
 *    兩人同一小時都在外面 → 低頻成立一次巧遇,雙方各留一句日誌、關係 +1。
 *
 * 設計約束(與 dreams.ts / floorChain.ts 同源):
 * - **零 RNG**:選目的地、選文案、決定下次間隔一律用決定性雜湊。多一次亂數呼叫
 *   就會位移整個模擬序列、讓 balance 快照全盤漂移。
 * - **前 OUTING_FIRST_DAY 天不巧遇**:balance-test 的快照窗只有 10 遊戲日,
 *   且 `logs` 是整數精確比對;更隱蔽的是關係值會間接改變 socialPass/conflicts 的
 *   擲骰次數 → RNG 序列位移。第 14 天起才觸發 ⇒ 快照零漂移。
 * - **固定迭代次序**:`Object.values(state.runtimes)` 的順序取決於鍵插入順序
 *   (會被搬入/搬出改變),一律先依 id 排序,否則同一存檔在不同 session 會巧遇到
 *   不同的人(同 floorChain.presentTenants)。
 * - **排除 pendingEvent**:被事件凍結的租客 visualState 停在舊值,看起來像在外面。
 * - **冷卻入存檔且以「遊戲日序號」計**:寫在 `state.interactionCooldowns`(借用同一張
 *   入存檔的表,不需改 persistence)。刻意不用 gameMs 差值——`syncToNow()` 補進度
 *   一次會跑最多 48 個 hourlyTick,日序號冷卻天然冪等,gameMs 短冷卻會刷出一整排巧遇。
 * - **相位偏移**:新局所有 pair 的冷卻鍵同時不存在,不處理的話第 14 天會兩兩同時
 *   巧遇一輪,一次刷出 C(n,2) 條日誌(同 dreams 的首夢相位)。
 * - **一次 pass 最多成立 1 對 + 每日全域鎖**:即使冷卻是 pair 級,同一小時 3 人外出仍可能
 *   同時成立 3 對;而每小時 1 對也只擋得住同一小時,住戶一多不同對仍會在同一天連續成立。
 *   兩層合起來保證「全樓一天最多一次巧遇」(稀疏哲學同 floorChain「每次 pass 最多推一話」)。
 * - **兩人目的地必須相同才算碰到面**:這條同時是「文案不矛盾」與「密度不爆」的關鍵。
 *   租客詳情面板直接吃整條 rt.log(含 minor 觀察句),觀察句與巧遇句共用同一個
 *   gameMs ⇒ timeLabel 相同、相鄰兩行;地點若不一致就會並排矛盾。同時「每小時 1 對」
 *   只擋得住同一小時、pair 冷卻只擋得住同一對,住戶一多不同對仍會在同一天連續成立。
 * - **不做「回樓才留日誌」的延遲寫入**:那要新增 runtime 欄位、處理離線補進度的懸空
 *   狀態與巧遇後對方退租。改成當下就寫、文案用回憶語氣,效果相同而狀態機乾淨。
 * - 🏪 前綴刻意**不**加進 narration/weeklyReport 的過濾名單:巧遇是第一手世界事件,
 *   既不是 AI 自己寫的字、也不是既有日誌的二次敘述,應該進 AI 素材、也該能上週報。
 */
import { state, gameDayIndex, pushSocialLog, type TenantRuntime } from "./gameState";
import { pairKey, adjustRelationship } from "./social";
import {
  OUTING_ENCOUNTER_LINES,
  OUTING_SPOT_BREAKFAST_LINES,
  OUTING_SPOT_CONVENIENCE_LINES,
  OUTING_SPOT_MARKET_LINES,
  OUTING_SPOT_NIGHTMARKET_LINES,
  OUTING_SPOT_OVERTIME_LINES,
  OUTING_SPOT_PARK_LINES,
} from "../content/outingLines";

/** 新局前幾個遊戲日不巧遇(也讓 balance-test 的 10 遊戲日完全碰不到本系統) */
export const OUTING_FIRST_DAY = 14;
/** 同一對租客兩次巧遇之間最少相隔幾個遊戲日 */
export const OUTING_MIN_GAP_DAYS = 4;
/** 實際間隔 = OUTING_MIN_GAP_DAYS + [0, OUTING_GAP_SPAN) → 4~5 天,決定性挑 */
export const OUTING_GAP_SPAN = 2;
/** 首次巧遇的相位偏移範圍:每對的第一次落在第 OUTING_FIRST_DAY ~ +OUTING_PHASE_SPAN-1 天 */
export const OUTING_PHASE_SPAN = 4;
/** 巧遇讓雙方關係微升(對照:寵物同框 +1、週末電影夜 +2、洗衣房口角 −3) */
export const OUTING_BOND = 1;
/** 冷卻鍵前綴(借用 interactionCooldowns 這張入存檔的表);值存的是遊戲日序號 */
const OUTING_CD_PREFIX = "outing|";
/**
 * 每日全域鎖:一個遊戲日全樓最多成立一次巧遇。
 * pair 冷卻只擋得住「同一對」、每小時 1 對只擋得住「同一小時」,住戶一多,
 * 不同對仍會在同一天連續成立(8 住戶實測單日最高 7 對 = 14 則 notable 日誌,
 * 佔 FEED_CAP 的近四分之一)。鍵名不可能與 pairKey 相撞(pairKey 恆含 `|`)。
 */
const OUTING_DAY_LOCK_KEY = `${OUTING_CD_PREFIX}__day`;

/** 決定性雜湊:同輸入永遠同輸出,不消耗 Math.random(同 dreams.dreamIndex 的寫法) */
export function outingIndex(key: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % Math.max(1, size);
}

export interface OutingSpotDef {
  id: string;
  /** 進巧遇文案 {spot} 的名稱;一律寫成「地點」而非「行為」(加班 → 公司樓下) */
  label: string;
  /** 這個目的地合理的小時區間(含頭含尾),避免「凌晨三點在公園散步」 */
  from: number;
  to: number;
  lines: string[];
}

/**
 * 目的地表。便利商店與加班涵蓋 0~23,確保任何小時都至少有兩個候選
 * (大夜班的 0-4 外出時段也選得到東西)。
 */
export const OUTING_SPOTS: OutingSpotDef[] = [
  { id: "convenience", label: "便利商店", from: 0, to: 23, lines: OUTING_SPOT_CONVENIENCE_LINES },
  { id: "overtime", label: "公司樓下", from: 0, to: 23, lines: OUTING_SPOT_OVERTIME_LINES },
  { id: "breakfast", label: "早餐店", from: 5, to: 10, lines: OUTING_SPOT_BREAKFAST_LINES },
  { id: "market", label: "超市", from: 10, to: 21, lines: OUTING_SPOT_MARKET_LINES },
  { id: "park", label: "公園", from: 6, to: 19, lines: OUTING_SPOT_PARK_LINES },
  { id: "nightmarket", label: "夜市", from: 17, to: 23, lines: OUTING_SPOT_NIGHTMARKET_LINES },
];

const SPOT_BY_ID = new Map(OUTING_SPOTS.map((s) => [s.id, s]));

/**
 * 時段分塊(邊界對齊 generate.timeWord)。目的地以「時段」為單位穩定,
 * 而不是每小時重抽——否則同一個下午會出現「在超市 → 在公園 → 在超市」。
 */
function timeBlock(hour: number): string {
  if (hour >= 5 && hour <= 10) return "morning";
  if (hour >= 11 && hour <= 13) return "noon";
  if (hour >= 14 && hour <= 17) return "afternoon";
  if (hour >= 18 && hour <= 21) return "evening";
  return "night";
}

/**
 * 這個租客這個時段大概去了哪(回傳目的地 id)。
 * 決定性:同一人 × 同一遊戲日 × 同一時段 ⇒ 永遠同一個答案;跨天會變。
 */
export function outingSpot(rt: TenantRuntime, day: number, hour: number): string {
  const open = OUTING_SPOTS.filter((s) => hour >= s.from && hour <= s.to);
  const pool = open.length ? open : OUTING_SPOTS;
  return pool[outingIndex(`spot|${rt.tenant.id}|${day}|${timeBlock(hour)}`, pool.length)].id;
}

/** 目的地句池(給 generate.ts 在 away 狀態換池用);id 不認得就回 undefined → 呼叫端 fallback */
export function outingSpotLines(spotId: string | undefined): string[] | undefined {
  return spotId ? SPOT_BY_ID.get(spotId)?.lines : undefined;
}

/** 目的地名稱(給巧遇文案的 {spot});id 不認得就回空字串 */
export function outingSpotLabel(spotId: string): string {
  return SPOT_BY_ID.get(spotId)?.label ?? "";
}

/**
 * 佔位符代換。代換值一律走 function replacement——{o} 是租客名字(可能由 AI 生成),
 * 若字面含 `$&`／`` $` ``,字串形式的 replacement 會被當成 pattern 展開。
 */
const fillOuting = (line: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), () => value), line);

/** 巧遇文案(決定性;把「誰的視角」併進雜湊,兩人不會拿到同一句) */
function encounterLine(selfId: string, pk: string, day: number, hour: number, otherName: string, spot: string): string {
  const line = OUTING_ENCOUNTER_LINES[outingIndex(`line|${pk}|${selfId}|${day}|${hour}`, OUTING_ENCOUNTER_LINES.length)];
  return fillOuting(line, { o: otherName, spot });
}

/**
 * 每小時呼叫:兩人同時在外面 → 低頻成立一次樓外巧遇。
 * ⚠️ 必須在 applyHour 的每租客迴圈**全部跑完之後**才呼叫,
 * 全員本小時的 visualState 才定案(同 dreamPass 的理由)。
 */
export function outingEncounterPass(hour: number): void {
  const day = gameDayIndex();
  if (day < OUTING_FIRST_DAY) return;
  if (state.interactionCooldowns[OUTING_DAY_LOCK_KEY] === day) return; // 全樓一天最多一次
  // 固定次序:runtimes 的鍵順序會被搬入/搬出改變,不排序會讓同一存檔巧遇到不同的人
  const out = Object.values(state.runtimes)
    .filter((rt) => !rt.pendingEvent && rt.tenant.visualState === "away")
    .sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
  if (out.length < 2) return;

  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      // 兩人必須在同一個目的地才碰得到面。這一刀同時解決兩件事:
      // (a) **文案矛盾**:租客詳情面板(App.vue 的 LogFeed)吃整條 rt.log(含 minor),
      //     觀察句用他自己的 spot、巧遇句若取另一位的 spot,兩行 timeLabel 相同又相鄰,
      //     會並排出現「他在超市」+「🏪 在公園碰到…」。地點一致後任何介面都不再矛盾。
      // (b) **密度**:每小時最多 1 對只擋得住同一小時,pair 冷卻只擋得住同一對;
      //     住戶一多,不同對仍會在同一天連續成立(8 住戶實測單日曾達 9 對 = 18 則 notable)。
      //     要求同地點後,一天的成立數自然收斂到個位數以下。
      const spotId = outingSpot(a, day, hour);
      if (spotId !== outingSpot(b, day, hour)) continue;
      const pk = pairKey(a.tenant.id, b.tenant.id);
      const key = `${OUTING_CD_PREFIX}${pk}`;
      const last = state.interactionCooldowns[key];
      if (last == null) {
        // 這一對還沒巧遇過(新局或舊存檔升級):相位偏移把首次散到第 14~17 天,
        // 否則所有 pair 的冷卻鍵同時不存在 → 第 14 天會兩兩同時巧遇一輪。
        if (day < OUTING_FIRST_DAY + outingIndex(`phase|${pk}`, OUTING_PHASE_SPAN)) continue;
      } else {
        const gap = OUTING_MIN_GAP_DAYS + outingIndex(`gap|${pk}|${last}`, OUTING_GAP_SPAN);
        if (day - last < gap) continue;
      }
      // ⚠️ 此鍵存的是「遊戲日序號」,與 interactionCooldowns 表中其他鍵存的 gameMs 單位不同。
      state.interactionCooldowns[key] = day;
      state.interactionCooldowns[OUTING_DAY_LOCK_KEY] = day;
      // 地點就是兩人共同的目的地,與雙方本小時的觀察句必然對得起來
      const spot = outingSpotLabel(spotId);
      pushSocialLog(a, encounterLine(a.tenant.id, pk, day, hour, b.tenant.name, spot), "notable");
      pushSocialLog(b, encounterLine(b.tenant.id, pk, day, hour, a.tenant.name, spot), "notable");
      adjustRelationship(a.tenant.id, b.tenant.id, OUTING_BOND);
      return; // 一次 pass 最多成立 1 對(稀疏優先,同 floorChain 每次 pass 最多推一話)
    }
  }
}

/** 測試用:清掉所有樓外巧遇冷卻(比照 dreams.resetDreamCooldown) */
export function resetOutingCooldown(): void {
  for (const key of Object.keys(state.interactionCooldowns)) {
    if (key.startsWith(OUTING_CD_PREFIX)) delete state.interactionCooldowns[key];
  }
}
