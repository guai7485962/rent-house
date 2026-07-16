/**
 * 租客錢包與繳租戲劇(路線圖中型深化第 3 項):
 * 薪水/開銷/上限、財務困難收入中斷、錢包見底 → 欠租、求情事件三選
 * (寬限→補繳感激/催繳/一筆勾銷)、AI context 財務行、存檔往返、moveOut 欠款通知。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, decide, SAVE_KEY } = await import("../src/store");
const eco = await import("../src/sim/economy");
const { gameDayIndex } = await import("../src/sim/gameState");
const { buildNarrateCtx } = await import("../src/sim/narration");
const { save } = await import("../src/sim/persistence");
const { moveOut } = await import("../src/sim/tenancy");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const lin = state.runtimes["tenant_lin_asmr"];
const day = () => gameDayIndex();
const daily = Math.round(lin.tenant.finance.monthlyRent / 30);
const willing = () => {
  const f = lin.tenant.finance;
  const factor = Math.min(100, Math.max(0, f.paymentReliability + (lin.tenant.stats.affinity - 50) * 0.3 + (lin.satisfaction - 50) * 0.2)) / 100;
  return Math.round(daily * factor);
};
// 全員擋掉財務困難擲骰(冷卻),讓測試流程完全可控
const blockHardshipRolls = () => {
  for (const rt of Object.values(state.runtimes)) rt.lastHardshipDay = day() + 99;
};
blockHardshipRolls();

// --- 1. 初始化 ---
check("ensureWallets 依月租初始化錢包", lin.wallet === Math.round(lin.tenant.finance.monthlyRent * eco.WALLET_INIT_MONTHS) && lin.arrears === 0);

// --- 2. 正常日:薪水入帳、從錢包繳租、房東收到 ---
{
  const w0 = lin.wallet!;
  const m0 = state.money;
  const expectPaid = willing();
  eco.collectRent();
  const income = daily * eco.WALLET_INCOME_FACTOR;
  const living = Math.round(daily * eco.WALLET_LIVING_FACTOR);
  check("錢包流水:+薪水 −開銷 −房租", lin.wallet === w0 + income - living - expectPaid, `wallet=${lin.wallet}`);
  check("房東收到租金入帳", state.money > m0);
  check("錢包充足 → 不產生欠租", lin.arrears === 0);
}

// --- 3. 錢包上限 ---
{
  lin.wallet = 999999;
  eco.collectRent();
  check("錢包夾在 3 個月租金上限內", lin.wallet! <= lin.tenant.finance.monthlyRent * eco.WALLET_CAP_MONTHS);
}

// --- 4. 財務困難:收入中斷 → 錢包見底 → 欠租 ---
{
  eco.triggerHardship(lin, 6);
  check("困難狀態:inHardship + 記憶 + 日誌", eco.inHardship(lin) && lin.tenant.memoryTags.some((m) => m.label === "[手頭拮据]") && lin.log.some((e) => e.text.startsWith("💼")));
  lin.wallet = 0;
  const expectShort = willing();
  eco.collectRent();
  check("錢包見底:繳不出的部分記成欠租", lin.arrears === expectShort, `arrears=${lin.arrears}`);
  check("欠租日誌(💸 錢包見底)", lin.log.some((e) => e.text.includes("錢包見底")));
  check("AI context 財務行:欠租", buildNarrateCtx(lin, "d").finance?.startsWith("欠租 $") === true);
}

// --- 5. 求情事件掛起 ---
{
  lin.arrears = daily * eco.PLEA_ARREARS_DAILY + 10;
  lin.lastRentPleaDay = -99;
  lin.pendingEvent = null;
  lin.wallet = 0;
  eco.collectRent(); // 困難中收入 0,錢包不會超過安全水位 → 不自動補繳 → 掛求情
  check("欠滿門檻 → 掛起 rent_plea 事件", lin.pendingEvent?.id === "rent_plea");
  check("求情事件有三個選項", lin.pendingEvent?.choices.length === 3);
  const arrearsAtPlea = lin.arrears!;
  eco.collectRent();
  check("已有待決事件 → 不重複掛(欠租續累)", lin.pendingEvent?.id === "rent_plea" && lin.arrears! >= arrearsAtPlea);
}

// --- 6. 寬限 → 回穩自動補繳 → 感激 ---
{
  decide(lin.tenant.id, "grace", "寬限幾天");
  check("寬限:rentGraceUntilDay 設定", lin.rentGraceUntilDay === day() + eco.GRACE_DAYS);
  check("AI context 標示已寬限", buildNarrateCtx(lin, "d").finance?.includes("寬限") === true);
  // 回穩:困難解除 + 給足錢包 → 下次收租自動補清
  lin.hardshipUntilDay = -99;
  lin.wallet = lin.tenant.finance.monthlyRent * 2;
  const affinity0 = lin.tenant.stats.affinity;
  const m0 = state.money;
  const owed = lin.arrears!;
  eco.collectRent();
  check("回穩自動補繳:欠租歸零、房東收到欠款", lin.arrears === 0 && state.money >= m0 + owed);
  check("曾寬限 → 感激記憶 + 好感上升", lin.tenant.memoryTags.some((m) => m.label === "[房東寬限的恩情]") && lin.tenant.stats.affinity > affinity0);
  check("寬限旗標已清", lin.rentGraceUntilDay === -99);
}

// --- 7. 催繳:立即把錢包裡的錢拿來抵 ---
{
  eco.triggerHardship(lin, 4); // 擋住收入,情境穩定
  lin.arrears = daily * eco.PLEA_ARREARS_DAILY;
  lin.wallet = 0;
  lin.lastRentPleaDay = -99;
  lin.pendingEvent = null;
  eco.collectRent();
  check("再次掛起求情事件", lin.pendingEvent?.id === "rent_plea");
  lin.wallet = 200; // 決定催繳當下他錢包裡剛好還有一點錢
  const m0 = state.money;
  const arrears0 = lin.arrears!;
  const wallet0 = lin.wallet!;
  const expectPay = Math.min(wallet0, arrears0);
  decide(lin.tenant.id, "collect", "現在就催繳");
  check("催繳:錢包被拿來抵欠款", state.money === m0 + expectPay && lin.arrears === arrears0 - expectPay && lin.wallet === wallet0 - expectPay);
  check("催繳留下難堪記憶", lin.tenant.memoryTags.some((m) => m.label === "[被催繳的難堪]"));
}

// --- 8. 一筆勾銷 ---
{
  lin.arrears = daily * eco.PLEA_ARREARS_DAILY;
  lin.lastRentPleaDay = -99;
  lin.pendingEvent = null;
  lin.wallet = 0;
  eco.collectRent();
  const m0 = state.money;
  decide(lin.tenant.id, "forgive", "這筆就算了");
  check("勾銷:欠租歸零、房東沒收到錢", lin.arrears === 0 && state.money <= m0);
  check("勾銷留下感激記憶", lin.tenant.memoryTags.some((m) => m.label === "[房東免了欠租]"));
}

// --- 9. 存檔往返 ---
{
  lin.wallet = 4321;
  lin.arrears = 87;
  lin.hardshipUntilDay = day() + 2;
  save();
  const saved = JSON.parse(mem[SAVE_KEY]).runtimes[lin.tenant.id];
  check("錢包欄位有入存檔", saved.wallet === 4321 && saved.arrears === 87 && saved.hardshipUntilDay === day() + 2);
}

// --- 10. 帶欠款搬走 → 通知 ---
{
  lin.arrears = 500;
  moveOut(lin.tenant.id, "測試搬離");
  const noticed = state.noticeLog.some((n) => n.text.includes("未繳欠租搬走"));
  check("moveOut:欠款收不回的通知", noticed && !state.runtimes[lin.tenant.id]);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
