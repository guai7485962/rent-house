/** CAFE-16：研發樹三層、前置條件、純交易與遊戲日倒數。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAFE_SIGNBOARD_IDS, CAFE_UPGRADE_IDS } from "../src/content/cafeUpgrades";
import { defaultCafe } from "../src/sim/gameState";
import {
  advanceCafeResearch,
  availableCafeResearch,
  cafeResearchDaysLeft,
  cafeResearchRequirementsMet,
  cafeResearchTicketBonus,
  cafeTicketPrice,
  CAFE_BASE_TICKET,
  CAFE_RESEARCH,
  CAFE_RESEARCH_IDS,
  getCafeResearch,
  startCafeResearch,
} from "../src/sim/cafe";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const snapshot = (value: unknown) => JSON.stringify(value);
const openedCafe = () => ({ ...defaultCafe(), open: true });

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return originalRandom(); };

try {
  // 1. 資料樹：三個根、七個直接子項，加上 2026-08-25 補進來的第三層三項。
  const ids = CAFE_RESEARCH.map((item) => item.id);
  const names = CAFE_RESEARCH.map((item) => item.name);
  check("三層共有 13 個研發節點且 id 不重複", CAFE_RESEARCH.length === 13 && new Set(ids).size === 13);
  check("第一層 3 項、第二層 7 項、第三層 3 項", CAFE_RESEARCH.filter((item) => item.level === 1).length === 3
    && CAFE_RESEARCH.filter((item) => item.level === 2).length === 7
    && CAFE_RESEARCH.filter((item) => item.level === 3).length === 3);
  check("三個第一層方向完整", ["基礎沖煮", "烘焙", "寵物餐點"].every((name) => names.includes(name)));
  // 🔴 這條在 2026-08-25 由「第三層不在 CAFE-16」**反轉**過來:第三層已經上線。
  check("第三層三項都在", ["季節限定豆", "造型拿鐵", "下午茶套餐"].every((name) => names.includes(name)));
  check("每項成本與天數都是正整數", CAFE_RESEARCH.every((item) => Number.isInteger(item.cost) && item.cost > 0
    && Number.isInteger(item.days) && item.days > 0));
  check("每項都有菜單品名與效果說明", CAFE_RESEARCH.every((item) => item.menuItem.trim() && item.effect.trim()));
  check("第二層各有一個有效第一層前置", CAFE_RESEARCH.filter((item) => item.level === 2).every((item) =>
    item.requiresResearch.length === 1 && CAFE_RESEARCH.some((parent) => parent.id === item.requiresResearch[0] && parent.level === 1)));
  check("第三層各有一個有效第二層前置", CAFE_RESEARCH.filter((item) => item.level === 3).every((item) =>
    item.requiresResearch.length === 1 && CAFE_RESEARCH.some((parent) => parent.id === item.requiresResearch[0] && parent.level === 2)));
  // 🔴 第三層的門檻**刻意放在招牌前置**($30,000/$60,000/$110,000)而不是研發費:
  //    研發費固定 $3,000,是「整包 60 天回本」反推出來的上限。招牌閘門同時保證
  //    開張期(招牌 Lv1)一項第三層都碰不到,而且每升一級招牌就恰好多開一項高價品。
  check("🔴 每一項第三層都以一塊招牌為前置(門檻在招牌,不在研發費)", (() => {
    const signs: string[] = [...CAFE_SIGNBOARD_IDS];
    const tier3 = CAFE_RESEARCH.filter((item) => item.level === 3);
    const gates = tier3.map((item) => item.requiresUpgrades.filter((id) => signs.includes(id)));
    return tier3.length === 3
      && gates.every((g) => g.length === 1)
      && new Set(gates.map((g) => g[0])).size === 3;  // 三項各佔一級,不重複
  })(), CAFE_RESEARCH.filter((i) => i.level === 3).map((i) => `${i.name}:${i.requiresUpgrades.join("/")}`).join(" "));
  check("🔴 研發費固定 $3,000/項(門檻由招牌承擔;調高會讓第三層永遠回不了本)",
    CAFE_RESEARCH.filter((item) => item.level === 3).every((item) => item.cost === 3_000 && item.days === 6));
  // 🔴 第三層的價值全在客單價 ⇒ 售價必須明顯高於前兩層的整個區間。
  check("🔴 三項第三層的售價都高於前兩層的最高價", (() => {
    const lower = CAFE_RESEARCH.filter((item) => item.level < 3).map((item) => item.menuPrice);
    return CAFE_RESEARCH.filter((item) => item.level === 3)
      .every((item) => item.menuPrice > Math.max(...lower));
  })(), `前兩層最高 $${Math.max(...CAFE_RESEARCH.filter((i) => i.level < 3).map((i) => i.menuPrice))}`
    + ` / 第三層 ${CAFE_RESEARCH.filter((i) => i.level === 3).map((i) => "$" + i.menuPrice).join(",")}`);
  check("只有生日蛋糕標示特殊事件", CAFE_RESEARCH.filter((item) => "specialEvent" in item && item.specialEvent).map((item) => item.id).join()
    === CAFE_RESEARCH_IDS.petBirthdayCake);
  check("冷萃需要大型冷藏、生日蛋糕需要貓跳台", getCafeResearch(CAFE_RESEARCH_IDS.coldBrew)?.requiresUpgrades.includes(CAFE_UPGRADE_IDS.coldStorage) === true
    && getCafeResearch(CAFE_RESEARCH_IDS.petBirthdayCake)?.requiresUpgrades.includes(CAFE_UPGRADE_IDS.petTower) === true);
  check("未知研發 id 回 undefined", getCafeResearch("cafe_research_missing") === undefined);

  // 2. 解鎖與前置條件。
  const closed = defaultCafe();
  const opened = openedCafe();
  const rootIds = [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals];
  check("未開張沒有可開始研發", availableCafeResearch(closed).length === 0);
  check("剛開張只開放三個第一層", snapshot(availableCafeResearch(opened).map((item) => item.id)) === snapshot(rootIds));
  const basicDone = { ...opened, completed: [CAFE_RESEARCH_IDS.basicBrewing] };
  check("完成基礎沖煮後，手沖與拉花解鎖", [CAFE_RESEARCH_IDS.pourOver, CAFE_RESEARCH_IDS.latteArt]
    .every((id) => availableCafeResearch(basicDone).some((item) => item.id === id)));
  check("沒有大型冷藏時冷萃仍鎖住", !availableCafeResearch(basicDone).some((item) => item.id === CAFE_RESEARCH_IDS.coldBrew));
  const coldReady = { ...basicDone, upgrades: [CAFE_UPGRADE_IDS.coldStorage] };
  check("研究與設備前置都滿足才解鎖冷萃", cafeResearchRequirementsMet(coldReady, getCafeResearch(CAFE_RESEARCH_IDS.coldBrew)!)
    && availableCafeResearch(coldReady).some((item) => item.id === CAFE_RESEARCH_IDS.coldBrew));

  // 3. 開始研發：純交易、單一 active、所有拒絕都零扣款。
  const unknown = startCafeResearch(opened, 10_000, "missing", 4);
  check("未知研發拒絕且零扣款", !unknown.ok && unknown.cost === 0 && unknown.moneyAfter === 10_000 && unknown.cafe === opened);
  const closedStart = startCafeResearch(closed, 10_000, CAFE_RESEARCH_IDS.basicBrewing, 4);
  check("未開張不能研發", !closedStart.ok && closedStart.reason === "咖啡廳尚未開張" && closedStart.cafe === closed);
  const locked = startCafeResearch(opened, 10_000, CAFE_RESEARCH_IDS.pourOver, 4);
  check("缺研究前置不能開始", !locked.ok && locked.reason === "研發前置條件尚未完成");
  const noEquipment = startCafeResearch(basicDone, 10_000, CAFE_RESEARCH_IDS.coldBrew, 4);
  check("缺設備前置不能開始", !noEquipment.ok && noEquipment.reason === "研發前置條件尚未完成");
  const poor = startCafeResearch(opened, 2_499, CAFE_RESEARCH_IDS.basicBrewing, 4);
  check("餘額不足不能開始且原狀態不變", !poor.ok && poor.cost === 0 && poor.moneyAfter === 2_499 && poor.cafe === opened);
  const badDay = startCafeResearch(opened, 10_000, CAFE_RESEARCH_IDS.basicBrewing, Number.NaN);
  check("非有限遊戲日拒絕", !badDay.ok && badDay.reason === "遊戲日期無效");

  const beforeStart = snapshot(opened);
  const started = startCafeResearch(opened, 6_000, CAFE_RESEARCH_IDS.basicBrewing, 12.9);
  check("開始成功：精確扣款、交易分類與標籤", started.ok && started.cost === 2_500 && started.moneyAfter === 3_500
    && started.category === "cafe" && started.label === "咖啡廳研發:基礎沖煮");
  check("開始成功寫入日序、天數與投入快照", started.cafe.research?.id === CAFE_RESEARCH_IDS.basicBrewing
    && started.cafe.research.startedDay === 12 && started.cafe.research.days === 2 && started.cafe.research.invested === 2_500);
  check("開始回傳新 state，不修改輸入", started.cafe !== opened && snapshot(opened) === beforeStart && opened.research === null);
  const concurrent = startCafeResearch(started.cafe, 99_999, CAFE_RESEARCH_IDS.baking, 13);
  check("同時只能研發一項", !concurrent.ok && concurrent.reason === "同時只能研發一項" && concurrent.cafe === started.cafe);
  check("有進行中項目時沒有其他可開始研發", availableCafeResearch(started.cafe).length === 0);
  const alreadyDone = startCafeResearch(basicDone, 99_999, CAFE_RESEARCH_IDS.basicBrewing, 13);
  check("已完成項目不能重做", !alreadyDone.ok && alreadyDone.reason === "這項研發已經完成");
  const exactCold = startCafeResearch(coldReady, 5_000, CAFE_RESEARCH_IDS.coldBrew, 20);
  check("設備前置滿足且剛好足額可開始冷萃", exactCold.ok && exactCold.moneyAfter === 0);

  // 4. 日數倒數與完成：N / N-1 / 0，未到期與無 active 保持原參考。
  check("開始當日顯示完整 2 天", cafeResearchDaysLeft(started.cafe, 12) === 2);
  check("隔日剩 1 天，到期日歸 0，過期仍為 0", cafeResearchDaysLeft(started.cafe, 13) === 1
    && cafeResearchDaysLeft(started.cafe, 14) === 0 && cafeResearchDaysLeft(started.cafe, 99) === 0);
  check("沒有 active 時 daysLeft 為 null", cafeResearchDaysLeft(opened, 99) === null);
  const pending = advanceCafeResearch(started.cafe, 13);
  check("未到期不建立新 state", !pending.changed && pending.cafe === started.cafe && pending.daysLeft === 1 && pending.completed === null);
  const activeBefore = snapshot(started.cafe);
  const finished = advanceCafeResearch(started.cafe, 14);
  check("到期清空 active 並加入 completed", finished.changed && finished.cafe.research === null
    && finished.cafe.completed.join() === CAFE_RESEARCH_IDS.basicBrewing && finished.completed?.id === CAFE_RESEARCH_IDS.basicBrewing);
  check("完成回傳新 state，原 active 不被修改", finished.cafe !== started.cafe && snapshot(started.cafe) === activeBefore);
  const idleAgain = advanceCafeResearch(finished.cafe, 30);
  check("完成後重複推進冪等", !idleAgain.changed && idleAgain.cafe === finished.cafe && idleAgain.completed === null);
  const duplicateActive = {
    ...finished.cafe,
    research: { id: CAFE_RESEARCH_IDS.basicBrewing, startedDay: 1, days: 2, invested: 2_500 },
  };
  const deduped = advanceCafeResearch(duplicateActive, 3);
  check("髒資料 active 已在 completed 時不重複加入", deduped.changed
    && deduped.cafe.completed.filter((id) => id === CAFE_RESEARCH_IDS.basicBrewing).length === 1);
  const unknownActive = { ...opened, research: { id: "future_research", startedDay: 1, days: 1, invested: 1 } };
  const keptUnknown = advanceCafeResearch(unknownActive, 3);
  check("未知 active 不吞玩家投入、回修復提示", !keptUnknown.changed && keptUnknown.cafe === unknownActive
    && keptUnknown.reason === "找不到進行中的研發資料");

  // 5. CAFE-17 邊界與純函式護欄。
  check("沒有完成研發時不會得到未賺取的客單價加成", cafeResearchTicketBonus([]) === 0
    && cafeTicketPrice([]) === CAFE_BASE_TICKET);
  const callsBefore = randomCalls;
  availableCafeResearch(coldReady);
  startCafeResearch(coldReady, 9_999, CAFE_RESEARCH_IDS.coldBrew, 20);
  cafeResearchDaysLeft(started.cafe, 13);
  advanceCafeResearch(started.cafe, 14);
  check("研發資料、開始與倒數零 Math.random", randomCalls === callsBefore, `calls=${randomCalls - callsBefore}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const cafeSource = readFileSync(join(here, "..", "src", "sim", "cafe.ts"), "utf8");
  const researchSection = cafeSource.split("// 6. 研發資料與日數倒數(CAFE-16)")[1]
    ?.split("// 7. 客流(設計文件 §5.5)")[0] ?? "";
  const researchCode = researchSection.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("找到 CAFE-16 獨立純函式區段", researchSection.length > 0);
  check("CAFE-16 維持純函式邊界", !/\bstate\s*\.|\baddMoney\s*\(|\bsave\s*\(/.test(researchCode));
  check("CAFE-16 沒有新增 Math.random 呼叫", !/Math\.random\s*\(/.test(researchCode));
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
