/**
 * 咖啡廳重設計 P3:**進貨時機 + 損耗調校 + 建議常備量 + 銷售排行**。
 *
 * P1 的實測發現「缺貨」與「備太多」都不痛(設計文件 §4.7 的實測回填),
 * 根因是進貨掛在**日結**、而且是「補到常備量」——少備料等於少付錢。
 * P3 把進貨移到**開店前**,於是玩家先付錢、後賺錢。本測試把這件事釘死:
 *
 * 1. 🔴 進貨時機 —— 09:00 扣款、一天只扣一次、打烊後不補、未開張完全不碰
 * 2. 🔴 離線一致性 —— 線上逐時 24 小時 vs 離線 `syncToNow()` 一次補,逐欄相同
 * 3. 🔴 損耗調校 —— 建議常備量**保證零損耗**(懶人路線),多備 50% 則明確虧錢
 * 4. 建議常備量 —— 算式、fallback、不產生 0/NaN
 * 5. 銷售排行 —— 排序、缺貨次數、7 日窗口
 * 6. 零 RNG
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START } = await import("../src/sim/gameState");
const {
  cafeDailyPass, cafeHourlyPass, cafeRestockPass, hourlyTick, syncToNow,
  CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR,
} = await import("../src/sim/tick");
const {
  applySpoilage, cafeIngredientPeakDemand, cafeSalesRanking, menuItems,
  suggestedStandingOrders, suggestStandingOrdersFromSales,
  CAFE_SALES_WINDOW_DAYS, CAFE_SUGGEST_BUFFER, CAFE_SUGGEST_MIN_SERVINGS,
  SPOILAGE_FREE_UNITS, SPOILAGE_RATE,
} = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");
const { CAFE_RESEARCH_IDS } = await import("../src/content/cafeResearch");
const { placeCafeStarterSet } = await import("../src/sim/placements");
import type { CafeSalesDay } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const RESTOCK_HOUR = CAFE_OPEN_HOUR - 1;
const at = (day: number, hour: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS; };
const setCafe = (patch: Partial<typeof state.cafe>) => Object.assign(state.cafe, defaultCafe(), patch);
const stockValue = (stock: Record<string, number>) =>
  CAFE_INGREDIENTS.reduce((sum, item) => sum + (stock[item.id] ?? 0) * item.unitPrice, 0);

/** 跑完整的一個營業日:開店前進貨 → 11 個營業小時 → 換日日結。 */
function runBusinessDay(day: number) {
  at(day, RESTOCK_HOUR);
  cafeRestockPass(RESTOCK_HOUR);
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    at(day, hour);
    cafeHourlyPass(hour);
  }
  at(day, 0);
  cafeDailyPass();
}

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.5; };

try {
  placeCafeStarterSet(); // 開張贈品 = 吧台 + 三組桌椅(席次來源)
  // 零 RNG 只針對咖啡廳自己的路徑計數:第三節的 hourlyTick()/syncToNow() 會跑整個
  // 世界(租客事件、寵物、維修…),那些既有系統本來就有 RNG,不在本測試的觀察範圍。
  const rngMark1 = randomCalls;

  // =========================================================================
  // 一、🔴 進貨時機:09:00 扣款,一天只扣一次
  // =========================================================================
  state.money = 400_000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: {}, popularity: 50 });

  at(0, RESTOCK_HOUR);
  const beforeRestock = state.money;
  cafeRestockPass(RESTOCK_HOUR);
  const spent = beforeRestock - state.money;
  check("開店前(09:00)就扣進貨款", spent > 0, `spent=$${spent}`);
  check("扣完款庫存就補到常備量(開門時貨已經在店裡)",
    CAFE_INGREDIENTS.every((item) => state.cafe.stock[item.id] === item.defaultStandingOrder),
    JSON.stringify(state.cafe.stock));
  check("進貨金額 = 補進來的庫存價值", spent === stockValue(state.cafe.stock), `$${spent}`);
  check("進貨記在 ledger 的「咖啡廳進貨」/cafe 分類",
    state.ledger.some((t) => t.label === "咖啡廳進貨" && t.category === "cafe" && t.amount === -spent));

  const record0 = state.cafe.sales[state.cafe.sales.length - 1];
  check("🔴 當日銷售紀錄帶著 restocked 旗標與進貨金額",
    record0.restocked === true && record0.restockCost === spent, JSON.stringify(record0));

  const moneyAfterFirst = state.money;
  for (let hour = RESTOCK_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    at(0, hour);
    cafeRestockPass(hour);
  }
  check("🔴 同一天再呼叫 12 次,一毛錢都不會再扣(restocked 旗標的冪等性)",
    state.money === moneyAfterFirst, `$${moneyAfterFirst} → $${state.money}`);
  check("同一天重複呼叫也不會多記 ledger",
    state.ledger.filter((t) => t.label === "咖啡廳進貨").length === 1);

  // 打烊之後(> 20:00)不進貨:買一批東西進來只是等著半夜壞掉
  at(1, CAFE_CLOSE_HOUR + 1);
  const beforeLate = state.money;
  state.cafe.stock = {};
  cafeRestockPass(CAFE_CLOSE_HOUR + 1);
  check("🔴 打烊後不進貨", state.money === beforeLate && Object.keys(state.cafe.stock).length === 0);
  at(1, RESTOCK_HOUR - 1);
  cafeRestockPass(RESTOCK_HOUR - 1);
  check("🔴 開店前一小時之前(08:00)也不進貨", state.money === beforeLate);
  at(1, RESTOCK_HOUR);
  cafeRestockPass(RESTOCK_HOUR);
  check("同一天到了 09:00 才真的進貨", state.money < beforeLate);

  // 未開張 = 天然閘門
  const closedMoney = state.money;
  setCafe({ open: false, standingOrders: suggestedStandingOrders(), stock: { milk: 3 } });
  const closedLedger = state.ledger.length;
  for (let hour = 0; hour < 24; hour++) { at(2, hour); cafeRestockPass(hour); }
  check("🔴 未開張:money / ledger / 庫存 / 銷售紀錄一律不動(平衡快照零漂移的閘門)",
    state.money === closedMoney && state.ledger.length === closedLedger
    && state.cafe.stock.milk === 3 && state.cafe.sales.length === 0);

  // 錢不夠只補得起的部分,而且不會變負
  state.money = 50;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: {}, popularity: 10 });
  at(3, RESTOCK_HOUR);
  cafeRestockPass(RESTOCK_HOUR);
  check("錢不夠:只補得起的部分,money 仍非負", state.money >= 0, `$${state.money}`);
  check("錢不夠:庫存不會變負", Object.values(state.cafe.stock).every((n) => n >= 0));
  check("錢不夠:補不滿會扣一點聲譽(跨日的軟性扣分)", state.cafe.popularity < 10, String(state.cafe.popularity));

  // =========================================================================
  // 二、🔴 帳目:history 的 cost 含當日開店前的進貨
  // =========================================================================
  state.money = 400_000;
  state.ledger.splice(0, state.ledger.length);
  // 庫存刻意留空:進貨才會真的花到錢(常備量已經滿的話當天本來就不用補)
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: {}, popularity: 70 });
  const beforeDay = state.money;
  runBusinessDay(9);
  const hist = state.cafe.history[state.cafe.history.length - 1];
  check("🔴 一整天下來 money 的變動 = 營收 − history.cost(帳三方對得起來)",
    state.money - beforeDay === hist.revenue - hist.cost,
    `money ${state.money - beforeDay} vs ${hist.revenue - hist.cost}`);
  check("history.cost 含進貨(不是只有固定開銷)", hist.cost > 370, `$${hist.cost}`);
  check("history.net = revenue − cost", hist.net === hist.revenue - hist.cost);
  check("ledger 三種標籤都在(營收/進貨/固定開銷)",
    ["咖啡廳營收", "咖啡廳進貨", "咖啡廳固定開銷"].every((label) => state.ledger.some((t) => t.label === label)));

  // =========================================================================
  // 三、🔴 離線一致性:線上逐時 24 小時 vs 離線一次補完
  //
  // 起點刻意選 03:00,讓這 24 小時**完整跨過 09:00 的進貨與午夜的日結**——
  // 這正是進貨移位之後最容易破的一段。
  // =========================================================================
  const THREE_AM = new Date(2026, 6, 20, 3, 0, 0).getTime();
  // 🔴 只比對咖啡廳自己的欄位與 cafe 分類的帳。原始 `state.money` 不能拿來比:
  // 這 24 小時跨過午夜 ⇒ 會收租,而租金吃租客的滿意度——第一輪跑完已經把租客
  // 推進了 24 小時,第二輪的租客起點本來就不同。那是既有系統的狀態延續,
  // 不是進貨時機的問題;把它算進來只會讓這條斷言變成噪音。
  const snapshot = () => JSON.stringify({
    cafeNet: state.ledger.filter((t) => t.category === "cafe").reduce((sum, t) => sum + t.amount, 0),
    stock: state.cafe.stock,
    popularity: state.cafe.popularity,
    sales: state.cafe.sales,
    history: state.cafe.history,
    ledger: state.ledger.filter((t) => t.category === "cafe").map((t) => ({ label: t.label, amount: t.amount })),
  });
  const setupOffline = () => {
    state.money = 400_000;
    state.ledger.splice(0, state.ledger.length);
    // 庫存留空 ⇒ 09:00 那筆進貨一定會動到錢,「只扣一次」才驗得到
    setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: {}, popularity: 45 });
    state.gameMs = THREE_AM;
  };
  const cafeRandomBeforeOffline = randomCalls - rngMark1;

  setupOffline();
  for (let i = 0; i < 24; i++) hourlyTick(false);
  const online = snapshot();
  const onlineGameMs = state.gameMs;
  const onlineRestocks = state.ledger.filter((t) => t.label === "咖啡廳進貨").length;

  setupOffline();
  state.gameAnchorMs = state.gameMs;
  state.realAnchorMs = Date.now() - Math.round((24.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  check("離線補進度確實補了 24 個遊戲小時", caught === 24, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs);
  check("🔴 離線一致性:咖啡廳現金流 / 庫存 / 聲譽 / 銷售紀錄 / history / 咖啡廳帳本逐欄相同",
    online === snapshot(), online === snapshot() ? "" : `\n     線上 ${online.slice(0, 320)}\n     離線 ${snapshot().slice(0, 320)}`);
  check("🔴 跨過一整天只進一次貨(離線補進度不會重複扣款)",
    onlineRestocks === 1 && state.ledger.filter((t) => t.label === "咖啡廳進貨").length === 1,
    `線上 ${onlineRestocks} 筆`);
  check("這 24 小時真的做了生意(否則上面幾條是假通過)",
    state.cafe.history.length > 0 && state.cafe.history[state.cafe.history.length - 1].revenue > 0);

  // =========================================================================
  // 四、🔴 損耗調校(設計文件 §4.3.1 懶人路線 vs §4.7「備太多反而虧」)
  // =========================================================================
  const rngMark2 = randomCalls;
  check("損耗旋鈕:免損耗額度 23、損耗率 0.9(推導見 cafe.ts)",
    SPOILAGE_FREE_UNITS === 23 && SPOILAGE_RATE === 0.9, `${SPOILAGE_FREE_UNITS}/${SPOILAGE_RATE}`);

  // 🔴 懶人路線的**數學保證**:進貨只會把庫存補「到」常備量,消耗只會讓它變少
  //    ⇒ 夜間剩餘永遠 <= 常備量。所以只要常備量本身零損耗,懶人路線就恆零損耗。
  const lazyLeftoverWorstCase = suggestedStandingOrders();
  check("🔴 懶人路線:建議常備量原封不動放一整夜也零損耗(最壞情況:一位客人都沒來)",
    applySpoilage(lazyLeftoverWorstCase).totalSpoiled === 0, JSON.stringify(applySpoilage(lazyLeftoverWorstCase).lines));
  check("🔴 每一種生鮮的建議常備量都在免損耗額度的收斂上界之內",
    CAFE_INGREDIENTS.filter((i) => i.perishable)
      .every((i) => i.defaultStandingOrder <= SPOILAGE_FREE_UNITS + Math.ceil(1 / SPOILAGE_RATE) - 1),
    CAFE_INGREDIENTS.filter((i) => i.perishable).map((i) => `${i.name}=${i.defaultStandingOrder}`).join(","));

  // 備貨過量:易腐品多備 50% ⇒ 夜間剩餘明顯高於額度 ⇒ 每天丟掉一筆錢
  const over: Record<string, number> = {};
  for (const item of CAFE_INGREDIENTS) over[item.id] = item.perishable ? Math.round(item.defaultStandingOrder * 1.5) : item.defaultStandingOrder;
  const overSpoil = applySpoilage(over);
  check("🔴 易腐品多備 50%:每天真的丟掉東西", overSpoil.totalSpoiled > 0, JSON.stringify(overSpoil.lines));
  check("🔴 而且丟掉的金額大到吃得掉開張期的日淨利(> $100)",
    overSpoil.totalWastedValue > 100, `$${overSpoil.totalWastedValue}`);
  check("乾貨一單位都不會壞(囤咖啡豆沒有代價,只有佔用現金)",
    overSpoil.lines.every((line) => CAFE_INGREDIENTS.find((i) => i.id === line.id)?.perishable === true));

  // 收斂:囤到天上去也只會掉回上界,永遠不歸零
  let converge: Record<string, number> = { milk: 900, butter: 900, pet_fresh: 900 };
  for (let i = 0; i < 300; i++) converge = applySpoilage(converge).stock;
  const CEIL = SPOILAGE_FREE_UNITS + Math.ceil(1 / SPOILAGE_RATE) - 1;
  check(`🔴 囤到 900 也只會收斂到 ${CEIL} 並停住,永遠不會被損耗清空`,
    Object.values(converge).every((n) => n === CEIL) && applySpoilage(converge).totalSpoiled === 0,
    JSON.stringify(converge));

  // 端到端:同一份客流,精準備貨賺錢、備貨過量虧錢
  // 112 天 = 16 個遊戲週:天氣(晴40/陰25/雨25/悶熱10)與星期都跑得夠平,
  // 與 `scripts/cafe-opening-sim.ts` 用同一個窗口,兩邊的數字可以直接對照。
  const measure = (orders: Record<string, number>, days = 112) => {
    state.money = 5_000_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: orders, stock: { ...orders }, popularity: 100 });
    let net = 0;
    for (let day = 0; day < days; day++) {
      state.cafe.popularity = 100; // 固定人氣,讓兩個情境的客流可比
      const before = state.money;
      runBusinessDay(day);
      net += state.money - before;
    }
    return net / days;
  };
  const preciseNet = measure(suggestedStandingOrders());
  const overNet = measure(over);
  console.log(`   · 開張期日淨利:補貨精準 $${preciseNet.toFixed(0)} / 備貨過量 $${overNet.toFixed(0)}`);
  check("🔴 端到端:補貨精準是賺錢的(開店不是陷阱)", preciseNet > 0, `$${preciseNet.toFixed(0)}`);
  check("🔴 端到端:易腐品多備 50% 變成明確的負值(P1 時是 +$59)",
    overNet < 0, `$${overNet.toFixed(0)}`);
  check("備貨過量與精準備貨的差距 > $100/日(不是誤差等級的差別)",
    preciseNet - overNet > 100, `$${(preciseNet - overNet).toFixed(0)}`);

  // =========================================================================
  // 五、建議常備量(拍板 Q3 的懶人路線)
  // =========================================================================
  const baseMenu = menuItems([]);
  const emptyResult = suggestStandingOrdersFromSales([], baseMenu);
  check("🔴 沒有任何銷售紀錄 → fallback 到內建建議值(不會算出全 0)",
    emptyResult.fallback === true
    && JSON.stringify(emptyResult.orders) === JSON.stringify(suggestedStandingOrders()));
  check("fallback 的每一項都是有限的正整數(不產生 NaN)",
    Object.values(emptyResult.orders).every((n) => Number.isFinite(n) && n > 0 && Number.isInteger(n)));

  const emptyDays: CafeSalesDay[] = [0, 1, 2].map((day) => ({
    day, sold: {}, missed: {}, revenue: 0, ingredientCost: 0, served: 0, refused: 0,
    settled: true, restocked: true, restockCost: 0,
  }));
  const quietResult = suggestStandingOrdersFromSales(emptyDays, baseMenu);
  check("🔴 有紀錄但一份都沒賣掉(離線太久/剛開張)也走 fallback,不會建議全 0",
    quietResult.fallback === true && Object.values(quietResult.orders).every((n) => n > 0));
  check("壞資料(undefined / 非陣列 / 空菜單)不會爆也不會產生 NaN", (() => {
    const bad = suggestStandingOrdersFromSales(undefined as any, undefined as any);
    return bad.fallback === true && Object.values(bad.orders).every((n) => Number.isFinite(n));
  })());

  // 有歷史:建議量 = ceil(7 日單日尖峰 × 1.15),被拒的那幾份也算進需求
  const day = (d: number, sold: Record<string, number>, missed: Record<string, number> = {}): CafeSalesDay => ({
    day: d, sold, missed, revenue: 0, ingredientCost: 0, served: 0, refused: 0,
    settled: true, restocked: true, restockCost: 0,
  });
  const coffee = baseMenu[0]; // 招牌美式咖啡:咖啡豆 ×4
  const bake = baseMenu[1];   // 每日烘焙小點:麵粉 ×2 + 奶油 ×1
  const history: CafeSalesDay[] = [
    day(1, { [coffee.id]: 5, [bake.id]: 2 }),
    day(2, { [coffee.id]: 10, [bake.id]: 3 }, { [coffee.id]: 2 }), // 尖峰日:12 份咖啡的需求
    day(3, { [coffee.id]: 4, [bake.id]: 1 }),
  ];
  const peak = cafeIngredientPeakDemand(history, baseMenu);
  check("尖峰需求含「想買卻做不出來」的那幾份(否則缺貨會自我實現)",
    peak.coffee_bean === (10 + 2) * 4, `咖啡豆尖峰=${peak.coffee_bean}`);
  check("尖峰是單日最大值,不是總和也不是平均", peak.flour === 3 * 2, `麵粉尖峰=${peak.flour}`);
  const suggested = suggestStandingOrdersFromSales(history, baseMenu);
  check("有歷史時不走 fallback", suggested.fallback === false && suggested.days === 3);
  check(`建議量 = ceil(尖峰 × ${CAFE_SUGGEST_BUFFER})`,
    suggested.orders.coffee_bean === Math.ceil(48 * CAFE_SUGGEST_BUFFER), `咖啡豆=${suggested.orders.coffee_bean}`);
  check("🔴 菜單上用不到的原料建議 0(別買你用不到的東西)",
    suggested.orders.milk === 0 && suggested.orders.pet_fresh === 0,
    `牛奶=${suggested.orders.milk} 寵物鮮食=${suggested.orders.pet_fresh}`);
  check("🔴 菜單上有、但這 7 日沒賣掉的新品有「至少兩份」的底線(剛研發完不會被建議成 0)", (() => {
    const withLatte = menuItems([CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.latteArt]);
    const out = suggestStandingOrdersFromSales(history, withLatte);
    // 經典拉花拿鐵配方含牛奶 ×1 ⇒ 底線 = 1 × CAFE_SUGGEST_MIN_SERVINGS
    return out.orders.milk === CAFE_SUGGEST_MIN_SERVINGS;
  })(), `min=${CAFE_SUGGEST_MIN_SERVINGS}`);
  check("建議量一律非負整數", Object.values(suggested.orders).every((n) => Number.isInteger(n) && n >= 0));
  check("建議量的鍵涵蓋全部六種原料(面板逐格填得滿)",
    CAFE_INGREDIENTS.every((item) => typeof suggested.orders[item.id] === "number"));
  check("只看最近 7 個遊戲日(更早的尖峰不算數)", (() => {
    const long: CafeSalesDay[] = [day(0, { [coffee.id]: 999 })];
    for (let d = 1; d <= CAFE_SALES_WINDOW_DAYS; d++) long.push(day(d, { [coffee.id]: 3 }));
    return suggestStandingOrdersFromSales(long, baseMenu).orders.coffee_bean
      === Math.ceil(3 * 4 * CAFE_SUGGEST_BUFFER);
  })());

  // 🔴 按了建議按鈕之後,懶人路線仍然不會天天損耗
  check("🔴 依建議量進貨後放一整夜也零損耗(建議按鈕不會自己害玩家爛貨)",
    applySpoilage(suggested.orders).totalSpoiled === 0, JSON.stringify(applySpoilage(suggested.orders).lines));

  // =========================================================================
  // 六、銷售排行(需求 1:玩家視熱門度補貨的唯一資訊來源)
  // =========================================================================
  const ranking = cafeSalesRanking(history, baseMenu);
  check("排行涵蓋目前菜單的每一項(賣不動的也要看得到)", ranking.length === baseMenu.length);
  check("🔴 依賣出杯數由高到低",
    ranking[0].id === coffee.id && ranking[0].sold === 19 && ranking[1].id === bake.id && ranking[1].sold === 6,
    JSON.stringify(ranking));
  check("🔴 缺貨次數逐項正確(那是玩家在虧錢的訊號)",
    ranking[0].missed === 2 && ranking[1].missed === 0, JSON.stringify(ranking));
  check("零銷量的品項排在最後、且不產生 NaN",
    ranking[ranking.length - 1].sold === 0 && ranking.every((row) => Number.isFinite(row.sold) && Number.isFinite(row.missed)));
  check("同為 0 杯時改比缺貨次數(想買卻買不到的要浮上來)", (() => {
    const rows = cafeSalesRanking([day(1, {}, { [baseMenu[2].id]: 4 })], baseMenu);
    return rows[0].id === baseMenu[2].id && rows[0].missed === 4;
  })());
  check("只統計最近 7 個遊戲日", (() => {
    const long: CafeSalesDay[] = [day(0, { [coffee.id]: 500 })];
    for (let d = 1; d <= CAFE_SALES_WINDOW_DAYS; d++) long.push(day(d, { [coffee.id]: 1 }));
    return cafeSalesRanking(long, baseMenu)[0].sold === CAFE_SALES_WINDOW_DAYS;
  })());
  check("已下架/未知品項 id 的舊紀錄不會混進排行",
    cafeSalesRanking([day(1, { cafe_menu_removed_item: 99 })], baseMenu).every((row) => row.sold === 0));
  check("空輸入不會爆", cafeSalesRanking().length === 0 && cafeSalesRanking(undefined as any, baseMenu).length === baseMenu.length);

  // 端到端:真的跑一天之後,排行讀得到「畫面上真的賣出去的東西」
  state.money = 400_000;
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(), popularity: 80 });
  runBusinessDay(30);
  const liveRanking = cafeSalesRanking(state.cafe.sales, menuItems(state.cafe.completed));
  const liveRecord = state.cafe.sales[state.cafe.sales.length - 1];
  check("🔴 端到端:排行的賣出杯數合計 = 當日成功結帳人次",
    liveRanking.reduce((sum, row) => sum + row.sold, 0) === liveRecord.served,
    `${liveRanking.reduce((sum, row) => sum + row.sold, 0)} vs ${liveRecord.served}`);

  // =========================================================================
  // 七、零 RNG
  // =========================================================================
  const cafeRandom = cafeRandomBeforeOffline + (randomCalls - rngMark2);
  check("🔴 咖啡廳自己的路徑零 Math.random(進貨/損耗/建議/排行都是決定性算術)",
    cafeRandom === 0, `calls=${cafeRandom}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
