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

export const CAFE_UPGRADE_IDS = {
  signboard: "cafe_signboard",
  secondMachine: "cafe_second_machine",
  outdoorSeats: "cafe_outdoor_seats",
  coldStorage: "cafe_cold_storage",
  petTower: "cafe_pet_tower",
} as const;

export type CafeUpgradeId = (typeof CAFE_UPGRADE_IDS)[keyof typeof CAFE_UPGRADE_IDS];

export interface CafeUpgrade {
  id: CafeUpgradeId;
  name: string;
  price: number;
  effect: string;
}

/** 一次性、永久、不可退；價格照設計文件 §5.4。 */
export const CAFE_UPGRADES = [
  { id: CAFE_UPGRADE_IDS.signboard, name: "店面招牌", price: 30_000, effect: "基礎客流提高，租屋詢問更容易出現" },
  { id: CAFE_UPGRADE_IDS.secondMachine, name: "第二台咖啡機", price: 18_000, effect: "產能上限提高，尖峰時段少流失客人" },
  { id: CAFE_UPGRADE_IDS.outdoorSeats, name: "戶外座位", price: 25_000, effect: "晴天客流提高，雨天不生效" },
  { id: CAFE_UPGRADE_IDS.coldStorage, name: "大型冷藏", price: 15_000, effect: "生鮮免損耗量提高，損耗率減半" },
  { id: CAFE_UPGRADE_IDS.petTower, name: "貓跳台與軟墊", price: 12_000, effect: "寵物停留更久，認養詢問更容易出現" },
] as const satisfies readonly CafeUpgrade[];
