/** 相性＋積怨資料模型、冷卻、群體活動折算與舊存檔相容。 */
const {
  relationships, pairKey, getRel, encounter, compatibilityDetail, adjustGroupBond,
  relationshipDailyPass, listRelationships, loadRelationships, serializeRelationships,
  setCouple,
} = await import("../src/sim/social");
import type { CoreTag, Tenant } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const tag = (id: string): CoreTag => ({ id, label: id, behaviorHint: "" });
const tenant = (id: string, name: string, tags: string[], gender: "male" | "female"): Tenant => ({
  id, name, age: 28, isAdult: true, gender, attractedTo: gender === "male" ? ["female"] : ["male"],
  occupation: "測試", roomNo: "301", coreTags: tags.map(tag), memoryTags: [], growthTags: [],
  stats: { mood: 60, stress: 40, wellbeing: 70, energy: 70, affinity: 50 },
  finance: { monthlyRent: 10000, deposit: 20000 }, visualState: "idle",
} as Tenant);

const noisy = tenant("fr_noisy", "夜班玩家", ["noisy", "gamer", "night_owl"], "male");
const quiet = tenant("fr_quiet", "早起工作者", ["sound_sensitive", "wfh", "early_bird", "busybody"], "female");
const detail = compatibilityDetail(noisy, quiet);
check("相性細節給出負分", detail.score <= -3, `score=${detail.score}`);
check("相性原因具體包含噪音與作息", detail.conflicts.some((r) => r.includes("噪音")) && detail.conflicts.some((r) => r.includes("作息")), detail.conflicts.join(" / "));
check("相性細節以結構欄位標記噪音衝突", detail.hasNoiseConflict);

const originalRandom = Math.random;
const setRel = (a: Tenant, b: Tenant, tension: number) => {
  relationships[pairKey(a.id, b.id)] = {
    value: 10, tension, lastConflictGameMs: 0, romantic: false, cohabitOffered: false,
  };
};

// tension=0、無隔音時保留舊版精確門檻與 RNG 骨架。
const neutralA = tenant("threshold_neutral_a", "中性甲", [], "male");
const neutralB = tenant("threshold_neutral_b", "中性乙", [], "female");
setRel(neutralA, neutralB, 0);
Math.random = () => 0.03;
check("中性零積怨在舊 3% 邊界不衝突", !encounter(neutralA, neutralB).naturalConflict);
setRel(neutralA, neutralB, 0);
Math.random = () => 0.029999;
check("中性零積怨維持舊 3% 門檻", encounter(neutralA, neutralB).naturalConflict);

const incompatibleA = tenant("threshold_bad_a", "夜貓甲", ["night_owl"], "male");
const incompatibleB = tenant("threshold_bad_b", "早鳥乙", ["early_bird"], "female");
setRel(incompatibleA, incompatibleB, 0); // comp=-2，舊門檻恰為 20%
Math.random = () => 0.20;
check("負相性零積怨在舊 20% 邊界不衝突", !encounter(incompatibleA, incompatibleB).naturalConflict);
setRel(incompatibleA, incompatibleB, 0);
Math.random = () => 0.199999;
check("負相性零積怨維持舊 20% 門檻", encounter(incompatibleA, incompatibleB).naturalConflict);
setRel(incompatibleA, incompatibleB, 60); // 舊公式：.20 + 60*.0035 = .41
Math.random = () => 0.410001;
check("負相性積怨 60 在舊 41% 門檻上方不衝突", !encounter(incompatibleA, incompatibleB).naturalConflict);
setRel(incompatibleA, incompatibleB, 60);
Math.random = () => 0.409999;
check("負相性持續沿用既有逐點積怨加壓", encounter(incompatibleA, incompatibleB).naturalConflict);

const compatibleA = tenant("threshold_good_a", "運動甲", ["fitness"], "male");
const compatibleB = tenant("threshold_good_b", "運動乙", ["fitness"], "female");
setRel(compatibleA, compatibleB, 60);
Math.random = () => 0.03;
check("正相性積怨 60 仍在緩衝帶並維持舊 3%", !encounter(compatibleA, compatibleB).naturalConflict);
setRel(compatibleA, compatibleB, 65); // base .03 + (65-60)*.0035 = .0475
Math.random = () => 0.04;
check("正相性積怨接近冷戰風險後提高自然口角機率", encounter(compatibleA, compatibleB).naturalConflict);

setRel(neutralA, neutralB, 0);
let randomCalls = 0;
Math.random = () => { randomCalls += 1; return 0.5; };
encounter(neutralA, neutralB, { allowConflict: false });
check("節流時仍維持既有衝突 roll＋一般互動 RNG 骨架", randomCalls === 3, `calls=${randomCalls}`);
Math.random = originalRandom;

// 舊 v6 關係資料沒有 tension/cooldown；載入後必須補零且能繼續運算。
loadRelationships([{ key: pairKey(noisy.id, quiet.id), value: 12, romantic: false, cohabitOffered: false }]);
check("舊關係資料載入後 tension/cooldown 預設 0", getRel(noisy.id, quiet.id)?.tension === 0 && getRel(noisy.id, quiet.id)?.lastConflictGameMs === 0);

Math.random = () => 0;
const hour = 60 * 60 * 1000;
const first = encounter(noisy, quiet, { gameMs: 24 * hour, allowConflict: true });
const afterFirst = getRel(noisy.id, quiet.id)!;
check("不合房客口角會累積 tension 並寫具體原因", first.naturalConflict && afterFirst.tension >= 10 && /噪音|作息/.test(first.textA));
const second = encounter(noisy, quiet, { gameMs: 25 * hour, allowConflict: true });
check("同一對口角後 12 小時冷卻", second.tone !== "conflict");
const third = encounter(noisy, quiet, { gameMs: 37 * hour, allowConflict: true });
check("冷卻期滿後可再次發生口角", third.tone === "conflict");
Math.random = originalRandom;

const rel = getRel(noisy.id, quiet.id)!;
rel.value = 20;
rel.tension = 40;
adjustGroupBond(noisy, quiet, 4);
check("水火不容者參加群體活動不會無條件加好感", rel.value === 20);
check("共同完成活動仍會讓積怨略降", rel.tension === 38);
relationshipDailyPass();
check("每日自然降溫 -2", rel.tension === 36);

rel.value = 0;
rel.tension = 55;
const views = listRelationships((id) => id === noisy.id ? noisy : id === quiet.id ? quiet : undefined);
check("關係 0 但有積怨仍會出現在關係頁資料", views.length === 1 && views[0].tension === 55 && views[0].reasons.length >= 1);
check("高積怨／負相性阻止直接建立戀情", setCouple(noisy.id, quiet.id, true, noisy, quiet) === false && !rel.romantic);

const saved = serializeRelationships()[0];
check("序列化保留 tension 與衝突冷卻", saved.tension === 55 && typeof saved.lastConflictGameMs === "number");

for (const key of Object.keys(relationships)) delete relationships[key];
console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
