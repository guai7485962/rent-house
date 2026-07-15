/**
 * 戲劇事件(§10-2 戲劇批)驗證:
 * - 劈腿抓包:條件(有伴 + 第三人曖昧 ≥75 + 互有好感 + 伴侶在場)→ 修羅場全套後果
 * - 守門:伴侶外出不抓包、曖昧值不足不觸發、第三人取向不合不算劈腿
 * - 偷吃冰箱:吃貨/夜貓才偷、有交情(≥50)不算偷、冷卻 72h 不重複
 * - 被撞見:第三人記憶/壓力 + 當事人尷尬日誌
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { affairPass, fridgePass, maybeWitness } = await import("../src/sim/drama");
const { relationships, pairKey, getRel } = await import("../src/sim/social");
const { feudActive } = await import("../src/sim/conflicts");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");
const { state } = await import("../src/store");
import type { CoreTag } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const tag = (id: string): CoreTag => ({ id, label: id, behaviorHint: "" });

// 佈景:A(男)×B(女)情侶;再搬入 C(女)當第三者、D 當吃瓜群眾
const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
A.tenant.gender = "male"; A.tenant.attractedTo = ["female"];
B.tenant.gender = "female"; B.tenant.attractedTo = ["male"];
moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
const C = state.runtimes[state.occupancy.r303];
const D = state.runtimes[state.occupancy.r304];
C.tenant.gender = "female"; C.tenant.attractedTo = ["male"];
D.tenant.gender = "male"; D.tenant.attractedTo = ["female"];
for (const rt of [A, B, C, D]) { rt.tenant.visualState = "idle"; rt.pendingEvent = null; }

function coupleAB(v = 90) {
  relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: v, romantic: true, cohabitOffered: true };
}

// --- 守門 ---
coupleAB();
relationships[pairKey(A.tenant.id, C.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
check("曖昧 60 → 不觸發", !affairPass(() => 0));

relationships[pairKey(A.tenant.id, C.tenant.id)] = { value: 80, romantic: false, cohabitOffered: false };
relationships[pairKey(B.tenant.id, C.tenant.id)] = { value: 96, romantic: false, cohabitOffered: false };
B.tenant.visualState = "away";
check("伴侶外出 → 抓不到", !affairPass(() => 0));
B.tenant.visualState = "idle";

C.tenant.attractedTo = ["female"]; // 取向不合 → canRomance false,不算曖昧
check("第三人取向不合 → 不算劈腿", !affairPass(() => 0));
C.tenant.attractedTo = ["male"];

// --- 修羅場全套 ---
const moodB = B.tenant.stats.mood;
check("條件全中 → 修羅場", affairPass(() => 0));
check("情侶拆夥", !getRel(A.tenant.id, B.tenant.id)?.romantic);
check("關係重挫", (getRel(A.tenant.id, B.tenant.id)?.value ?? 99) <= 60);
check("伴侶心情重挫", B.tenant.stats.mood < moodB);
check("三方記憶:[被劈腿]", B.tenant.memoryTags.some((m) => m.label === "[被劈腿]"));
check("三方記憶:[劈腿被抓包]", A.tenant.memoryTags.some((m) => m.label === "[劈腿被抓包]"));
check("閨密背叛好感超級重挫", (getRel(B.tenant.id, C.tenant.id)?.value ?? 99) <= 26);
check("受害者記住摯友背叛", B.tenant.memoryTags.some((m) => m.label === "[摯友背叛]"));
check("第三者記住背叛摯友", C.tenant.memoryTags.some((m) => m.label === "[背叛摯友]"));
check("背叛的閨密也進入冷戰", feudActive(B.tenant.id, C.tenant.id));
check("抓包日誌點明閨密雙重背叛", B.log.some((e) => e.text.includes("自己的閨密")));
check("全樓八卦(D 吃瓜)", D.log.some((e) => e.text.includes("全樓都在傳")));
check("分手後冷戰", feudActive(A.tenant.id, B.tenant.id));
check("通知有發", state.noticeLog.some((n) => n.text.includes("修羅場")));
check("一小時最多一場:分手後不再觸發", !affairPass(() => 0));

// --- 偷吃冰箱 ---
for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
A.log.splice(0); B.log.splice(0); C.log.splice(0); D.log.splice(0);
A.tenant.coreTags = [tag("wfh")]; // 先讓 A 沒有偷吃屬性
B.tenant.coreTags = [tag("caring")];
C.tenant.coreTags = [tag("perfectionist")];
D.tenant.coreTags = [tag("punctual")];
check("沒人有吃貨/夜貓屬性 → 不偷", !fridgePass(() => 0));

A.tenant.coreTags = [tag("foodie")];
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 70, romantic: false, cohabitOffered: false };
relationships[pairKey(A.tenant.id, C.tenant.id)] = { value: 55, romantic: false, cohabitOffered: false };
relationships[pairKey(A.tenant.id, D.tenant.id)] = { value: 65, romantic: false, cohabitOffered: false };
check("跟大家都有交情(≥50)→ 不偷", !fridgePass(() => 0));

relationships[pairKey(A.tenant.id, D.tenant.id)] = { value: 10, romantic: false, cohabitOffered: false };
const relBefore = getRel(A.tenant.id, D.tenant.id)!.value;
check("吃貨 × 低交情 → 偷吃被抓", fridgePass(() => 0));
check("受害者日誌(major)", D.log.some((e) => e.text.includes("偷吃") && e.importance === "major"));
check("小偷也有日誌", A.log.some((e) => e.text.includes("偷吃")));
check("關係扣分", getRel(A.tenant.id, D.tenant.id)!.value < relBefore);
check("受害者記憶 [冰箱結仇]", D.tenant.memoryTags.some((m) => m.label === "[冰箱結仇]"));
check("冷卻中不重複", !fridgePass(() => 0));
state.gameMs += 73 * MS_PER_GAME_HOUR;
check("冷卻 72h 過後可再發", fridgePass(() => 0));

// --- 被撞見 ---
A.log.splice(0); B.log.splice(0); C.log.splice(0); D.log.splice(0);
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 90, romantic: true, cohabitOffered: true };
const witnessed = maybeWitness(A, B, () => 0);
check("有第三人在 → 撞見成立", witnessed);
const witness = [C, D].find((rt) => rt.tenant.memoryTags.some((m) => m.label === "[撞見不該看的]"));
check("撞見者拿到 [撞見不該看的] 記憶與日誌", !!witness && witness.log.some((e) => e.text.includes("撞見")));
check("當事人尷尬日誌", A.log.some((e) => e.text.includes("尷尬")) && B.log.some((e) => e.text.includes("尷尬")));
C.tenant.visualState = "away";
D.tenant.visualState = "away";
check("沒有第三人在場 → 不會被撞見", !maybeWitness(A, B, () => 0));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
