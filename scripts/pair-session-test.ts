/**
 * 雙人互動圖式(§10-6 第一階段)驗證:
 * - session 登記/查詢/替換/過期(現實時間+遊戲時間雙重)/清空
 * - tileB 會挑錨點旁可走的相鄰格
 * - agent 層:pair pose 走位被錨點覆寫;hidden pose(🔞 遮蔽式)sprite 隱藏
 * - 整合:互動觸發後這一對確實有 session;交誼廳相遇也會湊到一起演
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { startPairSession, sessionFor, activeSessions, clearPairSessions } = await import("../src/floor/pairSession");
const { currentBlocked } = await import("../src/floor/pathfind");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { interactionsPass } = await import("../src/sim/interactions");
const { relationships, pairKey } = await import("../src/sim/social");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");
const { state, debugStepHour } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const now = () => state.gameMs;

// --- 單元:session 生命週期 ---
// 找一個「可走且旁邊有可走鄰格」的錨點
const blocked = currentBlocked();
let anchor = { c: 7, r: 10 };
outer: for (let r = 1; r < blocked.length - 1; r++) {
  for (let c = 1; c < blocked[0].length - 1; c++) {
    if (!blocked[r][c] && (!blocked[r][c + 1] || !blocked[r][c - 1] || !blocked[r + 1][c] || !blocked[r - 1][c])) {
      anchor = { c, r };
      break outer;
    }
  }
}

clearPairSessions();
startPairSession("pa", "pb", anchor, "pair", now());
check("登記後有 1 場 session", activeSessions(now()).length === 1);
const sa = sessionFor("pa", now());
const sb = sessionFor("pb", now());
check("A 分到錨點", !!sa && sa.tile.c === anchor.c && sa.tile.r === anchor.r);
check("B 分到相鄰格(非同格)", !!sb && Math.abs(sb.tile.c - anchor.c) + Math.abs(sb.tile.r - anchor.r) === 1);
check("B 的格可走", !!sb && !blocked[sb.tile.r][sb.tile.c]);
check("局外人查不到 session", sessionFor("px", now()) === null);

// 替換:同一人再登記 → 舊的被清掉,一人同時只演一場
startPairSession("pa", "pc", anchor, "hidden", now());
check("同一人新 session 取代舊的", activeSessions(now()).length === 1);
check("pb 的舊 session 已失效", sessionFor("pb", now()) === null);
check("hidden pose 帶得出來", sessionFor("pa", now())?.pose === "hidden");

// 現實時間過期自清
startPairSession("pd", "pe", anchor, "pair", now(), 0);
check("現實時間到期的 session 查不到", sessionFor("pd", now()) === null);

// 遊戲時間過期(快轉/無頭模擬):現實時間還沒到,但遊戲已過 1 小時 → 失效,不釘住作息
startPairSession("pf", "pg", anchor, "pair", now(), 60000);
check("遊戲時間未過:查得到", sessionFor("pf", now()) !== null);
check("遊戲時間過 1 小時:失效", sessionFor("pf", now() + MS_PER_GAME_HOUR) === null);

clearPairSessions();
check("clearPairSessions 清空", activeSessions(now()).length === 0);

// --- agent 層:走位覆寫 + 遮蔽式隱藏 ---
debugStepHour(); // 讓 targetTile 就緒
const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
A.tenant.visualState = "idle";
B.tenant.visualState = "idle";
A.targetTile = { ...anchor };
B.targetTile = { ...anchor };
const agents = createAgents();
const agA = agents.find((x) => x.tenantId === A.tenant.id)!;
const agB = agents.find((x) => x.tenantId === B.tenant.id)!;

startPairSession(A.tenant.id, B.tenant.id, anchor, "pair", now());
tickAgents(agents, 0.05);
check("pair pose:A 目標被覆寫為錨點", !agA.hidden && !!agA.goal && agA.goal.c === anchor.c && agA.goal.r === anchor.r);
check("pair pose:B 目標被覆寫為相鄰格", !agB.hidden && !!agB.goal && (agB.goal.c !== anchor.c || agB.goal.r !== anchor.r));

startPairSession(A.tenant.id, B.tenant.id, anchor, "hidden", now());
tickAgents(agents, 0.05);
check("hidden pose(🔞 遮蔽式):兩人 sprite 都隱藏", agA.hidden && agB.hidden);

// 坐/躺圖式(§10-6):不隱藏、pose 帶到 agent 給渲染層
startPairSession(A.tenant.id, B.tenant.id, anchor, "sit", now());
tickAgents(agents, 0.05);
check("sit pose:兩人不隱藏且 agent.pose=sit", !agA.hidden && !agB.hidden && agA.pose === "sit" && agB.pose === "sit");
startPairSession(A.tenant.id, B.tenant.id, anchor, "lie", now());
tickAgents(agents, 0.05);
check("lie pose:agent.pose=lie", agA.pose === "lie" && agB.pose === "lie");

clearPairSessions();
tickAgents(agents, 0.05);
check("session 結束:兩人重新現身、pose 清空", !agA.hidden && !agB.hidden && agA.pose === null && agB.pose === null);

// --- 家具座位錨點(§10-6):session 指定沙發佔用格 → 走到旁邊「跨上去」坐 ---
const { furnitureSeats } = await import("../src/sim/interactions");
const seats = furnitureSeats("lounge", ["shared_sofa"]);
check("furnitureSeats 找到共用沙發並肩兩格", !!seats && Math.abs(seats!.a.c - seats!.b.c) === 1 && seats!.a.r === seats!.b.r);
check("寬 1 家具坐不下兩人 → null", furnitureSeats("lounge", ["coffee_machine"]) === null);
check("地點沒這件家具 → null", furnitureSeats("r301", ["shared_sofa"]) === null);
if (seats) {
  A.targetTile = { c: seats.a.c, r: seats.a.r + 1 }; // 從沙發正前方出發
  B.targetTile = { c: seats.b.c - 2, r: seats.b.r + 2 }; // 稍遠處出發(要走幾步)
  const ag2 = createAgents();
  const a2 = ag2.find((x) => x.tenantId === A.tenant.id)!;
  const b2 = ag2.find((x) => x.tenantId === B.tenant.id)!;
  startPairSession(A.tenant.id, B.tenant.id, seats.a, "sit", now(), 15000, seats);
  for (let i = 0; i < 600; i++) tickAgents(ag2, 0.1);
  check("兩人各自坐上沙發格(跨上家具)", a2.c === seats.a.c && a2.r === seats.a.r && b2.c === seats.b.c && b2.r === seats.b.r, `a=(${a2.c},${a2.r}) b=(${b2.c},${b2.r})`);
  check("坐定後不再移動、pose=sit", !a2.moving && !b2.moving && a2.pose === "sit" && b2.pose === "sit");
  clearPairSessions();
  tickAgents(ag2, 0.05);
  check("session 結束:能從家具格走回原目標", !a2.moving || a2.path.length > 0);
}

// --- 整合:互動觸發 → 這一對有 session ---
A.tenant.gender = "male"; A.tenant.attractedTo = ["female"];
B.tenant.gender = "female"; B.tenant.attractedTo = ["male"];
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 95, romantic: true, cohabitOffered: true };
delete state.occupancy.r302;
state.cohabits[B.tenant.id] = "r301";
A.tenant.visualState = "idle"; B.tenant.visualState = "idle";
A.pendingEvent = null; B.pendingEvent = null;
state.adultMode = true;
state.gameMs = new Date("2026-07-06T23:30:00+08:00").getTime();

let triggered = false;
for (let i = 0; i < 300 && !triggered; i++) {
  clearPairSessions();
  interactionsPass();
  triggered = activeSessions(now()).length > 0;
}
check("整合:同房互動觸發後登記了 session", triggered);
if (triggered) {
  check("整合:session 屬於這一對", sessionFor(A.tenant.id, now()) !== null && sessionFor(B.tenant.id, now()) !== null);
}

// 🔞 互動一定是 hidden(遮蔽式):清冷卻反覆觸發,收集出現過的 pose
for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
let sawAdult = false;
let adultAlwaysHidden = true;
for (let i = 0; i < 400; i++) {
  clearPairSessions();
  A.log.splice(0); B.log.splice(0);
  for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
  interactionsPass();
  const adultHit = A.log.some((e) => e.text.includes("請勿打擾") || e.text.includes("水聲"));
  if (adultHit) {
    sawAdult = true;
    if (sessionFor(A.tenant.id, now())?.pose !== "hidden") adultAlwaysHidden = false;
  }
}
check("整合:🔞 互動有觸發到(抽樣)", sawAdult);
check("整合:🔞 互動的 session 一律 hidden(遮蔽式)", adultAlwaysHidden);

// --- 整合:交誼廳相遇(socialPass)也登記 session ---
delete state.cohabits[B.tenant.id];
state.occupancy.r302 = B.tenant.id;
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
A.inLounge = true; B.inLounge = true;
A.tenant.visualState = "idle"; B.tenant.visualState = "idle";
clearPairSessions();
let loungeSession = false;
for (let i = 0; i < 100 && !loungeSession; i++) {
  debugStepHour();
  A.inLounge = true; B.inLounge = true;
  A.pendingEvent = null; B.pendingEvent = null;
  loungeSession = sessionFor(A.tenant.id, now()) !== null || sessionFor(B.tenant.id, now()) !== null;
}
check("整合:交誼廳相遇會湊到一起演(session 登記)", loungeSession);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
