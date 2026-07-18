/**
 * 星期系統:本地日曆星期、週末判定、header 時鐘標示、AI context 接線、模板日記週末句。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { weekdayOf, weekdayLabel, weekdayShort, isWeekend, WEEKDAY_LABELS, WEEKDAY_SHORT } = await import("../src/sim/week");
const { state, GAME_START, clockLabel } = await import("../src/sim/gameState");
await import("../src/store"); // 讓種子租客就位
const { buildNarrateCtx } = await import("../src/sim/narration");
const { templateDiary } = await import("../src/sim/narrate");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY = 24 * 3600 * 1000;
const start = GAME_START.getTime(); // 2026-07-05 22:00(+08)= 週日

// --- 純函式:星期對應與週末判定(測試須在 UTC+8 執行,見交接文件) ---
check("GAME_START(2026-07-05)是週日", weekdayOf(start) === 0, `got ${weekdayOf(start)}`);
check("連續 7 天星期循環正確", [0, 1, 2, 3, 4, 5, 6].every((i) => weekdayOf(start + i * DAY) === i));
check("label 表齊全", WEEKDAY_LABELS.length === 7 && WEEKDAY_SHORT.length === 7 && weekdayLabel(start) === "週日" && weekdayShort(start + DAY) === "一");
check("週末判定:週日/週六 true、週一 false", isWeekend(start) && isWeekend(start + 6 * DAY) && !isWeekend(start + DAY));

// --- header 時鐘帶星期 ---
state.gameMs = start + 15 * 3600 * 1000; // 週日 22:00 + 15h = 週一 13:00
check("clockLabel 帶「(一)」星期標示", clockLabel.value.includes("(一)"), clockLabel.value);

// --- AI context 接線 ---
const lin = state.runtimes["tenant_lin_asmr"];
const ctx = buildNarrateCtx(lin, "測試日");
check("buildNarrateCtx 帶今日星期 label", ctx.weekday === weekdayLabel(state.gameMs) && ctx.weekday === "週一");

// --- 模板日記週末句(強制抽池尾;週末句混在天氣句之前,故拿掉 weather 讓週末句在池尾) ---
const realRandom = Math.random;
Math.random = () => 0.999999;
const weekendDiary = templateDiary({ ...ctx, weekday: "週六", weather: undefined, relationships: [], events: [] });
const weekdayDiary = templateDiary({ ...ctx, weekday: "週三", weather: undefined, relationships: [], events: [] });
Math.random = realRandom;
check("週六模板日記抽得到週末情境句", weekendDiary.includes("週末午後的公共區"), weekendDiary);
check("平日模板日記不混週末句", !weekdayDiary.includes("週末午後的公共區"), weekdayDiary);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
