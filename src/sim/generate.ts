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

/** 各狀態的旁白模板(監視器口吻);{name} 會替換成租客名 */
const LINES: Partial<Record<TenantVisualState, string[]>> = {
  sleeping_on_bed: ["蜷在被窩裡睡得像被拔掉電源,連翻身都省了。", "睡死。鬧鐘大概又會被按掉三次。"],
  sleeping_on_couch: ["沒力氣走到床上,和衣癱在沙發睡著,鞋只脫了一隻。"],
  working_at_desk: ["又坐回電腦前,三螢幕的光是這房間唯一的動靜。", "盯著螢幕敲鍵盤,肩膀一小時比一小時垮。"],
  gaming: ["切到遊戲畫面,難得聽見一聲短促的歡呼。", "打電動打到對著螢幕罵了一句髒話。"],
  streaming: ["開播了。麥克風亮起紅燈,一萬人在另一端一起屏住呼吸。", "直播中,對鏡頭維持著溫柔的聲線。"],
  cooking: ["在共用廚房開火,半夜的泡麵香味飄出來。"],
  eating: ["在餐桌前吃東西,一個人,配著手機。"],
  showering: ["浴室門關上,蒸氣從門縫爬出來。"],
  playing_with_cat: ["把橘貓 Bug 抱起來轉圈,貓表達了強烈的不同意。", "逗貓逗到笑出來,今天的疲憊暫時退場。"],
  watching_tv: ["癱在沙發上追劇,遙控器擱在肚子上。"],
  reading: ["裹著毯子看紙本書,翻頁聲規律得像 ASMR。"],
  cleaning: ["難得動手打掃,垃圾終於被倒了。"],
  pacing: ["在房間中央來回踱步,手指掐著手臂——壓力到臨界了。"],
  crying: ["深夜獨自崩潰,對著空氣把情緒倒出來。"],
  talking_on_phone: ["講了很久的電話,語氣起伏不定。"],
  away: ["房間空著,外出上班去了。"],
  idle: ["站在房間中央發了一會呆。"],
};

function pick(arr: string[] | undefined, seed: number): string {
  if (!arr || arr.length === 0) return "";
  return arr[seed % arr.length];
}

export function generateHourly(ctx: GenCtx): GenResult {
  const base = pick(LINES[ctx.state], ctx.hour) || "度過了平淡的一小時。";
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
