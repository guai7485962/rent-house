/**
 * 🔴 缺貨歸因到原料(使用者 2026-08-08 實玩回報)。
 *
 * > 「我覺得咖啡廳系統賺不太到錢,並且原料和商品對不起來,
 * >   我不知道那個商品缺貨我要多進的是什麼原料。」
 *
 * 面板上「銷售排行(品項 + 缺貨 N)」與「常備量(原料 + 庫存)」兩張表之間本來
 * 沒有任何連結,而 `content/cafeIngredients.ts` 的 `usedIn` 字串又是 P1 之前的
 * 裝飾文字、早就與菜單對不上。本測試釘死修好之後的三件事:
 *
 * 1. **商品 → 原料**:唯一事實來源是 `CafeMenuItem.recipe`,`cafeRecipeLines()` 逐項對得上
 * 2. **原料 → 商品**:`cafeIngredientMenuUse()` 只列目前菜單上的品項,名稱與菜單逐字相同
 * 3. **缺貨歸因**:`missedBy` 記的是結帳當下真的不夠的那些原料(`checkoutCafeOrder().missing`),
 *    不是事後拿配方推的;同一個品項在不同狀況下缺不同的料也分得出來
 *
 * 另外把 `usedIn` 已從所有顯示路徑消失、以及存檔往返(不升 SAVE_VERSION)一起釘住。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { state, defaultCafe, sanitizeCafeState, GAME_START } = await import("../src/sim/gameState");
const { cafeHourlyPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const {
  cafeIngredientMenuUse, cafeIngredientShortageBlame, cafeItemShortageCauses, cafeRecipeLines,
  checkoutCafeOrder, menuItems, CAFE_BASE_MENU_ITEMS, CAFE_SALES_WINDOW_DAYS,
} = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");
const { CAFE_RESEARCH_IDS } = await import("../src/content/cafeResearch");
const { SAVE_VERSION } = await import("../src/sim/persistence");
const { placeCafeStarterSet } = await import("../src/sim/placements");
import type { CafeSalesDay } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]) => readFileSync(join(here, "..", "src", ...parts), "utf8");
/**
 * 只留程式碼:拿掉 `/* *\/`、`//` 與 `<!-- -->` 三種註解。
 * 註解裡可以(也應該)解釋「為什麼移除 usedIn」「為什麼不呼叫 addMoney」,
 * 掃描界線時把它們算進去只會逼人不敢寫註解。
 */
const codeOnly = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const at = (day: number, hour: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS; };

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.123456789; };

try {
  // ===========================================================================
  // 一、`usedIn` 已徹底退場
  // ===========================================================================
  check("原料資料不再帶 usedIn 欄位",
    CAFE_INGREDIENTS.every((item) => !("usedIn" in item)),
    JSON.stringify(CAFE_INGREDIENTS[0]));
  check("content/cafeIngredients.ts 原始碼只在說明為何移除時提到 usedIn(沒有欄位定義)",
    !/^\s*usedIn\s*[:?]/m.test(src("content", "cafeIngredients.ts")));
  for (const file of [["sim", "cafe.ts"], ["sim", "tick.ts"], ["components", "CafePanel.vue"], ["floor", "guestAgents.ts"]]) {
    // 註解裡可以解釋歷史,但程式碼一個字都不准再碰它
    check(`${file.join("/")} 沒有任何顯示路徑再讀 usedIn`, !/\busedIn\b/.test(codeOnly(src(...file))));
  }

  // ===========================================================================
  // 二、商品 → 原料(唯一事實來源是 recipe)
  // ===========================================================================
  const baseMenu = menuItems([]);
  const coffee = baseMenu.find((item) => item.id === "cafe_menu_house_coffee")!;
  const bake = baseMenu.find((item) => item.id === "cafe_menu_daily_bake")!;
  const coffeeLines = cafeRecipeLines(coffee);
  check("招牌美式咖啡的配方 = 咖啡豆 ×4(逐字對得上 recipe)",
    coffeeLines.length === 1 && coffeeLines[0].id === "coffee_bean"
    && coffeeLines[0].name === "咖啡豆" && coffeeLines[0].units === 4
    && coffeeLines[0].unitPrice === 4,
    JSON.stringify(coffeeLines));
  const bakeLines = cafeRecipeLines(bake);
  check("每日烘焙小點 = 麵粉 ×2 + 奶油 ×1,順序照 CAFE_INGREDIENTS 宣告序",
    bakeLines.map((line) => `${line.id}x${line.units}`).join() === "flourx2,butterx1",
    JSON.stringify(bakeLines));
  check("配方明細與 recipe 完全一致(全菜單逐項比對)",
    menuItems(Object.values(CAFE_RESEARCH_IDS)).every((item) => {
      const lines = cafeRecipeLines(item);
      const fromRecipe = Object.entries(item.recipe).filter(([, n]) => (n ?? 0) > 0);
      return lines.length === fromRecipe.length
        && lines.every((line) => (item.recipe as Record<string, number>)[line.id] === line.units);
    }));
  check("空配方/壞輸入回空陣列,不丟例外",
    cafeRecipeLines(null).length === 0 && cafeRecipeLines({ recipe: {} }).length === 0
    && cafeRecipeLines({ recipe: { coffee_bean: -3 } as never }).length === 0);

  // ===========================================================================
  // 三、原料 → 商品(取代 usedIn)
  // ===========================================================================
  const beanUseBase = cafeIngredientMenuUse("coffee_bean", baseMenu);
  check("開張期咖啡豆只餵「招牌美式咖啡」——名稱與菜單逐字相同",
    beanUseBase.length === 1 && beanUseBase[0].name === coffee.name && beanUseBase[0].units === 4,
    JSON.stringify(beanUseBase));
  check("🔴 舊 usedIn 寫的「美式咖啡」根本不是菜單上的名字(這就是對不起來的原因)",
    coffee.name === "招牌美式咖啡" && !baseMenu.some((item) => item.name === "美式咖啡"));
  const milkUseBase = cafeIngredientMenuUse("milk", baseMenu);
  check("開張期沒有任何商品用到牛奶(舊 usedIn 卻寫著「拿鐵」)", milkUseBase.length === 0);
  const fullMenu = menuItems(Object.values(CAFE_RESEARCH_IDS));
  const milkUseFull = cafeIngredientMenuUse("milk", fullMenu);
  check("研發完之後牛奶餵得到的品項全部真的在菜單上",
    milkUseFull.length > 0
    && milkUseFull.every((use) => fullMenu.some((item) => item.id === use.id && item.name === use.name)),
    JSON.stringify(milkUseFull));
  check("原料 → 商品的用量與商品 → 原料完全互為反向",
    CAFE_INGREDIENTS.every((ingredient) => cafeIngredientMenuUse(ingredient.id, fullMenu).every((use) => {
      const item = fullMenu.find((entry) => entry.id === use.id)!;
      return cafeRecipeLines(item).some((line) => line.id === ingredient.id && line.units === use.units);
    })));
  check("未知原料 id 回空陣列", cafeIngredientMenuUse("not_an_ingredient", fullMenu).length === 0);

  // ===========================================================================
  // 四、缺貨歸因用的是**實際 missing 紀錄**
  // ===========================================================================
  // 拉花拿鐵同時吃咖啡豆與牛奶 ⇒ 同一個品項可能缺不同的料,靜態配方分不出來。
  const latte = fullMenu.find((item) => item.researchId === CAFE_RESEARCH_IDS.latteArt)!;
  const noMilk = checkoutCafeOrder({ coffee_bean: 99, milk: 0 }, latte);
  const noBean = checkoutCafeOrder({ coffee_bean: 0, milk: 99 }, latte);
  check("同一個品項:缺牛奶時 missing = milk、缺咖啡豆時 missing = coffee_bean",
    noMilk.missing.join() === "milk" && noBean.missing.join() === "coffee_bean",
    `${noMilk.missing.join()} / ${noBean.missing.join()}`);

  const day = (n: number, missedBy: Record<string, Record<string, number>>): CafeSalesDay => ({
    day: n, sold: {}, missed: {}, missedBy, revenue: 0, ingredientCost: 0,
    served: 0, refused: 0, settled: true, restocked: true, restockCost: 0,
  });
  const sales: CafeSalesDay[] = [
    day(1, { [latte.id]: { milk: 3 } }),
    day(2, { [latte.id]: { coffee_bean: 5, milk: 1 }, [coffee.id]: { coffee_bean: 2 } }),
  ];
  const latteCauses = cafeItemShortageCauses(sales, latte.id, fullMenu, CAFE_SALES_WINDOW_DAYS);
  check("拉花拿鐵的缺貨歸因 = 咖啡豆 5 單 + 牛奶 4 單(跨日累加、由多到少)",
    latteCauses.map((c) => `${c.id}:${c.times}`).join() === "coffee_bean:5,milk:4",
    JSON.stringify(latteCauses));
  check("歸因同時告訴玩家「要補多少」= 次數 × 每份用量",
    latteCauses[0].units === 4 && latteCauses[0].unitsShort === 20
    && latteCauses[1].units === 1 && latteCauses[1].unitsShort === 4,
    JSON.stringify(latteCauses));
  const coffeeCauses = cafeItemShortageCauses(sales, coffee.id, fullMenu, CAFE_SALES_WINDOW_DAYS);
  check("同一份紀錄裡,招牌美式咖啡只歸因到咖啡豆(不會沾到拉花拿鐵的牛奶)",
    coffeeCauses.length === 1 && coffeeCauses[0].id === "coffee_bean" && coffeeCauses[0].times === 2,
    JSON.stringify(coffeeCauses));
  check("沒有紀錄就回空陣列——不拿配方猜(舊存檔的退路由面板自己走 cafeRecipeLines)",
    cafeItemShortageCauses([], coffee.id, fullMenu).length === 0
    && cafeItemShortageCauses([day(1, {})], coffee.id, fullMenu).length === 0
    && cafeItemShortageCauses(sales, "cafe_menu_not_a_thing", fullMenu).length === 0);
  const blame = cafeIngredientShortageBlame(sales, CAFE_SALES_WINDOW_DAYS);
  check("原料層級的歸因 = 各品項加總(咖啡豆 7、牛奶 4)",
    blame.coffee_bean === 7 && blame.milk === 4 && Object.keys(blame).length === 2,
    JSON.stringify(blame));
  check("窗口只看最近 N 日", cafeIngredientShortageBlame(sales, 1).coffee_bean === 7);
  check("壞資料(非物件、負數、NaN)一律當 0,不丟例外",
    Object.keys(cafeIngredientShortageBlame([
      { ...day(3, { [coffee.id]: { coffee_bean: -4 } }) },
      { ...day(4, {}), missedBy: "oops" as never },
    ])).length === 0);

  // ===========================================================================
  // 五、🔴 端對端:tick 真的把 missing 寫進 missedBy,而且對得上顯示層
  // ===========================================================================
  placeCafeStarterSet();
  Object.assign(state.cafe, defaultCafe(), {
    open: true,
    standingOrders: {},
    // 咖啡豆刻意歸零 ⇒ 咖啡類一定做不出來;其餘備到夠 ⇒ 只有咖啡豆會被歸因。
    stock: { coffee_bean: 0, milk: 400, flour: 400, butter: 400, cat_can: 400, pet_fresh: 400 },
    popularity: 100,
  });
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    at(0, hour);
    cafeHourlyPass(hour);
  }
  const record = state.cafe.sales[state.cafe.sales.length - 1];
  const totalMissed = Object.values(record.missed).reduce((sum, n) => sum + n, 0);
  check("跑完一天真的有品項做不出來(咖啡豆歸零)", totalMissed > 0, JSON.stringify(record.missed));
  check("🔴 每一筆 missed 都有對應的 missedBy 歸因,且歸因的原料只有咖啡豆",
    Object.keys(record.missed).every((itemId) => {
      const row = record.missedBy?.[itemId];
      return !!row && Object.keys(row).join() === "coffee_bean";
    }),
    JSON.stringify(record.missedBy));
  check("🔴 歸因次數與 missed 次數逐項相等(記的就是實際那幾單)",
    Object.entries(record.missed).every(([itemId, times]) => record.missedBy?.[itemId]?.coffee_bean === times),
    `${JSON.stringify(record.missed)} vs ${JSON.stringify(record.missedBy)}`);
  const liveMenu = menuItems(state.cafe.completed);
  const liveCoffee = cafeItemShortageCauses(state.cafe.sales, coffee.id, liveMenu);
  check("面板讀到的歸因 = 咖啡豆,且算得出要補多少單位",
    liveCoffee.length === 1 && liveCoffee[0].id === "coffee_bean"
    && liveCoffee[0].unitsShort === liveCoffee[0].times * 4,
    JSON.stringify(liveCoffee));
  check("賣得出去的品項不會被誤記歸因(寵物小點原料充足)",
    !record.missedBy?.["cafe_menu_pet_snack"] && (record.sold["cafe_menu_pet_snack"] ?? 0) > 0,
    JSON.stringify(record.sold));

  // ===========================================================================
  // 六、存檔:選填欄位 + 消毒預設值,**不升 SAVE_VERSION**
  // ===========================================================================
  check("SAVE_VERSION 沒有被升(缺貨歸因是選填欄位)", SAVE_VERSION === 10, String(SAVE_VERSION));
  const roundTrip = sanitizeCafeState(JSON.parse(JSON.stringify(state.cafe)), state.gameMs);
  check("存檔往返後 missedBy 逐欄相同",
    JSON.stringify(roundTrip.sales.at(-1)?.missedBy) === JSON.stringify(record.missedBy));
  const legacy = sanitizeCafeState({
    open: true,
    sales: [{ day: 1, sold: { a: 1 }, missed: { a: 2 }, revenue: 10, ingredientCost: 4, served: 1, refused: 2, settled: true }],
  }, state.gameMs);
  check("舊存檔(沒有 missedBy)⇒ 補成 {},其餘欄位不受影響",
    JSON.stringify(legacy.sales[0].missedBy) === "{}" && legacy.sales[0].missed.a === 2);
  const dirty = sanitizeCafeState({
    open: true,
    sales: [{ day: 1, sold: {}, missed: {}, missedBy: { ok: { coffee_bean: 3, bad: "x" }, empty: {}, junk: 7 } }],
  }, state.gameMs);
  check("手改存檔的壞資料被消毒:非數字丟掉、整層空掉的鍵不留",
    JSON.stringify(dirty.sales[0].missedBy) === JSON.stringify({ ok: { coffee_bean: 3 } }),
    JSON.stringify(dirty.sales[0].missedBy));

  // ===========================================================================
  // 七、面板真的把這三件事畫出來了(顯示層的硬斷言)
  // ===========================================================================
  const panel = src("components", "CafePanel.vue");
  check("面板的銷售排行有讀 cafeItemShortageCauses(缺貨 → 原料)",
    panel.includes("cafeItemShortageCauses") && panel.includes("itemShortage(row.id)"));
  check("面板的排行列會顯示「要補多少單位」", panel.includes("unitsShort"));
  check("面板的常備量有讀 cafeIngredientMenuUse(原料 → 品項)",
    panel.includes("cafeIngredientMenuUse") && panel.includes("ingredientUse(item.id)"));
  check("面板的常備量有顯示「害幾單做不出來」", panel.includes("cafeIngredientShortageBlame") && panel.includes("order-blame"));
  check("🔴 常備量輸入的上限不再低於內建建議值(咖啡豆 130)",
    /MAX_STANDING_ORDER\s*=\s*(\d+)/.test(panel)
    && Number(panel.match(/MAX_STANDING_ORDER\s*=\s*(\d+)/)![1])
      >= Math.max(...CAFE_INGREDIENTS.map((item) => item.defaultStandingOrder)),
    panel.match(/MAX_STANDING_ORDER\s*=\s*(\d+)/)?.[0]);

  // ===========================================================================
  // 八、零 RNG / 純函式界線
  // ===========================================================================
  check("本批新增的算式沒有用到 Math.random", randomCalls === 0, `呼叫 ${randomCalls} 次`);
  const cafeCode = codeOnly(src("sim", "cafe.ts"));
  check("cafe.ts 仍然不 import state / 不 addMoney / 不推日誌",
    !/from\s+"\.\.\/store"/.test(cafeCode) && !/\baddMoney\b/.test(cafeCode) && !/\brt\.log\b/.test(cafeCode));
  check("歸因函式是純函式:同樣輸入兩次結果相同、且不改動輸入",
    JSON.stringify(cafeItemShortageCauses(sales, latte.id, fullMenu))
      === JSON.stringify(latteCauses)
    && JSON.stringify(sales[1].missedBy) === JSON.stringify({
      [latte.id]: { coffee_bean: 5, milk: 1 }, [coffee.id]: { coffee_bean: 2 },
    }));
  check("基礎菜單的每一項都有非空配方(不會出現無本生意)",
    CAFE_BASE_MENU_ITEMS.every((item) => cafeRecipeLines(item).length > 0));
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
