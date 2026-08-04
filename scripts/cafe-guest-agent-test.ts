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
  createGuestAgents,
  departedGuestIds,
  guestAgentSignature,
  guestSeated,
  syncGuestAgents,
  tickGuestAgents,
} from "../src/floor/guestAgents";
import { currentBlocked } from "../src/floor/pathfind";
import { buildGrid } from "../src/floor/map";
import { cafeCounterSpots, cafeSeatSpots, placeCafeStarterSet } from "../src/sim/placements";

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
  check("顧客走位與繪製全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
