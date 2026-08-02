/**
 * CAFE-21 `groupScene` 的 cafe venue + `at_cafe` 的 `EFFECT` 數值效果。
 *
 * 兩件事共用一支測試,因為它們共用同一條零漂移論證:
 * 走位完全不用 RNG、`at_cafe` 兩道閘門(`cafe.open` + `CAFE_FIRST_DAY`)在 balance 快照的
 * 10 個遊戲日窗內不可能成立 ⇒ 兩者都碰不到 `scripts/balance-snapshot.json`。
 *
 * 本檔最重要的是第 2 節:`lounge` / `rooftop` 的**既有行為回歸釘子**。
 * `lounge` 的期望值不是抄現行輸出,而是把改動前的 `anchorFor()` / `loungeTiles()`
 * 逐字複製成參考實作再比對 ⇒ 只要 venue 重構動到 lounge 的挑格邏輯就會紅。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state } = await import("../src/store");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const {
  startGroupScene, groupSceneView, groupSceneFor, clearGroupScene,
} = await import("../src/floor/groupScene");
const { buildGrid, LOUNGE_HALL_RECT, CAFE_RECTS } = await import("../src/floor/map");
const { currentBlocked } = await import("../src/floor/pathfind");
const { generateHourly } = await import("../src/sim/generate");
const { CAFE_FIRST_DAY, cafeSitHourForDay, routineSlot } = await import("../src/sim/routine");
const { GAME_START } = await import("../src/sim/gameState");
import type { Tile } from "../src/floor/pathfind";
import type { GroupSceneLayout } from "../src/floor/groupScene";
import type { StatDeltas, TenantVisualState } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
const ids = Object.keys(state.runtimes).sort().slice(0, 3);
check("三位場景參與者就緒", ids.length === 3);

const grid = buildGrid();
const LAYOUTS: GroupSceneLayout[] = ["cluster", "table", "watch", "storm", "farewell"];
const key = (t: Tile | null) => (t ? `${t.c},${t.r}` : "null");

/** 起一個場景並回傳走位(含 hidden);priority 3 確保不被前一個場景擋住。 */
function run(venue: "lounge" | "rooftop" | "cafe", layout: GroupSceneLayout) {
  clearGroupScene();
  const ok = startGroupScene({
    id: `test:${venue}:${layout}`,
    title: "測試",
    venue,
    layout,
    participantIds: ids,
    gameNow: state.gameMs,
    priority: 3,
  });
  const view = groupSceneView();
  return {
    ok,
    tiles: view?.actors.map((a) => a.tile) ?? [],
    hidden: groupSceneFor(ids[0], state.gameMs)?.hidden,
  };
}

// ---------------------------------------------------------------------------
// 1) CAFE-21:cafe venue 走 lounge 那條路線(真實座標、不隱藏)
// ---------------------------------------------------------------------------
const cafeRuns = LAYOUTS.map((layout) => ({ layout, ...run("cafe", layout) }));
check("cafe 場景可以成立(五種 layout 全部)", cafeRuns.every((r) => r.ok && r.tiles.length === 3));
check("cafe 每位演員都拿到真實 tile(不是 rooftop 的 null)",
  cafeRuns.every((r) => r.tiles.every((t) => !!t)));
check("cafe 站位互不重疊",
  cafeRuns.every((r) => new Set(r.tiles.map(key)).size === 3));
check("cafe 走位全部落在一樓 cafe_floor 且可走",
  cafeRuns.every((r) => r.tiles.every((t) => !!t
    && grid[t.r]?.[t.c] === "cafe_floor"
    && currentBlocked()[t.r]?.[t.c] === false)),
  JSON.stringify(cafeRuns.map((r) => r.tiles.map((t) => (t ? grid[t.r]?.[t.c] : null)))));
check("cafe 走位在 CAFE_RECTS.cafe_floor 矩形內",
  cafeRuns.every((r) => r.tiles.every((t) => !!t
    && t.c >= CAFE_RECTS.cafe_floor.c0 && t.c <= CAFE_RECTS.cafe_floor.c1
    && t.r >= CAFE_RECTS.cafe_floor.r0 && t.r <= CAFE_RECTS.cafe_floor.r1)));
check("cafe 的 hidden = false(人在主平面上,和 lounge 一樣要畫出來)",
  cafeRuns.filter((r) => r.layout !== "farewell").every((r) => r.hidden === false),
  JSON.stringify(cafeRuns.map((r) => `${r.layout}=${r.hidden}`)));
check("cafe + farewell 仍走既有的歡送小舞台規則(hidden = true)",
  cafeRuns.find((r) => r.layout === "farewell")?.hidden === true);

// layout 真的會換錨點:點餐靠吧台(cafe_counter 下方)、看熱鬧靠寵物區。
const cafeTable = cafeRuns.find((r) => r.layout === "table")!.tiles;
const cafeWatch = cafeRuns.find((r) => r.layout === "watch")!.tiles;
check("cafe/table 走位聚在吧台側(c ≤ 6)", cafeTable.every((t) => !!t && t.c <= 6), JSON.stringify(cafeTable));
check("cafe/watch 走位偏向寵物區側(至少一格 c ≥ 9)",
  cafeWatch.some((t) => !!t && t.c >= 9), JSON.stringify(cafeWatch));
check("cafe/table 與 cafe/cluster 的走位不同(錨點確實有作用)",
  cafeTable.map(key).join() !== cafeRuns.find((r) => r.layout === "cluster")!.tiles.map(key).join());

// 決定性 + 零 RNG(走位不得位移模擬的亂數序列)
const sampleCafe = () => LAYOUTS.map((l) => run("cafe", l).tiles.map(key).join("|")).join(";");
const firstCafe = sampleCafe();
check("cafe 走位決定性:同輸入重複三次完全相同", firstCafe === sampleCafe() && firstCafe === sampleCafe());
const realRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return realRandom(); };
sampleCafe();
Math.random = realRandom;
check("🔴 cafe 走位零 RNG:整趟沒有呼叫過 Math.random", randomCalls === 0, `calls=${randomCalls}`);

// ---------------------------------------------------------------------------
// 2) 🔴 回歸釘子:lounge / rooftop 的既有行為完全沒變
// ---------------------------------------------------------------------------
/** 改動前的 `anchorFor()`(逐字複製) */
function refAnchorFor(layout: GroupSceneLayout): Tile {
  if (layout === "table") return { c: 3, r: 12 };
  if (layout === "watch") return { c: 11, r: 12 };
  return { c: 8, r: 11 };
}
/** 改動前的 `loungeTiles()`(逐字複製) */
function refLoungeTiles(count: number, layout: GroupSceneLayout): Tile[] {
  const blocked = currentBlocked();
  const anchor = refAnchorFor(layout);
  const open: Tile[] = [];
  for (let r = LOUNGE_HALL_RECT.r0; r <= LOUNGE_HALL_RECT.r1; r++) {
    for (let c = LOUNGE_HALL_RECT.c0; c <= LOUNGE_HALL_RECT.c1; c++) {
      if (blocked[r]?.[c] === false) open.push({ c, r });
    }
  }
  open.sort((a, b) => {
    const da = Math.abs(a.c - anchor.c) + Math.abs(a.r - anchor.r);
    const db = Math.abs(b.c - anchor.c) + Math.abs(b.r - anchor.r);
    return da - db || a.r - b.r || a.c - b.c;
  });
  return open.slice(0, count);
}

const loungeRuns = LAYOUTS.map((layout) => ({ layout, ...run("lounge", layout) }));
check("🔴 lounge 走位與改動前的參考實作逐格相同(五種 layout)",
  loungeRuns.every((r) => r.tiles.map(key).join() === refLoungeTiles(3, r.layout).map(key).join()),
  JSON.stringify(loungeRuns.map((r) => `${r.layout}:${r.tiles.map(key).join("|")}`)));
check("lounge 走位仍落在交誼廳大廳且互不重疊",
  loungeRuns.every((r) => new Set(r.tiles.map(key)).size === 3
    && r.tiles.every((t) => !!t && grid[t.r]?.[t.c] === "lounge")));
// 現行座標的黃金值:參考實作若哪天連同本體一起被改壞,這一條仍會紅。
check("🔴 lounge 黃金座標未變(cluster / table / watch)",
  loungeRuns.find((r) => r.layout === "cluster")!.tiles.map(key).join("|") === "8,11|8,10|7,11"
  && loungeRuns.find((r) => r.layout === "table")!.tiles.map(key).join("|") === "4,12|3,13|3,10"
  && loungeRuns.find((r) => r.layout === "watch")!.tiles.map(key).join("|") === "11,12|10,12|12,12",
  JSON.stringify(loungeRuns.map((r) => `${r.layout}:${r.tiles.map(key).join("|")}`)));
check("🔴 lounge 的 hidden 規則未變(非 farewell = false、farewell = true)",
  loungeRuns.every((r) => r.hidden === (r.layout === "farewell")));

const roofRuns = LAYOUTS.map((layout) => ({ layout, ...run("rooftop", layout) }));
check("🔴 rooftop 仍可成立且演員一律沒有主平面座標(tile = null)",
  roofRuns.every((r) => r.ok && r.tiles.length === 3 && r.tiles.every((t) => t === null)));
check("🔴 rooftop 的 hidden 恆為 true(五種 layout)", roofRuns.every((r) => r.hidden === true));

// 優先權規則未變:低 priority 蓋不掉高 priority,不分場地。
clearGroupScene();
startGroupScene({
  id: "test:hold", title: "章節場景", venue: "lounge", layout: "cluster",
  participantIds: ids, gameNow: state.gameMs, priority: 2,
});
check("既有優先權規則未變:cafe 場景(priority 1)蓋不掉 lounge 章節場景(priority 2)",
  startGroupScene({
    id: "test:cafe-low", title: "咖啡廳", venue: "cafe", layout: "cluster",
    participantIds: ids, gameNow: state.gameMs, priority: 1,
  }) === false && groupSceneView()?.id === "test:hold");
check("同權重可接手:cafe 場景(priority 2)能接管舞台",
  startGroupScene({
    id: "test:cafe-eq", title: "咖啡廳", venue: "cafe", layout: "cluster",
    participantIds: ids, gameNow: state.gameMs, priority: 2,
  }) === true && groupSceneView()?.venue === "cafe");
clearGroupScene();

// ---------------------------------------------------------------------------
// 3) `at_cafe` 的 EFFECT 條目
// ---------------------------------------------------------------------------
const deltasOf = (visual: TenantVisualState, furnitureDefId?: string): StatDeltas => generateHourly({
  tenantId: ids[0],
  tenantName: "測試",
  hour: 15,
  timeLabel: "15:00",
  state: visual,
  isDeviation: false,
  recentSummary: "",
  furnitureDefId,
}).statDeltas;

const cafeEffect = deltasOf("at_cafe");
check("at_cafe 有 EFFECT 條目(該小時不再是數值真空)", Object.keys(cafeEffect).length > 0,
  JSON.stringify(cafeEffect));
check("at_cafe:心情上升且幅度介於 watching_tv(2) 與 playing_with_cat(6) 之間",
  (cafeEffect.mood ?? 0) > 2 && (cafeEffect.mood ?? 0) < 6, JSON.stringify(cafeEffect));
check("at_cafe:壓力下降,且不比擼貓/洗澡(-4)更強",
  (cafeEffect.stress ?? 0) < 0 && (cafeEffect.stress ?? 0) >= -4, JSON.stringify(cafeEffect));
check("at_cafe:體力接近持平(-2 ～ +1,不當回血手段)",
  (cafeEffect.energy ?? 0) >= -2 && (cafeEffect.energy ?? 0) <= 1, JSON.stringify(cafeEffect));
check("at_cafe:wellbeing 微幅正向且不超過洗澡的 0.5",
  (cafeEffect.wellbeing ?? 0) >= 0 && (cafeEffect.wellbeing ?? 0) <= 0.5, JSON.stringify(cafeEffect));
check("at_cafe:不碰 cleanliness(喝咖啡與清潔無關)", cafeEffect.cleanliness === undefined);
check("at_cafe 不是睡眠狀態:帶了高階床的 defId 也不吃 tier 乘數",
  JSON.stringify(deltasOf("at_cafe", "luxury_bed")) === JSON.stringify(cafeEffect));

// 既有條目一格都不能動(抽驗四類:活動/衛生/外出/待機 + 睡眠主軸)
const sameDeltas = (visual: TenantVisualState, expect: StatDeltas) =>
  JSON.stringify(deltasOf(visual)) === JSON.stringify(expect);
check("🔴 既有 EFFECT 未被改動:gaming / showering / away / idle / sleeping_on_bed",
  sameDeltas("gaming", { mood: 4, stress: -3, energy: -2 })
  && sameDeltas("showering", { stress: -4, cleanliness: 1, energy: 1, wellbeing: 0.5 })
  && sameDeltas("away", { stress: 2, energy: -3 })
  && sameDeltas("idle", { energy: 1 })
  && sameDeltas("sleeping_on_bed", { stress: -5, mood: 2, energy: 9, wellbeing: 0.3 }),
  JSON.stringify([deltasOf("gaming"), deltasOf("showering"), deltasOf("away"), deltasOf("idle")]));

// ---------------------------------------------------------------------------
// 4) 🔴 快照零漂移釘子:新增 EFFECT 條目沒有意外打開任何閘門
// ---------------------------------------------------------------------------
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const gameMsBefore = state.gameMs;
const cafeOpenBefore = state.cafe.open;
state.cafe.open = true; // 刻意打開閘門一,單獨考驗 CAFE_FIRST_DAY
for (const id of ids) {
  const rt = state.runtimes[id];
  if (rt) { rt.directive = null; rt.pendingEvent = null; }
}
let windowHits = 0;
for (let day = 0; day < 10; day++) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + HOUR_MS;
  for (const id of Object.keys(state.runtimes)) {
    if (cafeSitHourForDay(id, day) !== null && day >= CAFE_FIRST_DAY) windowHits++;
    for (let hour = 0; hour < 24; hour++) {
      if (routineSlot(id, hour).state === "at_cafe") windowHits++;
    }
  }
}
state.cafe.open = cafeOpenBefore;
state.gameMs = gameMsBefore;
check("🔴 第 0～9 遊戲日(balance 快照窗)仍然 0 次 at_cafe(EFFECT 新增沒有打開閘門)",
  windowHits === 0, `hits=${windowHits}`);
check("CAFE_FIRST_DAY 仍嚴格大於快照窗的 10 個遊戲日", CAFE_FIRST_DAY > 10, `CAFE_FIRST_DAY=${CAFE_FIRST_DAY}`);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
