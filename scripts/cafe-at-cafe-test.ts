/**
 * CAFE-20:`at_cafe` visualState(租客下樓坐一樓咖啡廳)。
 *
 * 本檔的第一組斷言是 balance 快照零漂移的**直接釘子**:
 * balance-test 跑固定種子 10 個遊戲日,所以「第 0～9 遊戲日在任何情況下都產生不出
 * at_cafe」若成立,快照就不可能因為本系統而漂移。其餘斷言守住 outing.ts 檔頭列的
 * 四條同源設計約束(零 RNG / 固定次序 / 排除 pendingEvent / 冷卻以遊戲日序號計)。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { TENANT_VISUAL_STATES } = await import("../src/types");
const { OBSERVATION_LINES } = await import("../src/content/observationLines");
const routinesJson = (await import("../data/routines.json", { with: { type: "json" } })).default as any;
const {
  CAFE_FIRST_DAY, CAFE_SIT_GAP_DAYS, cafeSitHourForDay, routineSlot, resolveTarget,
} = await import("../src/sim/routine");
const { applyHour } = await import("../src/sim/tick");
const { buildGrid } = await import("../src/floor/map");
const { state, roomOfTenant } = await import("../src/store");
const { GAME_START } = await import("../src/sim/gameState");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ids = Object.keys(state.runtimes).sort();
/** 把遊戲時鐘挪到「第 day 個遊戲日」(gameDayIndex 以 GAME_START 起算的 24h 區塊) */
const setDay = (day: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS + HOUR_MS; };
const openCafe = (open: boolean) => { state.cafe.open = open; };
for (const id of ids) {
  const rt = state.runtimes[id];
  rt.directive = null;
  rt.pendingEvent = null;
  rt.tenant.stats.stress = 40;
}

// ---------------------------------------------------------------------------
// 1) 白名單、文案、資料表
// ---------------------------------------------------------------------------
check("at_cafe 已列入 TENANT_VISUAL_STATES 白名單", TENANT_VISUAL_STATES.includes("at_cafe" as any));
check("at_cafe 有足量本地觀察文案(≥13 句,同 observation-test 門檻)",
  (OBSERVATION_LINES.at_cafe?.length ?? 0) >= 13, `count=${OBSERVATION_LINES.at_cafe?.length}`);
const allSpans = [
  ...Object.values(routinesJson.tenants as Record<string, any[]>).flat(),
  ...Object.values(routinesJson.archetypes as Record<string, any[]>).flat(),
];
check("data/routines.json 的每日作息表沒有寫死 at_cafe(否則兩道閘門形同虛設)",
  allSpans.every((s) => s.state !== "at_cafe"));

// ---------------------------------------------------------------------------
// 2) 🔴 零漂移釘子:balance-test 的 10 遊戲日窗內,任何情況都產不出 at_cafe
// ---------------------------------------------------------------------------
openCafe(true); // 刻意把「開張」閘門打開,單獨考驗 CAFE_FIRST_DAY 日數閘門
let snapshotWindowHits = 0;
for (let day = 0; day < 10; day++) {
  setDay(day);
  for (const id of ids) {
    if (cafeSitHourForDay(id, day) !== null && day >= CAFE_FIRST_DAY) snapshotWindowHits++;
    for (let hour = 0; hour < 24; hour++) {
      if (routineSlot(id, hour).state === "at_cafe") snapshotWindowHits++;
    }
  }
}
check("🔴 第 0～9 遊戲日(balance 快照窗)在咖啡廳已開張下仍完全產不出 at_cafe",
  snapshotWindowHits === 0, `hits=${snapshotWindowHits}`);
check("CAFE_FIRST_DAY 嚴格大於快照窗的 10 個遊戲日", CAFE_FIRST_DAY > 10, `CAFE_FIRST_DAY=${CAFE_FIRST_DAY}`);

// ---------------------------------------------------------------------------
// 3) 閘門一:咖啡廳未開張 → 不觸發(即使已過 CAFE_FIRST_DAY)
// ---------------------------------------------------------------------------
openCafe(false);
let closedHits = 0;
for (let day = CAFE_FIRST_DAY; day < CAFE_FIRST_DAY + 30; day++) {
  setDay(day);
  for (const id of ids) for (let hour = 0; hour < 24; hour++) {
    if (routineSlot(id, hour).state === "at_cafe") closedHits++;
  }
}
check("閘門一:咖啡廳未開張時,第 14～43 遊戲日一律不觸發", closedHits === 0, `hits=${closedHits}`);

// ---------------------------------------------------------------------------
// 4) 閘門二之後 + 已開張 → 真的會觸發
// ---------------------------------------------------------------------------
openCafe(true);
const hits: Array<{ id: string; day: number; hour: number }> = [];
for (let day = CAFE_FIRST_DAY; day < CAFE_FIRST_DAY + 30; day++) {
  setDay(day);
  for (const id of ids) for (let hour = 0; hour < 24; hour++) {
    if (routineSlot(id, hour).state === "at_cafe") hits.push({ id, day, hour });
  }
}
check("咖啡廳開張且過了 CAFE_FIRST_DAY 之後才會觸發", hits.length > 0, `hits=${hits.length}`);
check("每位租客在 30 個遊戲日內都至少下樓一次", new Set(hits.map((h) => h.id)).size === ids.length);
check("每人每個遊戲日最多只有一個 at_cafe 時段",
  new Set(hits.map((h) => `${h.id}|${h.day}`)).size === hits.length);
check("觸發時段落在營業時間內(10～19 點)", hits.every((h) => h.hour >= 10 && h.hour <= 19));
check("下樓頻率符合 CAFE_SIT_GAP_DAYS(每人相鄰兩次至少相隔 5 個遊戲日)", ids.every((id) => {
  const days = hits.filter((h) => h.id === id).map((h) => h.day).sort((a, b) => a - b);
  return days.every((d, i) => i === 0 || d - days[i - 1] >= CAFE_SIT_GAP_DAYS);
}));
check("相位錯開:CAFE_FIRST_DAY 當天不會全樓一起下樓",
  hits.filter((h) => h.day === CAFE_FIRST_DAY).length < ids.length);

// ---------------------------------------------------------------------------
// 5) 決定性 + 零 RNG
// ---------------------------------------------------------------------------
const sample = () => {
  const out: string[] = [];
  for (let day = CAFE_FIRST_DAY; day < CAFE_FIRST_DAY + 30; day++) {
    setDay(day);
    for (const id of ids) out.push(`${id}|${day}|${cafeSitHourForDay(id, day)}|${routineSlot(id, 14).state}`);
  }
  return out.join(",");
};
const first = sample();
check("決定性:同一輸入重複三次結果完全相同", first === sample() && first === sample());

const realRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return realRandom(); };
sample();
Math.random = realRandom;
check("零 RNG:整趟挑日子/挑時段沒有呼叫過 Math.random", randomCalls === 0, `calls=${randomCalls}`);

// ---------------------------------------------------------------------------
// 6) 迭代次序穩定:結果不受 state.runtimes 鍵插入順序影響
// ---------------------------------------------------------------------------
const beforeReorder = sample();
const snapshotRuntimes = { ...state.runtimes };
for (const id of Object.keys(state.runtimes)) delete (state.runtimes as any)[id];
for (const id of [...ids].reverse()) (state.runtimes as any)[id] = snapshotRuntimes[id];
check("迭代次序:反轉 state.runtimes 的鍵插入順序後結果不變",
  sample() === beforeReorder && Object.keys(state.runtimes).join() !== ids.join());

// ---------------------------------------------------------------------------
// 7) 排除 pendingEvent(被事件凍結的租客不下樓)
// ---------------------------------------------------------------------------
const victim = hits[0];
setDay(victim.day);
const vrt = state.runtimes[victim.id];
check("前置:該租客該時段本來會下樓", routineSlot(victim.id, victim.hour).state === "at_cafe");
vrt.pendingEvent = { id: "test", title: "t", text: "t", choices: [] } as any;
check("排除 pendingEvent:凍結中的租客不觸發,退回原作息",
  routineSlot(victim.id, victim.hour).state !== "at_cafe");
vrt.pendingEvent = null;

// ---------------------------------------------------------------------------
// 8) 整合:applyHour 真的會把 visualState 設成 at_cafe,而且目標格落在一樓咖啡廳
// ---------------------------------------------------------------------------
const grid = buildGrid();
setDay(victim.day);
vrt.tenant.stats.stress = 40;
vrt.directive = null;
applyHour(vrt, victim.hour, false);
check("整合:applyHour 後 visualState = at_cafe(沒有被 resolveTarget 失敗吞成 idle)",
  vrt.tenant.visualState === "at_cafe", vrt.tenant.visualState);
const tile = vrt.targetTile;
check("整合:目標格落在一樓咖啡廳區域",
  !!tile && String(grid[tile.r]?.[tile.c]).startsWith("cafe"), JSON.stringify(tile));
check("整合:人下樓了,不算在交誼廳(不會被 3F 社交配對抓走)", vrt.inLounge === false);
const seat = resolveTarget("cafe", roomOfTenant(victim.id));
check("resolveTarget('cafe') 不會誤取租客自己房間的家具",
  !!seat && seat.placement.room.startsWith("cafe"), JSON.stringify(seat?.placement));

// 崩潰仍然優先於下樓(既有壓力偏離行為不受本項影響)
vrt.tenant.stats.stress = 99;
applyHour(vrt, victim.hour, false);
check("既有行為不變:壓力 ≥95 的崩潰偏離仍然覆蓋咖啡廳時段",
  vrt.tenant.visualState === "crying", vrt.tenant.visualState);
vrt.tenant.stats.stress = 40;

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
