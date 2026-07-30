/**
 * 內容生成接縫(Content Generation Seam)。
 *
 * generateHourly(ctx) 吃「當前狀態 + 租客 + 歷史」→ 產出這一小時的觀察日誌文本
 * 與小幅數值變化。
 *
 * ★ 這是 AI 的唯一插入點 ★
 * 現在:本地模板句(依 state + 性格微調),讓框架先能跑。
 * 之後:改成呼叫 Claude(吃 memoryTags/recentSummary/近期 logs 產生演進式敘事,
 *       回傳符合 AIEventResponse 的結果)。store 與 UI 完全不用動。
 */
import type { ObservationLog, StatDeltas, TenantVisualState } from "../types";
import { OBSERVATION_LINES } from "../content/observationLines";
import { getDef } from "../furniture/catalog";
import { sleepMultiplier } from "../furniture/tier";
import { outingSpotLines } from "./outing";

export interface GenCtx {
  tenantId: string;
  tenantName: string;
  hour: number;
  timeLabel: string; // "02:00"
  state: TenantVisualState;
  /** 純演出活動可沿用被取代作息的數值效果，避免增加內容時意外重做平衡。 */
  effectState?: TenantVisualState;
  isDeviation: boolean; // 是否偏離了正常作息(壓力/事件)
  recentSummary: string;
  /** 外出目的地 id(僅 state === "away" 時給;見 sim/outing.ts)。用來把「空房間」的
   *  觀察句換成「他大概在便利商店/早餐店/公司樓下」的目的地句池。 */
  outingSpot?: string;
  /** 這一小時實際使用的家具 defId(由 `tick.ts` 的 `applyHour` 帶入)。
   *  目前**只有睡眠**會用到它(床的 tier → 恢復效率乘數);其他活動一律不吃乘數。 */
  furnitureDefId?: string;
}

export interface GenResult {
  logText: string;
  importance: ObservationLog["importance"];
  statDeltas: StatDeltas;
}

/** 各狀態的小幅每小時數值效果(energy=精力資源:睡覺充、活動耗;wellbeing=身心健康慢變) */
const EFFECT: Partial<Record<TenantVisualState, StatDeltas>> = {
  sleeping_on_bed: { stress: -5, mood: 2, energy: 9, wellbeing: 0.3 },
  sleeping_on_couch: { stress: -2, mood: -1, energy: 5 },
  working_at_desk: { stress: 3, mood: -1, energy: -4 },
  gaming: { mood: 4, stress: -3, energy: -2 },
  streaming: { mood: 3, stress: 1, energy: -4 },
  cooking: { mood: 2, cleanliness: -1, energy: -1, wellbeing: 0.3 },
  eating: { mood: 2, cleanliness: -1, energy: 1 },
  eating_at_table: { mood: 2, energy: 1 },
  showering: { stress: -4, cleanliness: 1, energy: 1, wellbeing: 0.5 },
  using_toilet: { stress: -4, cleanliness: 1, energy: 1, wellbeing: 0.5 },
  washing_at_sink: { stress: -4, cleanliness: 1, energy: 1, wellbeing: 0.5 },
  taking_bath: { stress: -4, cleanliness: 1, energy: 1, wellbeing: 0.5 },
  waiting_for_bathroom: { stress: 1, energy: -1 },
  playing_with_cat: { mood: 6, stress: -4, energy: 1 },
  watching_tv: { mood: 2, stress: -1, energy: 2 },
  reading: { mood: 1, stress: -2, energy: 2 },
  cleaning: { cleanliness: 6, mood: -1, energy: -2, wellbeing: 0.4 },
  painting: { mood: 3, stress: -2, energy: -1 },
  using_appliance: { energy: 0 },
  pacing: { stress: 6, mood: -3, energy: -2 },
  crying: { mood: -7, stress: 3, energy: -3 },
  talking_on_phone: { mood: 0 },
  away: { stress: 2, energy: -3 },
  idle: { energy: 1 },
};

/**
 * 吃家具 tier 乘數的狀態:**只有睡眠**。
 *
 * 沙發休息/看電視/泡澡/書桌工作刻意不接——種子局那些活動全踩在 premium 家具上
 * (`mic_desk`、`gaming_desk`、`shared_sofa`、`lounge_tv`、`bathtub`),一接就整片
 * 改變既有平衡快照。要擴充請另開一階段、連同快照一起重新校準。
 *
 * ⚠️ 擴充時的坑:本函式的 key 是 `ctx.effectState ?? ctx.state`,而 `tick.ts` 的
 * `decideState` 在浴室輪替/洗衣時會讓「畫面狀態」與「數值狀態」分家,可能出現
 * 「泡的是 premium 浴缸、乘數卻乘在 showering 上」。睡眠沒有這個問題:床的 slot
 * 從不觸發 effectState 覆寫。
 */
const SLEEP_STATES = new Set<TenantVisualState>(["sleeping_on_bed", "sleeping_on_couch"]);

/**
 * 睡眠乘數只作用在這兩個欄位。
 *
 * - `energy`:主軸,但實測 240h 有 41~47% 的 +9 被 100 上限吃掉,帳面效果比名目小近一半。
 * - `stress`:-5 在實測中 100% 生效(從未觸底),且 stress 有 homeostasis 拉回、
 *   不會像 energy 那樣黏死在極值 ⇒ 「好床真的有感」主要靠它。
 *
 * 刻意不含 `mood`(+2 已頻繁頂到 100,加成幾乎全浪費,還會讓心情滿分更常態化)
 * 與 `wellbeing`(+0.3 太小,單日 ±2,乘了看不出來)。
 */
const SLEEP_SCALED = ["energy", "stress"] as const;

/** 這一小時的家具 tier 乘數(非睡眠狀態、或沒帶家具 → 精確的 1.0,乘了等於沒乘) */
function furnitureMultiplier(key: TenantVisualState, defId: string | undefined): number {
  if (!SLEEP_STATES.has(key) || !defId) return 1;
  return sleepMultiplier(getDef(defId)) ?? 1;
}

function pick(arr: string[] | undefined, seed: number): string {
  if (!arr || arr.length === 0) return "";
  return arr[seed % arr.length];
}

/** 依小時給時段詞,避免「白天卻說半夜」 */
function timeWord(hour: number): string {
  if (hour >= 5 && hour <= 10) return "早晨";
  if (hour >= 11 && hour <= 13) return "中午";
  if (hour >= 14 && hour <= 17) return "午後";
  if (hour >= 18 && hour <= 21) return "傍晚";
  return "深夜";
}

export function generateHourly(ctx: GenCtx): GenResult {
  // 從豐富句庫隨機挑一句(每次不同,避免每天雷同),再把 {time} 換成實際時段
  const seed = Math.floor(Math.random() * 1000);
  // 外出時改用目的地句池(「他大概在哪」),取不到就 fallback 回原本的空房間句池。
  // ⚠️ 只換池不換流程:仍然只有上面那一次 Math.random,日誌筆數與 RNG 次序完全不變
  //    ⇒ balance 快照零漂移(快照沒有文字欄位)。
  const pool = (ctx.state === "away" ? outingSpotLines(ctx.outingSpot) : undefined) ?? OBSERVATION_LINES[ctx.state];
  const base = (pick(pool, seed) || "度過了平淡的一小時。").replace(/\{time\}/g, timeWord(ctx.hour));
  const importance: ObservationLog["importance"] = ctx.isDeviation
    ? "major"
    : ctx.state === "crying" || ctx.state === "pacing"
      ? "notable"
      : "minor";
  // 家具 tier → 數值效果乘數。全系統只有這一種形式:`EFFECT[key] × mult`。
  // budget 床(與所有非睡眠狀態)的 mult 是精確的 1.0,`9 * 1.0 === 9` 位元級成立。
  const effectKey = ctx.effectState ?? ctx.state;
  const mult = furnitureMultiplier(effectKey, ctx.furnitureDefId);
  const statDeltas: StatDeltas = { ...(EFFECT[effectKey] ?? {}) };
  for (const field of SLEEP_SCALED) {
    const v = statDeltas[field];
    if (v !== undefined) statDeltas[field] = v * mult;
  }
  return { logText: base, importance, statDeltas };
}
