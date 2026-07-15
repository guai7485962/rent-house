/** 待補 AI 日記:持久佇列、原地升級、每房客只留最新一篇。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const narration = await import("../src/sim/narration");
const { state, SAVE_KEY } = await import("../src/store");
import type { NarrateResult } from "../src/sim/narrate";

const {
  diaryTiming, produceDailyDiaries, resetDeferredDiaryBudgetForTest, resetDiaryQuota,
  resumeDeferredDiaries, setNarrateImplForTest,
} = narration;
diaryTiming.gapMs = 1;
diaryTiming.retryMs = 1;
diaryTiming.deferredMinGapMs = 1;
diaryTiming.deferredMaxGapMs = 1;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const runtimes = () => Object.values(state.runtimes);
const reset = () => {
  state.pendingDiaries.splice(0);
  for (const rt of runtimes()) rt.log.splice(0);
};
const success = (name: string): NarrateResult => ({
  diary: `AI補寫:${name}`,
  newMemory: null,
  event: null,
  summaryUpdate: null,
  arcUpdate: null,
  ai: true,
  provider: "gemini-flash-lite",
});

// 掛機模板先落地，並寫進可持久化佇列。
reset();
await produceDailyDiaries(false);
const initialCount = runtimes().reduce((n, rt) => n + rt.log.length, 0);
check("掛機模板立即可見", runtimes().every((rt) => rt.log.at(-1)?.ai === false));
check("每位房客各有一篇待補", state.pendingDiaries.length === runtimes().length && runtimes().every((rt) => rt.log.at(-1)?.aiPending));
check("待補佇列已寫入存檔", JSON.parse(mem[SAVE_KEY]).pendingDiaries.length === runtimes().length);
check("context 帶事件機會欄位", state.pendingDiaries.every((job) => typeof job.ctx.eventDue === "boolean"));

// 回前景後補寫:同一筆 log 原地換字，不新增重複動態。
setNarrateImplForTest(async (ctx) => success(ctx.name));
resetDeferredDiaryBudgetForTest(4);
await resumeDeferredDiaries(4);
check("補寫後佇列清空", state.pendingDiaries.length === 0);
check("模板原地升級、不增加篇數", runtimes().reduce((n, rt) => n + rt.log.length, 0) === initialCount);
check("升級後標示模型來源", runtimes().every((rt) => rt.log.at(-1)?.ai && rt.log.at(-1)?.aiProvider === "gemini-flash-lite"));

// 同一房客累積多篇時，只追最新一篇，舊篇不再浪費免費請求。
reset();
await produceDailyDiaries(false);
await produceDailyDiaries(false);
check("每位房客只保留最新待補篇", state.pendingDiaries.length === runtimes().length);
check("舊模板停止等候、最新模板等候中", runtimes().every((rt) => {
  const diaries = rt.log.filter((entry) => entry.daily);
  return diaries.length === 2 && !diaries[0].aiPending && diaries[1].aiPending;
}));

// 連線失敗保留佇列與可讀原因，下一次回前景可再試。
setNarrateImplForTest(async (ctx) => ({
  diary: `內建:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
  ai: false, fallbackReason: "offline",
}));
resetDeferredDiaryBudgetForTest(4);
await resumeDeferredDiaries(1);
check("離線失敗仍保留待補篇", state.pendingDiaries.length === runtimes().length);
check("UI 可顯示失敗原因", runtimes()[0].log.at(-1)?.aiFallbackReason === "offline");

// 每日補寫預算會重置：用盡後同日不再打，換日重置入口恢復請求。
let resetCalls = 0;
setNarrateImplForTest(async (ctx) => { resetCalls++; return success(ctx.name); });
resetDeferredDiaryBudgetForTest(0);
const beforeReset = state.pendingDiaries.length;
await resumeDeferredDiaries(1);
check("待補預算用盡時不再白打 API", resetCalls === 0 && state.pendingDiaries.length === beforeReset);
resetDiaryQuota();
await resumeDeferredDiaries(1);
check("每日重置後待補預算恢復", resetCalls === 1 && state.pendingDiaries.length === beforeReset - 1);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
