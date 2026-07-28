/**
 * 夢境彩蛋(sim/dreams.ts)驗證:
 * - 零 RNG:整段 dreamPass 不呼叫 Math.random(呼叫次數必須為 0)
 * - 決定性:同一遊戲日、同一租客重複跑,文案完全一致
 * - 前 DREAM_FIRST_DAY 天不觸發(balance-test 的 10 遊戲日碰不到本系統 → 快照零漂移)
 * - 一夜最多一夢:gameDayIndex 以 22:00 換日,整個 22:00→06:00 只會產生一則
 * - 冷卻間隔決定性地落在 3~4 遊戲日,且冷卻入存檔(reload 後不會當晚再做夢)
 * - 有 pendingEvent(被事件凍結、visualState 停在舊值)的租客不做夢
 * - 主題選材:有記憶走記憶池、只有關係走關係池、兩者皆無走保底池;佔位符全部代換乾淨
 * - 純風味:跑前後 mood/stress/energy/wellbeing/affinity/滿意度/關係值完全不變
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32);本測試同時會統計 Math.random 呼叫次數
let __seed = 20260729;
let randomCalls = 0;
Math.random = () => {
  randomCalls++;
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state } = await import("../src/store");
const {
  dreamPass, resetDreamCooldown, pickDreamTheme, dreamLine,
  DREAM_FIRST_DAY, DREAM_MIN_GAP_DAYS, DREAM_THEMES,
} = await import("../src/sim/dreams");
const { GAME_START, gameDayIndex } = await import("../src/sim/gameState");
const { relationships, adjustRelationship } = await import("../src/sim/social");
const { save, load } = await import("../src/sim/persistence");
const { DREAM_NEUTRAL_LINES } = await import("../src/content/dreamLines");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
/** 把遊戲時間放到第 day 個遊戲日開始後的第 offset 小時(gameDayIndex 以 GAME_START 的 22:00 為原點) */
function setDayHour(day: number, offset = 12) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + offset * 3600 * 1000;
}
/** 目前這一小時的本地時鐘(遊戲作息全用本地 getHours(),測試不硬寫數字) */
const curHour = () => new Date(state.gameMs).getHours();

const ids = Object.keys(state.runtimes);
const A = ids[0];

function sleepAll(vs: "sleeping_on_bed" | "sleeping_on_couch" = "sleeping_on_bed") {
  for (const rt of Object.values(state.runtimes)) {
    rt.tenant.visualState = vs;
    rt.pendingEvent = null;
  }
}
function clearLogs() {
  for (const rt of Object.values(state.runtimes)) rt.log.splice(0, rt.log.length);
}
const dreamLogs = (id: string) => state.runtimes[id].log.filter((l) => l.text.startsWith("💤"));
const allDreams = () => ids.flatMap((id) => dreamLogs(id).map((l) => l.text));
/** 完整清場:冷卻、日誌、姿勢 */
function reset() {
  resetDreamCooldown();
  clearLogs();
  sleepAll();
}
/** 數值快照(夢境不得動到任何一項) */
function statsSnapshot(): string {
  return JSON.stringify({
    tenants: ids.map((id) => {
      const rt = state.runtimes[id];
      return { s: rt.tenant.stats, sat: rt.satisfaction, unhappy: rt.unhappyHours, flags: rt.flags.length, mem: rt.tenant.memoryTags.length };
    }),
    rels: Object.entries(relationships).map(([k, r]) => [k, r.value, r.romantic]),
    money: state.money,
  });
}

check("測試前置:至少兩位租客", ids.length >= 2);
check("門檻涵蓋 balance-test 的 10 遊戲日", DREAM_FIRST_DAY > 10, `DREAM_FIRST_DAY=${DREAM_FIRST_DAY}`);

// --- 1. 前 DREAM_FIRST_DAY 天完全不觸發 ---------------------------------------
reset();
for (let d = 0; d < DREAM_FIRST_DAY; d++) {
  for (let h = 0; h < 24; h++) {
    setDayHour(d, h);
    sleepAll();
    dreamPass(curHour());
  }
}
check("門檻:前 14 個遊戲日一則夢都不產生", allDreams().length === 0, `實際 ${allDreams().length} 則`);

// --- 2. 第 14 天開始做夢 -------------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
dreamPass(curHour());
check("觸發:第 14 個遊戲日每位睡著的租客各留一則夢", ids.every((id) => dreamLogs(id).length === 1));
check("觸發:文字以「💤 」開頭", allDreams().every((t) => t.startsWith("💤 ")));
check("觸發:日誌 importance 為 notable(會進 Feed)", state.runtimes[A].log.every((l) => l.importance === "notable"));
check("觸發:沒有殘留未代換的佔位符", allDreams().every((t) => !/[{}]/.test(t)));
check("觸發:記憶方括號已去掉", allDreams().every((t) => !/[[\]]/.test(t)));

// --- 3. 一夜最多一夢(22:00 → 06:00 同屬一個遊戲日)-----------------------------
reset();
const nightDay = DREAM_FIRST_DAY;
const hoursSeen: number[] = [];
for (let offset = 0; offset <= 9; offset++) { // 22:00 → 07:00
  setDayHour(nightDay, offset);
  sleepAll();
  hoursSeen.push(curHour());
  dreamPass(curHour());
}
check("一夜一夢:22:00→07:00 跨 10 個小時只產生一則", ids.every((id) => dreamLogs(id).length === 1), JSON.stringify(ids.map((id) => dreamLogs(id).length)));
check("一夜一夢:整夜確實同屬一個遊戲日", gameDayIndex() === nightDay && hoursSeen.includes(22) && hoursSeen.includes(6), JSON.stringify(hoursSeen));

// --- 4. 冷卻間隔 3~4 遊戲日 ----------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
dreamPass(curHour());
const lastDay: Record<string, number> = Object.fromEntries(ids.map((id) => [id, DREAM_FIRST_DAY]));
const gaps: number[] = [];
for (let d = DREAM_FIRST_DAY + 1; d <= DREAM_FIRST_DAY + 40; d++) {
  setDayHour(d, 0);
  sleepAll();
  const before = Object.fromEntries(ids.map((id) => [id, dreamLogs(id).length]));
  dreamPass(curHour());
  for (const id of ids) {
    if (dreamLogs(id).length > before[id]) {
      gaps.push(d - lastDay[id]);
      lastDay[id] = d;
    }
  }
}
check("冷卻:40 天內確實反覆做夢", gaps.length >= 15, `實際 ${gaps.length} 次`);
check("冷卻:間隔一律落在 3~4 遊戲日", gaps.every((g) => g >= DREAM_MIN_GAP_DAYS && g <= DREAM_MIN_GAP_DAYS + 1), JSON.stringify(gaps));
check("冷卻:同一晚不會補第二則", ids.every((id) => dreamLogs(id).length <= Math.ceil(41 / DREAM_MIN_GAP_DAYS)));

// --- 5. 冷卻入存檔:reload 後不會當晚再做夢 -------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
dreamPass(curHour());
check("存檔:冷卻寫在 interactionCooldowns", state.interactionCooldowns[`dream|${A}`] === DREAM_FIRST_DAY);
save();
resetDreamCooldown();
check("存檔:load 前冷卻確實被清掉", state.interactionCooldowns[`dream|${A}`] === undefined);
load();
check("存檔:冷卻完整還原", state.interactionCooldowns[`dream|${A}`] === DREAM_FIRST_DAY);
setDayHour(DREAM_FIRST_DAY + 1, 0);
sleepAll();
const beforeReload = dreamLogs(A).length;
dreamPass(curHour());
check("存檔:reload 後隔天不會馬上又做夢", dreamLogs(A).length === beforeReload);

// --- 6. 被事件凍結的租客不做夢 --------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
state.runtimes[A].pendingEvent = {
  id: "test_pending",
  title: "測試待決",
  description: "測試用",
  choices: [{ id: "a", label: "選項甲", hint: "無" }],
} as any;
dreamPass(curHour());
check("pendingEvent:被事件凍結的租客不做夢", dreamLogs(A).length === 0);
check("pendingEvent:其他人照常做夢", ids.slice(1).every((id) => dreamLogs(id).length === 1));
state.runtimes[A].pendingEvent = null;

// --- 7. 沒睡就不做夢 -----------------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
for (const rt of Object.values(state.runtimes)) rt.tenant.visualState = "idle";
dreamPass(curHour());
check("觸發條件:醒著/外出的租客不做夢", allDreams().length === 0);
sleepAll("sleeping_on_couch");
dreamPass(curHour());
check("觸發條件:沙發睡死也算睡著", ids.every((id) => dreamLogs(id).length === 1));

// --- 8. 零 RNG ----------------------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
const callsBefore = randomCalls;
dreamPass(curHour());
for (const id of ids) pickDreamTheme(state.runtimes[id]);
const rngUsed = randomCalls - callsBefore;
check("零 RNG:dreamPass/pickDreamTheme 期間不呼叫 Math.random", rngUsed === 0, `實際呼叫 ${rngUsed} 次`);

// --- 9. 決定性 ----------------------------------------------------------------
function transcript(): string {
  reset();
  setDayHour(DREAM_FIRST_DAY, 0);
  sleepAll();
  dreamPass(curHour());
  return allDreams().join("\n");
}
const runA = transcript();
const runB = transcript();
check("決定性:同一天同一批租客兩次跑出完全相同文案", runA === runB, `\n  A=${runA}\n  B=${runB}`);
check("決定性:文案有實際內容", runA.split("\n").length === ids.length && runA.length > 20);

// --- 10. 主題選材:記憶 / 關係 / 保底 -------------------------------------------
const rt = state.runtimes[A];
const originalMemory = rt.tenant.memoryTags;
const originalRels = JSON.parse(JSON.stringify(relationships));
const clearRels = () => { for (const k of Object.keys(relationships)) delete relationships[k]; };
const restoreRels = () => {
  clearRels();
  for (const [k, v] of Object.entries(originalRels)) (relationships as any)[k] = v;
};

setDayHour(DREAM_FIRST_DAY, 0);
// 10a) 無記憶、無關係 → 保底池
rt.tenant.memoryTags = [];
clearRels();
const neutral = pickDreamTheme(rt);
check("保底池:無記憶無關係時走 DREAM_NEUTRAL_LINES", neutral.themeId === "neutral" && neutral.lines === DREAM_NEUTRAL_LINES);
const neutralText = dreamLine(rt, DREAM_FIRST_DAY, curHour());
check("保底池:文案在保底池內且無佔位符", DREAM_NEUTRAL_LINES.includes(neutralText) && !/[{}]/.test(neutralText));

// 10b) 無記憶、有關係 → 關係池(名字被代換)
const other = state.runtimes[ids[1]].tenant;
adjustRelationship(A, other.id, 60);
const bond = pickDreamTheme(rt);
const bondText = dreamLine(rt, DREAM_FIRST_DAY, curHour());
check("關係池:好朋友以上走親近池", bond.themeId === "bond", bond.themeId);
check("關係池:對方名字與親疏文字都塞得進去", bond.vars.o === other.name && !!bond.vars.tier && !/[{}]/.test(bondText));
clearRels();
adjustRelationship(A, other.id, 8);
const distant = pickDreamTheme(rt);
check("關係池:還不熟時走疏遠池", distant.themeId === "distant", `${distant.themeId} value=${JSON.stringify(distant.vars)}`);

// 10c) 有記憶 → 記憶池優先,且主題對得上關鍵字
let themeHits = 0;
for (const theme of DREAM_THEMES) {
  rt.tenant.memoryTags = [{
    id: `test_${theme.id}`,
    label: `[${theme.keywords[0]}]`,
    behaviorHint: "測試用",
    acquiredAt: "2026-07-20T00:00:00.000Z",
    source: "system",
  }];
  const picked = pickDreamTheme(rt);
  const text = dreamLine(rt, DREAM_FIRST_DAY, curHour());
  if (picked.themeId === theme.id && picked.vars.m === theme.keywords[0] && !/[{}[\]]/.test(text)) themeHits++;
}
check("記憶池:每個主題的關鍵字都選得到對應句池", themeHits === DREAM_THEMES.length, `${themeHits}/${DREAM_THEMES.length}`);
check("記憶池:主題數與句池都非空", DREAM_THEMES.length >= 8 && DREAM_THEMES.every((t) => t.lines.length >= 13 && t.keywords.length > 0));

rt.tenant.memoryTags = [{
  id: "test_priority",
  label: "[失戀]",
  behaviorHint: "測試用",
  acquiredAt: "2026-07-20T00:00:00.000Z",
  source: "system",
}];
adjustRelationship(A, other.id, 80);
check("優先序:有記憶時記憶主題優先於關係主題", pickDreamTheme(rt).themeId === "heartbreak");

rt.tenant.memoryTags = originalMemory;
restoreRels();

// --- 11. 純風味:零數值副作用 ---------------------------------------------------
reset();
setDayHour(DREAM_FIRST_DAY, 0);
sleepAll();
const before = statsSnapshot();
dreamPass(curHour());
const after = statsSnapshot();
check("零副作用:mood/stress/energy/滿意度/關係值/金錢完全不變", before === after, `\n  before=${before}\n  after =${after}`);
check("零副作用:確實有做夢(不是空轉才沒變)", allDreams().length === ids.length);

// --- 12. resetDreamCooldown 清乾淨 ---------------------------------------------
resetDreamCooldown();
check("resetDreamCooldown:清掉所有 dream| 冷卻", !Object.keys(state.interactionCooldowns).some((k) => k.startsWith("dream|")));
clearLogs();

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
