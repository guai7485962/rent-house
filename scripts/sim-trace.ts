/**
 * 無頭模擬追蹤器(self-check harness)
 *
 * 跑真正的遊戲邏輯:store 每小時 tick + 真的 agent 尋路走位,
 * 把「誰、在做什麼、從哪走到哪、走幾步、有沒有抵達」印成文字軌跡,
 * 並做健全性檢查(有無卡住 / 走不到目標)。改完程式跑這支就能自我驗證。
 *
 * 用法: npx tsx scripts/sim-trace.ts [遊戲小時數,預設 24]
 */
import { state, debugInit, debugStepHour, debugClock, unreadCount } from "../src/store";
import { createAgents, tickAgents } from "../src/floor/agents";

const HOURS = Number(process.argv[2] ?? 24);
const DT = 0.1;
const MAX_TICKS = 600; // 單一小時內最多模擬多少 tick(避免卡死)

debugInit();
const agents = createAgents();
const byTenant = new Map(agents.map((a) => [a.tenantId, a]));

interface Issue {
  when: string;
  tenant: string;
  msg: string;
}
const issues: Issue[] = [];
let totalMoves = 0;

console.log(`=== 模擬 ${HOURS} 遊戲小時 ===`);

for (let h = 0; h < HOURS; h++) {
  // 記錄推進前的位置
  const before = new Map(agents.map((a) => [a.tenantId, { c: a.c, r: a.r }]));

  debugStepHour(); // 新的一小時 → 更新每人目標

  // 模擬 agent 走位直到全部靜止(或觸頂)
  let ticks = 0;
  tickAgents(agents, DT); // 先觸發重新尋路
  while (agents.some((a) => !a.hidden && a.moving) && ticks < MAX_TICKS) {
    tickAgents(agents, DT);
    ticks++;
  }

  console.log(`\n[${debugClock()}]  (該小時模擬 ${ticks} tick)`);
  for (const rt of Object.values(state.runtimes)) {
    const a = byTenant.get(rt.tenant.id)!;
    const st = rt.tenant.visualState;
    const last = rt.log[rt.log.length - 1];
    const dev = last?.importance === "major" ? "  ★偏離作息" : "";

    if (a.hidden) {
      console.log(`  ${rt.tenant.name}  ${st}  外出/隱藏${dev}`);
      continue;
    }
    const from = before.get(rt.tenant.id)!;
    const target = rt.targetTile!;
    const moved = from.c !== a.c || from.r !== a.r;
    const arrived = a.c === target.c && a.r === target.r;
    const route = moved ? `(${from.c},${from.r})→(${a.c},${a.r})` : `原地(${a.c},${a.r})`;
    const mark = arrived ? "✓抵達" : "✗未達";
    if (moved) totalMoves++;
    console.log(`  ${rt.tenant.name}  ${st.padEnd(16)} ${route}  目標(${target.c},${target.r}) ${mark}${dev}`);

    if (!arrived) {
      issues.push({ when: debugClock(), tenant: rt.tenant.name, msg: `未走到目標(卡在 ${a.c},${a.r})` });
    }
    if (ticks >= MAX_TICKS) {
      issues.push({ when: debugClock(), tenant: rt.tenant.name, msg: `模擬觸頂,可能有人卡住` });
    }
  }
}

// --- 健全性報告 ---
console.log(`\n=== 檢查結果 ===`);
console.log(`總移動次數:${totalMoves}`);
for (const rt of Object.values(state.runtimes)) {
  console.log(`  ${rt.tenant.name}:未讀 ${unreadCount(rt.tenant.id)} / log ${rt.log.length} 筆`);
}
if (issues.length === 0) {
  console.log("✅ 無異常:每個非外出時段的租客都走到了目標家具。");
} else {
  console.log(`⚠ 發現 ${issues.length} 筆異常:`);
  for (const i of issues.slice(0, 20)) console.log(`  [${i.when}] ${i.tenant}:${i.msg}`);
}
