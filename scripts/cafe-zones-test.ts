/**
 * 🔴 A 批:**地板分區產生機能差異**(設計文件 `docs/咖啡廳經營玩法-重設計.md` §4.10)。
 *
 * 本檔釘死一條規則與它的四個出口:
 *
 * > **家具擺在對的區才有機能效果;擺錯區只剩氛圍(`cozy + style`)。**
 *
 * 1. **後場 `cafe_back`** → 庫存容量上限(`cafeStorageCapacity` × `restockPlan`)
 * 2. **寵物區 `cafe_pet`** → 寵物停留時間與認養／租屋詢問的出現率
 * 3. **吧台區 `cafe_counter`** → 同時服務人數(`cafeServiceStations` × `cafeCapability`)
 * 4. **界線** → `cafe.ts` 仍然不 import `placements`,所有幾何數字都是參數餵進去的
 *
 * 每一節都有一條**回歸釘子**:不帶新參數時的輸出必須與 A 批之前逐欄相同,
 * 否則既有存檔的行為會無聲改變。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const {
  CAFE_COUNTER_TECH_PER_STATION,
  addPlacement,
  cafeAmbiancePoints,
  cafeBackStoragePoints,
  cafeCounterSpan,
  cafeCounterTechPoints,
  cafePetComfortPoints,
  cafeServiceStations,
  cafeStaffSpots,
  placeCafeStarterSet,
  placements,
} = await import("../src/sim/placements");
const { CAFE_INTENT_BASE } = await import("../src/sim/cafeGuests");
const {
  CAFE_ADOPT_MAX_BONUS,
  CAFE_MAX_EXTRA_STAFF,
  CAFE_PET_TOWER_UPGRADE_COMFORT,
  CAFE_RENT_PER_SIGN,
  CAFE_STAFF_CUPS_PER_DAY,
  CAFE_STORAGE_BASE,
  CAFE_STORAGE_MAX,
  CAFE_STORAGE_PER_POINT,
  CAFE_UPGRADE_IDS,
  cafeCapability,
  cafeDailyLine,
  cafeIntentWeights,
  cafePetComfort,
  cafeServiceStaff,
  cafeStaffCount,
  cafeStorageCapacity,
  restockPlan,
  suggestedStandingOrders,
} = await import("../src/sim/cafe");
const {
  CAFE_PET_VISIT_END_HOUR,
  CAFE_PET_VISIT_PERCENT,
  SHOP_CAT_CAFE_PERCENT,
  cafePetVisitEndHour,
  cafePetVisitPercent,
  shopCatCafePercent,
} = await import("../src/floor/petAgents");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

/** 清空一樓,再照參數擺一批家具(room 明寫,測的就是「擺在哪一區」)。 */
const layout = (items: readonly { defId: string; room: string; c: number; r: number }[]) => {
  placements.list.splice(0, placements.list.length);
  for (const item of items) addPlacement({ ...item, rotation: 0 });
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.5; };

try {
  const orders = suggestedStandingOrders();
  const RICH = 1_000_000;

  // =========================================================================
  // 一、後場 `cafe_back` → 庫存容量上限
  // =========================================================================
  layout([]);
  check("空店的後場收納為 0、容量退回底量", cafeBackStoragePoints() === 0
    && cafeStorageCapacity(cafeBackStoragePoints()) === 360 && CAFE_STORAGE_BASE === 360);
  // 🔴 2026-08-25:第七種原料(精品生豆 24 單位)上線後總和由 310 → **334**,
  //    底量 360 的餘裕從 50 單位縮到 **26 單位**。護欄本身沒變(開張期不准撞到上限),
  //    但這裡把數字寫死是刻意的:再加一種原料就會把底量吃穿,那時必須連底量一起重訂,
  //    而不是讓「開張期天天被庫存上限夾住」悄悄上線。
  check("底量 360 高於建議常備量總和 334 ⇒ 開張期玩家永遠碰不到上限", (() => {
    const suggested = Object.values(orders).reduce((sum, units) => sum + units, 0);
    return suggested === 334 && suggested < CAFE_STORAGE_BASE
      && restockPlan(orders, {}, RICH, { capacity: cafeStorageCapacity(0) }).capped === false;
  })());

  const BACK_SET = [
    { defId: "cafe_stock_shelf", room: "cafe_back", c: 1, r: 48 },
    { defId: "cafe_stock_shelf", room: "cafe_back", c: 4, r: 48 },
    { defId: "cafe_crate", room: "cafe_back", c: 10, r: 48 },
  ];
  layout(BACK_SET);
  check("標準解:後場貨架 ×2 + 木箱 ×1 = 14 點收納 → 容量 920",
    cafeBackStoragePoints() === 14 && cafeStorageCapacity(cafeBackStoragePoints()) === 920,
    `points=${cafeBackStoragePoints()} cap=${cafeStorageCapacity(cafeBackStoragePoints())}`);
  check("容量公式:底量 + 點數 × 每點,且有硬上限",
    cafeStorageCapacity(0) === CAFE_STORAGE_BASE
    && cafeStorageCapacity(3) === CAFE_STORAGE_BASE + 3 * CAFE_STORAGE_PER_POINT
    && cafeStorageCapacity(1e9) === CAFE_STORAGE_MAX);

  // 🔴 分區規則的核心斷言:同一組家具擺到主廳就完全不算收納。
  layout(BACK_SET.map((item) => ({ ...item, room: "cafe_floor" })));
  check("🔴 一模一樣的貨架擺在 cafe_floor:收納 0 點(擺錯區只剩氛圍)",
    cafeBackStoragePoints() === 0 && cafeStorageCapacity(cafeBackStoragePoints()) === CAFE_STORAGE_BASE);
  check("擺錯區仍然算氛圍(cafeAmbiancePoints 一行未改)", cafeAmbiancePoints() >= 0);

  layout([]);
  // 回歸釘子:不帶 capacity 的呼叫必須逐欄等於 A 批之前的輸出。
  const legacyPlan = restockPlan(orders, { milk: 3 }, 4_000);
  check("🔴 回歸釘子:省略 capacity ⇒ 不夾、每一欄都是 A 批之前的值",
    legacyPlan.capacity === null && legacyPlan.capped === false && legacyPlan.cappedUnits === 0
    && legacyPlan.stock.milk >= 3 && legacyPlan.totalCost <= 4_000);
  check("省略 capacity 與明寫超大 capacity,結果逐欄相同", (() => {
    const bare = restockPlan(orders, { milk: 3 }, 4_000);
    const huge = restockPlan(orders, { milk: 3 }, 4_000, { capacity: 999_999 });
    return JSON.stringify({ ...bare, capacity: 0, stored: 0 })
      === JSON.stringify({ ...huge, capacity: 0, stored: 0 });
  })());

  const capped = restockPlan(orders, {}, RICH, { capacity: 120 });
  check("容量夾住:買到的總量恰為容量、`capped` 為真、花費不超支",
    capped.lines.reduce((sum, line) => sum + line.bought, 0) === 120
    && capped.capped === true && capped.totalCost <= RICH);
  check("容量夾住時**庫存只增不減**", (() => {
    const before = { milk: 12, coffee_bean: 40 };
    const plan = restockPlan(orders, before, RICH, { capacity: 60 });
    return plan.stock.milk >= 12 && plan.stock.coffee_bean >= 40;
  })());
  check("🔴 stored > capacity(玩家事後拆貨架):只補不進來,**絕不倒扣既有庫存**", (() => {
    const hoard = { milk: 400, flour: 200 };
    const plan = restockPlan(orders, hoard, RICH, { capacity: 100 });
    return plan.stock.milk === 400 && plan.stock.flour === 200
      && plan.totalCost === 0 && plan.stored === 600;
  })());
  check("被容量夾住不會誤報 underfunded(那一欄仍然只指錢不夠)",
    restockPlan(orders, {}, RICH, { capacity: 50 }).underfunded === false);
  check("後場放不下有專屬敘事,且與其他 kind 不同句",
    cafeDailyLine({ kind: "storage", day: 3, subject: "牛奶" })
      !== cafeDailyLine({ kind: "underfunded", day: 3, subject: "牛奶", fulfillment: 0.5 })
    && cafeDailyLine({ kind: "storage", day: 3, subject: "牛奶" })
      === cafeDailyLine({ kind: "storage", day: 3, subject: "牛奶" }));

  // =========================================================================
  // 二、寵物區 `cafe_pet` → 停留時間與詢問意圖
  // =========================================================================
  layout([]);
  check("空店的寵物區舒適為 0", cafePetComfortPoints() === 0);
  check("🔴 回歸釘子:舒適 0 時三個 petAgent 旋鈕逐字等於 A 批之前的常數",
    cafePetVisitPercent(0) === CAFE_PET_VISIT_PERCENT && CAFE_PET_VISIT_PERCENT === 35
    && cafePetVisitEndHour(0) === CAFE_PET_VISIT_END_HOUR && CAFE_PET_VISIT_END_HOUR === 16
    && shopCatCafePercent(0) === SHOP_CAT_CAFE_PERCENT && SHOP_CAT_CAFE_PERCENT === 55);

  layout([{ defId: "cafe_cat_tower", room: "cafe_pet", c: 9, r: 41 }]);
  check("貓跳台擺在寵物區 → 舒適 5", cafePetComfortPoints() === 5, `${cafePetComfortPoints()}`);
  layout([{ defId: "cafe_cat_tower", room: "cafe_floor", c: 4, r: 43 }]);
  check("🔴 同一座貓跳台擺在主廳 → 舒適 0(擺錯區只剩氛圍)", cafePetComfortPoints() === 0);
  check("擺錯區的貓跳台仍然算氛圍(cozy 5 + style 3)", cafeAmbiancePoints() === 8, `${cafeAmbiancePoints()}`);

  layout([
    { defId: "cafe_table", room: "cafe_pet", c: 9, r: 41 },
    { defId: "cafe_chair_front", room: "cafe_pet", c: 11, r: 41 },
    { defId: "cafe_chair_side", room: "cafe_pet", c: 12, r: 41 },
  ]);
  check("🔴 防刷分:桌椅塞進寵物區一點舒適都不給(它們是 seating 不是 ambiance)",
    cafePetComfortPoints() === 0, `${cafePetComfortPoints()}`);

  layout([
    { defId: "cafe_cat_tower", room: "cafe_pet", c: 9, r: 41 },
    { defId: "cafe_pet_cushion", room: "cafe_pet", c: 12, r: 41 },
  ]);
  check("跳台 + 軟墊 = 9 點;再加投資項 = 17 點",
    cafePetComfortPoints() === 9
    && cafePetComfort(cafePetComfortPoints(), [CAFE_UPGRADE_IDS.petTower]) === 9 + CAFE_PET_TOWER_UPGRADE_COMFORT,
    `${cafePetComfortPoints()}`);
  check("沒買投資項就不加(cafePetComfort 只讀 upgrades,不自己去翻 placements)",
    cafePetComfort(9, []) === 9 && cafePetComfort(9, [CAFE_UPGRADE_IDS.signboard]) === 9);

  check("🔴 回歸釘子:cafeIntentWeights(0, 1) 逐位元等於 { adopt: 20, rent: 10 }",
    JSON.stringify(cafeIntentWeights(0, 1)) === JSON.stringify(CAFE_INTENT_BASE)
    && CAFE_INTENT_BASE.adopt === 20 && CAFE_INTENT_BASE.rent === 10);
  check("設計表逐格對得上", (() => {
    const rows: [number, number, number, number][] = [
      [0, 1, 20, 10],
      [5, 1, 27, 10],   // 5 × 1.5 = 7.5 → floor 7
      [17, 1, 35, 10],  // 17 × 1.5 = 25.5 → 夾在 +15
      [17, 4, 35, 19],
    ];
    return rows.every(([comfort, level, adopt, rent]) => {
      const w = cafeIntentWeights(comfort, level);
      return w.adopt === adopt && w.rent === rent;
    });
  })(), JSON.stringify(cafeIntentWeights(5, 1)));
  check("認養加成有封頂:舒適 100 也只到 35%",
    cafeIntentWeights(100, 1).adopt === CAFE_INTENT_BASE.adopt + CAFE_ADOPT_MAX_BONUS
    && cafeIntentWeights(100, 1).adopt === 35);
  check("租屋加成綁招牌等級,且被 CAFE_MAX_SIGN_LEVEL 夾住",
    cafeIntentWeights(0, 4).rent === CAFE_INTENT_BASE.rent + 3 * CAFE_RENT_PER_SIGN
    && cafeIntentWeights(0, 99).rent === cafeIntentWeights(0, 4).rent);
  check("三種意圖的權重和永遠 < 100(coffee 永遠留得下人)", (() => {
    for (let comfort = 0; comfort <= 60; comfort++) {
      for (let level = 1; level <= 4; level++) {
        const w = cafeIntentWeights(comfort, level);
        if (w.adopt + w.rent >= 100) return false;
      }
    }
    return true;
  })());
  check("壞資料不產生 NaN 或負權重", (() => {
    const bad = cafeIntentWeights(Number.NaN, Number.NaN);
    const negative = cafeIntentWeights(-40, -3);
    return bad.adopt === 20 && bad.rent === 10 && negative.adopt === 20 && negative.rent === 10;
  })());
  check("舒適度推高 petAgent 的三個旋鈕(上限內)",
    cafePetVisitPercent(9) === 53 && cafePetVisitEndHour(9) === 18 && shopCatCafePercent(9) === 73);

  // =========================================================================
  // 三、吧台區 `cafe_counter` → 同時服務人數
  // =========================================================================
  layout([]);
  check("拆光吧台 ⇒ 服務位退化成 1 而不是 0(收銀口一定存在,不製造失敗狀態)",
    cafeCounterSpan() === 0 && cafeServiceStations() === 1);

  layout([{ defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 }]);
  check("開張贈品 1 座(2 格寬)⇒ span 2、服務位 3",
    cafeCounterSpan() === 2 && cafeServiceStations() === 3);

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "cafe_counter", room: "cafe_counter", c: 5, r: 38 },
  ]);
  check("2 座相連 c3–c6 ⇒ span 4、服務位 5(名店期需求)",
    cafeCounterSpan() === 4 && cafeServiceStations() === 5,
    `span=${cafeCounterSpan()}`);
  check("加寬吧台後員工站位跟著變多(排隊與站位共用同一組 lane)",
    cafeStaffSpots().length >= 5, `${cafeStaffSpots().length}`);

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "cafe_counter", room: "cafe_counter", c: 2, r: 40 },
  ]);
  check("2 座分離 ⇒ 只算最大的那一塊(兩張各自為政的吧台不等於一條長吧台)",
    cafeCounterSpan() === 2 && cafeServiceStations() === 3,
    `span=${cafeCounterSpan()}`);

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "cafe_counter", room: "cafe_floor", c: 9, r: 43 },
    { defId: "cafe_counter", room: "cafe_floor", c: 11, r: 43 },
  ]);
  check("🔴 跨區:主廳拉再長的吧台也不算服務位(否則玩家可在主廳拉 14 格)",
    cafeCounterSpan() === 2 && cafeServiceStations() === 3,
    `span=${cafeCounterSpan()}`);

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "espresso_machine", room: "cafe_counter", c: 6, r: 38 },
  ]);
  check("濃縮咖啡機擺吧台區 ⇒ tech 3 兌現成 +1 服務位",
    cafeCounterTechPoints() === 3 && CAFE_COUNTER_TECH_PER_STATION === 3
    && cafeServiceStations() === 4, `tech=${cafeCounterTechPoints()}`);

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "espresso_machine", room: "cafe_back", c: 6, r: 48 },
    { defId: "cafe_fridge", room: "cafe_back", c: 8, r: 48 },
  ]);
  check("🔴 濃縮機擺後場 ⇒ +0;冷藏櫃的 tech 2 在後場也不生效(這正是分區規則)",
    cafeCounterTechPoints() === 0 && cafeServiceStations() === 3);

  // ---- cafeServiceStaff / cafeCapability ----
  check("cafeServiceStaff 夾住人力,但永遠至少 1",
    cafeServiceStaff(9, 3) === 3 && cafeServiceStaff(2, 5) === 2
    && cafeServiceStaff(9, 0) === 1 && cafeServiceStaff(9, -4) === 1);
  check("🔴 stations 省略/null = 不夾(比照 seats 的既有慣例)",
    cafeServiceStaff(9) === 9 && cafeServiceStaff(9, null) === 9);
  check("🔴 回歸釘子:cafeCapability 省略 stations ⇒ 逐欄等於 A 批之前", (() => {
    const cap = cafeCapability([], { seats: 9999, extraStaff: 4 });
    return cap.stations === null && cap.activeStaff === cap.staffCount && cap.idleStaff === 0
      && cap.staffCapacity === cap.staffCount * CAFE_STAFF_CUPS_PER_DAY
      && cap.staffCount === 5;
  })());
  check("stations 夾住產能:雇 5 人 + 贈品吧台(3 位)⇒ 只有 3 人做得出杯子", (() => {
    const cap = cafeCapability([], { seats: 9999, extraStaff: 4, stations: 3 });
    return cap.activeStaff === 3 && cap.idleStaff === 2
      && cap.staffCapacity === 3 * CAFE_STAFF_CUPS_PER_DAY;
  })());
  check("吧台夠寬就不夾:5 人 + 服務位 5 ⇒ 一位都不閒著", (() => {
    const cap = cafeCapability([], { seats: 9999, extraStaff: 4, stations: 5 });
    return cap.idleStaff === 0 && cap.staffCapacity === 5 * CAFE_STAFF_CUPS_PER_DAY;
  })());
  check("服務位再多也不會憑空生出員工(人力上限仍然是 `CAFE_MAX_EXTRA_STAFF`)", (() => {
    const cap = cafeCapability([], { seats: 9999, extraStaff: 99, stations: 30 });
    return cap.staffCount === cafeStaffCount(CAFE_MAX_EXTRA_STAFF) && cap.idleStaff === 0;
  })());
  check("壞掉的 stations 不產生 NaN、也不會把產能打成 0", (() => {
    const cap = cafeCapability([], { seats: 12, extraStaff: 2, stations: Number.NaN });
    return Number.isFinite(cap.capacity) && cap.capacity > 0 && cap.activeStaff >= 1;
  })());

  // =========================================================================
  // 四、界線與決定性
  // =========================================================================
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cafeSrc = readFileSync(join(repoRoot, "src", "sim", "cafe.ts"), "utf8");
  const cafeCode = cafeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("🔴 cafe.ts 仍然不 import ./placements(幾何數字一律由 caller 餵參數)",
    !/from\s+"\.\/placements"/.test(cafeCode));
  check("🔴 cafe.ts 程式碼本體不出現 getPlacements", !cafeCode.includes("getPlacements"));
  check("cafe.ts 本體零 Math.random", !cafeCode.includes("Math.random"));

  const placementsSrc = readFileSync(join(repoRoot, "src", "sim", "placements.ts"), "utf8");
  check("cafeAmbiancePoints() 仍然只看四個 cafe 區域(氛圍公式一行未改)",
    /export function cafeAmbiancePoints\(\): number \{\s*let points = 0;\s*for \(const p of placements\.list\) \{\s*if \(!CAFE_PLACEMENT_REGION_SET\.has\(p\.room\)\) continue;/.test(placementsSrc));

  layout([
    { defId: "cafe_counter", room: "cafe_counter", c: 3, r: 38 },
    { defId: "cafe_cat_tower", room: "cafe_pet", c: 9, r: 41 },
    { defId: "cafe_stock_shelf", room: "cafe_back", c: 1, r: 48 },
  ]);
  const snapshot = () => JSON.stringify({
    storage: cafeBackStoragePoints(),
    comfort: cafePetComfortPoints(),
    span: cafeCounterSpan(),
    tech: cafeCounterTechPoints(),
    stations: cafeServiceStations(),
  });
  check("同一組擺放連查兩次結果逐欄相同(決定性)", snapshot() === snapshot(), snapshot());
  check("四個查詢全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);

  // 還原成開張贈品的擺法,不留給後續使用者奇怪的場景
  layout([]);
  placeCafeStarterSet();
  check("開張贈品擺回去之後,服務位仍是 3(整份規格的預設起點)", cafeServiceStations() === 3);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
