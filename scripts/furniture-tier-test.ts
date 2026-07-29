/**
 * 家具品質層級(tier)接上舒適度的驗證。
 *
 * 核心驗收點:
 * - 同型三階遞增(單人床 < 雙人床 < 帷幔床)——玩家多花錢買得到數值差
 * - **零屬性家具也有 tier 差**——證明沒退化成「attributes 乘子」的空砲方案
 * - 未標 tier 的家具(畢業生紀念物、UNKNOWN_DEF)fallback 為中性 standard,不是 budget
 * - tierPart 有上限夾值(狂塞 premium 小物刷不了分)
 * - 零 RNG:覆寫 Math.random 並計數,被呼叫就 fail
 * - COMFORT_LIMITS.tierMax 與實際上限一致(防 UI 面板與計算脫鉤)
 */
// 固定種子 PRNG + localStorage mock —— 必須在載入 store 之前
let seed = 20260729;
const seededRandom = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = seededRandom;
const store = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

await import("../src/store");
const { roomComfortBreakdown, COMFORT_LIMITS, cleanlinessMultiplier } = await import("../src/sim/comfort");
const { addPlacement } = await import("../src/sim/placements");
const { getDef, CATALOG } = await import("../src/furniture/catalog");
const { TIER_POINTS, TIER_INFO, DEFAULT_TIER, tierOf, tierPoints, tierChipText } =
  await import("../src/furniture/tier");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/** 只放指定家具的乾淨探針房(id 唯一,不與種子房互相汙染) */
let probeSeq = 0;
function probeRoom(defIds: string[]): string {
  const room = `r_tier_probe_${probeSeq++}`;
  defIds.forEach((defId, i) => addPlacement({ defId, room, c: i, r: 1 } as any));
  return room;
}
const tierPartOf = (room: string) => roomComfortBreakdown(room, 100).tierPart;

// --- 1. TIER_POINTS 值域合法、standard 是中性基準 ---
check(
  `三階點數遞增且非負(budget ${TIER_POINTS.budget} < standard ${TIER_POINTS.standard} < premium ${TIER_POINTS.premium})`,
  TIER_POINTS.budget >= 0 && TIER_POINTS.budget < TIER_POINTS.standard && TIER_POINTS.standard < TIER_POINTS.premium,
);
check(
  `standard 是中性基準(fallback = ${DEFAULT_TIER},且點數落在 budget 與 premium 之間)`,
  DEFAULT_TIER === "standard" && TIER_POINTS[DEFAULT_TIER] === TIER_POINTS.standard,
);
check(
  "TIER_INFO 三階都有星數與中文標籤(UI 文案與係數同檔,不會改了一邊忘另一邊)",
  (["budget", "standard", "premium"] as const).every(
    (t) => TIER_INFO[t].stars.length > 0 && TIER_INFO[t].label.length > 0 && tierChipText(t).includes(String(TIER_POINTS[t])),
  ),
);
check(
  "單件點數遠小於整房上限(單件不該主宰舒適度)",
  TIER_POINTS.premium * 3 <= COMFORT_LIMITS.tierMax,
);

// --- 2. 未標 tier 的家具 fallback 為 standard(不是 budget!) ---
// 畢業生紀念物是「留下的禮物」,fallback 成 budget 會讓它變相對扣分,語意完全相反。
const MEMORIALS = ["memorial_poster", "memorial_sign", "memorial_cert", "memorial_book", "memorial_frame"];
check(
  "畢業生紀念物確實沒標 tier(前提成立,否則本測試失去意義)",
  MEMORIALS.every((id) => getDef(id).tier === undefined),
);
check(
  `未標 tier 的紀念物 fallback 為 standard(memorial_poster → ${tierOf(getDef("memorial_poster"))} / ${tierPoints(getDef("memorial_poster"))} 點)`,
  MEMORIALS.every((id) => tierOf(getDef(id)) === "standard" && tierPoints(getDef(id)) === TIER_POINTS.standard),
);
check(
  `查無 id 的 UNKNOWN_DEF 同樣 fallback standard(→ ${tierOf(getDef("不存在的id"))})`,
  tierOf(getDef("不存在的id")) === "standard" && tierPoints(getDef("不存在的id")) === TIER_POINTS.standard,
);
const memorialRoom = probeRoom(["memorial_poster"]);
const budgetRoom = probeRoom(["plastic_stool"]);
check(
  `紀念物房的 tierPart 高於平價家具房(${tierPartOf(memorialRoom)} > ${tierPartOf(budgetRoom)},紀念物不會變扣分)`,
  tierPartOf(memorialRoom) > tierPartOf(budgetRoom),
);
check(
  "目錄裡每件家具的 tier 都能解析成合法係數(不再有純標示、無係數的 tier)",
  CATALOG.every((d) => Number.isFinite(tierPoints(d)) && tierPoints(d) >= 0),
);

// --- 3. 同型三階遞增(核心驗收):單人床 < 雙人床 < 帷幔床 ---
const bedBudget = roomComfortBreakdown(probeRoom(["single_bed"]), 100);
const bedStandard = roomComfortBreakdown(probeRoom(["double_bed"]), 100);
const bedPremium = roomComfortBreakdown(probeRoom(["canopy_bed"]), 100);
check(
  `床鋪三階 tierPart 嚴格遞增(${bedBudget.tierPart} < ${bedStandard.tierPart} < ${bedPremium.tierPart})`,
  bedBudget.tierPart < bedStandard.tierPart && bedStandard.tierPart < bedPremium.tierPart,
);
check(
  `床鋪三階整體舒適度嚴格遞增(${bedBudget.comfort.toFixed(2)} < ${bedStandard.comfort.toFixed(2)} < ${bedPremium.comfort.toFixed(2)})`,
  bedBudget.comfort < bedStandard.comfort && bedStandard.comfort < bedPremium.comfort,
);

// --- 4. 零屬性家具也有 tier 差(證明沒退化成 attributes 乘子的空砲) ---
// 曬衣架(budget)與淋浴間(standard):同為 utility、attributes 皆空 →
// 兩房的 attrPart 與 categoryPart 完全相同,舒適度差額**只可能**來自 tier。
const ZERO_ATTR_BUDGET = "drying_rack";
const ZERO_ATTR_STANDARD = "shower";
check(
  `前提:${ZERO_ATTR_BUDGET} / ${ZERO_ATTR_STANDARD} 同類別、attributes 皆空、tier 不同`,
  [ZERO_ATTR_BUDGET, ZERO_ATTR_STANDARD].every((id) => Object.values(getDef(id).attributes).every((v) => !v)) &&
    getDef(ZERO_ATTR_BUDGET).category === getDef(ZERO_ATTR_STANDARD).category &&
    getDef(ZERO_ATTR_BUDGET).tier !== getDef(ZERO_ATTR_STANDARD).tier,
);
const zeroA = roomComfortBreakdown(probeRoom([ZERO_ATTR_BUDGET]), 100);
const zeroB = roomComfortBreakdown(probeRoom([ZERO_ATTR_STANDARD]), 100);
check(
  `零屬性家具的 attrPart 都是 0(${zeroA.attrPart} / ${zeroB.attrPart}),乘子方案在這裡會是 0×n 的空砲`,
  zeroA.attrPart === 0 && zeroB.attrPart === 0 && zeroA.categoryPart === zeroB.categoryPart,
);
check(
  `零屬性家具仍吃得到 tier 差 → 舒適度不同(${zeroA.comfort.toFixed(2)} < ${zeroB.comfort.toFixed(2)})`,
  zeroB.comfort > zeroA.comfort &&
    Math.abs((zeroB.comfort - zeroA.comfort) - (TIER_POINTS.standard - TIER_POINTS.budget)) < 1e-9,
);
// 零屬性的機能家具(爐具/馬桶/洗衣機…)同樣吃得到 tier
const stoveRoom = probeRoom(["stove"]);
const washerRoom = probeRoom(["laundry_washer"]);
check(
  `零屬性機能家具都計入 tierPart(stove ${tierPartOf(stoveRoom)} / 洗衣機 ${tierPartOf(washerRoom)},洗衣機 standard 高於 stove budget)`,
  tierPartOf(washerRoom) > tierPartOf(stoveRoom) && tierPartOf(washerRoom) > 0,
);

// --- 5. tierPart 上限夾住(狂塞 premium 小物刷不了分) ---
const spamRoom = `r_tier_spam`;
for (let i = 0; i < 20; i++) addPlacement({ defId: "canopy_bed", room: spamRoom, c: i, r: 1 } as any);
const spam = roomComfortBreakdown(spamRoom, 100);
check(
  `塞 20 件 premium 家具 tierPart 夾在上限(${spam.tierPart} === ${COMFORT_LIMITS.tierMax},未夾值應為 ${20 * TIER_POINTS.premium})`,
  spam.tierPart === COMFORT_LIMITS.tierMax && 20 * TIER_POINTS.premium > COMFORT_LIMITS.tierMax,
);
check(
  `上限夾住後舒適度仍不破 100(${spam.comfort.toFixed(1)})`,
  spam.comfort <= 100,
);

// --- 6. 空房 tierPart = 0、roomId === null 回中性 ---
const bare = roomComfortBreakdown("r_tier_bare", 100);
check(
  `空房 tierPart 為 0 且舒適度仍為 0(comfort ${bare.comfort})`,
  bare.tierPart === 0 && bare.comfort === 0,
);
const neutral = roomComfortBreakdown(null, 0);
check(
  `roomId 為 null → 中性拆解(comfort ${neutral.comfort}、tierPart ${neutral.tierPart})`,
  neutral.comfort === 50 && neutral.tierPart === 0 &&
    neutral.attrPart + neutral.categoryPart + neutral.tierPart === 50,
);

// --- 7. COMFORT_LIMITS.tierMax 與實際上限一致(防 UI 面板與計算脫鉤) ---
check(
  `tierMax 是正數且等於實測上限(${COMFORT_LIMITS.tierMax})`,
  COMFORT_LIMITS.tierMax > 0 && spam.tierPart === COMFORT_LIMITS.tierMax,
);
check(
  "任何房間的 tierPart 都落在 0~tierMax(面板進度條不會爆格)",
  [memorialRoom, budgetRoom, spamRoom, "r301", "r302", "r303", "r304", "r_tier_bare"].every((room) => {
    const t = roomComfortBreakdown(room, 100).tierPart;
    return t >= 0 && t <= COMFORT_LIMITS.tierMax;
  }),
);

// --- 8. 加法對得起來:(attr + cat + tier) × cleanMult = comfort(面板一致性) ---
const idCases: [string | null, number][] = [
  ["r301", 100], ["r301", 0], ["r302", 55], ["r303", 100], ["r304", 20],
  [memorialRoom, 100], [spamRoom, 70], ["r_tier_bare", 100], [null, 42],
];
const idBad = idCases.filter(([room, cl]) => {
  const bd = roomComfortBreakdown(room, cl);
  const expect = Math.min(100, Math.max(0, (bd.attrPart + bd.categoryPart + bd.tierPart) * bd.cleanMult));
  // roomId 為 null 是中性拆解(固定 cleanMult=1),不套整潔乘子
  const multOk = room === null ? bd.cleanMult === 1 : bd.cleanMult === cleanlinessMultiplier(cl);
  return Math.abs(bd.comfort - expect) > 1e-9 || !multOk;
});
check(`(屬性+齊全+品質)×整潔 = 舒適 在 ${idCases.length} 組組合都成立`, idBad.length === 0);

// --- 9. 決定性 + 零 RNG:算 tier 不可以動到亂數序列 ---
let rngCalls = 0;
Math.random = () => { rngCalls++; return seededRandom(); };
const detA = idCases.map(([room, cl]) => roomComfortBreakdown(room, cl).tierPart);
const detB = idCases.map(([room, cl]) => roomComfortBreakdown(room, cl).tierPart);
Math.random = seededRandom;
check(`舒適度拆解不呼叫 Math.random(實測 ${rngCalls} 次)`, rngCalls === 0);
check("同輸入重複呼叫得到完全相同的 tierPart(決定性)", detA.every((v, i) => v === detB[i]));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
