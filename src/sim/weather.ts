/**
 * 天氣系統(讓世界有生活感):每遊戲日一種天氣,由遊戲日序號的決定性雜湊決定——
 * 不消耗模擬 RNG、不入存檔(同一天永遠算出同一種天氣),balance 的亂數序不受影響。
 *
 * 接點:header 天氣 emoji(App.vue)、AI 敘事 context(narration.buildNarrateCtx)、
 * 模板日記的天氣句池(narrate.templateDiary)、社群事件門檻(community:雨天不上頂樓、
 * 雨天限定的交誼廳窩著)。
 */
import { gameDayIndex } from "./gameState";

export type WeatherId = "sunny" | "cloudy" | "rainy" | "sweltering";

const LABELS: Record<WeatherId, string> = {
  sunny: "☀️ 晴朗",
  cloudy: "☁️ 陰天",
  rainy: "🌧️ 雨天",
  sweltering: "🥵 悶熱",
};

/** 決定性雜湊(splitmix 尾段):同一天永遠同一種天氣;分佈約 晴40/陰25/雨25/悶熱10 */
export function weatherForDay(day: number): WeatherId {
  let h = (day + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  if (r < 0.4) return "sunny";
  if (r < 0.65) return "cloudy";
  if (r < 0.9) return "rainy";
  return "sweltering";
}

export const weatherLabel = (w: WeatherId): string => LABELS[w];

/** 今天(依 state.gameMs)的天氣 */
export const todayWeather = (): WeatherId => weatherForDay(gameDayIndex());
