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
 *
 * 第二階段(睡眠效率)追加(§10):
 * - `sleepMultiplier(budget)` **嚴格等於 1.0**——種子局四間房全是平價床,
 *   `9 * 1.0 === 9` 位元級成立才有 balance 快照零漂移
 * - 只有 energy/stress 吃乘數,mood/wellbeing 明確不吃
 * - **範圍紀律**:非睡眠狀態帶了家具也不能有任何數值差(擋第三階段的順手擴充)
 * - 不變條件:`INITIAL_PLACEMENTS` 裡所有床皆為 budget(有人換種子床就主動報警)
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
const { addPlacement, furnitureAt, removePlacementAt } = await import("../src/sim/placements");
const { getDef, CATALOG } = await import("../src/furniture/catalog");
const { TIER_POINTS, TIER_INFO, DEFAULT_TIER, tierOf, tierPoints, tierChipText, SLEEP_MULT, SLEEP_MULT_RANGE, sleepMultiplier } =
  await import("../src/furniture/tier");
const { generateHourly } = await import("../src/sim/generate");
const { INITIAL_PLACEMENTS } = await import("../src/floor/map");

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

// 商店把紀念物下架(price <= 0 不上架)後,**只擋購買入口、不能誤傷畢業生回饋**:
// 畢業流程仍會 addPlacement 紀念物,它仍要照常拿到 standard 的 +0.5。
const placedMemorialRoom = "r_tier_memorial_placed";
for (const id of MEMORIALS) addPlacement({ defId: id, room: placedMemorialRoom, c: MEMORIALS.indexOf(id), r: 1, memorial: true } as any);
const placedMemorial = roomComfortBreakdown(placedMemorialRoom, 100);
check(
  `紀念物仍可被擺放且照常計入 tierPart(5 件 × ${TIER_POINTS.standard} = ${placedMemorial.tierPart})`,
  placedMemorial.tierPart === MEMORIALS.length * TIER_POINTS.standard,
);
check(
  "下架不影響 tier 語意:紀念物的 tierOf 仍是 standard、tierPoints 仍 > 0",
  MEMORIALS.every((id) => tierOf(getDef(id)) === "standard" && tierPoints(getDef(id)) > 0),
);
check(
  `擺放的紀念物確實墊高該房舒適度(${placedMemorial.comfort.toFixed(2)} > 0,畢業生回饋沒被誤傷)`,
  placedMemorial.comfort > 0,
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

// --- 5b. 滿配房間:三個加項合計不破 100 → clamp 永遠不生效、面板加法恆等 ---
// 這是加了第三個加項之後最容易踩到的坑:上限若是 60+30+12=102,滿配房會出現
// 「小計 × 倍率 = 102」但總分顯示 100,四列加起來對不上(comfort.ts:45-48 明訂面板要對得起來)。
const maxRoom = "r_tier_maxed";
// 五大類全齊 + 狂堆高屬性 premium(帷幔床 cozy9/style7)把 attrPart 推到逼近 60、tierPart 撞上限
for (const defId of ["tv_console", "bookshelf", "plant", "loveseat"]) {
  addPlacement({ defId, room: maxRoom, c: 0, r: 1 } as any);
}
for (let i = 0; i < 200; i++) addPlacement({ defId: "canopy_bed", room: maxRoom, c: i, r: 2 } as any);
const maxed = roomComfortBreakdown(maxRoom, 100); // 整潔滿分 → cleanMult = 1(最嚴苛的情況)
const maxedSum = maxed.attrPart + maxed.categoryPart + maxed.tierPart;
check(
  `滿配房五類全齊、attrPart 逼近上限、tierPart 撞頂(attr ${maxed.attrPart.toFixed(2)} + cat ${maxed.categoryPart} + tier ${maxed.tierPart} = ${maxedSum.toFixed(2)})`,
  maxed.missing.length === 0 &&
    maxed.attrPart > COMFORT_LIMITS.attrMax - 1 &&
    maxed.categoryPart === COMFORT_LIMITS.categoryMax &&
    maxed.tierPart === COMFORT_LIMITS.tierMax,
);
check(
  `滿配房整潔 100 時三個加項合計仍不超過 100(${maxedSum.toFixed(4)} ≤ 100)`,
  maxedSum <= 100,
);
check(
  `滿配房的 clamp 不生效 → comfort 就是三項相加(${maxed.comfort.toFixed(4)} === ${maxedSum.toFixed(4)},面板加法恆等)`,
  Math.abs(maxed.comfort - maxedSum) < 1e-9 && maxed.comfort < 100,
);
// 刻意是 === 而不是 ≤:comfort.ts:52-56 明訂三個加項的總上限**剛好** = 100。
// 寫成 ≤ 的話,把 TIER_MAX 從 10 改成 5 也不會紅,但「滿配房拿得到 100」這個前提就悄悄破了。
check(
  `上限常數三項合計剛好等於 100(${COMFORT_LIMITS.attrMax} + ${COMFORT_LIMITS.categoryMax} + ${COMFORT_LIMITS.tierMax} === 100)`,
  COMFORT_LIMITS.attrMax + COMFORT_LIMITS.categoryMax + COMFORT_LIMITS.tierMax === 100,
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

// --- 10. 睡眠效率(tier 第二階段):床的品質放大恢復效率 ---
type VState = Parameters<typeof generateHourly>[0]["state"];
/** 走一次真正的 generateHourly(與 tick.ts 呼叫的是同一支函式),取這一小時的數值效果 */
function deltasOf(st: VState, furnitureDefId?: string) {
  return generateHourly({
    tenantId: "t_probe",
    tenantName: "探針",
    hour: 3,
    timeLabel: "03:00",
    state: st,
    isDeviation: false,
    recentSummary: "",
    furnitureDefId,
  }).statDeltas;
}

// 10-1. budget 必須是**嚴格等於** 1.0(不是 ≈):零漂移的位元級保證
check(
  `budget 床的睡眠乘數嚴格等於 1.0(實測 ${sleepMultiplier({ tier: "budget" })},9 × 它 = ${9 * sleepMultiplier({ tier: "budget" })})`,
  sleepMultiplier({ tier: "budget" }) === 1.0 && 9 * sleepMultiplier({ tier: "budget" }) === 9,
);
check(
  `睡眠乘數三階嚴格遞增(${SLEEP_MULT.budget} < ${SLEEP_MULT.standard} < ${SLEEP_MULT.premium})`,
  SLEEP_MULT.budget < SLEEP_MULT.standard && SLEEP_MULT.standard < SLEEP_MULT.premium,
);
check(
  `三階乘數都夾在合理值域內(${SLEEP_MULT_RANGE.min}~${SLEEP_MULT_RANGE.max},夾值不會偷偷改動現行係數)`,
  (["budget", "standard", "premium"] as const).every(
    (t) => sleepMultiplier({ tier: t }) === SLEEP_MULT[t] &&
      SLEEP_MULT[t] >= SLEEP_MULT_RANGE.min && SLEEP_MULT[t] <= SLEEP_MULT_RANGE.max,
  ),
);
check(
  `premium 的躍升大於 standard(形狀對齊 TIER_POINTS 的 0/0.5/1.5)`,
  SLEEP_MULT.premium - SLEEP_MULT.standard > SLEEP_MULT.standard - SLEEP_MULT.budget,
);

// 10-2. 未標 tier / 查無此 id → 複用 tierOf() 的 standard,不拋例外、不另開一套 fallback
let unknownOk = true;
try {
  unknownOk =
    sleepMultiplier(getDef("不存在的id")) === SLEEP_MULT.standard &&
    sleepMultiplier(getDef("memorial_poster")) === SLEEP_MULT[DEFAULT_TIER];
} catch {
  unknownOk = false;
}
check(
  `未知 defId / 未標 tier 的家具走 tierOf() 的 standard 且不拋例外(→ ×${sleepMultiplier(getDef("不存在的id"))})`,
  unknownOk,
);
check(
  "帶了查無此 id 的家具仍能算出這一小時的效果(UNKNOWN_DEF 不會炸掉睡眠)",
  Number.isFinite(deltasOf("sleeping_on_bed", "不存在的id").energy),
);
check(
  "完全不帶家具時退回 ×1.0(防禦性 fallback:效果與 budget 床完全相同)",
  JSON.stringify(deltasOf("sleeping_on_bed")) === JSON.stringify(deltasOf("sleeping_on_bed", "single_bed")),
);

// 10-3. 只乘 energy 與 stress:mood/wellbeing 明確不吃乘數
const sleepBudget = deltasOf("sleeping_on_bed", "single_bed");
const sleepStandard = deltasOf("sleeping_on_bed", "double_bed");
const sleepPremium = deltasOf("sleeping_on_bed", "canopy_bed");
check(
  `energy 恢復三階嚴格遞增(${sleepBudget.energy} < ${sleepStandard.energy} < ${sleepPremium.energy})`,
  sleepBudget.energy! < sleepStandard.energy! && sleepStandard.energy! < sleepPremium.energy!,
);
check(
  `stress 消除三階嚴格加強(${sleepBudget.stress} > ${sleepStandard.stress} > ${sleepPremium.stress},負值越大越紓壓)`,
  sleepBudget.stress! > sleepStandard.stress! && sleepStandard.stress! > sleepPremium.stress!,
);
check(
  `mood 三階完全相同(${sleepBudget.mood} / ${sleepStandard.mood} / ${sleepPremium.mood}——+2 已頻繁頂到 100 上限,乘了是浪費)`,
  sleepBudget.mood === sleepStandard.mood && sleepStandard.mood === sleepPremium.mood,
);
check(
  `wellbeing 三階完全相同(${sleepBudget.wellbeing} / ${sleepPremium.wellbeing}——單日 ±2 太小,乘了看不出來)`,
  sleepBudget.wellbeing === sleepStandard.wellbeing && sleepStandard.wellbeing === sleepPremium.wellbeing,
);
check(
  `乘法是唯一形式:premium = budget × ${SLEEP_MULT.premium}(沒有先四捨五入、沒有先加 bonus)`,
  Math.abs(sleepPremium.energy! - sleepBudget.energy! * SLEEP_MULT.premium) < 1e-12 &&
    Math.abs(sleepPremium.stress! - sleepBudget.stress! * SLEEP_MULT.premium) < 1e-12,
);

// 10-4. 🔴 範圍紀律:第二階段**只做睡眠**。種子局的沙發/電視/浴缸/書桌全踩 premium 家具,
// 一旦有人把乘數接到這些活動上,balance 快照會整片漂移 → 這裡先擋下來。
const NON_SLEEP: [VState, string][] = [
  ["reading", "shared_sofa"], ["watching_tv", "lounge_tv"], ["taking_bath", "bathtub"],
  ["working_at_desk", "gaming_desk"], ["streaming", "mic_desk"], ["playing_with_cat", "shared_sofa"],
  ["gaming", "gaming_desk"], ["eating_at_table", "dining_table"], ["idle", "canopy_bed"],
];
const leaked = NON_SLEEP.filter(
  ([st, defId]) => JSON.stringify(deltasOf(st, defId)) !== JSON.stringify(deltasOf(st)),
);
check(
  `非睡眠活動一律不吃家具乘數(${NON_SLEEP.length} 組全部零差異,含 premium 的沙發/電視/浴缸/書桌)`,
  leaked.length === 0,
);

// 10-5. 🔴 不變條件:種子局的床全是 budget ⇒ ×1.0 ⇒ balance 快照零漂移。
// 未來有人把種子床換成 double_bed/canopy_bed,這條會**主動報警**提醒重建快照。
const seedBeds = INITIAL_PLACEMENTS.filter((p) => {
  const sp = getDef(p.defId).sprite;
  return "kind" in sp && sp.kind === "bed";
});
check(
  `種子局的床全是 budget(${seedBeds.length} 張:${[...new Set(seedBeds.map((p) => p.defId))].join("/")})⇒ 睡眠乘數恆為 ×1.0、快照零漂移`,
  seedBeds.length > 0 && seedBeds.every((p) => tierOf(getDef(p.defId)) === "budget") &&
    seedBeds.every((p) => sleepMultiplier(getDef(p.defId)) === 1.0),
);

// 10-6. 文案與係數同步(比照 tierChipText:改了係數不能忘了改商店文案)
const BED_HINTS: [string, keyof typeof SLEEP_MULT][] = [
  ["folding_bed", "budget"], ["single_bed", "budget"], ["double_bed", "standard"], ["canopy_bed", "premium"],
];
check(
  `四張床的 effectHint 都寫出實際乘數(${BED_HINTS.map(([id]) => getDef(id).effectHint).join(" / ")})`,
  BED_HINTS.every(([id, tier]) =>
    getDef(id).tier === tier && (getDef(id).effectHint ?? "").includes(`×${SLEEP_MULT[tier].toFixed(2)}`),
  ),
);

// 10-7. 端到端:同房間換床 → 同一初始 energy 跑 N 小時睡眠,好床嚴格較高
/** 用真正的 generateHourly 逐小時累積(energy 是資源、夾在 0~100,與 applyStat 同語意) */
function sleepRun(defId: string, hours: number, from: number) {
  let energy = from;
  let stress = 60;
  for (let h = 0; h < hours; h++) {
    const d = deltasOf("sleeping_on_bed", defId);
    energy = Math.min(100, Math.max(0, energy + (d.energy ?? 0)));
    stress = Math.min(100, Math.max(0, stress + (d.stress ?? 0)));
  }
  return { energy, stress };
}
// 座標刻意遠離種子樓層與上面的探針房,避免與既有 placement 的佔位範圍相撞
const swapRoom = "r_sleep_swap";
const SC = 900, SR = 900;
addPlacement({ defId: "single_bed", room: swapRoom, c: SC, r: SR } as any);
const beforeSwap = furnitureAt(SC, SR);
const runBudget = sleepRun(beforeSwap!.defId, 5, 20);
removePlacementAt(SC, SR);
addPlacement({ defId: "canopy_bed", room: swapRoom, c: SC, r: SR } as any);
const afterSwap = furnitureAt(SC, SR);
const runPremium = sleepRun(afterSwap!.defId, 5, 20);
check(
  `前提:同一格的床真的換掉了(${beforeSwap?.defId} → ${afterSwap?.defId})`,
  beforeSwap?.defId === "single_bed" && afterSwap?.defId === "canopy_bed",
);
check(
  `同房換成 premium 床:5 小時睡眠後 energy 嚴格較高(${runBudget.energy} < ${runPremium.energy.toFixed(2)})`,
  runPremium.energy > runBudget.energy,
);
check(
  `同房換成 premium 床:5 小時睡眠後 stress 嚴格較低(${runBudget.stress} > ${runPremium.stress.toFixed(2)})`,
  runPremium.stress < runBudget.stress,
);

// 10-8. 零 RNG:查 placement 的 tier 是純查表,不得動到亂數序列(否則整個模擬序列位移)
let sleepRngCalls = 0;
Math.random = () => { sleepRngCalls++; return seededRandom(); };
const mulA = ["single_bed", "double_bed", "canopy_bed", "不存在的id", "memorial_poster"].map((id) => sleepMultiplier(getDef(id)));
const mulB = ["single_bed", "double_bed", "canopy_bed", "不存在的id", "memorial_poster"].map((id) => sleepMultiplier(getDef(id)));
Math.random = seededRandom;
check(`算睡眠乘數不呼叫 Math.random(實測 ${sleepRngCalls} 次)`, sleepRngCalls === 0);
check("同輸入重複呼叫得到完全相同的乘數(決定性)", mulA.every((v, i) => v === mulB[i]));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
