/**
 * 劇情弧 StoryArc + 事件連鎖 flag(設計檢討 §2 工作項 7)驗證:
 * - sanitizeArcUpdate 消毒(主題截斷/stage 只能 +1/maxStage 夾值/中途不可換主題)
 * - mock AI 全流程:開弧 → 推進 → 收束(留記憶+日誌);context 有餵 arc/flags
 * - 事件選項 flag:sanitizeAiEvent 截斷 → decide 套用 → 去重/cap
 * - arc/flags 存檔往返
 */

// mock localStorage + fetch —— 必須在載入 store 之前
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};
const seenBodies: any[] = [];
let scriptedArcUpdate: unknown = null;
(globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  seenBodies.push(body);
  return {
    ok: true,
    json: async () => ({
      diary: `【AI】${body?.name ?? "?"} 的一天。`,
      newMemory: null,
      event: null,
      summaryUpdate: null,
      arcUpdate: scriptedArcUpdate,
    }),
  };
};

const { state, fastForward, decide, exportSave, initGame, stopGame } = await import("../src/store");
const { diaryTiming } = await import("../src/sim/narration");
diaryTiming.gapMs = 4000; // 測試用:縮短錯開間隔(正式版 25s)
const { sanitizeArcUpdate } = await import("../src/sim/arcs");
const { GROWTH_TAGS, MAX_GROWTH_TAGS, grantGrowthTag, growthBaselineDelta, sanitizeGrowthTags } = await import("../src/sim/growth");
const { baselines } = await import("../src/sim/tick");
const { sanitizeAiEvent } = await import("../src/sim/events");
const { addFlag } = await import("../src/sim/gameState");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}
const waitNarrate = () => new Promise((r) => setTimeout(r, 7000)); // 2 位租客 × (fetch+4s 節流)

// --- 1. sanitizeArcUpdate 單元 ---
check("非物件 → null", sanitizeArcUpdate(null, null) === null && sanitizeArcUpdate("x", null) === null);
check("開新弧但沒主題 → 拒絕", sanitizeArcUpdate({ summary: "沒主題" }, null) === null);
const started = sanitizeArcUpdate({ theme: "一二三四五六七八九十一二三四五六", maxStage: 9, stage: 7, summary: "s".repeat(300) }, null);
check("開新弧:主題截 14 字", started?.kind === "start" && started.arc.theme.length === 14);
check("開新弧:maxStage 夾 2~6、stage 從 1 起", started?.kind === "start" && started.arc.maxStage === 6 && started.arc.stage === 1);
check("開新弧:摘要截 160 字", started?.kind === "start" && started.arc.summary.length === 160);
const cur = { id: "arc_t", theme: "原主題", stage: 2, maxStage: 5, summary: "舊摘要" };
const adv = sanitizeArcUpdate({ theme: "亂改主題", stage: 5, summary: "新摘要", done: false }, cur);
check("推進:stage 最多 +1、主題鎖定", adv?.kind === "advance" && adv.arc.stage === 3 && adv.arc.theme === "原主題");
const back = sanitizeArcUpdate({ stage: 0, done: false }, cur);
check("推進:stage 不可倒退、摘要缺省沿用", back?.kind === "advance" && back.arc.stage === 2 && back.arc.summary === "舊摘要");
check("done=true → 收束", sanitizeArcUpdate({ stage: 3, done: true }, cur)?.kind === "conclude");
check("推到 maxStage 未明說 done=false → 收束", sanitizeArcUpdate({ stage: 5 }, { ...cur, stage: 4 })?.kind === "conclude");

// --- 1b. 成長標籤:只准在收束時從白名單選，永久效果由本地表固定 ---
const growthConclusion = sanitizeArcUpdate({ done: true, growthTag: "more_confident" }, cur);
check("成長標籤:收束時保留白名單 id", growthConclusion?.kind === "conclude" && growthConclusion.growthTag === "more_confident");
const badGrowthConclusion = sanitizeArcUpdate({ done: true, growthTag: "money_plus_999" }, cur);
check("成長標籤:未知 id 不影響弧收束", badGrowthConclusion?.kind === "conclude" && badGrowthConclusion.growthTag === null);
const growthDuringAdvance = sanitizeArcUpdate({ stage: 3, done: false, growthTag: "more_confident" }, cur);
check("成長標籤:中途推進不能授予", growthDuringAdvance?.kind === "advance" && !("growthTag" in growthDuringAdvance));

const holder: { growthTags?: any[] } = {};
check("成長標籤:首次授予成功", grantGrowthTag(holder, "more_confident")?.label === GROWTH_TAGS.more_confident.label);
check("成長標籤:重複 id 不會堆疊", grantGrowthTag(holder, "more_confident") === null && holder.growthTags?.length === 1);
check("成長標籤:未知 id 不會寫入", grantGrowthTag(holder, "unknown") === null && holder.growthTags?.length === 1);
for (const id of ["resilient", "asks_for_help", "grounded", "hopeful", "patient"] as const) grantGrowthTag(holder, id);
check("成長標籤:每人最多四個", holder.growthTags?.length === MAX_GROWTH_TAGS);
check("成長標籤:舊檔正規化去重／去未知／限量", sanitizeGrowthTags(["hopeful", "bad", "hopeful", "patient", "grounded", "decisive", "resilient"]).length === MAX_GROWTH_TAGS);
check("成長標籤:固定 baseline 效果可組合", (() => {
  const d = growthBaselineDelta(["more_confident", "asks_for_help"]);
  return d.mood === 3 && d.stress === -3;
})());

// --- 2. mock AI 全流程:開弧 → 推進 → 收束 ---
const lin = state.runtimes["tenant_lin_asmr"];
scriptedArcUpdate = { theme: "神秘的深夜包裹", maxStage: 3, stage: 1, summary: "門口出現不明包裹", done: false };
fastForward(24); // 日記時段制:快轉一整天,讓每位租客的 diaryHour 都輪到
await waitNarrate();
check("第 1 天:AI 開了新弧", lin.arc?.theme === "神秘的深夜包裹" && lin.arc?.stage === 1);
check("開弧留下 notable 日誌(進 Feed)", lin.log.some((e) => e.importance === "notable" && e.text.includes("新篇章")));

scriptedArcUpdate = { stage: 2, summary: "包裹的寄件人浮出水面", done: false };
seenBodies.length = 0;
fastForward(24);
await waitNarrate();
const linBody = seenBodies.find((b) => b?.name === "林小婕");
check("第 2 天:context 有餵進行中的弧", linBody?.arc?.theme === "神秘的深夜包裹");
check("第 2 天:弧推進到 stage 2", lin.arc?.stage === 2 && lin.arc?.summary === "包裹的寄件人浮出水面");

// 存檔往返(趁弧還在):arc/flags 欄位有入檔
addFlag(lin, "答應保守秘密");
const json = exportSave();
const savedRt = JSON.parse(json!).runtimes["tenant_lin_asmr"];
check("arc 有入存檔", savedRt.arc?.theme === "神秘的深夜包裹" && savedRt.arc?.stage === 2);
check("flags 有入存檔", Array.isArray(savedRt.flags) && savedRt.flags.includes("答應保守秘密"));

scriptedArcUpdate = { stage: 3, summary: "真相大白", done: true };
seenBodies.length = 0;
fastForward(24);
await waitNarrate();
check("第 3 天:context 有餵伏筆旗標", seenBodies.find((b) => b?.name === "林小婕")?.flags?.includes("答應保守秘密"));
check("第 3 天:弧收束清除", lin.arc === null);
check("收束留下記憶", lin.tenant.memoryTags.some((m) => m.label === "[經歷:神秘的深夜包裹]"));
check("收束留下 notable 日誌", lin.log.some((e) => e.importance === "notable" && e.text.includes("篇章落幕")));

// --- 3. 事件連鎖 flag:sanitizeAiEvent → decide → 去重/cap ---
const ev = sanitizeAiEvent({
  title: "測試事件",
  description: "flag 傳遞",
  choices: [
    { label: "留伏筆", hint: "", effect: { flag: "欠房東一次人情外加超出上限的字" } },
    { label: "不留", hint: "", effect: {} },
  ],
});
check("sanitizeAiEvent:flag 截 16 字", ev?.choices[0].effect.flag === "欠房東一次人情外加超出上限的字".slice(0, 16));
lin.pendingEvent = ev;
decide(lin.tenant.id, "ai0", "留伏筆");
check("decide 套用 flag 到 runtime", lin.flags.includes(ev!.choices[0].effect.flag!));
const flagCount = lin.flags.length;
addFlag(lin, "答應保守秘密"); // 重複
check("flag 去重", lin.flags.length === flagCount);
for (let i = 0; i < 20; i++) addFlag(lin, `灌水旗標${i}`);
check("flag cap 12", lin.flags.length === 12);

// --- 3b. arc tone(觀察回饋第三期):enum 消毒 + 固定脈衝 ---
const advT = sanitizeArcUpdate({ stage: 3, done: false, tone: "tense" }, cur);
check("tone 白名單:tense 保留在 advance", advT?.kind === "advance" && advT.tone === "tense");
const advBad = sanitizeArcUpdate({ stage: 3, done: false, tone: "explode" }, cur);
check("tone 未知值 → 忽略(null),弧照常推進", advBad?.kind === "advance" && advBad.tone === null);
const conT = sanitizeArcUpdate({ done: true, tone: "up" }, cur);
check("tone 保留在 conclude", conT?.kind === "conclude" && conT.tone === "up");

{
  const { buildNarrateCtx, produceDailyDiaries, setNarrateImplForTest } = await import("../src/sim/narration");
  diaryTiming.gapMs = 1;
  const rt = state.runtimes["tenant_lin_asmr"];
  rt.arc = { id: "arc_tone", theme: "證照考試", stage: 1, maxStage: 4, summary: "報名了" };
  rt.tenant.growthTags = [];
  rt.tenant.stats.mood = 50;
  rt.tenant.stats.stress = 50;
  const baseBeforeGrowth = baselines(rt);
  const mk = (arcUpdate: unknown) => async (ctx: { name: string }) => ({
    diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
    arcUpdate: ctx.name === rt.tenant.name ? arcUpdate : null, observation: null, ai: true as const,
  });
  setNarrateImplForTest(mk({ stage: 2, summary: "衝刺中", done: false, tone: "tense" }));
  await produceDailyDiaries(true);
  check("推進 tense:壓力 +4、弧到 stage 2", rt.tenant.stats.stress === 54 && rt.arc?.stage === 2);
  setNarrateImplForTest(mk({ stage: 3, summary: "考過了", done: true, tone: "up", growthTag: "more_confident" }));
  await produceDailyDiaries(true);
  check("收束 up:心情 +8、壓力 -6、弧清除", rt.tenant.stats.mood === 58 && rt.tenant.stats.stress === 48 && rt.arc === null);
  check("收束記憶照留", rt.tenant.memoryTags.some((m) => m.label === "[經歷:證照考試]"));
  check("收束成長:永久標籤寫入租客", rt.tenant.growthTags?.includes("more_confident") === true);
  check("收束成長:留下可見的成長因果日誌", rt.log.some((e) => e.text.includes("🌱 成長:[更有自信]")));
  check("收束成長:homeostasis 心情基準永久 +3", baselines(rt).mood === baseBeforeGrowth.mood + 3);
  check("收束成長:後續 AI context 會列出既有特質", buildNarrateCtx(rt, "測試日").growthTags?.includes("[更有自信]") === true);
}

// --- 3c. 雙人劇情弧:開弧守門/同步推進/共同收束/搬離降級 ---
{
  const { produceDailyDiaries, setNarrateImplForTest } = await import("../src/sim/narration");
  const { adjustRelationship, getRel, setCouple } = await import("../src/sim/social");
  const { moveOut } = await import("../src/sim/tenancy");
  const { save } = await import("../src/sim/persistence");
  diaryTiming.gapMs = 1;
  const a = state.runtimes["tenant_lin_asmr"];
  const b = state.runtimes["tenant_chen_engineer"];
  a.arc = null;
  b.arc = null;
  setCouple(a.tenant.id, b.tenant.id, false); // 前面快轉可能撮合成情侶,先還原成純關係值測守門
  const relTo = (v: number) => adjustRelationship(a.tenant.id, b.tenant.id, v - (getRel(a.tenant.id, b.tenant.id)?.value ?? 0));
  const seenArcCtx: any[] = [];
  const mkFor = (name: string, arcUpdate: unknown) => async (ctx: { name: string; arc?: unknown }) => {
    seenArcCtx.push({ name: ctx.name, arc: ctx.arc });
    return {
      diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
      arcUpdate: ctx.name === name ? arcUpdate : null, observation: null, ai: true as const,
    };
  };

  const stW = sanitizeArcUpdate({ theme: "頂樓菜園計畫", maxStage: 4, summary: "想一起種點東西", with: "陳家豪" }, null);
  check("sanitize:開弧的 with 透傳", stW?.kind === "start" && stW.withName === "陳家豪");

  // 關係不足(10):降級為單人弧
  relTo(10);
  setNarrateImplForTest(mkFor(a.tenant.name, { theme: "頂樓菜園計畫", maxStage: 4, summary: "想一起種點東西", with: b.tenant.name }));
  await produceDailyDiaries(true);
  check("關係不足 → 自動降級單人弧", a.arc?.theme === "頂樓菜園計畫" && !a.arc?.partnerId && b.arc === null);
  a.arc = null;

  // 關係夠熟(50):雙人弧成立,兩份同 id、互指對方
  relTo(50);
  setNarrateImplForTest(mkFor(a.tenant.name, { theme: "頂樓菜園計畫", maxStage: 4, summary: "想一起種點東西", with: b.tenant.name }));
  await produceDailyDiaries(true);
  check("雙人弧成立:兩份同 id、互指對方",
    !!a.arc?.partnerId && a.arc?.partnerId === b.tenant.id && b.arc?.partnerId === a.tenant.id && a.arc?.id === b.arc?.id);
  check("雙方都有(與 X 共同)開章日誌",
    a.log.some((e) => e.text.includes(`與 ${b.tenant.name} 共同`)) && b.log.some((e) => e.text.includes(`與 ${a.tenant.name} 共同`)));

  // 推進:A 的日記推進 → B 的 stage/summary 同步;B 的 context 顯示雙人弧
  seenArcCtx.length = 0;
  setNarrateImplForTest(mkFor(a.tenant.name, { stage: 2, summary: "菜苗發芽了", done: false }));
  await produceDailyDiaries(true);
  check("A 推進 → B 同步 stage/summary", a.arc?.stage === 2 && b.arc?.stage === 2 && b.arc?.summary === "菜苗發芽了");
  check("B 的 context 標示雙人弧", seenArcCtx.some((c) => c.name === b.tenant.name && c.arc?.with === a.tenant.name));

  // 收束:B 的日記收束 → 兩人一起落幕、都留記憶
  setNarrateImplForTest(mkFor(b.tenant.name, { stage: 3, summary: "收成了", done: true }));
  await produceDailyDiaries(true);
  check("B 收束 → 兩人的弧都清除", a.arc === null && b.arc === null);
  check("兩人都留下[經歷]記憶",
    a.tenant.memoryTags.some((m) => m.label === "[經歷:頂樓菜園計畫]") && b.tenant.memoryTags.some((m) => m.label === "[經歷:頂樓菜園計畫]"));

  // 對方已有進行中的弧:降級單人、不打擾對方的弧
  b.arc = { id: "arc_busy", theme: "自己的計畫", stage: 1, maxStage: 3, summary: "" };
  setNarrateImplForTest(mkFor(a.tenant.name, { theme: "再開一條線", maxStage: 3, summary: "", with: b.tenant.name }));
  await produceDailyDiaries(true);
  check("對方已有弧 → 降級單人、對方的弧不受影響", a.arc?.theme === "再開一條線" && !a.arc?.partnerId && b.arc?.id === "arc_busy");

  // 搬離降級:另一位主角搬走 → 弧留下但斷開連結 + 日誌
  a.arc = { id: "arc_pair2", theme: "合寫小說", stage: 2, maxStage: 4, summary: "", partnerId: b.tenant.id, partnerName: b.tenant.name };
  b.arc = { id: "arc_pair2", theme: "合寫小說", stage: 2, maxStage: 4, summary: "", partnerId: a.tenant.id, partnerName: a.tenant.name };
  moveOut(b.tenant.id, "測試搬離");
  check("對方搬走 → 弧降級單人繼續", a.arc?.theme === "合寫小說" && !a.arc?.partnerId && !a.arc?.partnerName);
  check("搬離降級留下日誌", a.log.some((e) => e.text.includes("另一位主角") && e.text.includes("搬走了")));
  a.arc = null; // 還原:後面的重載測試預期「收束後 arc 為 null」
  save();
}

// --- 4. 重載還原 ---
// 目前存檔:弧已收束(null)、flags 有 cap 後的 12 筆(decide/fastForward 都會觸發 save)
const savedFlags = JSON.parse(exportSave()!).runtimes["tenant_lin_asmr"].flags;
const savedGrowthTags = JSON.parse(exportSave()!).runtimes["tenant_lin_asmr"].tenant.growthTags;
lin.arc = { id: "dirty", theme: "髒資料", stage: 1, maxStage: 3, summary: "" };
initGame();
stopGame();
const lin2 = state.runtimes["tenant_lin_asmr"];
check("重載後 arc 還原(收束後為 null)", lin2.arc === null);
check("重載後 flags 還原", JSON.stringify(lin2.flags) === JSON.stringify(savedFlags));
check("重載後永久成長標籤還原", JSON.stringify(lin2.tenant.growthTags) === JSON.stringify(savedGrowthTags));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
