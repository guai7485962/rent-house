/**
 * 星期系統(仿 weather.ts 的省成本模式):星期幾直接取自遊戲時間戳的本地日曆
 * (與 header 時鐘、換日同一時區基準),純函式、不耗模擬 RNG、不入存檔。
 *
 * 接點:header 時鐘(gameState.clockLabel 的「(五)」)、AI 敘事 context
 * (narration.buildNarrateCtx 的 weekday)、模板日記的週末句池(narrate.templateDiary)、
 * worker prompt(今天是週X)。
 */
export const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as const;
export const WEEKDAY_SHORT = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 0=週日 … 6=週六(依本地時區,與遊戲時鐘/換日一致) */
export const weekdayOf = (ms: number): number => new Date(ms).getDay();

export const weekdayLabel = (ms: number): string => WEEKDAY_LABELS[weekdayOf(ms)];
export const weekdayShort = (ms: number): string => WEEKDAY_SHORT[weekdayOf(ms)];

export const isWeekend = (ms: number): boolean => {
  const d = weekdayOf(ms);
  return d === 0 || d === 6;
};
