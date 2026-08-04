/**
 * 咖啡廳顧客的純資料層。
 *
 * 顧客不進 state.runtimes，也不碰關係、收租或日誌。所有選擇由 caller 提供的
 * seed 決定，刻意不呼叫 Math.random，避免改變既有模擬的 RNG 序列。
 */
import type { Appearance, CafeGuest, CafeGuestIntent, CafeGuestOrder, Gender } from "../types";
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

/**
 * 同時在店的顧客上限。
 *
 * 🔴 P2 從 6 提高到 32,理由是**合流**:每一筆結帳都必須有一位可見顧客,
 * 上限一旦綁死就會出現「帳本上收了錢、畫面上沒有人」的分裂。
 *
 * 32 是「席次上限 + 一小時到客上限」的保守和:
 * - 內用另受 `CAFE_DINE_IN_CAP`(20)限制 ⇒ 長時間佔位的最多 20 位
 * - 剩下 12 格是**每小時到客的餘裕**。現行客流上限 = 產能上限 40 人/日
 *   (`CAFE_BASE_CAPACITY 26 + CAFE_CAPACITY_PER_MACHINE 14`),攤到 11 個
 *   營業小時 ⇒ 單一小時最多 4 位 ≪ 12。
 *
 * `scripts/cafe-p2-flow-test.ts` 直接斷言這條餘裕成立;若未來 P4b 把產能推到
 * 每小時 12 位以上,這裡必須同步放大,否則合流不變式會退化。
 */
export const CAFE_GUEST_CAP = 32;

/** 內用(佔席)顧客的上限;剩下的 cap 留給當小時的外帶/撲空客。 */
export const CAFE_DINE_IN_CAP = 20;

/**
 * 外帶／撲空顧客的停留時間(遊戲小時)。
 *
 * 0.25 遊戲小時 ≈ 128 現實秒(`REAL_SECONDS_PER_GAME_HOUR ≈ 514`),
 * 足夠走進門 → 走到吧台 → 點餐演出 → 走出去,又短到下一個整點就被清乾淨
 * ⇒ 他們不會霸著 `CAFE_GUEST_CAP` 的名額。
 */
export const CAFE_TAKEAWAY_STAY_HOURS = 0.25;

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
  /** P2:這位顧客實際點的東西(合流的核心)。 */
  order?: CafeGuestOrder | null;
  /** P2:true = 沒空席,點完就走 ⇒ 停留時間縮成 `CAFE_TAKEAWAY_STAY_HOURS`。 */
  takeaway?: boolean;
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

/**
 * 顧客姓名綁定的性別(CAFE-19 起需要)。
 *
 * 租屋意圖顧客會被轉成應徵者、進而可能入住,姓名與性別若分開亂抽就會重演
 * recruit.ts NAME_IDENTITIES 註解記錄的「男性姓名被存成女性、關係顯示成閨密」問題。
 * 只能 append,改動既有對應會讓舊存檔裡的同名應徵者換性別。
 */
const CAFE_GUEST_GENDERS: Record<string, Gender> = {
  方雨晴: "female", 石育誠: "male", 朱庭安: "female", 江佩珊: "female",
  何宇辰: "male", 呂心瑜: "female", 宋子維: "male", 杜婉庭: "female",
  沈嘉禾: "male", 卓映彤: "female", 邱語晨: "female", 柯昱翔: "male",
  施佳穎: "female", 紀柏宇: "male", 胡芷寧: "female", 范庭瑄: "female",
  唐以樂: "female", 夏允恩: "female", 孫奕帆: "male", 徐若安: "female",
  高詠晴: "female", 梁子謙: "male", 莊可欣: "female", 陸承澤: "male",
  傅宜蓁: "female", 彭凱文: "male", 游舒涵: "female", 程皓然: "male",
  葉采薇: "female", 廖沛辰: "male", 趙家妤: "female", 劉祐廷: "male",
};

/** 顧客姓名 → 固定性別;表外姓名(舊存檔或未來新增)以姓名雜湊決定,同名永遠同性別。 */
export function cafeGuestGender(name: string): Gender {
  return CAFE_GUEST_GENDERS[name] ?? (indexFor(`${name}|gender`, 2) === 0 ? "male" : "female");
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
  const stayHours = input.takeaway === true ? CAFE_TAKEAWAY_STAY_HOURS : 1 + indexFor(`${key}|stay`, 3);
  return {
    id: `cafe_guest_${cafeGuestHash(key).toString(36)}_${sequence}`,
    name: nameFor(key, new Set(input.excludeNames ?? [])),
    appearance: appearanceFor(key),
    intent: input.intent ?? intentFor(key),
    arrivedMs: input.arrivedMs,
    leavesMs: input.arrivedMs + Math.round(stayHours * MS_PER_GAME_HOUR),
    seatTile: input.seatTile ? { ...input.seatTile } : null,
    order: input.order ? { ...input.order } : null,
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
