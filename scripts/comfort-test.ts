/**
 * 房間舒適度系統(第一波)驗證:
 * - 舒適度算法:家具屬性 + 種類齊全度 × 整潔乘子,值域合理、佈置越齊全越高
 * - 整潔乘子:同房越髒 → 舒適度越低(單調)
 * - 接基準線:舒適乾淨房 vs 簡陋髒房 → homeostasis 心情基準有差(慢變)
 * - 整潔慢變:朝收納決定的自然水位回歸(收納家具墊高基準 = 減緩衰減)
 * - 房間細看提示:太髒/缺類別會給對應建議
 */
// 固定種子 PRNG(mulberry32)+ localStorage mock —— 必須在載入 store 之前
let seed = 20260723;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const store = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { state, debugStepHour } = await import("../src/store");
const {
  roomComfort, comfortBaselineDelta, cleanlinessBaseline, comfortHints, cleanlinessMultiplier,
  roomComfortBreakdown, COMFORT_LIMITS, COMFORT_BUCKET_LABELS,
} = await import("../src/sim/comfort");
const { addPlacement } = await import("../src/sim/placements");
const { baselines, cozyHomePass, resetCozyHomeCooldown } = await import("../src/sim/tick");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

// --- 1. 值域與空房 ---
const bareRoom = roomComfort("r_nonexistent", 100); // 無任何家具
check(`空房舒適度為 0(得 ${bareRoom.toFixed(1)})`, bareRoom === 0);

const c301 = roomComfort("r301", state.runtimes["tenant_chen_engineer"].cleanliness);
const c302 = roomComfort("r302", state.runtimes["tenant_lin_asmr"].cleanliness);
check(`種子房舒適度落在合理中段(301=${c301.toFixed(1)}, 302=${c302.toFixed(1)})`,
  c301 > 20 && c301 < 70 && c302 > 30 && c302 < 80);
check("整潔的 302 舒適度高於髒亂起手的 301", c302 > c301);

// --- 2. 種類齊全度:加不同類別家具 → 舒適度上升 ---
const r303base = roomComfort("r303", 100); // 只有一張單人床
addPlacement({ defId: "plant", room: "r303", c: 2, r: 17 } as any); // 裝飾類 + cozy/style
const r303plant = roomComfort("r303", 100);
check(`加裝飾家具提升舒適度(${r303base.toFixed(1)} → ${r303plant.toFixed(1)})`, r303plant > r303base);
addPlacement({ defId: "dresser", room: "r303", c: 3, r: 17 } as any); // 收納類
const r303storage = roomComfort("r303", 100);
check(`再加收納類別再提升舒適度(${r303plant.toFixed(1)} → ${r303storage.toFixed(1)})`, r303storage > r303plant);

// --- 3. 整潔乘子:同房越髒舒適度越低(單調) ---
const clean = roomComfort("r302", 100);
const mid = roomComfort("r302", 50);
const dirty = roomComfort("r302", 10);
check(`整潔越低舒適度越低(clean ${clean.toFixed(1)} > mid ${mid.toFixed(1)} > dirty ${dirty.toFixed(1)})`,
  clean > mid && mid > dirty);
check("整潔乘子有下限保護(不歸零)", cleanlinessMultiplier(0) === 0.5 && cleanlinessMultiplier(100) === 1);

// --- 4. comfortBaselineDelta 方向正確 ---
const hi = comfortBaselineDelta(80);
const lo = comfortBaselineDelta(20);
check("舒適房墊高心情/降壓/升健康基準", hi.mood > 0 && hi.stress < 0 && hi.wellbeing > 0);
check("簡陋房下修心情/加壓/降健康基準", lo.mood < 0 && lo.stress > 0 && lo.wellbeing < 0);
check("comfort=50 時基準不動", comfortBaselineDelta(50).mood === 0);

// --- 5. 接基準線:舒適乾淨房 vs 髒房 → homeostasis 心情基準有差 ---
const chen = state.runtimes["tenant_chen_engineer"];
chen.tenant.growthTags = [];
chen.cleanliness = 100;
const moodClean = baselines(chen).mood;
chen.cleanliness = 5;
const moodDirty = baselines(chen).mood;
check(`同房乾淨 vs 髒 → 心情基準有差(clean ${moodClean.toFixed(1)} > dirty ${moodDirty.toFixed(1)})`,
  moodClean > moodDirty);

// --- 6. 整潔慢變:朝自然水位回歸 + 收納墊高基準 ---
check(`收納家具墊高整潔基準(r302 有書架=${cleanlinessBaseline("r302")}, r304 無收納=${cleanlinessBaseline("r304")})`,
  cleanlinessBaseline("r302") > cleanlinessBaseline("r304") && cleanlinessBaseline("r304") === 50);

chen.lastEventDay = 9999; // 擋事件,免得 pendingEvent 卡住
chen.pendingEvent = null;
chen.cleanliness = 15; // 遠低於自然水位
for (let i = 0; i < 48; i++) debugStepHour();
check(`髒房隨時間慢慢回升(15 → ${chen.cleanliness.toFixed(1)})`, chen.cleanliness > 15 && chen.cleanliness < 55);
chen.cleanliness = 98; // 遠高於自然水位
for (let i = 0; i < 48; i++) debugStepHour();
check(`過度乾淨隨生活慢慢下滑(98 → ${chen.cleanliness.toFixed(1)})`, chen.cleanliness < 98);

// --- 7. 房間細看提示 ---
const dirtyHints = comfortHints("r301", 20);
check("太髒 → 提示打掃", dirtyHints.some((h) => h.includes("打掃")));
const r304Hints = comfortHints("r304", 100); // 只有床 → 缺很多類別
check("缺家具類別 → 給對應建議且至多 3 條", r304Hints.length > 0 && r304Hints.length <= 3);

// --- 8. 舒適乾淨房的正向慶祝(cozyHomePass,與 dirtyComplaintPass 對稱) ---
const cozyCount = (rt: any) => rt.log.filter((e: any) => e.text.startsWith("🏡")).length;
const lin = state.runtimes["tenant_lin_asmr"];
lin.pendingEvent = null;
lin.cleanliness = 95; // 乾淨 + 佈置齊全 → 舒適度過門檻
resetCozyHomeCooldown();
const linBefore = cozyCount(lin);
const linMoodBefore = lin.tenant.stats.mood;
cozyHomePass(500);
check("舒適又乾淨的房間會慶祝(🏡 正向日誌)", cozyCount(lin) === linBefore + 1);
check("慶祝給極小正向加成(心情微升)", lin.tenant.stats.mood >= linMoodBefore);

// 冷卻:3 遊戲日內同一天再呼叫不重複
cozyHomePass(500);
check("慶祝有日數冷卻(同段時間不重複)", cozyCount(lin) === linBefore + 1);

// 低舒適/髒房保持沉默(用陳家豪髒亂房:cleanliness 低 → 兩道門檻都不過)
const chen2 = state.runtimes["tenant_chen_engineer"];
chen2.pendingEvent = null;
chen2.cleanliness = 20;
resetCozyHomeCooldown();
const chenBefore = cozyCount(chen2);
cozyHomePass(600);
check("髒亂/低舒適房不會慶祝(保持沉默)", cozyCount(chen2) === chenBefore);

// --- 9. 掃地機器人:墊高整潔基準 → 整潔隨時間收斂到更高水位 ---
const baseNoVac = cleanlinessBaseline("r301"); // r301 無收納無機器人 → 50
addPlacement({ defId: "robot_vacuum", room: "r301", c: 3, r: 3 } as any);
const baseVac = cleanlinessBaseline("r301");
check(`掃地機器人墊高整潔基準(r301 ${baseNoVac} → ${baseVac})`, baseVac > baseNoVac);
check("整潔基準仍有上限保護(夾 ≤ 90)", cleanlinessBaseline("r301") <= 90);

const chen3 = state.runtimes["tenant_chen_engineer"];
chen3.pendingEvent = null;
chen3.lastEventDay = 99999; // 擋事件,免得 pendingEvent 卡住模擬
chen3.cleanliness = 40; // 從低於兩種基準的水位起步
for (let i = 0; i < 96; i++) debugStepHour();
// 無機器人時 r301 基準只有 50,加上日常活動把整潔往下拖,不可能爬過 50;
// 有機器人把基準墊到 75,整潔才收斂到明顯更高的水位並越過 50。
check(`有掃地機器人 → 整潔慢慢爬過舊基準(40 → ${chen3.cleanliness.toFixed(1)},> 50)`,
  chen3.cleanliness > 50 && chen3.cleanliness <= 90);

// --- 10. 拆解不變量:房間細看的「舒適度拆解」面板直接顯示這些數字,
//         公式若被改動而這裡沒同步,面板就會對玩家說謊 → 用斷言鎖住。 ---
check(`整潔乘子三檔固定(0→${cleanlinessMultiplier(0)}, 50→${cleanlinessMultiplier(50)}, 100→${cleanlinessMultiplier(100)})`,
  cleanlinessMultiplier(0) === 0.5 && cleanlinessMultiplier(50) === 0.75 && cleanlinessMultiplier(100) === 1);

check(`拆解上限常數與設計一致(屬性 ${COMFORT_LIMITS.attrMax} + 齊全 ${COMFORT_LIMITS.categoryMax} + 品質 ${COMFORT_LIMITS.tierMax} = 100)`,
  COMFORT_LIMITS.attrMax === 60 && COMFORT_LIMITS.categoryMax === 30 &&
  COMFORT_LIMITS.categoryPoints === 6 && COMFORT_LIMITS.tierMax === 10 &&
  COMFORT_LIMITS.categoryMax === COMFORT_BUCKET_LABELS.length * COMFORT_LIMITS.categoryPoints);

// 三個加項的總上限必須 ≤ 100 → roomComfortBreakdown 的 clamp 永遠不生效。
// 這是面板加法恆等的前提:一旦 clamp 真的夾到,玩家就會看到「小計 × 倍率 = 102」但總分 100。
check(`三個加項總上限剛好不破 100(${COMFORT_LIMITS.attrMax} + ${COMFORT_LIMITS.categoryMax} + ${COMFORT_LIMITS.tierMax})`,
  COMFORT_LIMITS.attrMax + COMFORT_LIMITS.categoryMax + COMFORT_LIMITS.tierMax <= 100);

check(`五大舒適類別固定五類(${COMFORT_BUCKET_LABELS.join("/")})`,
  COMFORT_BUCKET_LABELS.length === 5 &&
  ["睡眠", "娛樂", "收納", "裝飾", "生活"].every((l, i) => COMFORT_BUCKET_LABELS[i] === l));

// (attrPart + categoryPart + tierPart) × cleanMult 必須真的等於 comfort(面板的加減乘法就是這條)
const idCases: [string | null, number][] = [
  ["r301", 100], ["r301", 0], ["r302", 55], ["r303", 100], ["r304", 20], ["r_nonexistent", 100], [null, 42],
];
const idBad = idCases.filter(([room, cl]) => {
  const bd = roomComfortBreakdown(room, cl);
  const expect = Math.min(100, Math.max(0, (bd.attrPart + bd.categoryPart + bd.tierPart) * bd.cleanMult));
  return Math.abs(bd.comfort - expect) > 1e-9;
});
check(`(屬性+齊全+品質)×整潔 = 舒適 在 ${idCases.length} 組房間/整潔組合都成立`, idBad.length === 0);

const multBad = idCases.filter(([, cl]) => roomComfortBreakdown("r302", cl).cleanMult !== cleanlinessMultiplier(cl));
check("拆解的 cleanMult 就是 cleanlinessMultiplier(面板顯示的折數不會另有一套)", multBad.length === 0);

// 屬性部分:過飽和函式收斂,狂堆家具也不會超過上限
for (let i = 0; i < 24; i++) addPlacement({ defId: "canopy_bed", room: "r_attr_probe", c: i, r: 1 } as any);
const probe = roomComfortBreakdown("r_attr_probe", 100);
check(`屬性部分過飽和收斂不破上限(狂堆 24 件 → ${probe.attrPart.toFixed(1)} < ${COMFORT_LIMITS.attrMax})`,
  probe.attrPart > 40 && probe.attrPart < COMFORT_LIMITS.attrMax);

// 齊全度:真實房間一定是「每類點數」的整數倍且不超上限(null 是中性值,不算房間)
const catBad = idCases.filter(([room, cl]) => {
  if (room === null) return false;
  const bd = roomComfortBreakdown(room, cl);
  return bd.categoryPart % COMFORT_LIMITS.categoryPoints !== 0 ||
    bd.categoryPart < 0 || bd.categoryPart > COMFORT_LIMITS.categoryMax ||
    // 缺的類別數 + 有的類別數 = 五類;齊全度必須對得上「有幾類」
    bd.categoryPart !== (COMFORT_BUCKET_LABELS.length - bd.missing.length) * COMFORT_LIMITS.categoryPoints;
});
check("齊全度 =(五類 − 缺的類數)× 每類點數,落在 0~上限", catBad.length === 0);

// missing:空房 = 缺全部五類(順序同 COMFORT_BUCKET_LABELS);且永遠是這五個 label 的子集
const bareBd = roomComfortBreakdown("r_nonexistent", 100);
check(`空房缺全部五類且順序一致(${bareBd.missing.join("/")})`,
  bareBd.missing.length === 5 && bareBd.missing.every((l, i) => l === COMFORT_BUCKET_LABELS[i]) &&
  bareBd.categoryPart === 0 && bareBd.attrPart === 0 && bareBd.tierPart === 0);
check("missing 內容永遠是五大類 label 的子集(面板不會拿到未知類別)",
  idCases.every(([room, cl]) => roomComfortBreakdown(room, cl).missing.every((l) => COMFORT_BUCKET_LABELS.includes(l))));

// 滿配房:r303 已有 床(睡眠)/盆栽(裝飾)/斗櫃(收納),補上娛樂與生活 → 五類全齊
addPlacement({ defId: "tv_console", room: "r303", c: 5, r: 17 } as any); // av → 娛樂
addPlacement({ defId: "beanbag", room: "r303", c: 6, r: 17 } as any); // seating → 生活
const fullBd = roomComfortBreakdown("r303", 100);
check(`五類全齊的房間 missing 為空、齊全度滿分(${fullBd.categoryPart}/${COMFORT_LIMITS.categoryMax})`,
  fullBd.missing.length === 0 && fullBd.categoryPart === COMFORT_LIMITS.categoryMax);
check(`三部分合計不超上限、整潔滿分時舒適 ≤ 100(實得 ${fullBd.comfort.toFixed(1)})`,
  fullBd.attrPart + fullBd.categoryPart + fullBd.tierPart <=
    COMFORT_LIMITS.attrMax + COMFORT_LIMITS.categoryMax + COMFORT_LIMITS.tierMax &&
  fullBd.comfort <= 100);

// roomId 為 null(無房租客)→ 中性拆解,面板不會出現負數或 NaN
const neutral = roomComfortBreakdown(null, 0);
check(`無房間時給中性拆解(comfort ${neutral.comfort}、倍率 ${neutral.cleanMult}、無缺類)`,
  neutral.comfort === 50 && neutral.cleanMult === 1 && neutral.missing.length === 0 &&
  neutral.tierPart === 0 && neutral.attrPart + neutral.categoryPart + neutral.tierPart === 50);

// --- 11. 家具品質層級(tier)是舒適度的第三個加項(細節見 furniture-tier-test.ts) ---
// 這裡只釘「有進入總分」與「沒破壞既有語意」,避免 comfort 的三個加項哪天被抽掉一個。
const tierProbe = "r_tier_in_comfort";
addPlacement({ defId: "single_bed", room: tierProbe, c: 1, r: 1 } as any); // budget、零屬性
const tierBefore = roomComfortBreakdown(tierProbe, 100);
addPlacement({ defId: "canopy_bed", room: tierProbe, c: 3, r: 1 } as any); // premium
const tierAfter = roomComfortBreakdown(tierProbe, 100);
check(`品質層級進入總分(tierPart ${tierBefore.tierPart} → ${tierAfter.tierPart},舒適 ${tierBefore.comfort.toFixed(1)} → ${tierAfter.comfort.toFixed(1)})`,
  tierAfter.tierPart > tierBefore.tierPart && tierAfter.comfort > tierBefore.comfort);

// 品質是「加項」不是「乘子」:同房不同整潔度,tierPart 完全不受整潔影響
check(`品質部分不隨整潔改變(clean100 ${roomComfortBreakdown(tierProbe, 100).tierPart} = clean10 ${roomComfortBreakdown(tierProbe, 10).tierPart})`,
  roomComfortBreakdown(tierProbe, 100).tierPart === roomComfortBreakdown(tierProbe, 10).tierPart);

// 既有語意不變:空房仍為 0(tier 加分是「逐件」的,沒家具就沒得加)
check(`空房仍為 0、tierPart 也是 0(tier 不會憑空給底分)`,
  roomComfort("r_nonexistent_2", 100) === 0 && roomComfortBreakdown("r_nonexistent_2", 100).tierPart === 0);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
