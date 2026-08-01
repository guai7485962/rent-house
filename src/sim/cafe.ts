/**
 * 咖啡廳的補貨 / 消耗 / 損耗計算(CAFE-12,設計文件 §5.2)。
 *
 * ## 這個檔案刻意「不做」的事
 *
 * 比照 CAFE-07~10 的成功切法:**全部是接收參數的純函式,不接 state、不接 tick**。
 *
 * - **不 import `state`**、不讀寫任何全域。所有輸入由 caller 給,所有輸出是新物件。
 * - **不呼叫 `addMoney()`**。`restockPlan()` 只回傳「應該扣多少」,實際扣款由 CAFE-13
 *   在日結 pass 統一做(金錢進出唯一入口仍是 `economy.ts` 的 `addMoney`)。
 * - **不推日誌**。缺貨、補不滿、損耗都只是回傳值上的欄位,由 CAFE-13 決定要不要寫成
 *   一則「客人撲空」或「今天只補得起七成」的敘事。
 * - **不碰 `tick.ts`**。日結 pass 是 CAFE-13 的範圍。
 *
 * 結果:本檔零副作用 ⇒ 對 `scripts/balance-snapshot.json` 天然零漂移。
 *
 * ## 零 RNG
 *
 * 全檔沒有 `Math.random()`,也不需要雜湊——補貨、消耗、損耗全是決定性算術。
 * 需要「有點變化」的地方(客流、天氣)不在本檔,那是 CAFE-13 用 `weatherForDay()`
 * 與 `week.ts` 這兩個現成確定性來源處理的事。
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
 * - 設太高 → 生鮮損耗,但 `SPOILAGE_FREE_UNITS = 6` 且損耗無條件捨去,
 *   庫存會**收斂到 15 就停住,永遠不會被損耗歸零**。
 */
import { CAFE_INGREDIENTS, type CafeIngredient } from "../content/cafeIngredients";

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
 * 生鮮的免損耗額度:這個量以內完全不會壞(一兩天內就用得完的量)。
 * 設計文件 §5.2 範例的牛奶常備量是 15,搭配下面的 `SPOILAGE_RATE` 剛好損耗為 0——
 * 也就是照文件的設定玩,生鮮一單位都不會壞;只有玩家**刻意囤到 16 以上**才開始損耗。
 */
export const SPOILAGE_FREE_UNITS = 6;

/** 超出免損耗額度的部分,每日損耗比例(無條件捨去)。 */
export const SPOILAGE_RATE = 0.1;

// ---------------------------------------------------------------------------
// 小工具(全部決定性)
// ---------------------------------------------------------------------------

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
 * 這條公式有一個刻意設計的**下界**:當 `庫存 − freeUnits < 1/rate`(預設 6 + 10 = 16)時,
 * `floor` 會讓損耗歸 0,庫存就停在那裡不再減少。所以
 *
 * - 反覆套用會**收斂到 15 並停住,永遠不會把櫃子清空**;
 * - 照設計文件 §5.2 的常備量玩(牛奶 15、奶油 8、寵物鮮食 6),損耗恆為 0;
 * - 只有玩家刻意把生鮮囤到 16 以上,才開始每天壞一點點。
 *
 * ### 冪等性:這是「每日」函式,不是「載入」函式
 *
 * 連套兩次 = 過了兩天,第二次會從更小的基數再壞一次——這是正確語意,不是 bug。
 * 但它**不該被載入流程呼叫**(否則玩家每讀一次檔就少一點庫存)。
 * 上面的下界是這件事的保險絲:就算有人誤呼叫很多次,庫存也只會收斂到 15,不會歸零。
 * 正確的呼叫點只有一個:CAFE-13 的日結 pass,每個遊戲日一次。
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
