/**
 * ☕ 咖啡廳互動內容池 + 第三分組(2026-09-03)。
 *
 * 這一批把 `interactionsPass()` 裡那行 `if (visualState === "at_cafe") continue;` 換成
 * `cafeGroup.push(rt)`,所以本檔的重點是**三道硬性關卡的機器證明**,而不是文案數量:
 *
 *   1. 🔴 **不把租客傳送回樓上**:真的跑一次咖啡廳互動,再真的跑 `tickAgents()`,
 *      斷言兩位 sprite 的座標從頭到尾都在 `CAFE_RECTS` 內、而且不在任何 `ROOM_RECTS` 內。
 *      (`startPairSession()` 登記的 tile 在 `floor/agents.ts` 排在 `activityTile` 前面 ⇒
 *       錨點一旦落在三樓,人就會被拉上去。這是 2026-08-27 修掉的傳送 bug 的第四條路徑。)
 *   2. 🔴 **零稀釋**:咖啡廳分組整條路徑 **0 次 `Math.random()`**(抽籤與選句都走雜湊),
 *      而且排在 room / lounge **之後**才跑 ⇒ 既有兩組的亂數序列一位元不變。
 *   3. 🔴 **未成年安全**:戀愛向的兩條一律 `tier` + `gate: "both_adult"` 雙保險。
 *
 * 另加內容結構的釘子:時段必須落在 `at_cafe` 真的產得出來的 10～19 點、不得用
 * `venue` / `seatOn`(見 interactions.ts 的說明)、`standAt` 的家具必須有一邊 ≥2 格。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const {
  INTERACTIONS, canInteract, gateOk, interactionsPass, pickCafeInteraction,
  cafeStandingPair, cafeFurnitureSet, inCafeArea,
} = await import("../src/sim/interactions");
const { CATALOG, getDef } = await import("../src/furniture/catalog");
const { placeCafeStarterSet, addPlacement } = await import("../src/sim/placements");
const { CAFE_FIRST_DAY, cafeSitHourForDay, routineSlot } = await import("../src/sim/routine");
const { applyHour } = await import("../src/sim/tick");
const { CAFE_RECTS, ROOM_RECTS } = await import("../src/floor/map");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const { relationships, pairKey } = await import("../src/sim/social");
const { SHOP_CAT_NAME } = await import("../src/sim/pets");
const { state } = await import("../src/store");
const { GAME_START } = await import("../src/sim/gameState");
import type { InteractionDef } from "../src/sim/interactions";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const CAFE = INTERACTIONS.filter((d) => d.location === "cafe");
const inRoomRects = (t: { c: number; r: number }) =>
  Object.values(ROOM_RECTS).some((b) => t.c >= b.c0 && t.c <= b.c1 && t.r >= b.r0 && t.r <= b.r1);

// ---------------------------------------------------------------------------
// 1) 內容池存在 + 結構釘子
// ---------------------------------------------------------------------------
check("咖啡廳內容池非空(第三分組不是一條沒有車的路)", CAFE.length >= 8, `${CAFE.length} 種`);
check("既有 room / lounge 目錄一種都沒有被改成 cafe",
  INTERACTIONS.filter((d) => d.location === "room").length === 19
  && INTERACTIONS.filter((d) => d.location === "lounge").length === 9,
  `room=${INTERACTIONS.filter((d) => d.location === "room").length} lounge=${INTERACTIONS.filter((d) => d.location === "lounge").length}`);

// `routine.CAFE_SIT_HOURS` 只產得出 10～19 點,且每人每日只有一小時 ⇒ 窗開在外面 = 永遠啞掉
check("🔴 時段全部落在 at_cafe 產得出來的 10～19 點(否則該 def 永遠不會觸發)",
  CAFE.every((d) => !!d.timeWindow && d.timeWindow[0] >= 10 && d.timeWindow[1] <= 19 && d.timeWindow[0] <= d.timeWindow[1]),
  CAFE.filter((d) => !d.timeWindow || d.timeWindow[0] < 10 || d.timeWindow[1] > 19).map((d) => d.id).join(","));
check("🔴 咖啡廳 def 不得用 venue(roomRect 查不到咖啡廳四區 ⇒ 錨點會變 null)",
  CAFE.every((d) => !d.venue), CAFE.filter((d) => d.venue).map((d) => d.id).join(","));
check("🔴 咖啡廳 def 不得用 seatOn(cafe_table 是桌面不是沙發,跨上去等於坐在桌上)",
  CAFE.every((d) => !d.seatOn), CAFE.filter((d) => d.seatOn).map((d) => d.id).join(","));
check("咖啡廳 def 一律不是 🔞 adult、也不用 privacy(公共場所)",
  CAFE.every((d) => !d.adult && !d.privacy));
check("咖啡廳不引入更低的 tier(會讓全樓低關係配對多擲骰)",
  CAFE.every((d) => ["close", "crush", "couple"].includes(d.tier)), CAFE.map((d) => d.tier).join(","));

const catalogIds = new Set(CATALOG.map((d) => d.id));
const standAtIds = [...new Set(CAFE.flatMap((d) => d.standAt ?? []))];
const requireIds = [...new Set(CAFE.flatMap((d) => d.requiresFurniture ?? []))];
check("standAt / requiresFurniture 指的家具都真的存在於目錄",
  [...standAtIds, ...requireIds].every((id) => catalogIds.has(id)),
  [...standAtIds, ...requireIds].filter((id) => !catalogIds.has(id)).join(","));
check("standAt / requiresFurniture 指的都是咖啡廳家具(venue === \"cafe\")",
  [...standAtIds, ...requireIds].every((id) => getDef(id).venue === "cafe"),
  [...standAtIds, ...requireIds].filter((id) => getDef(id).venue !== "cafe").join(","));
// furnitureStandingPair 需要沿著寬或高取兩格 ⇒ 1×1 家具永遠回 null
check("🔴 standAt 的家具至少有一邊 ≥2 格(1×1 永遠站不下兩人 ⇒ 該 def 永遠啞掉)",
  standAtIds.every((id) => getDef(id).footprint.w >= 2 || getDef(id).footprint.h >= 2),
  standAtIds.filter((id) => getDef(id).footprint.w < 2 && getDef(id).footprint.h < 2).join(","));

// 內容切角:必須是「只有咖啡廳才會發生」的東西,不是交誼廳互動換地名
const allLines = CAFE.flatMap((d) => d.lines);
check("每種至少 3 條文案、都能代換 {o}",
  CAFE.every((d) => d.lines.length >= 3 && d.lines.every((l) => l.includes("{o}"))));
check(`文案裡真的出現店貓「${SHOP_CAT_NAME}」(店貓線沒有因為改名而失聯)`,
  allLines.some((l) => l.includes(SHOP_CAT_NAME)));
check("有「房東在樓上看著」的切角", allLines.some((l) => l.includes("房東")));
check("有顧客/店員的切角", allLines.some((l) => l.includes("客人") || l.includes("店員")));
check("有打烊收尾的切角", CAFE.some((d) => (d.timeWindow?.[1] ?? 0) === 19 && (d.timeWindow?.[0] ?? 0) >= 17));

// ---------------------------------------------------------------------------
// 2) 🔴 未成年安全:戀愛向兩條靠 tier + both_adult 雙保險
// ---------------------------------------------------------------------------
const romance = CAFE.filter((d) => d.tier === "crush" || d.tier === "couple" || d.tier === "cohabit");
check("咖啡廳戀愛向至少兩條(內容有層次)", romance.length >= 2, `${romance.length}`);
check("🔴 咖啡廳戀愛向一律掛 gate: \"both_adult\"",
  romance.every((d) => d.gate === "both_adult"), romance.map((d) => `${d.id}=${d.gate}`).join(","));

const T = (id: string, gender: "male" | "female", attractedTo: ("male" | "female")[], isAdult: boolean) =>
  ({
    id, name: id, gender, attractedTo, isAdult,
    occupation: "", bio: "", coreTags: [], memoryTags: [],
    finance: { monthlyRent: 1000, paymentReliability: 80, monthsOverdue: 0 },
    stats: { mood: 60, stress: 40, wellbeing: 70, energy: 60, affinity: 50 },
    preferences: {}, visualState: "at_cafe", recentSummary: "",
  }) as unknown as Parameters<typeof canInteract>[1];
const wrap = (t: any) => ({ tenant: t, wallet: 10000 }) as any;
const MINOR = T("cafe_minor", "female", ["male"], false);
const ADULT = T("cafe_adult", "male", ["female"], true);
const OK_A = T("cafe_ok_a", "male", ["female"], true);
const OK_B = T("cafe_ok_b", "female", ["male"], true);
const setRel = (a: any, b: any, value: number, romantic: boolean) => {
  relationships[pairKey(a.id, b.id)] = { value, tension: 0, lastConflictGameMs: 0, romantic, cohabitOffered: romantic };
};
const allowed = (def: InteractionDef, a: any, b: any) =>
  canInteract(def, a, b, {
    hour: def.timeWindow![0], thirdPresent: false, adultMode: state.adultMode, cohabiting: false,
    furniture: new Set([...catalogIds]),
  }) && gateOk(def.gate, wrap(a), wrap(b));

// 舊存檔可能殘留非法 romantic ⇒ tier 擋不住,靠 both_adult 這道雙保險
setRel(MINOR, ADULT, 100, true);
check("🔴 未成年 + 舊存檔殘留的非法 romantic ⇒ 咖啡廳戀愛向全部擋掉",
  romance.every((d) => !allowed(d, MINOR, ADULT)),
  romance.filter((d) => allowed(d, MINOR, ADULT)).map((d) => d.id).join(","));
check("擋的是 gate 不是 tier(沒有空轉):tier 這時本來過得了",
  romance.every((d) => canInteract(d, MINOR, ADULT, {
    hour: d.timeWindow![0], thirdPresent: false, adultMode: state.adultMode, cohabiting: false,
    furniture: new Set([...catalogIds]),
  })));
setRel(OK_A, OK_B, 96, true);
check("對照組:合法成年情侶 ⇒ 咖啡廳戀愛向都通得過(上面那條不是空轉)",
  romance.every((d) => allowed(d, OK_A, OK_B)),
  romance.filter((d) => !allowed(d, OK_A, OK_B)).map((d) => d.id).join(","));
for (const p of [[MINOR, ADULT], [OK_A, OK_B]]) delete relationships[pairKey(p[0].id, p[1].id)];

// ---------------------------------------------------------------------------
// 3) 🔴 零 RNG:抽籤與選句都不擲骰,而且同輸入同輸出
// ---------------------------------------------------------------------------
{
  const orig = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return orig(); };
  const a = Array.from({ length: 200 }, (_, i) => pickCafeInteraction(CAFE, `pair|${i}|14`)?.id ?? "-");
  const b = Array.from({ length: 200 }, (_, i) => pickCafeInteraction(CAFE, `pair|${i}|14`)?.id ?? "-");
  Math.random = orig;
  check("🔴 pickCafeInteraction 零 Math.random", calls === 0, `實際 ${calls} 次`);
  check("pickCafeInteraction 同輸入同輸出(決定性)", a.join(",") === b.join(","));
  check("抽籤沒有退化成常數:200 個 seed 抽得到多種結果", new Set(a).size >= 4, `distinct=${new Set(a).size}`);
  check("chance 有作用:部分 seed 落空(不是每次都成局)", a.includes("-"));
  check("空候選 → null 且不擲骰", pickCafeInteraction([], "x") === null);
}

// 🔴 抽籤分布的回歸鎖(2026-09-03 實際踩到的坑)。
// `pickCafeInteraction()` 要抽**兩個**數:選 def 的權重數、比 `chance` 的機率數。
// 第一版把區分標籤放在字尾(`…|w` / `…|c`)、雜湊又只有純 FNV-1a(沒有尾段雪崩)
// ⇒ 兩個數強相關,`cafe_menu_bet` / `cafe_split_cake` / `cafe_coffee_cheers` /
// `cafe_shared_cup` 的實測觸發率是**精確 0.00%**(預期 3.2~5.2%),而前四種各多拿
// 1.7~2.5 倍 —— 而且**所有既有斷言都是綠的**(決定性、零 RNG、抽得到多種結果全都成立)。
// 所以這一節不驗「有沒有隨機性」,而是逐 def 驗**實測比例貼合 (w/W)·chance**。
for (const hour of [15, 18]) {
  const elig = CAFE.filter((d) => d.timeWindow![0] <= hour && hour <= d.timeWindow![1]);
  const W = elig.reduce((s, d) => s + d.weight, 0);
  const N = 20000;
  const tally = new Map<string, number>();
  for (let day = 0; day < N; day++) {
    const d = pickCafeInteraction(elig, `probe_a|probe_b|${day}|${hour}`);
    if (d) tally.set(d.id, (tally.get(d.id) ?? 0) + 1);
  }
  const worst = elig.reduce((m, d) => {
    const got = (tally.get(d.id) ?? 0) / N;
    const exp = (d.weight / W) * d.chance;
    return Math.max(m, Math.abs(got - exp) / exp);
  }, 0);
  check(`🔴 ${hour}:00 的抽籤分布逐 def 貼合 (w/W)·chance(誤差 < 20%)`,
    worst < 0.2, `最大誤差 ${(worst * 100).toFixed(1)}%`);
  check(`${hour}:00 沒有任何 def 被雜湊相關性打成 0`,
    elig.every((d) => (tally.get(d.id) ?? 0) > 0),
    elig.filter((d) => !(tally.get(d.id) ?? 0)).map((d) => d.id).join(","));
}

// ---------------------------------------------------------------------------
// 4) 場景:兩位租客同時在一樓,真的演出一次咖啡廳互動
// ---------------------------------------------------------------------------
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ids = Object.keys(state.runtimes).sort();
check("前置:種子局有兩位租客", ids.length >= 2, `${ids.length}`);
for (const id of ids) {
  const rt = state.runtimes[id];
  rt.directive = null;
  rt.pendingEvent = null;
  rt.tenant.stats.stress = 40;
}
state.cafe.open = true;
placeCafeStarterSet();
// 讓「看客人」那條的 cafe_busy gate 過得了(cafeGuestPass 排在 interactionsPass 之前)
state.cafe.guests = [{ id: "g1" }, { id: "g2" }] as any;
// 朋友門檻(close 需要 rel ≥ 50);不設 romantic ⇒ 這一節走的是全年齡內容
relationships[pairKey(ids[0], ids[1])] = { value: 80, tension: 0, lastConflictGameMs: 0, romantic: false, cohabitOffered: false };

check("開張贈品就站得下兩人:吧台與小圓桌都找得到並排兩格",
  cafeStandingPair(["cafe_counter"]) !== null && cafeStandingPair(["cafe_table"]) !== null);
check("cafeFurnitureSet 掃得到四個區域的家具(不是只查單一 roomId)",
  cafeFurnitureSet().has("cafe_counter") && cafeFurnitureSet().has("cafe_table"));

/** 找一天兩位租客同時下樓、同一小時。
 *  ⚠️ `routineSlot()` 的閘門讀的是 `gameDayIndex()`(不是參數),所以要先把 gameMs 撥到那一天。 */
let scene: { day: number; hour: number } | null = null;
for (let day = CAFE_FIRST_DAY; day < CAFE_FIRST_DAY + 120 && !scene; day++) {
  const h0 = cafeSitHourForDay(ids[0], day);
  const h1 = cafeSitHourForDay(ids[1], day);
  if (h0 === null || h0 !== h1) continue;
  state.gameMs = GAME_START.getTime() + day * DAY_MS + h0 * HOUR_MS;
  if (routineSlot(ids[0], h0).state === "at_cafe" && routineSlot(ids[1], h1).state === "at_cafe") scene = { day, hour: h0 };
}
check("前置:找得到兩位租客同框的那一小時", scene !== null);

/** 在 (day,hour) 佈好兩人的 at_cafe 狀態,然後跑一次 interactionsPass;回傳觸發到的 cafe def id */
function runScene(day: number, hour: number): { fired: string[]; rngCalls: number } {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
  clearPairSessions();
  for (const id of ids) applyHour(state.runtimes[id], hour, false);
  const before = { ...state.interactionCooldowns };
  const orig = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return orig(); };
  interactionsPass();
  Math.random = orig;
  const fired: string[] = [];
  for (const [k, v] of Object.entries(state.interactionCooldowns)) {
    if (before[k] !== v && CAFE.some((d) => k.endsWith(`|${d.id}`))) fired.push(k.split("|").pop()!);
  }
  return { fired, rngCalls: calls };
}

check("前置:兩人真的都被作息送到一樓",
  (() => {
    state.gameMs = GAME_START.getTime() + scene!.day * DAY_MS + scene!.hour * HOUR_MS;
    for (const id of ids) applyHour(state.runtimes[id], scene!.hour, false);
    return ids.every((id) => state.runtimes[id].tenant.visualState === "at_cafe");
  })(),
  ids.map((id) => state.runtimes[id].tenant.visualState).join(","));

// 冷卻會讓同一條不重複,所以掃連續多個同框日直到抓到一次觸發
let fired: string[] = [];
let zeroRng = true;
let scanned = 0;
for (let day = scene!.day; day < scene!.day + 200 && fired.length === 0; day++) {
  const h0 = cafeSitHourForDay(ids[0], day);
  const h1 = cafeSitHourForDay(ids[1], day);
  if (h0 === null || h0 !== h1) continue;
  scanned++;
  const r = runScene(day, h0);
  if (r.rngCalls !== 0) zeroRng = false;
  fired = r.fired;
}
check("🔴 咖啡廳互動真的觸發了(內容池不是擺著好看)", fired.length > 0, `掃了 ${scanned} 個同框日`);
check("🔴 整個 interactionsPass 在只有咖啡廳配對時 0 次 Math.random(零稀釋的機制保證)", zeroRng);

// ---------------------------------------------------------------------------
// 5) 🔴 傳送守衛:session 的格在一樓,而且 tickAgents 跑完人還在一樓
// ---------------------------------------------------------------------------
const sesA = sessionFor(ids[0], state.gameMs);
const sesB = sessionFor(ids[1], state.gameMs);
check("互動有掛上雙人演出 session", !!sesA && !!sesB);
check("🔴 session 的兩格都在 CAFE_RECTS 內",
  !!sesA && !!sesB && inCafeArea(sesA.tile) && inCafeArea(sesB.tile),
  `${JSON.stringify(sesA?.tile)} ${JSON.stringify(sesB?.tile)}`);
check("🔴 session 的兩格都不在任何套房矩形內(這正是傳送 bug 的長相)",
  !!sesA && !!sesB && !inRoomRects(sesA.tile) && !inRoomRects(sesB.tile));

const agents = createAgents();
let strayFrames = 0;
let arrived = 0;
for (let i = 0; i < 600; i++) {
  tickAgents(agents, 1 / 30);
  for (const a of agents) {
    if (!ids.includes(a.tenantId) || a.hidden) continue;
    if (inRoomRects({ c: a.c, r: a.r })) strayFrames++;
  }
}
for (const a of agents) if (ids.includes(a.tenantId) && !a.hidden && inCafeArea({ c: a.c, r: a.r })) arrived++;
check("🔴 tickAgents 跑 600 幀,sprite 一幀都沒有出現在三樓套房裡", strayFrames === 0, `stray=${strayFrames}`);
check("🔴 兩位 sprite 最後都停在一樓咖啡廳", arrived === 2, `arrived=${arrived}`);

// 對照:錨點候選全部不在一樓時,寧可不掛 session 也不傳送人
check("inCafeArea:三樓套房座標一律 false",
  !inCafeArea({ c: ROOM_RECTS.r301.c0, r: ROOM_RECTS.r301.r0 }) && !inCafeArea(null));
check("inCafeArea:咖啡廳主廳座標為 true",
  inCafeArea({ c: CAFE_RECTS.cafe_floor.c0, r: CAFE_RECTS.cafe_floor.r0 })
  && inCafeArea({ c: CAFE_RECTS.cafe_counter.c1, r: CAFE_RECTS.cafe_counter.r1 }));

// ---------------------------------------------------------------------------
// 6) 需要額外家具的內容:買了才解鎖(地點條件即玩法)
// ---------------------------------------------------------------------------
check("前置:開張贈品沒有菜單板/寵物軟墊", !cafeFurnitureSet().has("cafe_menu_board") && !cafeFurnitureSet().has("cafe_pet_cushion"));
check("沒買寵物軟墊/貓跳台時,店貓那條站不出舞台", cafeStandingPair(["cafe_pet_cushion", "cafe_cat_tower"]) === null);
addPlacement({ defId: "cafe_pet_cushion", room: "cafe_pet", c: 10, r: 43, rotation: 0 });
check("擺上寵物軟墊後,店貓那條就站得出舞台了(家具投資接回互動)",
  cafeStandingPair(["cafe_pet_cushion", "cafe_cat_tower"]) !== null);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
