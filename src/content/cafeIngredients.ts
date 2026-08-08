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
 * 4. 🔴 **這裡不放「這個原料用在哪些商品」的字串。**
 *    2026-08-08 移除了手寫的 `usedIn: string[]`——它是 P1(逐位結帳)以前的裝飾文字,
 *    P1 之後就與菜單對不上了(寫「美式咖啡」,菜單上其實是「招牌美式咖啡」;
 *    寫「拿鐵」,實際是研發品「經典拉花拿鐵」),玩家照它補貨等於照過期的對照表補貨。
 *    **商品 ↔ 原料的唯一事實來源是 `CafeMenuItem.recipe`**,雙向對照一律用
 *    `sim/cafe.ts` 的 `cafeRecipeLines()` / `cafeIngredientMenuUse()` 推導。
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
  /**
   * 每位客人的**平均**消耗量。
   *
   * ⚠️ P1(逐位結帳)之後這個欄位**不再驅動任何扣料**——真正的消耗是
   * `cafe.ts` 的 `CAFE_BASE_MENU_ITEMS[].recipe` 逐位顧客扣的。本欄位退居
   * 「面板預估」與 `dailyDemand()` 的估算用途,取值是把各品項配方依基礎熱門度
   * 加權平均回推的期望值(見 `docs/咖啡廳經營玩法-重設計.md` §4.1)。
   */
  perGuest: number;
  /**
   * 建議常備量(CAFE-15 的預設值;玩家可自行覆寫)。
   *
   * P1 重訂:配方是「整數單位/份」,一份美式就吃掉 4 單位咖啡豆,舊值(20)撐不到半天。
   * 取值原則 = **成熟期(產能上限 40 人、人氣滿)實測 200 天的單日尖峰消耗再留餘裕**
   * (實測尖峰:咖啡豆 124 / 牛奶 12 / 麵粉 49 / 奶油 21 / 貓罐頭 51 / 寵物鮮食 21),
   * 且三種生鮮一律 `<= SPOILAGE_FREE_UNITS + 1/SPOILAGE_RATE - 1`(= 24),
   * 讓「照建議值玩」永遠零缺貨、零損耗——偷懶路線必須維持可行(設計文件 §4.3.1)。
   */
  defaultStandingOrder: number;
}

/**
 * 六種原料。設計文件 §5.2 只舉了四個例子,這裡增為六(三乾三鮮)。
 *
 * ## 🔴 P1(2026-08-04)重訂了全部六個 `unitPrice`
 *
 * 舊值(咖啡豆 $15、牛奶 $12、麵粉 $8、奶油 $18、貓罐頭 $25、寵物鮮食 $20)是為
 * 「平均每客消耗 $15.78」設計的**攤提價**,不是「一份商品實際吃掉多少料」的價。
 * P1 把營收改成逐位顧客照配方結帳之後,配方成本直接等於原料成本,舊價會讓
 * 咖啡毛利 56%、烘焙只剩 28%(重設計文件 §4.1 的警告)。
 *
 * 因此改成**低單價 × 多單位**:一份美式吃 4 單位咖啡豆($16)、一份烘焙小點吃
 * 2 單位麵粉 + 1 單位奶油($16)。低單價換來的整數粒度,才有辦法讓 13 個品項
 * (基礎 3 + 研發 10)的毛利**全部落在 45～60%** 這個 band 裡——
 * 高價品同時也高成本,「研發完就穩賺」不成立(設計文件 §4.1)。
 *
 * 各品項的配方、成本與毛利率驗算在 `src/sim/cafe.ts` 的
 * `CAFE_BASE_MENU_ITEMS` / `CAFE_RESEARCH_RECIPES`,並由
 * `scripts/cafe-per-guest-test.ts` 逐項硬斷言守住 45～60%。
 *
 * ⚠️ 貓罐頭刻意是**乾貨**:罐頭的存在意義就是常溫保存。
 * 寵物線的生鮮由「寵物鮮食」承擔,不讓寵物餐點整條免疫損耗。
 */
export const CAFE_INGREDIENTS = [
  {
    id: "coffee_bean",
    name: "咖啡豆",
    unitPrice: 4,
    perishable: false,
    category: "brew",
    perGuest: 1.9,
    defaultStandingOrder: 130,
  },
  {
    id: "milk",
    name: "牛奶",
    unitPrice: 3,
    perishable: true,
    category: "brew",
    perGuest: 0.25,
    defaultStandingOrder: 24,
  },
  {
    id: "flour",
    name: "麵粉",
    unitPrice: 3,
    perishable: false,
    category: "bake",
    perGuest: 0.7,
    defaultStandingOrder: 52,
  },
  {
    id: "butter",
    name: "奶油",
    unitPrice: 10,
    perishable: true,
    category: "bake",
    perGuest: 0.3,
    defaultStandingOrder: 24,
  },
  {
    id: "cat_can",
    name: "貓罐頭",
    unitPrice: 6,
    perishable: false,
    category: "pet",
    perGuest: 0.55,
    defaultStandingOrder: 56,
  },
  {
    id: "pet_fresh",
    name: "寵物鮮食",
    unitPrice: 5,
    perishable: true,
    category: "pet",
    perGuest: 0.2,
    defaultStandingOrder: 24,
  },
] as const satisfies readonly CafeIngredient[];

export type CafeIngredientId = (typeof CAFE_INGREDIENTS)[number]["id"];
