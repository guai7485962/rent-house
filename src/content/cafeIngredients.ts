/**
 * 咖啡廳原料的純資料層(CAFE-12,設計文件 §5.2)。
 *
 * 風格比照 `observationLines.ts` / `cafeGuestNames.ts`:**只有常數,沒有函式**,
 * 計算全部留在 `src/sim/cafe.ts`。
 *
 * 三條規則:
 * 1. **只能 append,不可插入或重排。** 補貨在錢不夠時依本陣列的宣告順序配額,
 *    重排會靜默改變「錢不夠時先補誰」,是隱性平衡改動。
 * 2. **只有 `perishable: true` 會過期損耗**(設計文件 §5.2 明訂,乾貨永不損耗)。
 * 3. 三個菜單分支(沖煮 / 烘焙 / 寵物餐點)各配一乾一鮮,
 *    所以沒有任何一條研發線可以完全避開缺貨,也沒有任何一條會被損耗整批掃掉。
 */

/** 原料所屬的菜單分支,對應設計文件 §5.3 研發樹的三條主幹。 */
export type CafeIngredientCategory = "brew" | "bake" | "pet";

export interface CafeIngredient {
  id: string;
  /** 顯示用中文名(CAFE-15 面板直接用)。 */
  name: string;
  /** 每單位進貨單價(元)。 */
  unitPrice: number;
  /** 生鮮:會過期損耗。乾貨(false)永遠不損耗。 */
  perishable: boolean;
  category: CafeIngredientCategory;
  /** 用在哪些品項(敘事與 UI 說明用,不參與計算)。 */
  usedIn: readonly string[];
  /**
   * 每位客人的平均消耗量。
   * 取值讓 30 位客人時的消耗量重現設計文件 §5.2 範例表的「今日消耗」欄
   * (咖啡豆 12、牛奶 9、麵粉 4、貓罐頭 3)。
   */
  perGuest: number;
  /**
   * 建議常備量(CAFE-15 的預設值;玩家可自行覆寫)。
   * 前四項直接照抄設計文件 §5.2 範例表。
   */
  defaultStandingOrder: number;
}

/**
 * 六種原料。設計文件 §5.2 只舉了四個例子,這裡增為六:
 *
 * - **保留原文四項與其單價**(咖啡豆 $15、牛奶 $12、麵粉 $8、貓罐頭 $25),
 *   避免與已拍板的範例表對不上。
 * - **新增奶油 $18、寵物鮮食 $20**,理由是原文四項裡只有牛奶是生鮮,
 *   「生鮮才會損耗」這條規則會退化成單一原料的特例;補到三鮮三乾之後,
 *   損耗與缺貨兩種後果才都有足夠的樣本可以被玩家感知,也才測得動。
 * - 兩個新單價取在既有價帶 $8–$25 之內:奶油 $18(烘焙裡最貴的料)、
 *   寵物鮮食 $20(比常溫罐頭便宜,因為它會壞——玩家本來就該有理由不囤它)。
 *
 * ⚠️ 貓罐頭刻意是**乾貨**:罐頭的存在意義就是常溫保存。
 * 寵物線的生鮮由「寵物鮮食」承擔,不讓寵物餐點整條免疫損耗。
 */
export const CAFE_INGREDIENTS = [
  {
    id: "coffee_bean",
    name: "咖啡豆",
    unitPrice: 15,
    perishable: false,
    category: "brew",
    usedIn: ["美式咖啡", "拿鐵", "手沖單品", "冷萃"],
    perGuest: 0.4,
    defaultStandingOrder: 20,
  },
  {
    id: "milk",
    name: "牛奶",
    unitPrice: 12,
    perishable: true,
    category: "brew",
    usedIn: ["拿鐵", "造型拿鐵", "司康"],
    perGuest: 0.3,
    defaultStandingOrder: 15,
  },
  {
    id: "flour",
    name: "麵粉",
    unitPrice: 8,
    perishable: false,
    category: "bake",
    usedIn: ["司康", "貓咪造型餅乾", "下午茶套餐"],
    perGuest: 0.13,
    defaultStandingOrder: 10,
  },
  {
    id: "butter",
    name: "奶油",
    unitPrice: 18,
    perishable: true,
    category: "bake",
    usedIn: ["司康", "貓咪造型餅乾"],
    perGuest: 0.08,
    defaultStandingOrder: 8,
  },
  {
    id: "cat_can",
    name: "貓罐頭",
    unitPrice: 25,
    perishable: false,
    category: "pet",
    usedIn: ["寵物友善點心"],
    perGuest: 0.1,
    defaultStandingOrder: 8,
  },
  {
    id: "pet_fresh",
    name: "寵物鮮食",
    unitPrice: 20,
    perishable: true,
    category: "pet",
    usedIn: ["寵物友善點心", "寵物生日蛋糕"],
    perGuest: 0.06,
    defaultStandingOrder: 6,
  },
] as const satisfies readonly CafeIngredient[];

export type CafeIngredientId = (typeof CAFE_INGREDIENTS)[number]["id"];
