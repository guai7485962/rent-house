/**
 * CAFE-12:常備訂單、補貨、消耗與生鮮損耗的純函式測試。
 *
 * 本項刻意不接 state / tick / addMoney,所以這支測試也完全不需要啟動模擬——
 * 全部是「給輸入、比對輸出」。零 RNG 與零副作用兩件事各有一條硬斷言把關。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CAFE_INGREDIENTS } from "../src/content/cafeIngredients";
import {
  applySpoilage,
  consumeStock,
  CROWD_MULTIPLIER_FLOOR,
  CROWD_PENALTY_PER_SHORTAGE,
  dailyDemand,
  getCafeIngredient,
  cafeStorageCapacity,
  CAFE_STORAGE_BASE,
  CAFE_STORAGE_MAX,
  CAFE_STORAGE_PER_POINT,
  restockPlan,
  RESTOCK_RESERVE_RATIO,
  SPOILAGE_FREE_UNITS,
  SPOILAGE_RATE,
  suggestedStandingOrders,
} from "../src/sim/cafe";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.123456789; };

try {
  // -------------------------------------------------------------------------
  // 一、原料資料本身
  // -------------------------------------------------------------------------
  const ids = CAFE_INGREDIENTS.map((item) => item.id);
  check("原料 id 不重複", new Set(ids).size === ids.length);
  // 「用途」不再是這裡的手寫字串:2026-08-08 移除了過期的 `usedIn`,
  // 商品 ↔ 原料的唯一事實來源是 `CafeMenuItem.recipe`(對照由
  // `cafe-recipe-clarity-test.ts` 逐項把關)。這裡只剩「每種原料都有中文名」。
  check("每種原料都有中文名", CAFE_INGREDIENTS.every((item) => item.name.trim().length > 0));
  check("單價都是正整數", CAFE_INGREDIENTS.every((item) => Number.isInteger(item.unitPrice) && item.unitPrice > 0));
  check("建議常備量都是正整數", CAFE_INGREDIENTS.every((item) => Number.isInteger(item.defaultStandingOrder) && item.defaultStandingOrder > 0));
  check("生鮮與乾貨各至少一種", CAFE_INGREDIENTS.some((item) => item.perishable) && CAFE_INGREDIENTS.some((item) => !item.perishable));
  // 🔴 重設計 P1 重訂了全部六個 unitPrice(舊值是「每客攤提價」,不是「一份商品的料錢」)。
  // 這裡不再釘死具體數字——單價本來就是會跟著配方一起調的平衡旋鈕,釘數字只會逼人
  // 每次調平衡就順手改測試。要釘的是**不變式**:配方成本必須撐得起 45～60% 的毛利帶,
  // 那條由 `cafe-per-guest-test.ts` 逐品項把關。這裡只釘價格結構本身的合理性。
  check("原料 id 一個都沒變(舊存檔的 standingOrders / stock 才轉得過來)",
    ids.join() === "coffee_bean,milk,flour,butter,cat_can,pet_fresh", ids.join());
  check("生鮮的建議常備量都在零損耗水位內(偷懶路線必須維持可行)",
    CAFE_INGREDIENTS.filter((item) => item.perishable)
      .every((item) => Math.floor((item.defaultStandingOrder - SPOILAGE_FREE_UNITS) * SPOILAGE_RATE) === 0),
    CAFE_INGREDIENTS.filter((i) => i.perishable).map((i) => `${i.id}:${i.defaultStandingOrder}`).join(" "));
  check("未知原料 id 查不到定義", getCafeIngredient("not_an_ingredient") === undefined);

  // -------------------------------------------------------------------------
  // 二、今日需求
  // -------------------------------------------------------------------------
  const demand30 = dailyDemand(30);
  // P1 之後真正的扣料是逐位顧客照配方扣的;`dailyDemand()` 退居「面板預估」用途,
  // 所以這裡改釘「估算值與配方的量級對得上」而不是舊的範例表數字。
  check("30 位客人的預估消耗與配方量級相符(咖啡豆最大宗、生鮮最少)",
    demand30.coffee_bean > demand30.flour && demand30.flour > demand30.butter
    && demand30.coffee_bean === Math.ceil(30 * getCafeIngredient("coffee_bean")!.perGuest),
    JSON.stringify(demand30));
  check("需求全是非負整數(浮點噪音已修掉)",
    Object.values(demand30).every((n) => Number.isInteger(n) && n >= 0));
  check("零客流 → 零需求", Object.values(dailyDemand(0)).every((n) => n === 0));
  check("負數客流不報錯也不產生負需求", Object.values(dailyDemand(-5)).every((n) => n === 0));
  check("客流越多需求單調不減",
    CAFE_INGREDIENTS.every((item) => dailyDemand(60)[item.id] >= dailyDemand(30)[item.id]));

  // -------------------------------------------------------------------------
  // 三、補貨:錢夠的情況
  // -------------------------------------------------------------------------
  const orders = suggestedStandingOrders();
  check("建議常備量涵蓋全部原料", Object.keys(orders).length === CAFE_INGREDIENTS.length);

  const FULL_COST = CAFE_INGREDIENTS.reduce((sum, item) => sum + item.defaultStandingOrder * item.unitPrice, 0);
  // 整櫃成本是回歸基準值,不是設計目標:改了單價/常備量就該一起改這裡並確認差異合理。
  check("建議常備量的整櫃進貨成本為 1444", FULL_COST === 1444, `= ${FULL_COST}`);

  const rich = restockPlan(orders, {}, 100_000);
  check("錢夠時補滿到常備量", CAFE_INGREDIENTS.every((item) => rich.stock[item.id] === item.defaultStandingOrder));
  check("錢夠時總花費等於整櫃成本", rich.totalCost === FULL_COST, `${rich.totalCost}`);
  check("錢夠時不標記補不滿", rich.underfunded === false && rich.missingUnits === 0 && rich.fulfillment === 1);
  check("補貨明細順序照 CAFE_INGREDIENTS 宣告序", rich.lines.map((l) => l.id).join() === ids.join());
  check("moneyAfter = money − totalCost", rich.moneyAfter === 100_000 - FULL_COST);

  const topUp = restockPlan(orders, { ...orders }, 100_000);
  check("庫存已滿時不進貨", topUp.totalCost === 0 && topUp.lines.length === 0 && topUp.underfunded === false);

  // -------------------------------------------------------------------------
  // 四、補貨:錢不夠 → 只補得起多少補多少(設計文件 §5.2)
  // -------------------------------------------------------------------------
  const boundary = restockPlan(orders, {}, FULL_COST);
  check("錢剛好等於所需時仍能補滿", boundary.totalCost === FULL_COST && boundary.underfunded === false && boundary.moneyAfter === 0);

  const oneShort = restockPlan(orders, {}, FULL_COST - 1);
  check("錢差一元時補不滿但不超支", oneShort.underfunded === true && oneShort.totalCost <= FULL_COST - 1 && oneShort.moneyAfter >= 0);

  // 預算取「跑得完保底輪、但補不滿」的區間(保底輪合計 $722、整櫃 $1444)
  const POOR_BUDGET = 800;
  const poor = restockPlan(orders, {}, POOR_BUDGET);
  check("錢不夠時總花費不超過持有金錢", poor.totalCost <= POOR_BUDGET, `${poor.totalCost}`);
  check("錢不夠時 moneyAfter 不為負", poor.moneyAfter >= 0, `${poor.moneyAfter}`);
  check("錢不夠時不產生負庫存", Object.values(poor.stock).every((n) => n >= 0));
  check("錢不夠時買到的量不超過需求", poor.lines.every((line) => line.bought >= 0 && line.bought <= line.want));
  check("錢不夠時標記 underfunded 供 CAFE-13 推日誌", poor.underfunded === true && poor.missingUnits > 0 && poor.fulfillment < 1);
  // 保底輪的價值:單輪貪婪配額會讓清單末尾整批掛零,兩段式讓每種原料都拿得到量
  check("兩段式配額讓錢不夠時每種原料都補到一些", poor.lines.every((line) => line.bought > 0),
    JSON.stringify(poor.lines.map((l) => `${l.id}:${l.bought}/${l.want}`)));
  check("保底比例是常備量的一半", RESTOCK_RESERVE_RATIO === 0.5);
  // 預算 900 足夠跑完整輪保底(722)但不足以補滿(1444):驗證保底輪優先於補滿輪
  const mid = restockPlan(orders, {}, 900);
  check("預算夠跑完保底輪時,每種原料都先補到常備量的一半",
    mid.underfunded === true && mid.totalCost <= 900 && mid.lines.every((line) => {
      const item = getCafeIngredient(line.id)!;
      return line.bought >= Math.min(line.want, Math.ceil(item.defaultStandingOrder * RESTOCK_RESERVE_RATIO));
    }),
    JSON.stringify(mid.lines.map((l) => `${l.id}:${l.bought}/${l.want}`)));

  const broke = restockPlan(orders, {}, 0);
  check("身無分文時不進貨、不欠債、不變負庫存",
    broke.totalCost === 0 && broke.moneyAfter === 0 && broke.underfunded === true
    && Object.values(broke.stock).every((n) => n >= 0));
  check("負數金錢視同 0 元", restockPlan(orders, {}, -9999).totalCost === 0);

  // 掃描式性質檢查:任何預算下都不得超支、不得負庫存、買量不得超過需求
  let sweepOk = true;
  for (let money = 0; money <= 1200; money++) {
    const plan = restockPlan(orders, {}, money);
    if (plan.totalCost > money || plan.moneyAfter < 0) { sweepOk = false; break; }
    if (Object.values(plan.stock).some((n) => n < 0)) { sweepOk = false; break; }
    if (plan.lines.some((line) => line.bought > line.want)) { sweepOk = false; break; }
    const recomputed = plan.lines.reduce((sum, line) => sum + line.bought * line.unitPrice, 0);
    if (recomputed !== plan.totalCost) { sweepOk = false; break; }
  }
  check("預算 0～1200 全掃:不超支、不負庫存、不超買、金額自洽", sweepOk);

  // -------------------------------------------------------------------------
  // 五、補貨:玩家還沒設常備訂單
  // -------------------------------------------------------------------------
  const noOrders = restockPlan({}, {}, 5000);
  check("空的 standingOrders 不報錯且不進貨",
    noOrders.lines.length === 0 && noOrders.totalCost === 0 && noOrders.underfunded === false && noOrders.fulfillment === 1);
  check("空的 standingOrders 保留既有庫存", restockPlan({}, { milk: 3 }, 5000).stock.milk === 3);
  check("未知原料 id 的常備訂單被忽略且不報錯",
    restockPlan({ not_an_ingredient: 99 }, {}, 5000).totalCost === 0);
  check("壞資料(負數/NaN/小數)一律夾成非負整數",
    restockPlan({ milk: -5 }, {}, 5000).totalCost === 0
    && restockPlan({ milk: Number.NaN }, {}, 5000).totalCost === 0
    && restockPlan({ milk: 4.7 }, {}, 5000).stock.milk === 4
    && restockPlan(orders, { milk: -3 }, 5000).stock.milk === orders.milk);

  const srcOrders = { milk: 10 };
  const srcStock = { milk: 2 };
  restockPlan(srcOrders, srcStock, 5000);
  check("補貨不修改輸入物件", srcOrders.milk === 10 && srcStock.milk === 2);

  // -------------------------------------------------------------------------
  // 五之二、🔴 A 批:後場容量上限(`options.capacity`)
  // -------------------------------------------------------------------------
  const richMoney = 1_000_000;
  const uncapped = restockPlan(orders, {}, richMoney);
  check("省略 capacity = 無上限:每一欄都與 A 批之前逐字相同(回歸釘子)",
    uncapped.capacity === null && uncapped.capped === false && uncapped.cappedUnits === 0
    && uncapped.stored === 0);
  const wantTotal = uncapped.lines.reduce((sum, line) => sum + line.want, 0);

  const tight = restockPlan(orders, {}, richMoney, { capacity: 100 });
  const boughtTight = tight.lines.reduce((sum, line) => sum + line.bought, 0);
  check("容量夾住時只買得到容量那麼多", boughtTight === 100 && tight.capped === true
    && tight.cappedUnits === wantTotal - 100, `bought=${boughtTight}`);
  check("被容量夾住不算 underfunded(那一欄仍然只指錢不夠)",
    tight.underfunded === false && tight.totalCost <= richMoney);
  check("容量剛好放得下建議常備量時完全不夾(預設值 310 < 底量 360)",
    restockPlan(orders, {}, richMoney, { capacity: 360 }).capped === false);

  const overStocked = restockPlan(orders, { milk: 500 }, richMoney, { capacity: 100 });
  check("stored > capacity 時只是補不進來,**絕不倒扣既有庫存**",
    overStocked.stock.milk === 500 && overStocked.stored >= 500
    && overStocked.lines.every((line) => line.bought === 0));
  check("容量 0 也不會產生負庫存或負花費",
    restockPlan(orders, {}, richMoney, { capacity: 0 }).totalCost === 0);
  check("壞掉的 capacity 一律夾成非負整數",
    restockPlan(orders, {}, richMoney, { capacity: Number.NaN }).capacity === 0
    && restockPlan(orders, {}, richMoney, { capacity: -50 }).capacity === 0);
  check("容量與金錢同時吃緊時,總花費仍不超支",
    restockPlan(orders, {}, 300, { capacity: 50 }).totalCost <= 300);
  check("後場容量公式:0 點 = 底量、每點 +40、有硬上限",
    cafeStorageCapacity(0) === CAFE_STORAGE_BASE
    && cafeStorageCapacity(14) === CAFE_STORAGE_BASE + 14 * CAFE_STORAGE_PER_POINT
    && cafeStorageCapacity(99999) === CAFE_STORAGE_MAX);

  // -------------------------------------------------------------------------
  // 六、消耗與缺貨
  // -------------------------------------------------------------------------
  const stocked = restockPlan(orders, {}, 100_000).stock;
  const served = consumeStock(stocked, demand30);
  check("庫存充足時無缺貨、客流不打折",
    served.shortages.length === 0 && served.crowdMultiplier === 1 && served.fulfillment === 1);
  check("消耗量正確從庫存扣除",
    CAFE_INGREDIENTS.every((item) => served.stock[item.id] === stocked[item.id] - demand30[item.id]));
  check("消耗不修改輸入庫存", stocked.coffee_bean === orders.coffee_bean, `${stocked.coffee_bean}`);

  const empty = consumeStock({}, demand30);
  check("空庫存時全部缺貨且不產生負庫存",
    empty.shortages.length === CAFE_INGREDIENTS.length && Object.values(empty.stock).every((n) => n >= 0));
  check("缺貨客流折扣夾在下界 0.7,不是失敗狀態",
    empty.crowdMultiplier === CROWD_MULTIPLIER_FLOOR && CROWD_MULTIPLIER_FLOOR === 0.7);
  check("空庫存時滿足率為 0", empty.fulfillment === 0);

  const oneMissing = consumeStock({ ...stocked, milk: 0 }, demand30);
  check("單一原料見底只判定該項缺貨",
    oneMissing.shortages.join() === "milk", oneMissing.shortages.join());
  check("缺一種原料的客流折扣為 0.92",
    Math.abs(oneMissing.crowdMultiplier - (1 - CROWD_PENALTY_PER_SHORTAGE)) < 1e-9,
    `${oneMissing.crowdMultiplier}`);
  check("部分缺貨仍會把剩下的庫存用掉,不是全有全無",
    oneMissing.stock.coffee_bean === stocked.coffee_bean - demand30.coffee_bean && oneMissing.stock.milk === 0);

  const partial = consumeStock({ ...stocked, milk: 4 }, demand30);
  check("庫存少於需求時只消耗到見底", partial.stock.milk === 0 && partial.shortages.includes("milk"));
  check("缺貨判定看的是需求而不是庫存是否為 0", consumeStock({ ...stocked, milk: 9 }, demand30).shortages.length === 0);
  check("零需求時不判缺貨、不打折",
    consumeStock({}, {}).shortages.length === 0 && consumeStock({}, {}).crowdMultiplier === 1 && consumeStock({}, {}).fulfillment === 1);
  check("缺貨清單順序照 CAFE_INGREDIENTS 宣告序", empty.shortages.join() === ids.join());

  // -------------------------------------------------------------------------
  // 七、生鮮損耗
  // -------------------------------------------------------------------------
  const hoard: Record<string, number> = {};
  for (const item of CAFE_INGREDIENTS) hoard[item.id] = 30;
  const spoiled = applySpoilage(hoard);
  check("乾貨一單位都不損耗",
    CAFE_INGREDIENTS.filter((item) => !item.perishable).every((item) => spoiled.stock[item.id] === 30));
  check("生鮮會損耗",
    CAFE_INGREDIENTS.filter((item) => item.perishable).every((item) => spoiled.stock[item.id] < 30));
  check("損耗公式 = floor((庫存 − 免損耗額度) × 損耗率)",
    spoiled.stock.milk === 30 - Math.floor((30 - SPOILAGE_FREE_UNITS) * SPOILAGE_RATE), `${spoiled.stock.milk}`);
  check("損耗明細只列生鮮", spoiled.lines.every((line) => getCafeIngredient(line.id)?.perishable === true));
  check("損耗金額 = 數量 × 單價(僅供日誌,不扣款)",
    spoiled.lines.every((line) => line.wastedValue === line.spoiled * (getCafeIngredient(line.id)?.unitPrice ?? 0))
    && spoiled.totalWastedValue === spoiled.lines.reduce((sum, l) => sum + l.wastedValue, 0));
  check("損耗不修改輸入庫存", hoard.milk === 30);

  // 設計意圖:照設計文件的常備量玩,生鮮完全不會壞
  const byTheBook = applySpoilage(restockPlan(orders, {}, 100_000).stock);
  check("照設計文件 §5.2 的常備量設定,損耗恆為 0(偷懶不該被懲罰)",
    byTheBook.totalSpoiled === 0 && byTheBook.lines.length === 0);
  check("免損耗額度以內完全不壞", applySpoilage({ milk: SPOILAGE_FREE_UNITS }).totalSpoiled === 0);

  // 冪等性/收斂:這是「每日」函式,連套兩次 = 過了兩天,但有硬性下界。
  // 起始量必須高到「壞完一天還在免損耗額度之上」,否則第二天本來就不該再壞
  // (P3 調高 SPOILAGE_RATE 之後,一天就會掉到收斂上界)。
  const HOARD = SPOILAGE_FREE_UNITS * 3;
  const day1 = applySpoilage({ milk: HOARD });
  const day2 = applySpoilage(day1.stock);
  check("連套兩次 = 兩天,第二次從更小的基數再損耗一次",
    day2.stock.milk < day1.stock.milk && day1.stock.milk < HOARD,
    `${HOARD} → ${day1.stock.milk} → ${day2.stock.milk}`);
  check("連續套用永不產生負庫存",
    day2.stock.milk >= 0 && applySpoilage(applySpoilage(applySpoilage({ milk: 1 }).stock).stock).stock.milk === 1);

  let converge: Record<string, number> = { milk: 300, butter: 100, pet_fresh: 5, coffee_bean: 40 };
  for (let i = 0; i < 200; i++) converge = applySpoilage(converge).stock;
  const settled = applySpoilage(converge);
  // 收斂上界 = freeUnits + ceil(1/rate) − 1(P3 預設 23 + 2 − 1 = 24):
  // 公式推出來的,不是寫死的數字——`floor` 讓「超額 × rate < 1」的那一刻停住。
  const CONVERGE_CEIL = SPOILAGE_FREE_UNITS + Math.ceil(1 / SPOILAGE_RATE) - 1;
  check("反覆套用會收斂並停住,不會把櫃子清空(誤呼叫的保險絲)",
    settled.totalSpoiled === 0 && converge.milk === CONVERGE_CEIL && converge.butter === CONVERGE_CEIL && converge.pet_fresh === 5,
    JSON.stringify(converge));
  check("收斂後再套用一次完全不變", JSON.stringify(settled.stock) === JSON.stringify(converge));
  check("乾貨在 200 次套用後數量完全不變", converge.coffee_bean === 40);

  check("大型冷藏那類的參數可調低損耗(CAFE-14 用,本項不實作)",
    applySpoilage({ milk: 30 }, { rate: 0 }).totalSpoiled === 0
    && applySpoilage({ milk: 30 }, { freeUnits: 100 }).totalSpoiled === 0
    && applySpoilage({ milk: 30 }, { rate: 0.05 }).totalSpoiled < applySpoilage({ milk: 30 }).totalSpoiled);
  check("損耗壞資料防護",
    applySpoilage({ milk: -5 }).totalSpoiled === 0
    && applySpoilage({ milk: Number.NaN }).totalSpoiled === 0
    && applySpoilage({ milk: 30 }, { rate: Number.NaN }).totalSpoiled === applySpoilage({ milk: 30 }).totalSpoiled);

  // -------------------------------------------------------------------------
  // 八、決定性與零副作用
  // -------------------------------------------------------------------------
  const runOnce = () => {
    const plan = restockPlan(orders, { milk: 3, flour: 1 }, 617);
    const use = consumeStock(plan.stock, dailyDemand(23));
    const rot = applySpoilage(use.stock);
    return JSON.stringify({ plan, use, rot });
  };
  check("同輸入連跑兩次結果逐欄完全相同", runOnce() === runOnce());
  check("整條補貨→消耗→損耗鏈路仍不超支",
    restockPlan(orders, { milk: 3, flour: 1 }, 617).totalCost <= 617);

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sim", "cafe.ts"), "utf8");
  // 註解裡本來就會寫到「不呼叫 addMoney」「零 Math.random」,先把註解剝掉再掃程式碼本體
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("cafe.ts 程式碼本體零 Math.random", !code.includes("Math.random"));
  check("cafe.ts 不呼叫 addMoney(扣款留給 CAFE-13)", !code.includes("addMoney"));
  check("cafe.ts 不 import state / tick(純函式,零副作用)",
    !/from\s+"\.\/gameState"/.test(code) && !/from\s+"\.\/tick"/.test(code) && !/from\s+"\.\/economy"/.test(code));
  check("所有純函式呼叫期間零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
