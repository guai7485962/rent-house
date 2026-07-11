/**
 * 維修/損壞系統(§7-1)驗證:
 * - 觸發:故障入 state、費用擲定合理、住戶當下有感(日誌+滿意度)
 * - 不疊加:一房同時最多一件
 * - 拖延懲罰:每日滿意度/心情下滑 + 抱怨日誌
 * - 修理:錢不夠擋;夠則扣款記帳(upkeep)、故障移除、住戶回饋
 * - 存檔:save/load 後故障仍在
 * - 整合:跨日 tick 會擲骰與施加懲罰,不崩潰
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { BREAKDOWNS, getBreakdownDef, triggerBreakdown, maintenancePass, repairBreakdown } = await import("../src/sim/maintenance");
const { save, load } = await import("../src/sim/persistence");
const { state, debugStepHour } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = state.runtimes["tenant_chen_engineer"]; // r301
const B = state.runtimes["tenant_lin_asmr"]; // r302

// --- 觸發 ---
const satBefore = A.satisfaction;
check("觸發成功", triggerBreakdown("r301", "water_heater", () => 0.5));
const bd = state.breakdowns.r301;
const def = getBreakdownDef("water_heater")!;
check("故障入 state", !!bd && bd.defId === "water_heater");
check("費用在區間內且取整到百", bd.cost >= def.cost[0] && bd.cost <= def.cost[1] && bd.cost % 100 === 0, `實際 ${bd.cost}`);
check("住戶當下滿意度下滑", A.satisfaction < satBefore);
check("住戶留下故障日誌", A.log.some((e) => e.text.includes("熱水器")));
check("同房不疊加第二件", !triggerBreakdown("r301", "leak"));
check("通知有發", state.noticeLog.some((n) => n.text.includes("熱水器故障")));

// --- 拖延懲罰(rng=0.99:不擲出新故障)---
const satDay0 = A.satisfaction;
const moodDay0 = A.tenant.stats.mood;
const otherSat = B.satisfaction;
maintenancePass(() => 0.99);
check("拖延:滿意度每日下滑", Math.round(satDay0 - A.satisfaction) === -def.perDay.satisfaction, `Δ=${A.satisfaction - satDay0}`);
check("拖延:心情每日下滑", A.tenant.stats.mood < moodDay0);
check("拖延:留下抱怨日誌", A.log.filter((e) => e.text.includes("🚿")).length >= 2);
check("別房住戶不受影響", B.satisfaction === otherSat);

// --- 修理 ---
state.money = 0;
let res = repairBreakdown("r301");
check("錢不夠 → 擋下", !res.ok && res.reason === "金錢不足");
state.money = 50000;
const moneyBefore = state.money;
const satBeforeFix = A.satisfaction;
res = repairBreakdown("r301");
check("修理成功", res.ok);
check("扣款正確", state.money === moneyBefore - bd.cost);
check("記帳為 upkeep 支出", state.ledger.some((t) => t.category === "upkeep" && t.label.includes("維修") && t.amount === -bd.cost));
check("故障移除", !state.breakdowns.r301);
check("住戶修好後滿意度回升", A.satisfaction > satBeforeFix);
check("沒故障的房修理 → 擋下", !repairBreakdown("r302").ok);

// --- maintenancePass 擲骰(rng=0:必壞)---
maintenancePass(() => 0);
check("擲骰:有人住的房都壞了", !!state.breakdowns.r301 && !!state.breakdowns.r302);
check("空房不擲骰", !state.breakdowns.r303 && !state.breakdowns.r304);

// --- 存檔往返 ---
save();
delete state.breakdowns.r301;
delete state.breakdowns.r302;
check("讀檔成功", load());
check("讀檔後故障恢復", !!state.breakdowns.r301 && !!state.breakdowns.r302);

// --- 整合:帶著故障跨日 tick 不崩潰 ---
const logLen = state.runtimes["tenant_chen_engineer"].log.length;
for (let i = 0; i < 30; i++) debugStepHour();
check("跨日模擬無崩潰、日誌持續產生", state.runtimes["tenant_chen_engineer"].log.length >= logLen);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
