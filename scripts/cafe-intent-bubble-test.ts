/**
 * CAFE-10 / 重設計 P2:顧客頭上的資訊層。
 *
 * P2 把泡泡拆成四種:點餐(商品 + 價格)、收錢(綠色 +$NN 浮字)、
 * 缺料(紅色 ❌)、入座後的意圖泡泡。使用者的原話是
 * 「不知道這些人走進來後頭上的標誌代表什麼意思」,所以兩種**可互動**意圖
 * (想認養/想租房)必須明顯到與只是來喝咖啡的人分得出來。
 */
import type { Ctx } from "../src/pixel/sprites";
import { generateCafeGuest } from "../src/sim/cafeGuests";
import { createGuestAgents } from "../src/floor/guestAgents";
import {
  composeFloor,
  drawGuestBubble,
  drawIntentBubble,
  drawOrderBubble,
  drawPixelText,
  drawRefusedBubble,
  drawServedFloat,
} from "../src/floor/floorScene";
import { cafeSeatSpots, placeCafeStarterSet } from "../src/sim/placements";
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

const fills: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
const ctx = {
  fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, lineWidth: 1,
  fillRect(x: number, y: number, w: number, h: number) { fills.push({ color: String(this.fillStyle), x, y, w, h }); },
  strokeRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {},
} as unknown as Ctx;

try {
  resetLimezuCafeAtlasForTests();
  placeCafeStarterSet();
  const seats = cafeSeatSpots();

  // --- 1. 三種意圖泡泡 ---------------------------------------------------
  const intents = ["coffee", "adopt", "rent"] as const;
  const guests = createGuestAgents(intents.map((intent, sequence) => generateCafeGuest({
    seed: "intent-bubble", arrivedMs: 0, sequence, intent, seatTile: seats[sequence].seat,
  })));
  for (const [index, agent] of guests.entries()) {
    agent.phase = "seated";
    agent.moving = false;
    agent.c = agent.seatSpot!.stand.c;
    agent.r = agent.seatSpot!.stand.r;
    agent.px = agent.c * 16;
    agent.py = agent.r * 16;
    agent.guest.intent = intents[index];
  }
  const before = JSON.stringify(guests.map((agent) => agent.guest));

  const intentColors = ["#a86942", "#e95a72", "#5f83c1"];
  for (const [index, guest] of guests.entries()) {
    fills.length = 0;
    drawIntentBubble(ctx, guest, 0);
    check(`${intents[index]} 泡泡有可辨識的主色`, fills.some((pixel) => pixel.color === intentColors[index]));
    check(`${intents[index]} 泡泡位於角色頭頂`, fills.every((pixel) => pixel.y < guest.py));
  }

  // 🔴 可互動意圖必須比「只是來喝咖啡」明顯:更大的牌子 + 閃爍驚嘆號
  // 用「泡泡的實際覆蓋寬度」比大小,不用 fillRect 呼叫次數——後者跟顯眼程度無關。
  const area = (agent: (typeof guests)[number]) => {
    fills.length = 0;
    drawIntentBubble(ctx, agent, 0);
    const left = Math.min(...fills.map((p) => p.x));
    const right = Math.max(...fills.map((p) => p.x + p.w));
    return right - left;
  };
  const coffeeArea = area(guests[0]);
  check("想認養的泡泡明顯大於單純喝咖啡", area(guests[1]) > coffeeArea * 1.4, `${area(guests[1])} vs ${coffeeArea}`);
  check("想租房的泡泡明顯大於單純喝咖啡", area(guests[2]) > coffeeArea * 1.4, `${area(guests[2])} vs ${coffeeArea}`);
  const bang = (agent: (typeof guests)[number]) => {
    fills.length = 0;
    drawIntentBubble(ctx, agent, 0);
    return fills.some((pixel) => pixel.color === "#f6b93b");
  };
  check("兩種可互動意圖都帶驚嘆號(看得出可以點)", bang(guests[1]) && bang(guests[2]));
  check("單純喝咖啡的顧客不帶驚嘆號(不會誤導玩家去點)", !bang(guests[0]));

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

  // --- 2. P2 的三種點餐演出 ----------------------------------------------
  const buyer = createGuestAgents([generateCafeGuest({
    seed: "order-bubble", arrivedMs: 0, seatTile: seats[0].seat,
    order: { itemId: "cafe_menu_house_coffee", itemName: "招牌美式咖啡", price: 34, track: "coffee", served: true, missing: "", takeaway: false },
  })])[0];
  buyer.px = 5 * 16;
  buyer.py = 40 * 16;

  fills.length = 0;
  drawPixelText(ctx, "$34", 0, 0, "#112233");
  check("像素字模畫得出 $34(canvas 沒有 fillText,金額只能自己畫)",
    fills.filter((p) => p.color === "#112233").length >= 20, String(fills.length));

  buyer.phase = "ordering";
  fills.length = 0;
  drawOrderBubble(ctx, buyer);
  check("ordering 泡泡畫出咖啡杯圖示(他點的是什麼)", fills.some((p) => p.color === "#8a5a37"));
  check("ordering 泡泡畫出價格字(深色字模)", fills.some((p) => p.color === "#3f3446"));
  check("ordering 泡泡在角色頭頂", fills.every((p) => p.y < buyer.py));

  buyer.phase = "served";
  buyer.phaseT = 0.4;
  fills.length = 0;
  drawServedFloat(ctx, buyer);
  const greens = fills.filter((p) => p.color === "#5ee08a");
  check("served 有綠色 +$34 浮字", greens.length >= 20, String(greens.length));
  check("served 浮字有深色描邊(暖木地板上才看得清)", fills.some((p) => p.color === "#14301c"));
  const lowY = Math.min(...greens.map((p) => p.y));
  buyer.phaseT = 2.0;
  fills.length = 0;
  drawServedFloat(ctx, buyer);
  const laterY = Math.min(...fills.filter((p) => p.color === "#5ee08a").map((p) => p.y));
  check("served 浮字真的往上升(時間愈久位置愈高)", laterY < lowY, `${laterY} vs ${lowY}`);

  const refused = createGuestAgents([generateCafeGuest({
    seed: "refused-bubble", arrivedMs: 0,
    order: { itemId: "cafe_menu_latte", itemName: "經典拉花拿鐵", price: 40, track: "coffee", served: false, missing: "牛奶", takeaway: false },
  })])[0];
  refused.phase = "refused";
  refused.px = 5 * 16;
  refused.py = 40 * 16;
  fills.length = 0;
  drawRefusedBubble(ctx, refused);
  check("refused 是紅色 ❌ 泡泡", fills.filter((p) => p.color === "#e5395a").length >= 10);

  // drawGuestBubble 依 phase 分派,一次只畫一種
  for (const [phase, color] of [["ordering", "#8a5a37"], ["served", "#5ee08a"], ["refused", "#e5395a"]] as const) {
    const agent = phase === "refused" ? refused : buyer;
    agent.phase = phase;
    agent.phaseT = 0.3;
    fills.length = 0;
    drawGuestBubble(ctx, agent, 0);
    check(`drawGuestBubble 在 ${phase} 時只畫該階段的演出`, fills.some((p) => p.color === color));
  }
  buyer.phase = "departed";
  fills.length = 0;
  drawGuestBubble(ctx, buyer, 0);
  check("departed 顧客完全不畫任何泡泡", fills.length === 0);

  check("所有泡泡與浮字全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
