/**
 * 咖啡廳重設計 P4a:**四階段成長曲線的實測**腳本(設計文件 §4.7)。
 *
 * §4.7 拍板「咖啡廳可以慢慢成長取代收租」,並給了一張四階段的**設計目標值**表。
 * 本腳本用真的模擬迴圈(開店前 `cafeRestockPass` + 逐小時 `cafeHourlyPass`
 * + 換日 `cafeDailyPass`)把那張表量一次,並與**淨租金**對照。
 *
 * 每個階段都照設計表擺出對應的招牌等級、席次(真的擺椅子,走 `cafeSeatSpots()`)、
 * 額外員工與研發進度,再跑 28 天暖身 + 112 天量測。常備訂單走「依上週銷量建議」
 * 那條懶人路線(每 7 天按一次),因為那正是設計文件 §4.3.1 預期的玩法。
 *
 * 最後一列是**過度擴張**對照組:成長期的客流卻雇了 4 個人。
 *
 * 只印數字、不斷言 ⇒ 與 `cafe-opening-sim.ts` 一樣**刻意不列入回歸集**
 * (成長曲線的硬性護欄改由 `cafe-p4a-growth-test.ts` 斷言)。
 *   npx tsx scripts/cafe-growth-sim.ts
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START } = await import("../src/sim/gameState");
const { cafeDailyPass, cafeHourlyPass, cafeRestockPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const {
  cafeCapability, cafeStaffWage, menuItems, suggestedStandingOrders, suggestStandingOrdersFromSales,
  CAFE_FIXED_COST, CAFE_UPGRADE_IDS, CAFE_RESEARCH_IDS,
} = await import("../src/sim/cafe");
const { placements, addPlacement, placeCafeStarterSet, cafeSeatSpots, cafeAmbiancePoints } = await import("../src/sim/placements");
const { buildGrid } = await import("../src/floor/map");
const { BASE_UPKEEP, PER_ROOM_UPKEEP } = await import("../src/sim/economy");

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const WARMUP = 28;   // 讓人氣爬滿、讓「依上週銷量建議」收斂
const DAYS = 112;    // 16 個遊戲週:天氣與星期的分佈都跑得夠平
const RESUGGEST_EVERY = 7;

// ---------------------------------------------------------------------------
// 席次:真的擺椅子,不是塞一個數字進公式
// ---------------------------------------------------------------------------

const CAFE_REGIONS = new Set(["cafe_floor", "cafe_counter", "cafe_pet", "cafe_back"]);

/** 把內用席次調整到 `target` 張:先擺開張贈品,再逐張補椅子/拆椅子。 */
function setSeats(target: number) {
  placements.list.splice(0, placements.list.length);
  placeCafeStarterSet();
  const grid = buildGrid();
  // 補:只留下「真的讓 cafeSeatSpots() 多一席」的那些格,被圍死的直接還原
  for (let r = 36; r <= 50 && cafeSeatSpots().length < target; r++) {
    for (let c = 1; c <= 14 && cafeSeatSpots().length < target; c++) {
      const region = grid[r]?.[c];
      if (!region || !CAFE_REGIONS.has(region)) continue;
      if (placements.list.some((p) => p.c === c && p.r === r)) continue;
      const before = cafeSeatSpots().length;
      addPlacement({ defId: "cafe_chair_front", room: region, c, r, rotation: 0 });
      if (cafeSeatSpots().length <= before) {
        placements.list.splice(placements.list.findIndex((p) => p.c === c && p.r === r), 1);
      }
    }
  }
  // 拆:從最後擺的往回拆,直到剛好等於 target(開張贈品席次比設計表的 6 席多)
  while (cafeSeatSpots().length > target && placements.list.length > 0) {
    const seatIds = new Set(["cafe_chair_front", "cafe_chair_side", "cafe_table"]);
    const index = [...placements.list].reverse().findIndex((p) => seatIds.has(p.defId));
    if (index < 0) break;
    placements.list.splice(placements.list.length - 1 - index, 1);
  }
  return cafeSeatSpots().length;
}

// ---------------------------------------------------------------------------
// 階段
// ---------------------------------------------------------------------------

const SIGN_LV2 = [CAFE_UPGRADE_IDS.signboard];
const SIGN_LV3 = [...SIGN_LV2, CAFE_UPGRADE_IDS.signboardLv3];
const SIGN_LV4 = [...SIGN_LV3, CAFE_UPGRADE_IDS.signboardLv4];

const ROOTS = [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals];
const SIX = [...ROOTS, CAFE_RESEARCH_IDS.pourOver, CAFE_RESEARCH_IDS.scone, CAFE_RESEARCH_IDS.petTreat];
const ALL = Object.values(CAFE_RESEARCH_IDS);

/** 名店期玩家會把五項永久投資都買齊,不會只買招牌。 */
const FULL_KIT = [
  CAFE_UPGRADE_IDS.secondMachine, CAFE_UPGRADE_IDS.outdoorSeats,
  CAFE_UPGRADE_IDS.coldStorage, CAFE_UPGRADE_IDS.petTower,
];

interface Stage {
  label: string;
  upgrades: string[];
  seats: number;
  extraStaff: number;
  completed: string[];
  /** 設計文件 §4.7 的目標日淨利;`null` = 設計表沒有這一列(本腳本補的對照組)。 */
  target: number | null;
}

const STAGES: Stage[] = [
  { label: "開張期 Lv1", upgrades: [], seats: 6, extraStaff: 0, completed: [], target: 98 },
  { label: "成長期 Lv2", upgrades: SIGN_LV2, seats: 12, extraStaff: 1, completed: ROOTS, target: 430 },
  { label: "成熟期 Lv3", upgrades: SIGN_LV3, seats: 20, extraStaff: 2, completed: SIX, target: 900 },
  { label: "名店期 Lv4", upgrades: SIGN_LV4, seats: 32, extraStaff: 4, completed: ALL, target: 1620 },
  // 🔴 第五條虧損管道:成長期的客流,卻雇了 4 個人。
  { label: "⚠️ 過度擴張", upgrades: SIGN_LV2, seats: 12, extraStaff: 4, completed: ROOTS, target: -426 },
  // 以下兩列設計表沒有,是 P4a 補的診斷:設計表的 +4 人其實**多雇了一個**
  // (Lv4 的實際客流撐不到 5 人份產能),而名店期玩家也不會只買招牌。
  { label: "· 名店期 +3 人", upgrades: SIGN_LV4, seats: 32, extraStaff: 3, completed: ALL, target: null },
  { label: "· 名店期全設備", upgrades: [...SIGN_LV4, ...FULL_KIT], seats: 32, extraStaff: 3, completed: ALL, target: null },
];

function run(stage: Stage) {
  const seats = setSeats(stage.seats);
  state.money = 50_000_000; // 只量營運損益,不讓現金不足夾住 addMoney
  state.ledger.splice(0, state.ledger.length);
  Object.assign(state.cafe, defaultCafe(), {
    open: true,
    standingOrders: suggestedStandingOrders(),
    stock: suggestedStandingOrders(),
    upgrades: stage.upgrades,
    completed: stage.completed,
    extraStaff: stage.extraStaff,
    popularity: 0,
  });

  let revenue = 0;
  let guests = 0;
  let refused = 0;
  let restock = 0;
  let net = 0;
  let capped = 0;

  for (let day = 0; day < WARMUP + DAYS; day++) {
    const measuring = day >= WARMUP;
    if (day % RESUGGEST_EVERY === 0) {
      state.cafe.standingOrders = suggestStandingOrdersFromSales(
        state.cafe.sales, menuItems(state.cafe.completed),
      ).orders;
    }
    const before = state.money;
    state.gameMs = GAME_START.getTime() + day * DAY_MS + (CAFE_OPEN_HOUR - 1) * HOUR_MS;
    cafeRestockPass(CAFE_OPEN_HOUR - 1);
    for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
      state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
      cafeHourlyPass(hour);
    }
    const sale = state.cafe.sales[state.cafe.sales.length - 1];
    state.gameMs = GAME_START.getTime() + day * DAY_MS;
    cafeDailyPass();
    const record = state.cafe.history[state.cafe.history.length - 1];
    if (!measuring) continue;
    revenue += record.revenue;
    guests += record.guests;
    refused += sale?.refused ?? 0;
    restock += sale?.restockCost ?? 0;
    net += state.money - before;
    const cap = cafeCapability(state.cafe.upgrades, { seats, extraStaff: state.cafe.extraStaff });
    if (record.guests >= cap.capacity) capped++;
  }

  const per = (n: number) => n / DAYS;
  const cap = cafeCapability(state.cafe.upgrades, { seats, extraStaff: state.cafe.extraStaff });
  return {
    stage,
    seats,
    ambiance: cafeAmbiancePoints(),
    capacity: cap.capacity,
    seatCapacity: cap.seatCapacity ?? 0,
    staffCapacity: cap.staffCapacity,
    wage: cafeStaffWage(state.cafe.extraStaff),
    guests: per(guests),
    refused: per(refused),
    revenue: per(revenue),
    restock: per(restock),
    net: per(net),
    ticket: guests > 0 ? revenue / guests : 0,
    cappedDays: capped,
    popularity: state.cafe.popularity,
  };
}

// ---------------------------------------------------------------------------
// 對照基準:淨租金
// ---------------------------------------------------------------------------

/**
 * 兩條靶都要印,因為它們回答的是不同的問題:
 *
 * - **設計靶 $1,083**:§4.7 寫的「四房滿租月租約 $52,000」⇒ 日收 $1,733 − 管理費 $650。
 *   那是**四房都住滿、而且都是高租金租客**的理想上限,是設計表對照的那個數字。
 * - **種子局實測靶**:目前存檔真的收得到的租金 − 真的付得出的管理費。
 *   玩家實際感受到的「咖啡廳追上收租了沒」是這一條。
 */
const DESIGN_NET_RENT = 52_000 / 30 - 650;

const dailyRent = Object.values(state.runtimes)
  .reduce((sum, runtime) => sum + Math.round(runtime.tenant.finance.monthlyRent / 30), 0);
const dailyUpkeep = BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP;
const seedNetRent = dailyRent - dailyUpkeep;

console.log(`\n=== 咖啡廳成長曲線實測(暖身 ${WARMUP} 天 + 量測 ${DAYS} 天,常備量走「依上週銷量建議」)===`);
console.log(`設計靶(§4.7 四房滿租):$52,000/月 ÷ 30 − 管理費 $650 = **淨租金 $${DESIGN_NET_RENT.toFixed(0)}/日**`);
console.log(`種子局實測靶:日租金 $${dailyRent} − 管理費 $${dailyUpkeep} = **淨租金 $${seedNetRent}/日**`);
console.log(`固定開銷 $${CAFE_FIXED_COST}/日(已含首位店員);額外員工每人 −$260/日\n`);

console.log(
  "階段".padEnd(14) + "席次 產能(席/員)  日客流  撲空 客單價    營收     進貨     薪資     實測淨利  佔設計靶 佔種子局  設計值",
);
const rows = STAGES.map(run);
for (const r of rows) {
  console.log(
    r.stage.label.padEnd(12)
    + `${String(r.seats).padStart(4)}`
    + `${(`${r.capacity}(${r.seatCapacity}/${r.staffCapacity})`).padStart(13)}`
    + `${r.guests.toFixed(1).padStart(8)}`
    + `${r.refused.toFixed(1).padStart(6)}`
    + `${("$" + r.ticket.toFixed(1)).padStart(8)}`
    + `${("$" + r.revenue.toFixed(0)).padStart(9)}`
    + `${("−$" + r.restock.toFixed(0)).padStart(9)}`
    + `${("−$" + r.wage).padStart(9)}`
    + `${((r.net >= 0 ? "+$" : "−$") + Math.abs(r.net).toFixed(0)).padStart(10)}`
    + `${((r.net / DESIGN_NET_RENT * 100).toFixed(0) + "%").padStart(9)}`
    + `${((r.net / seedNetRent * 100).toFixed(0) + "%").padStart(9)}`
    + `${(r.stage.target === null ? "—" : (r.stage.target >= 0 ? "+$" : "−$") + Math.abs(r.stage.target)).padStart(9)}`,
  );
}

const flagship = rows[3];
const overreach = rows[4];
const tuned = rows[5];
const kitted = rows[6];
console.log(`\n🔴 名店期 > 100% 淨租金(設計靶 $${DESIGN_NET_RENT.toFixed(0)}):`
  + `照設計表 +4 人 ${flagship.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${flagship.net.toFixed(0)});`
  + ` 人力最佳化 +3 人 ${tuned.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${tuned.net.toFixed(0)});`
  + ` 全設備 ${kitted.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${kitted.net.toFixed(0)})`);
console.log(`🔴 過度擴張會虧:${overreach.net < 0 ? "成立" : "不成立"}`
  + `(實測 $${overreach.net.toFixed(0)};同客流同席次但只雇 1 人時是 +$${rows[1].net.toFixed(0)}`
  + `,多雇 3 人吃掉 $${(rows[1].net - overreach.net).toFixed(0)})`);
console.log("\n實測與設計值有出入是正常的;本腳本只量,不反過來調參數。");
