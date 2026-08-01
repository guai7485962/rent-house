/** CAFE-08：顧客入口→座位→入口走位與 floorScene 繪製。 */
import type { Ctx } from "../src/pixel/sprites";
import { generateCafeGuest } from "../src/sim/cafeGuests";
import { composeFloor, drawGuest } from "../src/floor/floorScene";
import {
  CAFE_GUEST_ENTRY_TILES,
  CAFE_GUEST_PREFERRED_SEATS,
  cafeGuestSeatCandidates,
  createGuestAgents,
  departedGuestIds,
  guestAgentSignature,
  tickGuestAgents,
} from "../src/floor/guestAgents";
import { currentBlocked } from "../src/floor/pathfind";
import { buildGrid } from "../src/floor/map";

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
  const source = Array.from({ length: 6 }, (_, sequence) => generateCafeGuest({ seed: "agent-test", arrivedMs: 0, sequence }));
  const sourceBefore = JSON.stringify(source);
  const agents = createGuestAgents([...source].reverse());
  const sortedIds = [...source].sort((a, b) => a.id.localeCompare(b.id)).map((guest) => guest.id).join("|");
  check("建立順序固定依 guest id 排序", agents.map((agent) => agent.guest.id).join("|") === sortedIds);
  check("六位顧客各自取得不重複座位", new Set(agents.map((agent) => `${agent.seatTile.c},${agent.seatTile.r}`)).size === 6);
  const grid = buildGrid();
  check("所有座位都落在 cafe_floor 主廳", agents.every((agent) => grid[agent.seatTile.r]?.[agent.seatTile.c] === "cafe_floor"));
  check("所有顧客從 cafe_entrance 兩格之一進場", agents.every((agent) => CAFE_GUEST_ENTRY_TILES.some((entry) => entry.c === agent.c && entry.r === agent.r)));
  check("建立 agent 不修改 CafeGuest 來源", JSON.stringify(source) === sourceBefore && source.every((guest) => guest.seatTile === null));
  check("signature 不受輸入排序影響", guestAgentSignature(source) === guestAgentSignature([...source].reverse()));

  const blocked = currentBlocked();
  check("入口與候選座位在預設地圖可通行", [...CAFE_GUEST_ENTRY_TILES, ...cafeGuestSeatCandidates(blocked)].every((tile) => blocked[tile.r]?.[tile.c] === false));
  const furnitureBlocked = blocked.map((row) => [...row]);
  CAFE_GUEST_PREFERRED_SEATS.forEach((tile) => { furnitureBlocked[tile.r][tile.c] = true; });
  const fallbackAgent = createGuestAgents([generateCafeGuest({ seed: "blocked-seat", arrivedMs: 0 })], furnitureBlocked)[0];
  check("偏好座位被家具擋住時改選其他主廳空格", grid[fallbackAgent.seatTile.r]?.[fallbackAgent.seatTile.c] === "cafe_floor" && furnitureBlocked[fallbackAgent.seatTile.r]?.[fallbackAgent.seatTile.c] === false);
  for (let i = 0; i < 700 && agents.some((agent) => agent.phase !== "seated"); i++) tickGuestAgents(agents, 0.05, 0);
  check("顧客都能從入口尋路到座位", agents.every((agent) => agent.phase === "seated" && agent.c === agent.seatTile.c && agent.r === agent.seatTile.r));
  check("入座後使用正面坐姿方向", agents.every((agent) => !agent.moving && agent.view === "front"));

  const leaveAt = Math.max(...agents.map((agent) => agent.guest.leavesMs));
  tickGuestAgents(agents, 0, leaveAt);
  check("到 leavesMs 後全部切為離場階段", agents.every((agent) => agent.phase === "leaving"));
  for (let i = 0; i < 700 && agents.some((agent) => agent.phase !== "departed"); i++) tickGuestAgents(agents, 0.05, leaveAt);
  check("離場顧客都走回 cafe_entrance 才隱藏", agents.every((agent) => agent.phase === "departed" && agent.hidden && CAFE_GUEST_ENTRY_TILES.some((entry) => entry.c === agent.c && entry.r === agent.r)));
  check("departedGuestIds 回傳穩定排序的完整 id", departedGuestIds(agents).join("|") === source.map((guest) => guest.id).sort().join("|"));

  const one = createGuestAgents([generateCafeGuest({ seed: "draw", arrivedMs: 0 })])[0];
  one.phase = "seated";
  one.moving = false;
  one.c = one.seatTile.c;
  one.r = one.seatTile.r;
  one.px = one.seatTile.c * 16;
  one.py = one.seatTile.r * 16;
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
