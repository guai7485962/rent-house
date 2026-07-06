import { state, fastForward, decide } from "../src/store";

const R = (n: number) => Math.round(n);

// 1. 跑 3 天,看滿意度演變
fastForward(72);
console.log("=== 3 天後滿意度 ===");
for (const rt of Object.values(state.runtimes))
  console.log(`  ${rt.tenant.name}: 滿意 ${R(rt.satisfaction)} / 壓力 ${rt.tenant.stats.stress} / 好感 ${rt.tenant.stats.affinity} / 不滿時數 ${rt.unhappyHours}`);

// 2. 強制低滿意 → 應觸發事件
const chen = state.runtimes["tenant_chen_engineer"];
chen.satisfaction = 10;
chen.lastEventDay = -999;
chen.pendingEvent = null;
fastForward(1);
console.log(`\n=== 事件觸發 ===`);
console.log(`  低滿意後陳家豪事件:${chen.pendingEvent?.title ?? "無"}`);
if (chen.pendingEvent) {
  const money0 = state.money;
  const aff0 = chen.tenant.stats.affinity;
  const c = chen.pendingEvent.choices[0];
  decide("tenant_chen_engineer", c.id, c.label);
  console.log(`  選「${c.label}」→ 事件清空:${chen.pendingEvent === null} / 好感 ${aff0}→${chen.tenant.stats.affinity} / 錢 ${money0}→${state.money}`);
}

// 3. 強制退租(壓住事件冷卻,讓不滿累積直接退租)
const lin = state.runtimes["tenant_lin_asmr"];
lin.satisfaction = 4;
lin.unhappyHours = 100;
lin.lastEventDay = 999999; // 冷卻中,不觸發事件
lin.pendingEvent = null;
const before = Object.keys(state.runtimes).length;
fastForward(1);
console.log(`\n=== 退租 ===`);
console.log(`  租客數 ${before}→${Object.keys(state.runtimes).length}`);
console.log(`  302 佔用:${state.occupancy["r302"] ?? "空(已退租)"}`);
console.log(`  系統通知:${state.notice || "(無)"}`);
