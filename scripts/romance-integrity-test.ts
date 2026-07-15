/**
 * 唯一伴侶回歸：自然相遇、AI couple、舊存檔修復都只能形成一對一正式戀情；
 * 已有伴侶時第三人停在曖昧，並能進入既有修羅場機制。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

import type { Tenant } from "../src/types";
const {
  relationships,
  pairKey,
  getRel,
  setCouple,
  canBecomeCouple,
  romanticPartnerId,
  pruneRomanceIntegrity,
  encounter,
  tierLabel,
} = await import("../src/sim/social");
const { state, makeRuntime } = await import("../src/sim/gameState");
const { affairPass } = await import("../src/sim/drama");
const { decide } = await import("../src/sim/tenancy");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const mk = (id: string, name: string, gender: "male" | "female"): Tenant => ({
  id, name, gender, attractedTo: [gender === "male" ? "female" : "male"], isAdult: true,
  occupation: "", bio: "", coreTags: [], memoryTags: [],
  finance: { monthlyRent: 1000, paymentReliability: 80, monthsOverdue: 0 },
  stats: { mood: 60, stress: 40, wellbeing: 70, energy: 60, affinity: 50 },
  preferences: {}, visualState: "idle", recentSummary: "",
} as Tenant);

const A = mk("exclusive_a", "阿哲", "male");
const B = mk("exclusive_b", "小芳", "female");
const C = mk("exclusive_c", "小美", "female");
const D = mk("exclusive_d", "阿宏", "male");
const E = mk("exclusive_e", "小安", "female");
const roster: Record<string, Tenant> = Object.fromEntries([A, B, C, D, E].map((t) => [t.id, t]));
const clearRels = () => { for (const key of Object.keys(relationships)) delete relationships[key]; };

for (const [i, t] of [A, B, C, D, E].entries()) {
  state.runtimes[t.id] = makeRuntime(t, `x${i}`, 70, []);
  state.runtimes[t.id].tenant.visualState = "idle";
}

clearRels();
check("第一段合法戀情可以成立", setCouple(A.id, B.id, true, A, B));
check("可雙向查到唯一正式伴侶", romanticPartnerId(A.id) === B.id && romanticPartnerId(B.id) === A.id);
check("已有伴侶者不能再和第三人成為情侶", !canBecomeCouple(A, C) && !setCouple(A.id, C.id, true, A, C));
check("第三人一側已有伴侶也會擋", setCouple(C.id, D.id, true, C, D) && !setCouple(E.id, D.id, true, E, D));
check("被擋的配對不會誤設 romantic", getRel(A.id, C.id)?.romantic === false && getRel(D.id, E.id)?.romantic === false);

// 自然相遇：跨過 75 仍只到曖昧，不會自動成為第二位正式伴侶。
clearRels();
setCouple(A.id, B.id, true, A, B);
relationships[pairKey(A.id, C.id)] = { value: 74, romantic: false, cohabitOffered: false };
const originalRandom = Math.random;
Math.random = () => 0.5; // 不衝突，固定增加關係
const crossed = encounter(A, C);
Math.random = originalRandom;
check("第三人跨過 75 不會觸發 became_couple", crossed.milestone !== "became_couple" && !getRel(A.id, C.id)?.romantic);
check("第三人保留高關係曖昧", (getRel(A.id, C.id)?.value ?? 0) >= 75 && tierLabel(getRel(A.id, C.id)!) === "曖昧");

// 第三人仍為非正式曖昧，因此既有 affairPass 現在能抓到，不會因先變第二伴侶而免疫。
const scandal = affairPass(() => 0);
check("高曖昧第三者會進入修羅場風險", scandal);
check("修羅場會解除原正式戀情", getRel(A.id, B.id)?.romantic === false);

// AI event 的 couple:true 同樣走 setCouple，不可繞過唯一伴侶守門。
clearRels();
setCouple(A.id, B.id, true, A, B);
const rtA = state.runtimes[A.id];
rtA.pendingEvent = {
  id: "ai_event", title: "曖昧告白", description: "", withId: C.id, ai: true,
  choices: [{ id: "accept", label: "接受告白", hint: "", effect: { rel: { delta: 8, couple: true } } }],
};
decide(A.id, "accept", "接受告白");
check("AI couple:true 也不能建立第二段正式戀情", getRel(A.id, B.id)?.romantic === true && getRel(A.id, C.id)?.romantic === false);
check("AI 被擋時留下曖昧說明，不會文字上假裝已交往", rtA.log.some((entry) => entry.text.includes("已有伴侶") && entry.text.includes("停在曖昧")));

// 舊存檔：同居配對優先；其他衝突邊依關係值配成一對一，其餘降回曖昧。
clearRels();
relationships[pairKey(A.id, B.id)] = { value: 80, romantic: true, cohabitOffered: true };
relationships[pairKey(A.id, C.id)] = { value: 99, romantic: true, cohabitOffered: true };
relationships[pairKey(C.id, D.id)] = { value: 88, romantic: true, cohabitOffered: true };
relationships[pairKey(B.id, D.id)] = { value: 97, romantic: true, cohabitOffered: true };
const removed = pruneRomanceIntegrity((id) => roster[id], (id) => id === A.id ? B.id : id === B.id ? A.id : null);
check("舊存檔優先保留同居配對", getRel(A.id, B.id)?.romantic === true);
check("剩餘角色仍可保留一組不衝突的最高關係戀情", getRel(C.id, D.id)?.romantic === true);
check("與已配對角色衝突的多重戀情降回曖昧", !getRel(A.id, C.id)?.romantic && !getRel(B.id, D.id)?.romantic && removed.length === 2);
check("降級時保留關係值並重置同居申請旗標", getRel(A.id, C.id)?.value === 99 && getRel(A.id, C.id)?.cohabitOffered === false);
const romanticEdges = Object.values(relationships).filter((rel) => rel.romantic).length;
check("五位房客同時最多兩組正式情侶", romanticEdges <= Math.floor(5 / 2), `edges=${romanticEdges}`);

// 沒有同居優先時，保留關係值最高的一組。
clearRels();
relationships[pairKey(A.id, B.id)] = { value: 80, romantic: true, cohabitOffered: false };
relationships[pairKey(A.id, C.id)] = { value: 95, romantic: true, cohabitOffered: false };
pruneRomanceIntegrity((id) => roster[id]);
check("無同居時保留最高關係戀情", getRel(A.id, C.id)?.romantic === true && getRel(A.id, B.id)?.romantic === false);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
