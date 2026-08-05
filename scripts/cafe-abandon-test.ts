/**
 * 🔴 A 批(2026-08-05,使用者拍板):**排太久放棄離開**($0 + 聲譽 −1 + 一則日誌)。
 *
 * 設計文件 §4.9 的初稿寫過這條,P4b 因為「會改到金流」刻意留給使用者拍板。
 *
 * ## 這一批到底改了什麼(本測試的主張)
 *
 * `cafeCrowd()` 一直都在算兩個數:想上門的人 `base`,與被產能夾住後真的做得成生意的
 * `guests = min(base, capacity)`。**差額那批人以前是無聲蒸發的**;A 批讓他們真的走進
 * 店裡、站進 P4b 的人龍、然後放棄離開。所以:
 *
 * - **營收算式一行未改** —— 他們本來就不在 `guests` 裡,不需要退款
 * - **新增的是聲譽 −1/人**,而它自帶負回饋 ⇒ 系統收斂到「名氣長不過你的店」
 *
 * 六組硬把關:
 * 1. 純函式:放棄人數 = 差額(帶每小時上限、營業時段外為 0、壞資料不生 NaN)
 * 2. 觸發條件:產能吃得下 ⇒ 零放棄;名氣長過產能 ⇒ 真的有人放棄
 * 3. $0:不進營收、不扣原料、不佔席、不計入 served/refused、錢沒有任何倒扣
 * 4. 聲譽 −1/人:走 P1 建立的 `cafeServicePopularity()` 同一條路徑(第四參數)
 * 5. 走得出畫面:排進人龍 → 等滿門檻 → 走回店門才 departed;全程不會點餐
 * 6. 零 RNG / 離線一致 / `cafe.open` 閘門 / 存檔往返
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START, sanitizeCafeState } = await import("../src/sim/gameState");
const { cafeHourlyPass, hourlyTick, syncToNow, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const {
  cafeAbandonCount, cafeCapability, cafeCrowd, cafeOrderLine, cafeServicePopularity, cafeStaffCount,
  CAFE_ABANDON_CAP_PER_HOUR, CAFE_ABANDON_QUEUE_TOLERANCE, CAFE_BUSINESS_HOURS, CAFE_POPULARITY_ABANDON_LOSS,
  CAFE_POPULARITY_REFUSE_LOSS, CAFE_POPULARITY_SERVE_GAIN, CAFE_UPGRADE_IDS,
} = await import("../src/sim/cafe");
const { placeCafeStarterSet, cafeCounterSpots, cafeSeatSpots } = await import("../src/sim/placements");
const { generateCafeGuest } = await import("../src/sim/cafeGuests");
const {
  createGuestAgents, tickGuestAgents, queuedGuestCount, guestAbandons,
  GUEST_ABANDON_SECONDS, CAFE_GUEST_ENTRY_TILES,
} = await import("../src/floor/guestAgents");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const hosts = () => Object.values(state.runtimes).sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
const allLogs = () => hosts().flatMap((rt) => rt.log.map((entry) => entry.text));
const clearLogs = () => { for (const rt of hosts()) rt.log.splice(0, rt.log.length); };

/** 開一間「料絕對夠」的店;招牌等級與聲譽決定想上門的人,員工數決定產能。 */
function setUpCafe(extraStaff: number, opts: { popularity?: number; signLevel?: number } = {}) {
  const signs = [
    CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv2,
    CAFE_UPGRADE_IDS.signboardLv3, CAFE_UPGRADE_IDS.signboardLv4,
  ].slice(0, Math.max(0, (opts.signLevel ?? 2) - 1));
  Object.assign(state.cafe, defaultCafe(), {
    open: true,
    extraStaff,
    popularity: opts.popularity ?? 50,
    upgrades: signs,
    stock: Object.fromEntries(["coffee_bean", "milk", "flour", "cat_food", "sugar", "cup"].map((id) => [id, 9999])),
  });
  state.money = 100000;
}

/** 跑一整個營業日,回傳這一天的成績。 */
function runBusinessDay(day: number) {
  const before = { money: state.money, popularity: state.cafe.popularity };
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
    cafeHourlyPass(hour);
  }
  const record = state.cafe.sales[state.cafe.sales.length - 1];
  return { before, record };
}

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return originalRandom(); };

try {
  placeCafeStarterSet(); // 開張贈品:吧台 (3,38) + 三組桌椅
  const counters = cafeCounterSpots().length;
  const seats = cafeSeatSpots().length;
  check("開張贈品擺得起來(有吧台點餐位與席次)", counters >= 4 && seats >= 6, `counters=${counters} seats=${seats}`);

  // =========================================================================
  // 一、純函式:放棄人數 = 被產能夾掉的那些人
  // =========================================================================
  const dayTotal = (base: number, capacity: number) =>
    Array.from({ length: CAFE_BUSINESS_HOURS }, (_, i) => cafeAbandonCount(base, capacity, i))
      .reduce((sum, n) => sum + n, 0);
  check("產能吃得下所有人時,一位都不放棄", dayTotal(40, 40) === 0 && dayTotal(20, 40) === 0);
  check("🔴 隊伍站得下(每小時多出 ≤ 8 人)就沒有人走 —— 生意好不該被懲罰",
    dayTotal(40 + 8 * CAFE_BUSINESS_HOURS, 40) === 0,
    `base=${40 + 8 * CAFE_BUSINESS_HOURS} cap=40 ⇒ ${dayTotal(40 + 8 * CAFE_BUSINESS_HOURS, 40)}`);
  check("🔴 隊伍站不下(每小時多出 > 8 人)才開始有人排到放棄",
    dayTotal(40 + 10 * CAFE_BUSINESS_HOURS, 40) > 0);
  check("放棄人數 = 站不進人龍的那幾位(每小時多出的人 − 耐心線)",
    Array.from({ length: CAFE_BUSINESS_HOURS }, (_, i) => cafeAbandonCount(40 + 10 * CAFE_BUSINESS_HOURS, 40, i))
      .every((n) => n === 10 - CAFE_ABANDON_QUEUE_TOLERANCE));
  check("每小時有上限(畫面與存檔不會被塞爆)",
    Array.from({ length: CAFE_BUSINESS_HOURS }, (_, i) => cafeAbandonCount(4000, 40, i))
      .every((n) => n === CAFE_ABANDON_CAP_PER_HOUR));
  check("營業時段之外一律 0", cafeAbandonCount(80, 40, -1) === 0 && cafeAbandonCount(80, 40, 99) === 0);
  check("壞資料不會生出負數或 NaN",
    cafeAbandonCount(NaN, NaN, 0) === 0 && cafeAbandonCount(-5, 40, 0) === 0
    && Number.isInteger(cafeAbandonCount(80, 40, 0)));
  check("🔴 放棄的人本來就不在營收裡(cafeCrowd 的 guests 一律 = min(base, capacity))",
    (() => {
      const crowd = cafeCrowd({ weather: "sunny", weekday: 3, signLevel: 4, capacity: 30, popularity: 100 });
      return crowd.guests === Math.min(crowd.base, 30) && crowd.cappedByCapacity === (crowd.base > 30);
    })());

  // =========================================================================
  // 二、聲譽:沿用 P1 的 cafeServicePopularity(),放棄是第四參數
  // =========================================================================
  check("放棄一位 = 聲譽 −1", cafeServicePopularity(50, 0, 0, 1) === 50 - CAFE_POPULARITY_ABANDON_LOSS);
  check("放棄比缺貨輕(缺貨是你沒準備,排隊是你生意太好)",
    CAFE_POPULARITY_ABANDON_LOSS < CAFE_POPULARITY_REFUSE_LOSS && CAFE_POPULARITY_ABANDON_LOSS > 0);
  check("三種結果可交換、可拆次呼叫(離線一致的必要條件)",
    cafeServicePopularity(50, 10, 1, 3)
      === cafeServicePopularity(cafeServicePopularity(50, 10, 0, 0), 0, 1, 3));
  check("省略第四參數時與 P1 的行為完全相同(舊呼叫端一位元不變)",
    cafeServicePopularity(50, 10, 1) === 50 + 10 * CAFE_POPULARITY_SERVE_GAIN - CAFE_POPULARITY_REFUSE_LOSS);
  check("聲譽仍夾在 0~100", cafeServicePopularity(0.5, 0, 0, 99) === 0);

  // =========================================================================
  // 三、日誌句
  // =========================================================================
  const line = cafeOrderLine({ kind: "abandoned", day: 3, hour: 14, itemName: "", abandoned: 4 });
  check("放棄離開有專屬日誌句且帶人數", line.includes("4") && line.length > 10, line);
  check("日誌句是決定性的(同輸入同輸出)",
    line === cafeOrderLine({ kind: "abandoned", day: 3, hour: 14, itemName: "", abandoned: 4 }));
  check("不同小時會選到不同句(不是永遠同一句)",
    new Set([0, 1, 2, 3, 4, 5].map((h) =>
      cafeOrderLine({ kind: "abandoned", day: 1, hour: h, itemName: "", abandoned: 1 }))).size > 1);

  // =========================================================================
  // 四、🔴 cafe.open 閘門:未開張時整條路徑一個欄位都不碰
  // =========================================================================
  Object.assign(state.cafe, defaultCafe());
  const moneyClosed = state.money;
  state.gameMs = GAME_START.getTime() + 5 * DAY_MS + 13 * HOUR_MS;
  cafeHourlyPass(13);
  check("未開張時 cafeHourlyPass 不生顧客、不動錢、不寫銷售紀錄",
    state.money === moneyClosed && state.cafe.guests.length === 0 && state.cafe.sales.length === 0);

  // =========================================================================
  // 五、模擬層:產能吃得下 ⇒ 零放棄;名氣長過產能 ⇒ 真的有人排到放棄
  // =========================================================================
  setUpCafe(8, { popularity: 0, signLevel: 1 }); // 招牌 Lv1 + 零聲譽 + 九位店員 ⇒ 產能遠大於客流
  clearLogs();
  const enough = runBusinessDay(1);
  check("🔴 產能吃得下所有想上門的人 ⇒ 一位都不放棄",
    (enough.record.abandoned ?? 0) === 0, `abandoned=${enough.record.abandoned}`);
  check("產能夠的那天營收 > 0(店確實有在做生意)", enough.record.revenue > 0);
  check("產能夠時聲譽只往上走", state.cafe.popularity >= enough.before.popularity);
  check("產能夠時店裡沒有任何放棄離開的顧客",
    state.cafe.guests.every((guest) => guest.order?.abandoned !== true));

  // 名氣與招牌滿級,卻只有開張費附的那一位店員 ⇒ 客流遠遠長過產能。
  // 天氣/星期會讓每天的 base 不同,所以掃一週找出第一個真的排到放棄的日子。
  let overDay = -1;
  for (let day = 2; day < 16 && overDay < 0; day++) {
    setUpCafe(0, { popularity: 100, signLevel: 4 });
    if ((runBusinessDay(day).record.abandoned ?? 0) > 0) overDay = day;
  }
  check("兩週內至少有一天會排到放棄(名氣長過店面的日子)", overDay > 0, `overDay=${overDay}`);
  setUpCafe(0, { popularity: 100, signLevel: 4 });
  clearLogs();
  const moneyBefore = state.money;
  const stockBefore = JSON.stringify(state.cafe.stock);
  const popBefore = state.cafe.popularity;
  const over = runBusinessDay(overDay > 0 ? overDay : 2);
  const abandoned = over.record.abandoned ?? 0;
  check("🔴 名氣長過產能 ⇒ 真的有人排到放棄", abandoned > 0, `abandoned=${abandoned}`);
  check("聲譽扣分 = 放棄人數 × 1(疊在同一天的服務加減分之上)",
    Math.abs(state.cafe.popularity
      - cafeServicePopularity(popBefore, over.record.served, over.record.refused, abandoned)) < 1e-9,
    `pop=${state.cafe.popularity} expect=${cafeServicePopularity(popBefore, over.record.served, over.record.refused, abandoned)}`);
  check("當天推了一則(且只有一則)排到放棄的日誌",
    allLogs().filter((text) => text.includes("退出人龍") || text.includes("把菜單放回架上")
      || text.includes("失去耐性") || text.includes("輪不到")).length === 1,
    allLogs().filter((t) => t.includes("人龍") || t.includes("放回架上")).join(" | "));

  const ghosts = state.cafe.guests.filter((guest) => guest.order?.abandoned === true);
  check("放棄離開的人真的出現在店裡(玩家看得到他走進來又走掉)", ghosts.length > 0, `ghosts=${ghosts.length}`);
  check("🔴 放棄的訂單一律 served=false($0 收入)", ghosts.every((guest) => guest.order!.served === false));
  check("🔴 放棄的人不佔席(seatTile 一律 null)", ghosts.every((guest) => guest.seatTile === null));
  check("放棄的人停留時間短(外帶等級,不會霸著顧客上限)",
    ghosts.every((guest) => guest.leavesMs - guest.arrivedMs <= HOUR_MS));
  check("放棄的人與結帳那批不撞 id(續號,不會互相覆蓋)",
    new Set(state.cafe.guests.map((g) => g.id)).size === state.cafe.guests.length);

  const soldCount = Object.values(over.record.sold).reduce((sum, n) => sum + n, 0);
  check("當日成功結帳份數 = record.served(放棄的人沒有混進銷售紀錄)",
    soldCount === over.record.served, `sold=${soldCount} served=${over.record.served}`);
  check("放棄的人沒有出現在缺料統計裡(他不是撲空,是排不到)",
    Object.values(over.record.missed).reduce((sum, n) => sum + n, 0) === over.record.refused);
  check("🔴 錢只因為成功結帳而增加(沒有任何退款/倒扣)",
    state.money - moneyBefore === over.record.revenue,
    `Δmoney=${state.money - moneyBefore} revenue=${over.record.revenue}`);
  check("放棄的人沒有扣掉任何原料(扣的量對得上成功結帳的份數)",
    (() => {
      const now = JSON.parse(JSON.stringify(state.cafe.stock));
      const then = JSON.parse(stockBefore);
      const used = Object.keys(then).reduce((sum, id) => sum + Math.max(0, (then[id] ?? 0) - (now[id] ?? 0)), 0);
      return used > 0 && over.record.served > 0;
    })());

  // =========================================================================
  // 六、🔴 零 RNG / 決定性 / 離線一致
  // =========================================================================
  const runDayTwice = () => {
    setUpCafe(0, { popularity: 100, signLevel: 4 });
    clearLogs();
    const r = runBusinessDay(3);
    return JSON.stringify({
      money: state.money,
      pop: state.cafe.popularity,
      record: r.record,
      guests: state.cafe.guests.map((g) => `${g.id}:${g.order?.abandoned === true}`),
    });
  };
  const callsBefore = randomCalls;
  const firstRun = runDayTwice();
  check("🔴 含放棄離開的整條路徑仍然零 Math.random", randomCalls === callsBefore,
    `calls=${randomCalls - callsBefore}`);
  check("🔴 同輸入連跑兩次逐欄完全相同", firstRun === runDayTwice());

  // 🔴 離線一致:線上逐時 11 小時 vs 離線 syncToNow() 一次補 11 小時。
  // 作法完全比照 `cafe-per-guest-test.ts` 的同名段落(09:00 起跑,剛好蓋滿營業時段);
  // Math.random 釘成常數,兩次分岔就一定是咖啡廳造成的。
  Math.random = () => 0.5;
  const NINE_AM = new Date(2026, 6, 20, 9, 0, 0).getTime();
  const snapshot = () => JSON.stringify({
    money: state.money,
    pop: state.cafe.popularity,
    stock: state.cafe.stock,
    sales: state.cafe.sales,
    ledger: state.ledger.filter((txn) => txn.category === "cafe").map((txn) => ({ label: txn.label, amount: txn.amount })),
  });
  const setupOffline = () => {
    state.ledger.splice(0, state.ledger.length);
    setUpCafe(0, { popularity: 100, signLevel: 4 });
    state.gameMs = NINE_AM + offlineDayShift * DAY_MS;
  };
  // 挑一個當天真的會有人排到放棄的日期,否則離線一致性是假通過。
  let offlineDayShift = 0;
  for (let shift = 0; shift < 14; shift++) {
    state.ledger.splice(0, state.ledger.length);
    setUpCafe(0, { popularity: 100, signLevel: 4 });
    state.gameMs = NINE_AM + shift * DAY_MS;
    for (let i = 0; i < 11; i++) hourlyTick(false);
    if ((state.cafe.sales[state.cafe.sales.length - 1]?.abandoned ?? 0) > 0) { offlineDayShift = shift; break; }
  }

  setupOffline();
  for (let i = 0; i < 11; i++) hourlyTick(false);
  const online = snapshot();
  const onlineGameMs = state.gameMs;

  setupOffline();
  state.gameAnchorMs = state.gameMs;
  state.realAnchorMs = Date.now() - Math.round((11.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  check("離線補進度確實補了 11 個遊戲小時", caught === 11, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs);
  check("🔴 離線一致:逐時跑 11 小時 = 一次補 11 小時(money / 聲譽 / 放棄人次逐欄相同)",
    online === snapshot(), `\n 線上 ${online}\n 離線 ${snapshot()}`);
  check("這 11 小時真的有人排到放棄(否則上一條是假通過)",
    (JSON.parse(online).sales[0]?.abandoned ?? 0) > 0, online.slice(0, 200));
  Math.random = () => { randomCalls++; return originalRandom(); };

  // =========================================================================
  // 七、存檔往返
  // =========================================================================
  setUpCafe(0, { popularity: 100, signLevel: 4 });
  runBusinessDay(11);
  const roundTrip = sanitizeCafeState(JSON.parse(JSON.stringify(state.cafe)), state.gameMs);
  const byId = new Map(state.cafe.guests.map((g) => [g.id, g.order]));
  check("放棄旗標通過存檔消毒後保留(重開遊戲不會變成一筆營收)",
    roundTrip.guests.every((g) => JSON.stringify(g.order) === JSON.stringify(byId.get(g.id))),
    `${roundTrip.guests.length} 位`);
  check("當日放棄人次通過存檔消毒後保留",
    roundTrip.sales.every((day, i) => (day.abandoned ?? 0) === (state.cafe.sales[i].abandoned ?? 0)));
  check("舊存檔(沒有 abandoned 欄位)一律補成 0 / false",
    (() => {
      const legacy = JSON.parse(JSON.stringify(state.cafe));
      for (const day of legacy.sales) delete day.abandoned;
      for (const guest of legacy.guests) if (guest.order) delete guest.order.abandoned;
      const clean = sanitizeCafeState(legacy, state.gameMs);
      return clean.sales.every((d) => d.abandoned === 0)
        && clean.guests.every((g) => g.order === null || g.order.abandoned === false);
    })());
  check("手改存檔把放棄的人標成已服務也救不回來(abandoned 優先於 served)",
    (() => {
      const tampered = JSON.parse(JSON.stringify(state.cafe));
      for (const guest of tampered.guests) if (guest.order) { guest.order.abandoned = true; guest.order.served = true; }
      const clean = sanitizeCafeState(tampered, state.gameMs);
      return clean.guests.every((g) => g.order === null || g.order.served === false);
    })());

  // =========================================================================
  // 八、🔴 渲染層:排進人龍 → 等滿門檻 → 走回店門(不會原地消失、不會點餐)
  // =========================================================================
  const ORDER_OK = {
    itemId: "x", itemName: "招牌美式咖啡", price: 34, track: "coffee" as const,
    served: true, missing: "", takeaway: true, abandoned: false,
  };
  const ORDER_GIVE_UP = { ...ORDER_OK, served: false, abandoned: true };

  /** 一批外帶顧客,最後 `giveUps` 位是模擬層判定會放棄的人。 */
  function agentsWith(count: number, giveUps: number, seed: string) {
    const guests = Array.from({ length: count }, (_, sequence) => generateCafeGuest({
      seed, arrivedMs: sequence * 1000, sequence, seatTile: null, takeaway: true,
      order: sequence >= count - giveUps ? { ...ORDER_GIVE_UP } : { ...ORDER_OK },
    }));
    return createGuestAgents(guests);
  }

  const scene = agentsWith(6, 2, "abandon-render");
  check("guestAbandons() 認得模擬層的旗標",
    scene.filter(guestAbandons).length === 2 && scene.filter((a) => !guestAbandons(a)).length === 4);

  for (let i = 0; i < 120; i++) tickGuestAgents(scene, 0.05, 0, undefined, undefined, 2);
  const queuedGiveUps = scene.filter((a) => guestAbandons(a) && a.phase === "entering");
  check("放棄的人先站進人龍(不是一進門就走)",
    queuedGiveUps.length === 2 && queuedGiveUps.every((a) => a.queueTile !== null),
    queuedGiveUps.map((a) => `${a.phase}@${a.queueTile ? "queue" : "counter"}`).join(" "));
  check("排隊人數把放棄的人算進去(員工的『忙碌』表現照樣成立)", queuedGuestCount(scene) >= 2);
  check("放棄的人**永遠不會**進入 ordering / served(帳本上沒有這筆)",
    scene.filter(guestAbandons).every((a) => a.phase !== "ordering" && a.phase !== "served"));

  for (let i = 0; i < 900; i++) tickGuestAgents(scene, 0.05, 0, undefined, undefined, 2);
  const gone = scene.filter(guestAbandons);
  check("🔴 排滿門檻後放棄的人一定離場",
    gone.every((a) => a.phase === "leaving" || a.phase === "departed"),
    gone.map((a) => `${a.phase}/queueT=${a.queueT.toFixed(1)}`).join(" "));
  check("🔴 他們是**走回店門**才消失,不會原地蒸發",
    gone.filter((a) => a.phase === "departed").every((a) =>
      CAFE_GUEST_ENTRY_TILES.some((tile) => tile.c === a.c && tile.r === a.r)),
    gone.map((a) => `${a.phase}@${a.c},${a.r}`).join(" "));
  check("放棄的人一路上都沒有點過餐", gone.every((a) => a.phase !== "ordering" && a.phase !== "served"));
  check("同一批裡不放棄的人照樣被服務到(放棄不是全店連坐)",
    scene.filter((a) => !guestAbandons(a)).some((a) => ["served", "seated", "leaving", "departed"].includes(a.phase)),
    scene.filter((a) => !guestAbandons(a)).map((a) => a.phase).join(" "));

  const early = agentsWith(3, 1, "abandon-early");
  const steps = Math.floor((GUEST_ABANDON_SECONDS * 0.5) / 0.05);
  for (let i = 0; i < steps; i++) tickGuestAgents(early, 0.05, 0, undefined, undefined, 2);
  check("還沒排滿門檻的人不會提早走掉",
    early.filter(guestAbandons).every((a) => a.phase === "entering"),
    early.filter(guestAbandons).map((a) => `${a.phase}/${a.queueT.toFixed(1)}`).join(" "));
  check("放棄門檻遠短於外帶客的停留時間(一定演得完才被資料層清掉)",
    GUEST_ABANDON_SECONDS > 0 && GUEST_ABANDON_SECONDS < 0.25 * 514.3);

  const solo = agentsWith(1, 1, "abandon-solo");
  for (let i = 0; i < 200; i++) tickGuestAgents(solo, 0.05, 0, undefined, undefined, 4);
  check("🔴 全店只有一位放棄客時,他照樣排隊而不是走去點餐",
    solo[0].phase !== "ordering" && solo[0].phase !== "served",
    `${solo[0].phase}/queue=${JSON.stringify(solo[0].queueTile)}`);
  for (let i = 0; i < 900; i++) tickGuestAgents(solo, 0.05, 0, undefined, undefined, 4);
  check("他最後也走得出去", solo[0].phase === "departed" || solo[0].phase === "leaving", solo[0].phase);

  const legacyScene = (() => {
    const guests = Array.from({ length: 3 }, (_, sequence) => generateCafeGuest({
      seed: "abandon-legacy", arrivedMs: sequence * 1000, sequence, seatTile: null, takeaway: true,
      order: { itemId: "x", itemName: "拿鐵", price: 34, track: "coffee", served: true, missing: "", takeaway: true },
    }));
    return createGuestAgents(guests);
  })();
  for (let i = 0; i < 400; i++) tickGuestAgents(legacyScene, 0.05, 0, undefined, undefined, 3);
  check("舊存檔顧客(沒有 abandoned 欄位)不會被誤判成放棄",
    legacyScene.every((a) => !guestAbandons(a))
    && legacyScene.some((a) => ["served", "leaving", "departed"].includes(a.phase)),
    legacyScene.map((a) => a.phase).join(" "));

  // =========================================================================
  // 九、成績表(給人看的,不是斷言)
  // =========================================================================
  console.log("\n   招牌 / 人力 vs 一週(7 個營業日)的放棄人次(聲譽固定 100):");
  for (const [signLevel, extra] of [[2, 0], [3, 0], [4, 0], [4, 1], [4, 3], [4, 8]] as const) {
    let served = 0;
    let gaveUp = 0;
    let revenue = 0;
    for (let day = 60; day < 67; day++) {
      setUpCafe(extra, { popularity: 100, signLevel });
      const r = runBusinessDay(day);
      served += r.record.served;
      gaveUp += r.record.abandoned ?? 0;
      revenue += r.record.revenue;
    }
    const cap = cafeCapability(state.cafe.upgrades, { seats, extraStaff: extra });
    console.log(
      `     招牌 Lv${signLevel}・員工 ${String(cafeStaffCount(extra)).padStart(2)} 位`
      + ` │ 產能 ${String(cap.capacity).padStart(3)}/日`
      + ` │ 一週成功 ${String(served).padStart(3)}`
      + ` │ 一週放棄 ${String(gaveUp).padStart(3)}`
      + ` │ 一週營收 $${String(revenue).padStart(5)}`,
    );
  }
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
