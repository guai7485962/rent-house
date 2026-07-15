/**
 * 房間升級階梯(設計檢討 7-1:給錢一個「長期去處」)。
 *
 * 與家具(可買可賣、影響即時需求)不同,升級是**一次性大額投資、不可退**:
 * - 永久提高該房屬性(吸引高星應徵者)
 * - 應徵者租金行情加成(rentBonus)
 * - 對在住租客談漲租的容忍度加成(tolBonus → tenancy.previewRent)
 * 安裝狀態存在這裡的 reactive(入存檔);購買入口 economy.buyUpgrade。
 */
import { reactive } from "vue";
import type { RoomAttribute } from "../types";

export interface UpgradeDef {
  id: string;
  icon: string;
  name: string;
  desc: string;
  price: number;
  /** 永久房間屬性加成(疊在家具屬性上) */
  attributes: Partial<Record<RoomAttribute, number>>;
  /** 應徵者租金行情加成(0.12 = +12%) */
  rentBonus: number;
  /** 對在住租客談漲租的容忍度加成 */
  tolBonus: number;
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: "soundproof_reno",
    icon: "🔇",
    name: "隔音改建",
    desc: "牆體加隔音棉、換氣密窗——夜貓、實況主和聲音敏感的租客最買單。",
    price: 12000,
    attributes: { soundproof: 8 },
    rentBonus: 0.12,
    tolBonus: 0.05,
  },
  {
    id: "premium_reno",
    icon: "✨",
    name: "精裝修",
    desc: "實木地板、間接照明、全室重新粉刷,整體質感直接翻一級。",
    price: 18000,
    attributes: { style: 7, cozy: 6 },
    rentBonus: 0.18,
    tolBonus: 0.07,
  },
  {
    id: "smart_home",
    icon: "📡",
    name: "智慧家居",
    desc: "智慧燈光、電子門鎖、對稱高速網路——科技控看了走不動路。",
    price: 15000,
    attributes: { tech: 8 },
    rentBonus: 0.12,
    tolBonus: 0.05,
  },
];

/**
 * 噪音裁決中 $3,000 的局部隔音處理。它會永久留在存檔並阻止同一房再次被一般噪音公審，
 * 但不提供完整改建的租金／漲租加成，也不在改建商店重複販售。
 */
export const EVENT_SOUNDPROOFING_ID = "event_soundproofing";
const HIDDEN_UPGRADES: UpgradeDef[] = [
  {
    id: EVENT_SOUNDPROOFING_ID,
    icon: "🛠️",
    name: "噪音改善工程",
    desc: "針對門縫、牆面與震動源做局部隔音處理。",
    price: 3000,
    attributes: { soundproof: 4 },
    rentBonus: 0,
    tolBonus: 0,
  },
];

export const getUpgradeDef = (id: string): UpgradeDef | undefined =>
  UPGRADES.find((u) => u.id === id) ?? HIDDEN_UPGRADES.find((u) => u.id === id);

/** 各房間已安裝的升級(入存檔;additive,舊存檔缺 = 空) */
export const upgradeState = reactive({ byRoom: {} as Record<string, string[]> });

export function roomUpgradeIds(roomId: string): string[] {
  return upgradeState.byRoom[roomId] ?? [];
}

/** 不重複地登記一項永久房間工程；費用與住戶效果由呼叫端處理。 */
export function grantRoomUpgrade(roomId: string, upgradeId: string): boolean {
  if (!getUpgradeDef(upgradeId)) return false;
  const ids = (upgradeState.byRoom[roomId] ??= []);
  if (ids.includes(upgradeId)) return false;
  ids.push(upgradeId);
  return true;
}

/** 該房升級帶來的屬性加成合計(placements.roomAttributes 會疊加) */
export function upgradeAttributes(roomId: string): Partial<Record<RoomAttribute, number>> {
  const totals: Partial<Record<RoomAttribute, number>> = {};
  for (const id of roomUpgradeIds(roomId)) {
    const def = getUpgradeDef(id);
    if (!def) continue;
    for (const [k, v] of Object.entries(def.attributes)) {
      totals[k as RoomAttribute] = (totals[k as RoomAttribute] ?? 0) + (v ?? 0);
    }
  }
  return totals;
}

/** 該房的應徵者租金行情加成合計 */
export function upgradeRentBonus(roomId: string): number {
  return roomUpgradeIds(roomId).reduce((s, id) => s + (getUpgradeDef(id)?.rentBonus ?? 0), 0);
}

/** 該房對在住租客談漲租的容忍度加成合計 */
export function upgradeTolBonus(roomId: string): number {
  return roomUpgradeIds(roomId).reduce((s, id) => s + (getUpgradeDef(id)?.tolBonus ?? 0), 0);
}
