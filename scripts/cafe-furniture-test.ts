/**
 * 咖啡廳開張贈品(基本家具)與家具氛圍加成。
 *
 * 三條不變條件是本檔的重點:
 * 1. 贈品**免費**且**只在開張那一刻擺一次**——玩家搬走/賣掉後不會被塞回來。
 * 2. 氛圍乘數**空店為 1.0、有家具 > 1.0、堆再多也不超過上限**。
 * 3. 咖啡廳未開張時整條路徑完全不動(balance 快照零漂移的直接釘子)。
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

const { state } = await import("../src/store");
const { addMoney } = await import("../src/sim/economy");
const { save, load } = await import("../src/sim/persistence");
const { cafeDailyPass } = await import("../src/sim/tick");
const {
  CAFE_AMBIANCE_FULL_POINTS,
  CAFE_AMBIANCE_SWING,
  CAFE_OPENING_COST,
  cafeAmbianceMultiplier,
  cafeCrowd,
  openCafe,
} = await import("../src/sim/cafe");
const {
  CAFE_PLACEMENT_REGIONS,
  CAFE_STARTER_PLACEMENTS,
  cafeAmbiancePoints,
  canPlaceFree,
  getPlacements,
  placeCafeStarterSet,
  placementFootprint,
  placements,
  removePlacementAt,
} = await import("../src/sim/placements");
const { getDef } = await import("../src/furniture/catalog");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` (${detail})` : ""}`); }
};

const cafeRegions = new Set<string>(CAFE_PLACEMENT_REGIONS);
const cafePlacements = () => getPlacements().filter((p) => cafeRegions.has(p.room));
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

// --- 0. 開張前:一樓是空的(贈品刻意不進 INITIAL_PLACEMENTS) ---
check("開張前一樓四個區域完全沒有家具", cafePlacements().length === 0, `${cafePlacements().length} 件`);
check("開張前氛圍點數為 0", cafeAmbiancePoints() === 0);
check("空店的氛圍乘數恰為 1.0(沒家具不懲罰)", cafeAmbianceMultiplier(cafeAmbiancePoints()) === 1);

// --- 1. 未開張 = 天然閘門:日結整條路徑不動(零漂移的直接釘子) ---
{
  const before = JSON.stringify({ money: state.money, cafe: state.cafe, ledger: state.ledger.length, version: placements.version });
  cafeDailyPass();
  cafeDailyPass();
  const after = JSON.stringify({ money: state.money, cafe: state.cafe, ledger: state.ledger.length, version: placements.version });
  check("未開張時 cafeDailyPass() 連跑兩次完全不動任何狀態", before === after);
}
check("未開張時客流公式的氛圍輸入恆為 0 ⇒ 乘數 1.0",
  cafeCrowd({ weather: "cloudy", weekday: 3, signLevel: 1, capacity: 9999, popularity: 0 }).ambianceMultiplier === 1);

// --- 2. 開張:扣 $12,000,家具免費 ---
{
  const moneyBefore = state.money;
  const ledgerBefore = state.ledger.length;
  const result = openCafe(state.cafe, state.money);
  check("openCafe() 成功且只收開張費", result.ok === true && result.cost === CAFE_OPENING_COST);
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳支出", "cafe");

  const moneyAfterFee = state.money;
  const ledgerAfterFee = state.ledger.length;
  const placed = placeCafeStarterSet();

  check("開張擺上完整一組基本家具", placed.length === CAFE_STARTER_PLACEMENTS.length && placed.length === 10, `${placed.length} 件`);
  check("擺放贈品完全不碰金流(金額不變)", state.money === moneyAfterFee, `${moneyAfterFee} → ${state.money}`);
  check("擺放贈品不產生任何帳目", state.ledger.length === ledgerAfterFee);
  check("整個開張流程只扣 $12,000", moneyBefore - state.money === CAFE_OPENING_COST, `實扣 ${moneyBefore - state.money}`);
}

// --- 3. 擺放合法性:每一件都通過 canPlaceFree ---
{
  const starter = cafePlacements();
  check("贈品全部落在四個 cafe 區域", starter.length === 10, `${starter.length} 件`);
  check("含吧台與三組桌椅",
    starter.filter((p) => p.defId === "cafe_counter").length === 1
    && starter.filter((p) => p.defId === "cafe_table").length === 3
    && starter.filter((p) => p.defId === "cafe_chair_front").length === 3
    && starter.filter((p) => p.defId === "cafe_chair_side").length === 3);

  // 逐件重驗:把自己排除後,原位仍必須是合法擺放點(等同 canPlaceFree 當初的判定)。
  const illegal = starter.filter((p) => {
    const fp = placementFootprint(p);
    return canPlaceFree(p.c, p.r, fp.w, fp.h, { c: p.c, r: p.r }) !== p.room;
  });
  check("每一件贈品的位置都通過 canPlaceFree(不壓牆/不重疊/不跨區)", illegal.length === 0,
    illegal.map((p) => `${p.defId}@${p.c},${p.r}`).join(" "));

  const occupied = new Set<string>();
  for (const p of getPlacements()) {
    const fp = placementFootprint(p);
    for (let dr = 0; dr < fp.h; dr++) for (let dc = 0; dc < fp.w; dc++) occupied.add(`${p.c + dc},${p.r + dr}`);
  }
  const corridor = [...occupied].filter((key) => {
    const [c, r] = key.split(",").map(Number);
    return (c === 7 || c === 8) && r >= 32;
  });
  check("不擋樓梯↔店門的中央走道 c7/c8", corridor.length === 0, corridor.join(" "));

  const { CAFE_GUEST_PREFERRED_SEATS } = await import("../src/floor/guestAgents");
  const takenSeats = CAFE_GUEST_PREFERRED_SEATS.filter((t) => occupied.has(`${t.c},${t.r}`));
  check("不佔用顧客偏好座位格", takenSeats.length === 0, JSON.stringify(takenSeats));
}

// --- 4. 只擺一次 ---
{
  const beforeOpenAgain = getPlacements().length;
  const again = openCafe(state.cafe, state.money);
  check("已開張時 openCafe() 直接 reject(贈品不可能再送一次)", again.ok === false && again.cost === 0);
  check("reject 路徑不改動任何擺放", getPlacements().length === beforeOpenAgain);

  // 存檔往返不重跑贈品
  save();
  const savedCafeCount = cafePlacements().length;
  load();
  check("存檔往返後一樓家具件數不變(載入不重跑擺放)", cafePlacements().length === savedCafeCount, `${cafePlacements().length}`);

  // 玩家搬走/賣掉之後也不會被塞回來
  const victim = cafePlacements().find((p) => p.defId === "cafe_chair_front")!;
  removePlacementAt(victim.c, victim.r);
  const afterRemove = cafePlacements().length;
  check("移除一件後件數 −1", afterRemove === savedCafeCount - 1);
  save();
  load();
  check("玩家移走家具後,存檔往返不會把它塞回來", cafePlacements().length === afterRemove, `${cafePlacements().length}`);
  const rejected = openCafe(state.cafe, state.money);
  check("移走家具後再按開張仍被擋(不會補送)", rejected.ok === false);
  check("被擋後件數仍是移除後的數量", cafePlacements().length === afterRemove);
}

// --- 5. 氛圍加成 ---
{
  check("氛圍乘數:0 點 = 1.0", cafeAmbianceMultiplier(0) === 1);
  check("氛圍乘數:負數/NaN 一律夾成 1.0", cafeAmbianceMultiplier(-50) === 1 && cafeAmbianceMultiplier(NaN as unknown as number) === 1);
  check("氛圍乘數單調遞增", cafeAmbianceMultiplier(10) < cafeAmbianceMultiplier(20)
    && cafeAmbianceMultiplier(20) < cafeAmbianceMultiplier(40));
  const ceiling = 1 + CAFE_AMBIANCE_SWING;
  check("氛圍乘數在滿點時剛好觸頂", cafeAmbianceMultiplier(CAFE_AMBIANCE_FULL_POINTS) === ceiling, `${cafeAmbianceMultiplier(CAFE_AMBIANCE_FULL_POINTS)}`);
  check("堆到很多家具仍不超過上限",
    cafeAmbianceMultiplier(CAFE_AMBIANCE_FULL_POINTS * 100) === ceiling
    && cafeAmbianceMultiplier(Number.MAX_SAFE_INTEGER) === ceiling);
  check("上限幅度不高於人氣加成(靜態投資不該壓過動態服務品質)", CAFE_AMBIANCE_SWING <= 0.25);

  // 目錄屬性 → 點數:與實際擺放算出來的一致
  const expected = cafePlacements().reduce((sum, p) => {
    const attrs = getDef(p.defId).attributes;
    return sum + Math.max(0, attrs.cozy ?? 0) + Math.max(0, attrs.style ?? 0);
  }, 0);
  check("cafeAmbiancePoints() = 一樓家具 cozy+style 總和", cafeAmbiancePoints() === expected, `${cafeAmbiancePoints()} vs ${expected}`);
  check("開張後氛圍點數 > 0 ⇒ 乘數 > 1.0", cafeAmbiancePoints() > 0 && cafeAmbianceMultiplier(cafeAmbiancePoints()) > 1);

  // 客流公式真的吃到氛圍
  const crowdArgs = { weather: "cloudy" as const, weekday: 3, signLevel: 1, capacity: 9999, popularity: 0 };
  const plain = cafeCrowd(crowdArgs);
  const cosy = cafeCrowd({ ...crowdArgs, ambiancePoints: cafeAmbiancePoints() });
  const maxed = cafeCrowd({ ...crowdArgs, ambiancePoints: CAFE_AMBIANCE_FULL_POINTS * 10 });
  check("有家具的客流高於空店", cosy.base > plain.base, `${plain.base} → ${cosy.base}`);
  check("堆爆家具的客流仍被上限夾住", maxed.ambianceMultiplier === ceiling && maxed.base === Math.round(plain.base * ceiling),
    `${maxed.base}`);
  check("氛圍與其他係數並列、互不干擾",
    plain.weatherMultiplier === cosy.weatherMultiplier
    && plain.weekdayMultiplier === cosy.weekdayMultiplier
    && plain.popularityMultiplier === cosy.popularityMultiplier);

  // 只算一樓:三樓家具再多也不加分
  const upstairs = getPlacements().filter((p) => !cafeRegions.has(p.room));
  check("三樓/共用區的家具不計入氛圍(只看一樓四區)", upstairs.length > 0 && cafeAmbiancePoints() === expected);
}

// --- 6. 界線:擺放與金流的歸屬沒有被磨掉 ---
{
  const cafeSrc = readSrc("src", "sim", "cafe.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("cafe.ts 仍未 import placements(擺放是 state,不進純函式檔)",
    !/from\s+"\.\/placements"/.test(cafeSrc));
  check("cafe.ts 的氛圍算式是純函式(不讀 getPlacements)", !cafeSrc.includes("getPlacements"));
  const panelSrc = readSrc("src", "components", "CafePanel.vue");
  check("CafePanel 的開張流程確實呼叫 placeCafeStarterSet()", panelSrc.includes("placeCafeStarterSet()"));
  const tickSrc = readSrc("src", "sim", "tick.ts");
  check("tick.cafeDailyPass 把氛圍點數餵進客流公式", /ambiancePoints:\s*cafeAmbiancePoints\(\)/.test(tickSrc));
}

// --- 舊存檔補發(v6 → v7) ---
// 這一組釘的是 2026-08-03 使用者實玩回報的漏洞:贈品只在按下開張那一刻擺,
// **在本功能上線前就已經開張的存檔永遠拿不到,一樓會永遠是空的**。
{
  const { SAVE_VERSION, migrateSave } = await import("../src/sim/persistence");
  const { starterPlacementsAgainst } = await import("../src/sim/placements");
  const cafeCount = (list: any[]) => list.filter((p) => cafeRegions.has(p.room)).length;

  check("SAVE_VERSION 已升到 8", SAVE_VERSION === 8);

  // 🔴 v7 已經上線過,且當時的 MIGRATIONS[6] 帶著會誤擋的守衛。
  // 受影響的存檔已被標成 v7、升級表不會回頭 ⇒ 必須有 v7 → v8 才追得到他們。
  const strandedAtV7 = migrateSave({
    v: 7,
    cafe: { open: true },
    placements: [{ defId: "cafe_cat_tower", room: "cafe_pet", c: 11, r: 44, rotation: 0 }],
  });
  check("已被舊守衛擋掉、卡在 v7 的存檔 → v8 補齊贈品",
    strandedAtV7 != null && strandedAtV7.v === 8 && cafeCount(strandedAtV7.placements) > 1,
    `一樓共 ${strandedAtV7 ? cafeCount(strandedAtV7.placements) : "null"} 件`);

  // 已經拿過贈品的 v7 存檔再升到 v8 不可以多送(重跑安全性)
  const alreadyGifted = migrateSave({ v: 6, cafe: { open: true }, placements: [] });
  const reMigrated = migrateSave({ ...(alreadyGifted as any), v: 7 });
  check("已拿過贈品的存檔升到 v8 不會重複補發",
    reMigrated != null && cafeCount(reMigrated.placements) === cafeCount(alreadyGifted!.placements),
    `${reMigrated ? cafeCount(reMigrated.placements) : "null"} vs ${cafeCount(alreadyGifted!.placements)}`);

  // 已開張、一樓全空的舊檔 → 補發
  const opened = migrateSave({ v: 6, cafe: { open: true }, placements: [] });
  check("舊檔已開張且一樓全空 → 補發整組贈品",
    opened != null && opened.v === SAVE_VERSION && cafeCount(opened.placements) === CAFE_STARTER_PLACEMENTS.length,
    `補了 ${opened ? cafeCount(opened.placements) : "null"} 件`);

  // 沒開張的舊檔 → 不補(開張時才送,免得未開張就先有店面)
  const closed = migrateSave({ v: 6, cafe: { open: false }, placements: [] });
  check("舊檔未開張 → 不補發", closed != null && closed.v === SAVE_VERSION && cafeCount(closed.placements) === 0);

  // 🔴 2026-08-03 使用者回報:「我的咖啡廳已經放置一個貓跳台了,這樣是不是就不會補家具?」
  // 第一版確實有「一樓已有家具就整組跳過」的守衛 —— 放一件貓跳台就拿不到任何補發。
  // 「有一件家具」跟「已經佈置好了」是兩回事;防覆蓋由逐格重疊檢查負責,不該用這種粗守衛。
  const tower = [{ defId: "cafe_cat_tower", room: "cafe_pet", c: 11, r: 44, rotation: 0 }];
  const withTower = migrateSave({ v: 6, cafe: { open: true }, placements: tower });
  check("一樓已有一件玩家家具(貓跳台)→ 仍然補發贈品",
    withTower != null && cafeCount(withTower.placements) > 1,
    `一樓共 ${withTower ? cafeCount(withTower.placements) : "null"} 件`);
  check("補發不會動到玩家原有的貓跳台",
    withTower != null && withTower.placements.some(
      (p: any) => p.defId === "cafe_cat_tower" && p.c === 11 && p.r === 44));

  // 佔住某個贈品座標 → 該件跳過,其餘照補(逐格重疊檢查生效)
  const blocking = [{ defId: "cafe_table", room: "cafe_floor", c: 2, r: 43, rotation: 0 }];
  const blocked = migrateSave({ v: 6, cafe: { open: true }, placements: blocking });
  check("玩家佔住贈品座標 → 只跳過該件,不覆蓋也不整組放棄",
    blocked != null
      && cafeCount(blocked.placements) > 1
      && cafeCount(blocked.placements) <= CAFE_STARTER_PLACEMENTS.length,
    `一樓共 ${blocked ? cafeCount(blocked.placements) : "null"} 件`);

  // 只跑一次:已經是 v7 的檔再走一次升級不會再補
  const again = migrateSave({ ...(opened as any) });
  check("已補發過的檔再升級不會重複補發",
    again != null && cafeCount(again.placements) === CAFE_STARTER_PLACEMENTS.length);

  // 純函式版本不碰模組狀態
  const before = getPlacements().length;
  starterPlacementsAgainst([]);
  check("starterPlacementsAgainst() 不修改模組的 placements", getPlacements().length === before);

  // 同一批內部不可互相重疊
  const batch = starterPlacementsAgainst([]);
  const seen = new Set<string>();
  let overlap = false;
  for (const p of batch) {
    const fp = placementFootprint(p as any);
    for (let dr = 0; dr < fp.h; dr++)
      for (let dc = 0; dc < fp.w; dc++) {
        const key = `${p.c + dc},${p.r + dr}`;
        if (seen.has(key)) overlap = true;
        seen.add(key);
      }
  }
  check("補發的贈品彼此不重疊", !overlap);
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
