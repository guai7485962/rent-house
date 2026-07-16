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
  const { produceDailyDiaries, setNarrateImplForTest } = await import("../src/sim/narration");
  diaryTiming.gapMs = 1;
  const rt = state.runtimes["tenant_lin_asmr"];
  rt.arc = { id: "arc_tone", theme: "證照考試", stage: 1, maxStage: 4, summary: "報名了" };
  rt.tenant.stats.mood = 50;
  rt.tenant.stats.stress = 50;
  const mk = (arcUpdate: unknown) => async (ctx: { name: string }) => ({
    diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null,
    arcUpdate: ctx.name === rt.tenant.name ? arcUpdate : null, observation: null, ai: true as const,
  });
  setNarrateImplForTest(mk({ stage: 2, summary: "衝刺中", done: false, tone: "tense" }));
  await produceDailyDiaries(true);
  check("推進 tense:壓力 +4、弧到 stage 2", rt.tenant.stats.stress === 54 && rt.arc?.stage === 2);
  setNarrateImplForTest(mk({ stage: 3, summary: "考過了", done: true, tone: "up" }));
  await produceDailyDiaries(true);
  check("收束 up:心情 +8、壓力 -6、弧清除", rt.tenant.stats.mood === 58 && rt.tenant.stats.stress === 48 && rt.arc === null);
  check("收束記憶照留", rt.tenant.memoryTags.some((m) => m.label === "[經歷:證照考試]"));
}

// --- 4. 重載還原 ---
// 目前存檔:弧已收束(null)、flags 有 cap 後的 12 筆(decide/fastForward 都會觸發 save)
const savedFlags = JSON.parse(exportSave()!).runtimes["tenant_lin_asmr"].flags;
lin.arc = { id: "dirty", theme: "髒資料", stage: 1, maxStage: 3, summary: "" };
initGame();
stopGame();
const lin2 = state.runtimes["tenant_lin_asmr"];
check("重載後 arc 還原(收束後為 null)", lin2.arc === null);
check("重載後 flags 還原", JSON.stringify(lin2.flags) === JSON.stringify(savedFlags));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
