/**
 * 隔音／洗衣間整合回歸：
 * - 完整改建與事件隔音都會永久阻止一般噪音公審，且 AI context 看得到
 * - $3,000 事件工程會入存檔
 * - 洗衣事件真的建立洗衣機前的雙人 session
 * - 每位租客約每四日有一次可見的單人洗衣作息
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, GAME_START, roomOfTenant } = await import("../src/sim/gameState");
const { noiseComplaintEligible, roomAcousticsForTenant, grantEventSoundproofing } = await import("../src/sim/acoustics");
const { EVENT_SOUNDPROOFING_ID, upgradeState } = await import("../src/sim/upgrades");
const { buildNarrateCtx } = await import("../src/sim/narration");
const { COMMUNITY_EVENTS, laundryStageTiles, resolveGroupEvent } = await import("../src/sim/community");
const { clearPairSessions, sessionFor } = await import("../src/floor/pairSession");
const { FACILITY_RECTS } = await import("../src/floor/map");
const { laundryHourForDay, resolveTarget } = await import("../src/sim/routine");
const { applyHour } = await import("../src/sim/tick");
const { save } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const [A, B] = Object.values(state.runtimes);
const roomId = roomOfTenant(A.tenant.id)!;
const originalTags = A.tenant.coreTags;
const originalUpgrades = [...(upgradeState.byRoom[roomId] ?? [])];
const noisyTag = { id: "gamer", label: "[玩家]", behaviorHint: "會打電動", acquiredAt: "", source: "ai_event" as const, intensity: 1 };
A.tenant.coreTags = [noisyTag];
delete upgradeState.byRoom[roomId];

check("無隔音的玩家可成為噪音公審對象", noiseComplaintEligible(A));
upgradeState.byRoom[roomId] = ["soundproof_reno"];
check("$12,000 完整改建會阻止噪音公審", !noiseComplaintEligible(A));
check("AI context 看得到永久隔音且抗議已阻隔", (() => {
  const room = buildNarrateCtx(A, "測試日").room;
  return room.treated === true && room.complaintRisk === false;
})());

delete upgradeState.byRoom[roomId];
check("$3,000 事件工程可永久登記", grantEventSoundproofing(A.tenant.id));
check("事件工程完成後也不再被一般噪音公審", !noiseComplaintEligible(A));
check("事件工程提供隔音屬性並標記 treated", (() => {
  const room = roomAcousticsForTenant(A.tenant.id);
  return room.soundproof >= 4 && room.treated;
})());
save();
check("事件隔音工程有寫入存檔", JSON.parse(mem["rent_house_save_v1"]).upgrades[roomId].includes(EVENT_SOUNDPROOFING_ID));

// 用真正的群體事件解決路徑驗證 installsSoundproofing，不只測底層 helper。
delete upgradeState.byRoom[roomId];
state.money = 50000;
state.pendingGroupEvent = {
  id: "noise_verdict", title: "噪音糾紛要你裁決", description: "",
  participantIds: [A.tenant.id, B.tenant.id],
  // 模擬部署前已存在的待決事件（沒有新欄位），仍應依 event/choice id 補上永久工程。
  choices: [{ id: "soundproof", label: "花錢做隔音($3,000)", hint: "", money: -3000, clearsNoise: true }],
};
check("噪音裁決可正常解決", resolveGroupEvent("soundproof"));
check("裁決扣 $3,000 並留下永久工程", state.money === 47000 && upgradeState.byRoom[roomId].includes(EVENT_SOUNDPROOFING_ID));

// 洗衣事件必須真的把兩個人帶到洗衣間，不再只有日誌和中央 FX。
clearPairSessions();
A.tenant.visualState = "sleeping_on_bed";
B.tenant.visualState = "idle";
const laundry = COMMUNITY_EVENTS.find((e) => e.id === "laundry")!;
check("洗衣事件不會把睡覺的人半夜硬拉去洗衣", laundry.select([A, B], () => 0.5) === null);
A.tenant.visualState = "idle";
laundry.fire([A, B], () => 0.5);
const sesA = sessionFor(A.tenant.id, state.gameMs);
const sesB = sessionFor(B.tenant.id, state.gameMs);
const rect = FACILITY_RECTS.laundry;
const inLaundry = (tile: { c: number; r: number } | undefined) => !!tile && tile.c >= rect.c0 && tile.c <= rect.c1 && tile.r >= rect.r0 && tile.r <= rect.r1;
check("洗衣間有兩個合法事件站位", (() => {
  const tiles = laundryStageTiles();
  return !!tiles && inLaundry(tiles.a) && inLaundry(tiles.b) && (tiles.a.c !== tiles.b.c || tiles.a.r !== tiles.b.r);
})());
check("洗衣事件建立雙人面對面 session", sesA?.pose === "stand_face" && sesB?.pose === "stand_face");
check("兩位角色的 session 位置都在洗衣間", inLaundry(sesA?.tile) && inLaundry(sesB?.tile));
check("洗衣事件期間兩人顯示使用家電", A.tenant.visualState === "using_appliance" && B.tenant.visualState === "using_appliance");

// 約每四日一次，不改每日固定作息；排到時 applyHour 會真的使用共用洗衣機。
const scheduled = Array.from({ length: 12 }, (_, day) => ({ day, hour: laundryHourForDay(A.tenant.id, day) })).filter((x) => x.hour != null);
check("十二天約有三次日常洗衣", scheduled.length === 3, `count=${scheduled.length}`);
check("laundry role 會解析到洗衣間家具", resolveTarget("laundry", roomId)?.placement.room === "laundry");
const first = scheduled[0];
state.gameMs = GAME_START.getTime() + first.day * 24 * 3600 * 1000;
A.directive = null;
A.tenant.stats.stress = 40;
applyHour(A, first.hour!, false);
check("排定日的單人作息會走到洗衣間洗衣", A.tenant.visualState === "using_appliance" && resolveTarget("laundry", roomId)?.tile.c === A.targetTile?.c && resolveTarget("laundry", roomId)?.tile.r === A.targetTile?.r);

A.tenant.coreTags = originalTags;
if (originalUpgrades.length) upgradeState.byRoom[roomId] = originalUpgrades;
else delete upgradeState.byRoom[roomId];

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
