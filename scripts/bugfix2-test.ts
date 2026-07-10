/**
 * 四項 bug 修復驗證(2026-07-10):
 * 1. 退租後,其他租客身上關於他的記憶標籤要清掉(親近者留「搬走了」)
 * 2. 心情很好卻掛著負面記憶標籤 → 每日矛盾檢查移除
 * 3. 同居後,搬過去的租客不能消失(runtime/關係保留、房間空出、免租)
 * 4. 招租應徵者同一遊戲日不重抽
 */
import { state, resolveCohabit, getApplicants, roomOfTenant, debugStepHour, moveIn } from "../src/store";
import { relationships, pairKey, getRel } from "../src/sim/social";
import { pruneContradictedMemories } from "../src/sim/memoryEffects";
import type { Tenant } from "../src/types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
}

const A = "tenant_chen_engineer";
const B = "tenant_lin_asmr";
const a = state.runtimes[A];
const b = state.runtimes[B];

// ---------- Bug 3:同居不消失 ----------
relationships[pairKey(A, B)] = { value: 95, romantic: true, cohabitOffered: true };
a.tenant.gender = "male"; a.tenant.attractedTo = ["female"];
b.tenant.gender = "female"; b.tenant.attractedTo = ["male"];
state.pendingCohabit = { aId: A, bId: B, aName: a.tenant.name, bName: b.tenant.name };
resolveCohabit(true);

check("同居後 b 的 runtime 仍存在", !!state.runtimes[B]);
check("b 的原房間(r302)已空出", !state.occupancy.r302);
check("b 登記為同居(住進 r301)", state.cohabits[B] === "r301");
check("roomOfTenant(b) = r301", roomOfTenant(B) === "r301");
check("情侶關係保留", !!getRel(A, B)?.romantic);
check("雙方獲得同居記憶", a.tenant.memoryTags.some((m) => m.label.includes("同居")) && b.tenant.memoryTags.some((m) => m.label.includes("同居")));

// 同居者免租:推進一整天,看 ledger 只有 a 的房租
const before = state.ledger.length;
for (let i = 0; i < 24; i++) debugStepHour();
const newTxns = state.ledger.slice(before);
const rentB = newTxns.filter((t) => t.category === "rent" && t.label.includes(b.tenant.name));
const rentA = newTxns.filter((t) => t.category === "rent" && t.label.includes(a.tenant.name));
check("同居者(b)不另收租", rentB.length === 0, `b 房租筆數=${rentB.length}`);
check("承租者(a)照常收租", rentA.length >= 1);
check("推進 24h 後 b 仍存在(不會被任何機制誤刪)", !!state.runtimes[B]);

// ---------- Bug 4:應徵者池穩定 ----------
const batch1 = getApplicants("r302");
const batch2 = getApplicants("r302");
check("同日重複開招租,應徵者不重抽", batch1.map((x) => x.id).join() === batch2.map((x) => x.id).join());
check("應徵者不與在住租客同名", batch1.every((x) => x.name !== a.tenant.name && x.name !== b.tenant.name));
for (let i = 0; i < 24; i++) debugStepHour(); // 跨一個遊戲日
const batch3 = getApplicants("r302");
check("跨遊戲日後換新一批", batch3.map((x) => x.id).join() !== batch1.map((x) => x.id).join());

// ---------- Bug 2:矛盾記憶淡出 ----------
const t = {
  memoryTags: [
    { id: "m1", label: "[情緒低落]", behaviorHint: "", acquiredAt: "", source: "ai_event" },
    { id: "m2", label: "[養貓]", behaviorHint: "", acquiredAt: "", source: "ai_event" },
    { id: "m3", label: "[對房東起疑]", behaviorHint: "", acquiredAt: "", source: "ai_event" },
  ],
  stats: { mood: 100, stress: 30, wellbeing: 50, energy: 60, affinity: 90 },
} as unknown as Tenant;
const removed = pruneContradictedMemories(t);
check("心情 100 → [情緒低落] 被移除", removed.includes("[情緒低落]"));
check("好感 90 → [對房東起疑] 被移除(和解)", removed.includes("[對房東起疑]"));
check("無矛盾的 [養貓] 保留", t.memoryTags.some((m) => m.label === "[養貓]"));

const t2 = { memoryTags: [{ id: "m1", label: "[失戀]", behaviorHint: "", acquiredAt: "", source: "ai_event" }], stats: { mood: 40, stress: 60, wellbeing: 50, energy: 60, affinity: 50 } } as unknown as Tenant;
check("心情不高時 [失戀] 不會被移除", pruneContradictedMemories(t2).length === 0);

// ---------- Bug 1:退租清掉別人身上的記憶 ----------
// 招一位新租客進 r302,給 a 一個關於他的記憶,再讓他退租
const ap = getApplicants("r302")[0];
moveIn("r302", ap);
const c = state.runtimes[ap.id];
check("新租客入住 r302", !!c && state.occupancy.r302 === ap.id);
a.tenant.memoryTags.push({ id: "mx", label: `[和${ap.name}成為朋友]`, behaviorHint: `常和 ${ap.name} 聊天`, acquiredAt: "", source: "ai_event" });
relationships[pairKey(A, ap.id)] = { value: 60, romantic: false, cohabitOffered: false };
// 讓他長期不滿 → 退租(把事件冷卻推遠 + 清掉待決事件,避免事件把退租擋住)
c.satisfaction = 0;
c.unhappyHours = 60;
c.pendingEvent = null;
c.lastEventDay = 999999;
debugStepHour();
check("不滿退租:租客已移除", !state.runtimes[ap.id]);
check("a 身上關於他的舊記憶已清除", !a.tenant.memoryTags.some((m) => m.label.includes(ap.name) && !m.label.includes("搬走")));
check("親近的 a 留下「搬走了」記憶", a.tenant.memoryTags.some((m) => m.label === `[${ap.name}搬走了]`));
check("關係表已無他的殘留", Object.keys(relationships).every((k) => !k.includes(ap.id)));

// ---------- 分手搬離(同居的延伸情境) ----------
// b 目前同居在 r301;手動觸發分手處置:有空房(r302)→ 應搬過去轉正
const rel = getRel(A, B)!;
rel.romantic = false;
rel.value = 30;
// endCohabitOnBreakup 是內部函式,經由 socialPass 觸發較難控制;直接驗證資料一致性即可:
// 模擬「b 搬回空房」的最終狀態應可由 moveOut(承租者)驗證 —— 改驗:a 退租時,同居的 b 應接手 r301
state.runtimes[A].satisfaction = 0;
state.runtimes[A].unhappyHours = 60;
state.runtimes[A].pendingEvent = null;
state.runtimes[A].lastEventDay = 999999;
// a 的心情/好感很高會讓滿意度回升 → 壓低,確保這一小時仍 <25
state.runtimes[A].tenant.stats.mood = 5;
state.runtimes[A].tenant.stats.affinity = 5;
state.runtimes[A].tenant.stats.stress = 95;
state.runtimes[A].tenant.memoryTags.splice(0);
debugStepHour();
check("承租者退租後,同居者接手房間", state.occupancy.r301 === B && !state.cohabits[B], `occ=${JSON.stringify(state.occupancy)} cohab=${JSON.stringify(state.cohabits)}`);
check("接手後 roomNo 更新", state.runtimes[B]?.roomNo === "301");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
