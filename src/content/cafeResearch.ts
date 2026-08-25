/**
 * 一樓寵物咖啡廳研發樹（CAFE-16，設計文件 §5.3）。
 *
 * 前兩層：三個基礎方向與七個直接子項（CAFE-16 第一期）。
 *
 * ## 🔴 第三層（2026-08-25 上線；`docs/咖啡廳經營玩法-重設計.md` §4.10）
 *
 * 季節限定豆、造型拿鐵、下午茶套餐三項在 CAFE-16 第一期**刻意不偷跑**，
 * 這次補上，因為量測證實名店期離設計曲線的缺口 **100% 來自客單價**
 * （客流 118.6 已超過設計值 110、成本結構殘差只有 $29、`CAFE_MAX_AVG_TICKET`
 * 的 $55 夾值從來沒生效過）。
 *
 * 三項共同的三個設計約束：
 *
 * 1. **前置是招牌等級，不是設備。** 招牌 Lv2/Lv3/Lv4 各配一項 ⇒ 開張期一項都碰不到、
 *    每個階段恰好多開一項高價品。掛設備的話成長期就吃不到，中段曲線補不起來。
 * 2. **售價 $58~64，明顯高於前兩層的 $36~43 區間。** 第三層的價值全在客單價，
 *    毛利率仍守在既有的 45~60% band 內（由 `cafe-per-guest-test.ts` 逐項硬斷言）。
 * 3. **研發費固定 $3,000/項**，不照「逐層加價」的慣例。門檻由招牌前置
 *    （$30,000 / $60,000 / $110,000）承擔：中控訂的「名店期 105~115% 淨租金」
 *    反推整包第三層的日增益上限約 $231 ⇒ 60 天回本的研發費上限只有 $13,860，
 *    再貴就變成「解得開但永遠不划算」的死項目。
 *
 * **刻意不做寵物線第三層**：寵物線總權重只佔 16%，再加一項只會稀釋自己，
 * 驗算的名店期邊際只有 $11~25/日、回本 78~174 天，永遠追不上 60 天的門檻。
 */
import { CAFE_UPGRADE_IDS, type CafeUpgradeId } from "./cafeUpgrades";

export const CAFE_RESEARCH_IDS = {
  basicBrewing: "cafe_research_basic_brewing",
  pourOver: "cafe_research_pour_over",
  latteArt: "cafe_research_latte_art",
  coldBrew: "cafe_research_cold_brew",
  baking: "cafe_research_baking",
  scone: "cafe_research_scone",
  catCookie: "cafe_research_cat_cookie",
  petMeals: "cafe_research_pet_meals",
  petTreat: "cafe_research_pet_treat",
  petBirthdayCake: "cafe_research_pet_birthday_cake",
  // 🔴 第三層(2026-08-25)。**只能 append**:id 會進存檔的 `cafe.completed`。
  seasonalBean: "cafe_research_seasonal_bean",
  pawLatte: "cafe_research_paw_latte",
  afternoonTea: "cafe_research_afternoon_tea",
} as const;

export type CafeResearchId = (typeof CAFE_RESEARCH_IDS)[keyof typeof CAFE_RESEARCH_IDS];
export type CafeResearchTrack = "coffee" | "bakery" | "pet";
export type CafeMenuAudience =
  | "daily"
  | "single_origin"
  | "photo"
  | "cold_drink"
  | "sweet"
  | "afternoon_tea"
  | "family"
  | "pet_family"
  | "pet_companion"
  | "celebration";

export interface CafeResearchDefinition {
  id: CafeResearchId;
  name: string;
  track: CafeResearchTrack;
  level: 1 | 2 | 3;
  days: number;
  cost: number;
  menuItem: string;
  /** CAFE-17 菜單標價；平均客單價另由第二層品項多樣性里程碑與硬上限保護。 */
  menuPrice: number;
  /** 只描述客群結構，不改 CAFE-07 的 coffee/adopt/rent 意圖比例。 */
  audience: CafeMenuAudience;
  effect: string;
  requiresResearch: readonly CafeResearchId[];
  requiresUpgrades: readonly CafeUpgradeId[];
  /** CAFE-17/後續敘事可讀；CAFE-16 本身不觸發事件。 */
  specialEvent?: boolean;
}

/**
 * 根節點維持 2 天、$2,500～3,000，讓剛開張保留的 $6,000 周轉金仍有選擇；
 * 第二層為 3～4 天、$3,500～5,000，符合「低頻、高重量」而非每日點擊；
 * 第三層一律 6 天 / $3,000（門檻在招牌前置，不在研發費，理由見檔頭）。
 */
export const CAFE_RESEARCH = [
  {
    id: CAFE_RESEARCH_IDS.basicBrewing,
    name: "基礎沖煮",
    track: "coffee",
    level: 1,
    days: 2,
    cost: 2_500,
    menuItem: "本日配方咖啡",
    menuPrice: 36,
    audience: "daily",
    effect: "建立咖啡研發基礎，解鎖手沖、拉花與冷萃方向",
    requiresResearch: [],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.pourOver,
    name: "手沖單品",
    track: "coffee",
    level: 2,
    days: 3,
    cost: 4_000,
    menuItem: "今日手沖單品",
    menuPrice: 42,
    audience: "single_origin",
    effect: "菜單增加單品咖啡，為季節限定豆預留前置",
    requiresResearch: [CAFE_RESEARCH_IDS.basicBrewing],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.latteArt,
    name: "拿鐵拉花",
    track: "coffee",
    level: 2,
    days: 3,
    cost: 4_000,
    menuItem: "經典拉花拿鐵",
    menuPrice: 40,
    audience: "photo",
    effect: "菜單增加拉花拿鐵，為造型拿鐵預留前置",
    requiresResearch: [CAFE_RESEARCH_IDS.basicBrewing],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.coldBrew,
    name: "冷萃",
    track: "coffee",
    level: 2,
    days: 4,
    cost: 5_000,
    menuItem: "慢萃冰咖啡",
    menuPrice: 41,
    audience: "cold_drink",
    effect: "菜單增加冷萃飲品，需要大型冷藏穩定低溫製程",
    requiresResearch: [CAFE_RESEARCH_IDS.basicBrewing],
    requiresUpgrades: [CAFE_UPGRADE_IDS.coldStorage],
  },
  {
    id: CAFE_RESEARCH_IDS.baking,
    name: "烘焙",
    track: "bakery",
    level: 1,
    days: 2,
    cost: 2_500,
    menuItem: "每日磅蛋糕",
    menuPrice: 43,
    audience: "sweet",
    effect: "建立店內烘焙基礎，解鎖司康與造型餅乾",
    requiresResearch: [],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.scone,
    name: "司康",
    track: "bakery",
    level: 2,
    days: 3,
    cost: 3_500,
    menuItem: "奶油司康",
    menuPrice: 41,
    audience: "afternoon_tea",
    effect: "菜單增加司康，為下午茶套餐預留前置",
    requiresResearch: [CAFE_RESEARCH_IDS.baking],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.catCookie,
    name: "貓咪造型餅乾",
    track: "bakery",
    level: 2,
    days: 3,
    cost: 4_000,
    menuItem: "貓咪造型餅乾",
    menuPrice: 37,
    audience: "family",
    effect: "菜單增加容易被記住的招牌甜點",
    requiresResearch: [CAFE_RESEARCH_IDS.baking],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.petMeals,
    name: "寵物餐點",
    track: "pet",
    level: 1,
    days: 2,
    cost: 3_000,
    menuItem: "基礎寵物餐",
    menuPrice: 38,
    audience: "pet_family",
    effect: "建立寵物餐點基礎，解鎖友善點心與生日蛋糕",
    requiresResearch: [],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.petTreat,
    name: "寵物友善點心",
    track: "pet",
    level: 2,
    days: 3,
    cost: 3_500,
    menuItem: "寵物友善點心",
    menuPrice: 38,
    audience: "pet_companion",
    effect: "菜單增加可與毛孩分享的安全點心",
    requiresResearch: [CAFE_RESEARCH_IDS.petMeals],
    requiresUpgrades: [],
  },
  {
    id: CAFE_RESEARCH_IDS.petBirthdayCake,
    name: "寵物生日蛋糕",
    track: "pet",
    level: 2,
    days: 4,
    cost: 5_000,
    menuItem: "寵物生日蛋糕",
    menuPrice: 42,
    audience: "celebration",
    effect: "菜單增加生日蛋糕，並為寵物生日特殊事件預留解鎖",
    requiresResearch: [CAFE_RESEARCH_IDS.petMeals],
    requiresUpgrades: [CAFE_UPGRADE_IDS.petTower],
    specialEvent: true,
  },
  // -------------------------------------------------------------------------
  // 第三層（2026-08-25）：一階招牌配一項，售價 $58~64，研發費一律 $3,000 / 6 天。
  // -------------------------------------------------------------------------
  {
    id: CAFE_RESEARCH_IDS.seasonalBean,
    name: "季節限定豆",
    track: "coffee",
    level: 3,
    days: 6,
    cost: 3_000,
    menuItem: "季節限定單品豆",
    menuPrice: 64,
    audience: "single_origin",
    effect: "菜單增加當季精品豆單杯，是目前店裡最高價的一杯",
    requiresResearch: [CAFE_RESEARCH_IDS.pourOver],
    requiresUpgrades: [CAFE_UPGRADE_IDS.signboard],
  },
  {
    id: CAFE_RESEARCH_IDS.pawLatte,
    name: "造型拿鐵",
    track: "coffee",
    level: 3,
    days: 6,
    cost: 3_000,
    menuItem: "貓掌造型拿鐵",
    menuPrice: 58,
    audience: "photo",
    effect: "菜單增加高單價的拍照款拿鐵，需要街角立招帶來的人潮",
    requiresResearch: [CAFE_RESEARCH_IDS.latteArt],
    requiresUpgrades: [CAFE_UPGRADE_IDS.signboardLv3],
  },
  {
    id: CAFE_RESEARCH_IDS.afternoonTea,
    name: "下午茶套餐",
    track: "bakery",
    level: 3,
    days: 6,
    cost: 3_000,
    menuItem: "午後茶點套餐",
    menuPrice: 62,
    audience: "afternoon_tea",
    effect: "菜單增加成套的午後茶點，是名店期客單價的最後一塊",
    requiresResearch: [CAFE_RESEARCH_IDS.scone],
    requiresUpgrades: [CAFE_UPGRADE_IDS.signboardLv4],
  },
] as const satisfies readonly CafeResearchDefinition[];
