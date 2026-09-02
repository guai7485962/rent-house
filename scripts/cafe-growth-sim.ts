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
 * 🔴 **2026-08-25 重量測批次**:2026-08-16 的「地板分區機能」上線後,產能多了一條腿
 * ——`cafeServiceStations()`(吧台服務位)。本腳本原本只擺開張贈品那一座吧台
 * ⇒ 服務位固定 3 ⇒ 中後期雇的人**站不上吧台、薪水照付**。原本的表格因為
 * `cafeCapability()` 沒餵 `stations`,印出來的產能欄還是「店員數 × 杯數」,
 * 與模擬迴圈(`tick.ts` 有餵 `stations`)實際夾的產能不一致 ⇒ 表格系統性高估。
 *
 * 同一批次還量出**第二個過期變因**:後場儲物。`cafeStorageCapacity()` 也是分區批次
 * 才有的東西,本腳本後場什麼都不擺 ⇒ 庫存上限固定 360 單位,而名店期的常備量約 900
 * ⇒ 進貨天天被夾住、顧客天天撲空。這同樣不是平衡問題,是**腳本的擺設過期了**。
 *
 * 這一版做四件事:
 * 1. 產能欄改餵 `stations`,與 `cafeHourlyPass()` 用同一個數字 ⇒ 表格不再說謊;
 * 2. 每個階段跑**三組**:【A】現行擺放(服務位 3 / 庫存 360)、【B】只補吧台
 *    (`服務位 >= 店員數`,單一變因)、【C】再補後場儲物(庫存上限 920);
 * 3. 表格加印「沒接到(`turnedAway`,做不出來)」與「庫存上限/常備量」兩欄,
 *    把「想上門 vs 做得出來 vs 進得完」三件事拆開;
 * 4. 名店期補一段**天花板分解**:離設計目標的缺口各由客流/客單價/成本結構佔多少。
 *
 * 🔴 **2026-08-28 基準對帳批次**(只動本腳本與文件,`src/` 一行未動):
 *
 * 1. **客單價階梯重訂**。設計表 §4.7 的 $36/$41/$47/$53 與 `avgTicket()` 是**同一個量**
 *    ——**未加權**的菜單標價平均(給玩家看的顯示值);但營收是逐位顧客照 `baseWeight`
 *    50/30/20 **加權**賣出的。拿前者訂目標、拿後者對帳,從第一天起就是蘋果對橘子。
 *    本腳本新增「客單價階梯」與「天花板掃描」兩段,把兩個量並排印出來。
 * 2. **階段目標重算**。新目標 = 設計客流 × **可達加權**客單價 × (1 − 原料率) − 固定 − 薪資。
 *    `Stage.oldTarget` 保留原設計值,表格兩欄並印 ⇒ 球門調整看得見。
 * 3. **基準納入設備**(【E】)。原本四階段的 `upgrades` **只有招牌、零設備**,
 *    低估了真實體驗。新增【E】表,依**回本天數**逐階段納入設備(證據見「設備逐項回本」段)。
 *    🔴【A】【B】【C】、`⚠️ 過度擴張` 與 `LEGACY_STAGES` **一格未動**——
 *    它們是既有對照組(設計配置、第五條虧損管道、第三層單一變因),動了就對不回去。
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
  cafeCapability, cafeStaffCount, cafeStaffWage, menuItems, avgTicket,
  suggestedStandingOrders, suggestStandingOrdersFromSales,
  applySpoilage, cafeStorageCapacity,
  CAFE_FIXED_COST, CAFE_MAX_AVG_TICKET, CAFE_UPGRADES, CAFE_UPGRADE_IDS, CAFE_RESEARCH_IDS,
} = await import("../src/sim/cafe");
const { CAFE_RESEARCH } = await import("../src/content/cafeResearch");
const {
  placements, addPlacement, placeCafeStarterSet, cafeSeatSpots, cafeAmbiancePoints,
  cafeServiceStations, cafeBackStoragePoints,
} = await import("../src/sim/placements");
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

/**
 * 吧台區(`cafe_counter` = c2..6 / r38..40)裡,開張贈品那座之外**還放得下**的吧台座標。
 * 每座 `cafe_counter` 是 2×1、與既有那塊相連 ⇒ 每多一座 `cafeServiceStations()` +2
 * (實測:3 → 5 → 7 → 9 → 11 → 13)。順序固定 ⇒ 量測是決定性的。
 */
const EXTRA_COUNTER_SPOTS: readonly [number, number][] = [[5, 38], [2, 39], [4, 39], [2, 40], [4, 40]];

/** 要讓 `服務位 >= staffCount`,得再買幾座吧台。服務位 = 1 + 吧台寬 + tech/3,每座 +2。 */
function countersNeededFor(staffCount: number): number {
  return Math.max(0, Math.min(EXTRA_COUNTER_SPOTS.length, Math.ceil((staffCount - 3) / 2)));
}

/**
 * 後場(`cafe_back` = c1..14 / r48..50)的標準儲物解,照 `CAFE_STORAGE_PER_POINT`
 * 註解寫的那一組:備品貨架 ×2(storage 6 ×2)+ 進貨木箱 ×1(storage 2)= 14 點
 * ⇒ `cafeStorageCapacity` = 360 + 14×40 = **920 單位**,$13,600。
 *
 * 為什麼要有這一組:後場儲物與吧台一樣是 2026-08-16 分區批次才有的東西,
 * 本腳本原本什麼都不擺 ⇒ 庫存上限固定 360,中後期的常備量根本進不完。
 */
const BACK_STORAGE_KIT: readonly { defId: string; c: number; r: number }[] = [
  { defId: "cafe_stock_shelf", c: 1, r: 48 },
  { defId: "cafe_stock_shelf", c: 3, r: 48 },
  { defId: "cafe_crate", c: 5, r: 48 },
];

/**
 * 把內用席次調整到 `target` 張:先擺開張贈品,再補 `extraCounters` 座吧台,最後補/拆椅子。
 *
 * 吧台**必須先於椅子**擺:`setSeats()` 的補椅子迴圈掃的是一樓四區(含 `cafe_counter`),
 * 先補椅子的話吧台格會被佔走 ⇒ 兩組對照的席次會不一樣、變因就不乾淨了。
 */
function setSeats(target: number, extraCounters = 0, backStorage = false) {
  placements.list.splice(0, placements.list.length);
  placeCafeStarterSet();
  for (const [c, r] of EXTRA_COUNTER_SPOTS.slice(0, extraCounters)) {
    addPlacement({ defId: "cafe_counter", room: "cafe_counter", c, r, rotation: 0 });
  }
  if (backStorage) {
    for (const item of BACK_STORAGE_KIT) {
      addPlacement({ defId: item.defId, room: "cafe_back", c: item.c, r: item.r, rotation: 0 });
    }
  }
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
/**
 * 🔴 2026-08-25(第三層研發上線)重訂階段的研發進度。
 *
 * 舊清單是 3 / 6 / 10 項,那是「第三層還不存在」時代的手挑組合。第三層的
 * `requiresUpgrades` 是**招牌等級**,所以每個階段解得開的東西不再是選擇題:
 *
 * - 成長期(招牌 Lv2)= 三個根 + 手沖單品 + 季節限定豆 = **5 項**
 * - 成熟期(招牌 Lv3)= 再加 拿鐵拉花 + 造型拿鐵 + 司康 = **8 項**
 * - 名店期(招牌 Lv4)= 全部 **13 項**
 *
 * 這不是搬球門:內容是招牌閘門的唯一解,不是挑的。舊的 3 / 6 兩列仍然照印
 * (`LEGACY_STAGES`),讓 diff 看得出「多少是調價、多少是第三層」。
 */
const GROWTH = [...ROOTS, CAFE_RESEARCH_IDS.pourOver, CAFE_RESEARCH_IDS.seasonalBean];
const MATURE = [...GROWTH, CAFE_RESEARCH_IDS.latteArt, CAFE_RESEARCH_IDS.pawLatte, CAFE_RESEARCH_IDS.scone];
const ALL = Object.values(CAFE_RESEARCH_IDS);
/** 舊階段清單(3 / 6 項),只當對照組印出來,不是設計目標。 */
const LEGACY_SIX = [...ROOTS, CAFE_RESEARCH_IDS.pourOver, CAFE_RESEARCH_IDS.scone, CAFE_RESEARCH_IDS.petTreat];

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
  /**
   * 設計文件 §4.7 的目標日淨利;`null` = 設計表沒有這一列(本腳本補的對照組)。
   *
   * 🔴 **2026-08-28 起這裡放的是「修正後」的目標**(推導見下方「階段目標重算」段):
   * 原設計值的客單價欄是**未加權**的量,而淨利是加權算的 ⇒ 目標本身就不可達。
   */
  target: number | null;
  /** 原設計值(2026-08-04 §4.7 那張表),只當對照印出來,**不要拿來當門檻**。 */
  oldTarget: number | null;
}

/**
 * 🔴 **2026-08-28 重訂 `target`**。舊值 98 / 430 / 900 / 1620 的客單價欄
 * ($36/$41/$47/$53)是未加權平均,而淨利是 `baseWeight` 加權算的 ⇒ $47 / $53
 * **任何前置合法的研發組合都做不到**(掃描結果見下方「客單價天花板掃描」)。
 * 新值 = 設計客流 × 該階段**可達加權**客單價 × (1 − 實測原料率) − 固定 − 薪資,
 * **客流欄一格未動**(實測 24.5 / 49.4 / 74.8 / 118.3 vs 設計 26 / 48 / 75 / 110)。
 *
 * ⚠️ 目標下修**不代表玩家收入變多**:本批一個遊戲數值都沒動。
 */
const STAGES: Stage[] = [
  { label: "開張期 Lv1", upgrades: [], seats: 6, extraStaff: 0, completed: [], target: 124, oldTarget: 98 },
  { label: "成長期 Lv2", upgrades: SIGN_LV2, seats: 12, extraStaff: 1, completed: GROWTH, target: 398, oldTarget: 430 },
  { label: "成熟期 Lv3", upgrades: SIGN_LV3, seats: 20, extraStaff: 2, completed: MATURE, target: 765, oldTarget: 900 },
  { label: "名店期 Lv4", upgrades: SIGN_LV4, seats: 32, extraStaff: 4, completed: ALL, target: 1051, oldTarget: 1620 },
  // 🔴 第五條虧損管道:成長期的客流,卻雇了 4 個人。**這一列刻意不重訂目標也不加設備**:
  // 它是「同客流卻多雇 3 人」的單一變因診斷,動了就與成長期那一列對不起來。
  { label: "⚠️ 過度擴張", upgrades: SIGN_LV2, seats: 12, extraStaff: 4, completed: ROOTS, target: -426, oldTarget: -426 },
  // 以下兩列設計表沒有,是 P4a 補的診斷:設計表的 +4 人其實**多雇了一個**
  // (Lv4 的實際客流撐不到 5 人份產能),而名店期玩家也不會只買招牌。
  { label: "· 名店期 +3 人", upgrades: SIGN_LV4, seats: 32, extraStaff: 3, completed: ALL, target: null, oldTarget: null },
  { label: "· 名店期全設備", upgrades: [...SIGN_LV4, ...FULL_KIT], seats: 32, extraStaff: 3, completed: ALL, target: null, oldTarget: null },
];

/**
 * 🔴 舊階段清單的對照組(3 / 6 項研發)。條件與上面的成長/成熟期**完全相同**,
 * 只有 `completed` 不一樣 ⇒ 兩兩相減就是「第三層值多少」,不會混進別的變因。
 *
 * 🔴 2026-08-28:這兩列的**設定與目標值都刻意不動**(擺設、人力、招牌、`target` 全部照舊)。
 * 它們屬於「第三層上線前」那個年代,拿當年的設計值當標尺才對得起來;
 * 而且上面四階段一旦加了設備,這裡也加就不再是單一變因了。
 */
const LEGACY_STAGES: Stage[] = [
  { label: "舊·成長期 3 研發", upgrades: SIGN_LV2, seats: 12, extraStaff: 1, completed: ROOTS, target: 430, oldTarget: 430 },
  { label: "舊·成熟期 6 研發", upgrades: SIGN_LV3, seats: 20, extraStaff: 2, completed: LEGACY_SIX, target: 900, oldTarget: 900 },
];

/**
 * 🔴 2026-09-02:常備量倍率(`1` = 照建議量,完全等同舊行為)。
 *
 * 大型冷藏是**保險**,而保險的價值只有在「出險」時看得到 —— 照建議量備貨的人
 * 一天壞不到一單位,它的日邊際結構上就趨近 0(不是沒接上)。要量它,唯一誠實的
 * 情境是「玩家自己備太多」,所以這裡開一個倍率旋鈕把那個情境跑出來。
 */
const scaleOrders = (orders: Record<string, number>, mult: number) => (mult === 1
  ? orders
  : Object.fromEntries(Object.entries(orders).map(([id, n]) => [id, Math.max(0, Math.round(n * mult))])));

function run(stage: Stage, extraCounters = 0, backStorage = false, stockMult = 1) {
  const seats = setSeats(stage.seats, extraCounters, backStorage);
  const stations = cafeServiceStations();
  const storage = cafeStorageCapacity(cafeBackStoragePoints());
  state.money = 50_000_000; // 只量營運損益,不讓現金不足夾住 addMoney
  state.ledger.splice(0, state.ledger.length);
  Object.assign(state.cafe, defaultCafe(), {
    open: true,
    standingOrders: scaleOrders(suggestedStandingOrders(), stockMult),
    stock: scaleOrders(suggestedStandingOrders(), stockMult),
    upgrades: stage.upgrades,
    completed: stage.completed,
    extraStaff: stage.extraStaff,
    popularity: 0,
  });

  let revenue = 0;
  let guests = 0;
  let refused = 0;
  let turnedAway = 0;
  let restock = 0;
  let net = 0;
  let capped = 0;
  let spoiledUnits = 0;
  let spoiledValue = 0;

  for (let day = 0; day < WARMUP + DAYS; day++) {
    const measuring = day >= WARMUP;
    if (day % RESUGGEST_EVERY === 0) {
      state.cafe.standingOrders = scaleOrders(suggestStandingOrdersFromSales(
        state.cafe.sales, menuItems(state.cafe.completed),
      ).orders, stockMult);
    }
    const before = state.money;
    state.gameMs = GAME_START.getTime() + day * DAY_MS + (CAFE_OPEN_HOUR - 1) * HOUR_MS;
    cafeRestockPass(CAFE_OPEN_HOUR - 1);
    for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
      state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
      cafeHourlyPass(hour);
    }
    const sale = state.cafe.sales[state.cafe.sales.length - 1];
    // 損耗要在 `cafeDailyPass()` **之前**算:它是純函式、不動狀態,但 pass 會把
    // 壞掉的庫存扣走 ⇒ 事後再算就只剩下沒壞的那些。金額不進金流(進貨時就付過了),
    // 這裡量的是「已付的錢裡有多少被丟掉」。
    const rot = applySpoilage(state.cafe.stock, cafeCapability(state.cafe.upgrades).spoilage);
    state.gameMs = GAME_START.getTime() + day * DAY_MS;
    cafeDailyPass();
    const record = state.cafe.history[state.cafe.history.length - 1];
    if (!measuring) continue;
    revenue += record.revenue;
    guests += record.guests;
    refused += sale?.refused ?? 0;
    turnedAway += sale?.turnedAway ?? 0;
    restock += sale?.restockCost ?? 0;
    spoiledUnits += rot.totalSpoiled;
    spoiledValue += rot.lines.reduce((sum, line) => sum + line.wastedValue, 0);
    net += state.money - before;
    const cap = cafeCapability(state.cafe.upgrades, { seats, stations, extraStaff: state.cafe.extraStaff });
    if (record.guests >= cap.capacity) capped++;
  }

  const per = (n: number) => n / DAYS;
  // 🔴 `stations` 一定要餵:`cafeHourlyPass()` 餵了,不餵的話這張表印的是
  // 「所有店員都上得了工」的假產能,與迴圈裡真的夾住客流的數字對不起來。
  const cap = cafeCapability(state.cafe.upgrades, { seats, stations, extraStaff: state.cafe.extraStaff });
  return {
    stage,
    seats,
    extraCounters,
    backStorage,
    stations,
    storage,
    standingUnits: Object.values(state.cafe.standingOrders).reduce((sum, n) => sum + n, 0),
    staffCount: cap.staffCount,
    activeStaff: cap.activeStaff,
    idleStaff: cap.idleStaff,
    ambiance: cafeAmbiancePoints(),
    capacity: cap.capacity,
    seatCapacity: cap.seatCapacity ?? 0,
    staffCapacity: cap.staffCapacity,
    wage: cafeStaffWage(state.cafe.extraStaff),
    guests: per(guests),
    refused: per(refused),
    turnedAway: per(turnedAway),
    revenue: per(revenue),
    restock: per(restock),
    spoiledUnits: per(spoiledUnits),
    spoiledValue: per(spoiledValue),
    net: per(net),
    ticket: guests > 0 ? revenue / guests : 0,
    cappedDays: capped,
    popularity: state.cafe.popularity,
  };
}

type Row = ReturnType<typeof run>;

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

// ---------------------------------------------------------------------------
// 🔴 客單價:兩個量,不是一個量(2026-08-28)
//
// 設計表 §4.7 的客單價欄與 `avgTicket()` 都是**未加權**的菜單標價平均 —— 那是
// 面板上給玩家看的顯示值。但營收是逐位顧客照 `baseWeight`(50/30/20 打底)加權
// 賣出的 ⇒ 真正決定淨利的是**加權**平均。兩個數字都對,只是不同量;
// 拿未加權訂目標、拿加權對帳,從第一天起就是蘋果對橘子。
// ---------------------------------------------------------------------------

/** 依 `baseWeight` 加權的菜單均價 —— 錢是照這個量賺的。 */
function weightedTicket(completed: readonly string[]): number {
  const menu = menuItems(completed);
  const weight = menu.reduce((sum, item) => sum + item.baseWeight, 0);
  if (weight <= 0) return 0;
  return menu.reduce((sum, item) => sum + item.price * item.baseWeight, 0) / weight;
}
/** 未加權(= `avgTicket()` 夾值前的原始平均),給玩家看的那個量。 */
function plainTicket(completed: readonly string[]): number {
  const menu = menuItems(completed);
  return menu.length === 0 ? 0 : menu.reduce((sum, item) => sum + item.price, 0) / menu.length;
}

const TICKET_LADDER: { label: string; completed: string[]; design: number }[] = [
  { label: "開張期 Lv1", completed: [], design: 36 },
  { label: "成長期 Lv2", completed: GROWTH, design: 41 },
  { label: "成熟期 Lv3", completed: MATURE, design: 47 },
  { label: "名店期 Lv4", completed: ALL, design: 53 },
];

console.log("=== 客單價階梯:未加權(畫面顯示)vs 加權(拿來算錢)===");
console.log("階段".padEnd(14) + "品數  原設計值  未加權  avgTicket()   加權  加權 vs 原設計值");
for (const row of TICKET_LADDER) {
  const weighted = weightedTicket(row.completed);
  console.log(
    row.label.padEnd(12)
    + `${String(menuItems(row.completed).length).padStart(4)}`
    + `${("$" + row.design).padStart(10)}`
    + `${("$" + plainTicket(row.completed).toFixed(2)).padStart(8)}`
    + `${("$" + avgTicket(row.completed)).padStart(13)}`
    + `${("$" + weighted.toFixed(2)).padStart(7)}`
    + `${((weighted / row.design - 1) * 100).toFixed(1).padStart(12)}%`,
  );
}

// 天花板掃描:16 品的所有 completed 子集,但**只算前置合法的那些**。
// 設計文件 §10.6 第 2 條寫的「8,192 組合最高 $49」把前置不合法的組合也算進去了
// (那個最大值是「只研發三項第三層、其它一項都不做」,而三項第三層各自都有研發前置)。
const RESEARCH_REQ = new Map<string, readonly string[]>(
  CAFE_RESEARCH.map((research) => [research.id, research.requiresResearch]),
);
let bestPlain = { value: -1, set: [] as string[] };
let bestWeighted = { value: -1, set: [] as string[] };
let legalSets = 0;
for (let mask = 0; mask < (1 << ALL.length); mask++) {
  const set = ALL.filter((_, index) => (mask & (1 << index)) !== 0);
  const owned = new Set(set);
  if (!set.every((id) => (RESEARCH_REQ.get(id) ?? []).every((need) => owned.has(need)))) continue;
  legalSets++;
  const plain = plainTicket(set);
  const weighted = weightedTicket(set);
  if (plain > bestPlain.value) bestPlain = { value: plain, set };
  if (weighted > bestWeighted.value) bestWeighted = { value: weighted, set };
}
console.log(`\n=== 客單價天花板掃描(${1 << ALL.length} 種 completed 子集,其中前置合法 ${legalSets} 種)===`);
console.log(`  可達**未加權**最大 $${bestPlain.value.toFixed(2)}(${bestPlain.set.length} 項研發)`
  + ` ⇒ 設計表的成熟期 $47 / 名店期 $53 **任何合法組合都到不了**`);
console.log(`  可達**加權**最大   $${bestWeighted.value.toFixed(2)}(${bestWeighted.set.length} 項研發;`
  + `全 13 項解鎖反而只有 $${weightedTicket(ALL).toFixed(2)} —— 寵物線與低價第二層把加權均價稀釋掉)`);
console.log(`  夾值 CAFE_MAX_AVG_TICKET = $${CAFE_MAX_AVG_TICKET} 仍然沒有生效,繼續只當「誤加 $200 品項」的防呆`);

// ---------------------------------------------------------------------------
// 階段目標重算:設計客流 × 可達加權客單價 × (1 − 原料率) − 固定 − 薪資
//
// 🔴 三個輸入的來源必須寫清楚,讀者要能自己複算:
//   - 設計客流:§4.7 原表,**一格未動**(實測本來就精準命中,不是缺口所在)
//   - 可達加權客單價:上面那張階梯表的「加權」欄(該階段招牌閘門唯一解得開的研發集合)
//   - 原料率:【C】(吧台 + 後場儲物)那一組的實測 `進貨 / 營收`
// ---------------------------------------------------------------------------

const TARGET_INPUTS = [
  { label: "開張期 Lv1", guests: 26, ticket: 35.4, materialRate: 0.463, wage: 0 },
  { label: "成長期 Lv2", guests: 48, ticket: 39.9, materialRate: 0.463, wage: 260 },
  { label: "成熟期 Lv3", guests: 75, ticket: 41.4, materialRate: 0.467, wage: 520 },
  { label: "名店期 Lv4", guests: 110, ticket: 42.3, materialRate: 0.471, wage: 1040 },
];

console.log("\n=== 階段目標重算(設計客流 × 可達加權客單價 × (1 − 原料率) − 固定 − 薪資)===");
console.log("階段".padEnd(14) + "設計客流  加權客單價   日營收   原料率  固定+薪資   修正目標  原設計值   差");
for (const [index, input] of TARGET_INPUTS.entries()) {
  const revenue = input.guests * input.ticket;
  const cost = CAFE_FIXED_COST + input.wage;
  const net = revenue * (1 - input.materialRate) - cost;
  const old = STAGES[index].oldTarget ?? 0;
  console.log(
    input.label.padEnd(12)
    + `${String(input.guests).padStart(8)}`
    + `${("$" + input.ticket.toFixed(1)).padStart(11)}`
    + `${("$" + revenue.toFixed(0)).padStart(9)}`
    + `${((input.materialRate * 100).toFixed(1) + "%").padStart(9)}`
    + `${("−$" + cost).padStart(11)}`
    + `${("+$" + net.toFixed(0)).padStart(11)}`
    + `${("+$" + old).padStart(10)}`
    + `${((net - old >= 0 ? "+$" : "−$") + Math.abs(net - old).toFixed(0)).padStart(8)}`,
  );
}
console.log("⚠️ 目標下修**不代表玩家收入變多** —— 本批一個遊戲數值都沒動,");
console.log("   變的只是「拿什麼跟什麼比」。原本的客單價欄量的是畫面顯示值,不是拿來算錢的那個量。");
console.log("   (原料率是四捨五入到 0.1% 的輸入值;與【C】實測 進貨/營收 的對照印在【C】表之後)");

const HEADER = "階段".padEnd(14)
  + "席次 吧台 服務位/店員/上工 產能(席/員) 庫存上限/常備  日客流 沒接到  撲空 客單價    營收     進貨     薪資     固定"
  + "   實測淨利  佔設計靶 佔種子局 修正目標 原設計值";

function printTable(title: string, note: string, rows: Row[]) {
  console.log(`\n【${title}】${note}`);
  console.log(HEADER);
  for (const r of rows) {
    console.log(
      r.stage.label.padEnd(12)
      + `${String(r.seats).padStart(4)}`
      + `${String(1 + r.extraCounters).padStart(5)}`
      + `${(`${r.stations}/${r.staffCount}/${r.activeStaff}`).padStart(17)}`
      + `${(`${r.capacity}(${r.seatCapacity}/${r.staffCapacity})`).padStart(13)}`
      + `${(`${r.storage}/${r.standingUnits}`).padStart(14)}`
      + `${r.guests.toFixed(1).padStart(8)}`
      + `${r.turnedAway.toFixed(1).padStart(7)}`
      + `${r.refused.toFixed(1).padStart(6)}`
      + `${("$" + r.ticket.toFixed(1)).padStart(8)}`
      + `${("$" + r.revenue.toFixed(0)).padStart(9)}`
      + `${("−$" + r.restock.toFixed(0)).padStart(9)}`
      + `${("−$" + r.wage).padStart(9)}`
      + `${("−$" + CAFE_FIXED_COST).padStart(9)}`
      + `${((r.net >= 0 ? "+$" : "−$") + Math.abs(r.net).toFixed(0)).padStart(10)}`
      + `${((r.net / DESIGN_NET_RENT * 100).toFixed(0) + "%").padStart(9)}`
      + `${((r.net / seedNetRent * 100).toFixed(0) + "%").padStart(9)}`
      + `${money(r.stage.target).padStart(9)}`
      + `${money(r.stage.oldTarget).padStart(9)}`,
    );
  }
}

/** `null` = 設計表沒有這一列。 */
function money(n: number | null): string {
  return n === null ? "—" : (n >= 0 ? "+$" : "−$") + Math.abs(n);
}

// 【A】現行擺放:只有開張贈品那座吧台 ⇒ 服務位 3;後場空的 ⇒ 庫存上限 360(分區機能上線前的設定)
const current = STAGES.map((stage) => run(stage));
// 【B】只補吧台:買到「服務位 >= 店員數」,席次/招牌/研發/員工數完全不變(單一變因)
const staffed = STAGES.map((stage) => run(stage, countersNeededFor(cafeStaffCount(stage.extraStaff))));
// 【C】再補後場儲物:庫存上限 360 → 920,常備量才進得完
const stocked = STAGES.map((stage) => run(stage, countersNeededFor(cafeStaffCount(stage.extraStaff)), true));

printTable("A", "現行擺放:只有開張贈品那座吧台(服務位 3)、後場空的(庫存上限 360)——分區機能上線前的腳本設定", current);
printTable("B", "只補吧台:買到「服務位 >= 店員數」,其餘條件完全相同(每座吧台 $16,000)", staffed);
printTable("C", "吧台 + 後場儲物:再加備品貨架 ×2 + 進貨木箱 ×1(storage 14 ⇒ 庫存上限 920,$13,600)", stocked);

// 階段目標重算用的原料率是從這裡取的:對照一下四捨五入前後差多少(差 < $3/日)。
console.log("原料率對照(階段目標重算的輸入 vs【C】實測 進貨/營收):"
  + TARGET_INPUTS.map((input, index) => `${input.label.slice(0, 3)} ${(input.materialRate * 100).toFixed(1)}%`
    + ` vs ${(stocked[index].restock / stocked[index].revenue * 100).toFixed(2)}%`).join(";"));

// 🔴 舊階段清單(3 / 6 項研發)的對照:與【C】完全相同的擺設,只有 completed 不同。
const legacy = LEGACY_STAGES.map((stage) =>
  run(stage, countersNeededFor(cafeStaffCount(stage.extraStaff)), true));
printTable("C-舊", "對照組:【C】的擺設不變,研發進度改回第三層上線前的 3 / 6 項(差額 = 第三層值多少)", legacy);
console.log("\n【C vs C-舊】第三層在中段值多少(同席次/同人力/同招牌,只差研發進度)");
for (const [i, row] of legacy.entries()) {
  const now = stocked[i + 1];
  console.log(`  ${row.stage.label.padEnd(16)} $${row.net.toFixed(0)}(${(row.net / DESIGN_NET_RENT * 100).toFixed(0)}%)`
    + ` → ${now.stage.label}(${now.stage.completed.length} 研發) $${now.net.toFixed(0)}`
    + `(${(now.net / DESIGN_NET_RENT * 100).toFixed(0)}%)`
    + `  Δ +$${(now.net - row.net).toFixed(0)}`
    + `;客單價 $${row.ticket.toFixed(1)} → $${now.ticket.toFixed(1)}`);
}

console.log("\n【D】對照(**修正後**目標 / 現行實測:服務位不足 / 只補吧台 / 吧台+後場儲物)");
console.log("階段".padEnd(14) + "  修正目標    現行實測(佔靶)      只補吧台(佔靶)    吧台+後場(佔靶)  吧台差 只補吧台Δ  加後場Δ");
for (let i = 0; i < 4; i++) {
  const a = current[i];
  const b = staffed[i];
  const c = stocked[i];
  const target = a.stage.target ?? 0;
  const cell = (row: Row) => ((row.net >= 0 ? "+$" : "−$") + Math.abs(row.net).toFixed(0))
    + `(${(row.net / target * 100).toFixed(0)}%)`;
  const delta = (n: number) => (n >= 0 ? "+$" : "−$") + Math.abs(n).toFixed(0);
  console.log(
    a.stage.label.padEnd(12)
    + `${("+$" + target).padStart(10)}`
    + `${cell(a).padStart(19)}`
    + `${cell(b).padStart(20)}`
    + `${cell(c).padStart(19)}`
    + `${(`+${b.extraCounters - a.extraCounters} 座`).padStart(8)}`
    + `${delta(b.net - a.net).padStart(10)}`
    + `${delta(c.net - b.net).padStart(10)}`,
  );
}

// ---------------------------------------------------------------------------
// 🔴 設備逐項回本(2026-08-28):基準要不要納入設備,由**回本天數**決定
//
// §10.5 剛立的設計帶是 60~250 天。某件設備在該階段回本超過 250 天 ⇒ 不該算進
// 「正常玩家會有的擺設」;低於 60 天則是「無腦按鈕」,值得記一筆但不排除。
// 單一變因:【C】(吧台 + 後場儲物)為底,只多加那一件設備。
// ---------------------------------------------------------------------------

const EQUIPMENT_KIT = [
  CAFE_UPGRADE_IDS.secondMachine, CAFE_UPGRADE_IDS.outdoorSeats,
  CAFE_UPGRADE_IDS.coldStorage, CAFE_UPGRADE_IDS.petTower,
];
const upgradeById = new Map(CAFE_UPGRADES.map((item) => [item.id, item]));

console.log("\n=== 設備逐項回本(【C】為底;單一變因:只加那一件)===");
console.log("階段".padEnd(14) + "設備".padEnd(14) + "  售價     底淨利   加了之後   日邊際    回本天數  客流變化");
for (let i = 0; i < 4; i++) {
  const stage = STAGES[i];
  const counters = countersNeededFor(cafeStaffCount(stage.extraStaff));
  const base = stocked[i];
  for (const id of EQUIPMENT_KIT) {
    const def = upgradeById.get(id)!;
    const withIt = run({ ...stage, upgrades: [...stage.upgrades, id] }, counters, true);
    const marginal = withIt.net - base.net;
    const payback = marginal > 0 ? def.price / marginal : Infinity;
    console.log(
      stage.label.padEnd(12) + def.name.padEnd(12)
      + `${("$" + def.price.toLocaleString()).padStart(9)}`
      + `${("+$" + base.net.toFixed(0)).padStart(10)}`
      + `${("+$" + withIt.net.toFixed(0)).padStart(11)}`
      + `${((marginal >= 0 ? "+$" : "−$") + Math.abs(marginal).toFixed(1)).padStart(10)}`
      + `${(Number.isFinite(payback) ? payback.toFixed(1) + " 天" : "永不回本").padStart(12)}`
      + `   ${base.guests.toFixed(1)} → ${withIt.guests.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 🔴 大型冷藏的**兩個情境**(2026-09-02):它的判準不是 §10.5 的 60~250 產能帶
//
// 上面那張表用的是「常備量照建議」——而那正是它看起來像廢物的原因,不是 bug:
// 損耗的天花板只有 $18.2/日(名店期),冷藏拿走的是那 100%($18.2 → $0.0)。
// 根因是 §4.3.1「懶人路線必須零損耗」把 `SPOILAGE_FREE_UNITS = 23` 釘死成唯一解
// ⇒ 照建議量備貨的人**本來就沒有損耗可以省**。
//
// 🔴 **純調價無解的證明**:它的價值方差是 $0 ~ 約 $100/日(數倍),而 §10.5 的
// 回本帶寬只有 250/60 = **4.17 倍** ⇒ **任何單一售價都不可能讓兩端同時落在帶內**。
// 所以判準改掉:大型冷藏用**「備貨過量情境」**判定(常備量 ×1.5),
// 而「玩得好的人回本很久」是**正確的** —— 保險沒出險就是白買。
// 兩個情境都印出來,免得日後有人只看到其中一欄就回頭調價。
// ---------------------------------------------------------------------------

const COLD_OVERSTOCK_MULT = 1.5;
const coldDef = upgradeById.get(CAFE_UPGRADE_IDS.coldStorage)!;
console.log(`\n=== 大型冷藏的兩個情境(它是保險 + 冷萃閘門,不是產能;售價 $${coldDef.price.toLocaleString()})===`);
console.log("階段".padEnd(14) + "情境".padEnd(22) + " 底淨利   加了之後   日邊際    回本天數  損耗(單位/日)");
for (let i = 0; i < 4; i++) {
  const stage = STAGES[i];
  const counters = countersNeededFor(cafeStaffCount(stage.extraStaff));
  for (const [label, mult] of [["常備量照建議", 1], ["常備量 ×1.5(備太多)", COLD_OVERSTOCK_MULT]] as const) {
    const base = run(stage, counters, true, mult);
    const withIt = run({ ...stage, upgrades: [...stage.upgrades, coldDef.id] }, counters, true, mult);
    const marginal = withIt.net - base.net;
    const payback = marginal > 0 ? coldDef.price / marginal : Infinity;
    console.log(
      stage.label.padEnd(12) + label.padEnd(20)
      + `${("+$" + base.net.toFixed(0)).padStart(9)}`
      + `${("+$" + withIt.net.toFixed(0)).padStart(11)}`
      + `${((marginal >= 0 ? "+$" : "−$") + Math.abs(marginal).toFixed(1)).padStart(10)}`
      + `${(Number.isFinite(payback) ? payback.toFixed(1) + " 天" : "永不回本").padStart(12)}`
      + `   ${base.spoiledUnits.toFixed(1)} → ${withIt.spoiledUnits.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 【E】把上面那張回本表的結論套回基準:各階段納入「回本天數說得過去」的設備。
//
// 🔴 結論(**2026-09-02 永久投資修正後**重量):
//   - 第二台咖啡機:開張 243.5 天 / 成長 96.6 天 / 成熟 50.3 天 / 名店 82.0 天(未動)
//   - 戶外座位($25,000):**不再是 0** —— 它現在自帶 `CAFE_OUTDOOR_CAPACITY = 10` 的
//     產能(加在 `min()` 外面,理由見 `cafe.ts` 該常數)⇒ 開張 252.8 / 成長 189.3 /
//     成熟 150.4 / 名店 217.3 天。修改前四個階段的日邊際都**精確是 $0**:它加的是
//     晴天「想上門」的人數,而四階段一路被員工腿夾住,多來的人一個都做不出來。
//   - 大型冷藏($8,000,原 $15,000):照建議量備貨時仍然近乎 0(成熟 10,667 天、
//     名店 439.6 天)—— 那是**正確的**,它是保險 + 冷萃閘門,判準改用「備貨過量情境」,
//     見上方那張兩情境表。**不納入【E】**。
//   - 貓跳台與軟墊:日邊際 0(它動的是寵物停留與認養詢問,不進金流)。
//     那也是對的,它換到的是真實內容;本批只補「送養了幾隻」的可見性,一個數值都沒動。
//
// 🔴 **前提修正二(2026-08-28 的舊表基準是壞的)**:`menuItems()`(`src/sim/cafe.ts`)
// 只看 `completed`,**完全不看 `requiresUpgrades`**。遊戲裡玩家點不開沒前置的研發
// (`startCafeResearch()` 有擋),但本腳本是直接把 `completed = ALL` 塞進 state ⇒
// 名店期那幾列**已經白拿了冷萃與寵物生日蛋糕的閘門價值**。所以上表量到的
// 「大型冷藏/貓跳台 = 0」少算了它們的閘門那一半,不能只當成防損耗/認養的數字讀。
//
// **開張期刻意不納入**:243.5 天雖然勉強在設計帶內,但那個階段玩家剛付完開店費、
// 拿不出 $18,000;而且開張期那一列同時是「備太多反而虧」的平衡錨(§4.7),
// 給它加產能會動到錨本身。⇒ 開張期維持零設備。
//
// `⚠️ 過度擴張` 不進本表(它是「同客流多雇 3 人」的單一變因診斷);
// `名店期全設備` 一格未動(它是「預設 vs 全設備」的對照組,§10.4 的代數論證靠它)。
// ---------------------------------------------------------------------------

const SECOND_MACHINE = CAFE_UPGRADE_IDS.secondMachine;
const EQUIPPED_STAGES: Stage[] = [
  { ...STAGES[0] },                                                          // 開張期:零設備(理由見上)
  { ...STAGES[1], upgrades: [...SIGN_LV2, SECOND_MACHINE] },
  { ...STAGES[2], upgrades: [...SIGN_LV3, SECOND_MACHINE] },
  { ...STAGES[3], upgrades: [...SIGN_LV4, SECOND_MACHINE] },
  { ...STAGES[5], upgrades: [...SIGN_LV4, SECOND_MACHINE] },
  { ...STAGES[6] },                                                          // 名店期全設備:一格未動
];

const equipped = EQUIPPED_STAGES.map((stage) =>
  run(stage, countersNeededFor(cafeStaffCount(stage.extraStaff)), true));
printTable("E", "🔴 **本批起的真實體驗基準**:【C】再加該階段回本天數過關的設備(= 第二台咖啡機 $18,000;開張期零設備)", equipped);
console.log("\n【E vs C】設備買下來的產能值多少(同席次/同人力/同招牌/同研發,只差設備)");
for (const [i, row] of equipped.entries()) {
  const baseIndex = i < 4 ? i : i + 1;
  const before = stocked[baseIndex];
  console.log(`  ${row.stage.label.padEnd(16)} $${before.net.toFixed(0)} → $${row.net.toFixed(0)}`
    + `  Δ ${(row.net - before.net >= 0 ? "+$" : "−$")}${Math.abs(row.net - before.net).toFixed(0)}`
    + `;客流 ${before.guests.toFixed(1)} → ${row.guests.toFixed(1)}`
    + `;沒接到 ${before.turnedAway.toFixed(1)} → ${row.turnedAway.toFixed(1)}`
    + `${row.stage.target === null ? "" : `;佔修正目標 ${(row.net / row.stage.target * 100).toFixed(0)}%`}`);
}
console.log("⚠️ 【E】高於修正目標的部分是**多花 $18,000 買來的產能**,而日淨利欄不含這筆資本支出。");
console.log("   基準換了 ≠ 咖啡廳賺得比較多:本批一個遊戲數值都沒動。");

// ---------------------------------------------------------------------------
// 🔴 第三層逐項回本:單一變因(只抽掉那一項研發,其餘完全相同)
//
// 設計約束是「在**它自己解得開的那一階段**要在 60 天內回本」。整包比較看不出
// 哪一項在拖後腿,所以這裡一項一項抽掉再量一次,差額就是那一項的日邊際。
// ---------------------------------------------------------------------------

const TIER3_CASES: { id: string; name: string; cost: number; stage: Stage; base: Row }[] = [
  { id: CAFE_RESEARCH_IDS.seasonalBean, name: "季節限定豆", cost: 3_000, stage: STAGES[1], base: stocked[1] },
  { id: CAFE_RESEARCH_IDS.pawLatte, name: "造型拿鐵", cost: 3_000, stage: STAGES[2], base: stocked[2] },
  { id: CAFE_RESEARCH_IDS.afternoonTea, name: "下午茶套餐", cost: 3_000, stage: STAGES[3], base: stocked[3] },
];

console.log("\n=== 第三層逐項回本(在它自己解得開的那一階段;單一變因:只抽掉那一項)===");
console.log("項目".padEnd(12) + "階段".padEnd(14) + "  研發費   有它的淨利   抽掉後   日邊際   回本天數  客單價變化");
for (const c of TIER3_CASES) {
  const without = run(
    { ...c.stage, completed: c.stage.completed.filter((id) => id !== c.id) },
    countersNeededFor(cafeStaffCount(c.stage.extraStaff)), true,
  );
  const delta = c.base.net - without.net;
  const payback = delta > 0 ? c.cost / delta : Infinity;
  console.log(
    c.name.padEnd(10)
    + c.stage.label.padEnd(12)
    + `${("$" + c.cost.toLocaleString()).padStart(8)}`
    + `${("+$" + c.base.net.toFixed(0)).padStart(13)}`
    + `${("+$" + without.net.toFixed(0)).padStart(10)}`
    + `${("+$" + delta.toFixed(1)).padStart(9)}`
    + `${(Number.isFinite(payback) ? payback.toFixed(1) + " 天" : "永遠不回本").padStart(11)}`
    + `   $${without.ticket.toFixed(1)} → $${c.base.ticket.toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------
// 名店期天花板分解:補足吧台之後,離設計目標 +$1,620 還差在哪
// ---------------------------------------------------------------------------

const flagship = stocked[3];
const overreach = stocked[4];
const tuned = stocked[5];
const kitted = stocked[6];
const target = flagship.stage.target ?? 0;
const designGuests = 110;   // 設計表的名店期日客流
const designTicket = 53;    // 設計表的名店期客單價

/** 只換一個變因、其它照實測比例推,看各自能補回多少。 */
const materialRate = flagship.restock / flagship.revenue;
const fixedAndWage = CAFE_FIXED_COST + flagship.wage;
const netAtGuests = (g: number, t: number) => g * t * (1 - materialRate) - fixedAndWage;

console.log(`\n=== 名店期天花板分解(以【C】吧台 + 後場儲物為基準:設計配置,不含設備)===`);
console.log(`修正目標 +$${target} / 原設計值 +$${flagship.stage.oldTarget}`
  + ` / 實測 ${(flagship.net >= 0 ? "+$" : "−$")}${Math.abs(flagship.net).toFixed(0)}`
  + ` ⇒ 對修正目標的缺口 $${(target - flagship.net).toFixed(0)}`
  + `、對原設計值的缺口 $${((flagship.stage.oldTarget ?? 0) - flagship.net).toFixed(0)}`);
console.log(`🔴 下面這段分解對的是**原設計值** +$${flagship.stage.oldTarget} 與它的客單價 $${designTicket},`
  + `目的是示範「$${designTicket} 這個數字不可達」,不是拿它當門檻。`);
console.log(`實測結構:客流 ${flagship.guests.toFixed(1)}(設計 ${designGuests})`
  + ` × 客單價 $${flagship.ticket.toFixed(1)}(設計 $${designTicket})`
  + ` = 營收 $${flagship.revenue.toFixed(0)};原料佔營收 ${(materialRate * 100).toFixed(1)}%`
  + `;固定+薪資 $${fixedAndWage};損耗 ${flagship.spoiledUnits.toFixed(1)} 單位/日($${flagship.spoiledValue.toFixed(0)})`);
const oldGap = (flagship.stage.oldTarget ?? 0) - flagship.net;
const gapGuests = netAtGuests(designGuests, flagship.ticket) - flagship.net;
const gapTicket = netAtGuests(flagship.guests, designTicket) - flagship.net;
const gapBoth = netAtGuests(designGuests, designTicket) - flagship.net;
console.log(`只把客流補到設計值 ${designGuests}:淨利 ${(flagship.net + gapGuests).toFixed(0)}`
  + ` ⇒ 補回 $${gapGuests.toFixed(0)}(舊缺口的 ${(gapGuests / oldGap * 100).toFixed(0)}%)`);
console.log(`只把客單價補到設計值 $${designTicket}:淨利 ${(flagship.net + gapTicket).toFixed(0)}`
  + ` ⇒ 補回 $${gapTicket.toFixed(0)}(舊缺口的 ${(gapTicket / oldGap * 100).toFixed(0)}%)`);
console.log(`兩者都補:淨利 ${(flagship.net + gapBoth).toFixed(0)}`
  + ` ⇒ 補回 $${gapBoth.toFixed(0)}(舊缺口的 ${(gapBoth / oldGap * 100).toFixed(0)}%)`
  + `;交互項 $${(gapBoth - gapGuests - gapTicket).toFixed(0)}`);
console.log(`殘差(成本結構:原料 ${(materialRate * 100).toFixed(1)}% + 固定 $${CAFE_FIXED_COST} + 薪資 $${flagship.wage})`
  + `:$${(oldGap - gapBoth).toFixed(0)}`);

// 客單價那條腿的天花板:菜單本身,而不是 `CAFE_MAX_AVG_TICKET` 的夾值
const fullMenu = menuItems(ALL);
const menuMean = fullMenu.reduce((sum, item) => sum + item.price, 0) / fullMenu.length;
console.log(`客單價天花板:全研發菜單 ${fullMenu.length} 品、未加權均價 $${menuMean.toFixed(2)}(= avgTicket 的量)`
  + `、加權均價 $${weightedTicket(ALL).toFixed(2)}(= 賺錢的量)、最高 $${Math.max(...fullMenu.map((i) => i.price))}`
  + `;實測 $${flagship.ticket.toFixed(1)}`);
console.log(`🔴 所以設計值 $${designTicket} 不可達:前置合法組合的**加權**上限只有 $${bestWeighted.value.toFixed(2)}`
  + `、**未加權**上限只有 $${bestPlain.value.toFixed(2)} —— 連畫面顯示值都到不了 $${designTicket}。`
  + `夾值 CAFE_MAX_AVG_TICKET = $${CAFE_MAX_AVG_TICKET} 從未生效。`);

console.log(`\n🔴 名店期 > 100% 淨租金(設計靶 $${DESIGN_NET_RENT.toFixed(0)}):`
  + `照設計表 +4 人 ${flagship.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${flagship.net.toFixed(0)});`
  + ` 人力最佳化 +3 人 ${tuned.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${tuned.net.toFixed(0)});`
  + ` 全設備 ${kitted.net > DESIGN_NET_RENT ? "成立" : "不成立"}($${kitted.net.toFixed(0)})`);
console.log(`🔴 過度擴張會虧:${overreach.net < 0 ? "成立" : "不成立"}`
  + `(實測 $${overreach.net.toFixed(0)};同客流同席次但只雇 1 人時是 +$${stocked[1].net.toFixed(0)}`
  + `,多雇 3 人吃掉 $${(stocked[1].net - overreach.net).toFixed(0)})`);
console.log("\n實測與設計值有出入是正常的;本腳本只量,不反過來調參數。");
