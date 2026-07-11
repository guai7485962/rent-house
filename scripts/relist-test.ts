/**
 * 招租重新刊登(§7-1 招租費用)驗證:
 * - 扣費正確(記帳 other)、應徵者池立刻換新、同日不再自動重抽
 * - 錢不夠 → 擋且不動池
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { getApplicants, relistApplicants, RELIST_COST } = await import("../src/sim/tenancy");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const ids = (roomId: string) => getApplicants(roomId).map((a) => a.id).join(",");

// 建池
const before = ids("r303");
check("同日重複查詢不重抽", ids("r303") === before);

// 錢不夠 → 擋
state.money = RELIST_COST - 1;
const res1 = relistApplicants("r303");
check("錢不夠 → 擋", !res1.ok && res1.reason === "金錢不足");
check("池不動", ids("r303") === before);

// 正常刊登
state.money = 50000;
const moneyBefore = state.money;
check("重新刊登成功", relistApplicants("r303").ok);
check("扣費正確", state.money === moneyBefore - RELIST_COST);
check("記帳(other 類別)", state.ledger.some((t) => t.category === "other" && t.label.includes("重新刊登") && t.amount === -RELIST_COST));
const after = ids("r303");
check("應徵者池換新", after !== before);
check("同日再查詢仍是新批(不自動重抽)", ids("r303") === after);
check("別房的池不受影響", !!state.applicantPools.r303 && !state.applicantPools.r302);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
