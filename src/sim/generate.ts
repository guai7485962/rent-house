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

export interface GenCtx {
  tenantId: string;
  tenantName: string;
  hour: number;
  timeLabel: string; // "02:00"
  state: TenantVisualState;
  isDeviation: boolean; // 是否偏離了正常作息(壓力/事件)
  recentSummary: string;
}

export interface GenResult {
  logText: string;
  importance: ObservationLog["importance"];
  statDeltas: StatDeltas;
}

/** 各狀態的小幅每小時數值效果 */
const EFFECT: Partial<Record<TenantVisualState, StatDeltas>> = {
  sleeping_on_bed: { stress: -5, mood: 2 },
  sleeping_on_couch: { stress: -2, mood: -1 },
  working_at_desk: { stress: 3, mood: -1 },
  gaming: { mood: 4, stress: -3 },
  streaming: { mood: 3, stress: 1 },
  cooking: { mood: 2, cleanliness: -1 },
  eating: { mood: 2, cleanliness: -1 },
  showering: { stress: -4, cleanliness: 1 },
  playing_with_cat: { mood: 6, stress: -4 },
  watching_tv: { mood: 2, stress: -1 },
  reading: { mood: 1, stress: -2 },
  cleaning: { cleanliness: 6, mood: -1 },
  pacing: { stress: 6, mood: -3 },
  crying: { mood: -7, stress: 3 },
  talking_on_phone: { mood: 0 },
  away: { stress: 2 },
  idle: {},
};

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
  const base = (pick(OBSERVATION_LINES[ctx.state], seed) || "度過了平淡的一小時。").replace(/\{time\}/g, timeWord(ctx.hour));
  const importance: ObservationLog["importance"] = ctx.isDeviation
    ? "major"
    : ctx.state === "crying" || ctx.state === "pacing"
      ? "notable"
      : "minor";
  return {
    logText: base,
    importance,
    statDeltas: { ...(EFFECT[ctx.state] ?? {}) },
  };
}
