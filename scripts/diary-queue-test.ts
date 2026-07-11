/**
 * 日記錯開佇列 + 限流重試(額度分散)驗證:
 * - 佇列一次一篇;429 先重試一次(當作每分鐘限流),重試成功 → 繼續 AI,不再整批放棄
 * - 重試仍 429 → 判定當日額度用盡:該批剩下走模板、只通知一次、不再白打 API
 * - 換日重置 quotaHold:新批次會重新嘗試 AI
 * - live=false 全模板、不打 API;離線失敗(非 quota)沿用 narrateDay 的模板結果
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { produceDailyDiaries, setNarrateImplForTest, diaryTiming } = await import("../src/sim/narration");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { state } = await import("../src/store");
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
const ids = Object.keys(state.runtimes);
check("四位租客就緒", ids.length === 4);

const ok = (name: string): NarrateResult => ({ diary: `AI日記:${name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: true });
const quota = (): NarrateResult => ({ diary: "", newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false, quota: true });
const offline = (ctxName: string): NarrateResult => ({ diary: `模板:${ctxName}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false });

const lastDiary = (id: string) => state.runtimes[id].log.filter((e) => e.daily).slice(-1)[0];
const clearLogs = () => Object.values(state.runtimes).forEach((rt) => rt.log.splice(0));

// --- 情境 1:第二位撞限流,重試成功 → 四位都是 AI(以前會整批放棄)---
let calls = 0;
let quotaOnce = true;
setNarrateImplForTest(async (ctx) => {
  calls++;
  if (calls === 2 && quotaOnce) { quotaOnce = false; return quota(); }
  return ok(ctx.name);
});
clearLogs();
await produceDailyDiaries(true);
check("情境1:四位都拿到 AI 日記(限流重試救回)", ids.every((id) => lastDiary(id)?.ai === true));
check("情境1:API 呼叫 5 次(4 篇 + 1 次重試)", calls === 5, `實際 ${calls}`);
check("情境1:沒有誤發額度通知", !state.noticeLog.some((n) => n.text.includes("額度已用完")));

// --- 情境 2:第二位起持續 429 → 第一位 AI、其餘模板、通知一次、不白打 API ---
calls = 0;
setNarrateImplForTest(async (ctx) => {
  calls++;
  return calls === 1 ? ok(ctx.name) : quota();
});
clearLogs();
await produceDailyDiaries(true);
const aiCount = ids.filter((id) => lastDiary(id)?.ai === true).length;
check("情境2:恰一位 AI、其餘模板", aiCount === 1);
check("情境2:額度判定後不再白打(1 成功 + 2 次 429)", calls === 3, `實際 ${calls}`);
check("情境2:額度通知恰一次", state.noticeLog.filter((n) => n.text.includes("額度已用完")).length === 1);
check("情境2:每位都有日記(模板墊底)", ids.every((id) => !!lastDiary(id)));

// --- 情境 3:換日重置 → 新批次重新嘗試 AI ---
calls = 0;
setNarrateImplForTest(async (ctx) => { calls++; return ok(ctx.name); });
clearLogs();
await produceDailyDiaries(true);
check("情境3:額度恢復後全員 AI(quotaHold 已重置)", ids.every((id) => lastDiary(id)?.ai === true) && calls === 4);

// --- 情境 4:live=false 全模板、不打 API ---
calls = 0;
clearLogs();
await produceDailyDiaries(false);
check("情境4:離線批次全模板且 0 次 API", ids.every((id) => lastDiary(id)?.ai === false) && calls === 0);

// --- 情境 5:非 quota 的失敗(離線模板)直接採用,不觸發額度判定 ---
calls = 0;
setNarrateImplForTest(async (ctx) => { calls++; return offline(ctx.name); });
clearLogs();
state.noticeLog.splice(0);
await produceDailyDiaries(true);
check("情境5:每位各打一次、全模板、無額度通知", calls === 4 && ids.every((id) => lastDiary(id)?.ai === false) && !state.noticeLog.some((n) => n.text.includes("額度")));

// --- 日記時間戳:落在入列當下 ---
setNarrateImplForTest(async (ctx) => ok(ctx.name));
clearLogs();
const stampMs = state.gameMs;
await produceDailyDiaries(true);
check("日記時間戳 = 入列當下的遊戲時間", ids.every((id) => lastDiary(id)?.gameMs === stampMs));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
