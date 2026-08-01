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
 * - 設太高 → 生鮮損耗,但 `SPOILAGE_FREE_UNITS = 6` 且損耗無條件捨去,
 *   庫存會**收斂到 15 就停住,永遠不會被損耗歸零**。
 */
import { CAFE_INGREDIENTS, type CafeIngredient } from "../content/cafeIngredients";
// 型別匯入(編譯後完全抹除),本檔仍然沒有任何 runtime 相依。
import type { WeatherId } from "./weather";

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

// ===========================================================================
// CAFE-13:客流公式、客單價、人氣與日結敘事(全部仍是純函式)
// ===========================================================================

// ---------------------------------------------------------------------------
// 4. 設備能力(CAFE-14 的讀取面)
// ---------------------------------------------------------------------------

/**
 * 設計文件 §5.4 的五個投資項 id。
 *
 * **本項只做「讀」**:把 id 對應到客流/產能/損耗上的效果。
 * 「賣」那一面(價格、`openCafe()`、`buyUpgrade()` 同構的一次性扣款、UI)是 **CAFE-14**。
 * 因此今天 `state.cafe.upgrades` 恆為空陣列,下面每一項都算不出效果——
 * 這是刻意的:公式先長好形狀,CAFE-14 只要把 id 塞進陣列就會活過來。
 */
export const CAFE_UPGRADE_IDS = {
  /** 店面招牌:招牌等級 +1 ⇒ 基礎客流翻倍(§5.4「基礎客流 ↑」) */
  signboard: "cafe_signboard",
  /** 第二台咖啡機:產能上限 +CAFE_CAPACITY_PER_MACHINE(§5.4「尖峰時段不再流失客人」) */
  secondMachine: "cafe_second_machine",
  /** 戶外座位:晴天客流 +CAFE_OUTDOOR_SUNNY_BONUS,雨天無效(§5.4 原文) */
  outdoorSeats: "cafe_outdoor_seats",
  /** 大型冷藏:免損耗額度加倍、損耗率減半(§5.4「生鮮損耗 ↓」) */
  coldStorage: "cafe_cold_storage",
  /** 貓跳台與軟墊:效果在認養詢問頻率上,與日結無關(留給 CAFE-14 / CAFE-09 線) */
  petTower: "cafe_pet_tower",
} as const;

/** 沒有任何投資時的產能上限。招牌等級 1 的基礎客流(22)略低於它 ⇒ 只有尖峰日會撞到天花板。 */
export const CAFE_BASE_CAPACITY = 26;
/** 每台額外咖啡機提高的產能上限。 */
export const CAFE_CAPACITY_PER_MACHINE = 14;
/** 大型冷藏的免損耗額度倍率與損耗率折扣。 */
export const CAFE_COLD_STORAGE_FREE_MULT = 2;
export const CAFE_COLD_STORAGE_RATE_MULT = 0.5;

export interface CafeCapability {
  /** 招牌等級,無招牌 = 1。 */
  signLevel: number;
  /** 產能上限(當日客流的硬天花板)。 */
  capacity: number;
  /** 有沒有戶外座位(只在晴天生效)。 */
  outdoorSeats: boolean;
  /** 直接餵給 `applySpoilage()` 的損耗參數。 */
  spoilage: SpoilageOptions;
}

/** 由已購買的投資項 id 陣列推出日結需要的四項能力。**純讀取,不改輸入。** */
export function cafeCapability(upgrades: readonly string[] = []): CafeCapability {
  const owned = new Set(Array.isArray(upgrades) ? upgrades : []);
  const cold = owned.has(CAFE_UPGRADE_IDS.coldStorage);
  return {
    signLevel: 1 + (owned.has(CAFE_UPGRADE_IDS.signboard) ? 1 : 0),
    capacity: CAFE_BASE_CAPACITY + (owned.has(CAFE_UPGRADE_IDS.secondMachine) ? CAFE_CAPACITY_PER_MACHINE : 0),
    outdoorSeats: owned.has(CAFE_UPGRADE_IDS.outdoorSeats),
    spoilage: cold
      ? { freeUnits: SPOILAGE_FREE_UNITS * CAFE_COLD_STORAGE_FREE_MULT, rate: SPOILAGE_RATE * CAFE_COLD_STORAGE_RATE_MULT }
      : {},
  };
}

// ---------------------------------------------------------------------------
// 5. 客流(設計文件 §5.5)
// ---------------------------------------------------------------------------

/**
 * 每一級招牌帶來的基礎客流。
 *
 * 22 這個數字是回推出來的,不是拍腦袋:設計文件 §5.2 的範例表以「30 位客人」為基準,
 * 而 §5.1 要求成熟期日淨利只能是日租金的 30–50%。招牌 1 級 ≈ 22 人(剛開張、只夠打平多一點)、
 * 2 級 ≈ 44 人但被產能夾到 40 人(成熟期),兩點連起來剛好落在目標帶。
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
}

export interface CafeCrowdResult {
  /** 基礎客流(尚未被產能夾),已取整。 */
  base: number;
  /** 實際客流 = `min(base, capacity)`。 */
  guests: number;
  weatherMultiplier: number;
  weekdayMultiplier: number;
  popularityMultiplier: number;
  /** true = 今天被產能上限擋掉了客人(CAFE-15 可以據此提示「該加設備了」)。 */
  cappedByCapacity: boolean;
}

/**
 * 客流公式。**形狀直接抄 `coinLaundryIncome()`(`economy.ts:27`)的「設備數 × 係數 × 條件數」**,
 * 那條公式已經在正式版跑很久、經過平衡驗證。
 *
 * ```
 * 基礎客流 = 招牌等級 × 每級客流 × 天氣係數 × 星期係數 × (1 + 人氣加成)
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

  const signLevel = Math.max(0, finiteOr(input.signLevel, 1));
  const raw = signLevel * CAFE_CROWD_PER_SIGN_LEVEL * weatherMultiplier * weekdayMultiplier * popularityMultiplier * outdoor;
  const base = Math.max(0, Math.round(quantize(raw)));
  const capacity = Math.max(0, Math.floor(finiteOr(input.capacity, CAFE_BASE_CAPACITY)));
  const guests = Math.min(base, capacity);
  return { base, guests, weatherMultiplier, weekdayMultiplier, popularityMultiplier, cappedByCapacity: base > capacity };
}

// ---------------------------------------------------------------------------
// 6. 客單價(設計文件 §5.5)
// ---------------------------------------------------------------------------

/**
 * 基礎客單價。與六種原料的每客成本(≈ $16.6)一起看:毛利率約 54%,
 * 原料成本佔營收約 46%。刻意讓原料**佔得夠重**,常備訂單那條機制才有存在感。
 */
export const CAFE_BASE_TICKET = 36;

/**
 * 每日固定成本(水電、清潔、耗材、雜支)——設計文件 §5.5 的「淨利 = 營收 − 原料成本 − 固定成本」。
 *
 * 370 是解一個兩點聯立解出來的:成熟期(40 人)淨利要落在 $300–500,
 * 剛開張(26 人)又不能是負的、否則開店變成陷阱。
 */
export const CAFE_FIXED_COST = 370;

/**
 * 客單價 = 基礎價 × (1 + Σ 研發加成)。
 *
 * 🔴 **研發加成表是 CAFE-16 的範圍**,本項不猜任何研發 id 的數值,一律回 0
 * (`state.cafe.completed` 今天也恆為空)。公式先長好形狀,CAFE-16 只要換掉
 * `cafeResearchTicketBonus()` 的實作即可,呼叫端一行都不用改。
 */
export function cafeResearchTicketBonus(_completed: readonly string[] = []): number {
  return 0;
}

export function cafeTicketPrice(completed: readonly string[] = []): number {
  return Math.max(0, Math.round(CAFE_BASE_TICKET * (1 + cafeResearchTicketBonus(completed))));
}

// ---------------------------------------------------------------------------
// 7. 人氣
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
// 8. 日結敘事(設計文件 §5.2:缺貨與補不滿是敘事,不是懲罰)
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
