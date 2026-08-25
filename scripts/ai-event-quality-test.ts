/** AI 房東抉擇品質回歸：鎖住玩家截圖中的簡體、驅逐、收養租客與掛錯人物案例。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { sanitizeAiEvent } = await import("../src/sim/events");
const { decide, state } = await import("../src/store");
const { compatiblePendingEvent, load, save, SAVE_KEY } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const owner = "陳家豪";
const roster = { 邱柏翰: "tenant_chiu", 林小婕: "tenant_lin" };

const screenshotFixture = {
  title: "保护橘子",
  description: "橘子对邱柏翰产生了依恋,可能影响其生存安全",
  choices: [
    { label: "收养邱柏翰", hint: "保护橘子", effect: { mood: 5 } },
    { label: "驱逐邱柏翰", hint: "保护橘子", effect: { evict: true } },
    { label: "继续加班", hint: "工作狂模式", effect: { stress: 5 } },
  ],
};
check("截圖案例：整個怪異事件被拒絕", sanitizeAiEvent(screenshotFixture, roster, owner) === null);

const traditional = sanitizeAiEvent({
  title: "邻居来敲门",
  description: "林小婕对陈家豪说,保护猫咪也要顾虑邻居。",
  with: "林小婕",
  choices: [
    { label: "答应沟通", hint: "让他们把话说开", effect: { memory: { label: "[学会沟通]", hint: "关系恢复" } } },
    { label: "暂时拒绝", hint: "之后再问", effect: {} },
  ],
}, roster, owner);
check("事件四類文案：簡體統一轉繁體", !!traditional
  && traditional.title === "鄰居來敲門"
  && traditional.description.includes("林小婕對陳家豪說")
  && traditional.choices[0].label === "答應溝通"
  && traditional.choices[0].hint === "讓他們把話說開",
  JSON.stringify(traditional));
check("事件 effect 記憶文案也走相同語言閘門", traditional?.choices[0].effect.memory?.label === "[學會溝通]" && traditional?.choices[0].effect.memory?.hint === "關係恢復");

const unsafeMemory = sanitizeAiEvent({
  title: "租約討論", description: "陳家豪想聽聽房東的意見。",
  choices: [
    { label: "先答應", hint: "觀察後續", effect: { memory: { label: "[房東承諾]", hint: "之後驅逐邱柏翰" } } },
    { label: "先拒絕", hint: "保持距離", effect: {} },
  ],
}, roster, owner);
check("effect 記憶：禁用語意與錯置姓名同樣拒絕整個事件", unsafeMemory === null);

const strayTenant = sanitizeAiEvent({
  title: "工作上的煩惱",
  description: "邱柏翰突然跑來要求林小婕替他處理工作。",
  with: "林小婕",
  choices: [
    { label: "請他們談談", hint: "把問題說清楚", effect: {} },
    { label: "先不介入", hint: "觀察後續", effect: {} },
  ],
}, roster, owner);
check("姓名一致性：出現非 owner／with 的在住租客就拒絕", strayTenant === null);

const validCrossTenant = sanitizeAiEvent({
  title: "深夜談心",
  description: "陳家豪想和林小婕談談最近的誤會。",
  with: "林小婕",
  choices: [
    { label: "借出交誼廳", hint: "讓兩人好好聊", effect: { rel: { delta: 4 } } },
    { label: "不要介入", hint: "讓他們自己決定", effect: {} },
  ],
}, roster, owner);
check("姓名一致性：owner + with 的正常跨租客事件保留", validCrossTenant?.withId === "tenant_lin");

const tenantCompensation = sanitizeAiEvent({
  title: "物品損壞",
  description: "房東從監視器看到陳家豪弄壞林小婕的音響，需要決定如何協調。",
  with: "林小婕",
  choices: [
    { label: "要求陳家豪賠償", hint: "由租客自行負擔", effect: { money: -1200, rel: { delta: -2 } } },
    { label: "請雙方先協商", hint: "房東暫不代墊", effect: {} },
  ],
}, roster, owner);
check("租客間賠償：舊 raw money 不得扣到房東帳本", tenantCompensation?.choices[0].effect.money === 0,
  JSON.stringify(tenantCompensation));
if (tenantCompensation) {
  const a = state.runtimes.tenant_chen_engineer;
  const b = state.runtimes.tenant_lin_asmr;
  const before = { money: state.money, ledger: state.ledger.length, aWallet: a.wallet, bWallet: b.wallet };
  a.pendingEvent = tenantCompensation;
  decide(a.tenant.id, "ai0", tenantCompensation.choices[0].label);
  check("租客間賠償端到端：房東帳本與雙方租客錢包都不變", state.money === before.money
    && state.ledger.length === before.ledger && a.wallet === before.aWallet && b.wallet === before.bWallet,
    JSON.stringify({ before, after: { money: state.money, ledger: state.ledger.length, aWallet: a.wallet, bWallet: b.wallet } }));
}

const landlordAdvance = sanitizeAiEvent({
  title: "漏水搶修",
  description: "房東接到陳家豪與林小婕通報公共管線漏水，需要決定是否先墊付搶修費。",
  with: "林小婕",
  choices: [
    { label: "由房東先行墊付", hint: "立即安排搶修", effect: { landlordMoney: -1200 } },
    { label: "先向廠商詢價", hint: "暫不動用房東資金", effect: {} },
  ],
}, roster, owner);
check("房東明確支出：landlordMoney 才能異動內部 money", landlordAdvance?.choices[0].effect.money === -1200,
  JSON.stringify(landlordAdvance));
if (landlordAdvance) {
  const a = state.runtimes.tenant_chen_engineer;
  const b = state.runtimes.tenant_lin_asmr;
  const before = { money: state.money, ledger: state.ledger.length, aWallet: a.wallet, bWallet: b.wallet };
  a.pendingEvent = landlordAdvance;
  decide(a.tenant.id, "ai0", landlordAdvance.choices[0].label);
  const txn = state.ledger[state.ledger.length - 1];
  check("房東墊付端到端：只扣房東一次並留下 event 帳務，租客錢包不變", state.money === before.money - 1200
    && state.ledger.length === before.ledger + 1 && txn?.category === "event" && txn.amount === -1200
    && a.wallet === before.aWallet && b.wallet === before.bWallet,
    JSON.stringify({ before, after: { money: state.money, ledger: state.ledger.length, txn, aWallet: a.wallet, bWallet: b.wallet } }));
}

const ambiguousPayer = sanitizeAiEvent({
  title: "物品賠償",
  description: "房東看到陳家豪弄壞林小婕的物品，需要決定如何處理。",
  with: "林小婕",
  choices: [
    { label: "賠錢", hint: "把損失補回來", effect: { landlordMoney: -1200 } },
    { label: "不賠錢", hint: "暫時不處理", effect: {} },
  ],
}, roster, owner);
check("含糊付款人：landlordMoney 文案未明寫房東就拒絕整個事件", ambiguousPayer === null);

const tenantViewPayment = sanitizeAiEvent({
  title: "物品賠償",
  description: "房東看到陳家豪弄壞林小婕的物品，需要決定如何協調。",
  with: "林小婕",
  choices: [
    { label: "賠錢", hint: "把損失補回來", effect: { money: -1200 } },
    { label: "不賠錢", hint: "暫時不處理", effect: {} },
  ],
}, roster, owner);
check("租客視角按鈕：即使沒有有效 landlordMoney，賠錢／不賠錢仍拒收", tenantViewPayment === null);

check("存檔相容：舊 AI 待決事件淘汰，新契約與規則事件保留",
  compatiblePendingEvent({ ai: true, id: "legacy_ai" }) === null
  && compatiblePendingEvent(landlordAdvance) === landlordAdvance
  && compatiblePendingEvent({ id: "sick" })?.id === "sick");

if (landlordAdvance) {
  const tenantId = "tenant_chen_engineer";
  save();
  const legacySave = JSON.parse(mem[SAVE_KEY]);
  legacySave.runtimes[tenantId].pendingEvent = { ...landlordAdvance, aiSchema: undefined };
  mem[SAVE_KEY] = JSON.stringify(legacySave);
  const oldDropped = load() && state.runtimes[tenantId].pendingEvent === null;

  state.runtimes[tenantId].pendingEvent = landlordAdvance;
  save();
  state.runtimes[tenantId].pendingEvent = null;
  const currentRestored = load() && state.runtimes[tenantId].pendingEvent?.aiSchema === 2;
  check("存檔載入端到端：舊 AI pending 淘汰，aiSchema 2 pending 跨 session 保留", oldDropped && currentRestored);
}

const petAdoption = sanitizeAiEvent({
  title: "浪貓的去留",
  description: "陳家豪想正式收養門口那隻橘貓。",
  choices: [
    { label: "答應養貓", hint: "房裡會多一位小成員", effect: { directive: { id: "adopt_cat", days: 3 } } },
    { label: "暫時拒絕", hint: "請他再想清楚", effect: {} },
  ],
}, roster, owner);
check("收養寵物仍合法，不會被收養租客規則誤殺", petAdoption !== null);

for (const word of ["驅逐", "趕走", "退租"]) {
  const ev = sanitizeAiEvent({
    title: "租約爭議", description: "兩人對處理方式沒有共識。",
    choices: [
      { label: `${word}租客`, hint: "立即處理", effect: {} },
      { label: "再談談", hint: "找別的方法", effect: {} },
    ],
  }, roster, owner);
  check(`禁用語意：${word} 出現在文案就拒絕整個事件`, ev === null);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
