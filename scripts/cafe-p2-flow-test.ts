/**
 * 咖啡廳重設計 P2:**合流** + 顧客動線 + 開店關店。
 *
 * P1 留下一個分裂:結帳走 `cafeHourlyPass()` 的虛擬 index,而畫面上的人由
 * `cafeGuestPass()` 用另一條 55% 門檻生 —— 兩批人毫無關係。整個重設計的唯一主張是
 *
 *   > 畫面上發生的事,就是帳本上發生的事。
 *
 * 所以這支測試最重要的一條是:**每一筆結帳都對應畫面上一位真的走進來的顧客,
 * 而且他頭上泡泡顯示的就是他真的點的東西、他付的就是真的進帳的錢。**
 *
 * 七組把關:
 * 1. 🔴 合流 —— 某小時的結帳筆數 = 該小時生出的可見顧客數;Σ 訂單金額 = 實際進帳
 * 2. 🔴 席次來自 `placements` 而非硬編表;拆光椅子 → 全部外帶且不崩
 * 3. phase 轉移(含 refused 路徑)與各自的畫面表現
 * 4. 開店 / 關店:非營業時段不生客、打烊清場
 * 5. 🔴 離線一致性:線上逐時 11 小時 vs 離線一次補 11 小時,連 `guests` 都逐欄相同
 * 6. 決定性與零 RNG
 * 7. cap 餘裕:合流不變式在現行客流上限下不會退化
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START } = await import("../src/sim/gameState");
const {
  cafeBusinessOpen, cafeGuestPass, cafeHourlyPass, hourlyTick, syncToNow,
  CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR,
} = await import("../src/sim/tick");
const {
  cafeCapability, cafeCrowd, cafeHourlyGuestCount, menuItems, suggestedStandingOrders,
  CAFE_BUSINESS_HOURS,
} = await import("../src/sim/cafe");
const { CAFE_DINE_IN_CAP, CAFE_GUEST_CAP } = await import("../src/sim/cafeGuests");
const {
  cafeCounterSpots, cafeSeatSpots, getPlacements, placeCafeStarterSet, removePlacementAt,
} = await import("../src/sim/placements");
const {
  createGuestAgents, guestSeated, syncGuestAgents, tickGuestAgents,
  GUEST_ORDER_SECONDS, GUEST_REFUSED_SECONDS, GUEST_SERVED_SECONDS,
} = await import("../src/floor/guestAgents");
const { weatherForDay } = await import("../src/sim/weather");
const { weekdayOf } = await import("../src/sim/week");
const { cafeAmbiancePoints } = await import("../src/sim/placements");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const setCafe = (patch: Partial<typeof state.cafe>) => Object.assign(state.cafe, defaultCafe(), patch);
const stocked = (patch: Partial<typeof state.cafe> = {}) => setCafe({
  open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
  popularity: 60, ...patch,
});
/** 跑一個營業小時(順序照 `hourlyTick()`:先清場/離場,再結帳生客)。 */
function runHour(day: number, hour: number) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
  cafeGuestPass(hour);
  cafeHourlyPass(hour);
}

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.5; };

try {
  placeCafeStarterSet(); // 開張贈品 = 吧台 + 三組桌椅
  state.money = 500_000;

  // =========================================================================
  // 一、🔴 合流:結帳的人 = 畫面上的人
  // =========================================================================
  stocked();
  const before = {
    guests: state.cafe.guests.length,
    money: state.money,
    served: 0,
    refused: 0,
  };
  runHour(40, 13);
  const record = state.cafe.sales[state.cafe.sales.length - 1];
  const arrived = state.cafe.guests;
  const checkouts = record.served + record.refused;
  check("🔴 某小時的結帳筆數 = 該小時生出的可見顧客數",
    checkouts > 0 && arrived.length - before.guests === checkouts,
    `結帳 ${checkouts} 筆 / 顧客 ${arrived.length - before.guests} 位`);
  check("🔴 每位可見顧客都帶著他自己的那張訂單(不是事後補的假資料)",
    arrived.every((guest) => guest.order !== null && guest.order.itemName.length > 0));
  const orderRevenue = arrived.reduce((sum, guest) => sum + (guest.order?.served ? guest.order.price : 0), 0);
  check("🔴 Σ 顧客訂單金額 = 帳上實際進帳金額(泡泡上的錢就是口袋裡的錢)",
    orderRevenue === state.money - before.money && orderRevenue === record.revenue,
    `訂單 $${orderRevenue} / 進帳 $${state.money - before.money} / 銷售紀錄 $${record.revenue}`);
  check("🔴 服務成功的人數 = 訂單標記 served 的人數",
    arrived.filter((g) => g.order?.served).length === record.served,
    `${arrived.filter((g) => g.order?.served).length} vs ${record.served}`);
  const soldFromGuests: Record<string, number> = {};
  for (const guest of arrived) {
    if (guest.order?.served) soldFromGuests[guest.order.itemId] = (soldFromGuests[guest.order.itemId] ?? 0) + 1;
  }
  check("🔴 顧客點的品項逐項對得上銷售紀錄(不是只有總額對)",
    JSON.stringify(soldFromGuests) === JSON.stringify(record.sold),
    `${JSON.stringify(soldFromGuests)} vs ${JSON.stringify(record.sold)}`);
  const menu = menuItems(state.cafe.completed);
  check("每張訂單的售價都真的是菜單上那一項的售價",
    arrived.every((guest) => menu.some((item) => item.id === guest.order?.itemId && item.price === guest.order?.price
      && item.track === guest.order?.track)));

  // 整個營業日累計也對得上
  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  const dayMoney = state.money;
  let seenIds = new Set<string>();
  let seenRevenue = 0;
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    runHour(41, hour);
    for (const guest of state.cafe.guests) {
      if (seenIds.has(guest.id)) continue;
      seenIds.add(guest.id);
      if (guest.order?.served) seenRevenue += guest.order.price;
    }
  }
  const dayRecord = state.cafe.sales[state.cafe.sales.length - 1];
  check("🔴 一整個營業日:可見顧客總數 = 當日結帳筆數",
    seenIds.size === dayRecord.served + dayRecord.refused,
    `${seenIds.size} vs ${dayRecord.served + dayRecord.refused}`);
  check("🔴 一整個營業日:Σ 可見顧客付的錢 = 當日營收 = 當日入帳",
    seenRevenue === dayRecord.revenue && seenRevenue === state.money - dayMoney,
    `$${seenRevenue} / $${dayRecord.revenue} / $${state.money - dayMoney}`);
  check("同時在店的顧客 id 不重複、姓名不撞",
    new Set(state.cafe.guests.map((g) => g.id)).size === state.cafe.guests.length
      && new Set(state.cafe.guests.map((g) => g.name)).size === state.cafe.guests.length);

  // 缺料的那一路也必須有可見顧客(撲空的人也走得進畫面)
  stocked({ stock: {} });
  state.cafe.guests.splice(0, state.cafe.guests.length);
  const brokeMoney = state.money;
  runHour(42, 12);
  const brokeRecord = state.cafe.sales[state.cafe.sales.length - 1];
  check("🔴 全店缺料:撲空的顧客照樣走得進畫面(不是憑空消失的一筆帳)",
    brokeRecord.refused > 0 && state.cafe.guests.length === brokeRecord.refused,
    `refused=${brokeRecord.refused} guests=${state.cafe.guests.length}`);
  check("撲空顧客的訂單標記 served=false 並記下缺的原料名",
    state.cafe.guests.every((g) => g.order?.served === false && g.order.missing.length > 0),
    state.cafe.guests.map((g) => g.order?.missing).join(","));
  check("撲空不進帳一毛錢", state.money === brokeMoney);
  check("撲空的人不佔席位(轉頭就走)", state.cafe.guests.every((g) => g.seatTile === null));

  // =========================================================================
  // 二、🔴 席次來自 placements
  // =========================================================================
  const spots = cafeSeatSpots();
  check("開張贈品提供的席次 = 目錄裡標了 seat 的那幾件家具", spots.length >= 6, `seats=${spots.length}`);
  check("每個席位都有到達格,且到達格與座位格最多相差一格(不會瞬移)",
    spots.every((s) => Math.abs(s.seat.c - s.stand.c) + Math.abs(s.seat.r - s.stand.r) <= 1));
  check("點餐位在吧台前(玩家把吧台擺哪,顧客就走去哪)", cafeCounterSpots().length >= 1);

  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  runHour(43, 11);
  const seatedGuests = state.cafe.guests.filter((g) => g.seatTile);
  check("內用顧客的 seatTile 一定是 placements 查得到的真椅子",
    seatedGuests.length > 0 && seatedGuests.every((g) =>
      spots.some((s) => s.seat.c === g.seatTile!.c && s.seat.r === g.seatTile!.r)),
    `dine-in=${seatedGuests.length}`);
  check("同一時間不會有兩個人坐同一張椅子",
    new Set(seatedGuests.map((g) => `${g.seatTile!.c},${g.seatTile!.r}`)).size === seatedGuests.length);

  // 拆光椅子 → 全部外帶,不崩
  const seatDefIds = new Set(["cafe_table", "cafe_chair_front", "cafe_chair_side"]);
  for (const p of [...getPlacements()]) if (seatDefIds.has(p.defId)) removePlacementAt(p.c, p.r);
  check("拆光座位家具後 cafeSeatSpots() 回空陣列(不是回退到硬編表)", cafeSeatSpots().length === 0);
  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  const noSeatMoney = state.money;
  runHour(44, 14);
  const noSeatRecord = state.cafe.sales[state.cafe.sales.length - 1];
  check("零席次:仍然照常做生意、照常進帳(拆椅子不會壞)",
    noSeatRecord.served > 0 && state.money > noSeatMoney);
  check("🔴 零席次:每筆結帳仍有一位可見顧客",
    state.cafe.guests.length === noSeatRecord.served + noSeatRecord.refused,
    `guests=${state.cafe.guests.length} checkouts=${noSeatRecord.served + noSeatRecord.refused}`);
  check("🔴 零席次:所有人都是外帶(seatTile 全為 null、停留時間很短)",
    state.cafe.guests.every((g) => g.seatTile === null && g.leavesMs - g.arrivedMs < HOUR_MS));
  const noSeatAgents = createGuestAgents(state.cafe.guests);
  for (let i = 0; i < 900; i++) tickGuestAgents(noSeatAgents, 0.05, state.gameMs);
  check("零席次:畫面層不當機,沒有人卡在「坐下」狀態",
    noSeatAgents.every((a) => !guestSeated(a) && a.seatSpot === null));
  placeCafeStarterSet(); // 把桌椅裝回去,後面的測試繼續用

  // =========================================================================
  // 三、phase 轉移與畫面表現
  // =========================================================================
  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  runHour(45, 11);
  const served = state.cafe.guests.find((g) => g.order?.served && g.seatTile);
  check("這一小時至少有一位「有料 + 有空席」的顧客(否則下面是假測)", served !== undefined);
  const agent = createGuestAgents([served!])[0];
  const phases: string[] = [agent.phase];
  for (let i = 0; i < 2000; i++) {
    tickGuestAgents([agent], 0.05, state.gameMs);
    if (phases[phases.length - 1] !== agent.phase) phases.push(agent.phase);
    if (agent.phase === "seated" && guestSeated(agent)) break;
  }
  check("🔴 內用動線 phase 序列 = entering → ordering → served → seated",
    phases.join(">") === "entering>ordering>served>seated", phases.join(">"));
  check("🔴 顧客真的坐在椅子上(不是站在空地板)", guestSeated(agent)
    && agent.c === agent.seatSpot!.stand.c && agent.r === agent.seatSpot!.stand.r);
  check("ordering 階段站在吧台前(玩家看得到他在點餐)",
    cafeCounterSpots().some((t) => t.c === agent.counterTile.c && t.r === agent.counterTile.r));
  // 時間到 → 起身離場 → 走回店門
  tickGuestAgents([agent], 0, served!.leavesMs);
  check("停留時間到 → 切換為 leaving", agent.phase === "leaving");
  for (let i = 0; i < 2000 && agent.phase !== "departed"; i++) tickGuestAgents([agent], 0.05, served!.leavesMs);
  check("離場顧客走回店門才消失(不原地蒸發)", agent.phase === "departed" && agent.hidden && agent.r === 51);

  // refused 路徑
  stocked({ stock: {} });
  state.cafe.guests.splice(0, state.cafe.guests.length);
  runHour(46, 12);
  const refusedGuest = state.cafe.guests.find((g) => g.order?.served === false);
  const refusedAgent = createGuestAgents([refusedGuest!])[0];
  const refusedPhases: string[] = [refusedAgent.phase];
  for (let i = 0; i < 2000; i++) {
    tickGuestAgents([refusedAgent], 0.05, state.gameMs);
    if (refusedPhases[refusedPhases.length - 1] !== refusedAgent.phase) refusedPhases.push(refusedAgent.phase);
    if (refusedAgent.phase === "leaving") break;
  }
  check("🔴 缺料動線 phase 序列 = entering → ordering → refused → leaving",
    refusedPhases.join(">") === "entering>ordering>refused>leaving", refusedPhases.join(">"));
  check("缺料的顧客永遠不會入座", refusedAgent.seatSpot === null);
  check("三段演出各有非零秒數(不會一幀閃過看不到)",
    GUEST_ORDER_SECONDS > 1 && GUEST_SERVED_SECONDS > 1 && GUEST_REFUSED_SECONDS > 1);

  // 外帶路徑:有料但沒空席 → served → leaving,不入座
  const takeawayGuest = { ...served!, id: "takeaway_probe", seatTile: null };
  const takeawayAgent = createGuestAgents([takeawayGuest])[0];
  const takeawayPhases: string[] = [takeawayAgent.phase];
  for (let i = 0; i < 2000; i++) {
    tickGuestAgents([takeawayAgent], 0.05, 0);
    if (takeawayPhases[takeawayPhases.length - 1] !== takeawayAgent.phase) takeawayPhases.push(takeawayAgent.phase);
    if (takeawayAgent.phase === "leaving") break;
  }
  check("🔴 外帶動線 phase 序列 = entering → ordering → served → leaving(點完就走)",
    takeawayPhases.join(">") === "entering>ordering>served>leaving", takeawayPhases.join(">"));

  // =========================================================================
  // 四、開店 / 關店(設計文件 §4.4)
  // =========================================================================
  check("cafeBusinessOpen:10:00~20:00 才算營業中",
    cafeBusinessOpen(true, CAFE_OPEN_HOUR) && cafeBusinessOpen(true, CAFE_CLOSE_HOUR)
      && !cafeBusinessOpen(true, CAFE_OPEN_HOUR - 1) && !cafeBusinessOpen(true, CAFE_CLOSE_HOUR + 1));
  check("cafeBusinessOpen:沒開張就永遠是打烊(店還沒存在)",
    !cafeBusinessOpen(false, 12) && !cafeBusinessOpen(false, CAFE_OPEN_HOUR));

  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  const offHours: number[] = [];
  for (let hour = 0; hour < 24; hour++) {
    stocked();
    state.cafe.guests.splice(0, state.cafe.guests.length);
    runHour(47, hour);
    if (state.cafe.guests.length > 0) offHours.push(hour);
  }
  check("🔴 非營業時段一位顧客都不生",
    offHours.every((hour) => cafeBusinessOpen(true, hour)), `生客時段=${offHours.join(",")}`);
  check("營業時段確實有生客(否則上一條是假通過)", offHours.length >= 8, `hours=${offHours.length}`);

  stocked();
  state.cafe.guests.splice(0, state.cafe.guests.length);
  runHour(48, CAFE_CLOSE_HOUR);
  const beforeClose = state.cafe.guests.length;
  runHour(48, CAFE_CLOSE_HOUR + 1);
  check("🔴 打烊那一刻顧客清場(一樓變成暗的、空的)",
    beforeClose > 0 && state.cafe.guests.length === 0, `關店前 ${beforeClose} 位`);

  // =========================================================================
  // 五、🔴 離線一致性(P1 那條仍綠,而且現在連 guests 一起比)
  // =========================================================================
  const NINE_AM = new Date(2026, 6, 20, 9, 0, 0).getTime();
  const snapshot = () => JSON.stringify({
    money: state.money,
    stock: state.cafe.stock,
    popularity: state.cafe.popularity,
    sales: state.cafe.sales,
    guests: state.cafe.guests,
  });
  const setupOffline = () => {
    state.money = 400_000;
    state.ledger.splice(0, state.ledger.length);
    stocked({ popularity: 45 });
    state.gameMs = NINE_AM;
  };

  setupOffline();
  for (let i = 0; i < 11; i++) hourlyTick(false);
  const online = snapshot();
  const onlineGameMs = state.gameMs;
  const onlineGuests = state.cafe.guests.length;

  setupOffline();
  state.gameAnchorMs = state.gameMs;
  state.realAnchorMs = Date.now() - Math.round((11.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  check("離線補進度確實補了 11 個遊戲小時", caught === 11, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs);
  check("🔴 離線一致性:money / stock / popularity / 銷售紀錄 / **顧客(含訂單)** 逐欄相同",
    online === snapshot(), online === snapshot() ? "" : `\n     線上 ${online.slice(0, 300)}\n     離線 ${snapshot().slice(0, 300)}`);
  check("這 11 小時真的有人走進來(否則上一條是假通過)", onlineGuests > 0, `guests=${onlineGuests}`);

  // =========================================================================
  // 六、決定性與零 RNG
  // =========================================================================
  const runDay = () => {
    stocked({ popularity: 55 });
    state.cafe.guests.splice(0, state.cafe.guests.length);
    state.money = 300_000;
    for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) runHour(52, hour);
    return JSON.stringify({ guests: state.cafe.guests, sales: state.cafe.sales.at(-1), money: state.money });
  };
  const beforeCalls = randomCalls;
  const firstDay = runDay();
  check("🔴 合流後的整條路徑仍然零 Math.random", randomCalls === beforeCalls, `calls=${randomCalls - beforeCalls}`);
  check("🔴 同輸入連跑兩次:顧客、訂單、銷售紀錄、金額逐欄完全相同", firstDay === runDay());

  // 存檔往返後顧客身上的訂單不會走樣
  const { sanitizeCafeState } = await import("../src/sim/gameState");
  const roundTrip = sanitizeCafeState(JSON.parse(JSON.stringify(state.cafe)), state.gameMs);
  // ⚠️ 不可直接比兩邊的 `guests` 陣列:`sanitizeCafeState` 用**嚴格** `gameMs` 呼叫
  // `removeDepartedCafeGuests`,而 `cafeGuestPass` 用的是**含寬限期**的
  // `gameMs - CAFE_GUEST_LINGER_MS`(寬限期是留給畫面演「走回門口」的)。
  // 消毒濾得比較兇是**正確行為**——重開遊戲時該走的客人本來就該走光。
  // 所以這裡要比的是「**存活下來的**顧客,訂單有沒有走樣」,而不是兩個陣列等長。
  const survivors = roundTrip.guests;
  const byId = new Map(state.cafe.guests.map((g) => [g.id, g.order]));
  check("存活顧客都能在消毒前找到本人(沒有憑空生出顧客)",
    survivors.every((g) => byId.has(g.id)), `${survivors.length} 位`);
  check("訂單通過存檔消毒後逐欄保留(泡泡不會在重開後變空白)",
    survivors.every((g) => JSON.stringify(g.order) === JSON.stringify(byId.get(g.id))),
    `存活 ${survivors.length} / 消毒前 ${state.cafe.guests.length}`);
  check("消毒後仍有帶著訂單的顧客(否則上一條是假通過)",
    survivors.some((g) => g.order !== null), `${survivors.filter((g) => g.order).length} 位帶單`);

  // syncGuestAgents 的資料同步:訂單換了要跟著換
  const agents = createGuestAgents(state.cafe.guests.slice(0, 2));
  const swapped = state.cafe.guests.slice(0, 2).map((g) => ({ ...g, order: g.order ? { ...g.order, price: 999 } : null }));
  const resynced = syncGuestAgents(agents, swapped);
  check("syncGuestAgents 會把最新的訂單同步進 agent", resynced.every((a) => a.guest.order?.price === 999));

  // =========================================================================
  // 七、🔴 cap 餘裕:合流不變式在現行客流上限下不會退化
  // =========================================================================
  // 🔴 P4a:產能改成 `min(席次×迴轉率 + 外帶底量, 員工×杯數)`。cap 餘裕的推導前提
  // 因此改成「這一局實際的產能上限」——席次是這支測試自己擺出來的那些椅子。
  const maxCapacity = cafeCapability(
    ["cafe_espresso_machine", "cafe_signboard"],
    { seats: cafeSeatSpots().length, extraStaff: state.cafe.extraStaff },
  ).capacity;
  const maxHourly = Math.max(...Array.from({ length: CAFE_BUSINESS_HOURS },
    (_, i) => cafeHourlyGuestCount(maxCapacity, i)));
  check("🔴 cap 餘裕 = CAFE_GUEST_CAP − CAFE_DINE_IN_CAP 夠塞下一小時的最大到客",
    CAFE_GUEST_CAP - CAFE_DINE_IN_CAP >= maxHourly,
    `餘裕 ${CAFE_GUEST_CAP - CAFE_DINE_IN_CAP} vs 單小時上限 ${maxHourly}`);
  check("內用上限本身也不會超過 cap", CAFE_DINE_IN_CAP < CAFE_GUEST_CAP);
  // 實際跑一次「全滿」的一天,確認每個營業小時都不曾漏掉任何一位顧客
  stocked({ popularity: 100, upgrades: ["cafe_espresso_machine", "cafe_signboard", "cafe_outdoor_seats"] });
  state.cafe.guests.splice(0, state.cafe.guests.length);
  // ⚠️ 這裡必須數「**新進場**的顧客」而不是 `guests.length` 的淨變化。
  // `runHour` 先跑 `cafeGuestPass`(移除離場顧客)再跑 `cafeHourlyPass`(新增),
  // 而外帶/撲空客只停留 CAFE_TAKEAWAY_STAY_HOURS(0.25 小時)⇒ 幾乎每小時都有人離場。
  // 用淨變化會把「正常離場」誤判成「顧客被吃掉」,11 小時裡有 8 小時假性失敗。
  let lostGuests = 0;
  const detail: string[] = [];
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    const idsBefore = new Set(state.cafe.guests.map((g) => g.id));
    const soldBefore = state.cafe.sales.at(-1);
    const checkedBefore = (soldBefore?.served ?? 0) + (soldBefore?.refused ?? 0);
    runHour(60, hour);
    const after = state.cafe.sales.at(-1)!;
    const delta = (after.served + after.refused) - (hour === CAFE_OPEN_HOUR ? 0 : checkedBefore);
    const arrived = state.cafe.guests.filter((g) => !idsBefore.has(g.id)).length;
    if (arrived !== delta) {
      lostGuests++;
      detail.push(`${hour}時 結帳${delta}/進場${arrived}`);
    }
  }
  check("🔴 滿產能跑滿一天:沒有任何一個小時出現「收了錢卻沒有人」", lostGuests === 0,
    `壞掉的小時數=${lostGuests} ${detail.join(" / ")}`);

  // 客流上限的來源(未來 P4b 若把產能推高,上面那條餘裕要跟著放大)
  const cap = cafeCapability(
    ["cafe_espresso_machine", "cafe_signboard"],
    { seats: cafeSeatSpots().length, extraStaff: state.cafe.extraStaff },
  );
  const crowd = cafeCrowd({
    weather: weatherForDay(60), weekday: weekdayOf(state.gameMs), signLevel: cap.signLevel,
    capacity: cap.capacity, popularity: 100, outdoorSeats: true, ambiancePoints: cafeAmbiancePoints(),
  });
  check("目前日客流永遠不超過產能上限(cap 餘裕的推導前提)", crowd.guests <= maxCapacity,
    `crowd=${crowd.guests} capacity=${maxCapacity}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
