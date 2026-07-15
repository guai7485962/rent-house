/** 房東主動請離：協議補償、強制後果、同居接手與完整 moveOut 清理。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const {
  state,
  getApplicants,
  moveIn,
  previewEviction,
  evictTenant,
} = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = state.occupancy.r301;
const B = state.occupancy.r302;
const a = state.runtimes[A];
const b = state.runtimes[B];

check("不存在的房客不能建立請離預覽", previewEviction("missing", "agreement") === null);
state.money = 0;
const poor = previewEviction(A, "agreement")!;
check("協議解約費用是一個月租金", poor.cost === a.tenant.finance.monthlyRent);
check("現金不足會在預覽標示", !poor.canAfford);
const denied = evictTenant(A, "agreement");
check("現金不足不會把房客移除", !denied.ok && !!state.runtimes[A] && state.money === 0);

// 招入第三位，驗證協議解約只扣補償、不牽連其他住戶。
state.money = 100000;
const applicant = getApplicants("r303")[0];
moveIn("r303", applicant);
const C = applicant.id;
const c = state.runtimes[C];
const agreementCost = c.tenant.finance.monthlyRent;
const beforeAgreementMoney = state.money;
const beforeBystander = {
  affinity: b.tenant.stats.affinity,
  satisfaction: b.satisfaction,
  mood: b.tenant.stats.mood,
  stress: b.tenant.stats.stress,
};
const agreed = evictTenant(C, "agreement");
check("協議解約成功移除住戶並空出房間", agreed.ok && !state.runtimes[C] && !state.occupancy.r303);
check("協議解約正確扣一個月搬遷補償", state.money === beforeAgreementMoney - agreementCost);
check("搬遷補償有進入收支帳", state.ledger.some((tx) => tx.label.includes(`${applicant.name} 協議解約搬遷補償`) && tx.amount === -agreementCost));
check("協議解約會寫入歷任房客原因", state.alumni[0]?.name === applicant.name && state.alumni[0]?.reason.includes("協議解約"));
check("協議解約不會傷害旁觀住戶", b.tenant.stats.affinity === beforeBystander.affinity
  && b.satisfaction === beforeBystander.satisfaction
  && b.tenant.stats.mood === beforeBystander.mood
  && b.tenant.stats.stress === beforeBystander.stress);

// 讓 B 與 A 同居；強制請離承租人 A 後，B 應接手房間並承受全樓信任後果。
delete state.occupancy.r302;
state.cohabits[B] = "r301";
b.roomNo = "301";
const guestPreview = previewEviction(B, "agreement")!;
check("同居者也能被單獨請離", !guestPreview.isLeaseHolder && guestPreview.cost === b.tenant.finance.monthlyRent);
const forcedPreview = previewEviction(A, "forced")!;
check("強制請離免費且預告同居者接手", forcedPreview.cost === 0 && forcedPreview.handoffName === b.tenant.name);

state.activeId = A;
state.money = 54321;
b.tenant.stats.affinity = 70;
b.satisfaction = 70;
b.tenant.stats.mood = 70;
b.tenant.stats.stress = 30;
b.unhappyHours = 0;
const forcedMoney = state.money;
const forced = evictTenant(A, "forced");
check("強制請離成功且不收費", forced.ok && state.money === forcedMoney && !state.runtimes[A]);
check("同居者會接手原承租房與房號", state.occupancy.r301 === B && !state.cohabits[B] && b.roomNo === "301");
check("被請離者是目前角色時會切到仍在住戶", state.activeId === B);
check("全體住戶對房東的好感與滿意度下降", b.tenant.stats.affinity === 62 && b.satisfaction === 60);
check("強制請離也會影響心情、壓力與退租不安", b.tenant.stats.mood === 66 && b.tenant.stats.stress === 34 && b.unhappyHours === 12);
check("留下住戶會記得強制請離事件", b.tenant.memoryTags.some((m) => m.label.includes(`${a.tenant.name}被強制請離`)));
check("強制請離會留下全樓重要日誌", b.log.some((e) => e.importance === "major" && e.text.includes("強制請")));
check("強制請離原因會進歷任房客名冊", state.alumni[0]?.name === a.tenant.name && state.alumni[0]?.reason.includes("強制請離"));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
