/** 調租談判(設計檢討 7-1)驗證:降租必成 / 容忍內漲租勉強接受 / 漲太兇拒絕惹惱 / 冷卻 / 夾幅 / 非承租人擋下 */
import { state, previewRent, proposeRent } from "../src/store";

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

const chen = state.runtimes["tenant_chen_engineer"];
const id = chen.tenant.id;
const rent0 = chen.tenant.finance.monthlyRent;

// 讓數值可預期:滿意 70 / 好感 70 → 容忍度 (70*0.5+70*0.5-35)/200 = 0.175
chen.satisfaction = 70;
chen.tenant.stats.affinity = 70;

// --- 預覽 ---
check("降租提案 verdict = cut", previewRent(id, Math.round(rent0 * 0.9))?.verdict === "cut");
check("+5% 提案 verdict = safe", previewRent(id, Math.round(rent0 * 1.05))?.verdict === "safe");
check("+30% 提案 verdict = reject", previewRent(id, Math.round(rent0 * 1.3))?.verdict === "reject");
check("提案夾在 +30%(要求 2 倍被夾)", previewRent(id, rent0 * 2)!.next === Math.round(rent0 * 1.3));
check("不存在的租客 → null", previewRent("nobody", 10000) === null);

// --- 降租:必接受、好感上升 ---
const affBefore = chen.tenant.stats.affinity;
const r1 = proposeRent(id, Math.round(rent0 * 0.9));
check("降租被接受", r1.ok && r1.accepted);
check("月租確實下降", chen.tenant.finance.monthlyRent < rent0);
check("好感上升", chen.tenant.stats.affinity > affBefore);

// --- 冷卻:剛談完再談 → 擋下 ---
const r2 = proposeRent(id, Math.round(rent0 * 0.85));
check("冷卻中再談被擋下", !r2.ok);

// --- 容忍內漲租:勉強接受、好感下降 ---
chen.rentChangeDay = -99; // 重置冷卻
chen.satisfaction = 70;
chen.tenant.stats.affinity = 70;
const rentA = chen.tenant.finance.monthlyRent;
const r3 = proposeRent(id, Math.round(rentA * 1.05));
check("+5% 漲租被(勉強)接受", r3.ok && r3.accepted);
check("月租確實上調", chen.tenant.finance.monthlyRent > rentA);
check("好感下降", chen.tenant.stats.affinity < 70);

// --- 漲太兇:拒絕、房租不變、關係惡化、留記憶 ---
chen.rentChangeDay = -99;
chen.satisfaction = 70;
chen.tenant.stats.affinity = 70;
const rentB = chen.tenant.finance.monthlyRent;
const unhappyBefore = chen.unhappyHours;
const r4 = proposeRent(id, Math.round(rentB * 1.3));
check("+30% 被拒絕", r4.ok && !r4.accepted);
check("房租維持原價", chen.tenant.finance.monthlyRent === rentB);
check("好感明顯下降", chen.tenant.stats.affinity < 70);
check("不滿累積增加", chen.unhappyHours > unhappyBefore);
check("留下 [對漲租不滿] 記憶", chen.tenant.memoryTags.some((m) => m.label === "[對漲租不滿]"));

// --- 非承租人(同居者)不能談 ---
const linEntry = Object.entries(state.occupancy).find(([, tid]) => tid === "tenant_lin_asmr")!;
delete state.occupancy[linEntry[0]];
state.cohabits["tenant_lin_asmr"] = linEntry[0]; // 模擬林小婕同居中
check("同居者 previewRent → null", previewRent("tenant_lin_asmr", 8000) === null);
check("同居者 proposeRent → 擋下", !proposeRent("tenant_lin_asmr", 8000).ok);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
