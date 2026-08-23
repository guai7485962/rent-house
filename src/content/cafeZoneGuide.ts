import type { CafeRegion } from "../floor/map";

/**
 * 咖啡廳家具的「應擺分區」對照表 —— 三個 UI 落點(商店標籤／家具詳情／CafePanel 小抄)
 * 共用同一份資料,不要各自複製一份判斷。
 *
 * ⚠️ 新增/刪除咖啡廳家具時要同步更新這份表:這裡沒有機制會自動偵測 catalog 漏登記,
 * cafe-zone-guide-test.ts 只釘「已登記的 defId 都合法」,不會提醒你漏登記新家具。
 *
 * `CafeRegion`(`floor/map.ts`)還多一個 `"stairs"`(通往三樓的樓梯格,不是給玩家理解的
 * 「分區」,`CAFE_PLACEMENT_REGIONS` 也沒把它算進四個可擺放區)——UI 只需要玩家看得懂的
 * 5 個區塊,所以這裡排除它,用窄化過的 `CafePlacementZone`。
 */
export type CafePlacementZone = Exclude<CafeRegion, "stairs">;

export interface CafeZoneRule {
  room: CafePlacementZone;
  label: string;
  emoji: string;
}

export const CAFE_ZONE_INFO: Record<CafePlacementZone, { label: string; emoji: string; color: string; desc: string }> = {
  cafe_floor:    { label: "主廳",   emoji: "🪵", color: "#c89b6b", desc: "蜂蜜木色地板,桌椅隨便擺,純氛圍" },
  cafe_counter:  { label: "吧台區", emoji: "🍷", color: "#b97572", desc: "玫瑰陶磚色,點餐吧台／咖啡機要擺這" },
  cafe_pet:      { label: "寵物區", emoji: "🐈", color: "#91ad8e", desc: "鼠尾草綠,貓跳台／軟墊要擺這" },
  cafe_back:     { label: "後場",   emoji: "📦", color: "#7f8992", desc: "灰藍色,貨架／木箱／冷藏櫃要擺這" },
  cafe_entrance: { label: "店門",   emoji: "🚪", color: "#a17a54", desc: "不可擺家具" },
};

/** 只列出「有機能需求」的家具;不在這裡的(菜單板/桌/兩張椅)不分區、不顯示提示。
 *  cafe_fridge 是二選一(storage6 vs tech2),UI 一律推薦後場(可保留完整 storage 加成;
 *  擺吧台只吃到 tech2,< CAFE_COUNTER_TECH_PER_STATION=3,單獨放不會開新服務位)。 */
export const CAFE_FURNITURE_ZONE: Record<string, CafeZoneRule> = {
  cafe_counter:         { room: "cafe_counter", label: "吧台區", emoji: "🍷" },
  espresso_machine:     { room: "cafe_counter", label: "吧台區", emoji: "🍷" },
  cafe_cat_tower:       { room: "cafe_pet",      label: "寵物區", emoji: "🐈" },
  cafe_pet_cushion:     { room: "cafe_pet",      label: "寵物區", emoji: "🐈" },
  cafe_stock_shelf:     { room: "cafe_back",     label: "後場",   emoji: "📦" },
  cafe_crate:           { room: "cafe_back",     label: "後場",   emoji: "📦" },
  cafe_display_stocked: { room: "cafe_back",     label: "後場",   emoji: "📦" },
  cafe_fridge:          { room: "cafe_back",     label: "後場",   emoji: "📦" },
};
