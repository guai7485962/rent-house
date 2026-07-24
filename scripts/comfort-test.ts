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
const { roomComfort, comfortBaselineDelta, cleanlinessBaseline, comfortHints, cleanlinessMultiplier } =
  await import("../src/sim/comfort");
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

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
