/**
 * 一樓寵物咖啡廳第一期研發樹（CAFE-16，設計文件 §5.3）。
 *
 * 本檔只放前兩層：三個基礎方向與七個直接子項。季節限定豆、造型拿鐵
 * 與下午茶套餐屬第三層，刻意不在本期偷跑。
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
  level: 1 | 2;
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
 * 第二層為 3～4 天、$3,500～5,000，符合「低頻、高重量」而非每日點擊。
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
    menuPrice: 39,
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
    menuPrice: 38,
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
    menuPrice: 38,
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
] as const satisfies readonly CafeResearchDefinition[];
