/**
 * 記憶生命週期(設計檢討 §2)驗證:
 * 衰減率分級 / 漂移乘 intensity / 每日衰減 / 歸零淡忘 + 日誌 / 持續狀態不衰減 / 舊存檔缺欄位相容
 */
import { state, debugStepHour } from "../src/store";
import { decayRate, decayMemories, memoryDrift } from "../src/sim/memoryEffects";
import type { Tenant, MemoryTag } from "../src/types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

const mkTag = (label: string, intensity?: number): MemoryTag => ({
  id: label,
  label,
  behaviorHint: "",
  acquiredAt: "",
  source: "ai_event",
  ...(intensity !== undefined ? { intensity } : {}),
});
const mkTenant = (tags: MemoryTag[]): Tenant =>
  ({ memoryTags: tags, stats: { mood: 50, stress: 50, wellbeing: 50, energy: 50, affinity: 50 } }) as unknown as Tenant;

// --- 1. 衰減率分級 ---
check("失戀 = 強情緒 0.09", decayRate("[失戀]") === 0.09);
check("養貓 = 持續狀態 0(不衰減)", decayRate("[偷養浪貓]") === 0);
check("同居 = 持續狀態 0", decayRate("[與小婕同居]") === 0);
check("一般記憶 = 0.05", decayRate("[被漲租惹惱]") === 0.05);

// --- 2. 漂移乘 intensity ---
const full = memoryDrift(mkTenant([mkTag("[失戀]", 1)]));
const half = memoryDrift(mkTenant([mkTag("[失戀]", 0.5)]));
check(`半強度漂移減半(${full.mood} → ${half.mood})`, Math.abs(half.mood! - full.mood! * 0.5) < 1e-9);

// --- 3. 舊存檔缺 intensity 欄位 → 視為 1 ---
const legacy = memoryDrift(mkTenant([mkTag("[失戀]")]));
check("缺 intensity 視為 1", legacy.mood === full.mood);

// --- 4. decayMemories:衰減、淡忘、持續狀態不動 ---
const t = mkTenant([mkTag("[失戀]"), mkTag("[偷養浪貓]"), mkTag("[被漲租惹惱]", 0.03)]);
const faded = decayMemories(t);
check("快歸零的記憶被淡忘", faded.includes("[被漲租惹惱]") && !t.memoryTags.some((m) => m.label === "[被漲租惹惱]"));
const heartbreak = t.memoryTags.find((m) => m.label === "[失戀]");
check(`失戀衰減一天(1 → ${heartbreak?.intensity})`, Math.abs((heartbreak?.intensity ?? 0) - 0.91) < 1e-9);
check("養貓不衰減(intensity 未設)", t.memoryTags.find((m) => m.label === "[偷養浪貓]")?.intensity === undefined);

// --- 5. 整合:跨日觸發衰減 + 淡忘日誌 ---
const lin = state.runtimes["tenant_lin_asmr"];
lin.tenant.stats.stress = 30;
lin.lastEventDay = 9999;
state.runtimes["tenant_chen_engineer"].lastEventDay = 9999;
lin.tenant.memoryTags.push(mkTag("[被漲租惹惱]", 0.04));
lin.tenant.stats.mood = 50; // 避免矛盾淡出搶先移除
for (let i = 0; i < 25; i++) debugStepHour(); // 跨一個午夜
check("跨日後快歸零記憶被淡忘", !lin.tenant.memoryTags.some((m) => m.label === "[被漲租惹惱]"));
check("🍂 淡忘日誌已寫入", lin.log.some((e) => e.text.includes("🍂") && e.text.includes("被漲租惹惱")));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
