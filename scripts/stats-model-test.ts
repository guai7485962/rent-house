/**
 * 數值模型重整(設計檢討 §4)驗證:
 * - homeostasis 抗飽和:mood/stress 不再黏死 100/0
 * - wellbeing 後果:長期高壓蛀健康、過低觸發生病事件、事件抉擇可治療
 * - energy 為資源:整體保持在 0~100 且會變動
 */
import { state, debugStepHour, decide } from "../src/store";

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
const lin = state.runtimes["tenant_lin_asmr"];

// --- 1. 抗飽和:黏在 100/0 會被基準拉回 ---
lin.tenant.memoryTags = [];
lin.lastEventDay = 9999; // 擋掉事件,免得 pendingEvent 暫停模擬
chen.lastEventDay = 9999;
chen.tenant.memoryTags = [];
chen.tenant.stats.stress = 40; // 先解除開場的爆壓狀態
lin.tenant.stats.mood = 100;
lin.tenant.stats.stress = 0;
let moodMin = 100;
let stressMax = 0;
for (let i = 0; i < 24; i++) {
  debugStepHour();
  moodMin = Math.min(moodMin, lin.tenant.stats.mood);
  stressMax = Math.max(stressMax, lin.tenant.stats.stress);
}
check(`mood 從 100 被拉回(24h 最低 ${moodMin.toFixed(1)} < 97)`, moodMin < 97);
check(`stress 從 0 升回(24h 最高 ${stressMax.toFixed(1)} > 3)`, stressMax > 3);
check("mood 仍在 0~100", lin.tenant.stats.mood >= 0 && lin.tenant.stats.mood <= 100);

// --- 2. 高壓蛀健康(crying 迴圈維持高壓 → wellbeing 每小時流失) ---
chen.tenant.stats.stress = 96;
chen.tenant.stats.wellbeing = 60;
const wb0 = chen.tenant.stats.wellbeing;
for (let i = 0; i < 12; i++) debugStepHour();
check(`長期高壓後健康下降(${wb0} → ${chen.tenant.stats.wellbeing.toFixed(1)})`, chen.tenant.stats.wellbeing < wb0 - 2);

// --- 3. wellbeing 過低 → 生病事件 ---
chen.pendingEvent = null;
chen.lastEventDay = -99;
chen.tenant.stats.stress = 40;
chen.tenant.stats.wellbeing = 15;
debugStepHour();
check("低健康觸發生病事件", chen.pendingEvent?.id === "sick");

// --- 4. 生病抉擇:看醫生 → 花錢 + 健康回升 ---
if (chen.pendingEvent?.id === "sick") {
  const w0 = chen.tenant.stats.wellbeing;
  const m0 = state.money;
  decide(chen.tenant.id, "doctor", "帶他去看醫生");
  check("看醫生後健康大幅回升(+25)", chen.tenant.stats.wellbeing >= w0 + 20);
  check("看醫生花了 $800", state.money === m0 - 800);
} else {
  check("(生病事件未觸發,略過抉擇測試)", false);
}

// --- 5. energy 為資源:跑 24h 全程夾在 0~100 且有變動 ---
const eSeen = new Set<number>();
for (let i = 0; i < 24; i++) {
  debugStepHour();
  const e = lin.tenant.stats.energy;
  if (e < 0 || e > 100) check("energy 超出 0~100!", false);
  eSeen.add(Math.round(e));
}
check(`energy 24h 內有變動(${eSeen.size} 種取值)`, eSeen.size > 1);

// --- 6. 滿意度納入 wellbeing/energy:健康精力極低 → 滿意度目標明顯變低 ---
lin.tenant.stats.wellbeing = 5;
lin.tenant.stats.energy = 5;
const sat0 = lin.satisfaction;
for (let i = 0; i < 8; i++) debugStepHour();
check(`健康/精力崩掉拖低滿意度(${sat0.toFixed(0)} → ${lin.satisfaction.toFixed(0)})`, lin.satisfaction < sat0);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
