/**
 * 家具商店的場地分頁(2026-08-03 使用者實玩要求「把租房的家具和咖啡廳的家具做個分類」)。
 *
 * 這支測試釘住的三件事:
 * 1. **12 件咖啡廳家具都標了 `venue: "cafe"`,而且沒有任何租屋家具被誤標**。
 * 2. **防未來漏標**:所有 `cafe_*` id 都必須標到 venue——新增咖啡廳家具卻忘了標,
 *    這裡就會紅燈,而不是靜默出現在租屋分頁裡。
 *    (反過來不成立:`espresso_machine` 是沒有 `cafe_` 前綴的咖啡廳家具,
 *    所以程式**不可以**用前綴判斷,只能用顯式欄位。)
 * 3. **不重不漏**:兩個分頁件數相加 = 商店上架總件數,且既有上架規則(牆面家具、
 *    `price <= 0` 的紀念物不上架)沒有被分頁改動。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { CATALOG, getDef, isShopListed, venueOf } = await import("../src/furniture/catalog");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` (${detail})` : ""}`); }
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

/** CAFE-06 那一批咖啡廳家具(與 data-catalog-test.ts 的清單一致) */
const CAFE_FURNITURE_IDS = [
  "cafe_counter", "espresso_machine", "cafe_display_stocked", "cafe_menu_board",
  "cafe_table", "cafe_chair_front", "cafe_chair_side", "cafe_cat_tower",
  "cafe_pet_cushion", "cafe_stock_shelf", "cafe_crate", "cafe_fridge",
];

// --- 1. 標記正確:該標的都標了,不該標的都沒標 ---
{
  const missing = CAFE_FURNITURE_IDS.filter((id) => getDef(id).venue !== "cafe");
  check(`CAFE-06 的 ${CAFE_FURNITURE_IDS.length} 件咖啡廳家具全部標了 venue: "cafe"`,
    missing.length === 0, `漏標:${missing.join(", ")}`);

  const marked = CATALOG.filter((d) => d.venue === "cafe").map((d) => d.id);
  const extra = marked.filter((id) => !CAFE_FURNITURE_IDS.includes(id));
  check("沒有任何非咖啡廳家具被誤標成 cafe", extra.length === 0, `誤標:${extra.join(", ")}`);
  check(`標了 cafe 的正好是那 ${CAFE_FURNITURE_IDS.length} 件(不多不少,共 ${marked.length} 件)`,
    marked.length === CAFE_FURNITURE_IDS.length);

  // 🔴 防未來漏標:命名慣例是 `cafe_*`,新增時忘了標 venue 就會掉進租屋分頁。
  // (只當「檢查」用,程式本身不可以拿前綴當判準——espresso_machine 就是反例。)
  const prefixed = CATALOG.filter((d) => d.id.startsWith("cafe_"));
  const unmarkedPrefixed = prefixed.filter((d) => d.venue !== "cafe");
  check(`所有 cafe_* 家具都標了 venue(共 ${prefixed.length} 件,零漏標)`,
    unmarkedPrefixed.length === 0, `漏標:${unmarkedPrefixed.map((d) => d.id).join(", ")}`);
  check("清單裡確實有不帶 cafe_ 前綴的咖啡廳家具 ⇒ 前綴判斷會漏,必須用顯式欄位",
    CAFE_FURNITURE_IDS.some((id) => !id.startsWith("cafe_")));

  check("venue 欄位若有值必為 rent/cafe",
    CATALOG.every((d) => d.venue === undefined || d.venue === "rent" || d.venue === "cafe"));
  check("選填:絕大多數租屋家具一個字都沒改(venue 未標)",
    CATALOG.filter((d) => d.venue === undefined).length === CATALOG.length - CAFE_FURNITURE_IDS.length);
  check("venueOf() 對未標的家具回 rent(預設是租屋家具)",
    venueOf(getDef("double_bed")) === "rent" && venueOf(getDef("coffee_machine")) === "rent"
      && venueOf(getDef("cafe_counter")) === "cafe");
  check("三樓廚房的 coffee_machine 與咖啡廳的 espresso_machine 是兩件不同家具,前者留在租屋分頁",
    getDef("coffee_machine").venue === undefined && getDef("espresso_machine").venue === "cafe");
}

// --- 2. 兩個分頁不重不漏 ---
const listed = CATALOG.filter(isShopListed);
const rentTab = listed.filter((d) => venueOf(d) === "rent");
const cafeTab = listed.filter((d) => venueOf(d) === "cafe");
{
  check(`租屋分頁 ${rentTab.length} 件 + 咖啡廳分頁 ${cafeTab.length} 件 = 上架總數 ${listed.length} 件`,
    rentTab.length + cafeTab.length === listed.length);
  const ids = new Set([...rentTab, ...cafeTab].map((d) => d.id));
  check("沒有家具同時出現在兩個分頁", ids.size === listed.length);
  check("兩個分頁都不是空的(玩家兩邊都有東西可買)", rentTab.length > 0 && cafeTab.length > 0);
  check(`咖啡廳家具全部可購買 ⇒ 12 件都上架(實際 ${cafeTab.length} 件)`,
    cafeTab.length === CAFE_FURNITURE_IDS.length);
}

// --- 3. 既有上架規則沒被分頁破壞 ---
{
  const wall = CATALOG.filter((d) => d.placement === "wall");
  const free = CATALOG.filter((d) => d.price <= 0);
  check(`牆面家具仍不上架(${wall.length} 件全被擋)`, wall.every((d) => !isShopListed(d)));
  check(`price <= 0 的紀念物仍不上架(${free.length} 件全被擋)`, free.every((d) => !isShopListed(d)));
  check("上架清單每一件都放得下地板且有標價", listed.every((d) => d.placement !== "wall" && d.price > 0));
  check("被擋掉的家具不會因為 venue 分類而偷偷回到任一分頁",
    [...wall, ...free].every((d) => !rentTab.includes(d) && !cafeTab.includes(d)));
}

// --- 4. 分組:空類別不產生標題 ---
{
  const groupsOf = (venue: "rent" | "cafe") => {
    const byCat = new Map<string, typeof CATALOG>();
    for (const d of listed) {
      if (venueOf(d) !== venue) continue;
      if (!byCat.has(d.category)) byCat.set(d.category, []);
      byCat.get(d.category)!.push(d);
    }
    return [...byCat.entries()];
  };
  const cafeGroups = groupsOf("cafe");
  const rentGroups = groupsOf("rent");
  check("每個分組都至少有一件家具(空類別不會產生標題)",
    [...cafeGroups, ...rentGroups].every(([, items]) => items.length > 0));
  check(`咖啡廳分頁不出現「睡眠」等沒有品項的類別(實際只有 ${cafeGroups.map(([c]) => c).join("/")})`,
    !cafeGroups.some(([cat]) => cat === "sleep" || cat === "work" || cat === "av" || cat === "utility"));
  check("租屋分頁仍涵蓋全部 8 個類別(分頁沒有弄丟任何租屋家具)", rentGroups.length === 8, `${rentGroups.length} 組`);
  check("兩個分頁的品項總和等於上架總數(分組不重不漏)",
    [...cafeGroups, ...rentGroups].reduce((n, [, items]) => n + items.length, 0) === listed.length);
}

// --- 5. 介面接線:商店用顯式欄位過濾、分頁存在、既有文案沒被動到 ---
{
  const shop = readSrc("src", "components", "FurnitureShop.vue");
  check("商店用 venueOf() 過濾分頁,不是 id 前綴魔法",
    shop.includes("venueOf(d) !== venue.value") && !shop.includes('startsWith("cafe_")'));
  check("商店上架規則沿用 catalog 的 isShopListed(不各自複製一份判準)",
    shop.includes("CATALOG.filter(isShopListed)"));
  check("兩個分頁都在,且顯示件數", shop.includes("🏠 租屋樓層") && shop.includes("☕ 咖啡廳")
    && shop.includes("venueCount[t.id]"));
  check("既有購買流程與文案未動",
    shop.includes("選好家具後,回到地圖點一格擺放。")
      && shop.includes("const res = startPlacing(defId)")
      && shop.includes("買不了:"));

  const app = readSrc("src", "App.vue");
  const floorMap = readSrc("src", "components", "FloorMap.vue");
  check("FloorMap 換樓層時回報 floorChange", floorMap.includes('emit("floorChange", floorView.value)'));
  check("App 依目前樓層預選分頁(1F 開商店 → 咖啡廳)",
    app.includes(":initial-venue=\"floorView === '1f' ? 'cafe' : 'rent'\"")
      && app.includes('@floor-change="floorView = $event"'));

  // venue 只是商店分類,不參與模擬:sim 層不該讀它(讀了就是把 UI 分類偷渡成規則)
  const simFiles = ["cafe.ts", "placements.ts", "tick.ts", "economy.ts"];
  const simLeak = simFiles.filter((f) => /\.venue\b/.test(readSrc("src", "sim", f)));
  check("模擬層完全不讀 venue(純商店分類,不影響擺放/金流/客流)", simLeak.length === 0, simLeak.join(", "));
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
