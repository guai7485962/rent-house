/**
 * 群體場景導演回歸：
 * - 交誼廳多人站位唯一且高於雙人互動／一般作息
 * - 天台場景隱藏主樓層 sprite，並保留退租者的外觀快照
 * - 正確時段的社群事件會從持久化佇列啟動，外出作息不會讓答應參加者消失
 * - 場景以遊戲時間到期，且整套走位不消耗 RNG
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state } = await import("../src/store");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn, farewellSendoff } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");
const { scheduledCommunityPass } = await import("../src/sim/community");
const { startPairSession, sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const {
  startGroupScene, groupSceneFor, groupSceneView, clearGroupScene,
} = await import("../src/floor/groupScene");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
const ids = Object.keys(state.runtimes).sort().slice(0, 3);
const [aId, bId, cId] = ids;
check("三位場景參與者就緒", ids.length === 3);

let randomCalls = 0;
const noRng = () => { randomCalls++; return 0.5; };

// 多人舞台會清掉衝突的雙人演出，且每人拿到不同走位。
clearGroupScene();
clearPairSessions();
startPairSession(aId, bId, { c: 8, r: 11 }, "pair", state.gameMs);
const loungeStarted = startGroupScene({
  id: "test:lounge",
  title: "測試交誼廳聚會",
  venue: "lounge",
  layout: "table",
  participantIds: ids,
  gameNow: state.gameMs,
  priority: 2,
});
const lounge = groupSceneView();
const tileKeys = lounge?.actors.map((actor) => `${actor.tile?.c},${actor.tile?.r}`) ?? [];
check("交誼廳場景成功建立三人走位", loungeStarted && lounge?.actors.length === 3);
check("三人站位互不重疊", new Set(tileKeys).size === 3, tileKeys.join(" / "));
check("多人場景接管前清掉參與者的雙人演出", sessionFor(aId, state.gameMs) === null && sessionFor(bId, state.gameMs) === null);
check("低優先權場景不能蓋掉章節場景", startGroupScene({
  id: "test:lower",
  title: "低優先權",
  venue: "lounge",
  layout: "cluster",
  participantIds: ids,
  gameNow: state.gameMs,
  priority: 1,
}) === false && groupSceneView()?.id === "test:lounge");

// 天台不在主平面上：參與者於主樓層隱藏，另由 FloorMap 的小舞台呈現。
clearGroupScene();
state.runtimes[aId].tenant.visualState = "away";
startGroupScene({
  id: "test:roof",
  title: "傍晚頂樓乘涼",
  venue: "rooftop",
  layout: "cluster",
  participantIds: ids,
  gameNow: state.gameMs,
  priority: 2,
});
check("天台參與者在主樓層隱藏（含原作息外出者）",
  ids.every((id) => groupSceneFor(id, state.gameMs)?.hidden === true));
const removed = state.runtimes[aId];
const snapName = removed.tenant.name;
delete state.runtimes[aId];
check("runtime 移除後舞台仍保留角色外觀快照",
  groupSceneView()?.actors.some((actor) => actor.tenantId === aId && actor.name === snapName) === true);
state.runtimes[aId] = removed;
check("跨過一個遊戲小時後場景自動清除",
  groupSceneView(state.gameMs + MS_PER_GAME_HOUR) === null);

// 排程入存檔；重載後到了時段才結算並啟動現場。
const due = state.gameMs + MS_PER_GAME_HOUR;
state.scheduledCommunityEvents.splice(0, state.scheduledCommunityEvents.length, {
  eventId: "rooftop",
  participantIds: ids,
  dueGameMs: due,
});
save();
state.scheduledCommunityEvents.splice(0);
check("待演社群事件可從存檔恢復", load() && state.scheduledCommunityEvents.length === 1);
state.gameMs = due;
state.runtimes[aId].tenant.visualState = "away";
clearGroupScene();
const fired = scheduledCommunityPass(noRng);
check("到正確時段才啟動天台群體場景", fired === 1 && groupSceneView()?.venue === "rooftop");
check("答應參加者不因一般外出作息而缺席", groupSceneView()?.actors.length === 3);
check("排程與站位不額外消耗 RNG", randomCalls === 0, `calls=${randomCalls}`);

// 歡送會先拍 snapshot；離開者隨後從 runtime 移除，畫面仍能送他最後一程。
clearGroupScene();
const leaver = state.runtimes[aId];
farewellSendoff(leaver);
delete state.runtimes[aId];
const farewell = groupSceneView();
check("多人歡送會建立交誼廳送別舞台", farewell?.layout === "farewell" && farewell.actors.length >= 2);
check("離開者退租後仍留在歡送會快照", farewell?.actors.some((actor) => actor.tenantId === aId && actor.name === leaver.tenant.name) === true);
state.runtimes[aId] = leaver;
clearGroupScene();

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
