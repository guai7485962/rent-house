/**
 * 衝突系統(§10-2 打架/冷戰)驗證:
 * - tryFight 條件矩陣:關係 <20 + 積怨 ≥70 + 相容度 ≤-3 + 壓力(各 ≥22 且合計 ≥50)全中才打
 * - 打架後果:受傷/關係大扣/記憶/打鬥雲 fx + **看得見的** scuffle session/家具毀損(接 §7-1)/冷戰/房東抉擇
 * - 房東抉擇:調解 → 冷戰解除+關係回補;警告單方 → 跨租客效果
 * - 冷戰:互動與相遇全擋、交誼廳迴避、每日關係小扣、期滿氣消
 * - 存檔往返
 */

// 固定種子 PRNG(mulberry32),比照 balance-test.ts:必須在 import store 之前覆寫
// Math.random,否則模組初始化階段就已經吃掉真實亂數。目的是消除偶發假性失敗
// (原本靠 run-all.ts 的「失敗重試一次」兜著),不是放寬任何斷言。
let seed = 20260710;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { tryFight, feudActive, startFeud, endFeud, feudPass, maybeFeudAfterConflict, avoidLounge, FIGHT_STRESS_SUM, FIGHT_STRESS_EACH } = await import("../src/sim/conflicts");
const { relationships, pairKey, getRel } = await import("../src/sim/social");
const { canInteract, INTERACTIONS } = await import("../src/sim/interactions");
const { activeFx, clearFx } = await import("../src/floor/fx");
const { sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const { decide } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");
const { state } = await import("../src/store");
import type { CoreTag } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
const k = pairKey(A.tenant.id, B.tenant.id);
const tag = (id: string): CoreTag => ({ id, label: id, behaviorHint: "" });

// 相容度 ≤ -3:吵(noisy+gamer)vs 靜(sound_sensitive)+ 作息相反(night_owl vs early_bird)
A.tenant.coreTags = [tag("noisy"), tag("gamer"), tag("early_bird")];
B.tenant.coreTags = [tag("sound_sensitive"), tag("night_owl")];

function setup(rel = 10, stressA = 40, stressB = 40, tension = 80) {
  relationships[k] = { value: rel, tension, lastConflictGameMs: 0, romantic: false, cohabitOffered: false };
  A.tenant.stats.stress = stressA;
  B.tenant.stats.stress = stressB;
  // 壓力門檻改成「合計 + 各自下限」後,邊界用例會連打好幾場,wellbeing/mood 會被扣到 0
  // 而讓「受傷/心情重挫」的比較失去意義;每次 setup 一併回到中間值,讓每條斷言彼此獨立。
  for (const rt of [A, B]) {
    rt.tenant.stats.wellbeing = 70;
    rt.tenant.stats.mood = 60;
  }
  A.targetTile = { c: 7, r: 10 }; // 無頭初始沒定位,給 fx/session 一個錨點
  A.pendingEvent = null;
  B.pendingEvent = null;
  delete state.feuds[k];
  delete state.breakdowns.r301;
  delete state.breakdowns.r302;
  clearFx();
  clearPairSessions();
}

// --- 條件矩陣(rng=0:機率必過,只驗條件)---
check("門檻常數是實測拍板的 50 / 22", FIGHT_STRESS_SUM === 50 && FIGHT_STRESS_EACH === 22);
setup(30);
check("關係 30 → 不打", !tryFight(A, B, () => 0));
setup(10, 90, 90, 69);
check("積怨未達 70 → 不打", !tryFight(A, B, () => 0));
setup(10, 90, 90);
state.feuds[k] = { untilMs: state.gameMs + MS_PER_GAME_HOUR };
check("已在冷戰 → 不打(眼不見為淨)", !tryFight(A, B, () => 0));

// 壓力門檻的邊界(2026-08-17 由「雙方 ≥80」改成「各 ≥22 且合計 ≥50」)。
// 兩條門檻要能**各自**被驗到:合計夠但一方太低要擋、雙方都到下限但合計不夠也要擋。
setup(10, 22, 22); // 各自剛好到下限,但合計只有 44
check("各 22、合計 44 → 不打(卡合計)", !tryFight(A, B, () => 0));
setup(10, 28, 22); // 合計剛好 50,較低者剛好 22
check("28 + 22 = 50 → 打(兩條門檻都剛好踩線)", tryFight(A, B, () => 0));
setup(10, 27, 22); // 合計 49,只差 1
check("27 + 22 = 49 → 不打(合計差 1 也不行)", !tryFight(A, B, () => 0));
setup(10, 21, 80); // 合計 101 很高,但一方低於各自下限
check("21 + 80 = 101 → 不打(卡各自下限,合計再高也沒用)", !tryFight(A, B, () => 0));
setup(10, 21, 29); // 合計剛好 50,但較低者差 1
check("21 + 29 = 50 → 不打(合計到了,較低者差 1)", !tryFight(A, B, () => 0));
setup(10, 21, 21); // 兩關都不足
check("21 + 21 → 不打(兩關都卡)", !tryFight(A, B, () => 0));
setup(10, 25, 25); // 各 ≥22 且合計 50
check("25 + 25 = 50 → 打(平均分配也算數)", tryFight(A, B, () => 0));
setup(10, 90, 90);
check("雙方 90(舊門檻)→ 仍然打", tryFight(A, B, () => 0));
setup();
const goodTags = B.tenant.coreTags;
B.tenant.coreTags = [tag("gamer"), tag("night_owl")]; // 相容度變好
check("相容度不夠差 → 不打", !tryFight(A, B, () => 0));
B.tenant.coreTags = goodTags;

// --- 打起來:全套後果 ---
setup();
const wbA = A.tenant.stats.wellbeing;
const moodB = B.tenant.stats.mood;
check("條件全中 → 打", tryFight(A, B, () => 0));
check("雙方受傷(wellbeing↓)", A.tenant.stats.wellbeing < wbA);
check("心情重挫", B.tenant.stats.mood < moodB);
check("關係大扣", (getRel(A.tenant.id, B.tenant.id)?.value ?? 99) < 10);
check("雙方留下[大打出手]記憶", [A, B].every((rt) => rt.tenant.memoryTags.some((m) => m.label === "[大打出手]")));
check("打架日誌(major)", A.log.some((e) => e.text.includes("大打出手") && e.importance === "major"));
check("打鬥雲 fx 掛上", activeFx().some((f) => f.kind === "fight"));
check("打架 session 是看得見的 scuffle,不是 hidden", sessionFor(A.tenant.id, state.gameMs)?.pose === "scuffle");
check("兩人都掛上 scuffle(不是只有一方)", sessionFor(B.tenant.id, state.gameMs)?.pose === "scuffle");
check("家具毀損(接維修系統)", state.breakdowns.r301?.defId === "damage" || state.breakdowns.r302?.defId === "damage");
check("自動進入冷戰", feudActive(A.tenant.id, B.tenant.id));
check("必發房東抉擇(3 選項、跨租客)", A.pendingEvent?.id === "fight_decision" && A.pendingEvent.choices.length === 3 && A.pendingEvent.withId === B.tenant.id);
check("通知有發", state.noticeLog.some((n) => n.text.includes("大打出手")));

// --- 房東抉擇:調解 → 冷戰解除 + 關係回補 ---
const relBefore = getRel(A.tenant.id, B.tenant.id)!.value;
const tensionBefore = getRel(A.tenant.id, B.tenant.id)!.tension;
decide(A.tenant.id, "mediate", "☕ 出面調解,讓兩人把話說開");
check("調解:冷戰解除", !feudActive(A.tenant.id, B.tenant.id));
check("調解:關係回補", getRel(A.tenant.id, B.tenant.id)!.value > relBefore);
check("調解:積怨精確降低 30", getRel(A.tenant.id, B.tenant.id)!.tension === Math.max(0, tensionBefore - 30));
check("調解:[冷戰中]記憶移除", !A.tenant.memoryTags.some((m) => m.label === "[冷戰中]"));
check("調解:留下[房東調解]記憶", A.tenant.memoryTags.some((m) => m.label === "[房東調解]"));

// --- 房東抉擇:警告單方 → 跨租客效果(被警告的不滿、另一方覺得被撐腰)---
setup();
tryFight(A, B, () => 0);
const affA = A.tenant.stats.affinity;
const affB = B.tenant.stats.affinity;
const warnTension = getRel(A.tenant.id, B.tenant.id)!.tension;
decide(A.tenant.id, "warn_one", "⚠️ 只警告動手較兇的一方");
check("警告:被警告方好感↓", A.tenant.stats.affinity < affA);
check("警告:另一方好感↑", B.tenant.stats.affinity > affB);
check("警告:冷戰仍在", feudActive(A.tenant.id, B.tenant.id));
check("警告:偏袒不會讓積怨降溫", getRel(A.tenant.id, B.tenant.id)!.tension >= warnTension);

// --- 冷戰行為 ---
check("冷戰中互動全擋(canInteract)", INTERACTIONS.every((d) => !canInteract(d, A.tenant, B.tenant, { hour: 22, thirdPresent: false, adultMode: true, cohabiting: true, furniture: new Set(["double_bed", "tv_console", "shared_sofa", "lounge_tv"]) })));
B.inLounge = true;
check("交誼廳有冷戰對象 → 迴避", avoidLounge(A.tenant.id));
B.inLounge = false;
check("沒有冷戰對象在 → 不迴避", !avoidLounge(A.tenant.id));

// 每日:關係小扣;期滿氣消(先把關係墊離 0,免得被夾值擋住看不出扣分)
relationships[k].value = 20;
const vBefore = getRel(A.tenant.id, B.tenant.id)!.value;
feudPass();
check("冷戰每日關係小扣", getRel(A.tenant.id, B.tenant.id)!.value < vBefore);
state.feuds[k].untilMs = state.gameMs - 1; // 強制到期
feudPass();
check("期滿氣消:冷戰解除", !feudActive(A.tenant.id, B.tenant.id));
check("期滿:[冷戰中]記憶移除", !B.tenant.memoryTags.some((m) => m.label === "[冷戰中]"));
check("期滿:降溫日誌", A.log.some((e) => e.text.includes("冷戰慢慢降溫")));

// --- 大吵升級冷戰(maybeFeudAfterConflict)---
setup(10, 90, 90, 5);
startFeud(A, B, true, false);
check("任何既有冷戰入口都會把積怨拉到冷戰門檻", getRel(A.tenant.id, B.tenant.id)!.tension >= 70);
setup(10);
maybeFeudAfterConflict(A, B, () => 0);
check("低關係+相容差+大吵 → 升級冷戰", feudActive(A.tenant.id, B.tenant.id));
check("冷戰成立 → 兩人使用 apart session 各自退場", sessionFor(A.tenant.id, state.gameMs)?.pose === "apart" && sessionFor(B.tenant.id, state.gameMs)?.pose === "apart");
check("冷戰成立 → 房門出現摔門 fx", activeFx().some((f) => f.kind === "slam"));
setup(50);
maybeFeudAfterConflict(A, B, () => 0);
check("關係 50 → 吵完就過,不冷戰", !feudActive(A.tenant.id, B.tenant.id));

// --- 存檔往返 ---
startFeud(A, B, true);
const savedTension = getRel(A.tenant.id, B.tenant.id)!.tension;
save();
delete state.feuds[k];
relationships[k].tension = 0;
check("讀檔成功", load());
check("讀檔後冷戰仍在", !!state.feuds[k]);
check("完整存檔往返保留積怨", getRel(A.tenant.id, B.tenant.id)!.tension === savedTension);
endFeud(A.tenant.id, B.tenant.id, "expired");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
