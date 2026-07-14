/**
 * AI 提議互動(§10-3)驗證:
 * - sanitizeAiEvent:interaction 只在事件有 with(對得上 roster)時保留、截斷
 * - forceInteraction 門檻:未知 id/外出/冷戰擋;一般互動放寬階層/時段;🔞 走完整 canInteract(AI 不可越權)
 * - decide() 整合:玩家拍板 AI 事件選項 → 互動真的演出來(雙方日誌+關係+冷卻)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32),讓機率型整合測試在任何環境(含 CI)可重現
let __seed = 20260710;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { forceInteraction } = await import("../src/sim/interactions");
const { sanitizeAiEvent } = await import("../src/sim/events");
const { relationships, pairKey, getRel } = await import("../src/sim/social");
const { startFeud, endFeud } = await import("../src/sim/conflicts");
const { decide } = await import("../src/sim/tenancy");
const { addPlacement } = await import("../src/sim/placements");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
A.tenant.gender = "male"; A.tenant.attractedTo = ["female"];
B.tenant.gender = "female"; B.tenant.attractedTo = ["male"];
A.tenant.visualState = "idle"; B.tenant.visualState = "idle";
const roster = { [B.tenant.name]: B.tenant.id };

// --- sanitizeAiEvent ---
const mk = (withName: string | undefined, interaction: unknown) =>
  sanitizeAiEvent({
    title: "測試事件", description: "d", with: withName,
    choices: [
      { label: "選我", hint: "h", effect: { mood: 1, interaction } },
      { label: "不要", hint: "h", effect: {} },
    ],
  }, roster);

let ev = mk(B.tenant.name, "deep_talk");
check("有 with(對得上 roster)→ interaction 保留", ev?.choices[0].effect.interaction === "deep_talk");
ev = mk(undefined, "deep_talk");
check("沒有 with → interaction 丟棄", ev?.choices[0].effect.interaction === undefined);
ev = mk("不存在的人", "deep_talk");
check("with 對不上 roster → interaction 丟棄", ev?.choices[0].effect.interaction === undefined);
ev = mk(B.tenant.name, "x".repeat(99));
check("interaction 截斷到 24 字", (ev?.choices[0].effect.interaction ?? "").length === 24);
ev = mk(B.tenant.name, 123);
check("interaction 非字串 → 丟棄", ev?.choices[0].effect.interaction === undefined);

// --- forceInteraction 門檻 ---
state.gameMs = new Date("2026-07-06T03:30:00+08:00").getTime(); // 凌晨 3 時(cuddle_tv 時段外)
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 20, romantic: false, cohabitOffered: false };
check("未知 id → 擋", !forceInteraction(A.tenant.id, B.tenant.id, "no_such_thing"));
const logsBeforeCuddle = { a: A.log.length, b: B.log.length };
check("一般互動:放寬階層/時段 → 低關係+時段外照樣演", forceInteraction(A.tenant.id, B.tenant.id, "cuddle_tv"));
check("互動有落地:雙方新增帶對方名字的日誌", A.log.slice(logsBeforeCuddle.a).some((e) => e.text.includes(B.tenant.name)) && B.log.slice(logsBeforeCuddle.b).some((e) => e.text.includes(A.tenant.name)));
check("互動有落地:冷卻記錄", Object.keys(state.interactionCooldowns).some((k) => k.endsWith("|cuddle_tv")));
check("互動有落地:關係加分", (getRel(A.tenant.id, B.tenant.id)?.value ?? 0) > 20);

B.tenant.visualState = "away";
check("一方外出 → 擋", !forceInteraction(A.tenant.id, B.tenant.id, "deep_talk"));
B.tenant.visualState = "idle";

startFeud(A, B, true);
check("冷戰中 → 擋", !forceInteraction(A.tenant.id, B.tenant.id, "deep_talk"));
endFeud(A.tenant.id, B.tenant.id, "expired");

// 🔞:完整 canInteract,AI 不可越權
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 95, romantic: true, cohabitOffered: true };
delete state.occupancy.r302;
state.cohabits[B.tenant.id] = "r301";
state.adultMode = false;
state.gameMs = new Date("2026-07-06T23:30:00+08:00").getTime();
check("🔞:成人模式關 → 擋", !forceInteraction(A.tenant.id, B.tenant.id, "night_intimacy"));
state.adultMode = true;
state.gameMs = new Date("2026-07-06T14:30:00+08:00").getTime();
check("🔞:時段外(14 時)→ 擋(不放寬)", !forceInteraction(A.tenant.id, B.tenant.id, "night_intimacy"));
state.gameMs = new Date("2026-07-06T23:30:00+08:00").getTime();
B.tenant.isAdult = false;
check("🔞:一方未成年 → 擋", !forceInteraction(A.tenant.id, B.tenant.id, "night_intimacy"));
B.tenant.isAdult = true;
for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
check("🔞:房裡只有單人床 → 擋(要買雙人床)", !forceInteraction(A.tenant.id, B.tenant.id, "night_intimacy"));
addPlacement({ defId: "double_bed", room: "r301", c: 4, r: 1 });
check("🔞:門檻全過(含雙人床)→ 可演(遮蔽式)", forceInteraction(A.tenant.id, B.tenant.id, "night_intimacy"));
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 80, romantic: false, cohabitOffered: false };
check("🔞:非情侶 → 擋(情侶門檻不放寬)", !forceInteraction(A.tenant.id, B.tenant.id, "bath_together"));

// --- decide() 整合 ---
A.log.splice(0); B.log.splice(0);
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 40, romantic: false, cohabitOffered: false };
const aiEv = sanitizeAiEvent({
  title: "和好的契機", description: "兩人最近有點僵。",
  with: B.tenant.name,
  choices: [
    { label: "撮合他們聊聊", hint: "深夜談心", effect: { mood: 2, rel: { delta: 5 }, interaction: "deep_talk" } },
    { label: "不插手", hint: "", effect: {} },
  ],
}, roster)!;
A.pendingEvent = aiEv;
decide(A.tenant.id, aiEv.choices[0].id, aiEv.choices[0].label);
check("decide 整合:互動演出(雙方新增帶對方名字的談心日誌)", A.log.some((e) => e.text.includes(B.tenant.name)) && B.log.some((e) => e.text.includes(A.tenant.name)));
check("decide 整合:事件本身的效果也套了(rel.delta+互動加分)", (getRel(A.tenant.id, B.tenant.id)?.value ?? 0) > 45);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
