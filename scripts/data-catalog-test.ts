/**
 * 事件/作息資料化(設計檢討 §5 工作項 8)驗證:
 * - routines.json 展開後與原寫死作息一致(抽查)+ 24 小時全覆蓋 + 角色反查
 * - events.json 觸發優先序/門檻/{name} 代換與原行為一致
 * - 事件連鎖:requiresFlag 解鎖 + consumesFlag 消耗(rollEvent 層 + hourlyTick 整合)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

const { state } = await import("../src/store");
const { CATALOG, getDef: getFurnDef } = await import("../src/furniture/catalog");
const { routineSlot, routineRoles, ARCHETYPE_ROUTINES } = await import("../src/sim/routine");
const { rollEvent } = await import("../src/sim/events");
const { decide } = await import("../src/store");
const { hourlyTick } = await import("../src/sim/tick");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

// --- 1. 作息目錄:與原寫死表一致(抽查)+ 全覆蓋 ---
const spot = (id: string, h: number, role: string, st: string) => {
  const s = routineSlot(id, h);
  return s.role === role && s.state === st;
};
check("陳家豪 02 打電動", spot("tenant_chen_engineer", 2, "desk", "gaming"));
check("陳家豪 13 逗貓", spot("tenant_chen_engineer", 13, "sofa", "playing_with_cat"));
check("陳家豪 17 外出上班", spot("tenant_chen_engineer", 17, "out", "away"));
check("林小婕 03 直播中", spot("tenant_lin_asmr", 3, "desk", "streaming"));
check("林小婕 19 洗澡", spot("tenant_lin_asmr", 19, "bathroom", "showering"));
check("office 原型 10 外出", ARCHETYPE_ROUTINES.office[10].role === "out");
check("office 原型 23 睡覺", ARCHETYPE_ROUTINES.office[23].state === "sleeping_on_bed");
check("student 原型 00 打電動", ARCHETYPE_ROUTINES.student[0].state === "gaming");
check("freelancer 原型 23 趕稿", ARCHETYPE_ROUTINES.freelancer[23].state === "working_at_desk");
check(
  "三套原型 24 小時全覆蓋",
  Object.values(ARCHETYPE_ROUTINES).every((t) => t.length === 24 && t.every((s) => !!s.role && !!s.state)),
);
const roles = routineRoles("tenant_chen_engineer");
check("角色反查:含 desk/bed/kitchen、不含 out", roles.includes("desk") && roles.includes("bed") && roles.includes("kitchen") && !roles.includes("out"));

// --- 2. 事件目錄:優先序/門檻/{name} 代換 ---
const base = { name: "測試員", stress: 30, satisfaction: 60, affinity: 60, wellbeing: 70, flags: [] as string[] };
check("平穩狀態 → 不觸發", rollEvent(base) === null);
check("stress 90 → breakdown(最高優先)", rollEvent({ ...base, stress: 90, wellbeing: 20 })?.id === "breakdown");
const sickEv = rollEvent({ ...base, wellbeing: 28 });
check("wellbeing 28 → sick", sickEv?.id === "sick");
check("{name} 代換進標題", sickEv?.title === "測試員 生病了");
check("satisfaction 29 → dissatisfied", rollEvent({ ...base, satisfaction: 29 })?.id === "dissatisfied");
check("affinity 20 → grievance", rollEvent({ ...base, affinity: 20 })?.id === "grievance");
check("sick 的 rest 選項帶 flag+hermit", sickEv?.choices.find((c) => c.id === "rest")?.effect.flag === "病中沒人管" && sickEv?.choices.find((c) => c.id === "rest")?.effect.directive?.id === "hermit");
const stressEv = rollEvent({ ...base, stress: 95 });
check("breakdown 的 space 選項留下後續旗標", stressEv?.choices.find((c) => c.id === "space")?.effect.flag === "壓力自己扛");
const dissatisfiedEv = rollEvent({ ...base, satisfaction: 20 });
check("dissatisfied 的 promise 選項留下承諾旗標", dissatisfiedEv?.choices.find((c) => c.id === "promise")?.effect.flag === "答應改善房間");

// --- 3. 事件連鎖(rollEvent 層):requiresFlag 解鎖 + consumeFlag ---
check("沒旗標 → sick_aftermath 不觸發", rollEvent({ ...base, wellbeing: 70 }) === null);
const after = rollEvent({ ...base, wellbeing: 70, flags: ["病中沒人管"] });
check("有旗標且康復 → sick_aftermath 觸發", after?.id === "sick_aftermath");
check("觸發時標記 consumeFlag", after?.consumeFlag === "病中沒人管");
check("旗標在但還沒康復 → 不觸發", rollEvent({ ...base, wellbeing: 50, flags: ["病中沒人管"] }) === null);
const stressAfter = rollEvent({ ...base, stress: 55, flags: ["壓力自己扛"] });
check("壓力降下來且有旗標 → stress_aftermath", stressAfter?.id === "stress_aftermath" && stressAfter.consumeFlag === "壓力自己扛");
check("仍在高壓時不提前觸發後續", rollEvent({ ...base, stress: 80, flags: ["壓力自己扛"] }) === null);
const promiseDue = rollEvent({ ...base, satisfaction: 45, flags: ["答應改善房間"] });
check("承諾未兌現且滿意仍低 → promise_due", promiseDue?.id === "promise_due" && promiseDue.consumeFlag === "答應改善房間");
check("房間已改善 → 不追討舊承諾", rollEvent({ ...base, satisfaction: 70, flags: ["答應改善房間"] }) === null);

// --- 4. 整合:生病選「休養」留旗標 → 康復日 tick 觸發後續事件並消耗旗標 ---
const lin = state.runtimes["tenant_lin_asmr"];
lin.tenant.stats.wellbeing = 20;
lin.pendingEvent = rollEvent({ ...base, name: lin.tenant.name, wellbeing: 20 });
check("整合:生病事件掛上", lin.pendingEvent?.id === "sick");
decide(lin.tenant.id, "rest", "讓他自己休養");
check("整合:決定後旗標寫入 runtime", lin.flags.includes("病中沒人管"));
check("整合:hermit 指令生效", lin.directive?.id === "hermit");
lin.tenant.stats.wellbeing = 75; // 康復
lin.lastEventDay = -99; // 解除事件冷卻
hourlyTick(false);
check("整合:康復日觸發 sick_aftermath", lin.pendingEvent?.id === "sick_aftermath");
check("整合:旗標已消耗(不會重複觸發)", !lin.flags.includes("病中沒人管"));

// --- 5. 家具品質層級(tier):值域合法 + 平價變體比精品同胞便宜/低屬性 ---
const VALID_TIERS = new Set(["budget", "standard", "premium"]);
const attrSum = (id: string) => Object.values(getFurnDef(id).attributes).reduce((a, v) => a + (v ?? 0), 0);
check(
  "每件家具的 tier 若有值必為 budget/standard/premium(選配但合法)",
  CATALOG.every((d) => d.tier === undefined || VALID_TIERS.has(d.tier)),
);
check(
  "床鋪三階:single=budget、double=standard、canopy=premium",
  getFurnDef("single_bed").tier === "budget"
    && getFurnDef("double_bed").tier === "standard"
    && getFurnDef("canopy_bed").tier === "premium",
);
check(
  "床鋪三階價格遞增(budget < standard < premium)",
  getFurnDef("single_bed").price < getFurnDef("double_bed").price
    && getFurnDef("double_bed").price < getFurnDef("canopy_bed").price,
);
check(
  "床鋪三階屬性遞增(budget ≤ standard ≤ premium)",
  attrSum("single_bed") <= attrSum("double_bed") && attrSum("double_bed") <= attrSum("canopy_bed"),
);
// 新增平價入門變體:tier=budget,且比同類精品/較貴同胞更便宜、屬性不高於它
const BUDGET_VS_PRICIER: Array<[string, string]> = [
  ["folding_bed", "canopy_bed"],   // 折疊床 vs 帷幔床(premium)
  ["plastic_stool", "loveseat"],   // 塑膠椅凳 vs 戀人沙發(premium)
  ["bare_bulb", "floor_lamp"],     // 裸燈泡 vs 落地燈(standard)
];
check("新增三件平價變體 tier 皆為 budget",
  ["folding_bed", "plastic_stool", "bare_bulb"].every((id) => getFurnDef(id).tier === "budget"));
check(
  "平價變體比其較貴同胞便宜且屬性不高於它",
  BUDGET_VS_PRICIER.every(([cheap, pricy]) =>
    getFurnDef(cheap).price < getFurnDef(pricy).price && attrSum(cheap) <= attrSum(pricy)),
);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
