/**
 * 三角關係(吃醋)批驗證(中控核可規格 triangle-jealousy-spec.md):
 * - unrequitedSuitors() 的唯一過濾條件是既有 canRomance()——未成年、已搬走租客結構性排除
 * - became_couple 觸發時 EncounterResult.rivals 的落選者效果只套用一次(數值/記憶/日誌/fx)
 * - 全程零新增 RNG(固定文案、不 pick())
 * - affairThird() 重構後既有劈腿抓包行為不變:交給 scripts/drama-test.ts、
 *   scripts/romance-integrity-test.ts 既有斷言把關(本檔不重複),兩檔本次改動後仍逐字通過。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

import type { Tenant } from "../src/types";
const { state, makeRuntime } = await import("../src/sim/gameState");
const {
  relationships,
  pairKey,
  getRel,
  unrequitedSuitors,
  removeTenantRelations,
} = await import("../src/sim/social");
const { socialPass } = await import("../src/sim/tick");
const { activeFx, clearFx } = await import("../src/floor/fx");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const mk = (id: string, name: string, gender: "male" | "female", isAdult = true): Tenant => ({
  id, name, gender, attractedTo: [gender === "male" ? "female" : "male"], isAdult,
  occupation: "", bio: "", coreTags: [], memoryTags: [],
  finance: { monthlyRent: 1000, paymentReliability: 80, monthsOverdue: 0 },
  stats: { mood: 60, stress: 40, wellbeing: 70, energy: 60, affinity: 50 },
  preferences: {}, visualState: "idle", recentSummary: "",
} as Tenant);

const clearRels = () => { for (const key of Object.keys(relationships)) delete relationships[key]; };
const getTenant = (id: string) => state.runtimes[id]?.tenant;

// ── 1) 未成年排除:三人情境(B 為目標,A 未成年,C 成年)──
{
  const A = mk("tri_minor_a", "未成年阿凱", "male", false);
  const B = mk("tri_minor_b", "小雨", "female", true);
  const C = mk("tri_minor_c", "阿宏", "male", true);
  for (const t of [A, B, C]) state.runtimes[t.id] = makeRuntime(t, "z", 70, []);
  clearRels();
  relationships[pairKey(A.id, B.id)] = { value: 90, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  relationships[pairKey(C.id, B.id)] = { value: 80, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  const suitors = unrequitedSuitors(B.id, getTenant, []);
  check("未成年 A 即使關係值 90 也不會出現在 B 的單戀者陣列", !suitors.includes(A.id), `suitors=${suitors}`);
  check("成年且取向相容的 C 正常出現,陣列長度為 1", suitors.length === 1 && suitors[0] === C.id, `suitors=${suitors}`);
}

// ── 2) 第三人必須是現任租客:已搬走(removeTenantRelations)的租客不會出現 ──
{
  const B = mk("tri_moved_b", "小雨2", "female");
  const C = mk("tri_moved_c", "阿宏2", "male"); // 稍後搬走
  for (const t of [B, C]) state.runtimes[t.id] = makeRuntime(t, "z", 70, []);
  clearRels();
  relationships[pairKey(C.id, B.id)] = { value: 88, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  check("搬走前 C 是 B 的單戀者", unrequitedSuitors(B.id, getTenant, []).includes(C.id));
  removeTenantRelations(C.id);
  check("removeTenantRelations 後 relationships 不再有 C 的任何邊", Object.keys(relationships).every((k) => !k.split("|").includes(C.id)));
  check("已搬走的 C 不會出現在單戀者陣列", !unrequitedSuitors(B.id, getTenant, []).includes(C.id));
  delete state.runtimes[C.id]; // 模擬搬走:agent 也不存在了
  check("agent 不存在時 getTenant 回傳 undefined,結構上也不可能混入", getTenant(C.id) === undefined);
}

// ── 3) 決定性驗證:unrequitedSuitors() 全程零新增 RNG ──
{
  const B = mk("tri_rng_b", "小雨3", "female");
  const A = mk("tri_rng_a", "阿凱3", "male");
  for (const t of [A, B]) state.runtimes[t.id] = makeRuntime(t, "z", 70, []);
  clearRels();
  relationships[pairKey(A.id, B.id)] = { value: 80, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  let calls = 0;
  const originalRandom = Math.random;
  Math.random = () => { calls++; return originalRandom(); };
  for (let i = 0; i < 20; i++) unrequitedSuitors(B.id, getTenant, []);
  Math.random = originalRandom;
  check("unrequitedSuitors() 是純過濾函式,20 次呼叫零 Math.random()", calls === 0, `calls=${calls}`);
}

// ── 4) became_couple 觸發:rivals 效果的完整套用 + 只觸發一次 + fx 視在場座標優雅跳過 ──
{
  const A = state.runtimes["tenant_chen_engineer"];
  const B = state.runtimes["tenant_lin_asmr"];
  A.tenant.gender = "male"; A.tenant.attractedTo = ["female"]; A.tenant.isAdult = true;
  B.tenant.gender = "female"; B.tenant.attractedTo = ["male"]; B.tenant.isAdult = true;
  A.pendingEvent = null; B.pendingEvent = null;
  A.tenant.visualState = "idle"; B.tenant.visualState = "idle";
  A.inLounge = true; B.inLounge = true;
  A.targetTile = null; B.targetTile = null; // 不掛告白演出,乾淨隔離 rivals 的 fx 斷言

  const Z = mk("tri_rival_present", "小柔(現場)", "female"); // 對 A 單戀,有合法座標 → 應掛 fx
  const W = mk("tri_rival_away", "阿凱(不在場)", "male");     // 對 B 單戀,無座標 → 只套數值,不掛 fx
  state.runtimes[Z.id] = makeRuntime(Z, "z1", 70, []);
  state.runtimes[W.id] = makeRuntime(W, "z2", 70, []);
  state.runtimes[Z.id].tenant.visualState = "idle";
  state.runtimes[Z.id].pendingEvent = null;
  state.runtimes[Z.id].inLounge = false; // 落選者不必在交誼廳,只要不是 away/pendingEvent
  state.runtimes[Z.id].targetTile = { c: 5, r: 5 };
  state.runtimes[W.id].tenant.visualState = "idle";
  state.runtimes[W.id].pendingEvent = null;
  state.runtimes[W.id].inLounge = false;
  state.runtimes[W.id].targetTile = null;

  // 其餘既有種子/前面測試留下的 runtimes 全部退出交誼廳,避免 socialPass 跑到無關配對干擾判定
  for (const rt of Object.values(state.runtimes)) {
    if (rt !== A && rt !== B) rt.inLounge = false;
  }

  clearRels();
  relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 76, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  relationships[pairKey(A.tenant.id, Z.id)] = { value: 80, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };
  relationships[pairKey(B.tenant.id, W.id)] = { value: 82, romantic: false, tension: 0, lastConflictGameMs: 0, cohabitOffered: false };

  clearFx();
  const zStressBefore = state.runtimes[Z.id].tenant.stats.stress;
  const zMoodBefore = state.runtimes[Z.id].tenant.stats.mood;
  const wStressBefore = state.runtimes[W.id].tenant.stats.stress;
  const wMoodBefore = state.runtimes[W.id].tenant.stats.mood;

  const originalRandom = Math.random;
  Math.random = () => 0.5; // 跳過自然口角、確定性套用固定文案,比照既有測試手法
  socialPass();
  Math.random = originalRandom;

  check("A、B 確實成為情侶(既有 became_couple 判定不受影響)", getRel(A.tenant.id, B.tenant.id)?.romantic === true);

  const z = state.runtimes[Z.id].tenant;
  const w = state.runtimes[W.id].tenant;
  check("在場落選者 stress +4", z.stats.stress === zStressBefore + 4, `${zStressBefore}->${z.stats.stress}`);
  check("在場落選者 mood -3", z.stats.mood === zMoodBefore - 3, `${zMoodBefore}->${z.stats.mood}`);
  check("不在場座標的落選者數值效果仍套用(不因無座標而跳過數值/日誌)", w.stats.stress === wStressBefore + 4 && w.stats.mood === wMoodBefore - 3);
  check("落選者拿到一次性記憶標籤[暗戀落空]", z.memoryTags.some((m) => m.label === "[暗戀落空]") && w.memoryTags.some((m) => m.label === "[暗戀落空]"));
  check("落選者日誌文案固定一句,提及新伴侶雙方姓名", state.runtimes[Z.id].log.some((e) => e.text.includes("💔") && e.text.includes(A.tenant.name) && e.text.includes(B.tenant.name)));
  check("有合法座標的落選者掛 heartbreak fx(重用既有 fx kind,不新增種類)", activeFx().some((f) => f.kind === "heartbreak" && f.c === 5 && f.r === 5));
  check("無合法座標的落選者優雅跳過 fx,不丟例外(能跑到這裡就是沒炸)", true);

  // 只觸發一次:同一對已成為情侶,之後的相遇不會重複套用落選者反應
  const zStressAfterFirst = z.stats.stress;
  const zMemoryCountAfterFirst = z.memoryTags.filter((m) => m.label === "[暗戀落空]").length;
  const zLogCountAfterFirst = state.runtimes[Z.id].log.length;
  Math.random = () => 0.5;
  socialPass();
  socialPass();
  Math.random = originalRandom;
  check("became_couple 之後不會再重複套用落選者數值效果(rel.romantic 擋掉 became_couple 分支,不靠冷卻鍵)", z.stats.stress === zStressAfterFirst);
  check("[暗戀落空] 記憶標籤不會重複疊加", z.memoryTags.filter((m) => m.label === "[暗戀落空]").length === zMemoryCountAfterFirst);
  check("落選者日誌不會再新增同一句吃醋反應", state.runtimes[Z.id].log.length === zLogCountAfterFirst || !state.runtimes[Z.id].log.slice(zLogCountAfterFirst).some((e) => e.text.includes("眼睜睜看著")));
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
