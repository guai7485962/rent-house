/**
 * AI 觀察回饋第一期(statNudge):消毒夾值 + applyDiaryEffects 接線。
 * - sanitizeObservation:白名單欄位、±3/±2 夾值、全 0 或缺 reason 整包丟棄
 * - AI 回 observation → 數值小幅推動 + 🔮 因果日誌;null → 完全不動
 * - 待補日記原地升級路徑也會套用(同走 applyDiaryEffects)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { sanitizeObservation } = await import("../src/sim/observationEffects");
const narration = await import("../src/sim/narration");
const { state } = await import("../src/store");
import type { NarrateResult } from "../src/sim/narrate";

const { diaryTiming, produceDailyDiaries, resetDeferredDiaryBudgetForTest, resumeDeferredDiaries, setNarrateImplForTest } = narration;
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

// --- sanitizeObservation(消毒層) ---
const s1 = sanitizeObservation({ nudge: { mood: 99, stress: -99, affinity: 5 }, reason: "理由" });
check("超限夾值:mood 99→3、stress -99→-3、affinity 5→2", !!s1 && s1.nudge.mood === 3 && s1.nudge.stress === -3 && s1.nudge.affinity === 2);
const s2 = sanitizeObservation({ nudge: { mood: "abc", energy: 2.6, satisfaction: 20, money: 999 }, reason: "理由" });
check("非數值→0、小數四捨五入、satisfaction/money 欄位丟棄", !!s2 && s2.nudge.mood === 0 && s2.nudge.energy === 3 && !("satisfaction" in s2.nudge) && !("money" in s2.nudge));
check("全 0 推力 → 整包丟棄", sanitizeObservation({ nudge: { mood: 0 }, reason: "理由" }) === null);
check("缺 reason → 整包丟棄", sanitizeObservation({ nudge: { mood: 2 } }) === null);
check("reason 截 60 字", sanitizeObservation({ nudge: { mood: 1 }, reason: "長".repeat(99) })!.reason.length === 60);
check("非物件/null → null", sanitizeObservation(null) === null && sanitizeObservation("str") === null && sanitizeObservation({ nudge: "x", reason: "r" }) === null);

// --- 整合:AI 回 observation → 數值推動 + 🔮 日誌 ---
const runtimes = () => Object.values(state.runtimes);
const lin = state.runtimes["tenant_lin_asmr"];
const other = runtimes().find((rt) => rt.tenant.id !== lin.tenant.id)!;
const aiResult = (name: string, observation: unknown): NarrateResult => ({
  diary: `AI:${name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
  observation, ai: true, provider: "workers-ai-qwen",
});
const reason = "連兩天被搶洗衣機,悶氣還沒消";
setNarrateImplForTest(async (ctx) =>
  aiResult(ctx.name, ctx.name === lin.tenant.name ? { nudge: { mood: -2, stress: 3, affinity: -1 }, reason } : null));

const linBefore = { ...lin.tenant.stats };
const otherBefore = { ...other.tenant.stats };
for (const rt of runtimes()) rt.log.splice(0);
await produceDailyDiaries(true);

check("推力如實套用:心情 -2、壓力 +3、好感 -1",
  lin.tenant.stats.mood === linBefore.mood - 2 && lin.tenant.stats.stress === linBefore.stress + 3 && lin.tenant.stats.affinity === linBefore.affinity - 1);
const obsLog = lin.log.find((e) => e.text.startsWith("🔮 觀察影響:"));
check("🔮 日誌含理由與數值因果", !!obsLog && obsLog.text.includes(reason) && obsLog.text.includes("心情 -2") && obsLog.text.includes("壓力 +3"), obsLog?.text ?? "(無)");
check("observation=null 的租客:數值不動、無 🔮 日誌",
  other.tenant.stats.mood === otherBefore.mood && other.tenant.stats.stress === otherBefore.stress &&
  !other.log.some((e) => e.text.startsWith("🔮")));

// --- 邊界:推力不能把數值推出 0~100 ---
lin.tenant.stats.stress = 99;
setNarrateImplForTest(async (ctx) =>
  aiResult(ctx.name, ctx.name === lin.tenant.name ? { nudge: { stress: 3 }, reason: "高壓持續" } : null));
await produceDailyDiaries(true);
check("夾在 0~100:99 + 3 → 100", lin.tenant.stats.stress === 100);

// --- 待補日記原地升級路徑:補寫成功時同樣套用推力 ---
state.pendingDiaries.splice(0);
for (const rt of runtimes()) rt.log.splice(0);
setNarrateImplForTest(async () => { throw new Error("不該在模板批被呼叫"); });
await produceDailyDiaries(false); // 掛機模板 → 進待補佇列
const moodBeforeDeferred = lin.tenant.stats.mood;
setNarrateImplForTest(async (ctx) =>
  aiResult(ctx.name, ctx.name === lin.tenant.name ? { nudge: { mood: 2 }, reason: "回頭看其實是不錯的一天" } : null));
resetDeferredDiaryBudgetForTest(6);
await resumeDeferredDiaries(6);
check("補寫升級路徑也套用推力(mood +2)", lin.tenant.stats.mood === Math.min(100, moodBeforeDeferred + 2));
check("補寫升級也寫 🔮 日誌", lin.log.some((e) => e.text.startsWith("🔮 觀察影響:回頭看其實是不錯的一天")));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
