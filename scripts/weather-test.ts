/**
 * 天氣系統:決定性雜湊、label、AI context 接線、模板日記天氣句、社群事件天氣門檻。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { weatherForDay, weatherLabel, todayWeather } = await import("../src/sim/weather");
const { state, GAME_START } = await import("../src/sim/gameState");
await import("../src/store"); // 讓種子租客就位
const { buildNarrateCtx } = await import("../src/sim/narration");
const { templateDiary } = await import("../src/sim/narrate");
const { COMMUNITY_EVENTS } = await import("../src/sim/community");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 決定性與分佈 ---
check("決定性:同一天永遠同一種天氣", weatherForDay(42) === weatherForDay(42) && weatherForDay(7) === weatherForDay(7));
const seen = new Set<string>();
for (let d = 0; d < 200; d++) seen.add(weatherForDay(d));
check("200 天內四種天氣都會出現", seen.size === 4);
check("label 皆為 emoji+名稱", (["sunny", "cloudy", "rainy", "sweltering"] as const).every((w) => /^\S+ .+$/.test(weatherLabel(w))));

// 找出一個雨天與一個非雨天(供後續固定情境)
let rainyDay = -1;
let clearDay = -1;
for (let d = 0; d < 400 && (rainyDay < 0 || clearDay < 0); d++) {
  if (weatherForDay(d) === "rainy" && rainyDay < 0) rainyDay = d;
  if (weatherForDay(d) === "sunny" && clearDay < 0) clearDay = d;
}
check("掃描找得到雨天與晴天樣本", rainyDay >= 0 && clearDay >= 0);

const setDay = (day: number) => {
  state.gameMs = GAME_START.getTime() + day * 24 * 3600 * 1000 + 12 * 3600 * 1000;
};

// --- AI context 接線 ---
setDay(rainyDay);
const lin = state.runtimes["tenant_lin_asmr"];
const ctx = buildNarrateCtx(lin, "測試日");
check("buildNarrateCtx 帶今日天氣 label", ctx.weather === weatherLabel(todayWeather()) && ctx.weather === "🌧️ 雨天");

// --- 模板日記天氣句(強制抽池尾 = 最後混入的天氣句;測畢還原亂數) ---
const realRandom = Math.random;
Math.random = () => 0.999999;
const rainDiary = templateDiary({ ...ctx, weather: "🌧️ 雨天", relationships: [], events: [] });
Math.random = realRandom;
check("雨天模板日記抽得到雨天情境句", rainDiary.includes("雨"), rainDiary);

// --- 社群事件天氣門檻 ---
const rooftop = COMMUNITY_EVENTS.find((e) => e.id === "rooftop")!;
const rainyLounge = COMMUNITY_EVENTS.find((e) => e.id === "rainy_lounge")!;
setDay(rainyDay);
check("雨天:頂樓乘涼關閉、雨天窩交誼廳開放", rooftop.when!() === false && rainyLounge.when!() === true);
setDay(clearDay);
check("晴天:頂樓乘涼開放、雨天窩交誼廳關閉", rooftop.when!() === true && rainyLounge.when!() === false);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
