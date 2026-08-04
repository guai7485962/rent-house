/**
 * 咖啡廳的補貨 / 消耗 / 損耗計算(CAFE-12,設計文件 §5.2),
 * 以及客流公式與日結敘事的純算式(CAFE-13,設計文件 §5.1 §5.5)。
 *
 * ## 這個檔案刻意「不做」的事
 *
 * 比照 CAFE-07~10 的成功切法:**全部是接收參數的純函式,不接 state、不接 tick**。
 *
 * - **不 import `state`**、不讀寫任何全域。所有輸入由 caller 給,所有輸出是新物件。
 * - **不呼叫 `addMoney()`**。`restockPlan()` 只回傳「應該扣多少」,實際扣款由日結 pass
 *   統一做(金錢進出唯一入口仍是 `economy.ts` 的 `addMoney`)。
 * - **不推日誌**。缺貨、補不滿、損耗只是回傳值上的欄位;本檔只把它們**組成句子**
 *   (`cafeDailyLine()`),真正把句子推進 `rt.log` 的是日結 pass。
 * - **不碰 `tick.ts`**。
 *
 * 結果:本檔零副作用 ⇒ 對 `scripts/balance-snapshot.json` 天然零漂移。
 * `scripts/cafe-supply-test.ts` 有硬斷言掃描本檔原始碼,確保這條界線不會被後續項目磨掉。
 *
 * ## CAFE-13 為什麼把日結 pass 放在 `tick.ts` 而不是這裡
 *
 * 日結 pass 必須讀 `state`、呼叫 `addMoney`、推日誌——三件事都會打破上面那條界線。
 * 既有的 `cafeGuestPass()` 就住在 `tick.ts`(見 `scripts/cafe-state-test.ts` 的 import),
 * 咖啡廳的 pass 一律放 `tick.ts`、算式一律放本檔,是已經成立的切法。
 *
 * ## 零 RNG
 *
 * 全檔沒有 `Math.random()`。補貨、消耗、損耗是決定性算術;客流吃 caller 給的
 * 天氣與星期(`weatherForDay()` 是 splitmix32、`week.ts` 讀日曆,兩者都零 RNG);
 * 敘事選句用本檔的 `lineHash()`(FNV-1a,抄 `cafeGuests.ts` 的作法)。
 *
 * ## 迭代次序
 *
 * 所有輸出的原料順序一律照 `CAFE_INGREDIENTS` 的宣告順序,**不用 `Object.keys()`
 * 的插入序**(存檔往返、玩家改常備量都會改變插入序,那是不穩定的)。
 *
 * ## 設計意圖:常備訂單是「可以設一次就三個月不管」
 *
 * 設計文件 §5.2 把偷懶定位成「有代價但可接受的選擇,而不是失敗狀態」。
 * 因此本檔所有旋鈕都往溫和的方向調,兩個方向的代價都設了硬性下界:
 *
 * - 設太低 → 缺貨 → 客流打折,但 `CROWD_MULTIPLIER_FLOOR = 0.7`,**最慘也只掉三成**。
 * - 設太高 → 生鮮損耗,但 `SPOILAGE_FREE_UNITS = 23` 且損耗無條件捨去,
 *   庫存會**收斂到 24 就停住,永遠不會被損耗歸零**(24 = 生鮮的建議常備量)。
 */
import { CAFE_INGREDIENTS, type CafeIngredient, type CafeIngredientId } from "../content/cafeIngredients";
import {
  CAFE_MAX_SIGN_LEVEL,
  CAFE_OPENING_COST,
  CAFE_SIGNBOARD_IDS,
  CAFE_UPGRADES,
  CAFE_UPGRADE_IDS,
  type CafeUpgrade,
} from "../content/cafeUpgrades";
import {
  CAFE_RESEARCH,
  CAFE_RESEARCH_IDS,
  type CafeMenuAudience,
  type CafeResearchDefinition,
  type CafeResearchTrack,
} from "../content/cafeResearch";
// 型別匯入(編譯後完全抹除),本檔仍然沒有任何 runtime 相依。
import type { CafeSalesDay, CafeState } from "../types";
import type { WeatherId } from "./weather";

export {
  CAFE_MAX_SIGN_LEVEL,
  CAFE_OPENING_COST,
  CAFE_SIGNBOARD_IDS,
  CAFE_UPGRADES,
  CAFE_UPGRADE_IDS,
} from "../content/cafeUpgrades";
export { CAFE_RESEARCH, CAFE_RESEARCH_IDS } from "../content/cafeResearch";

// ---------------------------------------------------------------------------
// 旋鈕
// ---------------------------------------------------------------------------

/**
 * 錢不夠時的「保底比例」:第一輪先讓每種原料補到常備量的一半,第二輪才補滿。
 * 單輪配額會讓清單末尾的原料整批掛零(當日該品項完全缺貨);兩段式讓缺的是
 * 「廣度」而不是「深度」,符合「不是懲罰,是敘事」。
 */
export const RESTOCK_RESERVE_RATIO = 0.5;

/** 每有一種原料當日見底,客流乘上的折扣。 */
export const CROWD_PENALTY_PER_SHORTAGE = 0.08;

/**
 * 客流折扣的硬性下界。六種原料全缺也只會是 0.7——
 * 缺貨是「今天生意差一點」,不是失敗狀態。
 */
export const CROWD_MULTIPLIER_FLOOR = 0.7;

/**
 * 生鮮的免損耗額度:這個量以內完全不會壞(一天內就用得完的量)。
 *
 * 🔴 **P3 從 15 調到 23,同時 `SPOILAGE_RATE` 從 0.1 調到 0.9。**
 * 這兩顆旋鈕必須一起看,推導如下(設計文件 §4.7「備太多反而虧」那條虧損管道)。
 *
 * ### 前提:P3 把進貨移到開店前,損耗的對象因此換了一個東西
 *
 * P1/P2 時代進貨在日結、且緊接著就損耗 ⇒ 損耗算的是**剛補滿的常備量**。
 * P3 之後進貨在 09:00、損耗在午夜 ⇒ 損耗算的是**打烊後真正剩下來的庫存**。
 * 語意從「你訂了多少」變成「你今晚放著沒用完多少」——這才是生鮮會壞的原因,
 * 也讓兩顆旋鈕第一次可以只針對「囤積」下手,而不會誤傷「訂得剛好」。
 *
 * ### 推導:一條不等式夾出唯一的取值帶
 *
 * 令免損耗額度 `F`、損耗率 `R`,損耗 = `floor(max(0, 剩餘 − F) × R)`。
 *
 * - **懶人路線必須零損耗**(§4.3.1):照 `CAFE_INGREDIENTS` 的建議常備量玩,
 *   三種生鮮都是 24;開張期菜單根本用不到牛奶與寵物鮮食,**夜間剩餘就是 24**。
 *   ⇒ 硬性條件 `(24 − F) × R < 1`。
 * - **備太多必須是負值**(§4.7):易腐品多備 50% ⇒ 常備量 36、夜間剩餘約 29~36。
 *   要吃掉開張期 +$95 的淨利,每日損耗價值得跨過 $100 這個量級。
 *
 * 第一條把 `F` 頂到 23(再高就等於免疫),於是 `R < 1`;`R` 取 0.9 時
 * 多備 50% 的每日損耗 = 牛奶 11 + 奶油 5 + 寵物鮮食 11 單位 ≈ **$138/日**,
 * 足以把開張期打成明確負值。`R` 再往下調(0.5 → $78、0.75 → $112)就補不回
 * 淨利,所以 0.9 不是「調到滿」,是這條不等式的解。
 *
 * ### 語意:生鮮只有一天的保鮮期
 *
 * `F = 23` ≈ 成熟期一天的尖峰用量(奶油 21、貓罐頭以外的生鮮都在這之下),
 * `R = 0.9` = 超出一天用量的部分,隔夜幾乎全壞。這對牛奶／奶油／寵物鮮食
 * 完全合乎直覺,不是為了數字硬湊的懲罰。
 *
 * 收斂上界 = `F + ceil(1/R) − 1` = **24**,剛好等於生鮮的建議常備量:
 * 玩家囤到天上去、然後完全不管,庫存也只會慢慢掉回 24 就停住,**永遠不歸零**。
 */
export const SPOILAGE_FREE_UNITS = 23;

/** 超出免損耗額度的部分,每日損耗比例(無條件捨去)。推導見 `SPOILAGE_FREE_UNITS`。 */
export const SPOILAGE_RATE = 0.9;

// ---------------------------------------------------------------------------
// 小工具(全部決定性)
// ---------------------------------------------------------------------------

/** 存檔/玩家輸入可能是 NaN 或非數字;取不到就用預設值(比照 `gameState.finiteOr`)。 */
const finiteOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 存檔/玩家輸入可能是負數、小數或 NaN;一律夾成非負整數。 */
function safeUnits(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * 先修掉浮點噪音再取整。IEEE754 下 `0.4 × 30 === 12.000000000000002`,
 * 直接 `ceil` 會得到 13,設計文件 §5.2 的範例表就對不上了。
 * 小數位遠多於本檔用到的精度,不會改變任何刻意的取整行為。
 */
const quantize = (value: number) => Number(value.toFixed(6));

const ingredientById = new Map<string, CafeIngredient>(CAFE_INGREDIENTS.map((item) => [item.id, item]));

/** 依 id 取原料定義;未知 id 回 undefined(補貨與損耗都會直接略過它)。 */
export function getCafeIngredient(id: string): CafeIngredient | undefined {
  return ingredientById.get(id);
}

/** CAFE-15 的常備量預設值;玩家沒設過就用這份。 */
export function suggestedStandingOrders(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of CAFE_INGREDIENTS) out[item.id] = item.defaultStandingOrder;
  return out;
}

// ---------------------------------------------------------------------------
// 1. 補貨
// ---------------------------------------------------------------------------

export interface RestockLine {
  id: string;
  name: string;
  unitPrice: number;
  /** 補到常備量所需的數量(常備量 − 現有庫存)。 */
  want: number;
  /** 實際買到的數量;錢不夠時 < want。 */
  bought: number;
  /** `bought × unitPrice`。 */
  cost: number;
}

export interface RestockPlan {
  /** 只列 `want > 0` 的原料,順序照 `CAFE_INGREDIENTS` 宣告序。 */
  lines: RestockLine[];
  /** 總花費。**保證 `<= money`,且 `>= 0`**。本項不扣款,扣款是 CAFE-13 的事。 */
  totalCost: number;
  /** 補完後的庫存;未列在常備訂單裡的既有庫存原封不動保留。 */
  stock: Record<string, number>;
  /** 錢不夠而少買的單位總數;`> 0` 代表沒補滿。 */
  missingUnits: number;
  /** 錢不夠導致沒補滿(給 CAFE-13 判斷要不要推「今天只補得起⋯」那則日誌)。 */
  underfunded: boolean;
  /** 實際補到的比例(0~1);沒有任何需求時為 1。給日誌措辭用。 */
  fulfillment: number;
  /** `money − totalCost`,方便 CAFE-13 對帳;**保證非負**。 */
  moneyAfter: number;
}

/**
 * 依常備訂單算出今日補貨計畫。**不扣款、不改動任何輸入。**
 *
 * 錢不夠時的行為(設計文件 §5.2「只補得起多少補多少」):
 *
 * 1. 預算 = `max(0, floor(money))`。
 * 2. **第一輪(保底)**:照 `CAFE_INGREDIENTS` 宣告序,每種原料先補到
 *    `ceil(常備量 × RESTOCK_RESERVE_RATIO)` 的水位。
 * 3. **第二輪(補滿)**:再照同一順序把剩下的補滿。
 * 4. 每一步都只買 `floor(剩餘預算 / 單價)` 買得起的整數量。
 *
 * ⇒ 總花費永遠 `<= money`,庫存永遠不會變負,`moneyAfter` 永遠 `>= 0`。
 * 玩家帳上 0 元也只是「今天沒進貨」,不會欠債。
 *
 * @param standingOrders 原料 id → 每日補到的常備量。空物件(玩家還沒設)完全合法。
 * @param stock          現有庫存。
 * @param money          目前持有金錢。
 */
export function restockPlan(
  standingOrders: Readonly<Record<string, number>>,
  stock: Readonly<Record<string, number>>,
  money: number,
): RestockPlan {
  const nextStock: Record<string, number> = {};
  for (const [id, units] of Object.entries(stock ?? {})) nextStock[id] = safeUnits(units);

  interface Draft { item: CafeIngredient; want: number; bought: number }
  const drafts: Draft[] = [];
  for (const item of CAFE_INGREDIENTS) {
    // 未知 id(手改存檔、被移除的原料)沒有單價可用,直接不參與補貨。
    const target = safeUnits((standingOrders ?? {})[item.id]);
    const have = nextStock[item.id] ?? 0;
    const want = Math.max(0, target - have);
    if (want > 0) drafts.push({ item, want, bought: 0 });
  }

  // 預算取整數:單價都是整數,買不到「半個單位」,也避免浮點餘額累積。
  const startMoney = typeof money === "number" && Number.isFinite(money) ? Math.max(0, money) : 0;
  let budget = Math.floor(startMoney);
  const buy = (draft: Draft, upTo: number) => {
    const remaining = Math.min(upTo, draft.want - draft.bought);
    if (remaining <= 0) return;
    const affordable = Math.floor(budget / draft.item.unitPrice);
    const units = Math.max(0, Math.min(remaining, affordable));
    if (units <= 0) return;
    draft.bought += units;
    budget -= units * draft.item.unitPrice;
  };

  // 第一輪:保底水位(已高於保底水位的原料,這一輪買 0)
  for (const draft of drafts) {
    const target = safeUnits((standingOrders ?? {})[draft.item.id]);
    const have = nextStock[draft.item.id] ?? 0;
    const reserve = Math.ceil(target * RESTOCK_RESERVE_RATIO);
    buy(draft, Math.max(0, reserve - have));
  }
  // 第二輪:補滿
  for (const draft of drafts) buy(draft, draft.want);

  const lines: RestockLine[] = drafts.map((draft) => ({
    id: draft.item.id,
    name: draft.item.name,
    unitPrice: draft.item.unitPrice,
    want: draft.want,
    bought: draft.bought,
    cost: draft.bought * draft.item.unitPrice,
  }));
  for (const line of lines) nextStock[line.id] = (nextStock[line.id] ?? 0) + line.bought;

  const totalCost = lines.reduce((sum, line) => sum + line.cost, 0);
  const wantUnits = lines.reduce((sum, line) => sum + line.want, 0);
  const boughtUnits = lines.reduce((sum, line) => sum + line.bought, 0);
  const missingUnits = wantUnits - boughtUnits;
  return {
    lines,
    totalCost,
    stock: nextStock,
    missingUnits,
    underfunded: missingUnits > 0,
    fulfillment: wantUnits === 0 ? 1 : boughtUnits / wantUnits,
    moneyAfter: startMoney - totalCost,
  };
}

// ---------------------------------------------------------------------------
// 2. 消耗
// ---------------------------------------------------------------------------

export interface ConsumeLine {
  id: string;
  name: string;
  /** 今日需求量。 */
  demand: number;
  /** 實際消耗量;缺貨時 < demand。 */
  used: number;
}

export interface ConsumeResult {
  /** 只列 `demand > 0` 的原料,順序照 `CAFE_INGREDIENTS` 宣告序。 */
  lines: ConsumeLine[];
  /** 消耗後的庫存;**永遠不會有負值**。 */
  stock: Record<string, number>;
  /** 當日見底(供不應求)的原料 id,順序照宣告序。 */
  shortages: string[];
  /** 需求被滿足的比例(0~1);沒有需求時為 1。給日誌措辭用。 */
  fulfillment: number;
  /**
   * 缺貨造成的當日客流折扣,`1 − 缺貨種數 × CROWD_PENALTY_PER_SHORTAGE`,
   * 夾在 `CROWD_MULTIPLIER_FLOOR`(0.7)以上。由 CAFE-13 乘進客流公式。
   */
  crowdMultiplier: number;
}

/**
 * 扣掉今日消耗。**不改動任何輸入**,回傳新的庫存物件。
 *
 * 缺貨的後果只有兩個,而且都只是回傳值:
 * - `shortages` — CAFE-13 據此推一則「客人撲空」日誌。
 * - `crowdMultiplier` — CAFE-13 據此打折當日客流。
 *
 * 沒有罰款、沒有負庫存、沒有連鎖懲罰。
 *
 * @param demand 原料 id → 今日需求量,通常來自 `dailyDemand(客流)`。
 */
export function consumeStock(
  stock: Readonly<Record<string, number>>,
  demand: Readonly<Record<string, number>>,
): ConsumeResult {
  const nextStock: Record<string, number> = {};
  for (const [id, units] of Object.entries(stock ?? {})) nextStock[id] = safeUnits(units);

  const lines: ConsumeLine[] = [];
  const shortages: string[] = [];
  for (const item of CAFE_INGREDIENTS) {
    const want = safeUnits((demand ?? {})[item.id]);
    if (want <= 0) continue;
    const have = nextStock[item.id] ?? 0;
    const used = Math.min(have, want);
    nextStock[item.id] = have - used;
    lines.push({ id: item.id, name: item.name, demand: want, used });
    if (used < want) shortages.push(item.id);
  }

  const wantUnits = lines.reduce((sum, line) => sum + line.demand, 0);
  const usedUnits = lines.reduce((sum, line) => sum + line.used, 0);
  return {
    lines,
    stock: nextStock,
    shortages,
    fulfillment: wantUnits === 0 ? 1 : usedUnits / wantUnits,
    crowdMultiplier: Math.max(
      CROWD_MULTIPLIER_FLOOR,
      1 - shortages.length * CROWD_PENALTY_PER_SHORTAGE,
    ),
  };
}

/**
 * 客流 → 各原料的今日需求量。CAFE-13 的橋接點:配方知識留在 content 層,
 * 日結 pass 只要給它「今天來了幾個人」。
 *
 * `ceil(客流 × perGuest)` 無條件進位——寧可多算一點,也不要出現
 * 「客人來了但一單位原料都沒消耗」的怪狀態。30 位客人時的結果剛好
 * 重現設計文件 §5.2 範例表的今日消耗欄(咖啡豆 12 / 牛奶 9 / 麵粉 4 / 貓罐頭 3)。
 */
export function dailyDemand(guestCount: number): Record<string, number> {
  const guests = safeUnits(guestCount);
  const out: Record<string, number> = {};
  for (const item of CAFE_INGREDIENTS) out[item.id] = guests <= 0 ? 0 : Math.ceil(quantize(guests * item.perGuest));
  return out;
}

// ---------------------------------------------------------------------------
// 3. 生鮮損耗
// ---------------------------------------------------------------------------

export interface SpoilageOptions {
  /** 免損耗額度;CAFE-14 的「大型冷藏」投資項可以調高它(本項不實作投資)。 */
  freeUnits?: number;
  /** 損耗比例;同上,大型冷藏可以調低它。 */
  rate?: number;
}

export interface SpoilageLine {
  id: string;
  name: string;
  /** 損耗數量(> 0 才會出現在陣列裡)。 */
  spoiled: number;
  /** 損耗的進貨價值,只給日誌措辭用;**本項不扣款**。 */
  wastedValue: number;
}

export interface SpoilageResult {
  /** 只列真的有損耗的原料,順序照 `CAFE_INGREDIENTS` 宣告序。 */
  lines: SpoilageLine[];
  /** 損耗後的庫存;**永遠不會有負值**。 */
  stock: Record<string, number>;
  totalSpoiled: number;
  totalWastedValue: number;
}

/**
 * 生鮮的每日損耗。**乾貨(`perishable: false`)永遠不損耗**——設計文件 §5.2 明訂。
 *
 * 公式:`損耗 = floor(max(0, 庫存 − freeUnits) × rate)`
 *
 * ### 為什麼要有 `freeUnits` 這個免損耗額度
 *
 * 這條公式有一個刻意設計的**下界**:當 `庫存 − freeUnits < 1/rate`(預設 23 + 1.12)時,
 * `floor` 會讓損耗歸 0,庫存就停在那裡不再減少。所以
 *
 * - 反覆套用會**收斂到 24 並停住,永遠不會把櫃子清空**;
 * - 照 `CAFE_INGREDIENTS` 的建議常備量玩(三種生鮮都是 24),損耗恆為 0;
 * - 只有玩家刻意把生鮮囤到 25 以上,才開始每天壞。
 *
 * ### P3:呼叫點的語意換了(算式一行沒改)
 *
 * 進貨從日結移到開店前(09:00)之後,日結呼叫本函式時傳進來的是
 * **打烊後真正剩下的庫存**,不再是「剛補滿的常備量」。
 * ⇒ 訂得剛好的人夜裡幾乎沒有存貨可壞;囤積的人才會天天丟東西。
 *
 * ### 冪等性:這是「每日」函式,不是「載入」函式
 *
 * 連套兩次 = 過了兩天,第二次會從更小的基數再壞一次——這是正確語意,不是 bug。
 * 但它**不該被載入流程呼叫**(否則玩家每讀一次檔就少一點庫存)。
 * 上面的下界是這件事的保險絲:就算有人誤呼叫很多次,庫存也只會收斂到 24,不會歸零。
 * 正確的呼叫點只有一個:日結 pass,每個遊戲日一次。
 */
export function applySpoilage(
  stock: Readonly<Record<string, number>>,
  options: SpoilageOptions = {},
): SpoilageResult {
  const freeUnits = safeUnits(options.freeUnits ?? SPOILAGE_FREE_UNITS);
  const rawRate = options.rate ?? SPOILAGE_RATE;
  const rate = typeof rawRate === "number" && Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : SPOILAGE_RATE;

  const nextStock: Record<string, number> = {};
  for (const [id, units] of Object.entries(stock ?? {})) nextStock[id] = safeUnits(units);

  const lines: SpoilageLine[] = [];
  for (const item of CAFE_INGREDIENTS) {
    if (!item.perishable) continue; // 乾貨:一單位都不會壞
    const have = nextStock[item.id] ?? 0;
    const spoiled = Math.floor(quantize(Math.max(0, have - freeUnits) * rate));
    if (spoiled <= 0) continue;
    nextStock[item.id] = have - spoiled;
    lines.push({ id: item.id, name: item.name, spoiled, wastedValue: spoiled * item.unitPrice });
  }

  return {
    lines,
    stock: nextStock,
    totalSpoiled: lines.reduce((sum, line) => sum + line.spoiled, 0),
    totalWastedValue: lines.reduce((sum, line) => sum + line.wastedValue, 0),
  };
}

// ===========================================================================
// CAFE-13:客流公式、客單價、人氣與日結敘事(全部仍是純函式)
// ===========================================================================

// ---------------------------------------------------------------------------
// 4. 設備能力(CAFE-14 的讀取面)
// ---------------------------------------------------------------------------

/**
 * CAFE-14 的五個投資 id 與價格由 `content/cafeUpgrades.ts` 提供；本段把已購買 id
 * 轉成日結能力。購買命令在下方回傳純交易結果，不直接碰全域 state 或金流。
 */

/** 大型冷藏的免損耗額度倍率與損耗率折扣。 */
export const CAFE_COLD_STORAGE_FREE_MULT = 2;
export const CAFE_COLD_STORAGE_RATE_MULT = 0.5;

/**
 * 🔴 **P4a:產能不再是「買機器買出來的一個數字」,而是席次與員工的交集**(設計文件 §4.7)。
 *
 * ```
 * 日產能 = min( 外帶底量 + 席次 × 迴轉率 , 員工數 × 每人每日杯數 )
 * ```
 *
 * P4a 之前是 `CAFE_BASE_CAPACITY 26 + CAFE_CAPACITY_PER_MACHINE 14 = 40` 的硬天花板,
 * 那個天花板正是設計文件 §4.7 說「追不上收租」的三個天花板之一:
 * 產能 40 × 客單價 $38 = 日營收上限 $1,520,扣完成本淨利只有淨租金的 36%。
 *
 * 新公式讓**兩條腿都得自己長**:
 *
 * - 只買椅子不雇人 → 員工那條夾住(一個人一天做不出 100 杯);
 * - 只雇人不買椅子 → 席次那條夾住(沒地方坐,而且薪水照付 ⇒ 直接虧錢)。
 *
 * 這也是設計文件 §4.7 第五條虧損管道「過度擴張」得以成立的機制基礎。
 */

/**
 * 一個席位一天可以翻幾輪。
 *
 * 11 個營業小時(`CAFE_BUSINESS_HOURS`)除以 5 ≈ 每位內用客佔用 2.2 小時,
 * 這與 `cafeGuests.ts` 給內用客的停留時間同一個量級,不是憑空取的倍數。
 */
export const CAFE_SEAT_TURNOVER = 5;

/**
 * 零席次也做得到的外帶量(設計文件 §4.6「全店零席次 = 純外帶店,能活但收入明顯較差」)。
 *
 * 沒有這條下界的話,玩家把椅子全拆掉 ⇒ 產能 0 ⇒ 咖啡廳直接歸零,
 * 那就變成「拆家具 = 失敗狀態」,違反本作一貫的「有代價但不是失敗狀態」。
 * 10 杯/日 大約是固定開銷的一半,活得下去但明顯不賺 —— 正是設計要的手感。
 */
export const CAFE_TAKEAWAY_CAPACITY = 10;

/**
 * 一位員工一天處理得了的杯數。
 *
 * 設計文件 §4.7 原文寫 35,但 **26 才是對的**,理由是它同時要當**開張期的平衡錨**。
 *
 * P4a 之前產能是 `CAFE_BASE_CAPACITY = 26`,那個常數一直兼任兩個角色:
 * 「產能上限」與「開張期客流的錨」。開張期人氣滿 + 氛圍加成下基礎客流本來就有 30 人,
 * 全靠這個 26 夾住,P3 的損耗與虧損試算都是踩在這個數字上校準的。
 *
 * P4a 換成 `min(席次腿, 員工腿)` 後,一位店員若能做 35 杯就不再夾得住 ⇒ 開張期
 * 日客流 24.5 → 29.5、淨利 +$99 → +$195,連帶讓 P3 剛做成立的「備太多反而虧」
 * 退回 −$35 → **+$74**(不再虧)。那是使用者需求 3 的東西,不能默默退回去。
 *
 * 損耗旋鈕沒有餘裕可以補救:懶人路線零損耗的硬性條件是 `(24 − FREE_UNITS) × RATE < 1`
 * 且 `RATE ≤ 1`,(23, 0.9) 已是唯一解。所以要還原的是**產能錨**本身。
 *
 * 26 同時滿足兩端:
 * - 開張期(1 位店員)產能 = 26,與 P4a 之前的 `CAFE_BASE_CAPACITY` 完全相同 ⇒ 校準不變
 * - 名店期(5 位店員)產能 = 130 ≥ 該階段客流 129.9 ⇒ 成長曲線仍然走得完
 * 代價是中後期要多雇一點人才吃得下同樣的客流——那正是 §4.7 想要的經營張力。
 */
export const CAFE_STAFF_CUPS_PER_DAY = 26;

/**
 * 第二台咖啡機讓**每位員工**每日多做 10 杯。
 *
 * 為什麼改成「加乘員工」而不是像 P4a 之前那樣加一個固定的 +14 產能:
 * 新公式裡固定加成會在店還小的時候被席次夾掉、完全沒有感覺;
 * 而「機器讓每個人手不用排隊等萃取」本來就是這台機器在現實裡的作用。
 * 名店期 5 人 ⇒ +50 杯/日,$18,000 的投資才配得上它在設備清單上的位置。
 */
export const CAFE_MACHINE_CUPS_BONUS = 10;

/** 每位**額外**員工的日薪(設計文件 §4.7 原文)。首位店員的薪資已含在 `CAFE_FIXED_COST` 裡。 */
export const CAFE_STAFF_WAGE = 260;

/**
 * 額外員工的人數上限。
 *
 * 8 位(連首位共 9 位)的產能是 9 × 45 = 405 杯/日,遠高於招牌 Lv4 + 滿氛圍
 * 撐得起的客流(約 135 人),所以它**不是平衡旋鈕,是防呆**:擋住手改存檔
 * 或面板連點把薪資灌成天文數字。
 */
export const CAFE_MAX_EXTRA_STAFF = 8;

export interface CafeCapability {
  /** 招牌等級,無招牌 = 1,最高 `CAFE_MAX_SIGN_LEVEL`。 */
  signLevel: number;
  /** 產能上限(當日客流的硬天花板)= `min(seatCapacity, staffCapacity)`。 */
  capacity: number;
  /**
   * 席次那條腿。`null` = caller 沒告訴我們席次(面板、舊呼叫端)⇒ 這一輪不讓席次成為瓶頸。
   * 席次是 `placements` 的狀態,本檔不 import state,只能由 caller 餵進來。
   */
  seatCapacity: number | null;
  /** 員工那條腿 = `staffCount × cupsPerStaff`。 */
  staffCapacity: number;
  /** 總員工數,**含開張費已包含的首位店員**(所以永遠 >= 1)。 */
  staffCount: number;
  /** 每位員工每日杯數(第二台咖啡機會加成)。 */
  cupsPerStaff: number;
  /** 額外員工的日薪合計(首位不計,他在 `CAFE_FIXED_COST` 裡)。 */
  dailyWage: number;
  /** 有沒有戶外座位(只在晴天生效)。 */
  outdoorSeats: boolean;
  /** 直接餵給 `applySpoilage()` 的損耗參數。 */
  spoilage: SpoilageOptions;
}

export interface CafeCapabilityContext {
  /**
   * 內用席次數,由 caller 從 `sim/placements.ts` 的 `cafeSeatSpots().length` 取得。
   * **省略 = 不知道**(不是 0):`seatCapacity` 回 `null`、產能只由員工那條腿決定。
   * 這讓還沒接線的呼叫端(例如 P4b 才會改的 `CafePanel.vue`)看到的仍是一個合理的數字,
   * 而不是「零席次 = 產能 10」這種會誤導玩家的假天花板。
   */
  seats?: number;
  /** 額外雇用的員工數(不含首位店員),來自 `state.cafe.extraStaff`。 */
  extraStaff?: number;
}

/** 總員工數 = 開張費已含的首位店員 + 額外雇用;壞資料一律夾成 `1 ~ 1 + 上限`。 */
export function cafeStaffCount(extraStaff: unknown = 0): number {
  return 1 + Math.min(CAFE_MAX_EXTRA_STAFF, Math.max(0, Math.trunc(finiteOr(extraStaff, 0))));
}

/**
 * 每日薪資支出。**只算額外員工**——首位店員的薪水在 `CAFE_FIXED_COST = 370` 裡
 * (該常數的語意由「水電雜支」擴充為「水電 + 首位店員」,設計文件 §4.9),
 * 所以開張期的試算維持 +$98 不變,第二位起才是真的多出來的 −$260/日。
 */
export function cafeStaffWage(extraStaff: unknown = 0): number {
  return (cafeStaffCount(extraStaff) - 1) * CAFE_STAFF_WAGE;
}

/** 席次那條腿:`外帶底量 + 席次 × 迴轉率`。負數/NaN 一律當 0 席。 */
export function cafeSeatCapacity(seats: unknown): number {
  return CAFE_TAKEAWAY_CAPACITY + Math.max(0, Math.trunc(finiteOr(seats, 0))) * CAFE_SEAT_TURNOVER;
}

/**
 * 由已購買的投資項與(選填的)席次／人力推出日結需要的能力。**純讀取,不改輸入。**
 *
 * 招牌等級改成「數已買的招牌 id」而不是 P4a 之前的 `1 + (有招牌 ? 1 : 0)`:
 * 三個 id 逐級解鎖(`buyCafeUpgrade()` 擋前置),所以數量就是等級差。
 * 手改存檔只塞了 Lv4 也只會得到 Lv2 —— 少算不會多算,對玩家沒有便宜可佔。
 */
export function cafeCapability(
  upgrades: readonly string[] = [],
  context: CafeCapabilityContext = {},
): CafeCapability {
  const owned = new Set(Array.isArray(upgrades) ? upgrades : []);
  const cold = owned.has(CAFE_UPGRADE_IDS.coldStorage);
  const signLevel = Math.min(
    CAFE_MAX_SIGN_LEVEL,
    1 + CAFE_SIGNBOARD_IDS.filter((id) => owned.has(id)).length,
  );
  const staffCount = cafeStaffCount(context.extraStaff);
  const cupsPerStaff = CAFE_STAFF_CUPS_PER_DAY
    + (owned.has(CAFE_UPGRADE_IDS.secondMachine) ? CAFE_MACHINE_CUPS_BONUS : 0);
  const staffCapacity = staffCount * cupsPerStaff;
  const seatCapacity = context.seats === undefined || context.seats === null
    ? null
    : cafeSeatCapacity(context.seats);
  return {
    signLevel,
    capacity: seatCapacity === null ? staffCapacity : Math.min(seatCapacity, staffCapacity),
    seatCapacity,
    staffCapacity,
    staffCount,
    cupsPerStaff,
    dailyWage: cafeStaffWage(context.extraStaff),
    outdoorSeats: owned.has(CAFE_UPGRADE_IDS.outdoorSeats),
    spoilage: cold
      ? { freeUnits: SPOILAGE_FREE_UNITS * CAFE_COLD_STORAGE_FREE_MULT, rate: SPOILAGE_RATE * CAFE_COLD_STORAGE_RATE_MULT }
      : {},
  };
}

// ---------------------------------------------------------------------------
// 5. 開張與一次性投資(CAFE-14)
// ---------------------------------------------------------------------------

const cafeUpgradeById = new Map<string, CafeUpgrade>(CAFE_UPGRADES.map((item) => [item.id, item]));

export function getCafeUpgrade(id: string): CafeUpgrade | undefined {
  return cafeUpgradeById.get(id);
}

/**
 * 純交易結果：CAFE-15 收到成功結果後，才以既有金流入口扣 `cost`、寫入 `cafe` 並存檔。
 * 失敗時 `cafe` 保持原參考、`moneyAfter` 保持原值，caller 不可能誤扣第二次。
 */
export interface CafeInvestmentResult {
  ok: boolean;
  reason?: string;
  cafe: CafeState;
  cost: number;
  moneyAfter: number;
  label?: string;
  /** 成功交易固定使用既有的咖啡廳分類，CAFE-15 可直接交給金流入口。 */
  category?: "cafe";
}

function rejectCafeInvestment(cafe: CafeState, money: number, reason: string): CafeInvestmentResult {
  return { ok: false, reason, cafe, cost: 0, moneyAfter: money };
}

function canAffordCafeInvestment(money: number, cost: number): boolean {
  return typeof money === "number" && Number.isFinite(money) && money >= cost;
}

/** 一次性開張；不自動開店、不改傳入物件，也不動尚未由玩家設定的常備訂單。 */
export function openCafe(cafe: CafeState, money: number): CafeInvestmentResult {
  if (cafe.open) return rejectCafeInvestment(cafe, money, "咖啡廳已經開張");
  if (!canAffordCafeInvestment(money, CAFE_OPENING_COST)) return rejectCafeInvestment(cafe, money, "金錢不足");
  return {
    ok: true,
    cafe: { ...cafe, open: true },
    cost: CAFE_OPENING_COST,
    moneyAfter: money - CAFE_OPENING_COST,
    label: "咖啡廳開張",
    category: "cafe",
  };
}

/**
 * 一次性、永久、不可退的投資；檢查順序與既有 `buyUpgrade()` 同構。
 *
 * P4a 多一道 `requires` 前置檢查(招牌必須逐級升)。既有五項都沒有 `requires`,
 * 所以它們的行為一個字都沒變。
 */
export function buyCafeUpgrade(cafe: CafeState, money: number, upgradeId: string): CafeInvestmentResult {
  const def = getCafeUpgrade(upgradeId);
  if (!def) return rejectCafeInvestment(cafe, money, "沒有這種咖啡廳投資");
  if (cafe.upgrades.includes(def.id)) return rejectCafeInvestment(cafe, money, "咖啡廳已經做過這項投資");
  if (!cafe.open) return rejectCafeInvestment(cafe, money, "咖啡廳尚未開張");
  if (def.requires && !cafe.upgrades.includes(def.requires)) {
    return rejectCafeInvestment(cafe, money, `需要先完成「${getCafeUpgrade(def.requires)?.name ?? def.requires}」`);
  }
  if (!canAffordCafeInvestment(money, def.price)) return rejectCafeInvestment(cafe, money, "金錢不足");
  return {
    ok: true,
    cafe: { ...cafe, upgrades: [...cafe.upgrades, def.id] },
    cost: def.price,
    moneyAfter: money - def.price,
    label: `咖啡廳投資:${def.name}`,
    category: "cafe",
  };
}

// ---------------------------------------------------------------------------
// 5b. P4a:雇用與資遣(設計文件 §4.7 §4.9)
// ---------------------------------------------------------------------------

/**
 * 雇用/資遣的純交易結果。
 *
 * **刻意不共用 `CafeInvestmentResult`**:那個型別帶著 `cost` / `moneyAfter`,
 * 會讓呼叫端以為雇人要先付一筆錢。員工**沒有一次性費用**,只有每天結算的
 * `CAFE_STAFF_WAGE`(由 `tick.ts` 的日結扣),所以這裡連 `money` 都不接。
 * 資遣同理:沒有遣散費,懲罰是「你之前白付的那些薪水」,不是一筆罰款。
 */
export interface CafeStaffResult {
  ok: boolean;
  reason?: string;
  /** 成功 = 新物件;失敗 = 原參考(caller 不可能誤寫入)。 */
  cafe: CafeState;
  /** 交易後的額外員工數。 */
  extraStaff: number;
  /** 交易後的每日薪資合計(只含額外員工)。 */
  dailyWage: number;
}

function cafeStaffResult(cafe: CafeState, ok: boolean, reason?: string): CafeStaffResult {
  return { ok, reason, cafe, extraStaff: cafeStaffCount(cafe.extraStaff) - 1, dailyWage: cafeStaffWage(cafe.extraStaff) };
}

/**
 * 多雇一位店員。**不扣款**——薪資是每日固定成本,不是一次性投資。
 *
 * 沒有「錢不夠不准雇」的檢查:錢不夠的懲罰在設計上是**縮水而不是禁止**
 * (設計文件 §4.9 的「不倒店」),薪資扣款走既有 `addMoney` 的下限 0,
 * 玩家不會欠債,但會眼睜睜看著現金被薪水吃光 —— 那才是「過度擴張」該有的體感。
 */
export function hireCafeStaff(cafe: CafeState): CafeStaffResult {
  if (!cafe.open) return cafeStaffResult(cafe, false, "咖啡廳尚未開張");
  const current = cafeStaffCount(cafe.extraStaff) - 1;
  if (current >= CAFE_MAX_EXTRA_STAFF) return cafeStaffResult(cafe, false, "已經達到人力上限");
  const next: CafeState = { ...cafe, extraStaff: current + 1 };
  return cafeStaffResult(next, true);
}

/** 資遣一位店員。首位店員是開張費附的,資遣不到 ⇒ 額外員工為 0 時直接拒絕。 */
export function fireCafeStaff(cafe: CafeState): CafeStaffResult {
  if (!cafe.open) return cafeStaffResult(cafe, false, "咖啡廳尚未開張");
  const current = cafeStaffCount(cafe.extraStaff) - 1;
  if (current <= 0) return cafeStaffResult(cafe, false, "吧台後至少要留一位店員");
  const next: CafeState = { ...cafe, extraStaff: current - 1 };
  return cafeStaffResult(next, true);
}

// ---------------------------------------------------------------------------
// 6. 研發資料與日數倒數(CAFE-16)
// ---------------------------------------------------------------------------

const cafeResearchById = new Map<string, CafeResearchDefinition>(CAFE_RESEARCH.map((item) => [item.id, item]));

/** 依穩定 id 取得研發資料；未知或已移除的 id 回 undefined。 */
export function getCafeResearch(id: string): CafeResearchDefinition | undefined {
  return cafeResearchById.get(id);
}

/**
 * 前置條件只讀 `completed` 與 `upgrades`，不把「正在研究」誤算成已完成。
 * CAFE-18 可直接用這個函式解釋按鈕為何尚未解鎖。
 */
export function cafeResearchRequirementsMet(
  cafe: Pick<CafeState, "completed" | "upgrades">,
  research: CafeResearchDefinition,
): boolean {
  const completed = new Set(Array.isArray(cafe.completed) ? cafe.completed : []);
  const upgrades = new Set(Array.isArray(cafe.upgrades) ? cafe.upgrades : []);
  return research.requiresResearch.every((id) => completed.has(id))
    && research.requiresUpgrades.every((id) => upgrades.has(id));
}

/** 已開張、前置已滿足，且尚未完成／進行中的可開始項目。順序固定為 content 宣告序。 */
export function availableCafeResearch(cafe: CafeState): CafeResearchDefinition[] {
  if (!cafe.open || cafe.research) return [];
  const completed = new Set(Array.isArray(cafe.completed) ? cafe.completed : []);
  return CAFE_RESEARCH.filter((item) => !completed.has(item.id)
    && cafeResearchRequirementsMet(cafe, item));
}

export interface CafeResearchStartResult extends CafeInvestmentResult {
  research?: CafeResearchDefinition;
}

function rejectCafeResearch(cafe: CafeState, money: number, reason: string): CafeResearchStartResult {
  return { ok: false, reason, cafe, cost: 0, moneyAfter: money };
}

/**
 * 支付一次性研發費並開始倒數。純交易：不扣全域金錢、不存檔、不修改輸入。
 * 成功結果由 CAFE-18 經既有 `addMoney(..., "cafe")` 寫入；失敗永遠零扣款。
 */
export function startCafeResearch(
  cafe: CafeState,
  money: number,
  researchId: string,
  currentDay: number,
): CafeResearchStartResult {
  const def = getCafeResearch(researchId);
  if (!def) return rejectCafeResearch(cafe, money, "沒有這項咖啡廳研發");
  if (!cafe.open) return rejectCafeResearch(cafe, money, "咖啡廳尚未開張");
  if (cafe.research) return rejectCafeResearch(cafe, money, "同時只能研發一項");
  if (cafe.completed.includes(def.id)) return rejectCafeResearch(cafe, money, "這項研發已經完成");
  if (!cafeResearchRequirementsMet(cafe, def)) return rejectCafeResearch(cafe, money, "研發前置條件尚未完成");
  if (!Number.isFinite(currentDay)) return rejectCafeResearch(cafe, money, "遊戲日期無效");
  if (!canAffordCafeInvestment(money, def.cost)) return rejectCafeResearch(cafe, money, "金錢不足");

  return {
    ok: true,
    cafe: {
      ...cafe,
      research: {
        id: def.id,
        startedDay: Math.floor(currentDay),
        days: def.days,
        invested: def.cost,
      },
    },
    cost: def.cost,
    moneyAfter: money - def.cost,
    label: `咖啡廳研發:${def.name}`,
    category: "cafe",
    research: def,
  };
}

/**
 * 剩餘日數採既有日序號倒數語意：開始當日顯示 N 天，`startedDay + days` 當日歸零。
 * 進行中資料保留開始時的 days 快照，日後調整 content 不會改寫玩家已支付的時程。
 */
export function cafeResearchDaysLeft(cafe: Pick<CafeState, "research">, currentDay: number): number | null {
  const active = cafe.research;
  if (!active) return null;
  const startedDay = Number.isFinite(active.startedDay) ? Math.floor(active.startedDay) : 0;
  const days = Number.isFinite(active.days) ? Math.max(1, Math.floor(active.days)) : 1;
  const today = Number.isFinite(currentDay) ? Math.floor(currentDay) : startedDay;
  return Math.max(0, startedDay + days - today);
}

export interface CafeResearchProgressResult {
  cafe: CafeState;
  completed: CafeResearchDefinition | null;
  daysLeft: number | null;
  changed: boolean;
  reason?: string;
}

/**
 * 依目前遊戲日結清到期研發。未到期回原 state 參考；到期只 append 一次並清空 active。
 * 未知 id 保留原資料、不擅自吞掉玩家投入，交由後續版本或 UI 顯示修復提示。
 */
export function advanceCafeResearch(cafe: CafeState, currentDay: number): CafeResearchProgressResult {
  const daysLeft = cafeResearchDaysLeft(cafe, currentDay);
  if (daysLeft === null) return { cafe, completed: null, daysLeft: null, changed: false };
  const def = getCafeResearch(cafe.research!.id);
  if (!def) {
    return { cafe, completed: null, daysLeft, changed: false, reason: "找不到進行中的研發資料" };
  }
  if (daysLeft > 0) return { cafe, completed: null, daysLeft, changed: false };

  const completed = cafe.completed.includes(def.id) ? [...cafe.completed] : [...cafe.completed, def.id];
  return {
    cafe: { ...cafe, research: null, completed },
    completed: def,
    daysLeft: 0,
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// 7. 客流(設計文件 §5.5)
// ---------------------------------------------------------------------------

/**
 * 每一級招牌帶來的基礎客流。
 *
 * 22 這個數字是回推出來的,不是拍腦袋:設計文件 §5.2 的範例表以「30 位客人」為基準,
 * 招牌 1 級 ≈ 22 人(剛開張、只夠打平多一點)。
 *
 * 🔴 **P4a:招牌從「有/沒有」變成 Lv1~Lv4,本常數一級不變,四級就是 22/44/66/88。**
 * 乘上長期平均乘數之後大約是 30 / 60 / 90 / 120 人/日,對應設計文件 §4.7 的
 * 開張期→名店期四階段。舊註解裡「2 級 ≈ 44 人但被產能夾到 40」那句已經不成立:
 * 產能不再是固定的 40,而是 `min(席次×迴轉率, 員工×杯數)`(見 `cafeCapability()`)。
 * ⇒ **光升招牌不會自己變成錢**,席次與人力沒跟上就只是多買了一塊招牌。
 */
export const CAFE_CROWD_PER_SIGN_LEVEL = 22;

/**
 * 天氣係數。取值刻意讓**加權平均 ≈ 1.00**:
 * `weatherForDay()` 的分佈是 晴 40 / 陰 25 / 雨 25 / 悶熱 10,
 * `0.4×1.15 + 0.25×1.00 + 0.25×0.70 + 0.10×1.05 = 0.99`。
 *
 * 也就是天氣是 ±15~30% 的**質地**,不是長期的系統性加稅或減稅——
 * 上面那句「招牌 1 級 ≈ 22 人」在長期平均下才會成立。
 *
 * 悶熱**高於** 1:躲進有冷氣的店裡喝冰的是加分而不是扣分(這與「雨天不想出門」不同),
 * 也讓「戶外座位」這個投資項的晴天加成不會變成唯一的天氣互動。
 */
export const CAFE_WEATHER_MULTIPLIER: Record<WeatherId, number> = {
  sunny: 1.15,
  cloudy: 1,
  rainy: 0.7,
  sweltering: 1.05,
};

/**
 * 星期係數,索引 0=週日 … 6=週六(對齊 `week.ts` 的 `weekdayOf()`)。
 * 同樣讓**七日平均 ≈ 1.00**:`(1.25×2 + 1.05 + 0.9×4) / 7 = 1.021`。
 * 平日冷清、週五回溫、週末最旺——這是咖啡廳最容易被玩家感知的一條節奏。
 */
export const CAFE_WEEKDAY_MULTIPLIER = [1.25, 0.9, 0.9, 0.9, 0.9, 1.05, 1.25] as const;

/** 戶外座位在晴天的額外客流加成(其他天氣一律無效,§5.4 原文)。 */
export const CAFE_OUTDOOR_SUNNY_BONUS = 0.15;

/** 人氣 0 → 100 對基礎客流的最大加成。 */
export const CAFE_POPULARITY_SWING = 0.25;

/**
 * 氛圍加成的最大幅度(+20%)。比照 `CAFE_POPULARITY_SWING` 的作法設硬上限,
 * 玩家不可能靠無限堆家具把客流拉爆。
 */
export const CAFE_AMBIANCE_SWING = 0.2;

/**
 * 吃滿 `CAFE_AMBIANCE_SWING` 所需的氛圍點數(一樓咖啡廳區域內家具的 `cozy + style` 總和)。
 *
 * 60 是回推的:開張贈品(吧台 + 三組桌椅)共 28 點 ⇒ 開張第一天就有 ×1.093,
 * 玩家立刻看得到「擺家具有用」;要吃滿還得再自己買約兩倍的量(大型貓跳台 8 點、
 * 手寫菜單板 4 點、甜點展示櫃 3 點…),所以家具目錄從開張到成熟期都有事做。
 */
export const CAFE_AMBIANCE_FULL_POINTS = 60;

/**
 * 氛圍乘數:`1 + min(1, 點數 / 上限點數) × CAFE_AMBIANCE_SWING`,夾在 1.0 ~ 1.2。
 *
 * ### 為什麼氛圍是「乘進客流」的第四個獨立係數,而不是併進 popularity 或 capacity
 *
 * - **不併進 `popularity`**:人氣的語意是「服務品質的動態結果」——由缺貨/補不滿驅動
 *   (`nextCafePopularity()`),會漲會跌。把靜態的家具加成混進去,會讓同一個數字同時
 *   代表「我今天有沒有把客人服務好」與「我買了幾張椅子」,兩種語意打架,玩家也讀不懂
 *   面板上的人氣為何突然跳一階。
 * - **不併進 `capacity`**:產能是硬上限,只在 `base > capacity` 時才有感。早期客流
 *   (招牌 1 級 ≈ 22 人 < 26)根本撞不到天花板,玩家擺再多家具都零回饋。
 * - 乘數則從開張第一天就有可見效果,而且與 `weatherMultiplier` / `weekdayMultiplier` /
 *   `popularityMultiplier` 結構完全對齊,推理與測試都不必特例。
 *
 * **空無一物時回 1.0**:沒家具不扣分,只是拿不到獎勵 —— 咖啡廳沒家具仍能營運,
 * 這是 CAFE-13 起就成立的既有行為,本函式不改它。
 */
export function cafeAmbianceMultiplier(points: number): number {
  const safePoints = Math.max(0, finiteOr(points, 0));
  const ratio = Math.min(1, safePoints / CAFE_AMBIANCE_FULL_POINTS);
  return 1 + ratio * CAFE_AMBIANCE_SWING;
}
export const CAFE_POPULARITY_MAX = 100;
/** 順利做完一天 +2(從 0 爬到滿要 50 天,「成熟期」名副其實)。 */
export const CAFE_POPULARITY_GAIN = 2;
/** 讓客人撲空 −4(掉得比爬得快,但兩週就補得回來)。 */
export const CAFE_POPULARITY_LOSS = 4;
/** 只是沒補滿貨(還沒真的缺貨) −1。 */
export const CAFE_POPULARITY_SOFT_LOSS = 1;

export interface CafeCrowdInput {
  weather: WeatherId;
  /** 0=週日 … 6=週六,直接餵 `weekdayOf(state.gameMs)`。 */
  weekday: number;
  signLevel: number;
  capacity: number;
  /** 0~100。 */
  popularity: number;
  outdoorSeats?: boolean;
  /**
   * 一樓咖啡廳區域內家具的 `cozy + style` 總和,由 caller 從
   * `sim/placements.ts` 的 `cafeAmbiancePoints()` 取得(擺放狀態是 state,不進本檔)。
   * 省略 = 0 = 乘數 1.0,所有既有呼叫端行為完全不變。
   */
  ambiancePoints?: number;
}

export interface CafeCrowdResult {
  /** 基礎客流(尚未被產能夾),已取整。 */
  base: number;
  /** 實際客流 = `min(base, capacity)`。 */
  guests: number;
  weatherMultiplier: number;
  weekdayMultiplier: number;
  popularityMultiplier: number;
  /** 家具氛圍乘數,1.0 ~ `1 + CAFE_AMBIANCE_SWING`。 */
  ambianceMultiplier: number;
  /** true = 今天被產能上限擋掉了客人(CAFE-15 可以據此提示「該加設備了」)。 */
  cappedByCapacity: boolean;
}

/**
 * 客流公式。**形狀直接抄 `coinLaundryIncome()`(`economy.ts:27`)的「設備數 × 係數 × 條件數」**,
 * 那條公式已經在正式版跑很久、經過平衡驗證。
 *
 * ```
 * 基礎客流 = 招牌等級 × 每級客流 × 天氣係數 × 星期係數 × (1 + 人氣加成) × 氛圍乘數 × 戶外座位係數
 * 實際客流 = min(基礎客流, 產能上限)
 * ```
 *
 * **零 RNG**:天氣由 caller 從 `weatherForDay()`(splitmix32)取得、星期由 `weekdayOf()`
 * 讀日曆,兩者都是現成的確定性來源;本函式本身只有乘法與取整。
 */
export function cafeCrowd(input: CafeCrowdInput): CafeCrowdResult {
  const weatherMultiplier = CAFE_WEATHER_MULTIPLIER[input.weather] ?? 1;
  const weekdayIndex = Number.isFinite(input.weekday) ? ((Math.trunc(input.weekday) % 7) + 7) % 7 : 0;
  const weekdayMultiplier = CAFE_WEEKDAY_MULTIPLIER[weekdayIndex];
  const popularity = Math.min(CAFE_POPULARITY_MAX, Math.max(0, finiteOr(input.popularity, 0)));
  const popularityMultiplier = 1 + (popularity / CAFE_POPULARITY_MAX) * CAFE_POPULARITY_SWING;
  const outdoor = input.outdoorSeats === true && input.weather === "sunny" ? 1 + CAFE_OUTDOOR_SUNNY_BONUS : 1;
  const ambianceMultiplier = cafeAmbianceMultiplier(input.ambiancePoints ?? 0);

  const signLevel = Math.max(0, finiteOr(input.signLevel, 1));
  const raw = signLevel * CAFE_CROWD_PER_SIGN_LEVEL * weatherMultiplier * weekdayMultiplier
    * popularityMultiplier * ambianceMultiplier * outdoor;
  const base = Math.max(0, Math.round(quantize(raw)));
  // 壞資料的退路取「只有首位店員」的產能:少算不會多算,玩家拿不到便宜。
  const capacity = Math.max(0, Math.floor(finiteOr(input.capacity, CAFE_STAFF_CUPS_PER_DAY)));
  const guests = Math.min(base, capacity);
  return { base, guests, weatherMultiplier, weekdayMultiplier, popularityMultiplier, ambianceMultiplier, cappedByCapacity: base > capacity };
}

// ---------------------------------------------------------------------------
// 8. 客單價(設計文件 §5.5)
// ---------------------------------------------------------------------------

/**
 * 基礎客單價。與六種原料的每客成本(≈ $16.6)一起看:毛利率約 54%,
 * 原料成本佔營收約 46%。刻意讓原料**佔得夠重**,常備訂單那條機制才有存在感。
 */
export const CAFE_BASE_TICKET = 36;

/**
 * 每日固定成本——設計文件 §5.5 的「淨利 = 營收 − 原料成本 − 固定成本」。
 *
 * 370 是解一個兩點聯立解出來的:成熟期(40 人)淨利要落在 $300–500,
 * 剛開張(26 人)又不能是負的、否則開店變成陷阱。
 *
 * 🔴 **P4a 語意擴充:「水電雜支」→「水電雜支 + 首位店員」**(設計文件 §4.9)。
 * 開張費 $22,000 已經包含第一位店員,吧台後永遠至少有一個人 ——
 * 否則「開張期 0 員工」的成長曲線第一格會出現「沒人能結帳」的洞。
 * **數值一毛不動**(370),所以開張期試算維持 +$98/日;
 * 第二位起才是額外的 `CAFE_STAFF_WAGE`,由 `cafeStaffWage()` 另外算。
 */
export const CAFE_FIXED_COST = 370;

/** 一份商品要用掉哪些原料、各幾單位(P1;設計文件 §4.1)。 */
export type CafeRecipe = Partial<Record<CafeIngredientId, number>>;

export interface CafeMenuItem {
  id: string;
  name: string;
  price: number;
  track: CafeResearchTrack;
  level: 0 | 1 | 2;
  audience: CafeMenuAudience;
  source: "base" | "research";
  researchId?: string;
  specialEvent: boolean;
  /** P1:一份要用掉哪些原料、各幾單位。逐位顧客結帳時照這張表扣料。 */
  recipe: CafeRecipe;
  /** P1:基礎熱門度。顧客選品的權重底數,再乘客群/天氣/時段修正(§4.2)。 */
  baseWeight: number;
}

/**
 * 開張即有的三條基本菜單。三項平均剛好是 $36，與 CAFE-13 已定標的基礎客單價一致；
 * 三條 track 也對齊既有原料的 brew／bake／pet，避免「尚未研發就完全不消耗某類原料」。
 *
 * P1 補上 `recipe` 與 `baseWeight`(設計文件 §4.1 §4.2):
 *
 * | 品項 | 售價 | 配方 | 原料成本 | 毛利率 |
 * |---|---|---|---|---|
 * | 招牌美式咖啡 | $34 | 咖啡豆 ×4 | $16 | 52.9% |
 * | 每日烘焙小點 | $36 | 麵粉 ×2 + 奶油 ×1 | $16 | 55.6% |
 * | 基礎寵物小點 | $38 | 貓罐頭 ×3 | $18 | 52.6% |
 *
 * `baseWeight` 50/30/20 是「一般咖啡廳的品項結構」:飲料為主、甜點次之、寵物餐最少。
 * 它只是底數,實際權重還會被客群偏好、天氣與時段乘出明顯的日內起伏(§4.2)。
 */
export const CAFE_BASE_MENU_ITEMS = [
  { id: "cafe_menu_house_coffee", name: "招牌美式咖啡", price: 34, track: "coffee", level: 0, audience: "daily", source: "base", specialEvent: false, recipe: { coffee_bean: 4 }, baseWeight: 50 },
  { id: "cafe_menu_daily_bake", name: "每日烘焙小點", price: 36, track: "bakery", level: 0, audience: "sweet", source: "base", specialEvent: false, recipe: { flour: 2, butter: 1 }, baseWeight: 30 },
  { id: "cafe_menu_pet_snack", name: "基礎寵物小點", price: 38, track: "pet", level: 0, audience: "pet_family", source: "base", specialEvent: false, recipe: { cat_can: 3 }, baseWeight: 20 },
] as const satisfies readonly CafeMenuItem[];

/**
 * 研發解鎖品的配方與熱門度(P1)。
 *
 * **刻意放在 `cafe.ts` 而不是 `content/cafeResearch.ts`**:配方是平衡數值、
 * 會跟著原料單價一起調,而 `cafeResearch.ts` 是「研發樹形狀」的純資料層。
 * 兩者變動頻率不同,混在一起會讓每次調平衡都動到解鎖前置條件那份表。
 *
 * 每一項的成本都對著售價算過,毛利率全部落在 45～60%
 * (`scripts/cafe-per-guest-test.ts` 逐項硬斷言):
 *
 * | 品項 | 售價 | 成本 | 毛利率 |
 * |---|---|---|---|
 * | 本日配方咖啡 | $36 | $16 | 55.6% |
 * | 今日手沖單品 | $42 | $20 | 52.4% |
 * | 經典拉花拿鐵 | $40 | $19 | 52.5% |
 * | 慢萃冰咖啡 | $39 | $20 | 48.7% |
 * | 每日磅蛋糕 | $38 | $19 | 50.0% |
 * | 奶油司康 | $38 | $19 | 50.0% |
 * | 貓咪造型餅乾 | $37 | $16 | 56.8% |
 * | 基礎寵物餐 | $38 | $17 | 55.3% |
 * | 寵物友善點心 | $38 | $16 | 57.9% |
 * | 寵物生日蛋糕 | $42 | $21 | 50.0% |
 *
 * `baseWeight` 一律低於同 track 的基礎品項:新品是「多一個選擇」,
 * 不是「把舊品項洗掉」——研發的價值在客單價與客群廣度,不在排擠。
 */
export const CAFE_RESEARCH_RECIPES: Record<string, { recipe: CafeRecipe; baseWeight: number }> = {
  [CAFE_RESEARCH_IDS.basicBrewing]: { recipe: { coffee_bean: 4 }, baseWeight: 26 },
  [CAFE_RESEARCH_IDS.pourOver]: { recipe: { coffee_bean: 5 }, baseWeight: 16 },
  [CAFE_RESEARCH_IDS.latteArt]: { recipe: { coffee_bean: 4, milk: 1 }, baseWeight: 22 },
  [CAFE_RESEARCH_IDS.coldBrew]: { recipe: { coffee_bean: 5 }, baseWeight: 18 },
  [CAFE_RESEARCH_IDS.baking]: { recipe: { flour: 3, butter: 1 }, baseWeight: 20 },
  [CAFE_RESEARCH_IDS.scone]: { recipe: { flour: 2, butter: 1, milk: 1 }, baseWeight: 16 },
  [CAFE_RESEARCH_IDS.catCookie]: { recipe: { flour: 2, butter: 1 }, baseWeight: 16 },
  [CAFE_RESEARCH_IDS.petMeals]: { recipe: { cat_can: 2, pet_fresh: 1 }, baseWeight: 14 },
  [CAFE_RESEARCH_IDS.petTreat]: { recipe: { cat_can: 1, pet_fresh: 2 }, baseWeight: 12 },
  [CAFE_RESEARCH_IDS.petBirthdayCake]: { recipe: { pet_fresh: 3, flour: 2 }, baseWeight: 8 },
};

/** 配方成本 = Σ 單位數 × 進貨單價。未知原料 id 一律當 0(不會憑空多出成本)。 */
export function cafeItemCost(item: Pick<CafeMenuItem, "recipe">): number {
  let cost = 0;
  for (const ingredient of CAFE_INGREDIENTS) {
    const units = safeUnits((item.recipe ?? {})[ingredient.id]);
    if (units > 0) cost += units * ingredient.unitPrice;
  }
  return cost;
}

/** 毛利率 =(售價 − 配方成本)/ 售價。售價 <= 0 時回 0,不產生 NaN/Infinity。 */
export function cafeItemMargin(item: Pick<CafeMenuItem, "recipe" | "price">): number {
  const price = finiteOr(item.price, 0);
  if (price <= 0) return 0;
  return (price - cafeItemCost(item)) / price;
}

/**
 * 平均客單價的**硬上限防呆**。P4a 由 $38 調到 $55(設計文件 §4.7)。
 *
 * ### 為什麼原本的 $38 是個天花板,又為什麼把它抬到 $55 目前「還沒有」立刻加價
 *
 * $38 這個數字原本是 CAFE-17 為了守住「成熟期只能是日租金的 30~50%」而設的。
 * §4.7 拍板推翻了那條副業定位(咖啡廳要能取代收租),所以這個上限的**用途**
 * 也跟著換了:它不再是收益護欄,而是**「未來新增品項時的防呆」**——
 * 第三層研發(季節限定豆、造型拿鐵、下午茶套餐)本來就會帶進 $50 以上的品項,
 * $55 是那批品項全上線之後平均客單價的合理天花板。
 *
 * 🔴 **誠實記錄**:抬高這個常數**本身不會讓咖啡廳多賺一毛錢**。
 * P1 之後營收是逐位顧客照 `item.price` 真的結出來的(`checkoutCafeOrder()`),
 * `avgTicket()` 只是面板上的顯示值與這道防呆的量尺。現行菜單(3 個基礎品 +
 * 10 個研發品,售價 $34~$42)的平均就是 $38,離 $55 還有很大的餘裕 ——
 * 那個餘裕要等第三層研發真的加進 `content/cafeResearch.ts` 才會被用掉。
 * P4a 因此**不靠加價**達成 §4.7 的成長曲線,而是靠招牌分級 + 席次/員工產能。
 */
export const CAFE_MAX_AVG_TICKET = 55;

/**
 * 依完成研發產生菜單。未知／重複 id 會被忽略，輸出永遠按 content 宣告序，
 * 不受存檔陣列插入順序影響。CAFE-19/20 可讀 track 做客群結構，不需再解析中文品名。
 */
export function menuItems(completed: readonly string[] = []): CafeMenuItem[] {
  const done = new Set(Array.isArray(completed) ? completed : []);
  const researched = CAFE_RESEARCH
    .filter((research) => done.has(research.id))
    .map((research): CafeMenuItem => ({
      id: `cafe_menu_${research.id}`,
      name: research.menuItem,
      price: research.menuPrice,
      track: research.track,
      level: research.level,
      audience: research.audience,
      source: "research",
      researchId: research.id,
      specialEvent: "specialEvent" in research && research.specialEvent === true,
      // 沒登記配方的研發品(未來新增卻忘了補表)給空配方 + 零熱門度:
      // 空配方永遠「不缺料」會變成無本生意,零熱門度則讓它根本不會被點到,
      // 是兩害相權下唯一安全的預設值。`cafe-per-guest-test.ts` 有斷言不准留空。
      recipe: CAFE_RESEARCH_RECIPES[research.id]?.recipe ?? {},
      baseWeight: CAFE_RESEARCH_RECIPES[research.id]?.baseWeight ?? 0,
    }));
  return [...CAFE_BASE_MENU_ITEMS, ...researched];
}

/**
 * 平均客單價 = **目前菜單標價的平均**,四捨五入後夾在 `CAFE_MAX_AVG_TICKET` 以下。
 *
 * ### P4a 為什麼把它從「里程碑表」改成「真的去算平均」
 *
 * 舊版是一張手調的里程碑表(完成 2 項第二層 → $37、5 項 → $38),那在 P1
 * 把營收改成逐位顧客照 `item.price` 結帳之後就**與帳本脫鉤**了:面板上寫 $37,
 * 玩家實際收到的卻是菜單價的加權平均。同一個數字有兩種意思正是本次重設計要修的病。
 *
 * 現在它就是菜單平均,面板顯示什麼、玩家大致就收到什麼;而 `CAFE_MAX_AVG_TICKET`
 * 從「里程碑的終點」變成一道**只在資料寫壞時才會生效的夾子**——
 * 日後誰在 `content/cafeResearch.ts` 誤加一個 $200 的品項,平均也不會衝破 $55。
 *
 * 沒有研發時 = 三個基礎品項 `(34 + 36 + 38) / 3` = **$36**,與 `CAFE_BASE_TICKET`
 * 完全一致(既有行為不變);完整前兩層 13 項的平均 = $38.15 → **$38**,
 * 與舊里程碑表的終點也一致。⇒ 這次改寫對現有存檔的顯示值零位移。
 */
export function avgTicket(completed: readonly string[] = []): number {
  const menu = menuItems(completed);
  if (menu.length === 0) return CAFE_BASE_TICKET;
  const mean = menu.reduce((sum, item) => sum + Math.max(0, finiteOr(item.price, 0)), 0) / menu.length;
  return Math.min(CAFE_MAX_AVG_TICKET, Math.round(quantize(mean)));
}

/** 舊 API 保留給測試／呼叫端；回傳值改由菜單平均價反推，不接受未知 id 灌水。 */
export function cafeResearchTicketBonus(completed: readonly string[] = []): number {
  return avgTicket(completed) / CAFE_BASE_TICKET - 1;
}

/** 日結既有呼叫端不需修改；CAFE-17 只替換這個純讀取結果。 */
export function cafeTicketPrice(completed: readonly string[] = []): number {
  return avgTicket(completed);
}

// ---------------------------------------------------------------------------
// 9. 人氣
// ---------------------------------------------------------------------------

/**
 * 隔日人氣。順利做完一天慢慢累積,讓客人撲空掉得快一點。
 * 夾在 0~100,所以它只能在客流上加最多 +25%,永遠不會失控。
 */
export function nextCafePopularity(
  current: number,
  outcome: { shortages: number; underfunded: boolean },
): number {
  const now = Math.min(CAFE_POPULARITY_MAX, Math.max(0, finiteOr(current, 0)));
  const shortages = Math.max(0, Math.trunc(finiteOr(outcome.shortages, 0)));
  const delta = shortages > 0
    ? -CAFE_POPULARITY_LOSS
    : outcome.underfunded
      ? -CAFE_POPULARITY_SOFT_LOSS
      : CAFE_POPULARITY_GAIN;
  return Math.min(CAFE_POPULARITY_MAX, Math.max(0, now + delta));
}

// ---------------------------------------------------------------------------
// 10. 日結敘事(設計文件 §5.2:缺貨與補不滿是敘事,不是懲罰)
// ---------------------------------------------------------------------------

/**
 * 咖啡廳日結日誌的前綴。
 *
 * 🔴 **刻意選一個沒有被任何既有系統用過的字**(既有的有 ☕🍰🧁🍮🐾🏪🫖🧾🧋🍵…),
 * 並且 **刻意不加進 `narration.ts:376` 的 `/^[🔮🌀🌱💤]/u` 過濾字元類**。
 *
 * 那個字元類過濾的是「系統回饋日誌」——AI 自己寫的東西或既有日誌的二次敘述,
 * 回流會讓 AI 摘要自己的摘要。咖啡廳日結**是第一手世界事件**(今天真的賣完了、
 * 今天真的丟了一盒奶油),判準上該進 AI 素材。前例是 `outing.ts:39-40` 的 🏪 巧遇,
 * 同樣是第一手事件、同樣刻意不列入過濾名單。
 */
export const CAFE_LOG_PREFIX = "🥐";

export type CafeDailyLineKind = "shortage" | "underfunded" | "spoilage";

export interface CafeDailyLineInput {
  kind: CafeDailyLineKind;
  /** 決定性選句用,通常給遊戲日序號。 */
  day: number;
  /** 主角原料的中文名(缺貨/補不滿/損耗清單的第一項)。 */
  subject: string;
  /** 補不滿時實際補到的比例 0~1;其他 kind 忽略。 */
  fulfillment?: number;
}

/** FNV-1a 32-bit,與 `cafeGuests.ts` 同一套:穩定、快速、零 RNG。 */
function lineHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 缺貨:今天賣完了,後來的客人看看菜單就走。 */
const SHORTAGE_LINES = [
  (s: string) => `${s}下午三點就見底,後來的客人站在門口看了看菜單,又把門帶上走了。`,
  (s: string) => `${s}比預想中消耗得快,傍晚只能一個個說抱歉——有人笑著說下次早點來。`,
  (s: string) => `午後那波人潮把${s}掃得乾乾淨淨,店裡剩下的香氣比商品還多。`,
  (s: string) => `打烊前兩小時就掛出了「${s}售完」的牌子,幾位常客摸摸貓也就回去了。`,
];

/** 補不滿:錢不夠,這個月的進貨單刪了又刪。 */
const UNDERFUNDED_LINES = [
  (s: string, pct: number) => `這個月手頭緊,${s}只叫了${pct}成,冷藏櫃看起來空得有點心虛。`,
  (s: string, pct: number) => `跟供應商說這次先少進一點,${s}的箱子疊起來比平常矮了一截(只補到${pct}成)。`,
  (s: string, pct: number) => `結帳前算了又算,${s}最後只補得起${pct}成——先撐過這幾天再說。`,
  (s: string, pct: number) => `進貨單改了三次,${s}是照最省的量下的,${pct}成,不能再少了。`,
];

/** 損耗:囤太多的生鮮終究是用不完。 */
const SPOILAGE_LINES = [
  (s: string) => `整理冰箱時,從最深處翻出一盒過期的${s},只好默默丟掉。`,
  (s: string) => `${s}放到過了期,擦櫃子時才發現,湊近聞聞就知道不能用了。`,
  (s: string) => `盤點生鮮,${s}壞了一點點——囤得太多,終究是用不完。`,
  (s: string) => `打烊後把過期的${s}挑出來,袋口打了個結,提去後門。`,
];

/**
 * 把日結的三個旗標組成一句敘事(**含前綴**)。純函式:同樣的 `day` + `kind` + `subject`
 * 永遠得到同一句,選句用 `lineHash()` 而非 `Math.random()`。
 */
export function cafeDailyLine(input: CafeDailyLineInput): string {
  const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim() : "備料";
  const day = Math.trunc(finiteOr(input.day, 0));
  const pool = input.kind === "shortage" ? SHORTAGE_LINES : input.kind === "underfunded" ? UNDERFUNDED_LINES : SPOILAGE_LINES;
  const index = lineHash(`cafe|${input.kind}|${day}|${subject}`) % pool.length;
  if (input.kind === "underfunded") {
    // 0 成與 10 成都不成句(真的補到 10 成就不會走到這條路徑),夾在 1~9。
    const pct = Math.min(9, Math.max(1, Math.round(finiteOr(input.fulfillment, 0) * 10)));
    return `${CAFE_LOG_PREFIX} ${(pool as typeof UNDERFUNDED_LINES)[index](subject, pct)}`;
  }
  return `${CAFE_LOG_PREFIX} ${(pool as typeof SHORTAGE_LINES)[index](subject)}`;
}

// ===========================================================================
// 11. P1:逐位顧客結帳(設計文件 §3 §4.1 §4.2 §4.3 §4.8)
//
// 「畫面上發生的事,就是帳本上發生的事。」本節提供逐位結帳需要的**全部算式**,
// 副作用(扣款、扣庫存、推日誌、寫 state)一律留在 `tick.ts` 的 `cafeHourlyPass()`。
// 本節同樣零 `Math.random()`:選品走 `lineHash()`(FNV-1a,與 `cafeGuestHash` 同一套)。
// ===========================================================================

/** 營業時段的小時數(10:00~20:00 含頭含尾)。時鐘常數本身留在 `tick.ts`,本檔只吃「第幾個營業小時」。 */
export const CAFE_BUSINESS_HOURS = 11;

/**
 * 把當日客流攤到 11 個營業小時。**用累積差分而不是 `ceil(客流 / 11)`**:
 * 後者在 26 人時會變成每小時 3 人 × 11 = 33 人,一天硬生生多出 7 位客人、
 * 也就多出 7 份營收——「當日營收 = Σ 實際賣出」那條主張立刻破功。
 *
 * 累積差分保證 `Σ hourIndex=0..10 = 當日客流`(取整誤差在小時之間互相抵銷),
 * 而且每個小時只依賴 `(當日客流, hourIndex)`,**不依賴前幾個小時跑過沒有** ⇒
 * 線上逐時跑與離線一次補完全等價。
 */
export function cafeHourlyGuestCount(dayGuests: number, hourIndex: number): number {
  const index = Math.trunc(finiteOr(hourIndex, -1));
  if (index < 0 || index >= CAFE_BUSINESS_HOURS) return 0;
  const total = Math.max(0, Math.floor(finiteOr(dayGuests, 0)));
  const upTo = Math.round(quantize((total * (index + 1)) / CAFE_BUSINESS_HOURS));
  const prev = Math.round(quantize((total * index) / CAFE_BUSINESS_HOURS));
  return Math.max(0, upTo - prev);
}

/** 顧客的口味偏好只有三種,對齊菜單的三條 track。 */
export const CAFE_TASTE_TRACKS: readonly CafeResearchTrack[] = ["coffee", "bakery", "pet"];
/** 命中偏好 track 的權重加成(設計文件 §4.2 的「客群修正」)。 */
export const CAFE_TASTE_BOOST = 1.6;

/**
 * 天氣修正(§4.2):冷天熱飲 ↑、熱天冷萃 ↑。
 * 用 `audience === "cold_drink"` 認冷飲,不用中文品名做字串比對。
 */
function cafeWeatherWeight(item: CafeMenuItem, weather: WeatherId): number {
  const cold = item.audience === "cold_drink";
  const hotDrink = item.track === "coffee" && !cold;
  if (weather === "sweltering") return cold ? 1.6 : hotDrink ? 0.85 : 1;
  if (weather === "rainy") return cold ? 0.7 : hotDrink ? 1.2 : 1;
  if (weather === "cloudy") return cold ? 0.85 : hotDrink ? 1.1 : 1;
  return 1; // 晴天:誰都想喝點什麼,不偏袒
}

/**
 * 時段修正(§4.2):早上咖啡 ↑、下午烘焙 ↑、傍晚寵物客較多。
 * 邊界刻意用實際時鐘小時而不是 hourIndex——玩家讀得懂的是「早上/下午」。
 */
function cafeHourWeight(item: CafeMenuItem, hour: number): number {
  const h = Math.trunc(finiteOr(hour, 12));
  if (h <= 12) return item.track === "coffee" ? 1.35 : item.track === "bakery" ? 0.85 : 1;
  if (h <= 17) return item.track === "bakery" ? 1.3 : item.track === "coffee" ? 0.95 : 1;
  return item.track === "pet" ? 1.2 : 1;
}

export interface CafeOrderInput {
  /** 目前菜單,通常來自 `menuItems(cafe.completed)`。 */
  menu: readonly CafeMenuItem[];
  /** 遊戲日序號。 */
  day: number;
  /** 實際時鐘小時(10~20)。 */
  hour: number;
  /** 這位顧客是本小時的第幾位(0 起算)。 */
  index: number;
  weather: WeatherId;
}

/**
 * 一位顧客要點什麼。**決定性雜湊,零 RNG**:同一個
 * `(day, hour, index)` 在任何機器、任何 session、線上或離線,永遠得到同一項。
 *
 * 權重 = `baseWeight × 客群修正 × 天氣修正 × 時段修正`(設計文件 §4.2)。
 * 客群修正由 `雜湊(key|taste)` 決定這位顧客偏好哪條 track,命中則 ×1.6。
 *
 * 菜單為空、或全部品項權重皆為 0 時回 `null`(caller 視為「這位客人沒點到東西」,
 * 但**不算缺貨**——那是我們自己菜單掛了,不該罰玩家的聲譽)。
 */
export function chooseCafeMenuItem(input: CafeOrderInput): CafeMenuItem | null {
  const menu = (input.menu ?? []).filter((item) => item && finiteOr(item.baseWeight, 0) > 0);
  if (menu.length === 0) return null;
  const key = `cafe-order|${Math.trunc(finiteOr(input.day, 0))}|${Math.trunc(finiteOr(input.hour, 0))}|${Math.trunc(finiteOr(input.index, 0))}`;
  const prefer = CAFE_TASTE_TRACKS[lineHash(`${key}|taste`) % CAFE_TASTE_TRACKS.length];
  const weights = menu.map((item) => Math.max(0, quantize(
    finiteOr(item.baseWeight, 0)
    * (item.track === prefer ? CAFE_TASTE_BOOST : 1)
    * cafeWeatherWeight(item, input.weather)
    * cafeHourWeight(item, input.hour),
  )));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return menu[lineHash(`${key}|pick`) % menu.length];
  // 取雜湊的低位當 0~1 的分位數;精度 1/100000 遠高於任何一項的權重佔比。
  let roll = ((lineHash(`${key}|pick`) % 100_000) / 100_000) * total;
  for (let i = 0; i < menu.length; i++) {
    roll -= weights[i];
    if (roll < 0) return menu[i];
  }
  return menu[menu.length - 1];
}

export interface CafeCheckoutResult {
  /** true = 配方原料齊全,已扣料;false = 缺料,一單位都沒扣。 */
  ok: boolean;
  /** 結帳後的庫存(新物件;失敗時是輸入的乾淨副本)。 */
  stock: Record<string, number>;
  /** 缺的原料 id,順序照 `CAFE_INGREDIENTS` 宣告序;`ok` 時為空陣列。 */
  missing: string[];
  /** 成功 = `item.price`;缺料 = 0。 */
  revenue: number;
  /** 成功時扣掉的原料進貨價值(給毛利統計);缺料 = 0。 */
  cost: number;
}

/**
 * 一位顧客的結帳。**全有全無**:少一種料就整份做不出來,一單位都不扣、一毛錢都不收。
 *
 * 為什麼不做「部分供應」:客人點的是一杯拿鐵,不是「0.7 杯拿鐵」。
 * 部分供應會讓庫存被慢慢刮乾淨卻沒有任何一位客人被服務到,
 * 那既不合直覺,也讓「缺貨」這件事在畫面上永遠看不出來。
 */
export function checkoutCafeOrder(
  stock: Readonly<Record<string, number>>,
  item: Pick<CafeMenuItem, "recipe" | "price">,
): CafeCheckoutResult {
  const nextStock: Record<string, number> = {};
  for (const [id, units] of Object.entries(stock ?? {})) nextStock[id] = safeUnits(units);

  const recipe = item?.recipe ?? {};
  const missing: string[] = [];
  for (const ingredient of CAFE_INGREDIENTS) {
    const need = safeUnits(recipe[ingredient.id]);
    if (need <= 0) continue;
    if ((nextStock[ingredient.id] ?? 0) < need) missing.push(ingredient.id);
  }
  if (missing.length > 0) return { ok: false, stock: nextStock, missing, revenue: 0, cost: 0 };

  let cost = 0;
  for (const ingredient of CAFE_INGREDIENTS) {
    const need = safeUnits(recipe[ingredient.id]);
    if (need <= 0) continue;
    nextStock[ingredient.id] = (nextStock[ingredient.id] ?? 0) - need;
    cost += need * ingredient.unitPrice;
  }
  return { ok: true, stock: nextStock, missing: [], revenue: Math.max(0, finiteOr(item.price, 0)), cost };
}

// ---------------------------------------------------------------------------
// 12. P1:聲譽即時化(設計文件 §4.8)
// ---------------------------------------------------------------------------

/** 成功服務一位顧客。26 人的一天 ≈ +3.9。 */
export const CAFE_POPULARITY_SERVE_GAIN = 0.15;
/** 缺貨害一位顧客空手離開。兩次(−4)大致抵銷一整天的服務累積。 */
export const CAFE_POPULARITY_REFUSE_LOSS = 2;

/** 聲譽夾在 0~100;壞資料一律回退成 0(不產生 NaN)。 */
export function clampCafePopularity(value: number): number {
  return Math.min(CAFE_POPULARITY_MAX, Math.max(0, finiteOr(value, 0)));
}

/**
 * 一小時內服務 `served` 位、讓 `refused` 位撲空之後的新聲譽。
 * 純算術、可交換、夾值——同樣的 (served, refused) 不管拆成幾次呼叫結果相同,
 * 這正是「線上逐時 = 離線補進度」的必要條件之一。
 */
export function cafeServicePopularity(current: number, served: number, refused: number): number {
  const ok = Math.max(0, Math.trunc(finiteOr(served, 0)));
  const bad = Math.max(0, Math.trunc(finiteOr(refused, 0)));
  return clampCafePopularity(
    clampCafePopularity(current) + ok * CAFE_POPULARITY_SERVE_GAIN - bad * CAFE_POPULARITY_REFUSE_LOSS,
  );
}

// ---------------------------------------------------------------------------
// 13. P1:逐位結帳的敘事(一則賣出、一則撲空)
// ---------------------------------------------------------------------------

/** 賣出:玩家要看得到「有人真的點了東西、真的付了錢」。 */
const SALE_LINES = [
  (item: string, price: number) => `有人點了${item},$${price} 落進收銀機,杯子在吧台輕輕碰了一聲。`,
  (item: string, price: number) => `今天第一份${item}出餐($${price}),客人端著它挑了個看得到貓的位子。`,
  (item: string, price: number) => `${item}賣出去了,$${price}——收銀機的抽屜開合之間,一天就這樣開始了。`,
  (item: string, price: number) => `一位客人指了指${item},付了 $${price},說「就這個」。`,
];

/** 撲空:設計文件 §4.3 指定的體感——「有人想點拿鐵,牛奶沒了」。 */
const REFUSED_LINES = [
  (item: string, missing: string) => `有人想點${item},${missing}沒了——他看了看菜單,還是把門帶上走了。`,
  (item: string, missing: string) => `${missing}見底,${item}只能說抱歉;那位客人笑了笑,說下次再來。`,
  (item: string, missing: string) => `客人指著菜單上的${item},只好回他「${missing}用完了」,他點點頭就走了。`,
  (item: string, missing: string) => `${item}做不出來——${missing}早就用光了。客人聳聳肩,轉身離開。`,
];

export interface CafeOrderLineInput {
  kind: "sale" | "refused";
  /** 決定性選句用。 */
  day: number;
  hour: number;
  itemName: string;
  /** kind = "sale" 時的售價。 */
  price?: number;
  /** kind = "refused" 時缺的那項原料中文名。 */
  missingName?: string;
}

/**
 * 逐位結帳的日誌句(**含前綴**)。同樣是純函式 + `lineHash()` 選句,零 RNG。
 * 真正把句子推進 `rt.log` 的是 `tick.ts` 的 `cafeHourlyPass()`。
 */
export function cafeOrderLine(input: CafeOrderLineInput): string {
  const item = typeof input.itemName === "string" && input.itemName.trim() ? input.itemName.trim() : "今天的餐點";
  const day = Math.trunc(finiteOr(input.day, 0));
  const hour = Math.trunc(finiteOr(input.hour, 0));
  const index = lineHash(`cafe-order-line|${input.kind}|${day}|${hour}|${item}`) % SALE_LINES.length;
  if (input.kind === "sale") {
    const price = Math.max(0, Math.round(finiteOr(input.price, 0)));
    return `${CAFE_LOG_PREFIX} ${SALE_LINES[index](item, price)}`;
  }
  const missing = typeof input.missingName === "string" && input.missingName.trim() ? input.missingName.trim() : "備料";
  return `${CAFE_LOG_PREFIX} ${REFUSED_LINES[index](item, missing)}`;
}

// ---------------------------------------------------------------------------
// 14. P3:銷售排行 + 依上週銷量建議常備量(設計文件 §4.2 末段、§4.3.1)
//
// 兩者吃的是同一份原料:`state.cafe.sales`(P1 建立的逐日逐品項紀錄)。
// 本節一樣是純函式——`sales` 由 caller 傳進來,本檔仍然不 import state。
// ---------------------------------------------------------------------------

/** 銷售排行與建議常備量預設回看的遊戲日數(設計文件寫死「過去 7 個遊戲日」)。 */
export const CAFE_SALES_WINDOW_DAYS = 7;

/**
 * 建議常備量在「過去尖峰」之上再留的餘裕。
 *
 * 15% 是回推的:尖峰日 ≈ 週末 × 晴天(`1.25 × 1.15 = 1.44` 倍於平均),
 * 一週的窗口通常已經含到一個週末,所以真正要防的只是「下週比這週再旺一點」。
 * 餘裕再大就會把生鮮推過 `SPOILAGE_FREE_UNITS`,變成建議按鈕自己害玩家損耗。
 */
export const CAFE_SUGGEST_BUFFER = 1.15;

/**
 * 在菜單上、但過去 7 日一份都沒賣掉的原料,至少建議備幾份的量。
 *
 * 沒有這條的話,「剛研發完的新品」會被建議成 0(它當然還沒有銷售紀錄),
 * 玩家按了建議按鈕反而保證缺貨。2 份是最小的「至少做得出來」。
 */
export const CAFE_SUGGEST_MIN_SERVINGS = 2;

/** 銷售排行的一列。 */
export interface CafeSalesRankRow {
  /** 菜單品項 id。 */
  id: string;
  name: string;
  /** 窗口內賣出的份數。 */
  sold: number;
  /** 窗口內因缺料被拒的次數(玩家在虧錢的訊號)。 */
  missed: number;
}

/** 取窗口內的銷售紀錄(最新 `days` 筆,壞資料略過)。 */
function salesWindow(sales: readonly CafeSalesDay[] | undefined, days: number): CafeSalesDay[] {
  const span = Math.max(1, Math.trunc(finiteOr(days, CAFE_SALES_WINDOW_DAYS)));
  const rows = (Array.isArray(sales) ? sales : []).filter((row): row is CafeSalesDay =>
    !!row && typeof row === "object");
  return rows.slice(-span);
}

const countOf = (record: Record<string, number> | undefined, id: string) => safeUnits((record ?? {})[id]);

/**
 * 過去 `days` 個遊戲日各品項的**賣出份數**與**缺貨次數**,由高到低。
 *
 * 排序鍵刻意是三段的:賣出 ↓ → 缺貨 ↓ → 菜單宣告序。第三段讓「兩個都是 0」的
 * 新品維持穩定順序,不會因為 `Object.keys()` 的插入序在不同存檔跳來跳去。
 *
 * **回傳目前菜單上的每一項**(含零銷量),因為玩家要看的是「誰賣得好、誰賣不動」,
 * 把賣不動的藏起來反而讓面板騙人。已下架/未知 id 的舊紀錄一律略過。
 */
export function cafeSalesRanking(
  sales: readonly CafeSalesDay[] = [],
  menu: readonly CafeMenuItem[] = [],
  days: number = CAFE_SALES_WINDOW_DAYS,
): CafeSalesRankRow[] {
  const window = salesWindow(sales, days);
  const rows = (Array.isArray(menu) ? menu : [])
    .filter((item) => item && typeof item.id === "string")
    .map((item, order): CafeSalesRankRow & { order: number } => {
      let sold = 0;
      let missed = 0;
      for (const record of window) {
        sold += countOf(record.sold, item.id);
        missed += countOf(record.missed, item.id);
      }
      return { id: item.id, name: item.name, sold, missed, order };
    });
  rows.sort((a, b) => (b.sold - a.sold) || (b.missed - a.missed) || (a.order - b.order));
  return rows.map(({ id, name, sold, missed }) => ({ id, name, sold, missed }));
}

/**
 * 窗口內**單日尖峰**的各原料需求量(份數 × 配方,含被拒的那幾份)。
 *
 * 用尖峰而不是平均:平均會讓週末必缺貨(週末客流是平日的 1.39 倍)。
 * 把 `missed` 一起算進需求,是因為那些人本來就想買、只是我們做不出來——
 * 依「實際賣出」補貨會讓缺貨自我實現,永遠補不回來。
 */
export function cafeIngredientPeakDemand(
  sales: readonly CafeSalesDay[] = [],
  menu: readonly CafeMenuItem[] = [],
  days: number = CAFE_SALES_WINDOW_DAYS,
): Record<string, number> {
  const window = salesWindow(sales, days);
  const items = (Array.isArray(menu) ? menu : []).filter((item) => item && typeof item.id === "string");
  const peak: Record<string, number> = {};
  for (const ingredient of CAFE_INGREDIENTS) peak[ingredient.id] = 0;
  for (const record of window) {
    for (const ingredient of CAFE_INGREDIENTS) {
      let need = 0;
      for (const item of items) {
        const units = safeUnits((item.recipe ?? {})[ingredient.id as CafeIngredientId]);
        if (units <= 0) continue;
        need += (countOf(record.sold, item.id) + countOf(record.missed, item.id)) * units;
      }
      if (need > peak[ingredient.id]) peak[ingredient.id] = need;
    }
  }
  return peak;
}

export interface CafeSuggestedOrdersResult {
  /** 原料 id → 建議常備量,一律非負整數,順序照 `CAFE_INGREDIENTS` 宣告序。 */
  orders: Record<string, number>;
  /** 實際用到幾個遊戲日的紀錄。 */
  days: number;
  /** true = 沒有可用的銷售歷史,已退回 `suggestedStandingOrders()` 的內建建議值。 */
  fallback: boolean;
}

/**
 * 「依上週銷量建議」按鈕的算式(拍板 Q3 的懶人路線)。
 *
 * ```
 * 建議量 = max( ceil(過去 7 日單日尖峰需求 × 1.15), 菜單上該原料的「兩份」底線 )
 * ```
 *
 * **fallback**:窗口裡一天都沒有、或這 7 天一份都沒賣掉(剛開張、離線太久、
 * 舊存檔沒有 `sales`)⇒ 整份退回 `suggestedStandingOrders()`。
 * 這條保證按鈕**永遠不會算出全 0 或 NaN**——那會讓玩家按一下就整店斷料。
 *
 * 有歷史時個別原料算出 0 是**正確**的:開張期菜單根本用不到牛奶與寵物鮮食,
 * 建議 0 正是「別買你用不到的東西」。研發解鎖新品之後它會進菜單,
 * 那條「兩份」底線就會把它從 0 拉起來(前提是玩家再按一次按鈕)。
 */
export function suggestStandingOrdersFromSales(
  sales: readonly CafeSalesDay[] = [],
  menu: readonly CafeMenuItem[] = [],
  days: number = CAFE_SALES_WINDOW_DAYS,
): CafeSuggestedOrdersResult {
  const window = salesWindow(sales, days);
  const items = (Array.isArray(menu) ? menu : []).filter((item) => item && typeof item.id === "string");
  const activity = window.reduce((sum, record) => {
    let day = 0;
    for (const item of items) day += countOf(record.sold, item.id) + countOf(record.missed, item.id);
    return sum + day;
  }, 0);
  if (window.length === 0 || activity === 0) {
    return { orders: suggestedStandingOrders(), days: window.length, fallback: true };
  }

  const peak = cafeIngredientPeakDemand(window, items, window.length);
  const orders: Record<string, number> = {};
  for (const ingredient of CAFE_INGREDIENTS) {
    // 菜單上「一份最多要幾單位」× 兩份 = 這項原料的底線(沒進菜單就沒有底線)
    let perServing = 0;
    for (const item of items) {
      const units = safeUnits((item.recipe ?? {})[ingredient.id as CafeIngredientId]);
      if (units > perServing) perServing = units;
    }
    const floorUnits = perServing * CAFE_SUGGEST_MIN_SERVINGS;
    const wanted = Math.ceil(quantize(safeUnits(peak[ingredient.id]) * CAFE_SUGGEST_BUFFER));
    orders[ingredient.id] = Math.max(0, Math.max(wanted, floorUnits));
  }
  return { orders, days: window.length, fallback: false };
}
