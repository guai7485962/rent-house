/** CAFE-14：咖啡廳開張與五個一次性投資項。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCafe } from "../src/sim/gameState";
import {
  buyCafeUpgrade,
  cafeCapability,
  CAFE_MACHINE_CUPS_BONUS,
  CAFE_MAX_SIGN_LEVEL,
  CAFE_SIGNBOARD_IDS,
  CAFE_STAFF_CUPS_PER_DAY,
  CAFE_COLD_STORAGE_FREE_MULT,
  CAFE_COLD_STORAGE_RATE_MULT,
  CAFE_OPENING_COST,
  CAFE_UPGRADES,
  CAFE_UPGRADE_IDS,
  getCafeUpgrade,
  openCafe,
  SPOILAGE_FREE_UNITS,
  SPOILAGE_RATE,
} from "../src/sim/cafe";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.25; };

try {
  const ids = CAFE_UPGRADES.map((item) => item.id);
  check("共有七個投資項且 id 不重複(P4a 追加兩級招牌)", CAFE_UPGRADES.length === 7 && new Set(ids).size === 7);
  check("投資 id 與 CAFE-13 既有能力讀取面完全一致",
    Object.values(CAFE_UPGRADE_IDS).every((id) => ids.includes(id)) && ids.every((id) => Object.values(CAFE_UPGRADE_IDS).includes(id)));
  check("每一項名稱／效果完整且價格為正整數",
    CAFE_UPGRADES.every((item) => item.name.trim().length > 0 && item.effect.trim().length > 0 && Number.isInteger(item.price) && item.price > 0));
  // 🔴 既有五項的 id 與順序不可改(`cafeCapability()` 與所有存檔都吃它們);
  //    P4a 的兩級招牌一律追加在最後面。
  check("既有五項的 id 與順序原封不動",
    JSON.stringify(ids.slice(0, 5)) === JSON.stringify([
      "cafe_signboard", "cafe_second_machine", "cafe_outdoor_seats", "cafe_cold_storage", "cafe_pet_tower",
    ]), JSON.stringify(ids));
  // 🔴 2026-09-02:大型冷藏 $15,000 → **$10,000**(唯一一次調價)。
  // 它是「保險 + 閘門」不是產能:價值方差 $0~$159.8/日 大於 §10.5 的回本帶寬 4.17 倍
  // ⇒ **純調價不可能讓兩端同時落在帶內**,所以判準改用「備貨過量情境」,
  // 而 60~250 的帶對那個情境**照樣生效**(護欄不留例外)。
  // $10,000 ⇒ 備貨過量 **62.6 天**(帶內)、照建議量 549.6 天(保險沒出險就是白買)。
  // ⚠️ 下界卡在這裡:$8,000 會讓備貨過量掉到 50.1 天、跌破 60 天。
  // 投資項不能變賣 ⇒ 無拆賣套利;舊存檔付過的價不受影響。
  check("價格與設計文件一致(冷藏 2026-09-02 降價,其餘一毛未動)",
    JSON.stringify(CAFE_UPGRADES.map((item) => item.price)) === JSON.stringify([30000, 18000, 25000, 10000, 12000, 60000, 110000]),
    JSON.stringify(CAFE_UPGRADES.map((item) => item.price)));
  // 2026-08-03 改寫:吧台($16,000)現在由開張免費附贈,玩家不必自己買,原斷言的前提已不成立。
  // 新校準改釘兩件事 ——
  // (1) 付完開張費後仍買得起第二台咖啡機($18,000),開張不會變成無法營業的陷阱;
  check("開張費讓種子局付完仍買得起第二台咖啡機", CAFE_OPENING_COST + 18000 <= 52000);
  // (2) 🔴 反套利硬性下界:全套贈品零售 $39,400、賣出退款率 50% ⇒ 拆賣可回收 $19,700。
  //     開張費必須高於這個數,否則「開張 → 立刻拆光賣掉」會變成不經營也穩賺的無腦動作。
  //     這條若紅了,代表有人調降開張費或加碼贈品,請一併重算,不要直接改數字。
  check("開張費高於全套贈品的拆賣回收價(反套利)", CAFE_OPENING_COST > (16000 + 4200 * 3 + 1800 * 6) * 0.5);
  check("未知投資查詢回 undefined", getCafeUpgrade("not_an_upgrade") === undefined);

  const closed = defaultCafe();
  const closedBefore = JSON.stringify(closed);
  const poorOpen = openCafe(closed, CAFE_OPENING_COST - 1);
  check("餘額不足不能開張且不扣款", !poorOpen.ok && poorOpen.reason === "金錢不足" && poorOpen.cost === 0 && poorOpen.moneyAfter === CAFE_OPENING_COST - 1);
  check("開張失敗不修改輸入 state", poorOpen.cafe === closed && JSON.stringify(closed) === closedBefore);

  const opened = openCafe(closed, CAFE_OPENING_COST);
  check("剛好足額可以開張並扣到零", opened.ok && opened.cafe.open && opened.cost === CAFE_OPENING_COST && opened.moneyAfter === 0);
  check("開張交易帶正確 label 與 cafe 分類", opened.label === "咖啡廳開張" && opened.category === "cafe");
  check("開張成功回傳新 state、原 state 仍未開張", opened.cafe !== closed && !closed.open && JSON.stringify(closed) === closedBefore);
  const reopened = openCafe(opened.cafe, 999999);
  check("重複開張不重複扣款", !reopened.ok && reopened.reason === "咖啡廳已經開張" && reopened.cost === 0 && reopened.moneyAfter === 999999);

  const unknown = buyCafeUpgrade(opened.cafe, 999999, "not_an_upgrade");
  check("未知投資零變更拒絕", !unknown.ok && unknown.reason === "沒有這種咖啡廳投資" && unknown.cafe === opened.cafe && unknown.cost === 0);
  const closedBuy = buyCafeUpgrade(closed, 999999, CAFE_UPGRADE_IDS.signboard);
  check("未開張不能先買投資", !closedBuy.ok && closedBuy.reason === "咖啡廳尚未開張" && closedBuy.cost === 0);
  const signDef = getCafeUpgrade(CAFE_UPGRADE_IDS.signboard)!;
  const poorBuy = buyCafeUpgrade(opened.cafe, signDef.price - 1, signDef.id);
  check("投資餘額不足不扣款", !poorBuy.ok && poorBuy.reason === "金錢不足" && poorBuy.moneyAfter === signDef.price - 1 && poorBuy.cost === 0);

  const openBeforeBuy = JSON.stringify(opened.cafe);
  const boughtSign = buyCafeUpgrade(opened.cafe, signDef.price, signDef.id);
  check("剛好足額可買投資並扣到零", boughtSign.ok && boughtSign.moneyAfter === 0 && boughtSign.cost === signDef.price);
  check("投資交易帶可讀 label 與 cafe 分類", boughtSign.label === `咖啡廳投資:${signDef.name}` && boughtSign.category === "cafe");
  check("購買 append id 且不修改輸入 state", boughtSign.cafe.upgrades.at(-1) === signDef.id && JSON.stringify(opened.cafe) === openBeforeBuy);
  check("招牌購買後既有能力讀取面立即生效", cafeCapability(boughtSign.cafe.upgrades).signLevel === 2);
  const duplicate = buyCafeUpgrade(boughtSign.cafe, 999999, signDef.id);
  check("相同投資只能買一次", !duplicate.ok && duplicate.reason === "咖啡廳已經做過這項投資" && duplicate.cost === 0);

  let cafe = opened.cafe;
  let money = CAFE_UPGRADES.reduce((sum, item) => sum + item.price, 0);
  for (const item of CAFE_UPGRADES) {
    const result = buyCafeUpgrade(cafe, money, item.id);
    if (!result.ok) break;
    cafe = result.cafe;
    money = result.moneyAfter;
  }
  check("依資料順序可購齊七項且總扣款精確", cafe.upgrades.length === 7 && money === 0,
    `${cafe.upgrades.length} 項、餘 ${money}`);
  const all = cafeCapability(cafe.upgrades);
  check("第二台咖啡機提高每位員工的杯數", all.cupsPerStaff === CAFE_STAFF_CUPS_PER_DAY + CAFE_MACHINE_CUPS_BONUS);
  check("戶外座位旗標生效", all.outdoorSeats);
  check("大型冷藏同時提高免損耗量並降低損耗率",
    all.spoilage.freeUnits === SPOILAGE_FREE_UNITS * CAFE_COLD_STORAGE_FREE_MULT
      && all.spoilage.rate === SPOILAGE_RATE * CAFE_COLD_STORAGE_RATE_MULT);
  check("買齊三塊招牌 = 招牌 Lv4", all.signLevel === CAFE_MAX_SIGN_LEVEL && all.signLevel === 4);
  check("貓跳台永久記錄但不污染日結能力欄位", cafe.upgrades.includes(CAFE_UPGRADE_IDS.petTower));

  // P4a:招牌必須逐級升(前置檢查)
  const lv3Def = getCafeUpgrade(CAFE_UPGRADE_IDS.signboardLv3)!;
  const skipLv2 = buyCafeUpgrade(opened.cafe, 999999, CAFE_UPGRADE_IDS.signboardLv3);
  check("沒有 Lv2 招牌不能直接買 Lv3", !skipLv2.ok && skipLv2.cost === 0
    && (skipLv2.reason ?? "").includes("店面招牌"), skipLv2.reason);
  const skipLv3 = buyCafeUpgrade(boughtSign.cafe, 999999, CAFE_UPGRADE_IDS.signboardLv4);
  check("只有 Lv2 招牌不能跳過 Lv3 直接買 Lv4", !skipLv3.ok && skipLv3.cost === 0);
  const boughtLv3 = buyCafeUpgrade(boughtSign.cafe, lv3Def.price, lv3Def.id);
  check("有 Lv2 就買得到 Lv3,且招牌等級升到 3",
    boughtLv3.ok && cafeCapability(boughtLv3.cafe.upgrades).signLevel === 3);
  check("既有五項都沒有前置條件(行為與 P4a 之前完全相同)",
    CAFE_UPGRADES.slice(0, 5).every((item) => (item as { requires?: string }).requires === undefined));
  check("手改存檔只塞了 Lv4 也只算 Lv2(少算不多算)",
    cafeCapability([CAFE_UPGRADE_IDS.signboardLv4]).signLevel === 2);
  check("招牌 id 清單就是三塊招牌", CAFE_SIGNBOARD_IDS.length === 3
    && CAFE_SIGNBOARD_IDS[0] === CAFE_UPGRADE_IDS.signboard);

  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "src", "sim", "cafe.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("開張／投資仍不 import 全域 state、tick、economy",
    !/from\s+"\.\/gameState"/.test(code) && !/from\s+"\.\/tick"/.test(code) && !/from\s+"\.\/economy"/.test(code));
  check("整條開張／購買流程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
