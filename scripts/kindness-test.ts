/**
 * 心意互動 + 繳租處置成就(玩家目標批第 2 波):
 * 送宵夜/塞紙條/介紹案子的效果與扣款、每人每日一次、介紹案子僅限財務困難、
 * 累計 10 次 → 成就「暖心房東」、寬限/勾銷/催繳成就鉤子(走 decide → applyEffect)、
 * 存檔往返(lastCareDay/careGiven)。全程零 RNG,結果確定。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, decide, SAVE_KEY } = await import("../src/store");
const { KINDNESS_ACTS, giveKindness, caredToday, CARE_ACHIEVEMENT_AT } = await import("../src/sim/kindness");
const { triggerHardship, inHardship } = await import("../src/sim/economy");
const { gameDayIndex } = await import("../src/sim/gameState");
const { save } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const chen = state.runtimes["tenant_chen_engineer"];
const lin = state.runtimes["tenant_lin_asmr"];

// --- 1. 送宵夜:扣款 + 心情/好感 + 日誌 ---
{
  chen.tenant.stats.mood = 50;
  chen.tenant.stats.affinity = 50;
  const m0 = state.money;
  const res = giveKindness(chen.tenant.id, "snack");
  check("送宵夜成功", res.ok);
  check("扣款 $120 進帳目", state.money === m0 - KINDNESS_ACTS.snack.cost && state.ledger.some((t) => t.label.includes("送宵夜")));
  check("心情 +6 / 好感 +4", chen.tenant.stats.mood === 56 && chen.tenant.stats.affinity === 54);
  check("🍜 日誌進 Feed(也是隔日 AI 素材)", chen.log.some((e) => e.text.startsWith("🍜")));
  check("記入當日心意 + 計數", caredToday(chen) && state.careGiven === 1);
}

// --- 2. 每人每日一次 ---
{
  const res = giveKindness(chen.tenant.id, "note");
  check("同日第二次 → 擋下", !res.ok && (res.reason ?? "").includes("明天"));
  check("擋下時不計數", state.careGiven === 1);
}

// --- 3. 塞紙條(免費):壓力− / 好感+ ---
{
  lin.tenant.stats.stress = 60;
  lin.tenant.stats.affinity = 50;
  const m0 = state.money;
  const res = giveKindness(lin.tenant.id, "note");
  check("塞紙條成功且免費", res.ok && state.money === m0);
  check("壓力 −5 / 好感 +2", lin.tenant.stats.stress === 55 && lin.tenant.stats.affinity === 52);
  check("📝 日誌進 Feed", lin.log.some((e) => e.text.startsWith("📝")));
}

// --- 4. 介紹案子:僅限財務困難;結束困難 + 錢包頭款 + 感激記憶 ---
{
  lin.lastCareDay = -99; // 重置每日限制,專測 referral 規則
  const res1 = giveKindness(lin.tenant.id, "referral");
  check("沒困難 → 介紹案子擋下", !res1.ok);
  triggerHardship(lin, 6);
  lin.wallet = 100;
  const w0 = lin.wallet;
  const res2 = giveKindness(lin.tenant.id, "referral");
  check("困難中 → 介紹案子成功", res2.ok);
  check("財務困難提早結束", !inHardship(lin));
  check("案子頭款進錢包(半個月租)", lin.wallet === w0 + Math.round(lin.tenant.finance.monthlyRent * 0.5));
  check("拮据記憶翻頁 → 換感激記憶", !lin.tenant.memoryTags.some((m) => m.label === "[手頭拮据]") && lin.tenant.memoryTags.some((m) => m.label === "[房東拉了一把]"));
  check("💼 major 日誌 + 通知", lin.log.some((e) => e.text.startsWith("💼")) && state.noticeLog.some((n) => n.text.includes("介紹的案子")));
}

// --- 5. 金錢不足擋下 ---
{
  chen.lastCareDay = -99;
  const saved = state.money;
  state.money = 10;
  const res = giveKindness(chen.tenant.id, "snack");
  check("金錢不足 → 擋下且不記當日", !res.ok && !caredToday(chen));
  state.money = saved;
}

// --- 6. 累計 10 次 → 成就「暖心房東」 ---
{
  while (state.careGiven < CARE_ACHIEVEMENT_AT) {
    chen.lastCareDay = -99;
    giveKindness(chen.tenant.id, "note");
  }
  check("累計 10 次 → care_10 解鎖", state.achievements.includes("care_10"));
}

// --- 7. 繳租處置成就(走 decide → applyEffect 的 rentAction 鉤子) ---
{
  const mkPlea = (choiceId: string, action: string) => ({
    id: "rent_plea", title: "繳不出房租", description: "測試",
    choices: [{ id: choiceId, label: "測試", effect: { rentAction: action } }],
  });
  lin.arrears = 300;
  lin.pendingEvent = mkPlea("grace", "grace") as any;
  decide(lin.tenant.id, "grace", "寬限幾天");
  check("寬限 → 成就「寬限之恩」", state.achievements.includes("grace_giver"));

  lin.arrears = 300;
  lin.pendingEvent = mkPlea("forgive", "forgive") as any;
  decide(lin.tenant.id, "forgive", "一筆勾銷");
  check("勾銷 → 成就「佛心房東」", state.achievements.includes("debt_forgiver"));

  lin.arrears = 300;
  lin.wallet = 500;
  lin.hardshipUntilDay = gameDayIndex() + 3; // 落難中催繳 → 隱藏成就
  lin.pendingEvent = mkPlea("collect", "collect") as any;
  decide(lin.tenant.id, "collect", "現在就催繳");
  check("催繳落難租客 → 隱藏成就「鐵面房東」", state.achievements.includes("hard_collector"));
  lin.hardshipUntilDay = -99;
}

// --- 8. 存檔往返 ---
{
  save();
  const s = JSON.parse(mem[SAVE_KEY]);
  check("存檔含 careGiven 與 lastCareDay", s.careGiven === state.careGiven && typeof s.runtimes["tenant_chen_engineer"].lastCareDay === "number");
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
