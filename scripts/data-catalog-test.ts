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

// --- 3. 事件連鎖(rollEvent 層):requiresFlag 解鎖 + consumeFlag ---
check("沒旗標 → sick_aftermath 不觸發", rollEvent({ ...base, wellbeing: 70 }) === null);
const after = rollEvent({ ...base, wellbeing: 70, flags: ["病中沒人管"] });
check("有旗標且康復 → sick_aftermath 觸發", after?.id === "sick_aftermath");
check("觸發時標記 consumeFlag", after?.consumeFlag === "病中沒人管");
check("旗標在但還沒康復 → 不觸發", rollEvent({ ...base, wellbeing: 50, flags: ["病中沒人管"] }) === null);

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

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
