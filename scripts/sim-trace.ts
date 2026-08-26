/**
 * 無頭模擬追蹤器(self-check harness)
 *
 * 跑真正的遊戲邏輯:store 每小時 tick + 真的 agent 尋路走位,
 * 把「誰、在做什麼、從哪走到哪、走幾步、有沒有抵達」印成文字軌跡,
 * 並做健全性檢查(有無卡住 / 走不到目標)。改完程式跑這支就能自我驗證。
 *
 * 用法: npx tsx scripts/sim-trace.ts [遊戲小時數,預設 24]
 */
// 固定 RNG：這支是 CI 健全性檢查，不該因隨機偏離作息／互動而偶發假紅燈。
let seed = 20260716;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state, debugInit, debugStepHour, debugClock, unreadCount } = await import("../src/store");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { sessionFor } = await import("../src/floor/pairSession");

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
    // 互動 session(§10-6)會覆寫走位:人在互動錨點上 = 正常(在跟人互動,不是卡住)
    const ses = sessionFor(rt.tenant.id, state.gameMs);
    const atSession = !!ses && a.c === ses.tile.c && a.r === ses.tile.r;
    const activity = rt.activityPose ? rt.activityTile : null;
    const atActivity = !!activity && a.c === activity.c && a.r === activity.r;
    const arrived = (a.c === target.c && a.r === target.r) || atSession || atActivity;
    const route = moved ? `(${from.c},${from.r})→(${a.c},${a.r})` : `原地(${a.c},${a.r})`;
    const mark = atSession ? "✓互動中" : atActivity ? `✓${rt.activityPose === "lie" ? "躺在家具" : "坐在家具"}` : arrived ? "✓抵達" : "✗未達";
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

// ---------------------------------------------------------------------------
// 🔴 咖啡廳顧客走位(2026-08-26 補上)
//
// 這一段以前**完全不存在**:本檔只 import 租客層的 `createAgents/tickAgents`,
// `floor/guestAgents.ts` 一行都沒跑到 —— 顧客互相卡死(gridlock)因此活到玩家回報。
// 現在整批進場的情境(觸發門檻以上)跟租客走位共用同一份 issues 與「無異常」判定。
// ---------------------------------------------------------------------------
const { placeCafeStarterSet, cafeSeatSpots, cafeQueueTiles } = await import("../src/sim/placements");
const { runCafeCrowd, describeCafeCrowd, CAFE_CROWD_CASES } = await import("./cafe-crowd-sim");
const { currentBlocked } = await import("../src/floor/pathfind");

placeCafeStarterSet(); // 開張贈品 = 預設店面;既有存檔的擺法另由第 1~3 層兜底
console.log(`\n=== 咖啡廳顧客走位(整批進場)===`);
for (const scenario of CAFE_CROWD_CASES) {
  const result = runCafeCrowd(scenario);
  console.log(`  ${describeCafeCrowd(result)}`);
  for (const agent of result.stuck) {
    issues.push({
      when: "咖啡廳", tenant: agent.guest.name,
      msg: `顧客未走到目標(${result.label},卡在 ${agent.c},${agent.r} phase=${agent.phase})`,
    });
  }
}

// 席位幾何:死巷席位與「人龍壓在座位出入口上」是互卡的兩個結構性加重因子。
const walkableAt = (c: number, r: number) => currentBlocked()[r]?.[c] === false;
const queueKeys = new Set(cafeQueueTiles(14).map((tile) => `${tile.c},${tile.r}`));
for (const spot of cafeSeatSpots()) {
  const neighbours = [[0, 1], [0, -1], [1, 0], [-1, 0]]
    .filter(([dc, dr]) => walkableAt(spot.stand.c + dc, spot.stand.r + dr)).length;
  if (neighbours < 2) {
    issues.push({ when: "咖啡廳", tenant: `席位(${spot.seat.c},${spot.seat.r})`, msg: `到達格是一格寬死巷(可走鄰格 ${neighbours})` });
  }
  if (queueKeys.has(`${spot.stand.c},${spot.stand.r}`)) {
    issues.push({ when: "咖啡廳", tenant: `席位(${spot.seat.c},${spot.seat.r})`, msg: `到達格被人龍佔用(${spot.stand.c},${spot.stand.r})` });
  }
}
console.log(`  席位 ${cafeSeatSpots().length} 個、人龍 ${queueKeys.size} 格:出入口與死巷檢查完成`);

// --- 健全性報告 ---
console.log(`\n=== 檢查結果 ===`);
console.log(`總移動次數:${totalMoves}`);
for (const rt of Object.values(state.runtimes)) {
  console.log(`  ${rt.tenant.name}:未讀 ${unreadCount(rt.tenant.id)} / log ${rt.log.length} 筆`);
}
if (issues.length === 0) {
  console.log("✅ 無異常:每個非外出時段的租客都走到了目標家具,咖啡廳顧客也全員抵達。");
} else {
  console.log(`⚠ 發現 ${issues.length} 筆異常:`);
  for (const i of issues.slice(0, 20)) console.log(`  [${i.when}] ${i.tenant}:${i.msg}`);
}
