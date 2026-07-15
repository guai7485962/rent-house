/**
 * 社群事件(群體事件省成本版,§C-7)驗證:
 * - 洗衣房:關係差 → 搶洗衣機口角(rel↓);關係好 → 邊洗邊聊(rel↑)——讓死空間活起來
 * - 揪團/頂樓:3+ 人一起 → 全員心情↑、兩兩關係↑
 * - 噪音公審:有吵鬧/夜貓住戶才成立(多對一);沒有 → select 回 null
 * - communityPass:牽動 3+ 人、進 Feed、冷卻不洗版、稀疏觸發
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32),機率型測試可重現
let __seed = 20260710;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { COMMUNITY_EVENTS, communityPass, rollGroupEvent, resolveGroupEvent } = await import("../src/sim/community");
const { relationships, pairKey, getRel } = await import("../src/sim/social");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// 湊滿 4 位在場租客
if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
if (!state.occupancy.r304) moveIn("r304", generateApplicants("r304")[0]);
const rts = Object.values(state.runtimes);
for (const rt of rts) rt.tenant.visualState = "idle"; // 都在場、非外出
check("四位在場租客就緒", rts.length === 4 && rts.every((r) => r.tenant.visualState !== "away"));

const ev = (id: string) => COMMUNITY_EVENTS.find((e) => e.id === id)!;
const A = rts[0];
const B = rts[1];
const relVal = () => getRel(A.tenant.id, B.tenant.id)?.value ?? 0;

// --- 洗衣房:關係差 → 口角 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 20, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const relBeforeClash = relVal();
ev("laundry").fire([A, B], Math.random);
check("洗衣房(關係差):兩人關係下降", relVal() < relBeforeClash);
check("洗衣房(關係差):出現搶洗衣機口角日誌", A.log.some((e) => e.text.includes("搶最後一台空機")) || B.log.some((e) => e.text.includes("搶走")));
check("洗衣房口角進 Feed(notable)", A.log.some((e) => e.text.includes("洗衣房") && e.importance === "notable"));

// --- 洗衣房:關係好 → 變更近 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const relBeforeBond = relVal();
ev("laundry").fire([A, B], Math.random);
check("洗衣房(關係好):兩人關係上升", relVal() > relBeforeBond);
check("洗衣房(關係好):出現邊洗邊聊日誌", A.log.some((e) => e.text.includes("聊")) || B.log.some((e) => e.text.includes("聊")));

// --- 浴室:關係差 → 搶浴室口角;關係好 → 排隊聊天 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 20, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const relBeforeBath = relVal();
ev("bathroom").fire([A, B], Math.random);
check("浴室(關係差):兩人關係下降 + 設施爭用日誌", relVal() < relBeforeBath && [A, B].some((rt) => rt.log.some((e) => /搶浴室|敲門催|廁所|洗手台|熱水/.test(e.text))));
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const relBeforeBathBond = relVal();
ev("bathroom").fire([A, B], Math.random);
check("浴室(關係好):兩人關係上升 + 排隊互助日誌", relVal() > relBeforeBathBond && [A, B].some((rt) => rt.log.some((e) => /排隊|閒聊|洗手台|牙膏|熱水|乾毛巾/.test(e.text))));

// --- 早晨尖峰:3 人壓力↑但同仇敵愾拉近 ---
const rush = [rts[0], rts[1], rts[2]];
for (const rt of rush) { rt.tenant.stats.stress = 40; rt.log.splice(0); }
relationships[pairKey(rush[0].tenant.id, rush[1].tenant.id)] = { value: 40, romantic: false, cohabitOffered: false };
const rushRelBefore = getRel(rush[0].tenant.id, rush[1].tenant.id)!.value;
ev("morning_rush").fire(rush, Math.random);
check("早晨尖峰:全員壓力上升", rush.every((rt) => rt.tenant.stats.stress > 40));
check("早晨尖峰:同仇敵愾關係反而上升", getRel(rush[0].tenant.id, rush[1].tenant.id)!.value > rushRelBefore);

// --- 揪團:3 人全員心情↑、兩兩關係↑ ---
const trio = [rts[0], rts[1], rts[2]];
for (const rt of trio) { rt.tenant.stats.mood = 50; rt.log.splice(0); }
relationships[pairKey(trio[0].tenant.id, trio[2].tenant.id)] = { value: 40, romantic: false, cohabitOffered: false };
const relTrioBefore = getRel(trio[0].tenant.id, trio[2].tenant.id)!.value;
ev("group_order").fire(trio, Math.random);
check("揪團:全員心情上升", trio.every((rt) => rt.tenant.stats.mood > 50));
check("揪團:兩兩關係上升", getRel(trio[0].tenant.id, trio[2].tenant.id)!.value > relTrioBefore);
check("揪團:每人都有一筆 Feed 日誌", trio.every((rt) => rt.log.some((e) => e.text.includes("揪團") && e.importance === "notable")));

// --- 頂樓乘涼:壓力↓ ---
for (const rt of trio) { rt.tenant.stats.stress = 60; rt.log.splice(0); }
ev("rooftop").fire(trio, Math.random);
check("頂樓乘涼:全員壓力下降", trio.every((rt) => rt.tenant.stats.stress < 60));

// --- 噪音公審:需要吵鬧/夜貓住戶 ---
const mkTag = (id: string) => ({ id, label: `[${id}]`, behaviorHint: "", acquiredAt: "", source: "ai_event" as const, intensity: 1 });
for (const rt of rts) rt.tenant.coreTags = [mkTag("caring")]; // 先全部不吵
check("噪音公審:無吵鬧住戶 → select 回 null", ev("noise_tribunal").select(rts, Math.random) === null);
rts[0].tenant.coreTags = [mkTag("night_owl")]; // 給一位夜貓
const sel = ev("noise_tribunal").select(rts, Math.random);
check("噪音公審:有夜貓 → 選出 target + 2 抱怨者", !!sel && sel.length === 3 && sel[0].tenant.id === rts[0].tenant.id);
if (sel) {
  const target = sel[0];
  target.tenant.stats.stress = 40;
  target.log.splice(0);
  ev("noise_tribunal").fire(sel, Math.random);
  check("噪音公審:target 壓力上升", target.tenant.stats.stress > 40);
  check("噪音公審:target 有被上門抱怨日誌", target.log.some((e) => e.text.includes("抱怨")));
}

// --- communityPass 整合:冷卻不洗版 + 稀疏 ---
for (const k of Object.keys(state.interactionCooldowns)) if (k.startsWith("community|")) delete state.interactionCooldowns[k];
let fired = 0;
let laundryFires = 0;
for (let day = 0; day < 40; day++) {
  const before = state.interactionCooldowns;
  const beforeKeys = Object.keys(before).filter((k) => k.startsWith("community|")).length;
  if (communityPass()) {
    fired++;
    if (state.interactionCooldowns["community|laundry"] === state.gameMs) laundryFires++;
  }
  state.gameMs += 24 * 3600 * 1000; // 前進一遊戲日
  void beforeKeys;
}
check("communityPass:40 天內有觸發社群事件", fired > 0, `fired=${fired}`);
check("communityPass:稀疏(不是每天都觸發)", fired < 40, `fired=${fired}`);

// 冷卻:剛觸發過的洗衣房事件,冷卻期內 select 仍在但 communityPass 不會重挑它(靠 onCooldown)
state.interactionCooldowns["community|laundry"] = state.gameMs;
const eligibleNow = COMMUNITY_EVENTS.filter((e) => {
  const last = state.interactionCooldowns[`community|${e.id}`];
  return !(last != null && state.gameMs - last < e.cooldownDays * 24 * 3600 * 1000);
});
check("冷卻:剛觸發的洗衣房事件不在 eligible 內", !eligibleNow.some((e) => e.id === "laundry"));

// --- 群體事件(有房東抉擇版)---
const clearGroup = () => { state.pendingGroupEvent = null; delete state.interactionCooldowns["community|group_any"]; };

// rollGroupEvent:掛上待決群體事件
clearGroup();
rts[0].tenant.coreTags = [mkTag("night_owl")]; // 保證 noise_verdict 也可能成立
const rolled = rollGroupEvent(rts, Math.random);
check("rollGroupEvent:掛上待決群體事件", rolled && !!state.pendingGroupEvent);
check("群體事件:參與者都是在場租客、有選項", !!state.pendingGroupEvent && state.pendingGroupEvent.participantIds.every((id) => !!state.runtimes[id]) && state.pendingGroupEvent.choices.length >= 2);
check("群體事件:有待決時不重複掛新的", rollGroupEvent(rts, Math.random) === false);

// resolveGroupEvent:效果擴散(all/first/rest/money/bond)——用手構的事件精確驗證
clearGroup();
const p0 = rts[0], p1 = rts[1], p2 = rts[2];
p0.tenant.stats.stress = 20; p0.tenant.stats.affinity = 40;
p1.satisfaction = 50; p1.tenant.stats.affinity = 40;
p2.tenant.stats.affinity = 40;
relationships[pairKey(p1.tenant.id, p2.tenant.id)] = { value: 40, romantic: false, cohabitOffered: false };
const relB = getRel(p1.tenant.id, p2.tenant.id)!.value;
state.money = 50000;
state.pendingGroupEvent = {
  id: "test", title: "測試全樓事務", description: "",
  participantIds: [p0.tenant.id, p1.tenant.id, p2.tenant.id],
  choices: [{ id: "go", label: "選它", hint: "", money: -2500, all: { affinity: 5 }, first: { stress: 8 }, rest: { satisfaction: 4 }, bond: 3 }],
};
const okResolve = resolveGroupEvent("go");
check("resolveGroupEvent:成功且清掉待決", okResolve && state.pendingGroupEvent === null);
check("群體事件:房東花費扣款", state.money === 50000 - 2500);
check("群體事件:all 對全員生效(好感 +5)", p0.tenant.stats.affinity === 45 && p1.tenant.stats.affinity === 45 && p2.tenant.stats.affinity === 45);
check("群體事件:first 只對當事人(壓力 +8)", p0.tenant.stats.stress === 28);
check("群體事件:rest 對其餘(滿意 +4)", p1.satisfaction === 54);
check("群體事件:bond 兩兩關係上升", getRel(p1.tenant.id, p2.tenant.id)!.value > relB);
check("resolveGroupEvent:無待決時回 false", resolveGroupEvent("go") === false);

// 冷卻:剛解算過 → rollGroupEvent 在 3 日內不再觸發
check("群體事件:剛解算後 3 日冷卻內不觸發", rollGroupEvent(rts, Math.random) === false);

// 存檔往返:pendingGroupEvent 保留
clearGroup();
rollGroupEvent(rts, Math.random);
const pendingTitle = state.pendingGroupEvent?.title;
save();
state.pendingGroupEvent = null;
load();
check("群體事件:存檔往返保留待決事件", state.pendingGroupEvent?.title === pendingTitle);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
