/**
 * 使用者回報的修正驗證:
 * - 只允許異性成為伴侶(canRomance);pruneInvalidRomance 清掉既有同性情侶
 * - 隔音後清掉「被噪音困擾」記憶(clearNoiseMemories)
 * - 共用淋浴間單人使用(48 小時內不會有 2 人同時在浴室洗澡)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子,機率型整合測試可重現
let __seed = 20260710;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { canRomance, pruneInvalidRomance, relationships, pairKey, getRel } = await import("../src/sim/social");
const { clearNoiseMemories } = await import("../src/sim/memoryEffects");
const { INTERACTIONS } = await import("../src/sim/interactions");
const { state, debugStepHour } = await import("../src/store");
import type { Tenant } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- #5 只允許異性成為伴侶 ---
const mkT = (id: string, gender: string, attractedTo: string[]): Tenant => ({ id, gender, attractedTo, isAdult: true } as any);
const male = mkT("m", "male", ["female"]);
const female = mkT("f", "female", ["male"]);
const male2 = mkT("m2", "male", ["male", "female"]);
const female2 = mkT("f2", "female", ["male", "female"]);
check("異性 + 互有取向 → 可成伴侶", canRomance(male, female));
check("兩位男性(即使互有取向)→ 不可成伴侶", !canRomance(male2, mkT("m3", "male", ["male"])));
check("兩位女性 → 不可成伴侶", !canRomance(female2, mkT("f3", "female", ["female", "male"])));
check("異性但取向不合 → 不可", !canRomance(mkT("x", "male", ["male"]), female));

// pruneInvalidRomance 清掉既有同性情侶
relationships[pairKey("m2", "m3")] = { value: 90, romantic: true, cohabitOffered: false };
relationships[pairKey("m", "f")] = { value: 90, romantic: true, cohabitOffered: false };
const roster: Record<string, Tenant> = { m: male, f: female, m2: male2, m3: mkT("m3", "male", ["male"]) };
pruneInvalidRomance((id) => roster[id]);
check("prune:同性情侶被解除", relationships[pairKey("m2", "m3")].romantic === false);
check("prune:異性情侶保留", relationships[pairKey("m", "f")].romantic === true);

// --- #1 隔音後清掉噪音困擾記憶 ---
const t = state.runtimes["tenant_lin_asmr"].tenant;
t.memoryTags = [
  { id: "a", label: "[被噪音困擾]", behaviorHint: "隔壁裝修吵得睡不著。", acquiredAt: "", source: "ai_event", intensity: 1 },
  { id: "b", label: "[頻道破萬]", behaviorHint: "直播訂閱破萬,心情大好。", acquiredAt: "", source: "ai_event", intensity: 1 },
  { id: "c", label: "[失眠]", behaviorHint: "最近老是睡不好。", acquiredAt: "", source: "ai_event", intensity: 1 },
] as any;
const removed = clearNoiseMemories(t);
check("清掉噪音/失眠類記憶", removed.length === 2 && removed.includes("[被噪音困擾]") && removed.includes("[失眠]"));
check("無關記憶保留(頻道破萬)", t.memoryTags.length === 1 && t.memoryTags[0].label === "[頻道破萬]");

// --- #3 共用淋浴間:非伴侶不同框洗澡(伴侶可以)---
let showerViolation = false;
for (let i = 0; i < 48; i++) {
  debugStepHour();
  const shw = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState === "showering");
  for (let a = 0; a < shw.length; a++)
    for (let b = a + 1; b < shw.length; b++) {
      const rel = getRel(shw[a].tenant.id, shw[b].tenant.id);
      if (!(rel && rel.romantic)) showerViolation = true; // 同時洗澡卻不是伴侶 → 違規
    }
}
check("非伴侶不會同框洗澡(伴侶才可以)", !showerViolation);

// --- #1(本次)一起洗澡演出在淋浴間 ---
check("bath_together 演出地點 = 淋浴間", INTERACTIONS.find((d) => d.id === "bath_together")?.venue === "bathroom");

// --- #2 朋友以上會到彼此房間串門子 ---
const chen = state.runtimes["tenant_chen_engineer"];
const lin = state.runtimes["tenant_lin_asmr"];
check("有朋友房間互動定義(room_hangout, close/room)", INTERACTIONS.some((d) => d.id === "room_hangout" && d.tier === "close" && d.location === "room"));
let visited = false;
for (let i = 0; i < 150 && !visited; i++) {
  relationships[pairKey(chen.tenant.id, lin.tenant.id)] = { value: 70, romantic: false, cohabitOffered: false }; // 維持朋友
  chen.pendingEvent = null;
  lin.pendingEvent = null;
  debugStepHour();
  if (chen.visiting || lin.visiting) visited = true;
}
check("朋友以上會到彼此房間串門子(visiting 有觸發)", visited);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
