/** CAFE-07：CafeGuest 型別、獨立姓名池、決定性生成與純函式離場。 */
import type { CafeGuest } from "../src/types";
import { cafeGuestNames } from "../src/content/cafeGuestNames";
import { genderForKnownName } from "../src/sim/recruit";
import { state } from "../src/sim/gameState";
import {
  ALL_ACCESSORIES,
  ALL_HAIR_STYLES,
  HAIR_COLORS,
  PANTS_COLORS,
  SHIRT_COLORS,
  SKIN_TONES,
} from "../src/pixel/parts";
import { MS_PER_GAME_HOUR } from "../src/sim/clock";
import {
  appendCafeGuest,
  CAFE_GUEST_CAP,
  cafeGuestHash,
  generateCafeGuest,
  removeCafeGuest,
  removeDepartedCafeGuests,
} from "../src/sim/cafeGuests";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.123456789; };

try {
  check("獨立姓名池至少 30 筆且沒有空白", cafeGuestNames.length >= 30 && cafeGuestNames.every((name) => name.trim().length > 0));
  check("顧客姓名池內沒有重複", new Set(cafeGuestNames).size === cafeGuestNames.length);
  check("顧客姓名不與租客 NAME_IDENTITIES 重疊", cafeGuestNames.every((name) => genderForKnownName(name) === undefined));

  const input = { seed: "day-42", arrivedMs: 42 * MS_PER_GAME_HOUR, sequence: 3, seatTile: { c: 4, r: 43 } } as const;
  const runtimeIdsBefore = Object.keys(state.runtimes).sort().join("|");
  const first = generateCafeGuest(input);
  const again = generateCafeGuest(input);
  check("相同 seed 與 sequence 生成結果逐欄一致", JSON.stringify(first) === JSON.stringify(again));
  check("輸入的 seatTile 沒被共用或修改", first.seatTile !== input.seatTile && input.seatTile.c === 4 && input.seatTile.r === 43);
  check("顧客 id 使用獨立 cafe_guest namespace", first.id.startsWith("cafe_guest_"));
  check("顧客姓名只取自獨立姓名池", (cafeGuestNames as readonly string[]).includes(first.name));
  check("停留時間介於 1～3 個遊戲小時", first.leavesMs - first.arrivedMs >= MS_PER_GAME_HOUR && first.leavesMs - first.arrivedMs <= 3 * MS_PER_GAME_HOUR);
  check("外觀髮型來自既有白名單", ALL_HAIR_STYLES.includes(first.appearance.hairStyle));
  check("外觀顏色全部來自既有白名單", HAIR_COLORS.includes(first.appearance.hairColor) && SHIRT_COLORS.includes(first.appearance.shirt) && PANTS_COLORS.includes(first.appearance.pants) && SKIN_TONES.includes(first.appearance.skin));
  check("外觀配件來自既有白名單", ALL_ACCESSORIES.includes(first.appearance.accessory));

  const generated = Array.from({ length: 120 }, (_, sequence) => generateCafeGuest({ seed: "coverage", arrivedMs: 0, sequence }));
  check("不同 sequence 的 id 不重複", new Set(generated.map((guest) => guest.id)).size === generated.length);
  check("決定性預設生成能涵蓋三種意圖", new Set(generated.map((guest) => guest.intent)).size === 3);
  check("呼叫端可指定認養意圖", generateCafeGuest({ seed: 7, arrivedMs: 0, intent: "adopt" }).intent === "adopt");
  const excluded = cafeGuestNames.slice(0, cafeGuestNames.length - 1);
  check("生成時會避開同批已使用姓名", generateCafeGuest({ seed: 9, arrivedMs: 0, excludeNames: excluded }).name === cafeGuestNames.at(-1));
  check("hash 對相同輸入穩定且為 unsigned 32-bit", cafeGuestHash("咖啡廳") === cafeGuestHash("咖啡廳") && cafeGuestHash("咖啡廳") >= 0);

  const six = generated.slice(0, CAFE_GUEST_CAP);
  const capped = appendCafeGuest(six, generated[CAFE_GUEST_CAP]);
  check("顧客陣列 cap 固定為 6", CAFE_GUEST_CAP === 6 && capped.length === 6);
  check("appendCafeGuest 不修改來源陣列", six.length === 6 && capped !== six);
  check("重複 id 不會加入第二次", appendCafeGuest([first], first).length === 1);

  const beforeLeave = [
    { ...generated[0], id: "left", leavesMs: 100 },
    { ...generated[1], id: "stay", leavesMs: 101 },
  ] satisfies CafeGuest[];
  const afterTime = removeDepartedCafeGuests(beforeLeave, 100);
  check("到點顧客離場、未到點顧客保留", afterTime.map((guest) => guest.id).join() === "stay");
  check("時間離場純函式不修改來源", beforeLeave.length === 2 && afterTime !== beforeLeave);
  check("可依 id 移除已處理顧客", removeCafeGuest(beforeLeave, "stay").map((guest) => guest.id).join() === "left");
  check("所有生成與離場函式零 Math.random 呼叫", randomCalls === 0, `calls=${randomCalls}`);
  check("生成與離場不污染 state.runtimes", Object.keys(state.runtimes).sort().join("|") === runtimeIdsBefore);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
