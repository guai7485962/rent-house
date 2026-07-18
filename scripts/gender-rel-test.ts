/**
 * 性別資料完整性 + 戀愛寫入口徑驗證(關係頁性別符號的資料保證):
 * - 種子租客與 recruit 產生的一批應徵者(20+ 位)全部都有 gender 與非空 attractedTo
 *   → 關係頁的性別符號永遠不會出現紅色「?」
 * - setCouple 直接對同性兩人設 true 會被拒(回 false 且 romantic 未寫入)
 *   → UI 之下的寫入口徑也把關,不只 canRomance
 * - 一對互相吸引的異性成年租客可成情侶(正向對照)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32),抽樣應徵者可重現
let __seed = 20260718;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

import type { Tenant } from "../src/types";
const { generateApplicants } = await import("../src/sim/recruit");
const { setCouple, getRel, relationships, pairKey } = await import("../src/sim/social");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const GENDERS = new Set(["male", "female", "nonbinary"]);
const hasIdentity = (p: { gender?: string; attractedTo?: string[] }) =>
  !!p.gender && GENDERS.has(p.gender) && Array.isArray(p.attractedTo) && p.attractedTo.length > 0;

// --- a. 種子租客:gender / attractedTo 齊全 ---
const seeded = Object.values(state.runtimes).map((rt) => rt.tenant);
check("種子租客都有 gender 與非空 attractedTo", seeded.length > 0 && seeded.every(hasIdentity),
  seeded.filter((t) => !hasIdentity(t)).map((t) => t.id).join(","));

// --- a. recruit 產生的應徵者:抽 20+ 位全部齊全 ---
const applicants: { name: string; gender?: string; attractedTo?: string[] }[] = [];
for (let round = 0; round < 2; round++) {
  for (const roomId of ["r301", "r302", "r303", "r304"]) applicants.push(...generateApplicants(roomId));
}
check("抽樣應徵者數量 ≥ 20", applicants.length >= 20, `只有 ${applicants.length} 位`);
check("應徵者全部都有 gender 與非空 attractedTo(關係頁不會出現紅色「?」)",
  applicants.every(hasIdentity),
  applicants.filter((a) => !hasIdentity(a)).map((a) => a.name).join(","));

// --- b/c. setCouple 寫入口徑把關 ---
const mk = (id: string, gender: "male" | "female", attractedTo: ("male" | "female")[]): Tenant =>
  ({ id, name: id, gender, attractedTo, isAdult: true } as unknown as Tenant);
const clearRels = () => { for (const k of Object.keys(relationships)) delete relationships[k]; };

// b. 同性兩人(即使互有取向)直接 setCouple → 拒絕且 romantic 未寫入
clearRels();
const m1 = mk("gr_m1", "male", ["male", "female"]);
const m2 = mk("gr_m2", "male", ["male", "female"]);
check("setCouple:同性兩人設 true 被拒(回 false)", setCouple(m1.id, m2.id, true, m1, m2) === false);
check("setCouple:被拒後 romantic 未寫入", getRel(m1.id, m2.id)?.romantic !== true);

const f1 = mk("gr_f1", "female", ["female"]);
const f2 = mk("gr_f2", "female", ["female"]);
check("setCouple:同性女性也被拒", setCouple(f1.id, f2.id, true, f1, f2) === false && getRel(f1.id, f2.id)?.romantic !== true);

// c. 互相吸引的異性成年租客 → 可成情侶(正向對照)
clearRels();
const him = mk("gr_him", "male", ["female"]);
const her = mk("gr_her", "female", ["male"]);
check("setCouple:互相吸引的異性成年租客可成情侶", setCouple(him.id, her.id, true, him, her) === true);
check("setCouple:成功後 romantic 已寫入且關係值 ≥ 75",
  relationships[pairKey(him.id, her.id)]?.romantic === true && (getRel(him.id, her.id)?.value ?? 0) >= 75);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
