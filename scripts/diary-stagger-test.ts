/**
 * 日記時段錯開驗證(AI 額度分散):
 * - 每位租客有專屬 diaryHour,彼此不同 → 不再全擠在 0 點打 API
 * - 時段到了才生成、每人每日恰一篇、日記時間戳落在自己的時段
 * - live 路徑走佇列(AI);新住戶自動補指派且不撞既有時段
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { ensureDiaryHours, diaryPass, setNarrateImplForTest, diaryTiming } = await import("../src/sim/narration");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { state, debugStepHour } = await import("../src/store");
import type { NarrateResult } from "../src/sim/narrate";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

diaryTiming.gapMs = 1;
diaryTiming.retryMs = 1;

// 湊滿 4 位租客
moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
ensureDiaryHours();
const ids = Object.keys(state.runtimes);
const hours = ids.map((id) => state.runtimes[id].diaryHour);
check("四位租客都有日記時段", hours.every((h) => h >= 0 && h <= 23), JSON.stringify(hours));
check("四個時段彼此不同(不再擠在 0 點)", new Set(hours).size === 4, JSON.stringify(hours));
check("沒有人被排在 0 點整批時代的時段外", hours.every((h) => Number.isInteger(h)));

// --- 快轉 24 小時(live=false → 模板同步落地):每人恰一篇、時間戳在自己的時段 ---
const dailyCount = (id: string) => state.runtimes[id].log.filter((e) => e.daily).length;
for (const id of ids) state.runtimes[id].log.splice(0);
for (let i = 0; i < 24; i++) debugStepHour();
check("24 小時後每人恰一篇日記", ids.every((id) => dailyCount(id) === 1), JSON.stringify(ids.map(dailyCount)));
const stampHours = ids.map((id) => new Date(state.runtimes[id].log.find((e) => e.daily)!.gameMs).getHours());
check("日記時間戳落在各自的時段", ids.every((id, i) => stampHours[i] === state.runtimes[id].diaryHour), `${JSON.stringify(stampHours)} vs ${JSON.stringify(ids.map((id) => state.runtimes[id].diaryHour))}`);
check("四篇日記出現在四個不同小時(分散驗證)", new Set(stampHours).size === 4);

// --- 再 24 小時:不重複、變兩篇 ---
for (let i = 0; i < 24; i++) debugStepHour();
check("48 小時後每人恰兩篇(同日不重複)", ids.every((id) => dailyCount(id) === 2), JSON.stringify(ids.map(dailyCount)));

// --- live 路徑:時段到了走 AI 佇列 ---
let aiCalls = 0;
const ok = (name: string): NarrateResult => ({ diary: `AI日記:${name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: true });
setNarrateImplForTest(async (ctx) => { aiCalls++; return ok(ctx.name); });
const target = state.runtimes[ids[0]];
target.lastDiaryDay = -99; // 讓他今天還沒寫過
diaryPass(target.diaryHour, true);
await new Promise((r) => setTimeout(r, 80));
check("live:恰好只有時段到的那一位打了 AI", aiCalls === 1, `實際 ${aiCalls}`);
check("live:拿到 AI 日記", state.runtimes[ids[0]].log.filter((e) => e.daily).slice(-1)[0]?.ai === true);

// --- 新住戶:退租再入住,自動補時段且不撞現有的 ---
const rt3 = state.runtimes[ids[2]];
rt3.diaryHour = -1;
ensureDiaryHours();
const allHours = ids.map((id) => state.runtimes[id].diaryHour);
check("重新指派後時段仍彼此不同", new Set(allHours).size === 4, JSON.stringify(allHours));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
