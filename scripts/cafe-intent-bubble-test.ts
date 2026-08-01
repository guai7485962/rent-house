/** CAFE-10：三種顧客意圖泡泡、顯示時機與程序 fallback。 */
import type { Ctx } from "../src/pixel/sprites";
import { generateCafeGuest } from "../src/sim/cafeGuests";
import { createGuestAgents } from "../src/floor/guestAgents";
import { composeFloor, drawIntentBubble } from "../src/floor/floorScene";
import { resetLimezuCafeAtlasForTests } from "../src/art/limezu";

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
  resetLimezuCafeAtlasForTests();
  const intents = ["coffee", "adopt", "rent"] as const;
  const guests = createGuestAgents(intents.map((intent, sequence) => generateCafeGuest({
    seed: "intent-bubble",
    arrivedMs: 0,
    sequence,
    intent,
  })));
  for (const [index, agent] of guests.entries()) {
    agent.phase = "seated";
    agent.moving = false;
    agent.c = agent.seatTile.c;
    agent.r = agent.seatTile.r;
    agent.px = agent.seatTile.c * 16;
    agent.py = agent.seatTile.r * 16;
    agent.guest.intent = intents[index];
  }
  const before = JSON.stringify(guests.map((agent) => agent.guest));
  const fills: Array<{ color: string; x: number; y: number }> = [];
  const ctx = {
    fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, lineWidth: 1,
    fillRect(x: number, y: number) { fills.push({ color: String(this.fillStyle), x, y }); },
    strokeRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {},
  } as unknown as Ctx;

  const intentColors = ["#a86942", "#e95a72", "#5f83c1"];
  for (const [index, guest] of guests.entries()) {
    fills.length = 0;
    drawIntentBubble(ctx, guest, 0);
    check(`${intents[index]} 在 atlas 未載入時有可辨識 fallback`, fills.some((pixel) => pixel.color === intentColors[index]));
    check(`${intents[index]} fallback 位於角色頭頂`, fills.every((pixel) => pixel.y < guest.py));
  }

  const entering = { ...guests[0], phase: "entering" as const };
  fills.length = 0;
  drawIntentBubble(ctx, entering, 0);
  check("進場中的顧客不顯示意圖泡泡", fills.length === 0);
  const leaving = { ...guests[0], phase: "leaving" as const };
  drawIntentBubble(ctx, leaving, 0);
  check("離場中的顧客不顯示意圖泡泡", fills.length === 0);
  const hidden = { ...guests[0], hidden: true };
  drawIntentBubble(ctx, hidden, 0);
  check("hidden 顧客不顯示意圖泡泡", fills.length === 0);

  fills.length = 0;
  composeFloor(ctx, 0, [], undefined, 12, [], [], guests);
  check("composeFloor 在人物混排後繪製三種泡泡", intentColors.every((color) => fills.some((pixel) => pixel.color === color)));
  check("泡泡繪製不修改 CafeGuest 資料", JSON.stringify(guests.map((agent) => agent.guest)) === before);
  check("意圖泡泡全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
