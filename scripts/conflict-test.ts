/**
 * 衝突系統(§10-2 打架/冷戰)驗證:
 * - tryFight 條件矩陣:關係 <20 + 相容度 ≤-3 + 雙方壓力 ≥80 全中才打
 * - 打架後果:受傷/關係大扣/記憶/打鬥雲 fx + hidden session/家具毀損(接 §7-1)/冷戰/房東抉擇
 * - 房東抉擇:調解 → 冷戰解除+關係回補;警告單方 → 跨租客效果
 * - 冷戰:互動與相遇全擋、交誼廳迴避、每日關係小扣、期滿氣消
 * - 存檔往返
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { tryFight, feudActive, startFeud, endFeud, feudPass, maybeFeudAfterConflict, avoidLounge } = await import("../src/sim/conflicts");
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

function setup(rel = 10, stressA = 90, stressB = 90) {
  relationships[k] = { value: rel, romantic: false, cohabitOffered: false };
  A.tenant.stats.stress = stressA;
  B.tenant.stats.stress = stressB;
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
setup(30);
check("關係 30 → 不打", !tryFight(A, B, () => 0));
setup(10, 70, 90);
check("一方壓力 70 → 不打", !tryFight(A, B, () => 0));
setup(10, 90, 90);
state.feuds[k] = { untilMs: state.gameMs + MS_PER_GAME_HOUR };
check("已在冷戰 → 不打(眼不見為淨)", !tryFight(A, B, () => 0));
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
check("遮蔽式 session(hidden)", sessionFor(A.tenant.id, state.gameMs)?.pose === "hidden");
check("家具毀損(接維修系統)", state.breakdowns.r301?.defId === "damage" || state.breakdowns.r302?.defId === "damage");
check("自動進入冷戰", feudActive(A.tenant.id, B.tenant.id));
check("必發房東抉擇(3 選項、跨租客)", A.pendingEvent?.id === "fight_decision" && A.pendingEvent.choices.length === 3 && A.pendingEvent.withId === B.tenant.id);
check("通知有發", state.noticeLog.some((n) => n.text.includes("大打出手")));

// --- 房東抉擇:調解 → 冷戰解除 + 關係回補 ---
const relBefore = getRel(A.tenant.id, B.tenant.id)!.value;
decide(A.tenant.id, "mediate", "☕ 出面調解,讓兩人把話說開");
check("調解:冷戰解除", !feudActive(A.tenant.id, B.tenant.id));
check("調解:關係回補", getRel(A.tenant.id, B.tenant.id)!.value > relBefore);
check("調解:[冷戰中]記憶移除", !A.tenant.memoryTags.some((m) => m.label === "[冷戰中]"));
check("調解:留下[房東調解]記憶", A.tenant.memoryTags.some((m) => m.label === "[房東調解]"));

// --- 房東抉擇:警告單方 → 跨租客效果(被警告的不滿、另一方覺得被撐腰)---
setup();
tryFight(A, B, () => 0);
const affA = A.tenant.stats.affinity;
const affB = B.tenant.stats.affinity;
decide(A.tenant.id, "warn_one", "⚠️ 只警告動手較兇的一方");
check("警告:被警告方好感↓", A.tenant.stats.affinity < affA);
check("警告:另一方好感↑", B.tenant.stats.affinity > affB);
check("警告:冷戰仍在", feudActive(A.tenant.id, B.tenant.id));

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
setup(10);
maybeFeudAfterConflict(A, B, () => 0);
check("低關係+相容差+大吵 → 升級冷戰", feudActive(A.tenant.id, B.tenant.id));
setup(50);
maybeFeudAfterConflict(A, B, () => 0);
check("關係 50 → 吵完就過,不冷戰", !feudActive(A.tenant.id, B.tenant.id));

// --- 存檔往返 ---
startFeud(A, B, true);
save();
delete state.feuds[k];
check("讀檔成功", load());
check("讀檔後冷戰仍在", !!state.feuds[k]);
endFeud(A.tenant.id, B.tenant.id, "expired");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
