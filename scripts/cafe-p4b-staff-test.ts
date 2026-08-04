/**
 * 🔴 重設計 P4b:員工的畫面表現、吧台前的排隊、人力區塊的產能顯示(設計文件 §4.9)。
 *
 * 這一期只做**表現層**:`sim/cafe.ts` 的產能公式與 `sim/tick.ts` 的結帳/薪資
 * 一行都沒動。所以本測試釘的是四件事:
 *
 * 1. 吧台後的人數 = `cafeStaffCount()`,打烊/未開張時一個都不出現
 * 2. 站位一律由 `cafeStaffSpots()`(= `cafeCounterSpots()` 的另一側)推算,吧台搬到哪就跟到哪
 * 3. **人不夠才會排隊**——同一批顧客,員工少 ⇒ 隊伍長;員工夠 ⇒ 沒有人在排
 * 4. 面板的產能必須帶著真實席次與員工數算(P4b 之前漏帶,雇了人數字也不會動)
 */
import type { Ctx } from "../src/pixel/sprites";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateCafeGuest } from "../src/sim/cafeGuests";
import { composeFloor, drawStaff } from "../src/floor/floorScene";
import {
  createGuestAgents,
  orderingGuestViews,
  queuedGuestCount,
  tickGuestAgents,
} from "../src/floor/guestAgents";
import {
  createStaffAgents,
  staffAgentSignature,
  staffAppearance,
  syncStaffAgents,
  tickStaffAgents,
  STAFF_APRON,
  type StaffAgent,
} from "../src/floor/staffAgents";
import {
  addPlacement,
  cafeCounterSpots,
  cafeQueueTiles,
  cafeSeatSpots,
  cafeStaffSpots,
  placeCafeStarterSet,
  removePlacementAt,
} from "../src/sim/placements";
import {
  cafeCapability,
  cafeSeatCapacity,
  cafeStaffCount,
  cafeStaffWage,
  CAFE_STAFF_CUPS_PER_DAY,
  CAFE_STAFF_WAGE,
} from "../src/sim/cafe";
import { currentBlocked } from "../src/floor/pathfind";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const src = (file: string) => readFileSync(join(here, "..", "src", file), "utf8");

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.25; };

const ORDER = {
  itemId: "x", itemName: "招牌美式咖啡", price: 34, track: "coffee" as const,
  served: true, missing: "", takeaway: true,
};

/** 一批外帶顧客(不佔席 ⇒ 一路走到吧台就停在點餐/排隊,正好測隊伍)。 */
function takeawayAgents(count: number, seed: string) {
  const guests = Array.from({ length: count }, (_, sequence) => generateCafeGuest({
    seed, arrivedMs: sequence * 1000, sequence, seatTile: null, takeaway: true, order: ORDER,
  }));
  return createGuestAgents(guests);
}

try {
  placeCafeStarterSet(); // 開張贈品:吧台 (3,38) + 三組桌椅

  // -------------------------------------------------------------------------
  // A. 員工站在吧台後面
  // -------------------------------------------------------------------------
  const counters = cafeCounterSpots();
  const stations = cafeStaffSpots();
  check("吧台後有站位可用", stations.length >= 1, `stations=${JSON.stringify(stations)}`);
  check("員工站位與點餐位在吧台的**兩側**(不是同一排)",
    stations.every((tile) => counters.every((spot) => spot.r !== tile.r)),
    `staff=${JSON.stringify(stations)} counter=${JSON.stringify(counters)}`);
  check("員工站位比點餐位更靠內側(顧客在外、員工在裡)",
    stations.every((tile) => tile.r < counters[0].r));
  check("員工站位沿用點餐位那幾道(同一組 lane)",
    stations.every((tile) => counters.some((spot) => spot.c === tile.c)));
  check("員工站位都是可走格(沒有人站進牆或家具裡)",
    stations.every((tile) => currentBlocked()[tile.r]?.[tile.c] === false));

  check("開張後永遠至少一位店員(開張費已含首位)", cafeStaffCount(0) === 1 && cafeStaffCount(3) === 4);
  const three = createStaffAgents(cafeStaffCount(2), true);
  check("員工人數 = cafeStaffCount(extraStaff)", three.length === cafeStaffCount(2) && three.length === 3);
  check("員工都站在 cafeStaffSpots() 的格上",
    three.every((agent) => stations.some((tile) => tile.c === agent.c && tile.r === agent.r)),
    three.map((a) => `${a.c},${a.r}`).join(" "));
  check("員工外觀是決定性的(同 index 同一個人)",
    JSON.stringify(staffAppearance(1)) === JSON.stringify(staffAppearance(1))
    && JSON.stringify(staffAppearance(0)) !== JSON.stringify(staffAppearance(1)));
  check("員工制服不從顧客的襯衫色池抽(一眼分得出店員)",
    new Set([0, 1, 2, 3].map((i) => staffAppearance(i).shirt)).size === 1);

  // 🔴 cafe.open 閘門:打烊 / 未開張一個員工都不出現
  check("打烊(open=false)時吧台後沒有任何人", createStaffAgents(4, false).length === 0);
  check("打烊 signature 與營業中不同(會觸發清空)",
    staffAgentSignature(4, false) !== staffAgentSignature(4, true));
  const openAgents = syncStaffAgents(three, cafeStaffCount(2), true);
  check("再次同步依 index 保留既有 agent(不會每幀瞬移歸位)",
    openAgents.length === 3 && openAgents[0] === three[0]);
  check("打烊時同步一律清空", syncStaffAgents(openAgents, 3, false).length === 0);

  // 吧台搬走 ⇒ 站位跟著搬(沒有任何硬編座標)
  const movedCounterSpots = (() => {
    removePlacementAt(3, 38);
    addPlacement({ defId: "cafe_counter", room: "cafe_pet", c: 10, r: 44, rotation: 0 });
    return { counter: cafeCounterSpots(), staff: cafeStaffSpots() };
  })();
  check("搬動吧台後點餐位跟著搬", movedCounterSpots.counter.every((tile) => tile.r === 45),
    JSON.stringify(movedCounterSpots.counter));
  check("搬動吧台後員工站位也跟著搬(仍在吧台後方)",
    movedCounterSpots.staff.length > 0 && movedCounterSpots.staff.every((tile) => tile.r === 43),
    JSON.stringify(movedCounterSpots.staff));
  const movedStaff = createStaffAgents(1, true);
  check("重建後的員工站到新吧台後面",
    movedStaff[0].c === movedCounterSpots.staff[0].c && movedStaff[0].r === movedCounterSpots.staff[0].r);
  // 還原成開張贈品的擺法,後面的排隊測試才跑在預設場景上
  removePlacementAt(10, 44);
  addPlacement({ defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38, rotation: 0 });
  check("吧台還原後點餐位回到 (row 39)", cafeCounterSpots().every((tile) => tile.r === 39));

  // -------------------------------------------------------------------------
  // B. 🔴 排隊 = 產能不足的視覺信號
  // -------------------------------------------------------------------------
  const queue = cafeQueueTiles(6);
  check("排隊格由吧台往顧客側延伸", queue.length >= 4 && queue.every((tile) => tile.r > 39),
    JSON.stringify(queue));
  check("排隊格互不重疊、也不與點餐位重疊",
    new Set(queue.map((t) => `${t.c},${t.r}`)).size === queue.length
    && queue.every((tile) => !counters.some((spot) => spot.c === tile.c && spot.r === tile.r)));
  check("排隊格是一條連續的線(每一格都貼著前一格)",
    queue.every((tile, i) => i === 0 || Math.abs(tile.c - queue[i - 1].c) + Math.abs(tile.r - queue[i - 1].r) <= 2),
    JSON.stringify(queue));
  check("排隊格都是可走格", queue.every((tile) => currentBlocked()[tile.r]?.[tile.c] === false));
  check("不需要排隊時不配置任何排隊格", cafeQueueTiles(0).length === 0);

  // 同一批顧客,只有「同時能結帳的人數」不同
  const shortHanded = takeawayAgents(8, "p4b-queue");
  for (let i = 0; i < 260; i++) tickGuestAgents(shortHanded, 0.05, 0, undefined, undefined, 1);
  const shortQueue = queuedGuestCount(shortHanded);
  const wellStaffed = takeawayAgents(4, "p4b-queue");
  for (let i = 0; i < 260; i++) tickGuestAgents(wellStaffed, 0.05, 0, undefined, undefined, 4);
  const staffedQueue = queuedGuestCount(wellStaffed);
  check("人手不足時吧台前真的排起隊來", shortQueue >= 3, `queued=${shortQueue}`);
  check("人手足夠時沒有人在排隊", staffedQueue === 0, `queued=${staffedQueue}`);
  check("排隊的人各站一格,不會疊在一起",
    (() => {
      const tiles = shortHanded.filter((a) => a.queueTile).map((a) => `${a.queueTile!.c},${a.queueTile!.r}`);
      return new Set(tiles).size === tiles.length;
    })());
  check("同時在結帳的人數不超過員工數", orderingGuestViews(shortHanded).length <= 1,
    `ordering=${orderingGuestViews(shortHanded).length}`);
  check("排隊中的人面向吧台(背對鏡頭)",
    shortHanded.filter((a) => a.queueTile && !a.moving && a.r > 39).every((a) => a.view === "back"),
    shortHanded.filter((a) => a.queueTile).map((a) => `${a.view}@${a.c},${a.r}`).join(" "));

  // 隊伍會前進:前面的人點完離開,後面的人遞補
  const before = shortHanded.filter((a) => a.queueTile).map((a) => a.guest.id).join("|");
  for (let i = 0; i < 400; i++) tickGuestAgents(shortHanded, 0.05, 0, undefined, undefined, 1);
  const after = shortHanded.filter((a) => a.queueTile).map((a) => a.guest.id).join("|");
  check("隊伍會前進(排隊名單隨結帳推進而改變)", before !== after && after.length < before.length,
    `before=${before} after=${after}`);
  check("未指定員工數時行為與 P4b 之前相同(只受點餐位數限制)",
    (() => {
      const legacy = takeawayAgents(4, "p4b-legacy");
      for (let i = 0; i < 260; i++) tickGuestAgents(legacy, 0.05, 0);
      return queuedGuestCount(legacy) === 0;
    })());

  // -------------------------------------------------------------------------
  // C. 員工的三個狀態
  // -------------------------------------------------------------------------
  const worker = createStaffAgents(1, true);
  tickStaffAgents(worker, 0.05, [], 0);
  check("沒有客人時是待機", worker[0].phase === "idle" && worker[0].servingGuestId === null);
  check("待機時面向店裡", worker[0].view === "front");
  const counterGuest = { id: "g1", c: cafeCounterSpots()[0].c, r: cafeCounterSpots()[0].r };
  tickStaffAgents(worker, 0.05, [counterGuest], 0);
  check("有人結帳時切成 serving 並記下對象",
    worker[0].phase === "serving" && worker[0].servingGuestId === "g1");
  check("結帳時面向吧台前的顧客", worker[0].view === "front" && counterGuest.r > worker[0].r);
  tickStaffAgents(worker, 0.05, [counterGuest], 3);
  check("外面還有人排隊時切成 busy(連續動作)", worker[0].phase === "busy");
  tickStaffAgents(worker, 0.05, [], 0);
  check("客人走了就回到待機", worker[0].phase === "idle");

  const pair = createStaffAgents(2, true);
  const guestA = { id: "a", c: cafeCounterSpots()[0].c, r: cafeCounterSpots()[0].r };
  const guestB = { id: "b", c: cafeCounterSpots()[1].c, r: cafeCounterSpots()[1].r };
  for (let i = 0; i < 40; i++) tickStaffAgents(pair, 0.05, [guestA, guestB], 0);
  check("兩位員工各接一位顧客(不會兩人搶同一位)",
    pair[0].servingGuestId !== pair[1].servingGuestId
    && new Set(pair.map((a) => a.servingGuestId)).size === 2);
  check("員工會挪到顧客正對面那一格",
    pair.every((agent) => agent.c === (agent.servingGuestId === "a" ? guestA.c : guestB.c)),
    pair.map((a) => `${a.servingGuestId}@${a.c},${a.r}`).join(" "));
  check("員工全程沒有離開吧台後方那一排",
    pair.every((agent) => cafeStaffSpots().some((tile) => tile.c === agent.c && tile.r === agent.r)));

  // -------------------------------------------------------------------------
  // D. 面板產能顯示(P4b 修掉的 bug)
  // -------------------------------------------------------------------------
  const seats = cafeSeatSpots().length;
  const bare = cafeCapability([]);
  const real = cafeCapability([], { seats, extraStaff: 2 });
  check("修前:不帶參數的產能只認得首位店員", bare.capacity === CAFE_STAFF_CUPS_PER_DAY && bare.seatCapacity === null);
  check("修後:產能 = min(席次量, 員工量)",
    real.capacity === Math.min(cafeSeatCapacity(seats), 3 * CAFE_STAFF_CUPS_PER_DAY)
    && real.staffCount === 3);
  check("修前/修後真的是不同的數字(雇了人面板才會動)", bare.capacity !== real.capacity,
    `bare=${bare.capacity} real=${real.capacity} seats=${seats}`);
  check("日薪只算第二位起(首位在固定開銷裡)",
    real.dailyWage === cafeStaffWage(2) && real.dailyWage === 2 * CAFE_STAFF_WAGE);
  const panel = src("components/CafePanel.vue");
  check("CafePanel 的 cafeCapability 有帶席次與員工數",
    /cafeCapability\(state\.cafe\.upgrades,\s*\{[\s\S]{0,160}seats:[\s\S]{0,160}extraStaff:/.test(panel));
  check("CafePanel 的席次來自 cafeSeatSpots()", panel.includes("cafeSeatSpots().length"));
  check("人力區塊呼叫 P4a 的純函式", panel.includes("hireCafeStaff(") && panel.includes("fireCafeStaff("));
  check("人力區塊有負荷進度條", panel.includes("progress load") && panel.includes("今日負荷"));

  // -------------------------------------------------------------------------
  // E. 繪製
  // -------------------------------------------------------------------------
  const fills: Array<{ color: string }> = [];
  const ctx = {
    fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, lineWidth: 1,
    fillRect() { fills.push({ color: String(this.fillStyle) }); },
    strokeRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {},
  } as unknown as Ctx;
  const drawn: StaffAgent = createStaffAgents(1, true)[0];
  drawStaff(ctx, drawn);
  check("drawStaff 畫出制服圍裙", fills.some((pixel) => pixel.color === STAFF_APRON));
  const soloPixels = fills.length;
  fills.length = 0;
  composeFloor(ctx, 0, [], undefined, 12, [], [], [], true, [drawn]);
  check("composeFloor 的員工分支真的有畫到人",
    fills.some((pixel) => pixel.color === STAFF_APRON) && fills.length > soloPixels);
  fills.length = 0;
  composeFloor(ctx, 0, [], undefined, 12, [], [], [], false, []);
  check("打烊時畫面上沒有員工", !fills.some((pixel) => pixel.color === STAFF_APRON));

  // -------------------------------------------------------------------------
  // F. 硬性約束
  // -------------------------------------------------------------------------
  const staffSource = src("floor/staffAgents.ts");
  const staffCode = staffSource.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  check("staffAgents 沒有 Math.random(註解不算)", !staffCode.includes("Math.random"));
  check("staffAgents 不 import store/tick(表現層不碰模擬)",
    !/from "\.\.\/store"/.test(staffSource) && !/from "\.\.\/sim\/tick"/.test(staffSource));
  check("staffAgents 不自己算薪資或產能",
    !staffSource.includes("cafeStaffWage") && !staffSource.includes("cafeCapability"));
  check("員工/排隊全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
