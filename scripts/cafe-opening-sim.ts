/**
 * 咖啡廳重設計 P1 建立、P3 更新:開張期試算的**實測**腳本(設計文件 §4.7)。
 *
 * 設計文件的三個情境是拍腦袋前先算出來的目標值:
 *   補貨精準 +$98 / 缺貨 20% −$89 / 備貨過量 −$114
 * 本腳本用**真的模擬迴圈**(開店前 `cafeRestockPass` + 逐小時 `cafeHourlyPass`
 * + 換日 `cafeDailyPass`)量一次,
 * 把實測值印出來。**實測與設計值有出入是正常的**——這支腳本的用途是讓中控/使用者
 * 看到真實手感,不是拿來反過來硬調參數。
 *
 * 只印數字、不斷言;因此**刻意不列入 `scripts/run-all.ts` 的回歸集**。
 *   npx tsx scripts/cafe-opening-sim.ts
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START } = await import("../src/sim/gameState");
const { cafeDailyPass, cafeHourlyPass, cafeRestockPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const { suggestedStandingOrders, CAFE_FIXED_COST, CAFE_POPULARITY_MAX } = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DAYS = 112; // 16 個遊戲週:天氣與星期的分佈都跑得夠平

const stockValue = (stock: Record<string, number>) =>
  CAFE_INGREDIENTS.reduce((sum, item) => sum + (stock[item.id] ?? 0) * item.unitPrice, 0);

interface Scenario {
  label: string;
  orders: Record<string, number>;
  /** 期初庫存;省略 = 照常備量開場。 */
  stock?: Record<string, number>;
}

/**
 * 「靜態」模式每天開始前把人氣按回同一個值,讓各情境的**客流一致**——
 * 設計文件 §4.7 的試算表本來就是「同樣 26 位客人,只有備貨策略不同」的靜態比較。
 * 「自然」模式不按,人氣照 §4.8 逐位累積/扣分,缺貨的複利就會現形。
 */
const PINNED_POPULARITY = CAFE_POPULARITY_MAX;

function run(scenario: Scenario, pinned: boolean) {
  state.money = 5_000_000;
  state.ledger.splice(0, state.ledger.length);
  Object.assign(state.cafe, defaultCafe(), {
    open: true,
    standingOrders: scenario.orders,
    stock: { ...(scenario.stock ?? scenario.orders) },
    popularity: PINNED_POPULARITY,
  });

  let revenue = 0;
  let guests = 0;
  let refused = 0;
  let restockCost = 0;
  let ingredientCost = 0;
  let spoiledValue = 0;
  let net = 0;

  for (let day = 0; day < DAYS; day++) {
    if (pinned) state.cafe.popularity = PINNED_POPULARITY;
    const before = state.money;
    const stockBefore = stockValue(state.cafe.stock);
    // 🔴 P3:進貨在開店前一刻(09:00),不再是日結。先付錢、後賺錢。
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
    revenue += record.revenue;
    guests += record.guests;
    refused += sale?.refused ?? 0;
    const used = sale?.ingredientCost ?? 0;
    ingredientCost += used;
    // 🔴 P3:進貨支出改由當日銷售紀錄帶著走(開店前扣的),日結只剩固定開銷。
    // 舊算式(record.cost − 固定開銷)仍然等價,留作對帳:兩者不一致代表帳串掉了。
    const bought = sale?.restockCost ?? Math.max(0, record.cost - CAFE_FIXED_COST);
    restockCost += bought;
    // 庫存守恆:期末 = 期初 − 賣掉 + 進貨 − 損耗 ⇒ 損耗 = 期初 − 期末 − 賣掉 + 進貨
    spoiledValue += stockBefore - stockValue(state.cafe.stock) - used + bought;
    net += state.money - before;
  }

  const per = (n: number) => n / DAYS;
  const spoiled = spoiledValue;
  return {
    label: scenario.label,
    guests: per(guests),
    refused: per(refused),
    revenue: per(revenue),
    restock: per(restockCost),
    spoiled: per(spoiled),
    net: per(net),
    popularity: state.cafe.popularity,
    refuseRate: guests + refused > 0 ? refused / (guests + refused) : 0,
  };
}

const base = suggestedStandingOrders();
const scaled = (factor: number, only?: (id: string) => boolean) => {
  const out: Record<string, number> = {};
  for (const item of CAFE_INGREDIENTS) {
    out[item.id] = !only || only(item.id) ? Math.max(0, Math.round(base[item.id] * factor)) : base[item.id];
  }
  return out;
};
const perishable = (id: string) => CAFE_INGREDIENTS.find((item) => item.id === id)!.perishable;

const SCENARIOS: Scenario[] = [
  { label: "① 補貨精準、零缺貨", orders: base },
  // 咖啡是最大宗,砍咖啡豆最能製造「想點卻做不出來」——這就是設計文件說的「備錯料」。
  { label: "② 缺貨(咖啡豆只備 30%)", orders: { ...base, coffee_bean: 30 } },
  { label: "③ 備貨過量(易腐多備 50%)", orders: scaled(1.5, perishable) },
  { label: "④ 完全放著不管(常備量歸零)", orders: {}, stock: base },
  // ⑤ 才是設計文件 §4.7 那一列「缺貨 20%」真正想描述的形狀:
  //   **照樣付了一大筆進貨錢,卻還是做不出客人要的東西。**
  //   ② 只砍咖啡豆時進貨費用會跟著自己縮水(常備訂單是「補到水位」,不是「每天固定買一批」),
  //   所以那條線天生接近損益兩平;把其餘原料一起囤起來才會同時吃到兩頭。
  {
    label: "⑤ 備錯料(咖啡豆 30% + 其餘多備 50%)",
    orders: { ...scaled(1.5, (id) => id !== "coffee_bean"), coffee_bean: 30 },
  },
];

function table(pinned: boolean) {
  const results = SCENARIOS.map((scenario) => run(scenario, pinned));
  console.log(`\n=== 開張期實測:${pinned ? "靜態(人氣固定 " + PINNED_POPULARITY + ",客流可比)" : "自然(人氣照 §4.8 浮動,含缺貨複利)"} ===`);
  console.log("情境".padEnd(28) + "日客流  撲空  撲空率   營收     進貨    損耗    淨利   期末人氣");
  for (const r of results) {
    console.log(
      r.label.padEnd(24)
      + `${r.guests.toFixed(1).padStart(6)}`
      + `${r.refused.toFixed(1).padStart(6)}`
      + `${(`${(r.refuseRate * 100).toFixed(0)}%`).padStart(7)}`
      + `${("$" + r.revenue.toFixed(0)).padStart(9)}`
      + `${("−$" + r.restock.toFixed(0)).padStart(9)}`
      + `${("−$" + r.spoiled.toFixed(0)).padStart(8)}`
      + `${((r.net >= 0 ? "+$" : "−$") + Math.abs(r.net).toFixed(0)).padStart(9)}`
      + `${r.popularity.toFixed(0).padStart(9)}`,
    );
  }
}

console.log(`\n招牌 Lv1、零投資、${DAYS} 個遊戲日平均;固定開銷每日 −$${CAFE_FIXED_COST}`);
table(true);
table(false);
console.log("\n設計文件 §4.7 的目標值:①+$98 ②−$89 ③−$114 ④−$270(⑤ 是 P3 補的對照組,設計表沒有)");
