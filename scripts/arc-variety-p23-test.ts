/** 劇情弧多樣性第二／三階段:記憶額度、stall、主支線並行、種子擴充與舊檔相容。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};
(globalThis as any).fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "no_key" }) });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const { _internal } = await import("../worker/index");
const { clampCtx, buildPrompt, providerArcUpdate, narrateProviderOrder } = _internal;
const { state, initGame, stopGame, exportSave } = await import("../src/store");
const {
  MEMORY_CAP, EXPERIENCE_MEMORY_CAP, pushMemory, gameDayIndex,
} = await import("../src/sim/gameState");
const { ARC_STALL_TIMEOUT_DAYS } = await import("../src/sim/arcs");
const { STORY_ARC_SEEDS } = await import("../src/content/storyArcs");
const { localArcPass, pickSeedForDay, LOCAL_ARC_ID_PREFIX } = await import("../src/sim/localArc");
const { SAVE_KEY, save, SAVE_VERSION } = await import("../src/sim/persistence");
const {
  buildNarrateCtx, produceDailyDiaries, setNarrateImplForTest, diaryTiming,
} = await import("../src/sim/narration");

// ① 記憶淘汰:兩個池各自算額度,池內先丟最低 intensity、同值再丟最舊。
{
  const tenant = JSON.parse(JSON.stringify(Object.values(state.runtimes)[0].tenant));
  tenant.memoryTags = Array.from({ length: MEMORY_CAP }, (_, i) => ({
    id: `n${i}`, label: `[一般${i}]`, behaviorHint: "", acquiredAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    source: "ai_event" as const, intensity: i === 3 ? 0.1 : 0.8,
  }));
  tenant.memoryTags.push(...Array.from({ length: EXPERIENCE_MEMORY_CAP }, (_, i) => ({
    id: `e${i}`, label: `[經歷:篇章${i}]`, behaviorHint: "", acquiredAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    source: "ai_event" as const, intensity: i === 1 ? 0.05 : 0.9,
  })));
  pushMemory(tenant, "[新一般]", "", "ai_event");
  check("一般記憶超額先淘汰最低 intensity", !tenant.memoryTags.some((m) => m.id === "n3") && tenant.memoryTags.some((m) => m.label === "[新一般]"));
  check("新增一般記憶不吃掉經歷獨立額度", tenant.memoryTags.filter((m) => m.label.startsWith("[經歷:")).length === EXPERIENCE_MEMORY_CAP);
  pushMemory(tenant, "[經歷:新篇章]", "", "ai_event");
  check("經歷超額只在經歷池淘汰最低 intensity", !tenant.memoryTags.some((m) => m.id === "e1") && tenant.memoryTags.some((m) => m.label === "[經歷:新篇章]"));
  check("兩池總額可達一般+經歷", tenant.memoryTags.length === MEMORY_CAP + EXPERIENCE_MEMORY_CAP);
  const equalTenant = JSON.parse(JSON.stringify(Object.values(state.runtimes)[0].tenant));
  equalTenant.memoryTags = Array.from({ length: MEMORY_CAP }, (_, i) => ({
    id: `same${i}`, label: `[同強度${i}]`, behaviorHint: "", acquiredAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    source: "ai_event" as const, intensity: 0.5,
  }));
  pushMemory(equalTenant, "[同強度新記憶]", "", "ai_event");
  check("同 intensity 時淘汰 acquiredAt 最舊者", !equalTenant.memoryTags.some((m: any) => m.id === "same0"));
}

const target = Object.values(state.runtimes)[0];
const other = Object.values(state.runtimes)[1];
const seed = STORY_ARC_SEEDS.find((s) => !(s.occupations?.length) && !(s.tags?.length))!;
const day = gameDayIndex();

// ② stall 決定性中性收束；支線不受影響。
target.arcHistory = [];
target.tenant.memoryTags = target.tenant.memoryTags.filter((m) => !m.label.startsWith("[經歷:"));
target.arc = { id: "arc_stalled", theme: "卡住的主線", stage: 2, maxStage: 5, summary: "沒有進展", lastProgressDay: day - ARC_STALL_TIMEOUT_DAYS };
target.sideArc = { id: `${LOCAL_ARC_ID_PREFIX}${seed.id}_${day}`, theme: seed.theme, stage: 1, maxStage: seed.stages.length, summary: seed.stages[0].summary, seedId: seed.id, localDay: day };
const sideBefore = JSON.stringify(target.sideArc);
localArcPass();
check("AI 主線 stall 逾時會自動收束", target.arc === null && target.arcHistory.includes("卡住的主線"));
check("stall 收束留下經歷與可見日誌", target.tenant.memoryTags.some((m) => m.label === "[經歷:卡住的主線]") && target.log.some((e) => e.text.includes("篇章逾時收束")));
check("stall 收束不碰並行本地支線", JSON.stringify(target.sideArc) === sideBefore);

other.arc = { id: "arc_fresh", theme: "仍在推進", stage: 1, maxStage: 4, summary: "昨天才動", lastProgressDay: day - ARC_STALL_TIMEOUT_DAYS + 1 };
other.sideArc = null;
localArcPass();
check("未達 stall 門檻的主線保持進行", other.arc?.id === "arc_fresh");

target.arcHistory = [];
other.arcHistory = [];
target.arc = { id: "arc_pair_stall", theme: "逾時雙人篇章", stage: 2, maxStage: 5, summary: "停住", partnerId: other.tenant.id, partnerName: other.tenant.name, lastProgressDay: day - ARC_STALL_TIMEOUT_DAYS };
other.arc = { id: "arc_pair_stall", theme: "逾時雙人篇章", stage: 2, maxStage: 5, summary: "停住", partnerId: target.tenant.id, partnerName: target.tenant.name, lastProgressDay: day - ARC_STALL_TIMEOUT_DAYS };
localArcPass();
check("雙人主線 stall 會同步清除雙方 arc", target.arc === null && other.arc === null);
check("雙人 stall 雙方都有 history/memory/log", [target, other].every((rt) =>
  rt.arcHistory?.includes("逾時雙人篇章")
  && rt.tenant.memoryTags.some((m) => m.label === "[經歷:逾時雙人篇章]")
  && rt.log.some((e) => e.text.includes("逾時收束"))));

// ③ AI 主線 + 本地支線並行；AI 只更新主線，ctx/prompt 安全地把支線列為唯讀。
target.arc = { id: "arc_main", theme: "主線考驗", stage: 1, maxStage: 4, summary: "剛開始", lastProgressDay: day };
const sideStable = JSON.stringify(target.sideArc);
diaryTiming.gapMs = 1;
setNarrateImplForTest(async (ctx) => ({
  diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
  arcUpdate: ctx.name === target.tenant.name ? { stage: 2, summary: "主線前進", done: false } : null,
  observation: null, ai: true as const,
}));
await produceDailyDiaries(true);
check("AI arcUpdate 只推進主線", target.arc?.stage === 2 && target.arc.summary === "主線前進");
check("AI 主線更新不修改支線", JSON.stringify(target.sideArc) === sideStable);
const progressClock = target.arc?.lastProgressDay;
setNarrateImplForTest(async (ctx) => ({
  diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
  arcUpdate: ctx.name === target.tenant.name ? { stage: 2, summary: "主線前進", done: false, tone: "up" } : null,
  observation: null, ai: true as const,
}));
const moodBeforeNoop = target.tenant.stats.mood;
await produceDailyDiaries(true);
check("AI 重送相同 stage/summary 不重設 stall 時鐘", target.arc?.lastProgressDay === progressClock);
check("AI no-op advance 不重複發 tone 脈衝", target.tenant.stats.mood === moodBeforeNoop);

target.arc = { id: "arc_pair_clock", theme: "共同主線", stage: 1, maxStage: 4, summary: "起步", partnerId: other.tenant.id, partnerName: other.tenant.name, lastProgressDay: day - 2 };
other.arc = { id: "arc_pair_clock", theme: "共同主線", stage: 1, maxStage: 4, summary: "起步", partnerId: target.tenant.id, partnerName: target.tenant.name, lastProgressDay: day - 2 };
setNarrateImplForTest(async (ctx) => ({
  diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
  arcUpdate: ctx.name === target.tenant.name ? { stage: 2, summary: "一起前進", done: false } : null,
  observation: null, ai: true as const,
}));
await produceDailyDiaries(true);
check("雙人主線推進會同步雙方 stall 時鐘", target.arc?.lastProgressDay === day && other.arc?.lastProgressDay === day);
const ctx = buildNarrateCtx(target, "測試日");
check("NarrateCtx 同時帶主線與唯讀支線", ctx.arc?.theme === "共同主線" && ctx.sideArc?.theme === seed.theme);
const clamped = clampCtx({ name: "A", sideArc: { theme: "支".repeat(99), stage: 99, maxStage: 99, summary: "摘".repeat(999) } });
check("Worker 夾值 sideArc schema", clamped.sideArc?.theme.length === 40 && clamped.sideArc.stage === 6 && clamped.sideArc.maxStage === 6 && clamped.sideArc.summary.length === 200);
const prompt = buildPrompt(clampCtx({ name: "A", sideArc: { theme: "支線題材", stage: 1, maxStage: 3, summary: "支線摘要" } }));
check("prompt 明示支線唯讀且沒有主線仍可開主線", prompt.includes("本地支線(唯讀") && prompt.includes("進行中的劇情弧:無"));
check("只有支線時 Gemini 優先,讓 AI 主線仍開得起來", narrateProviderOrder(clampCtx({ name: "A", sideArc: { theme: "支線題材", stage: 1, maxStage: 3, summary: "支線摘要" } }), true, true)[0] === "gemini-flash");
check("弱模型不會把支線誤認成可推進主線", providerArcUpdate("workers-ai-qwen", { stage: 2 }, false) === null);

// ④ 目錄擴充、唯一性與選種排除。
check("本地種子目錄由 10 擴充到至少 16 條", STORY_ARC_SEEDS.length >= 16, `實際 ${STORY_ARC_SEEDS.length}`);
check("擴充後 seed id/theme 仍各自唯一", new Set(STORY_ARC_SEEDS.map((s) => s.id)).size === STORY_ARC_SEEDS.length && new Set(STORY_ARC_SEEDS.map((s) => s.theme)).size === STORY_ARC_SEEDS.length);
target.sideArc = null;
target.arc = { id: "same_theme", theme: seed.theme, stage: 1, maxStage: 3, summary: "", lastProgressDay: day };
target.arcHistory = [];
check("本地選種排除進行中主線題材", Array.from({ length: 80 }, (_, d) => pickSeedForDay(target, d)).every((s) => s?.theme !== seed.theme));
target.arc = null;
target.arcHistory = [seed.theme];
check("本地選種排除 arcHistory 題材", Array.from({ length: 80 }, (_, d) => pickSeedForDay(target, d)).every((s) => s?.theme !== seed.theme));
target.sideArc = { id: "existing_side", theme: seed.theme, stage: 1, maxStage: 3, summary: "", seedId: seed.id, localDay: day };
check("已有支線時不會再選第二條支線", Array.from({ length: 80 }, (_, d) => pickSeedForDay(target, d)).every((s) => s === null));

// ⑤ 存檔往返與舊檔:新欄位可存；缺 stall 時鐘從載入日開始；舊本地 arc 搬入 sideArc。
target.arc = { id: "save_main", theme: "存檔主線", stage: 2, maxStage: 4, summary: "主", lastProgressDay: day };
target.sideArc = { id: `${LOCAL_ARC_ID_PREFIX}${seed.id}_${day}`, theme: seed.theme, stage: 2, maxStage: seed.stages.length, summary: "支", seedId: seed.id, localDay: day };
save();
const roundTrip = JSON.parse(exportSave()!);
check("主線與支線都寫入存檔", roundTrip.runtimes[target.tenant.id].arc.theme === "存檔主線" && roundTrip.runtimes[target.tenant.id].sideArc.theme === seed.theme);
localStorage.setItem(SAVE_KEY, JSON.stringify(roundTrip));
initGame(); stopGame();
check("現行主線+支線重載後完整還原", state.runtimes[target.tenant.id].arc?.theme === "存檔主線" && state.runtimes[target.tenant.id].sideArc?.theme === seed.theme);

const legacyAi = structuredClone(roundTrip);
delete legacyAi.runtimes[target.tenant.id].arc.lastProgressDay;
delete legacyAi.runtimes[target.tenant.id].sideArc;
localStorage.setItem(SAVE_KEY, JSON.stringify(legacyAi));
initGame(); stopGame();
const loadedAi = state.runtimes[target.tenant.id];
check("舊 AI 弧缺 stall 時鐘時從載入當日開始", loadedAi.arc?.lastProgressDay === gameDayIndex());
localArcPass();
check("舊 AI 弧載入當日不會誤判逾時", loadedAi.arc?.id === "save_main");

const futureClock = structuredClone(roundTrip);
futureClock.runtimes[target.tenant.id].arc.lastProgressDay = gameDayIndex() + 999;
localStorage.setItem(SAVE_KEY, JSON.stringify(futureClock));
initGame(); stopGame();
check("未來的 stall 時鐘載入時夾回當日", state.runtimes[target.tenant.id].arc?.lastProgressDay === gameDayIndex());

const brokenSide = structuredClone(roundTrip);
brokenSide.runtimes[target.tenant.id].sideArc = { id: "bad", theme: "壞支線", stage: 1, maxStage: 3, summary: "缺 seedId" };
localStorage.setItem(SAVE_KEY, JSON.stringify(brokenSide));
initGame(); stopGame();
check("缺 seedId 的壞 sideArc 載入時丟棄,不形成永久死槽", state.runtimes[target.tenant.id].sideArc === null);

const missingLocalDay = structuredClone(roundTrip);
delete missingLocalDay.runtimes[target.tenant.id].sideArc.localDay;
localStorage.setItem(SAVE_KEY, JSON.stringify(missingLocalDay));
initGame(); stopGame();
check("合法 sideArc 缺 localDay 時從載入日開始", state.runtimes[target.tenant.id].sideArc?.localDay === gameDayIndex());

const legacyLocal = structuredClone(roundTrip);
legacyLocal.v = SAVE_VERSION;
legacyLocal.runtimes[target.tenant.id].arc = legacyLocal.runtimes[target.tenant.id].sideArc;
delete legacyLocal.runtimes[target.tenant.id].sideArc;
localStorage.setItem(SAVE_KEY, JSON.stringify(legacyLocal));
initGame(); stopGame();
const loadedLocal = state.runtimes[target.tenant.id];
check("舊本地 arc 載入後搬到 sideArc 並釋放 AI 主線", loadedLocal.arc === null && loadedLocal.sideArc?.seedId === seed.id);
check("additive schema 不需升 SAVE_VERSION", SAVE_VERSION === roundTrip.v);

const overCapMemory = structuredClone(roundTrip);
overCapMemory.runtimes[target.tenant.id].tenant.memoryTags = Array.from({ length: EXPERIENCE_MEMORY_CAP + 2 }, (_, i) => ({
  id: `legacy_exp_${i}`, label: `[經歷:舊篇章${i}]`, behaviorHint: "", acquiredAt: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, source: "ai_event", intensity: i / 10,
}));
localStorage.setItem(SAVE_KEY, JSON.stringify(overCapMemory));
initGame(); stopGame();
const loadedExperiences = state.runtimes[target.tenant.id].tenant.memoryTags;
check("舊檔載入即把超額經歷池收斂到獨立額度", loadedExperiences.length === EXPERIENCE_MEMORY_CAP && !loadedExperiences.some((m) => m.id === "legacy_exp_0" || m.id === "legacy_exp_1"));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
