/**
 * 互動框架(§10-1)驗證:
 * - canInteract 門檻矩陣:關係階層 / 🔞開關 / 雙方成年 / 私密 / 時段(含跨夜)
 * - 整合:同居情侶深夜觸發親密互動(遮蔽式)→ 效果/記憶/冷卻;開關關閉與未成年一律擋
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { canInteract, interactionsPass, INTERACTIONS } = await import("../src/sim/interactions");
const { relationships, pairKey } = await import("../src/sim/social");
const { state } = await import("../src/store");
import type { Tenant } from "../src/types";
import type { InteractCtx } from "../src/sim/interactions";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const T = (id: string, isAdult = true): Tenant =>
  ({ id, name: id, isAdult, gender: "male", attractedTo: ["female"], coreTags: [], memoryTags: [] }) as unknown as Tenant;
const TF = (id: string, isAdult = true): Tenant =>
  ({ id, name: id, isAdult, gender: "female", attractedTo: ["male"], coreTags: [], memoryTags: [] }) as unknown as Tenant;

const intimacy = INTERACTIONS.find((d) => d.id === "night_intimacy")!;
const cuddle = INTERACTIONS.find((d) => d.id === "cuddle_tv")!;
const lazy = INTERACTIONS.find((d) => d.id === "lazy_morning")!;
const earbuds = INTERACTIONS.find((d) => d.id === "share_earbuds")!;

// furniture = 地點家具解鎖(§10-6):預設把會用到的都放進來,個別案例再拿掉驗門檻
const baseCtx: InteractCtx = { hour: 23, thirdPresent: false, adultMode: true, cohabiting: true, furniture: new Set(["double_bed", "tv_console", "shared_sofa", "lounge_tv"]) };
const a = T("ia");
const b = TF("ib");

// --- canInteract 矩陣 ---
relationships[pairKey("ia", "ib")] = { value: 90, romantic: false, cohabitOffered: false };
check("非情侶 → 親密互動擋(關係 90 也不行)", !canInteract(intimacy, a, b, baseCtx));
check("非情侶 → 依偎看劇也擋(couple 級)", !canInteract(cuddle, a, b, { ...baseCtx, hour: 20 }));

relationships[pairKey("ia", "ib")] = { value: 90, romantic: true, cohabitOffered: true };
check("情侶+🔞開+深夜 → 親密互動可行", canInteract(intimacy, a, b, baseCtx));
check("沒雙人床 → 親熱擋(家具投資解鎖)", !canInteract(intimacy, a, b, { ...baseCtx, furniture: new Set() }));
check("🔞關 → 擋", !canInteract(intimacy, a, b, { ...baseCtx, adultMode: false }));
check("有第三人 → 私密互動擋", !canInteract(intimacy, a, b, { ...baseCtx, thirdPresent: true }));
check("白天(14 時)→ 時段擋", !canInteract(intimacy, a, b, { ...baseCtx, hour: 14 }));
check("跨夜時段:凌晨 1 時可行", canInteract(intimacy, a, b, { ...baseCtx, hour: 1 }));
check("跨夜時段:凌晨 2 時擋", !canInteract(intimacy, a, b, { ...baseCtx, hour: 2 }));

const minorB = TF("ib", false);
check("一方未成年 → 🔞開了也擋", !canInteract(intimacy, a, minorB, baseCtx));
check("未成年連 couple 級普通互動也到不了(canRomance 擋在成為情侶前)", !canInteract(intimacy, minorB, a, baseCtx));

check("賴床需同居:非同居擋", !canInteract(lazy, a, b, { ...baseCtx, hour: 8, cohabiting: false }));
check("賴床:同居+早上可行", canInteract(lazy, a, b, { ...baseCtx, hour: 8 }));

// crush(曖昧)門檻
relationships[pairKey("ia", "ib")] = { value: 80, romantic: false, cohabitOffered: false };
check("曖昧(80+互有好感、非情侶)→ 共用耳機可行", canInteract(earbuds, a, b, { ...baseCtx, hour: 20 }));
check("交誼廳沒沙發 → 共用耳機擋(家具投資解鎖)", !canInteract(earbuds, a, b, { ...baseCtx, hour: 20, furniture: new Set() }));
relationships[pairKey("ia", "ib")] = { value: 60, romantic: false, cohabitOffered: false };
check("關係 60 → 曖昧互動擋", !canInteract(earbuds, a, b, { ...baseCtx, hour: 20 }));
const bIncompatible = { ...TF("ib"), attractedTo: ["female"] } as unknown as Tenant;
relationships[pairKey("ia", "ib")] = { value: 90, romantic: false, cohabitOffered: false };
check("取向不合 → 曖昧互動擋(90 也不行)", !canInteract(earbuds, a, bIncompatible, { ...baseCtx, hour: 20 }));

// --- 整合:陳家豪 × 林小婕 同居於 r301 ---
const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
A.tenant.gender = "male"; A.tenant.attractedTo = ["female"];
B.tenant.gender = "female"; B.tenant.attractedTo = ["male"];
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 95, romantic: true, cohabitOffered: true };
delete state.occupancy.r302;
state.cohabits[B.tenant.id] = "r301";
A.tenant.visualState = "idle"; B.tenant.visualState = "idle";
A.pendingEvent = null; B.pendingEvent = null;
state.gameMs = new Date("2026-07-06T23:30:00+08:00").getTime(); // 深夜 23 時

const hasAdultTrace = () =>
  A.tenant.memoryTags.some((m) => m.label === "[甜蜜的夜晚]" || m.label === "[臉紅的祕密]") ||
  A.log.some((e) => e.text.includes("請勿打擾") || e.text.includes("水聲"));

// 🔞 關閉 → 100 次都不該出現
state.adultMode = false;
for (let i = 0; i < 100; i++) interactionsPass();
check("整合:🔞關閉 → 親密互動從不觸發", !hasAdultTrace());

// 🔞 開啟 → 應能觸發,且雙方數值/記憶/冷卻正確
state.adultMode = true;
const moodBefore = A.tenant.stats.mood;
let triggered = false;
for (let i = 0; i < 200 && !triggered; i++) {
  interactionsPass();
  triggered = hasAdultTrace();
}
check("整合:🔞開啟 → 深夜親密互動觸發(遮蔽式文字)", triggered);
check("整合:雙方都拿到記憶", B.tenant.memoryTags.some((m) => m.label === "[甜蜜的夜晚]" || m.label === "[臉紅的祕密]") === triggered);
check("整合:心情上升", A.tenant.stats.mood >= moodBefore);
const cdCount = Object.keys(state.interactionCooldowns).length;
check("整合:冷卻已記錄", cdCount >= 1);
const intimacyLogs = A.log.filter((e) => e.text.includes("請勿打擾")).length;
const bathLogs = A.log.filter((e) => e.text.includes("水聲")).length;
check("整合:冷卻期間內不重複(各互動 ≤1 次)", intimacyLogs <= 1 && bathLogs <= 1, `intimacy=${intimacyLogs} bath=${bathLogs}`);

// 未成年防線(假想情境):標成未成年後不再觸發
for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
A.tenant.memoryTags.splice(0);
B.tenant.memoryTags.splice(0);
A.log.splice(0); B.log.splice(0);
B.tenant.isAdult = false;
for (let i = 0; i < 100; i++) interactionsPass();
check("整合:一方 isAdult=false → 🔞開著也全擋", !hasAdultTrace());

// --- 整合:交誼廳朋友互動(深夜談心 / 開黑)---
B.tenant.isAdult = true;
delete state.cohabits[B.tenant.id];
state.occupancy.r302 = B.tenant.id;
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
A.log.splice(0); B.log.splice(0);
A.inLounge = true; B.inLounge = true;
state.gameMs = new Date("2026-07-06T22:30:00+08:00").getTime(); // 22 時(談心/開黑時段)
let loungeHit = false;
for (let i = 0; i < 200 && !loungeHit; i++) {
  interactionsPass();
  loungeHit = A.log.some((e) => e.text.includes("聊到深夜") || e.text.includes("還好嗎") || e.text.includes("開黑"));
}
check("整合:交誼廳朋友(60)觸發談心/開黑", loungeHit);
check("整合:朋友階段不會出現曖昧/親密內容", !A.log.some((e) => e.text.includes("耳機") || e.text.includes("請勿打擾") || e.text.includes("水聲")));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
