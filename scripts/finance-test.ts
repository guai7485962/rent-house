/**
 * 月報表/資產淨值(§7-1)驗證:
 * - netWorth:現金 + 家具轉售值(半價)+ 改建成本;買家具後現金↓但淨值只掉一半差額
 * - monthlyFlow:承租人月租合計(同居者不計)- 月管理費
 * - monthReport:只彙整遊戲時間「本月」的 ledger
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { netWorth, monthlyFlow, monthReport, dailyFlow } = await import("../src/sim/finance");
const { buyFurniture, addMoney, BASE_UPKEEP, PER_ROOM_UPKEEP, coinLaundryIncome, collectRent, grantStarterBonus, DEPOSIT_MONTHS, WASHER_DAILY_PER_ROOM, STARTER_BONUS } = await import("../src/sim/economy");
const { moveIn } = await import("../src/sim/tenancy");
const { generateApplicants } = await import("../src/sim/recruit");
const { getPlacements } = await import("../src/sim/placements");
const { getDef } = await import("../src/furniture/catalog");
const { upgradeState, UPGRADES } = await import("../src/sim/upgrades");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- netWorth ---
let w = netWorth();
const expectedFurniture = getPlacements().reduce((s, p) => s + Math.round(getDef(p.defId).price * 0.5), 0);
check("現金 = state.money", w.cash === state.money);
check("家具 = 全部擺設的半價合計", w.furniture === expectedFurniture, `${w.furniture} vs ${expectedFurniture}`);
check("初始無改建 → upgrades = 0", w.upgrades === 0);
check("total = 三項合計", w.total === w.cash + w.furniture + w.upgrades);

// 買一件家具:現金 -price、家具 +price/2 → 淨值只掉一半
state.money = 50000;
const before = netWorth().total;
const def = getDef(getPlacements()[0].defId);
const res = buyFurniture(def.id, "r303");
check("買家具成功", res.ok);
w = netWorth();
check("買家具後淨值只掉轉售差額(現金 -price、家具 +price/2)", w.total === before - def.price + Math.round(def.price * 0.5), `before=${before} after=${w.total} price=${def.price}`);

// 改建計入
upgradeState.byRoom.r301 = [UPGRADES[0].id];
check("改建以成本計入淨值", netWorth().upgrades === UPGRADES[0].price);
delete upgradeState.byRoom.r301;

// --- monthlyFlow ---
const f = monthlyFlow();
const expectRent = Object.values(state.occupancy).reduce((s, tid) => s + (state.runtimes[tid]?.tenant.finance.monthlyRent ?? 0), 0);
check("月租金流 = 承租人月租合計", f.rentIn === expectRent);
check("月管理費公式一致", f.upkeepOut === (BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP) * 30);
check("net = 租金 - 管理費", f.net === f.rentIn - f.upkeepOut);

// 同居者不計租
const bId = state.occupancy.r302;
delete state.occupancy.r302;
state.cohabits[bId] = "r301";
check("同居者月租不計入", monthlyFlow().rentIn === expectRent - state.runtimes[bId].tenant.finance.monthlyRent);
delete state.cohabits[bId];
state.occupancy.r302 = bId;

// --- dailyFlow(預估每日淨現金流)---
const df = dailyFlow();
check("每日管理費 = 基本 + 每房", df.upkeepOut === BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP);
check("每日淨 = 實收租 + 被動收入 - 管理費", df.net === df.rentIn + df.passiveIn - df.upkeepOut);
check("dailyFlow.passiveIn = coinLaundryIncome", df.passiveIn === coinLaundryIncome());
check("實收租金 > 0 且不超過名目日租合計", df.rentIn > 0 && df.rentIn <= Object.values(state.occupancy).reduce((s, tid) => s + Math.ceil((state.runtimes[tid]?.tenant.finance.monthlyRent ?? 0) / 30), 0) + 4);
// 好感提升 → 實收租金增加(和收租同公式,正向循環看得見)
const someId = Object.values(state.occupancy)[0];
const rentBefore = dailyFlow().rentIn;
state.runtimes[someId].tenant.stats.affinity = 100;
check("好感拉滿後預估實收租金上升", dailyFlow().rentIn > rentBefore);

// --- monthReport ---
state.ledger.splice(0);
const now = new Date(state.gameMs);
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).getTime();
state.ledger.push({ gameMs: lastMonth, label: "上月租金", amount: 9999, category: "rent" });
addMoney(3000, "本月租金", "rent");
addMoney(-1000, "本月維修", "upkeep");
const m = monthReport();
check("本月收入只算本月", m.income === 3000);
check("本月支出只算本月", m.expense === 1000);
check("本月淨額", m.net === 2000);
check("月份正確", m.month === now.getMonth() + 1);

// --- 投幣洗衣機被動收入 ---
const washers = getPlacements().filter((p) => p.defId === "laundry_washer").length;
const rooms = Object.keys(state.occupancy).length;
check("coinLaundryIncome = 台數 × 每房 × 住人房數", coinLaundryIncome() === washers * WASHER_DAILY_PER_ROOM * rooms);
check("有洗衣機 + 有租客 → 被動收入 > 0", coinLaundryIncome() > 0);
const coin = coinLaundryIncome();
state.ledger.splice(0);
collectRent();
check("collectRent 有一筆投幣洗衣機收入 = coinLaundryIncome", state.ledger.some((t) => t.label === "投幣洗衣機收入" && t.amount === coin));

// --- 入住押金:招租一次性收入 ---
const vacant = ["r301", "r302", "r303", "r304"].find((r) => !state.occupancy[r]);
if (vacant) {
  state.ledger.splice(0);
  const app = generateApplicants(vacant)[0];
  moveIn(vacant, app);
  check("入住 → 押金收入 = 月租 × DEPOSIT_MONTHS", state.ledger.some((t) => t.label.includes("入住押金") && t.amount === app.monthlyRent * DEPOSIT_MONTHS));
}

// --- 開辦補助金:一次性、冪等 ---
state.starterBonusGiven = false;
state.money = 1000;
grantStarterBonus();
check("開辦補助金:發放後入帳且旗標設起", state.starterBonusGiven && state.money === 1000 + STARTER_BONUS);
const afterBonus = state.money;
grantStarterBonus();
check("開辦補助金:冪等不重複發", state.money === afterBonus);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
