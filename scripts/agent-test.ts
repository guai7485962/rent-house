import { createAgents, tickAgents } from "../src/floor/agents";

const agents = createAgents();
let walked = 0;
let used = 0;
// 模擬 40 秒(dt=0.05 → 800 tick)
for (let i = 0; i < 800; i++) {
  tickAgents(agents, 0.05);
  for (const a of agents) {
    if (a.state === "walking") walked++;
    if (a.state === "using") used++;
  }
}
console.log("模擬 40 秒後:");
for (const a of agents) {
  console.log(`  ${a.tenantId}: 目前格(${a.c},${a.r}) 狀態=${a.state} 動作=${a.action ?? "—"}`);
}
console.log(`walking tick=${walked}, using tick=${used}(有在走動與停留即正常)`);
