/**
 * 咖啡廳開張成本與五個一次性投資項(CAFE-14,設計文件 §5.4)。
 *
 * 本檔只有純資料；能力換算與購買規則留在 `src/sim/cafe.ts`。
 * id 已由 CAFE-13 的 `cafeCapability()` 使用，必須保持穩定且不可重排。
 */

/**
 * 開張費用以種子局 $52,000 校準。
 *
 * **2026-08-03 由 $12,000 調高到 $22,000**，因為開張現在會**免費附贈**整套店面家具
 * (`placeCafeStarterSet()`：吧台 ×1 + 小圓桌 ×3 + 椅 ×6，零售合計 $39,400)。
 * 原本的 $12,000 是「付完還買得起點餐吧台($16,000)」的校準 —— 玩家本來要自己買吧台，
 * 現在直接送，原校準已不成立。
 *
 * 定價的硬性下界是**變賣套利**：家具賣出退款率 50%(`economy.ts` 的 `sellFurnitureAt`)，
 * 全套拆賣可回收 $19,700。若開張費 < $19,700，「開張 → 立刻拆光賣掉」就會變成
 * **不經營也穩賺的無腦動作**。$22,000 讓這條路穩虧 $2,300，同時玩家的總支出仍比
 * 原設計(開張 $12,000 + 自購吧台 $16,000 = $28,000)便宜，付完保留 $30,000 周轉。
 */
export const CAFE_OPENING_COST = 22_000;

/**
 * 🔴 **既有五個鍵的名稱、值與宣告順序不可改**(`cafeCapability()` 與存檔都吃它們)。
 *
 * P4a 追加的兩個招牌等級一律**接在最後面**:新 id = 新欄位,舊存檔讀不到就是沒買過,
 * 不需要 migration、不需要升 `SAVE_VERSION`。
 */
export const CAFE_UPGRADE_IDS = {
  signboard: "cafe_signboard",
  secondMachine: "cafe_second_machine",
  outdoorSeats: "cafe_outdoor_seats",
  coldStorage: "cafe_cold_storage",
  petTower: "cafe_pet_tower",
  signboardLv3: "cafe_signboard_lv3",
  signboardLv4: "cafe_signboard_lv4",
} as const;

export type CafeUpgradeId = (typeof CAFE_UPGRADE_IDS)[keyof typeof CAFE_UPGRADE_IDS];

export interface CafeUpgrade {
  id: CafeUpgradeId;
  name: string;
  price: number;
  effect: string;
  /**
   * 前置投資(P4a 新增)。招牌必須逐級升:沒有 Lv2 就買不到 Lv3。
   * 省略 = 沒有前置(既有五項都是),`buyCafeUpgrade()` 的既有行為完全不變。
   */
  requires?: CafeUpgradeId;
}

/**
 * 招牌逐級升所帶來的**基礎客流**(`CAFE_CROWD_PER_SIGN_LEVEL = 22`/級)一級不變,
 * 但每一級的價格逐級拉開 —— 設計文件 §4.7 要的是「慢慢成長」,不是三個月滿級。
 *
 * ### 定價推導(回本天數逐級拉長)
 *
 * 一級招牌 = +22 基礎客流,乘上該階段的長期平均乘數(天氣 0.99 × 星期 1.02 ×
 * 人氣 1.15~1.25 × 氛圍 1.11~1.20)後,實際多出來的日客流約:
 *
 * | 升級 | 該階段實際增客 | 毛利/客 ≈ $19 | 每日毛利增益 | 定價 | 回本 |
 * |---|---|---|---|---|---|
 * | Lv1 → Lv2 | ≈ 28 人 | | ≈ $532 | **$30,000**(不動) | 56 天 |
 * | Lv2 → Lv3 | ≈ 31 人 | | ≈ $589 | **$60,000** | 102 天 |
 * | Lv3 → Lv4 | ≈ 33 人 | | ≈ $627 | **$110,000** | 175 天 |
 *
 * Lv2 的 $30,000 **刻意一毛不動**:它是既有存檔已經付過的價格,調它等於回頭改帳。
 * Lv3/Lv4 用「回本 56 → 102 → 175 天」這條逐級拉長的等比帶回推,
 * 讓四個階段之間各隔約兩、三、六個遊戲月 —— 這正是 §4.7 說的「刻意留長」。
 *
 * 另外要注意:光升招牌**不會**自己變成收入,`cafeCapability()` 的產能同時被
 * 席次與員工夾住(§4.7 的新產能公式)。買了 Lv4 卻沒椅子沒員工 = 花了 $110,000 買不到客人。
 */
export const CAFE_UPGRADES = [
  { id: CAFE_UPGRADE_IDS.signboard, name: "店面招牌", price: 30_000, effect: "基礎客流提高，租屋詢問更容易出現" },
  { id: CAFE_UPGRADE_IDS.secondMachine, name: "第二台咖啡機", price: 18_000, effect: "每位員工每日可處理的杯數提高，尖峰時段少流失客人" },
  {
    id: CAFE_UPGRADE_IDS.outdoorSeats,
    name: "戶外座位",
    price: 25_000,
    // 🔴 這句文案在**規則上**是有意義的,不是修辭:戶外區自帶座位又多半自取
    // ⇒ 它的產能加在 `min(席次腿, 員工腿)` 的**外面**(`CAFE_OUTDOOR_CAPACITY`)。
    // 玩家要能看懂自己買到的是「一塊不搶店內位子也不搶人手的區域」,而不是「+10 個數字」。
    effect: "騎樓自成一區：自帶座位、客人多半自取，不占店內席次也不占店員人手，每天穩定多做一批；晴天再多招來一些客人",
  },
  {
    id: CAFE_UPGRADE_IDS.coldStorage,
    /**
     * 🔴 **$15,000 → $10,000(2026-09-02)。它是保險 + 閘門,不是產能。**
     *
     * 實測:損耗的天花板只有 **$18.2/日**(名店期),而冷藏拿走的是那 100%
     * ($18.2 → $0.0)—— 不是沒接上,是「可影響的量」本來就近乎零。根因在
     * §4.3.1「懶人路線必須零損耗」把 `SPOILAGE_FREE_UNITS = 23` 釘死成唯一解。
     *
     * 它唯一值錢的情境是**玩家自己備太多**(常備量 ×1.5):名店期救回 **$159.8/日**
     * (`cafe-growth-sim.ts` 的「大型冷藏的兩個情境」表)。
     *
     * ⚠️ **純調價無解的證明**:它的價值方差是 $0 ~ $159.8/日,遠大於 §10.5 的
     * 回本帶寬 250/60 = **4.17 倍** ⇒ **任何單一售價都不可能讓兩端同時落在帶內**。
     * 所以判準改掉:它用**「備貨過量情境」**判定,而 60~250 的帶對那個情境**照樣生效**
     * (護欄不留例外)。$10,000 ⇒ 備貨過量回本 **62.6 天**,落在帶內;
     * 玩得好、從不備太多的人是 **549.6 天**,而**那是正確的** —— 保險沒出險就是白買。
     *
     * ⚠️ 定價下界由此而來:$8,000 會讓備貨過量掉到 50.1 天、**跌破 60 天下界**。
     *
     * 投資項不能變賣 ⇒ 降價沒有拆賣套利風險;既有存檔已付過的價格不受影響。
     */
    name: "大型冷藏",
    price: 10_000,
    effect: "解鎖「冷萃」研發；生鮮免損耗量提高、損耗率減半——備貨保守時本來就壞不了幾單位，備多了才看得出它在擋損失",
  },
  { id: CAFE_UPGRADE_IDS.petTower, name: "貓跳台與軟墊", price: 12_000, effect: "寵物停留更久，認養詢問更容易出現" },
  {
    id: CAFE_UPGRADE_IDS.signboardLv3,
    name: "街角立招（招牌 Lv3）",
    price: 60_000,
    effect: "招牌升到 Lv3，基礎客流再提高一級",
    requires: CAFE_UPGRADE_IDS.signboard,
  },
  {
    id: CAFE_UPGRADE_IDS.signboardLv4,
    name: "霓虹招牌與遮陽棚（招牌 Lv4）",
    price: 110_000,
    effect: "招牌升到 Lv4，基礎客流再提高一級",
    requires: CAFE_UPGRADE_IDS.signboardLv3,
  },
] as const satisfies readonly CafeUpgrade[];

/** 招牌等級由低到高的投資 id;`cafeCapability()` 與購買前置都讀這一份。 */
export const CAFE_SIGNBOARD_IDS = [
  CAFE_UPGRADE_IDS.signboard,
  CAFE_UPGRADE_IDS.signboardLv3,
  CAFE_UPGRADE_IDS.signboardLv4,
] as const;

/** 招牌的最高等級(未投資 = Lv1)。 */
export const CAFE_MAX_SIGN_LEVEL = 1 + CAFE_SIGNBOARD_IDS.length;
