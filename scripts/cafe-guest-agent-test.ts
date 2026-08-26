/**
 * CAFE-08 / 重設計 P2:顧客走位。
 *
 * P2 之後動線是「店門 → 吧台 → 真的椅子 → 店門」,席次一律查 `placements`
 * (硬編的 `CAFE_GUEST_PREFERRED_SEATS` 已廢除)。phase 轉移與點餐演出另有
 * `scripts/cafe-p2-flow-test.ts` 深驗,這裡只釘走位與繪製這一層。
 */
import type { Ctx } from "../src/pixel/sprites";
import { generateCafeGuest } from "../src/sim/cafeGuests";
import { composeFloor, drawGuest } from "../src/floor/floorScene";
import {
  CAFE_GUEST_ENTRY_TILES,
  GUEST_FADE_SECONDS,
  createGuestAgents,
  departedGuestIds,
  guestAgentSignature,
  guestAlpha,
  guestSeated,
  syncGuestAgents,
  tickGuestAgents,
} from "../src/floor/guestAgents";
import { currentBlocked, findPath } from "../src/floor/pathfind";
import { buildGrid } from "../src/floor/map";
import {
  CAFE_QUEUE_MAX_DEPTH,
  cafeCounterSpots,
  cafeQueueTiles,
  cafeSeatSpots,
  placeCafeStarterSet,
} from "../src/sim/placements";
import { CAFE_CROWD_CASES, runCafeCrowd } from "./cafe-crowd-sim";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.25; };

try {
  placeCafeStarterSet(); // 開張贈品 = 吧台 + 三組桌椅,席次就是它們
  const seats = cafeSeatSpots();
  check("席次來自 placements 的 seat 家具(不是硬編表)", seats.length >= 6, `seats=${seats.length}`);
  check("點餐位在吧台前、可走", cafeCounterSpots().length >= 1);

  const source = seats.slice(0, 6).map((spot, sequence) => generateCafeGuest({
    seed: "agent-test", arrivedMs: 0, sequence, seatTile: spot.seat,
    order: { itemId: "x", itemName: "招牌美式咖啡", price: 34, track: "coffee", served: true, missing: "", takeaway: false },
  }));
  const sourceBefore = JSON.stringify(source);
  const agents = createGuestAgents([...source].reverse());
  const sortedIds = [...source].sort((a, b) => a.id.localeCompare(b.id)).map((guest) => guest.id).join("|");
  check("建立順序固定依 guest id 排序", agents.map((agent) => agent.guest.id).join("|") === sortedIds);
  check("六位顧客各自取得不重複席位",
    new Set(agents.map((agent) => `${agent.seatSpot?.seat.c},${agent.seatSpot?.seat.r}`)).size === 6);
  const grid = buildGrid();
  check("所有席位都落在一樓咖啡廳區域",
    agents.every((agent) => String(grid[agent.seatSpot!.seat.r]?.[agent.seatSpot!.seat.c] ?? "").startsWith("cafe")));
  check("所有顧客從 cafe_entrance 兩格之一進場",
    agents.every((agent) => CAFE_GUEST_ENTRY_TILES.some((entry) => entry.c === agent.c && entry.r === agent.r)));
  check("建立 agent 不修改 CafeGuest 來源", JSON.stringify(source) === sourceBefore);
  check("signature 不受輸入排序影響", guestAgentSignature(source) === guestAgentSignature([...source].reverse()));
  check("初始 phase 一律是 entering(先走向吧台)", agents.every((agent) => agent.phase === "entering"));

  const blocked = currentBlocked();
  check("入口與所有席位到達格在預設地圖可通行",
    [...CAFE_GUEST_ENTRY_TILES, ...seats.map((s) => s.stand)].every((tile) => blocked[tile.r]?.[tile.c] === false));

  // 走完全程:entering → ordering → served → seated
  for (let i = 0; i < 1400 && agents.some((agent) => !guestSeated(agent)); i++) tickGuestAgents(agents, 0.05, 0);
  check("顧客都能從入口一路走到真的椅子上坐下", agents.every((agent) => guestSeated(agent)),
    agents.map((a) => `${a.guest.name}:${a.phase}@${a.c},${a.r}`).join(" "));
  check("入座後使用正面坐姿方向", agents.every((agent) => !agent.moving && agent.view === "front"));
  check("入座格 = 該席位的到達格(不是隨便一塊空地板)",
    agents.every((agent) => agent.c === agent.seatSpot!.stand.c && agent.r === agent.seatSpot!.stand.r));

  // syncGuestAgents 保留既有 agent:新顧客進來時已入座的人不會被瞬移回門口
  const extra = generateCafeGuest({ seed: "agent-test", arrivedMs: 0, sequence: 99 });
  const seatedBefore = agents.map((agent) => `${agent.c},${agent.r},${agent.phase}`).join("|");
  const synced = syncGuestAgents(agents, [...source, extra]);
  check("syncGuestAgents 依 id 保留既有 agent 的位置與 phase",
    synced.filter((agent) => agent.guest.id !== extra.id)
      .map((agent) => `${agent.c},${agent.r},${agent.phase}`).join("|") === seatedBefore);
  check("新來的顧客從入口起步", synced.find((agent) => agent.guest.id === extra.id)?.phase === "entering");

  const leaveAt = Math.max(...agents.map((agent) => agent.guest.leavesMs));
  tickGuestAgents(agents, 0, leaveAt);
  check("到 leavesMs 後全部切為離場階段", agents.every((agent) => agent.phase === "leaving"));
  for (let i = 0; i < 1400 && agents.some((agent) => agent.phase !== "departed"); i++) tickGuestAgents(agents, 0.05, leaveAt);
  check("離場顧客都走回 cafe_entrance 才隱藏", agents.every((agent) => agent.phase === "departed" && agent.hidden
    && CAFE_GUEST_ENTRY_TILES.some((entry) => entry.c === agent.c && entry.r === agent.r)));
  check("departedGuestIds 回傳穩定排序的完整 id",
    departedGuestIds(agents).join("|") === source.map((guest) => guest.id).sort().join("|"));

  const one = createGuestAgents([generateCafeGuest({ seed: "draw", arrivedMs: 0, seatTile: seats[0].seat })])[0];
  one.phase = "seated";
  one.moving = false;
  one.c = one.seatSpot!.stand.c;
  one.r = one.seatSpot!.stand.r;
  one.px = one.c * 16;
  one.py = one.r * 16;
  one.guest.appearance = { ...one.guest.appearance, shirt: "#123456" };
  const fills: Array<{ color: string; x: number; y: number }> = [];
  const ctx = {
    fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, lineWidth: 1,
    fillRect(x: number, y: number) { fills.push({ color: String(this.fillStyle), x, y }); },
    strokeRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {},
  } as unknown as Ctx;
  drawGuest(ctx, one);
  check("drawGuest 畫出 CafeGuest snapshot 的衣服顏色", fills.some((pixel) => pixel.color === "#123456"));
  const directPixels = fills.length;
  fills.length = 0;
  composeFloor(ctx, 0, [], undefined, 12, [], [], [one]);
  check("composeFloor 顧客混排分支實際呼叫 drawGuest", fills.some((pixel) => pixel.color === "#123456") && fills.length > directPixels);
  one.hidden = true;
  fills.length = 0;
  composeFloor(ctx, 0, [], undefined, 12, [], [], [one]);
  check("composeFloor 不繪製 hidden 顧客", !fills.some((pixel) => pixel.color === "#123456"));
  // =========================================================================
  // 🔴 2026-08-26:顧客互相卡死(gridlock)
  //
  // 使用者回報「咖啡廳的客人會被椅子卡住,或是被等候先卡住」。兩件事同一個根因:
  // `detourGrid()` 把**正在移動的人**排除在障礙之外,而卡死中的顧客 `moving` 永遠是
  // `true` ⇒ 互卡的兩個人在彼此的繞路地圖上是隱形的,每次重算都得到同一條穿過對方的路。
  //
  // 上面那一段只跑 6 位、而且 `serviceSlots` 用預設的 Infinity(不排隊),
  // **恰好在觸發門檻(同時 5 位以上內用客)以下** —— 這就是這個 bug 活到玩家回報的原因。
  // 以下情境一律跑在門檻以上,並與 `scripts/sim-trace.ts` 共用同一個 harness。
  // =========================================================================
  for (const scenario of CAFE_CROWD_CASES) {
    const result = runCafeCrowd(scenario);
    check(`整批進場不卡死:${result.label}`, result.stuck.length === 0,
      result.stuck.map((a) => `${a.guest.name}:${a.phase}@${a.c},${a.r}`).join(" "));
  }
  const sceneB = runCafeCrowd({ dineIn: 8, takeaway: 3, staff: 5 });
  check("🔴 情境 B(8 內用 + 3 外帶 / 5 店員):未抵達目標的人數 = 0", sceneB.stuck.length === 0);
  check("情境 B:內用客是真的走到椅子上,不是靠兜底站著",
    sceneB.degraded.length === 0 && sceneB.agents.filter((a) => guestSeated(a)).length === 8,
    `坐下 ${sceneB.agents.filter((a) => guestSeated(a)).length} / 兜底 ${sceneB.degraded.length}`);
  const sceneBAgain = runCafeCrowd({ dineIn: 8, takeaway: 3, staff: 5 });
  check("情境 B 完全決定性(同輸入 ⇒ 同軌跡)",
    sceneB.agents.map((a) => `${a.guest.id}@${a.c},${a.r}`).join("|")
    === sceneBAgain.agents.map((a) => `${a.guest.id}@${a.c},${a.r}`).join("|"));

  // 🔴 反向把關:解 2-cycle 不可以用「把所有 moving 的人都當障礙」——那樣 findPath 會
  // 大量回 null,正常通行也塞住。門檻以下的小場面必須照樣**快速**走完。
  const light = runCafeCrowd({ dineIn: 4, takeaway: 2, staff: 5 }, "light");
  check("一般情況(4 內用 + 2 外帶)照樣全員抵達,而且沒有人走兜底",
    light.stuck.length === 0 && light.degraded.length === 0);
  const solo = runCafeCrowd({ dineIn: 1, takeaway: 0, staff: 5 }, "solo");
  check("單人情境完全不受繞路影響(< 20 現實秒抵達)",
    solo.stuck.length === 0 && solo.settledAt > 0 && solo.settledAt < 20, `settledAt=${solo.settledAt}`);
  // 「路徑照樣找得到」的量化把關:實走格數 vs 最短路徑格數。繞路一旦失控(或 findPath
  // 大量回 null 導致原地打轉再重來),這個比值會立刻膨脹。
  const idealSteps = light.agents.reduce((sum, agent) => {
    const toCounter = findPath(agent.entryTile, agent.counterTile, currentBlocked());
    const goal = agent.seatSpot ? agent.seatSpot.stand : agent.entryTile;
    const toGoal = findPath(agent.counterTile, goal, currentBlocked());
    return sum + (toCounter?.length ?? 1) - 1 + (toGoal?.length ?? 1) - 1;
  }, 0);
  check("一般情況的實走格數貼近最短路徑(繞路沒有失控 ⇒ 路徑照樣找得到)",
    idealSteps > 0 && light.steps <= idealSteps * 1.5, `實走 ${light.steps} / 最短 ${idealSteps}`);
  // 席位到入口的路一定找得到:繞路地圖再嚴也不能讓「基本路徑」消失。
  check("每個席位的到達格都從店門走得到",
    cafeSeatSpots().every((spot) => findPath(CAFE_GUEST_ENTRY_TILES[0], spot.stand, currentBlocked()) !== null));

  // -------------------------------------------------------------------------
  // 🔴 第 2 層安全網:seated / leaving 的脫困逾時
  //
  // 以前這兩個階段在階段轉移的 switch 裡是 `default: break`,完全沒有逾時 ⇒
  // 被鎖住的人最後被資料層 `cafeGuestPass()` **原地清掉**(顧客在畫面中央憑空消失)。
  // 這裡直接模擬最惡劣的情況:玩家用家具把顧客砌牆關起來(`canPlaceFree()` 沒有
  // 可達性檢查,玩家真的做得到),連 findPath 都回 null。
  // -------------------------------------------------------------------------
  const walled = currentBlocked().map((row) => [...row]);
  const trapped = createGuestAgents([generateCafeGuest({
    seed: "walled", arrivedMs: 0, sequence: 0, seatTile: seats[0].seat,
    order: { itemId: "x", itemName: "招牌美式咖啡", price: 34, track: "coffee", served: true, missing: "", takeaway: false },
  })], walled)[0];
  // 把他放進大廳中央再砌牆——在店門口砌牆等於「他已經在門口」,測不到走不出去的情況。
  trapped.c = 7;
  trapped.r = 45;
  trapped.px = trapped.c * 16;
  trapped.py = trapped.r * 16;
  for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) walled[trapped.r + dr][trapped.c + dc] = true;
  const trappedC = trapped.c;
  const trappedR = trapped.r;
  for (let i = 0; i < 60 / 0.05; i++) tickGuestAgents([trapped], 0.05, 0, undefined, walled);
  check("🔴 被砌牆關住的顧客不會消失(仍在畫面上、仍在原地)",
    !trapped.hidden && trapped.phase !== "departed" && trapped.c === trappedC && trapped.r === trappedR,
    `${trapped.phase} hidden=${trapped.hidden} @${trapped.c},${trapped.r}`);
  check("走不到座位 ⇒ 退化成站著用餐(不是永遠抱著走不通的路)",
    trapped.phase === "seated" && trapped.standingMeal && !trapped.moving);
  check("站著用餐的人不算「坐在椅子上」(不會憑空出現坐姿)", !guestSeated(trapped));
  check("站著用餐的人是完全不透明的(還沒開始淡出)", guestAlpha(trapped) === 1);

  tickGuestAgents([trapped], 0, trapped.guest.leavesMs, undefined, walled);
  check("時間到照樣轉入離場階段", trapped.phase === "leaving");
  let sawFade = false;
  for (let i = 0; i < 60 / 0.05 && trapped.phase !== "departed"; i++) {
    tickGuestAgents([trapped], 0.05, trapped.guest.leavesMs, undefined, walled);
    const alpha = guestAlpha(trapped);
    if (alpha > 0 && alpha < 1) sawFade = true;
  }
  check("🔴 走不出去的顧客是**淡出**而不是瞬間消失(中途量得到 0 < alpha < 1)", sawFade);
  check("淡完才真的離場(departed + hidden)", trapped.phase === "departed" && trapped.hidden);
  check("淡出耗時 = GUEST_FADE_SECONDS(不是 0 幀)", trapped.fadeT >= GUEST_FADE_SECONDS);

  // -------------------------------------------------------------------------
  // 🔴 第 3、4 層:席位不可以是死巷,人龍不可以壓在座位出入口上
  // 用專案自己的函式實測,不用眼睛判斷。
  // -------------------------------------------------------------------------
  const grid2 = currentBlocked();
  const walkableAt = (c: number, r: number) => grid2[r]?.[c] === false;
  const queue = cafeQueueTiles(CAFE_QUEUE_MAX_DEPTH);
  const queueKeys = new Set(queue.map((tile) => `${tile.c},${tile.r}`));
  const neighboursOf = (tile: { c: number; r: number }) =>
    [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dc, dr]) => walkableAt(tile.c + dc, tile.r + dr)).length;
  check("🔴 開張贈品沒有一格寬死巷席位(每個到達格可走鄰格 >= 2)",
    cafeSeatSpots().every((spot) => neighboursOf(spot.stand) >= 2),
    cafeSeatSpots().map((s) => `${s.seat.c},${s.seat.r}:${neighboursOf(s.stand)}`).join(" "));
  check("🔴 人龍不壓在任何席位的到達格上",
    cafeSeatSpots().every((spot) => !queueKeys.has(`${spot.stand.c},${spot.stand.r}`)),
    JSON.stringify(queue));
  check("人龍不會排進後場(cafe_back,r48-50)", queue.every((tile) => tile.r <= 47), JSON.stringify(queue));
  check("人龍是連續的一條線", queue.every((tile, i) => i === 0
    || Math.abs(tile.c - queue[i - 1].c) + Math.abs(tile.r - queue[i - 1].r) <= 2), JSON.stringify(queue));

  check("顧客走位與繪製全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
