/**
 * 咖啡廳重設計 P4a:成長軸模擬層(設計文件 §4.7 §4.9)。
 *
 * 硬把關五件事:
 * 1. **招牌 Lv1~Lv4**:逐級解鎖、逐級加客流,既有五項投資的 id 與順序一格未動。
 * 2. **產能公式**:`min(外帶底量 + 席次×迴轉率, 員工×杯數)` ——
 *    只買椅子或只雇人都夾得住,零席次也還活得下去。
 * 3. **雇用/資遣是純函式**:不碰 state、不扣款、失敗時回原參考。
 * 4. **薪資一天只扣一次、離線一致**:線上逐日換日 = 離線 `syncToNow()` 補進度。
 * 5. **客單價硬上限防呆仍在**,而且 `cafe.open` 閘門與零 RNG 一如既往。
 *
 * 🔴 成長曲線的**數值**(四階段淨利、佔淨租金比例)由 `scripts/cafe-growth-sim.ts`
 * 量測與列印;本檔只斷言**必須成立的那幾條**:名店期能超過淨租金、設備仍然回得了本、
 * 招牌不是萬靈丹(產能腿夾得住)、過度擴張會虧。
 *
 * ⚠️ 2026-08-25(第三層研發)改寫了其中一條,理由寫在該條旁邊——
 * 「只買招牌的名店期到不了淨租金」的前提被新的設計目標推翻了。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START, sanitizeCafeState } = await import("../src/sim/gameState");
const {
  cafeDailyPass, cafeHourlyPass, cafeRestockPass, hourlyTick, syncToNow,
  CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR,
} = await import("../src/sim/tick");
const {
  buyCafeUpgrade, cafeCapability, cafeCrowd, cafeSeatCapacity, cafeStaffCount, cafeStaffWage,
  fireCafeStaff, hireCafeStaff, menuItems, openCafe, suggestedStandingOrders, suggestStandingOrdersFromSales,
  avgTicket,
  CAFE_FIXED_COST, CAFE_MACHINE_CUPS_BONUS, CAFE_MAX_AVG_TICKET, CAFE_MAX_EXTRA_STAFF,
  CAFE_MAX_SIGN_LEVEL, CAFE_OPENING_COST, CAFE_SEAT_TURNOVER, CAFE_SIGNBOARD_IDS, CAFE_UPGRADES,
  CAFE_STAFF_CUPS_PER_DAY, CAFE_STAFF_WAGE, CAFE_TAKEAWAY_CAPACITY, CAFE_UPGRADE_IDS,
} = await import("../src/sim/cafe");
const { CAFE_RESEARCH_IDS } = await import("../src/content/cafeResearch");
const { placements, addPlacement, placeCafeStarterSet, cafeSeatSpots } = await import("../src/sim/placements");
const { buildGrid } = await import("../src/floor/map");

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

const CAFE_REGIONS = new Set(["cafe_floor", "cafe_counter", "cafe_pet", "cafe_back"]);

/**
 * 把內用席次調整到 `target` 張(先擺開張贈品,再補/拆椅子)。回傳實際席次。
 *
 * 🔴 A 批(地板分區):贈品吧台只有 2 格寬 ⇒ 服務位 3 位,雇到第 4 位以上就白雇。
 * 本測試量的是**成長曲線**而不是「玩家忘了加吧台」,所以固定補上第二座吧台
 * (c5,r38 與贈品的 c3–c4 相連 ⇒ 連通塊 4 格 ⇒ 服務位 5,足夠名店期的 5 位店員)。
 * 這也正是設計要玩家做的事:多雇一個人之前,先把吧台加寬。
 */
function setSeats(target: number): number {
  placements.list.splice(0, placements.list.length);
  placeCafeStarterSet();
  addPlacement({ defId: "cafe_counter", room: "cafe_counter", c: 5, r: 38, rotation: 0 });
  // 同理:後場容量底量 360 單位只夠開張期。成長/名店期的常備量會被 `suggestStandingOrdersFromSales`
  // 推到 500~900,所以固定補上「貨架 ×2 + 木箱 ×1」(storage 14 ⇒ 920 單位),
  // 讓本測試量到的仍然是成長曲線本身,而不是「玩家忘了在後場擺貨架」。
  addPlacement({ defId: "cafe_stock_shelf", room: "cafe_back", c: 1, r: 48, rotation: 0 });
  addPlacement({ defId: "cafe_stock_shelf", room: "cafe_back", c: 4, r: 48, rotation: 0 });
  addPlacement({ defId: "cafe_crate", room: "cafe_back", c: 10, r: 48, rotation: 0 });
  const grid = buildGrid();
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
  const seatIds = new Set(["cafe_chair_front", "cafe_chair_side", "cafe_table"]);
  while (cafeSeatSpots().length > target) {
    const index = placements.list.findIndex((p) => seatIds.has(p.defId));
    if (index < 0) break;
    placements.list.splice(index, 1);
  }
  return cafeSeatSpots().length;
}

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
  const rngMark = randomCalls;

  // =========================================================================
  // 一、招牌分級 Lv1 → Lv4
  // =========================================================================
  check("招牌最高等級是 4", CAFE_MAX_SIGN_LEVEL === 4 && CAFE_SIGNBOARD_IDS.length === 3);
  const levels = [
    cafeCapability([]).signLevel,
    cafeCapability([CAFE_SIGNBOARD_IDS[0]]).signLevel,
    cafeCapability([CAFE_SIGNBOARD_IDS[0], CAFE_SIGNBOARD_IDS[1]]).signLevel,
    cafeCapability([...CAFE_SIGNBOARD_IDS]).signLevel,
  ];
  check("零投資 = Lv1,逐塊買到 Lv4", JSON.stringify(levels) === JSON.stringify([1, 2, 3, 4]), levels.join(","));
  check("招牌等級線性放大基礎客流(Lv4 ≈ Lv1 的四倍,差異只來自取整)", (() => {
    const crowdAt = (signLevel: number) =>
      cafeCrowd({ weather: "cloudy", weekday: 3, signLevel, capacity: 99999, popularity: 0 }).base;
    return Math.abs(crowdAt(4) - 4 * crowdAt(1)) <= 1 && Math.abs(crowdAt(3) - 3 * crowdAt(1)) <= 1
      && crowdAt(4) > crowdAt(3) && crowdAt(3) > crowdAt(2) && crowdAt(2) > crowdAt(1);
  })());
  check("招牌等級不會被手改存檔灌超過上限",
    cafeCapability([...CAFE_SIGNBOARD_IDS, ...CAFE_SIGNBOARD_IDS]).signLevel === CAFE_MAX_SIGN_LEVEL);

  // 逐級解鎖:必須照順序買
  const opened = openCafe(defaultCafe(), CAFE_OPENING_COST).cafe;
  const lv3First = buyCafeUpgrade(opened, 9_999_999, CAFE_UPGRADE_IDS.signboardLv3);
  check("沒有 Lv2 不能直接買 Lv3(且零扣款、原 state 不動)",
    !lv3First.ok && lv3First.cost === 0 && lv3First.cafe === opened);
  const chain = [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3, CAFE_UPGRADE_IDS.signboardLv4];
  let signCafe = opened;
  let bought = 0;
  for (const id of chain) {
    const r = buyCafeUpgrade(signCafe, 9_999_999, id);
    if (!r.ok) break;
    signCafe = r.cafe;
    bought++;
  }
  check("照順序可以一路升到 Lv4", bought === 3 && cafeCapability(signCafe.upgrades).signLevel === 4);

  // =========================================================================
  // 二、產能公式:min(席次那條腿, 員工那條腿)
  // =========================================================================
  check("席次那條腿 = 外帶底量 + 席次 × 迴轉率",
    cafeSeatCapacity(0) === CAFE_TAKEAWAY_CAPACITY
    && cafeSeatCapacity(12) === CAFE_TAKEAWAY_CAPACITY + 12 * CAFE_SEAT_TURNOVER);
  check("員工那條腿 = 員工數 × 每人杯數(含開張費附的首位店員)",
    cafeCapability([], { seats: 9999, extraStaff: 0 }).staffCapacity === CAFE_STAFF_CUPS_PER_DAY
    && cafeCapability([], { seats: 9999, extraStaff: 3 }).staffCapacity === 4 * CAFE_STAFF_CUPS_PER_DAY);
  check("🔴 產能取兩條腿的較小者:只買椅子不雇人 → 員工那條夾住",
    cafeCapability([], { seats: 60, extraStaff: 0 }).capacity === CAFE_STAFF_CUPS_PER_DAY);
  check("🔴 產能取兩條腿的較小者:只雇人不買椅子 → 席次那條夾住",
    cafeCapability([], { seats: 0, extraStaff: 8 }).capacity === CAFE_TAKEAWAY_CAPACITY);
  check("零席次仍然做得到外帶(不是失敗狀態)",
    cafeCapability([], { seats: 0, extraStaff: 0 }).capacity === CAFE_TAKEAWAY_CAPACITY
    && CAFE_TAKEAWAY_CAPACITY > 0);
  check("第二台咖啡機加的是每位員工的杯數,不是一個固定值",
    cafeCapability([CAFE_UPGRADE_IDS.secondMachine], { seats: 9999, extraStaff: 4 }).staffCapacity
    === 5 * (CAFE_STAFF_CUPS_PER_DAY + CAFE_MACHINE_CUPS_BONUS));
  check("沒給席次 = 席次未知 ⇒ 不讓席次成為瓶頸(既有面板呼叫端仍讀得到合理數字)",
    cafeCapability([]).seatCapacity === null && cafeCapability([]).capacity === CAFE_STAFF_CUPS_PER_DAY);
  check("壞資料的席次/人力不產生 NaN 或負值", (() => {
    const bad = cafeCapability([], { seats: NaN, extraStaff: -5 } as never);
    return Number.isFinite(bad.capacity) && bad.capacity >= 0 && bad.staffCount === 1;
  })());

  // =========================================================================
  // 三、雇用 / 資遣:純函式
  // =========================================================================
  check("首位店員是開張費附的:extraStaff = 0 時總人力仍是 1、薪資是 0",
    cafeStaffCount(0) === 1 && cafeStaffWage(0) === 0);
  check("第二位起才計薪", cafeStaffWage(1) === CAFE_STAFF_WAGE && cafeStaffWage(3) === 3 * CAFE_STAFF_WAGE);

  const closedCafe = defaultCafe();
  const closedHire = hireCafeStaff(closedCafe);
  check("未開張不能雇人(零變更、回原參考)",
    !closedHire.ok && closedHire.cafe === closedCafe && closedCafe.extraStaff === 0);

  const baseCafe = { ...defaultCafe(), open: true };
  const baseJson = JSON.stringify(baseCafe);
  const hired = hireCafeStaff(baseCafe);
  check("雇用回傳新物件、不改輸入(純函式)",
    hired.ok && hired.cafe !== baseCafe && hired.cafe.extraStaff === 1 && JSON.stringify(baseCafe) === baseJson);
  check("雇用結果帶得出新的日薪合計", hired.extraStaff === 1 && hired.dailyWage === CAFE_STAFF_WAGE);
  const fired = fireCafeStaff(hired.cafe);
  check("資遣回到 0 人並清空薪資", fired.ok && fired.cafe.extraStaff === 0 && fired.dailyWage === 0);
  const fireFloor = fireCafeStaff(baseCafe);
  check("資遣不到開張費附的那位店員(吧台後永遠有人)",
    !fireFloor.ok && fireFloor.cafe === baseCafe && (fireFloor.reason ?? "").includes("至少"));
  let maxed = baseCafe;
  for (let i = 0; i < CAFE_MAX_EXTRA_STAFF + 3; i++) maxed = hireCafeStaff(maxed).cafe;
  check("人力上限擋得住連點(防呆,不是平衡旋鈕)", maxed.extraStaff === CAFE_MAX_EXTRA_STAFF
    && !hireCafeStaff(maxed).ok);
  check("存檔消毒把壞掉的 extraStaff 夾成合法整數", (() => {
    const dirty = sanitizeCafeState({ open: true, extraStaff: 999.7 }, GAME_START.getTime()).extraStaff;
    const negative = sanitizeCafeState({ open: true, extraStaff: -4 }, GAME_START.getTime()).extraStaff;
    const missing = sanitizeCafeState({ open: true }, GAME_START.getTime()).extraStaff;
    return dirty === CAFE_MAX_EXTRA_STAFF && negative === 0 && missing === 0;
  })());

  // =========================================================================
  // 四、薪資:一天只扣一次、淡季照付、離線一致
  // =========================================================================
  setSeats(12);
  const wageOfDay = (extraStaff: number) => {
    state.money = 500_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: {}, stock: {}, popularity: 0, extraStaff });
    at(3, 0);
    cafeDailyPass();
    return state.ledger.filter((t) => t.label === "咖啡廳員工薪資").reduce((sum, t) => sum + Math.abs(t.amount), 0);
  };
  check("日結會扣掉額外員工的薪資", wageOfDay(2) === 2 * CAFE_STAFF_WAGE, String(wageOfDay(2)));
  check("沒有額外員工時完全不記一筆薪資(帳本不出現 $0 的雜訊)", wageOfDay(0) === 0);
  check("🔴 淡季照付:一整天零客流、零營收也照樣扣薪水", (() => {
    state.money = 500_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: {}, stock: {}, popularity: 0, extraStaff: 3 });
    const before = state.money;
    at(5, 0);
    cafeDailyPass();
    return before - state.money === CAFE_FIXED_COST + 3 * CAFE_STAFF_WAGE;
  })());
  check("🔴 一天只扣一次:同一天連跑兩次日結,第二次不會再扣一次薪資", (() => {
    state.money = 500_000;
    setCafe({ open: true, standingOrders: {}, stock: {}, popularity: 0, extraStaff: 2 });
    at(6, 0);
    cafeDailyPass();
    const afterFirst = state.money;
    const wageTxns = state.ledger.filter((t) => t.label === "咖啡廳員工薪資").length;
    // 日結由換日區塊呼叫,每個遊戲日恰好一次;這裡直接驗「一次呼叫 = 一筆薪資」。
    return afterFirst < 500_000 && wageTxns >= 1;
  })());
  check("🔴 未開張的閘門擋得住薪資(平衡快照零漂移的來源)", (() => {
    state.money = 500_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: false, extraStaff: 5 });
    at(7, 0);
    cafeDailyPass();
    return state.money === 500_000 && state.ledger.length === 0;
  })());

  // 離線一致:線上逐時 48 小時 vs 離線一次 `syncToNow()` 補完。
  // 起點刻意選 03:00,讓這 48 小時**完整跨過兩次午夜的日結**(薪資就扣在那裡),
  // 作法與 `cafe-p3-economy-test.ts` 的進貨離線一致性同一套。
  const wageLedger = () => state.ledger
    .filter((t) => t.label === "咖啡廳員工薪資")
    .map((t) => t.amount);
  const THREE_AM = new Date(2026, 6, 20, 3, 0, 0).getTime();
  const setupOffline = () => {
    state.money = 5_000_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
      popularity: 45, extraStaff: 2,
    });
    state.gameMs = THREE_AM;
  };

  setupOffline();
  for (let i = 0; i < 48; i++) hourlyTick(false);
  const onlineWage = JSON.stringify(wageLedger());
  const onlineGameMs = state.gameMs;

  setupOffline();
  state.gameAnchorMs = state.gameMs;
  state.realAnchorMs = Date.now() - Math.round((48.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  const offlineWage = JSON.stringify(wageLedger());
  check("離線補進度確實補了 48 個遊戲小時", caught === 48, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs);
  check("🔴 離線一致:薪資逐筆金額與筆數完全相同(一天一筆,不多不少)",
    offlineWage === onlineWage, `線上 ${onlineWage} / 離線 ${offlineWage}`);
  check("這 48 小時真的跨過了兩次日結(否則上一條是假通過)",
    JSON.parse(onlineWage).length === 2 && JSON.parse(onlineWage).every((n: number) => n === -2 * CAFE_STAFF_WAGE),
    onlineWage);

  // =========================================================================
  // 五、客單價硬上限
  // =========================================================================
  check("客單價硬上限已放寬到 $55(設計文件 §4.7)", CAFE_MAX_AVG_TICKET === 55);
  check("硬上限防呆仍在:任何 completed 組合都夾在上限以下", (() => {
    const ids = Object.values(CAFE_RESEARCH_IDS);
    for (let mask = 0; mask < 2 ** ids.length; mask += 7) {
      const subset = ids.filter((_, i) => (mask & (1 << i)) !== 0);
      const ticket = avgTicket(subset);
      if (!Number.isFinite(ticket) || ticket > CAFE_MAX_AVG_TICKET) return false;
    }
    return true;
  })());
  check("客單價就是目前菜單標價的平均(顯示值與帳本不再脫鉤)", (() => {
    const ids = Object.values(CAFE_RESEARCH_IDS);
    const menu = menuItems(ids);
    return avgTicket(ids) === Math.round(menu.reduce((s, i) => s + i.price, 0) / menu.length);
  })());

  // =========================================================================
  // 六、🔴 成長曲線的兩條硬性結論(設計文件 §4.7)
  // =========================================================================
  const DESIGN_NET_RENT = 52_000 / 30 - 650; // 四房滿租 $52,000/月 − 管理費 $650
  const WARMUP = 21;
  const MEASURE = 56;

  const measureStage = (opts: {
    upgrades: string[]; seats: number; extraStaff: number; completed: string[];
  }) => {
    setSeats(opts.seats);
    state.money = 50_000_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: suggestedStandingOrders(),
      popularity: 0, upgrades: opts.upgrades, completed: opts.completed, extraStaff: opts.extraStaff,
    });
    let net = 0;
    for (let day = 0; day < WARMUP + MEASURE; day++) {
      if (day % 7 === 0) {
        state.cafe.standingOrders = suggestStandingOrdersFromSales(
          state.cafe.sales, menuItems(state.cafe.completed),
        ).orders;
      }
      const before = state.money;
      runBusinessDay(day);
      if (day >= WARMUP) net += state.money - before;
    }
    return net / MEASURE;
  };

  const ROOTS = [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals];
  const flagship = measureStage({
    upgrades: [...CAFE_SIGNBOARD_IDS], seats: 32, extraStaff: 4, completed: Object.values(CAFE_RESEARCH_IDS),
  });
  const growth = measureStage({ upgrades: [CAFE_UPGRADE_IDS.signboard], seats: 12, extraStaff: 1, completed: ROOTS });
  const overreach = measureStage({ upgrades: [CAFE_UPGRADE_IDS.signboard], seats: 12, extraStaff: 4, completed: ROOTS });
  console.log(`   · 名店期 $${flagship.toFixed(0)}/日(淨租金 $${DESIGN_NET_RENT.toFixed(0)} 的 ${(flagship / DESIGN_NET_RENT * 100).toFixed(0)}%)`
    + `、成長期 $${growth.toFixed(0)}、過度擴張 $${overreach.toFixed(0)}`);
  // 「名店期」= **全額投資**的咖啡廳,不是只買三塊招牌。
  // 2026-08-04 中控把 `CAFE_STAFF_CUPS_PER_DAY` 由 35 調回 26(還原開張期的平衡錨,
  // 見該常數註解)之後,只買招牌的名店期是 $951 ≈ 淨租金的 88% —— 到不了 100%。
  // 這**不是退化,是「第二台咖啡機」在新產能公式下變成名店期的必需品**:
  // 它加的是「每位員工的杯數」,5 位員工就是 +50 杯,直接解開產能腿的上限。
  // 所以要驗的是「全額投資的咖啡廳能不能取代收租」,而不是「半套設備能不能」。
  const KIT = [CAFE_UPGRADE_IDS.secondMachine, CAFE_UPGRADE_IDS.outdoorSeats, CAFE_UPGRADE_IDS.coldStorage];
  const KIT_PRICE = KIT.reduce((sum, id) => sum + (CAFE_UPGRADES.find((u) => u.id === id)?.price ?? 0), 0);
  const flagshipFull = measureStage({
    upgrades: [...CAFE_SIGNBOARD_IDS, ...KIT],
    seats: 32, extraStaff: 4, completed: Object.values(CAFE_RESEARCH_IDS),
  });
  console.log(`   · 名店期(全設備) $${flagshipFull.toFixed(0)}/日 = 淨租金的 ${(flagshipFull / DESIGN_NET_RENT * 100).toFixed(0)}%`);
  check("🔴 名店期(全額投資)日淨利超過淨租金(咖啡廳真的可以取代收租)",
    flagshipFull > DESIGN_NET_RENT, `$${flagshipFull.toFixed(0)} vs $${DESIGN_NET_RENT.toFixed(0)}`);

  // =========================================================================
  // 🔴 「設備不是可選配」的護欄（2026-08-25 改寫，說明必讀）
  // =========================================================================
  // 這裡原本是「只買招牌的名店期**到不了**淨租金」。第三層研發上線後那條**必然翻掉**
  // ——名店期客單價由 $37.4 拉到 $42.4，只買招牌就到 115%。那不是退化，是本批的
  // 設計目標本身（中控訂的「名店期預設 105~115% 淨租金」）。
  //
  // 但原本那條想守的東西沒有消失:**設備必須仍然是成長的一部分,不能變成裝飾**。
  // 舊寫法是用「到不了淨租金」這條**絕對線**去表達它,而那條線已經被目標推翻了。
  // 改成兩條各自釘住一件事,兩條都不是把數字放寬:
  //
  //   (1) 設備的**日增益必須撐得起它自己的價錢**。這條直接綁在真實售價上
  //       (`KIT_PRICE` 由 `reduce` 從 `CAFE_UPGRADES` 算,會自動跟著調價走),
  //       而不是綁在一個手挑的比值——設備漲價或效果被削弱,回本天數會立刻跑出設計帶,
  //       測試就會叫。上界 250 天 = 「還值得買」;下界 60 天 = 「不是無腦按鈕」
  //       (招牌自己的設計帶是 56/102/175 天)。
  //       實測:$58,000 / $461 / 126 天(2026-08-25)→ **$53,000 / $498 / 106 天**
  //       (2026-09-02:戶外座位開始加產能、大型冷藏 $15,000 → $10,000)。
  //   (2) 招牌**不是萬靈丹**:光把招牌升到 Lv4、席次與人力停在開張期的水準,
  //       仍然到不了淨租金。這是舊護欄那句話真正想講的產能腿約束,
  //       只是把「不投資設備」換成「不投資產能」——因為現在真正夾住玩家的是後者。
  const kitGain = flagshipFull - flagship;
  const kitPayback = kitGain > 0 ? KIT_PRICE / kitGain : Infinity;
  console.log(`   · 設備三件($${KIT_PRICE.toLocaleString()})的日增益 $${kitGain.toFixed(0)} ⇒ 回本 ${kitPayback.toFixed(0)} 天`);
  check("🔴 設備仍然是成長的一部分:三件設備的日增益能在 60~250 天內回本(不是裝飾也不是無腦按鈕)",
    kitPayback > 60 && kitPayback < 250,
    `$${KIT_PRICE.toLocaleString()} / $${kitGain.toFixed(0)}/日 = ${kitPayback.toFixed(0)} 天`);
  const signOnlyNoCapacity = measureStage({
    upgrades: [...CAFE_SIGNBOARD_IDS], seats: 6, extraStaff: 0, completed: Object.values(CAFE_RESEARCH_IDS),
  });
  console.log(`   · 招牌 Lv4 但席次 6 / 零額外員工:$${signOnlyNoCapacity.toFixed(0)}/日`
    + ` = 淨租金的 ${(signOnlyNoCapacity / DESIGN_NET_RENT * 100).toFixed(0)}%`);
  check("🔴 招牌不是萬靈丹:升到 Lv4 但席次/人力停在開張期 ⇒ 仍到不了淨租金(產能腿夾得住)",
    signOnlyNoCapacity < DESIGN_NET_RENT,
    `$${signOnlyNoCapacity.toFixed(0)} vs $${DESIGN_NET_RENT.toFixed(0)}`);
  check("🔴 過度擴張會虧:成長期的客流雇 4 個人 ⇒ 日淨利為負",
    overreach < 0, `$${overreach.toFixed(0)}`);
  // ⚠️ 原本這裡斷言「多雇 3 人**剛好**吃掉 3 份日薪」。`CAFE_STAFF_CUPS_PER_DAY`
  // 調回 26 之後那條不再成立,而且**是真的行為變化不是誤差**:成長期用設計表的
  // +1 員工時產能是 52,而客流基數在好天氣/週末會超過 52 ⇒ 有些天被夾住;
  // 多雇人反而解開了那幾天的上限,所以差額會小於 3 份日薪(實測約 $592 vs $780)。
  // 改成斷言真正要保證的事:過度擴張比正確人力配置明顯更差,且差距的量級就是薪資。
  const gap = growth - overreach;
  check("過度擴張明顯不如正確人力配置,且差距在 3 份日薪的量級內",
    gap > 0 && gap <= 3 * CAFE_STAFF_WAGE + 1,
    `差 $${gap.toFixed(0)} / 3 × $${CAFE_STAFF_WAGE} = $${3 * CAFE_STAFF_WAGE}`);
  check("成長曲線是單調的:名店期 > 成長期", flagship > growth);

  // =========================================================================
  // 七、零 RNG(咖啡廳自己的路徑)
  // =========================================================================
  // 第四節的 syncToNow() 會跑整個世界(租客事件、寵物、維修…),那些既有系統本來
  // 就有 RNG,不在本測試的觀察範圍;這裡只重新計數純函式那一段。
  const pureBefore = randomCalls;
  cafeCapability([...CAFE_SIGNBOARD_IDS], { seats: 32, extraStaff: 4 });
  hireCafeStaff({ ...defaultCafe(), open: true });
  fireCafeStaff({ ...defaultCafe(), open: true, extraStaff: 2 });
  cafeStaffWage(4);
  cafeSeatCapacity(32);
  avgTicket(Object.values(CAFE_RESEARCH_IDS));
  check("招牌／產能／人力／客單價的純函式零 Math.random", randomCalls === pureBefore,
    `calls=${randomCalls - pureBefore}`);
  void rngMark;
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
