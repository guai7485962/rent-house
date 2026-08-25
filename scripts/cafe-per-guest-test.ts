/**
 * 咖啡廳重設計 P1:菜單配方 + 顧客選品 + **逐位結帳**。
 *
 * 這支測試釘的是整個重設計的唯一主張:
 *
 *   > 畫面上發生的事,就是帳本上發生的事。
 *   > 當日營收 = Σ 每位顧客實際點到的商品售價(不再是 `客流 × 平均客單價`)
 *
 * 六組硬把關:
 * 1. **逐位結帳** — 營收逐筆對得上每個品項的售價 × 賣出份數
 * 2. **缺貨** — $0 收入、聲譽 −2.0/人、當下就推日誌
 * 3. **零 RNG 與決定性** — 同輸入同輸出,全程零 `Math.random()`
 * 4. 🔴 **離線一致性** — 線上逐時跑 11 小時 vs 離線 `syncToNow()` 一次補 11 小時,
 *    `money` / `stock` / `popularity` / 銷售紀錄逐欄位相同
 * 5. **未開張時整條路徑完全不動**(balance 快照零漂移的直接釘子)
 * 6. **各品項毛利落在 45～60%**(含 10 個研發解鎖品)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START, CAFE_SALES_CAP } = await import("../src/sim/gameState");
const {
  cafeDailyPass, cafeHourlyPass, hourlyTick, syncToNow, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR,
} = await import("../src/sim/tick");
const {
  cafeHourlyGuestCount, cafeItemCost, cafeItemMargin, cafeOrderLine, cafeServicePopularity,
  checkoutCafeOrder, chooseCafeMenuItem, clampCafePopularity, menuItems, suggestedStandingOrders,
  CAFE_BASE_MENU_ITEMS, CAFE_BUSINESS_HOURS, CAFE_POPULARITY_MAX, CAFE_POPULARITY_REFUSE_LOSS,
  CAFE_POPULARITY_SERVE_GAIN, CAFE_RESEARCH_IDS, CAFE_RESEARCH_RECIPES, CAFE_UPGRADE_IDS,
} = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");
const { SAVE_VERSION, migrateSave } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const ALL_RESEARCH = Object.values(CAFE_RESEARCH_IDS) as string[];
const hosts = () => Object.values(state.runtimes).sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
const clearHostLogs = () => { for (const rt of hosts()) rt.log.splice(0, rt.log.length); };
const setCafe = (patch: Partial<typeof state.cafe>) => Object.assign(state.cafe, defaultCafe(), patch);

/** 跑完整的一個營業日:11 個營業小時逐位結帳 + 換日日結。 */
function runBusinessDay(day: number, withDaily = true) {
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
    cafeHourlyPass(hour);
  }
  if (withDaily) {
    state.gameMs = GAME_START.getTime() + day * DAY_MS;
    cafeDailyPass();
  }
}

const originalRandom = Math.random;
try {
  // =========================================================================
  // 一、菜單配方與毛利帶(設計文件 §4.1)
  // =========================================================================
  const fullMenu = menuItems(ALL_RESEARCH);
  check("完整菜單 = 3 個基礎品項 + 13 個研發品項(2026-08-25 第三層上線後)", fullMenu.length === 16);
  check("每個品項都有非空配方(空配方 = 無本生意)",
    fullMenu.every((item) => Object.keys(item.recipe).length > 0),
    fullMenu.filter((i) => Object.keys(i.recipe).length === 0).map((i) => i.id).join(","));
  check("每個品項都有正的基礎熱門度(0 = 永遠不會被點到)",
    fullMenu.every((item) => item.baseWeight > 0),
    fullMenu.filter((i) => !(i.baseWeight > 0)).map((i) => i.id).join(","));
  check("配方只用得到現有七種原料(不會憑空引用不存在的料)",
    fullMenu.every((item) => Object.keys(item.recipe).every((id) => CAFE_INGREDIENTS.some((ing) => ing.id === id))));
  check("配方用量都是正整數", fullMenu.every((item) =>
    Object.values(item.recipe).every((units) => Number.isInteger(units) && (units as number) > 0)));
  check("每一份研發解鎖品都在 CAFE_RESEARCH_RECIPES 登記過(新增研發不能忘了配方)",
    ALL_RESEARCH.every((id) => CAFE_RESEARCH_RECIPES[id] !== undefined));

  console.log("\n   品項毛利表(P1 重訂單價後):");
  let marginsOk = true;
  for (const item of fullMenu) {
    const cost = cafeItemCost(item);
    const margin = cafeItemMargin(item);
    if (margin < 0.45 || margin > 0.60) marginsOk = false;
    const formula = Object.entries(item.recipe)
      .map(([id, units]) => `${CAFE_INGREDIENTS.find((ing) => ing.id === id)!.name}×${units}`).join(" + ");
    console.log(`     · ${item.name.padEnd(8)} $${String(item.price).padStart(2)}  ${formula.padEnd(28)} 成本 $${String(cost).padStart(2)}  毛利 ${(margin * 100).toFixed(1)}%`);
  }
  check("🔴 16 個品項的毛利全部落在 45～60%", marginsOk);
  check("三個基礎品項的配方與售價對得上毛利帶",
    CAFE_BASE_MENU_ITEMS.every((item) => cafeItemMargin(item) >= 0.45 && cafeItemMargin(item) <= 0.6));

  // =========================================================================
  // 🔴 「精確 0」的回歸釘子(2026-08-25)
  // =========================================================================
  // 病史:冷萃($39)、磅蛋糕($38)、司康($38)三項的**毛利額**恰好都是 $19,
  // 而基礎菜單依 baseWeight 50/30/20 加權出來的毛利**也恰好是 $19.00**。
  // 加權平均的性質:加進一個等於現行平均的樣本,平均一格不動
  // ⇒ 玩家花 $12,500 研發完這三項,曲線在數學上**精確**沒有變化,而且不報錯。
  // 這條釘子直接擋住未來再犯:任何品項的毛利額都不准落在基礎加權毛利上。
  const baseWeighted = CAFE_BASE_MENU_ITEMS.reduce((sum, item) =>
    sum + item.baseWeight * (item.price - cafeItemCost(item)), 0)
    / CAFE_BASE_MENU_ITEMS.reduce((sum, item) => sum + item.baseWeight, 0);
  const deadItems = fullMenu.filter((item) => Math.abs((item.price - cafeItemCost(item)) - baseWeighted) < 0.5);
  console.log(`   基礎菜單的加權毛利 = $${baseWeighted.toFixed(2)}/客`);
  check("🔴 沒有任何品項的毛利恰好等於基礎菜單的加權毛利(等於 = 研發它對曲線的貢獻精確為 0)",
    deadItems.length === 0,
    deadItems.map((i) => `${i.name} 毛利 $${i.price - cafeItemCost(i)}`).join(","));
  check("cafeItemCost 對未知原料回 0、不產生 NaN",
    cafeItemCost({ recipe: { not_a_thing: 5 } as any }) === 0 && cafeItemMargin({ recipe: {}, price: 0 }) === 0);

  // =========================================================================
  // 二、客流攤分:Σ 每小時 = 當日客流(不能多發客人)
  // =========================================================================
  let splitOk = true;
  for (let total = 0; total <= 120; total++) {
    let sum = 0;
    for (let i = 0; i < CAFE_BUSINESS_HOURS; i++) sum += cafeHourlyGuestCount(total, i);
    if (sum !== total) { splitOk = false; break; }
  }
  check("🔴 11 個營業小時的客人數加總 = 當日客流(0~120 全掃)", splitOk);
  check("營業時段以外一位客人都不發",
    cafeHourlyGuestCount(26, -1) === 0 && cafeHourlyGuestCount(26, CAFE_BUSINESS_HOURS) === 0);
  check("壞資料不產生負數或 NaN 客人",
    cafeHourlyGuestCount(Number.NaN, 3) === 0 && cafeHourlyGuestCount(-9, 3) === 0);
  check("每個小時的客人數只依賴(當日客流, 小時序)——與跑過幾個小時無關",
    cafeHourlyGuestCount(26, 5) === cafeHourlyGuestCount(26, 5));

  // =========================================================================
  // 三、🔴 逐位結帳:營收 = Σ 實際賣出品項售價
  // =========================================================================
  state.money = 200_000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({
    open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
    popularity: 60, completed: ALL_RESEARCH,
  });
  const moneyBeforeTrading = state.money;
  runBusinessDay(30, false); // 只跑營業時段,不做日結(日結會扣進貨/固定開銷)
  const sale = state.cafe.sales[state.cafe.sales.length - 1];
  const priceOf = new Map(menuItems(state.cafe.completed).map((item) => [item.id, item.price]));
  const expected = Object.entries(sale.sold).reduce((sum, [id, units]) => sum + (priceOf.get(id) ?? 0) * units, 0);
  check("🔴 當日營收 = Σ(各品項售價 × 賣出份數)", sale.revenue === expected, `${sale.revenue} vs ${expected}`);
  check("🔴 money 的增加額 = 當日營收(逐位結帳當場進帳)",
    state.money - moneyBeforeTrading === sale.revenue, `${state.money - moneyBeforeTrading} vs ${sale.revenue}`);
  check("成功結帳人次 = Σ 賣出份數",
    sale.served === Object.values(sale.sold).reduce((sum, n) => sum + n, 0), `${sale.served}`);
  check("賣出的品項不只一種(選品真的有在分岔)", Object.keys(sale.sold).length >= 3, Object.keys(sale.sold).join(","));
  check("賣出的品項售價不只一種 ⇒ 營收不可能是「人數 × 單一客單價」",
    new Set(Object.keys(sale.sold).map((id) => priceOf.get(id))).size >= 2);
  check("庫存確實照配方被扣掉(不是憑空生出商品)",
    CAFE_INGREDIENTS.some((ing) => (state.cafe.stock[ing.id] ?? 0) < suggestedStandingOrders()[ing.id]));
  check("原料成本 = Σ 賣出品項的配方成本",
    sale.ingredientCost === Object.entries(sale.sold).reduce((sum, [id, units]) => {
      const item = menuItems(state.cafe.completed).find((entry) => entry.id === id)!;
      return sum + cafeItemCost(item) * units;
    }, 0), `${sale.ingredientCost}`);
  check("順利服務時聲譽逐位累積 +0.15",
    Math.abs(state.cafe.popularity - clampCafePopularity(60 + sale.served * CAFE_POPULARITY_SERVE_GAIN)) < 1e-9,
    `${state.cafe.popularity}`);
  // 帳本合併:錢每小時真的入帳,但同一個遊戲日只留一筆營收紀錄
  const revenueRows = state.ledger.filter((txn) => txn.label === "咖啡廳營收");
  check("同一個遊戲日的營收在帳本上合併成一筆(LEDGER_CAP 只有 60)", revenueRows.length === 1, `${revenueRows.length} 筆`);
  check("合併後的金額仍與 money 變動完全一致",
    state.ledger.reduce((sum, txn) => sum + txn.amount, 0) === state.money - moneyBeforeTrading);

  // 日結接手:營收不再由它算,但 history 要對得起來
  const moneyBeforeDaily = state.money;
  state.gameMs = GAME_START.getTime() + 30 * DAY_MS;
  cafeDailyPass();
  const record = state.cafe.history[state.cafe.history.length - 1];
  check("日結把當日成績寫進 history(guests / revenue 來自逐位結帳)",
    record.guests === sale.served && record.revenue === sale.revenue, JSON.stringify(record));
  check("history 的 cost 就是日結實際扣掉的錢", record.cost === moneyBeforeDaily - state.money);
  check("history 的 net 自洽", record.net === record.revenue - record.cost);
  check("同一天的成績只會被日結收走一次(不會重複計入 history)", (() => {
    const before = state.cafe.history.length;
    cafeDailyPass();
    const second = state.cafe.history[state.cafe.history.length - 1];
    return state.cafe.history.length === before + 1 && second.revenue === 0 && second.guests === 0;
  })());

  // =========================================================================
  // 四、🔴 缺貨:$0 收入 + 聲譽 −2.0/人 + 當下就有日誌
  // =========================================================================
  state.money = 200_000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: {}, stock: {}, popularity: CAFE_POPULARITY_MAX });
  clearHostLogs();
  const moneyBeforeShortage = state.money;
  runBusinessDay(31, false);
  const dry = state.cafe.sales[state.cafe.sales.length - 1];
  const shortageLogs = hosts()[0].log.map((entry) => entry.text);
  check("🔴 完全沒料時每位顧客都撲空", dry.refused > 0 && dry.served === 0, JSON.stringify({ served: dry.served, refused: dry.refused }));
  check("🔴 缺貨的顧客貢獻 $0 收入", dry.revenue === 0 && state.money === moneyBeforeShortage);
  check("🔴 缺貨完全不記帳(帳本上不會出現 $0 的營收筆)", state.ledger.length === 0);
  check("🔴 每位撲空的顧客扣 2.0 聲譽",
    Math.abs(state.cafe.popularity - clampCafePopularity(CAFE_POPULARITY_MAX - dry.refused * CAFE_POPULARITY_REFUSE_LOSS)) < 1e-9,
    `${state.cafe.popularity} (refused=${dry.refused})`);
  check("🔴 缺貨當下就推一則「有人想點⋯沒了」的日誌",
    shortageLogs.some((line) => /想點|指著|做不出來|只能說抱歉/.test(line)), JSON.stringify(shortageLogs));
  check("缺貨日誌指名了缺的那項原料",
    shortageLogs.some((line) => CAFE_INGREDIENTS.some((ing) => line.includes(ing.name))), JSON.stringify(shortageLogs));
  check("缺貨紀錄逐品項記在 missed(P3 的銷售排行要用)",
    Object.keys(dry.missed).length > 0
      && Object.values(dry.missed).reduce((sum, n) => sum + n, 0) === dry.refused,
    JSON.stringify(dry.missed));
  check("聲譽夾在 0(缺一整個月也不會變負)",
    cafeServicePopularity(1, 0, 99) === 0 && cafeServicePopularity(Number.NaN, 0, 0) === 0);

  // 單筆結帳的純函式行為
  const latte = menuItems(ALL_RESEARCH).find((item) => item.researchId === CAFE_RESEARCH_IDS.latteArt)!;
  const noMilk = checkoutCafeOrder({ coffee_bean: 99, milk: 0 }, latte);
  check("缺一種料就整份做不出來(全有全無,不會被刮走半份料)",
    noMilk.ok === false && noMilk.revenue === 0 && noMilk.cost === 0
      && noMilk.missing.join() === "milk" && noMilk.stock.coffee_bean === 99, JSON.stringify(noMilk));
  const served = checkoutCafeOrder({ coffee_bean: 99, milk: 5 }, latte);
  check("料齊時照配方扣、收足額",
    served.ok && served.revenue === latte.price && served.cost === cafeItemCost(latte)
      && served.stock.coffee_bean === 95 && served.stock.milk === 4, JSON.stringify(served));
  check("結帳不修改輸入庫存", (() => {
    const src = { coffee_bean: 10 };
    checkoutCafeOrder(src, CAFE_BASE_MENU_ITEMS[0]);
    return src.coffee_bean === 10;
  })());

  // =========================================================================
  // 五、🔴 零 RNG 與決定性
  // =========================================================================
  let randomCalls = 0;
  Math.random = () => { randomCalls++; return 0.5; };
  const runOnce = () => {
    state.money = 300_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
      popularity: 55, completed: [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.scone],
    });
    clearHostLogs();
    runBusinessDay(33);
    return JSON.stringify({
      money: state.money, stock: state.cafe.stock, popularity: state.cafe.popularity,
      sales: state.cafe.sales, history: state.cafe.history,
      logs: hosts()[0].log.map((entry) => entry.text),
    });
  };
  const before = randomCalls;
  const first = runOnce();
  check("🔴 逐位結帳全程零 Math.random", randomCalls === before, `calls=${randomCalls - before}`);
  check("🔴 同輸入連跑兩次結果逐欄完全相同", first === runOnce());
  check("不同天結果不同(否則上一條是假通過)", (() => {
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
      popularity: 55, completed: [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.scone],
    });
    state.money = 300_000;
    runBusinessDay(34, false);
    const other = JSON.stringify(state.cafe.sales[state.cafe.sales.length - 1].sold);
    return other !== JSON.stringify(JSON.parse(first).sales.at(-1).sold);
  })());
  const orderCtx = { menu: fullMenu, day: 12, hour: 14, index: 2, weather: "cloudy" as const };
  check("選品是決定性的:同 (day, hour, index) 永遠同一項",
    chooseCafeMenuItem(orderCtx)!.id === chooseCafeMenuItem(orderCtx)!.id);
  check("換一位顧客會換到別的品項(雜湊真的有在分岔)",
    new Set(Array.from({ length: 40 }, (_, i) => chooseCafeMenuItem({ ...orderCtx, index: i })!.id)).size >= 4);
  check("天氣會改變選品分佈(悶熱天的冷萃比例上升)", (() => {
    const share = (weather: "sweltering" | "rainy") => Array.from({ length: 300 }, (_, i) =>
      chooseCafeMenuItem({ menu: fullMenu, day: 5, hour: 14, index: i, weather })!.researchId)
      .filter((id) => id === CAFE_RESEARCH_IDS.coldBrew).length;
    return share("sweltering") > share("rainy");
  })());
  check("時段會改變選品分佈(早上咖啡比例高於下午)", (() => {
    const share = (hour: number) => Array.from({ length: 300 }, (_, i) =>
      chooseCafeMenuItem({ menu: fullMenu, day: 5, hour, index: i, weather: "cloudy" })!.track)
      .filter((track) => track === "coffee").length;
    return share(10) > share(15);
  })());
  check("空菜單回 null(不當機、也不算缺貨)",
    chooseCafeMenuItem({ ...orderCtx, menu: [] }) === null);
  check("敘事句是決定性的且帶咖啡廳前綴", (() => {
    const line = cafeOrderLine({ kind: "sale", day: 3, hour: 11, itemName: "招牌美式咖啡", price: 34 });
    return line === cafeOrderLine({ kind: "sale", day: 3, hour: 11, itemName: "招牌美式咖啡", price: 34 })
      && line.startsWith("🥐") && line.includes("$34");
  })());
  Math.random = originalRandom;

  // =========================================================================
  // 六、🔴 離線一致性:線上逐時 11 小時 vs 離線一次補 11 小時
  //
  // `syncToNow()` 是逐小時呼叫 `hourlyTick()` 的(tick.ts),所以兩條路徑
  // 走的必須是同一段程式碼、得到同一個結果。刻意選 09:00 起跑的 11 小時
  // (剛好蓋滿 10:00~20:00 的營業時段且不跨午夜),讓比較聚焦在咖啡廳。
  //
  // Math.random 在此段被釘成常數:模擬的其他部分(租客事件擲骰)本來就有隨機,
  // 不釘住的話兩次執行會因為**與咖啡廳無關**的原因分岔。
  // =========================================================================
  Math.random = () => 0.5;
  const NINE_AM = new Date(2026, 6, 20, 9, 0, 0).getTime();
  const cafeSnapshot = () => JSON.stringify({
    money: state.money,
    stock: state.cafe.stock,
    popularity: state.cafe.popularity,
    sales: state.cafe.sales,
    history: state.cafe.history,
    ledger: state.ledger.filter((txn) => txn.category === "cafe").map((txn) => ({ label: txn.label, amount: txn.amount })),
  });
  const setupOfflineCase = () => {
    state.money = 400_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
      popularity: 45, completed: [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.latteArt],
      upgrades: [CAFE_UPGRADE_IDS.signboard],
    });
    state.gameMs = NINE_AM;
  };

  setupOfflineCase();
  for (let i = 0; i < 11; i++) hourlyTick(false); // 線上:每小時跑一次
  const onlineSnapshot = cafeSnapshot();
  const onlineGameMs = state.gameMs;

  setupOfflineCase();
  state.gameAnchorMs = state.gameMs;
  // 現實 1 秒 = 遊戲 7 秒;倒推 11.5 遊戲小時的現實時間 ⇒ syncToNow 算出 need = 11
  state.realAnchorMs = Date.now() - Math.round((11.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  const offlineSnapshot = cafeSnapshot();

  check("離線補進度確實補了 11 個遊戲小時", caught === 11, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs, `${state.gameMs} vs ${onlineGameMs}`);
  check("🔴 離線一致性:money / stock / popularity / 銷售紀錄 / history / 帳本逐欄位相同",
    onlineSnapshot === offlineSnapshot,
    onlineSnapshot === offlineSnapshot ? "" : `\n     線上 ${onlineSnapshot}\n     離線 ${offlineSnapshot}`);
  check("這 11 小時真的有做生意(否則上一條是假通過)",
    JSON.parse(onlineSnapshot).sales.length === 1 && JSON.parse(onlineSnapshot).sales[0].served > 0,
    onlineSnapshot.slice(0, 160));
  Math.random = originalRandom;

  // =========================================================================
  // 七、🔴 未開張時整條路徑完全不動(balance 快照零漂移的直接釘子)
  // =========================================================================
  let closedRandom = 0;
  Math.random = () => { closedRandom++; return originalRandom(); };
  state.money = 52_000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({
    open: false,
    standingOrders: suggestedStandingOrders(),
    stock: suggestedStandingOrders(),
    popularity: 42,
    history: [{ day: -1, guests: 9, revenue: 1, cost: 2, net: -1 }],
    sales: [{ day: -1, sold: { x: 1 }, missed: {}, revenue: 5, ingredientCost: 2, served: 1, refused: 0, settled: true }],
  });
  clearHostLogs();
  const closedBefore = JSON.stringify({ money: state.money, ledger: state.ledger, cafe: state.cafe, logs: hosts().map((rt) => rt.log.length) });
  for (let day = 0; day < 30; day++) {
    for (let hour = 0; hour < 24; hour++) {
      state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
      cafeHourlyPass(hour);
    }
    cafeDailyPass();
  }
  check("🔴 未開張:720 個小時 + 30 次日結,money / ledger / state.cafe / 日誌逐欄不變",
    JSON.stringify({ money: state.money, ledger: state.ledger, cafe: state.cafe, logs: hosts().map((rt) => rt.log.length) }) === closedBefore);
  check("🔴 未開張:整條路徑零 Math.random", closedRandom === 0, `calls=${closedRandom}`);
  Math.random = originalRandom;

  // =========================================================================
  // 八、銷售紀錄的 cap 與存檔升級
  // =========================================================================
  state.money = 2_000_000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(), popularity: 40 });
  for (let day = 0; day < CAFE_SALES_CAP + 12; day++) runBusinessDay(day);
  check(`銷售紀錄 cap ${CAFE_SALES_CAP} 生效(不會無限成長)`,
    state.cafe.sales.length === CAFE_SALES_CAP, String(state.cafe.sales.length));
  check("銷售紀錄最新在後、被砍掉的是最舊的",
    state.cafe.sales[state.cafe.sales.length - 1].day === CAFE_SALES_CAP + 11
      && state.cafe.sales[0].day === 12, state.cafe.sales.map((row) => row.day).join(","));
  check("銷售紀錄撐得起「過去 7 日排行」(cap 至少 7 天,且每筆都有 sold / missed)",
    CAFE_SALES_CAP >= 7 && state.cafe.sales.every((row) =>
      row.sold !== null && typeof row.sold === "object" && row.missed !== null && typeof row.missed === "object"));
  check("日結收走的那幾天都被標成 settled(不會被重複計入 history)",
    state.cafe.sales.every((row) => row.settled === true));

  // 🔴 刻意不寫 `SAVE_VERSION === 9`:那種斷言只會在升版時被順手改掉,擋不到真正的錯誤。
  //    要釘就釘行為 —— 每個舊版本都升得到現行版,而且升完一定有 `cafe.sales`。
  const legacy = [2, 3, 4, 5, 6, 7, 8].filter((v) => v < SAVE_VERSION);
  check("每個舊版存檔都升得到現行 SAVE_VERSION", legacy.length > 0 && legacy.every((v) => {
    const migrated = migrateSave({ v, cafe: { open: false }, placements: [] });
    return migrated != null && migrated.v === SAVE_VERSION;
  }), `versions=${legacy.join(",")} → ${SAVE_VERSION}`);
  const upgradedV8 = migrateSave({
    v: 8,
    placements: [],
    cafe: {
      open: true,
      standingOrders: { coffee_bean: 20, milk: 15 },
      stock: { coffee_bean: 7, milk: 3 },
      popularity: 33,
      history: [{ day: 1, guests: 5, revenue: 180, cost: 90, net: 90 }],
    },
  });
  check("v8 舊檔升級後補上空的 sales 陣列", Array.isArray(upgradedV8?.cafe?.sales) && upgradedV8.cafe.sales.length === 0,
    JSON.stringify(upgradedV8?.cafe?.sales));
  check("v8 舊檔的 standingOrders / stock / popularity / history 原封保留(原料 id 沒變)",
    upgradedV8.cafe.standingOrders.coffee_bean === 20 && upgradedV8.cafe.stock.milk === 3
      && upgradedV8.cafe.popularity === 33 && upgradedV8.cafe.history.length === 1);
  check("已經有 sales 的存檔再升級不會被清空",
    (migrateSave({ v: 8, placements: [], cafe: { open: true, sales: [{ day: 1, sold: {}, missed: {}, revenue: 3, ingredientCost: 1, served: 1, refused: 0, settled: true }] } }) as any)
      ?.cafe?.sales?.length === 1);
  check("沒有 cafe 欄位的舊檔升級也不會炸", migrateSave({ v: 8, placements: [] }) != null);

  // =========================================================================
  // 九、cafe.ts 的純函式界線(P1 新增的算式沒有偷偷跨界)
  // =========================================================================
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const cafeSrc = readFileSync(join(here, "..", "src", "sim", "cafe.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("cafe.ts 程式碼本體仍然零 Math.random", !cafeSrc.includes("Math.random"));
  check("cafe.ts 仍然不呼叫 addMoney、不推日誌",
    !cafeSrc.includes("addMoney") && !cafeSrc.includes("pushSocialLog"));
  check("cafe.ts 仍然不 import state / tick / economy",
    !/from\s+"\.\/gameState"/.test(cafeSrc) && !/from\s+"\.\/tick"/.test(cafeSrc) && !/from\s+"\.\/economy"/.test(cafeSrc));
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
