/**
 * 咖啡廳顧客的純資料層。
 *
 * 顧客不進 state.runtimes，也不碰關係、收租或日誌。所有選擇由 caller 提供的
 * seed 決定，刻意不呼叫 Math.random，避免改變既有模擬的 RNG 序列。
 */
import type { Appearance, CafeGuest, CafeGuestIntent } from "../types";
import { cafeGuestNames } from "../content/cafeGuestNames";
import {
  ALL_ACCESSORIES,
  ALL_HAIR_STYLES,
  HAIR_COLORS,
  PANTS_COLORS,
  SHIRT_COLORS,
  SKIN_TONES,
} from "../pixel/parts";
import { MS_PER_GAME_HOUR } from "./clock";

export const CAFE_GUEST_CAP = 6;

export interface GenerateCafeGuestInput {
  /** 同一 seed + sequence 永遠得到同一位顧客。 */
  seed: string | number;
  arrivedMs: number;
  sequence?: number;
  /** 後續事件可指定意圖；未指定時按 coffee 70% / adopt 20% / rent 10% 決定。 */
  intent?: CafeGuestIntent;
  seatTile?: CafeGuest["seatTile"];
  /** 生成同批顧客時排除已使用姓名；全池皆排除時才允許循環。 */
  excludeNames?: readonly string[];
}

/** FNV-1a 32-bit：穩定、快速、零 RNG。 */
export function cafeGuestHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const indexFor = (key: string, size: number) => cafeGuestHash(key) % Math.max(1, size);
const pick = <T>(values: readonly T[], key: string): T => values[indexFor(key, values.length)];

function nameFor(key: string, excluded: ReadonlySet<string>): string {
  const start = indexFor(`${key}|name`, cafeGuestNames.length);
  for (let offset = 0; offset < cafeGuestNames.length; offset++) {
    const name = cafeGuestNames[(start + offset) % cafeGuestNames.length];
    if (!excluded.has(name)) return name;
  }
  return cafeGuestNames[start];
}

function appearanceFor(key: string): Appearance {
  const accessoryPool = ALL_ACCESSORIES.filter((item) => item !== "none");
  const withAccessory = indexFor(`${key}|accessory-roll`, 10) < 4;
  return {
    hairStyle: pick(ALL_HAIR_STYLES, `${key}|hair-style`),
    hairColor: pick(HAIR_COLORS, `${key}|hair-color`),
    shirt: pick(SHIRT_COLORS, `${key}|shirt`),
    pants: pick(PANTS_COLORS, `${key}|pants`),
    skin: pick(SKIN_TONES, `${key}|skin`),
    accessory: withAccessory ? pick(accessoryPool, `${key}|accessory`) : "none",
  };
}

function intentFor(key: string): CafeGuestIntent {
  const roll = indexFor(`${key}|intent`, 100);
  if (roll < 70) return "coffee";
  if (roll < 90) return "adopt";
  return "rent";
}

/** 建立一位決定性顧客；不讀寫全域 state，也不修改 input。 */
export function generateCafeGuest(input: GenerateCafeGuestInput): CafeGuest {
  const sequence = Math.max(0, Math.trunc(input.sequence ?? 0));
  const key = `${String(input.seed)}|${sequence}|${Math.trunc(input.arrivedMs)}`;
  const stayHours = 1 + indexFor(`${key}|stay`, 3);
  return {
    id: `cafe_guest_${cafeGuestHash(key).toString(36)}_${sequence}`,
    name: nameFor(key, new Set(input.excludeNames ?? [])),
    appearance: appearanceFor(key),
    intent: input.intent ?? intentFor(key),
    arrivedMs: input.arrivedMs,
    leavesMs: input.arrivedMs + stayHours * MS_PER_GAME_HOUR,
    seatTile: input.seatTile ? { ...input.seatTile } : null,
  };
}

/** 純函式：未滿 cap 才加入顧客，回傳新陣列。 */
export function appendCafeGuest(guests: readonly CafeGuest[], guest: CafeGuest): CafeGuest[] {
  if (guests.length >= CAFE_GUEST_CAP || guests.some((entry) => entry.id === guest.id)) return [...guests];
  return [...guests, guest];
}

/** 純函式：移除玩家已處理或已走到出口的指定顧客。 */
export function removeCafeGuest(guests: readonly CafeGuest[], guestId: string): CafeGuest[] {
  return guests.filter((guest) => guest.id !== guestId);
}

/** 純函式：時間到的顧客直接離場，不留下 runtime、關係或其他殘留。 */
export function removeDepartedCafeGuests(guests: readonly CafeGuest[], gameMs: number): CafeGuest[] {
  return guests.filter((guest) => guest.leavesMs > gameMs);
}
