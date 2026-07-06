import { encounter, compatibility, getRel, tierLabel } from "../src/sim/social";
import type { Gender, Tenant } from "../src/types";

function mk(id: string, name: string, gender: Gender, attractedTo: Gender[], tags: string[]): Tenant {
  return {
    id, name, occupation: "", bio: "", gender, attractedTo,
    coreTags: tags.map((t) => ({ id: t, label: t, behaviorHint: "" })),
    memoryTags: [],
    finance: { monthlyRent: 0, paymentReliability: 80, monthsOverdue: 0 },
    stats: { mood: 70, stress: 30, hygiene: 70, affinity: 50 },
    preferences: {}, visualState: "idle", recentSummary: "",
  } as Tenant;
}

// 1. 相容 + 互有意 → 朋友 → 情侶 → 同居
const a = mk("a", "阿哲", "male", ["female"], ["night_owl", "gamer"]);
const b = mk("b", "小婕", "female", ["male"], ["night_owl", "gamer"]);
console.log(`相容度 阿哲-小婕:${compatibility(a, b)}(正=契合)`);
let friends = false, couple = false, cohabit = false, coupleAt = -1;
for (let i = 0; i < 90; i++) {
  const r = encounter(a, b);
  if (r.milestone === "became_friends") friends = true;
  if (r.milestone === "became_couple") { couple = true; coupleAt = i; }
  if (r.cohabit) cohabit = true;
}
const rel = getRel("a", "b")!;
console.log(`  90 次相遇:關係 ${Math.round(rel.value)}/${tierLabel(rel)} · 成朋友 ${friends} · 成情侶 ${couple}(第${coupleAt}次)· 觸發同居 ${cohabit}`);

// 2. 個性衝突:吵鬧 vs 聲音敏感 → 相容度負、常起衝突
const c = mk("c", "鼓手", "male", ["female"], ["noisy", "late_return"]);
const d = mk("d", "敏感", "female", ["male"], ["sound_sensitive", "early_bird"]);
console.log(`\n相容度 鼓手-敏感:${compatibility(c, d)}(負=水火不容)`);
let conflicts = 0;
for (let i = 0; i < 40; i++) if (encounter(c, d).importance === "notable") conflicts++;
console.log(`  40 次相遇:衝突 ${conflicts} 次 · 關係 ${Math.round(getRel("c", "d")!.value)}`);

// 3. 取向不合 → 永不成情侶(即使關係很高)
const e = mk("e", "男A", "male", ["female"], ["night_owl", "gamer"]);
const f = mk("f", "男B", "male", ["female"], ["night_owl", "gamer"]);
let coupleEF = false;
for (let i = 0; i < 90; i++) if (encounter(e, f).milestone === "became_couple") coupleEF = true;
console.log(`\n兩個異性戀男 90 次相遇:關係 ${Math.round(getRel("e", "f")!.value)} · 成情侶 ${coupleEF}(應 false)`);
