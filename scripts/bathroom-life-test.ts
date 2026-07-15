/** 浴室生活擴充：精確家具選位、輪替作息、設備佔用、坐躺姿勢與現場事件。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { TENANT_VISUAL_STATES } = await import("../src/types");
const { OBSERVATION_LINES } = await import("../src/content/observationLines");
const { getDef } = await import("../src/furniture/catalog");
const { bathroomActivityForDay, resolveTarget } = await import("../src/sim/routine");
const { addPlacement, removePlacementAt } = await import("../src/sim/placements");
const { applyHour, claimBathroomFixture, resetBathroomClaims } = await import("../src/sim/tick");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { COMMUNITY_EVENTS, bathroomStageTiles } = await import("../src/sim/community");
const { clearPairSessions, sessionFor } = await import("../src/floor/pairSession");
const { relationships, pairKey } = await import("../src/sim/social");
const { state, roomOfTenant } = await import("../src/store");
const { GAME_START } = await import("../src/sim/gameState");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
const roomId = roomOfTenant(A.tenant.id);
A.directive = null; B.directive = null;
A.pendingEvent = null; B.pendingEvent = null;
A.tenant.stats.stress = 40; B.tenant.stats.stress = 40;

const newStates = ["using_toilet", "washing_at_sink", "taking_bath", "waiting_for_bathroom"] as const;
check("四種浴室生活狀態已列入白名單", newStates.every((s) => TENANT_VISUAL_STATES.includes(s)));
check("每種浴室狀態都有足量本地觀察文案", newStates.every((s) => (OBSERVATION_LINES[s]?.length ?? 0) >= 8));
check("馬桶／洗手台／浴缸目錄會解鎖各自活動", getDef("toilet").unlocksStates.includes("using_toilet")
  && getDef("bath_sink").unlocksStates.includes("washing_at_sink")
  && getDef("bathtub").unlocksStates.includes("taking_bath"));

check("如廁只會解析到馬桶", resolveTarget("bathroom", roomId, "using_toilet")?.placement.defId === "toilet");
check("刷牙洗臉只會解析到浴室洗手台", resolveTarget("bathroom", roomId, "washing_at_sink")?.placement.defId === "bath_sink");
check("淋浴只會解析到淋浴間", resolveTarget("bathroom", roomId, "showering")?.placement.defId === "shower");
check("沒有浴缸時泡澡沒有假目標", resolveTarget("bathroom", roomId, "taking_bath") === null);

const variants = new Set(Array.from({ length: 4 }, (_, day) => bathroomActivityForDay(A.tenant.id, day, 5)));
check("四天輪替涵蓋淋浴／如廁／盥洗／泡澡", newStates.slice(0, 3).every((s) => variants.has(s)) && variants.has("showering"));

const dayFor = (wanted: string) => Array.from({ length: 8 }, (_, day) => day)
  .find((day) => bathroomActivityForDay(A.tenant.id, day, 5) === wanted)!;

state.gameMs = GAME_START.getTime() + dayFor("using_toilet") * 24 * 3600 * 1000;
resetBathroomClaims();
applyHour(A, 5, false);
check("排到如廁時角色真的走向馬桶", A.tenant.visualState === "using_toilet" && A.targetTile?.c === resolveTarget("bathroom", roomId, "using_toilet")?.tile.c);
let agents = createAgents();
tickAgents(agents, 0);
let agent = agents.find((x) => x.tenantId === A.tenant.id)!;
check("角色會跨上馬桶使用坐姿", agent.pose === "sit" && !agent.moving && A.activitySurface === "furniture");

state.gameMs = GAME_START.getTime() + dayFor("washing_at_sink") * 24 * 3600 * 1000;
resetBathroomClaims();
applyHour(A, 5, false);
check("排到盥洗時角色真的站到洗手台前", A.tenant.visualState === "washing_at_sink" && A.targetTile?.c === resolveTarget("bathroom", roomId, "washing_at_sink")?.tile.c);

addPlacement({ defId: "bathtub", room: "bathroom", c: 3, r: 24, rotation: 0 });
state.gameMs = GAME_START.getTime() + dayFor("taking_bath") * 24 * 3600 * 1000;
resetBathroomClaims();
applyHour(A, 5, false);
agents = createAgents();
tickAgents(agents, 0);
agent = agents.find((x) => x.tenantId === A.tenant.id)!;
check("擺放浴缸後泡澡會使用浴缸躺姿", A.tenant.visualState === "taking_bath" && agent.pose === "lie" && A.activitySurface === "furniture");
removePlacementAt(3, 24);

resetBathroomClaims(123);
check("第一位可占用馬桶", claimBathroomFixture("toilet", A.tenant.id, 123));
check("同一時段第二位不能重疊使用馬桶", !claimBathroomFixture("toilet", B.tenant.id, 123));
check("不同設備仍可同時使用", claimBathroomFixture("bath_sink", B.tenant.id, 123));
resetBathroomClaims(124);
check("兩座同型設備可用座標識別後同時使用", claimBathroomFixture("bathroom:toilet:1,28", A.tenant.id, 124)
  && claimBathroomFixture("bathroom:toilet:4,28", B.tenant.id, 124));

state.gameMs = GAME_START.getTime() + dayFor("using_toilet") * 24 * 3600 * 1000;
resetBathroomClaims(state.gameMs);
const toiletPlacement = resolveTarget("bathroom", roomId, "using_toilet")!.placement;
claimBathroomFixture(`${toiletPlacement.room}:${toiletPlacement.defId}:${toiletPlacement.c},${toiletPlacement.r}`, B.tenant.id, state.gameMs);
applyHour(A, 5, false);
check("馬桶被占用時會到浴室門外排隊", A.tenant.visualState === "waiting_for_bathroom" && (A.targetTile?.c ?? 0) >= 7);

const bathroom = COMMUNITY_EVENTS.find((e) => e.id === "bathroom")!;
A.tenant.visualState = "sleeping_on_bed";
B.tenant.visualState = "idle";
check("浴室事件不會把睡覺的人硬拉去排隊", bathroom.select([A, B], () => 0.5) === null);
A.tenant.visualState = "idle";
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
clearPairSessions();
bathroom.fire([A, B], () => 0.5);
const sesA = sessionFor(A.tenant.id, state.gameMs);
const sesB = sessionFor(B.tenant.id, state.gameMs);
check("浴室事件有合法門口雙人站位", bathroomStageTiles() !== null);
check("浴室事件建立面對面現場演出", sesA?.pose === "stand_face" && sesB?.pose === "stand_face" && A.tenant.visualState === "waiting_for_bathroom");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
