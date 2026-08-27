/**
 * 咖啡廳打烊後的租客聚會(CAFE-21 的內容端;`docs/咖啡廳經營玩法-重設計.md` §4.12)。
 *
 * 這批的三條紅線各有直接釘子:
 * 1. **零漂移**:未開張時 `communityPass()` 一次 `rng()` 都不多抽 ⇒ balance 快照局
 *    (永遠不開張)的亂數序列位元級不變。
 * 2. **不動既有平衡**:咖啡廳事件放在獨立池,不進 `COMMUNITY_EVENTS` ⇒
 *    lounge / rooftop 每件的相對機率仍是 1/N 而非 1/(N+2)。
 * 3. **打烊後才聚會**:場地時段落在 `cafeBusinessOpen()` 為 false 的時間,
 *    才不會與顧客人龍／店員站位搶格。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const {
  COMMUNITY_EVENTS, CAFE_COMMUNITY_EVENTS, CAFE_GATHER_HOUR, CAFE_GATHER_CHANCE,
  communityPass, scheduledCommunityPass,
} = await import("../src/sim/community");
const { CAFE_CLOSE_HOUR, CAFE_OPEN_HOUR, cafeBusinessOpen } = await import("../src/sim/tick");
const { groupSceneView, clearGroupScene } = await import("../src/floor/groupScene");
const { buildGrid, CAFE_RECTS } = await import("../src/floor/map");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");
const { isWeekend } = await import("../src/sim/week");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// 湊滿 4 位在場租客(咖啡廳事件的 need 已降到 2,週末場最多選 4 人入鏡,湊滿才驗得到 select 上限)
if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
if (!state.occupancy.r304) moveIn("r304", generateApplicants("r304")[0]);
for (const rt of Object.values(state.runtimes)) {
  rt.tenant.visualState = "idle";
  rt.pendingEvent = null;
}
state.pendingGroupEvent = null;
check("四位在場租客就緒", Object.values(state.runtimes).length >= 3);

// ---------------------------------------------------------------------------
// 1) 場地與時段:打烊後才聚會
// ---------------------------------------------------------------------------
check("聚會時段就是打烊後的第一個整點(釘住 tick.ts 的 CAFE_CLOSE_HOUR)",
  CAFE_GATHER_HOUR === CAFE_CLOSE_HOUR + 1, `gather=${CAFE_GATHER_HOUR} close=${CAFE_CLOSE_HOUR}`);
check("聚會時段不在營業時間內(不會與顧客人龍/店員站位搶格)",
  cafeBusinessOpen(true, CAFE_GATHER_HOUR) === false
  && cafeBusinessOpen(true, CAFE_OPEN_HOUR) === true);
check("咖啡廳事件全部用 cafe 場地且排在打烊後",
  CAFE_COMMUNITY_EVENTS.length >= 2
  && CAFE_COMMUNITY_EVENTS.every((e) => e.scene?.venue === "cafe" && e.scene?.hour === CAFE_GATHER_HOUR));

// ---------------------------------------------------------------------------
// 2) 不動既有 lounge / rooftop 的平衡
// ---------------------------------------------------------------------------
const cafeIds = new Set(CAFE_COMMUNITY_EVENTS.map((e) => e.id));
check("咖啡廳事件沒有混進 COMMUNITY_EVENTS(既有事件的相對機率不被稀釋)",
  COMMUNITY_EVENTS.every((e) => !cafeIds.has(e.id)));
check("COMMUNITY_EVENTS 內沒有任何 cafe 場地(lounge/rooftop 演出未被改寫)",
  COMMUNITY_EVENTS.every((e) => !e.scene || e.scene.venue === "lounge" || e.scene.venue === "rooftop"));

// ---------------------------------------------------------------------------
// 3) 零漂移:未開張時不多抽任何一次 RNG
// ---------------------------------------------------------------------------
let rngCalls = 0;
/** 固定回 0.9:群體事件(<0.18)不成立、社群事件(>0.4)不成立、咖啡廳(>0.3)也不成立 */
const countingRng = () => { rngCalls++; return 0.9; };
const clearCooldowns = () => {
  for (const key of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[key];
};

state.cafe.open = false;
clearCooldowns();
state.scheduledCommunityEvents.splice(0);
rngCalls = 0;
communityPass(countingRng);
const closedCalls = rngCalls;
check("未開張:communityPass 只抽既有的兩次(群體事件閘門 + 社群事件閘門)",
  closedCalls === 2, `calls=${closedCalls}`);
check("未開張:不排任何咖啡廳演出", state.scheduledCommunityEvents.length === 0);

state.cafe.open = true;
rngCalls = 0;
communityPass(countingRng);
check("已開張:多抽一次咖啡廳機率骰(0.9 > 0.3 ⇒ 這天仍不聚會)",
  rngCalls === closedCalls + 1, `calls=${rngCalls}`);
check("已開張但骰輸:仍然不排演出", state.scheduledCommunityEvents.length === 0);

// ---------------------------------------------------------------------------
// 4) 完整流程:排程 → 存檔往返 → 到點開演在一樓
// ---------------------------------------------------------------------------
// 腳本化 RNG:①群體事件閘門 skip ②社群事件閘門 skip ③咖啡廳機率命中 ④之後全 0
const scripted = (values: number[]): (() => number) => {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
};

state.cafe.open = true;
clearCooldowns();
state.scheduledCommunityEvents.splice(0);
// 挪到當天 09:00,dueAtHour(21) 才會排在同一天而不是隔天
const day = new Date(state.gameMs);
day.setHours(9, 0, 0, 0);
state.gameMs = day.getTime();
const fired = communityPass(scripted([0.9, 0.9, CAFE_GATHER_CHANCE - 0.05]));
check("已開張且骰贏:排出一場咖啡廳聚會", fired === true && state.scheduledCommunityEvents.length === 1,
  `fired=${fired} queued=${state.scheduledCommunityEvents.length}`);
const entry = state.scheduledCommunityEvents[0];
check("排程的事件 id 來自咖啡廳池", !!entry && cafeIds.has(entry.eventId), entry?.eventId);
check("排程時段是打烊後的 21:00", !!entry && new Date(entry.dueGameMs).getHours() === CAFE_GATHER_HOUR,
  entry ? String(new Date(entry.dueGameMs).getHours()) : "-");
check("平日/週末各挑到自己那條(select 由 isWeekend 分流)",
  !!entry && (isWeekend(state.gameMs) ? entry.eventId === "cafe_weekend_night" : entry.eventId === "cafe_afterhours"),
  `${entry?.eventId} weekend=${isWeekend(state.gameMs)}`);

// 存檔往返:只有既有的 scheduledCommunityEvents 欄位,不需要新的存檔欄位
save();
state.scheduledCommunityEvents.splice(0);
check("咖啡廳排程可從既有存檔欄位還原(SAVE_VERSION 不動)",
  load() && state.scheduledCommunityEvents.length === 1 && cafeIds.has(state.scheduledCommunityEvents[0].eventId));

state.gameMs = state.scheduledCommunityEvents[0].dueGameMs;
clearGroupScene();
for (const rt of Object.values(state.runtimes)) rt.log.splice(0);
let playRng = 0;
const fireRng = () => { playRng++; return 0.5; };
const played = scheduledCommunityPass(fireRng);
const scene = groupSceneView(state.gameMs);
check("到 21:00 才開演,且場地是咖啡廳", played === 1 && scene?.venue === "cafe", `played=${played} venue=${scene?.venue}`);
check("開演不消耗 RNG(文案走既有決定性雜湊)", playRng === 0, `calls=${playRng}`);
check("三位以上租客拿到互不重疊的走位", (scene?.actors.length ?? 0) >= 3
  && new Set(scene?.actors.map((a) => `${a.tile?.c},${a.tile?.r}`)).size === scene?.actors.length);

const grid = buildGrid();
const box = CAFE_RECTS.cafe_floor;
check("每個走位都落在一樓 cafe_floor(不站到吧台內側或寵物區)",
  scene?.actors.every((a) => !!a.tile
    && a.tile.r >= box.r0 && a.tile.r <= box.r1 && a.tile.c >= box.c0 && a.tile.c <= box.c1
    && grid[a.tile.r]?.[a.tile.c] === "cafe_floor") === true,
  scene?.actors.map((a) => `${a.tile?.c},${a.tile?.r}`).join(" / "));
check("咖啡廳場地不隱藏 sprite(和 rooftop 的隱藏小舞台不同)",
  scene?.actors.every((a) => a.tile !== null) === true);
check("參與者都拿到聚會日誌(進 Feed)",
  scene?.actors.every((a) => (state.runtimes[a.tenantId]?.log ?? []).some((e) => e.importance === "notable")) === true);

clearGroupScene();
console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
