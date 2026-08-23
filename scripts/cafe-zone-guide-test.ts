/**
 * 2026-08-23「咖啡廳分區規則進 UI」的資料層合約測試(`src/content/cafeZoneGuide.ts`)。
 *
 * 背景:十二件咖啡廳家具沒有一件在 catalog 裡帶「該擺哪區」的欄位,`CAFE_FURNITURE_ZONE`
 * 是手動維護的對照表,商店標籤／家具詳情／CafePanel 分區小抄三個 UI 落點共用同一份。
 * 這裡只釘資料正確性,不驗 UI 渲染(渲染釘在各自的 SFC 合約測試裡)。
 *
 * 1. 表裡每個 key 都是 CATALOG 裡真實存在、venue==="cafe" 的 defId(防打錯字)。
 * 2. 8 件「有機能需求」家具逐一斷言都在表裡且 room 值正確。
 * 3. 4 件純氛圍/座位家具不在表裡(不分區、不顯示提示)。
 * 4. room 值與 `src/sim/placements.ts` 對應機能查詢函式篩選的 room 字串一致
 *    (吧台類 "cafe_counter"、寵物類 "cafe_pet"、後場類 "cafe_back"——直接比對字串常數)。
 */
import { CATALOG } from "../src/furniture/catalog";
import { CAFE_FURNITURE_ZONE, CAFE_ZONE_INFO, type CafeZoneRule } from "../src/content/cafeZoneGuide";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};

const catalogIds = new Set(CATALOG.map((d) => d.id));
const cafeCatalogIds = new Set(CATALOG.filter((d) => d.venue === "cafe").map((d) => d.id));

// ── ① 表裡每個 key 都是真實存在的咖啡廳家具 ──────────────────
for (const defId of Object.keys(CAFE_FURNITURE_ZONE)) {
  check(`CAFE_FURNITURE_ZONE 的 key "${defId}" 是 CATALOG 裡真實存在的 defId`, catalogIds.has(defId));
  check(`"${defId}" 的 venue 是 "cafe"`, cafeCatalogIds.has(defId));
}

// ── ② 8 件「有機能需求」家具逐一核對 room ───────────────────
const EXPECTED: Record<string, CafeZoneRule["room"]> = {
  cafe_counter: "cafe_counter",
  espresso_machine: "cafe_counter",
  cafe_cat_tower: "cafe_pet",
  cafe_pet_cushion: "cafe_pet",
  cafe_stock_shelf: "cafe_back",
  cafe_crate: "cafe_back",
  cafe_display_stocked: "cafe_back",
  cafe_fridge: "cafe_back",
};
for (const [defId, room] of Object.entries(EXPECTED)) {
  check(`"${defId}" 在表裡`, defId in CAFE_FURNITURE_ZONE);
  check(`"${defId}" 的 room 是 "${room}"`, CAFE_FURNITURE_ZONE[defId]?.room === room);
}
check("剛好 8 件家具有機能需求(表的大小)", Object.keys(CAFE_FURNITURE_ZONE).length === Object.keys(EXPECTED).length);

// ── ③ 4 件純氛圍/座位家具不在表裡 ───────────────────────
const AMBIANCE_ONLY = ["cafe_menu_board", "cafe_table", "cafe_chair_front", "cafe_chair_side"];
for (const defId of AMBIANCE_ONLY) {
  check(`"${defId}" 是純氛圍家具,不在 CAFE_FURNITURE_ZONE 裡`, CAFE_FURNITURE_ZONE[defId] === undefined);
  check(`"${defId}" 仍是真實存在的咖啡廳家具(不是打錯字)`, cafeCatalogIds.has(defId));
}

// ── ④ room 值與 sim/placements.ts 的機能查詢函式篩選字串一致 ─────
// 直接比對字串常數(來源:cafeCounterSpan/cafeCounterTechPoints 篩 "cafe_counter"、
// cafePetComfortPoints 篩 "cafe_pet"、cafeBackStoragePoints 篩 "cafe_back")。
const PLACEMENTS_QUERY_ROOM: Record<CafeZoneRule["room"], boolean> = {
  cafe_floor: false, cafe_counter: true, cafe_pet: true, cafe_back: true, cafe_entrance: false,
};
for (const rule of Object.values(CAFE_FURNITURE_ZONE)) {
  check(
    `room "${rule.room}" 是 sim/placements.ts 有對應機能查詢的分區`,
    PLACEMENTS_QUERY_ROOM[rule.room] === true,
  );
}

// ── ⑤ CAFE_ZONE_INFO 涵蓋全部 5 區,且與 CAFE_FURNITURE_ZONE 用的 room 互相對得上 ──
const ZONE_INFO_KEYS = Object.keys(CAFE_ZONE_INFO).sort();
check(
  "CAFE_ZONE_INFO 涵蓋全部 5 個 CafeRegion",
  ZONE_INFO_KEYS.join(",") === ["cafe_back", "cafe_counter", "cafe_entrance", "cafe_floor", "cafe_pet"].sort().join(","),
);
for (const rule of Object.values(CAFE_FURNITURE_ZONE)) {
  check(`CAFE_ZONE_INFO 有登記 room "${rule.room}"`, rule.room in CAFE_ZONE_INFO);
  check(`"${rule.room}" 的 label/emoji 與 CAFE_ZONE_INFO 一致`, CAFE_ZONE_INFO[rule.room].label === rule.label && CAFE_ZONE_INFO[rule.room].emoji === rule.emoji);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
