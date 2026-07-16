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

// ============================================================
// 第二期:selfBehavior 自發行為
// ============================================================

// --- 消毒 ---
const b1 = sanitizeObservation({ nudge: {}, behavior: { id: "sulk", days: 99 }, reason: "理由" });
check("behavior-only 也有效;days 夾 1~2(99→2)", !!b1 && b1.behavior?.id === "sulk" && b1.behavior.days === 2 && b1.nudge.mood === 0);
check("behavior 未知 id → 丟棄;連同全 0 nudge → 整包 null", sanitizeObservation({ nudge: {}, behavior: { id: "teleport", days: 1 }, reason: "r" }) === null);
check("adopt_cat 不開放自發(房東層級決定)", sanitizeObservation({ nudge: {}, behavior: { id: "adopt_cat", days: 1 }, reason: "r" }) === null);
const b2 = sanitizeObservation({ nudge: { mood: 1 }, behavior: { id: "adopt_cat", days: 1 }, reason: "r" });
check("非法 behavior 丟棄但合法 nudge 保留", !!b2 && b2.behavior === null && b2.nudge.mood === 1);

// --- 整合:自發行為生效(source=ai + 🌀 日誌 + 冷卻登記) ---
const { gameDayIndex } = await import("../src/sim/gameState");
lin.directive = null;
lin.lastSelfBehaviorDay = -99;
for (const rt of runtimes()) rt.log.splice(0);
const sulkReason = "和鄰居吵完架,整個人悶悶的";
setNarrateImplForTest(async (ctx) =>
  aiResult(ctx.name, ctx.name === lin.tenant.name ? { nudge: { mood: -1 }, behavior: { id: "sulk", days: 2 }, reason: sulkReason } : null));
await produceDailyDiaries(true);
check("自發行為生效:directive=sulk、source=ai、為期 2 天",
  lin.directive?.id === "sulk" && lin.directive?.source === "ai" && lin.directive?.untilDay === gameDayIndex() + 2);
check("冷卻已登記(lastSelfBehaviorDay=今天)", lin.lastSelfBehaviorDay === gameDayIndex());
check("🌀 日誌含理由與行為開場白", lin.log.some((e) => e.text.startsWith(`🌀 ${sulkReason}——`) && e.text.includes("悶悶不樂")));
check("observation=null 的租客不受影響", !other.directive);

// --- 防線:進行中指令優先、3 日冷卻 ---
lin.directive = null; // 清掉 sulk,但冷卻(今天)仍在
await produceDailyDiaries(true);
check("3 日冷卻內:自發行為被擋", lin.directive === null);
lin.lastSelfBehaviorDay = -99; // 解除冷卻,改掛玩家拍板的指令
lin.directive = { id: "social", untilDay: gameDayIndex() + 5, source: "choice" };
await produceDailyDiaries(true);
check("已有玩家拍板指令:自發行為不覆蓋", lin.directive?.id === "social" && lin.directive?.source === "choice");
lin.directive = null;
lin.lastSelfBehaviorDay = -99;

// --- 待補日記隔太久(>1 遊戲日):行為過時不套,數值照補 ---
state.pendingDiaries.splice(0);
for (const rt of runtimes()) rt.log.splice(0);
setNarrateImplForTest(async () => { throw new Error("不該在模板批被呼叫"); });
await produceDailyDiaries(false);
state.gameMs += 3 * 24 * 3600 * 1000; // 快轉 3 遊戲日後才補寫成功
const staleMoodBefore = lin.tenant.stats.mood;
setNarrateImplForTest(async (ctx) =>
  aiResult(ctx.name, ctx.name === lin.tenant.name ? { nudge: { mood: -2 }, behavior: { id: "hermit", days: 2 }, reason: "那天的事還放在心上" } : null));
resetDeferredDiaryBudgetForTest(6);
await resumeDeferredDiaries(6);
check("過期補寫:行為不套用", lin.directive === null);
check("過期補寫:數值照補(mood -2)", lin.tenant.stats.mood === Math.max(0, staleMoodBefore - 2));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
