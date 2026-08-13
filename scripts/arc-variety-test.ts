/**
 * 劇情弧多樣性 第一階段驗證(強模型接手連載 + 弱模型降權 + 主題去重):
 * - narrateProviderOrder:有進行中的弧時 Gemini 優先;無弧無事件仍走免費 Workers AI
 * - providerArcUpdate:弱模型不得開新弧、不得給 growthTag;已有弧時的推進照常放行
 * - prompt:主題類型清單、已演過主題禁止重複、久未連載時鼓勵開新弧、maxStage 統一 2~6
 * - clampCtx:pastArcThemes 條數/長度夾值;arc.maxStage 夾 2~6
 * - arcHistory:AI 與本地弧收束時寫入、去重、有上限;進 NarrateCtx.pastArcThemes
 * - 舊存檔(沒有 arcHistory 欄位)載入不炸,補成空陣列
 */

// mock localStorage —— 必須在載入 store 之前
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

// ---------------------------------------------------------------------------
// A/B/C-prompt:worker 端純函式
// ---------------------------------------------------------------------------
const { _internal } = await import("../worker/index");
const { clampCtx, buildPrompt, narrateProviderOrder, providerArcUpdate, systemPrompt } = _internal;

const arcCtx = clampCtx({ name: "a", arc: { theme: "頂樓菜園計畫", stage: 2, maxStage: 4, summary: "菜苗發芽了" } });
const plainCtx = clampCtx({ name: "a" });

check("provider 順序:有進行中的弧 → Gemini 優先",
  narrateProviderOrder(arcCtx, true, true).join(",") === "gemini-flash,workers-ai-qwen,workers-ai-llama");
check("provider 順序:無弧無事件的平日仍由免費 Workers AI 主力",
  narrateProviderOrder(plainCtx, true, true).join(",") === "workers-ai-qwen,workers-ai-llama,gemini-flash-lite");
check("provider 順序:有弧但沒有 Gemini 金鑰 → 仍可用 Workers AI",
  narrateProviderOrder(arcCtx, true, false).join(",") === "workers-ai-qwen,workers-ai-llama");

const startUpdate = { theme: "神秘的深夜包裹", maxStage: 3, stage: 1, summary: "門口出現不明包裹", done: false };
const advanceUpdate = { stage: 3, summary: "真相大白", done: false, tone: "tense", growthTag: "more_confident" };
check("弧信任:Workers AI 開新弧一律丟棄",
  providerArcUpdate("workers-ai-qwen", startUpdate, false) === null
  && providerArcUpdate("workers-ai-llama", startUpdate, false) === null);
check("弧信任:Gemini 開新弧照常放行",
  providerArcUpdate("gemini-flash", startUpdate, false) === startUpdate
  && providerArcUpdate("gemini-flash-lite", startUpdate, false) === startUpdate);
check("弧信任:Workers AI 在已有弧時可推進", (() => {
  const kept = providerArcUpdate("workers-ai-qwen", advanceUpdate, true) as Record<string, unknown> | null;
  return !!kept && kept.stage === 3 && kept.summary === "真相大白" && kept.tone === "tense" && kept.done === false;
})());
check("弧信任:Workers AI 的 growthTag 被剝除",
  !("growthTag" in ((providerArcUpdate("workers-ai-qwen", advanceUpdate, true) ?? {}) as object)));
check("弧信任:Gemini 的 growthTag 保留",
  (providerArcUpdate("gemini-flash", advanceUpdate, true) as any)?.growthTag === "more_confident");
check("弧信任:非物件 arcUpdate → null", providerArcUpdate("workers-ai-qwen", null, true) === null);

check("prompt 含 8~12 類主題類型清單",
  ["職涯轉折", "親密關係", "健康與身心", "金錢困境", "家庭與過去", "創作與嗜好", "鄰里衝突與和解", "秘密與謊言", "寵物與照顧", "搬遷與告別", "意外訪客", "習慣養成"]
    .every((kind) => systemPrompt.includes(kind)));
check("prompt 明令不得重複已演過的主題", systemPrompt.includes("不得重複已演過的主題") && systemPrompt.includes("相同或近義"));
check("prompt 改成鼓勵開新弧(不再是「平淡的日子就填 null,不要硬開」)",
  systemPrompt.includes("只要近期沒有連載,就優先開一條新的") && !systemPrompt.includes("平淡的日子就填 null"));
check("prompt 保留「重大事件與弧無關時不要硬串」防線", systemPrompt.includes("不要硬把兩件事串在一起"));
check("prompt 的 maxStage 與消毒層一致(2~6)", systemPrompt.includes('"maxStage":2~6') && !systemPrompt.includes('"maxStage":3~5'));

check("clampCtx:pastArcThemes 夾 ≤8 條、每條 ≤14 字", (() => {
  const c = clampCtx({ name: "a", pastArcThemes: Array.from({ length: 20 }, (_, i) => `主${i}`.repeat(20)) });
  return c.pastArcThemes!.length === 8 && c.pastArcThemes!.every((t) => t.length <= 14);
})());
check("clampCtx:缺 pastArcThemes → 空陣列且不進 prompt", (() => {
  const c = clampCtx({ name: "a" });
  return c.pastArcThemes!.length === 0 && !buildPrompt(c).includes("已演過的主題");
})());
check("clampCtx:arc.maxStage 夾 2~6", (() => {
  const hi = clampCtx({ name: "a", arc: { theme: "t", stage: 9, maxStage: 99, summary: "s" } });
  const lo = clampCtx({ name: "a", arc: { theme: "t", stage: 1, maxStage: 1, summary: "s" } });
  return hi.arc!.maxStage === 6 && hi.arc!.stage <= 6 && lo.arc!.maxStage === 2;
})());
check("buildPrompt:有歷史時列出已演過的主題並要求換題材", (() => {
  const prompt = buildPrompt(clampCtx({ name: "a", pastArcThemes: ["神秘的深夜包裹", "頂樓菜園計畫"] }));
  return prompt.includes("已演過的主題") && prompt.includes("神秘的深夜包裹") && prompt.includes("頂樓菜園計畫")
    && prompt.includes("不可重複或近義");
})());
check("buildPrompt:沒有進行中的弧時鼓勵開新弧",
  buildPrompt(clampCtx({ name: "a" })).includes("優先開一條新的"));

// ---------------------------------------------------------------------------
// C:arcHistory 收束寫入 / 上限 / 進 ctx / 舊存檔相容
// ---------------------------------------------------------------------------
const { state, initGame, stopGame, exportSave } = await import("../src/store");
const { ARC_HISTORY_CAP, pushArcHistory } = await import("../src/sim/gameState");
const { SAVE_KEY } = await import("../src/sim/persistence");
const { buildNarrateCtx, produceDailyDiaries, setNarrateImplForTest, diaryTiming } = await import("../src/sim/narration");
diaryTiming.gapMs = 1;

const rt = state.runtimes["tenant_lin_asmr"];

// 單元:去重 + 上限
const solo: any = { arc: null };
pushArcHistory(solo, "主題A");
pushArcHistory(solo, "  ");
check("pushArcHistory:空字串不寫入", solo.arcHistory.length === 1);
pushArcHistory(solo, "主題B");
pushArcHistory(solo, "主題A");
check("pushArcHistory:重複主題移到最新、不占兩格",
  solo.arcHistory.length === 2 && solo.arcHistory[1] === "主題A");
for (let i = 0; i < 20; i++) pushArcHistory(solo, `灌水主題${i}`);
check(`pushArcHistory:上限 ${ARC_HISTORY_CAP} 條、丟最舊`,
  solo.arcHistory.length === ARC_HISTORY_CAP && solo.arcHistory[ARC_HISTORY_CAP - 1] === "灌水主題19");

// AI 路徑:收束一條弧 → 主題進歷史 → 隔天的 ctx 帶上
rt.arcHistory = [];
rt.arc = { id: "arc_variety", theme: "考潛水證照", stage: 3, maxStage: 3, summary: "最後一堂課" };
setNarrateImplForTest(async (ctx) => ({
  diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
  arcUpdate: ctx.name === rt.tenant.name ? { stage: 3, summary: "拿到證照", done: true } : null,
  observation: null, ai: true as const,
}));
await produceDailyDiaries(true);
check("AI 弧收束:主題寫入 arcHistory", rt.arc === null && rt.arcHistory?.includes("考潛水證照") === true);
check("收束後的 ctx 帶上 pastArcThemes",
  buildNarrateCtx(rt, "測試日").pastArcThemes?.includes("考潛水證照") === true);

// 本地種子弧路徑:收束也要記錄
{
  const { localArcPass } = await import("../src/sim/localArc");
  const { STORY_ARC_SEEDS } = await import("../src/content/storyArcs");
  const { gameDayIndex } = await import("../src/sim/gameState");
  const seed = STORY_ARC_SEEDS[0];
  const day = gameDayIndex();
  rt.arc = {
    id: `larc_${seed.id}_x`, theme: seed.theme, stage: seed.stages.length,
    maxStage: seed.stages.length, summary: "最後一步", seedId: seed.id, localDay: day - 9,
  };
  localArcPass();
  check("本地種子弧收束:主題也寫入 arcHistory",
    rt.arc === null && rt.arcHistory?.includes(seed.theme) === true);
}

// 存檔往返 + 舊存檔相容
{
  const { save } = await import("../src/sim/persistence");
  rt.arcHistory = ["考潛水證照", "頂樓菜園計畫"];
  save();
  const saved = JSON.parse(exportSave()!);
  check("arcHistory 有入存檔",
    JSON.stringify(saved.runtimes["tenant_lin_asmr"].arcHistory) === JSON.stringify(["考潛水證照", "頂樓菜園計畫"]));
  initGame();
  stopGame();
  check("重載後 arcHistory 還原",
    JSON.stringify(state.runtimes["tenant_lin_asmr"].arcHistory) === JSON.stringify(["考潛水證照", "頂樓菜園計畫"]));

  // 舊存檔:完全沒有 arcHistory 欄位(且不升 SAVE_VERSION)
  const legacy = JSON.parse(exportSave()!);
  const savedVersion = legacy.v;
  for (const r of Object.values<any>(legacy.runtimes)) delete r.arcHistory;
  localStorage.setItem(SAVE_KEY, JSON.stringify(legacy));
  let loadOk = true;
  try { initGame(); stopGame(); } catch { loadOk = false; }
  const legacyRt = state.runtimes["tenant_lin_asmr"];
  check("舊存檔(無 arcHistory)載入不炸,補成空陣列",
    loadOk && Array.isArray(legacyRt.arcHistory) && legacyRt.arcHistory.length === 0);
  const { SAVE_VERSION } = await import("../src/sim/persistence");
  check("arcHistory 是選填欄位,SAVE_VERSION 不需要升", savedVersion === SAVE_VERSION);
  check("舊存檔載入後 ctx 的 pastArcThemes 為空陣列而非 undefined",
    Array.isArray(buildNarrateCtx(legacyRt, "測試日").pastArcThemes));
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
