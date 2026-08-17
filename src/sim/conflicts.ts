/**
 * 衝突系統(設計檢討 §10-2 衝突批):冷戰 + 打架——「看得見的不和」。
 *
 * 冷戰(feud):大吵/打架後 3 遊戲日互相迴避——不去有對方在的交誼廳、相遇不互動、
 * 關係每日小扣;期滿氣消,自動解除。
 * 打架:關係 <20 + 積怨 ≥70 + 相容度 ≤ -3 + 壓力門檻(見 FIGHT_STRESS_*)才可能觸發
 * → 卡通推擠演出(scuffle,兩人看得見、但不見血)+ 打鬥雲 fx
 * → 雙方受傷(wellbeing↓)+ 家具損壞(接 §7-1 維修系統)+ 必發房東抉擇(調解/各打五十/警告)。
 */
import type { Tenant } from "../types";
import type { EventDef } from "./events";
import { pairKey, getRel, adjustRelationship, adjustTension, compatibility } from "./social";
import { state, clamp, notify, pushMemory, pushSocialLog, roomOfTenant, type TenantRuntime } from "./gameState";
import { triggerBreakdown } from "./maintenance";
import { spawnFx } from "../floor/fx";
import { startPairSession, startSeparationSession, scuffleTiles } from "../floor/pairSession";
import { currentBlocked } from "../floor/pathfind";
import type { Tile } from "../floor/pathfind";
import { LOUNGE_HALL_RECT } from "../floor/map";
import { roomRect } from "./placements";
import { MS_PER_GAME_HOUR } from "./clock";
import { unlock } from "./legacy";

const FEUD_DAYS = 3;
const FEUD_MEMORY = "[冷戰中]";

/** 兩人是否冷戰中 */
export function feudActive(aId: string, bId: string): boolean {
  const f = state.feuds[pairKey(aId, bId)];
  return !!f && state.gameMs < f.untilMs;
}

/** 這個人要去交誼廳時,裡面是否已有冷戰對象(有 → 迴避不去) */
export function avoidLounge(tenantId: string): boolean {
  return Object.values(state.runtimes).some((rt) => rt.tenant.id !== tenantId && rt.inLounge && feudActive(tenantId, rt.tenant.id));
}

/** 開始冷戰:登記期限 + 雙方記憶/日誌(玩家與 AI 都看得到「正在互相迴避」) */
export function startFeud(A: TenantRuntime, B: TenantRuntime, quiet = false, animate = true) {
  const currentTension = getRel(A.tenant.id, B.tenant.id)?.tension ?? 0;
  if (currentTension < 70) adjustTension(A.tenant.id, B.tenant.id, 70 - currentTension);
  state.feuds[pairKey(A.tenant.id, B.tenant.id)] = { untilMs: state.gameMs + FEUD_DAYS * 24 * MS_PER_GAME_HOUR };
  pushMemory(A.tenant, FEUD_MEMORY, `和${B.tenant.name}徹底鬧翻,現在連交誼廳都刻意錯開。`, "ai_event");
  pushMemory(B.tenant, FEUD_MEMORY, `和${A.tenant.name}徹底鬧翻,現在連交誼廳都刻意錯開。`, "ai_event");
  if (!quiet) {
    pushSocialLog(A, `❄️ 和 ${B.tenant.name} 徹底鬧翻,進入冷戰,互相當作看不見。`, "major");
    pushSocialLog(B, `❄️ 和 ${A.tenant.name} 徹底鬧翻,進入冷戰,互相當作看不見。`, "major");
    notify(`❄️ ${A.tenant.name} 和 ${B.tenant.name} 鬧翻了,進入冷戰`);
  }
  if (animate) playDoorSlamExit(A, B);
}

/** 冷戰成立時，兩人立刻停止原本互動、各自退回住處；門口顯示摔門震動。 */
function playDoorSlamExit(A: TenantRuntime, B: TenantRuntime) {
  if (A.tenant.visualState === "away" || B.tenant.visualState === "away") return;
  const aTile = retreatTile(A, false);
  const bTile = retreatTile(B, true);
  if (aTile && bTile) startSeparationSession(A.tenant.id, B.tenant.id, aTile, bTile, state.gameMs);

  const seen = new Set<string>();
  for (const rt of [A, B]) {
    const door = roomDoor(rt);
    if (!door || seen.has(`${door.c},${door.r}`)) continue;
    seen.add(`${door.c},${door.r}`);
    spawnFx("slam", door.c, door.r, 12000, state.gameMs + MS_PER_GAME_HOUR);
  }
}

/** 同房冷戰時分取房內左右兩端；不同房則各自選房內可走格。 */
function retreatTile(rt: TenantRuntime, reverse: boolean): Tile | null {
  const roomId = roomOfTenant(rt.tenant.id);
  const rect = roomId ? roomRect(roomId) : null;
  if (!rect) return rt.targetTile ? { ...rt.targetTile } : null;
  const blocked = currentBlocked();
  const cols = Array.from({ length: rect.c1 - rect.c0 + 1 }, (_, i) => rect.c0 + i);
  const rows = Array.from({ length: rect.r1 - rect.r0 + 1 }, (_, i) => rect.r0 + i);
  if (reverse) cols.reverse();
  for (const c of cols) {
    for (const r of rows) if (blocked[r]?.[c] === false) return { c, r };
  }
  return rt.targetTile ? { ...rt.targetTile } : null;
}

/** 四間套房的門都在靠中央走廊側，可由房間矩形推導，不另寫死座標。 */
function roomDoor(rt: TenantRuntime): Tile | null {
  const roomId = roomOfTenant(rt.tenant.id);
  const rect = roomId ? roomRect(roomId) : null;
  if (!rect) return null;
  return {
    c: rect.c1 < 7 ? rect.c1 + 1 : rect.c0 - 1,
    r: Math.floor((rect.r0 + rect.r1) / 2),
  };
}

/** 解除冷戰(期滿或房東調解成功):移除登記與 [冷戰中] 記憶 + 日誌 */
export function endFeud(aId: string, bId: string, reason: "expired" | "mediated") {
  const k = pairKey(aId, bId);
  if (!state.feuds[k]) return;
  delete state.feuds[k];
  if (reason === "expired") adjustTension(aId, bId, -8);
  for (const id of [aId, bId]) {
    const rt = state.runtimes[id];
    if (!rt) continue;
    const otherName = state.runtimes[id === aId ? bId : aId]?.tenant.name ?? "對方";
    const i = rt.tenant.memoryTags.findIndex((m) => m.label === FEUD_MEMORY);
    if (i >= 0) rt.tenant.memoryTags.splice(i, 1);
    pushSocialLog(
      rt,
      reason === "mediated" ? `🕊️ 在房東的調解下,和 ${otherName} 把話說開了。` : `🕊️ 和 ${otherName} 的冷戰慢慢降溫,見面至少會點頭了。`,
      "notable",
    );
  }
}

/** 每遊戲日呼叫:冷戰關係小扣;期滿自動解除 */
export function feudPass() {
  for (const k of Object.keys(state.feuds)) {
    const [aId, bId] = k.split("|");
    if (state.gameMs >= state.feuds[k].untilMs) {
      endFeud(aId, bId, "expired");
    } else {
      adjustRelationship(aId, bId, -2); // 不說話,關係只會更僵
    }
  }
}

/** 大吵後可能升級成冷戰(socialPass 在 conflict 基調的相遇後呼叫) */
export function maybeFeudAfterConflict(A: TenantRuntime, B: TenantRuntime, rng: () => number = Math.random) {
  if (feudActive(A.tenant.id, B.tenant.id)) return;
  const rel = getRel(A.tenant.id, B.tenant.id);
  if ((rel?.tension ?? 0) < 70) return;
  if ((rel?.value ?? 0) >= 30) return; // 還有點交情,吵完就過了
  if (compatibility(A.tenant, B.tenant) > -2) return;
  if (rng() > 0.35) return;
  startFeud(A, B);
}

/** 打架的房東抉擇(必發):牽涉雙方,選項用既有跨租客效果(other/rel)落地 */
function fightDecision(a: Tenant, b: Tenant): EventDef {
  return {
    id: "fight_decision",
    title: "🥊 打架事件",
    description: `${a.name} 和 ${b.name} 在交誼廳大打出手,兩人都掛了彩,現場一片狼藉。身為房東,你要怎麼處理?`,
    withId: b.id,
    withName: b.name,
    choices: [
      {
        id: "mediate",
        label: "☕ 出面調解,讓兩人把話說開",
        hint: "花時間各別談心,化解心結(冷戰解除)",
        effect: {
          stress: -12,
          mood: 6,
          affinity: 4,
          other: { stress: -12, mood: 6, affinity: 4 },
          rel: { delta: 12 },
          memory: { label: "[房東調解]", hint: "打架後房東把兩人拉來談開,心裡有點感激。" },
        },
      },
      {
        id: "scold_both",
        label: "📢 各打五十大板,嚴厲警告兩人",
        hint: "立威但不解心結(冷戰繼續)",
        effect: { stress: 4, affinity: -6, other: { stress: 4, affinity: -6 } },
      },
      {
        id: "warn_one",
        label: `⚠️ 只警告動手較兇的 ${a.name}`,
        hint: `${a.name} 會不服氣;${b.name} 覺得被撐腰`,
        effect: {
          affinity: -10,
          stress: 6,
          satisfaction: -6,
          other: { mood: 5, affinity: 5 },
          memory: { label: "[被房東警告]", hint: "打架後被房東點名警告,心裡不服氣。" },
        },
      },
    ],
  };
}

/**
 * 打架的壓力門檻(2026-08-17 依 `scripts/conflict-freq-sim.ts` 的實測改成「合計 + 各自下限」)。
 *
 * 舊門檻是「**雙方** stress ≥ 80」,實測證明那不是難,是**不可達**:
 * 逐時活動增量長期為負(睡覺 −5/h、洗澡 −4、打電動 −3)而 homeostasis 只有 6%/h,
 * 壓力平衡點落在 `baselines()` 基準**下方約 20 點**、幾乎不曾超過基準;基準本身又夾在 10~90。
 * 高摩擦滿房跑 60 遊戲日 × 三種壓力基準(38/58/78),打架 **0 場**,漏斗
 * 873→535(rel)→198(tension)→198(comp)→**0**(stress),瓶頸 100% 在這一關。
 * 而且 stress ≥90/≥95 會被 `tick.decideState()` 判成 `isDeviation` 趕回房間
 * (`inLounge = false`)⇒ [80, 90) 的可用窗口實質為零。
 *
 * 現值 **50/22** 是拿同一支腳本逐個候選值**實跑**選出來的(不是從分布推導的——推導過一次,
 * 62/28 的估計就錯了:影子漏斗在 `hourlyTick()` **之後**取樣,那一小時若發生口角雙方已各 +4,
 * 合計被墊高最多 8 點)。60 遊戲日、固定種子、四人高摩擦滿房的實跑對照:
 *
 *   門檻      normal(基準 ~40)   stressed(基準 ~60)
 *   62 / 28        0 場                17 場      ← 一般住戶完全看不到,沒有解決使用者的抱怨
 *   55 / 24        1 場                14 場      ← 兩個月才一次,實質仍看不到
 *   50 / 22        9 場                14 場      ← 現值
 *   46 / 20       10 場                19 場
 *
 * 使用者的原始訴求是「要看到大打出手太難了」,而遊戲的一天綁瀏覽器本地時區 ⇒ 門檻必須讓
 * **一般壓力基準**的敵對配對也偶爾打得起來,才算解決。
 *
 * 放寬到這裡不會變成天天打,因為自我抑制是獨立於門檻的:打完雙方 stress −15、必進 3 遊戲日
 * 冷戰(冷戰期間 `avoidLounge()` 讓兩人根本不同框),而且打架與口角**共用**全樓每日 2 場的
 * 衝突額度 ⇒ 打架變多時口角自動變少,總衝突量不會暴增(實測 108 → 78)。
 *
 * 相容的一對永遠是確定 0 —— 前三道門檻(rel<20、tension≥70、comp≤−3)就結構性擋掉了,
 * 打架只發生在玩家自己組出來的水火不容配對上。
 *
 * ⚠️ 更好的寫法是相對各自基準線(`stress >= baselines(rt).stress - 10`,自動適應不同原型),
 * 但 `conflicts.ts` import `tick.ts` 的 `baselines` 會造成循環 import(`tick.ts` 已 import 本檔),
 * 要先把 `baselines()` 抽到共用模組。已記在 `docs/待辦.md`,本批不做。
 */
export const FIGHT_STRESS_SUM = 50;
export const FIGHT_STRESS_EACH = 22;

/** 其他在場租客這一小時的目標格 —— 打架錨點要閃開它們(以及它們的擁擠溢出環)。 */
function othersTargets(exclude: readonly string[]): Tile[] {
  const skip = new Set(exclude);
  const out: Tile[] = [];
  for (const rt of Object.values(state.runtimes)) {
    if (skip.has(rt.tenant.id) || rt.tenant.visualState === "away") continue;
    const t = rt.activityTile ?? rt.targetTile;
    if (t) out.push(t);
  }
  return out;
}

/**
 * 嘗試觸發打架(socialPass 相遇前呼叫)。條件全中才擲骰:
 * 關係 <20 + 積怨 ≥70 + 相容度 ≤ -3 + 壓力(各 ≥22 且合計 ≥50)+ 非冷戰中。
 * 回傳 true = 打起來了(這對這小時到此為止)。
 */
export function tryFight(A: TenantRuntime, B: TenantRuntime, rng: () => number = Math.random): boolean {
  const rel = getRel(A.tenant.id, B.tenant.id);
  if ((rel?.value ?? 0) >= 20) return false;
  if ((rel?.tension ?? 0) < 70) return false;
  if (compatibility(A.tenant, B.tenant) > -3) return false;
  // 「兩人都在氣頭上」= 各自要高於自己的日常水位(EACH),而且加起來夠嗆(SUM);
  // 不再要求兩個人同時飆到極端值——那個窗口被 isDeviation 壓成了零。
  if (A.tenant.stats.stress < FIGHT_STRESS_EACH || B.tenant.stats.stress < FIGHT_STRESS_EACH) return false;
  if (A.tenant.stats.stress + B.tenant.stats.stress < FIGHT_STRESS_SUM) return false;
  if (feudActive(A.tenant.id, B.tenant.id)) return false;
  if (B.pendingEvent) return false; // A 的 pendingEvent 由 socialPass 先濾掉
  if (rng() > 0.6) return false;

  // 雙方受傷 + 發洩掉一點壓力,但心情/滿意重挫、關係大扣
  for (const rt of [A, B]) {
    const s = rt.tenant.stats;
    s.wellbeing = clamp(s.wellbeing - 15, 0, 100);
    s.stress = clamp(s.stress - 15, 0, 100);
    s.mood = clamp(s.mood - 12, 0, 100);
    rt.satisfaction = clamp(rt.satisfaction - 8, 0, 100);
  }
  adjustRelationship(A.tenant.id, B.tenant.id, -15);
  adjustTension(A.tenant.id, B.tenant.id, 20);
  const line = (o: string) => `💢 和 ${o} 大打出手,場面一度失控,兩人都掛了彩!`;
  pushSocialLog(A, line(B.tenant.name), "major");
  pushSocialLog(B, line(A.tenant.name), "major");
  pushMemory(A.tenant, "[大打出手]", `和${B.tenant.name}打了一架,臉上還掛著瘀青。`, "ai_event");
  pushMemory(B.tenant, "[大打出手]", `和${A.tenant.name}打了一架,臉上還掛著瘀青。`, "ai_event");
  notify(`💢 ${A.tenant.name} 和 ${B.tenant.name} 在交誼廳大打出手!`);
  unlock("brawl"); // 成就:樓要塌了(§G-7)

  // 演出:打鬥雲 + **看得見的卡通推擠**(2026-08-17 由 `pose: "hidden"` 改成 `"scuffle"`)。
  // 舊版把兩人 sprite 直接藏起來,畫面上只剩一團雲 ⇒ 就算真的打起來玩家也看不到人。
  // 🚫 **維持非血腥**:scuffle 只是兩人面對面、左右交替 ±1px 的拉扯位移,
  //    沿用既有的側面 sprite 與既有的 fight fx(雲 + 星星),
  //    **不畫傷口、不畫血、不新增任何暴力細節**,也不得在後續批次升級成血腥描寫。
  //
  // F-3「就地開打」:錨點不再直接拿 `A.targetTile`(交誼廳沙發那個一格寬的死巷),
  // 改用 `scuffleTiles()` 在兩人現有目標格附近挑一組相鄰兩格,並避開其他租客的
  // 目標格與擁擠溢出環 ⇒ 兩人少走路、也不會被第三人堵在半路。挑不到就退回舊路徑。
  const nearA = A.activityTile ?? A.targetTile;
  const nearB = B.activityTile ?? B.targetTile;
  const pair = nearA && nearB
    ? scuffleTiles({ a: nearA, b: nearB }, othersTargets([A.tenant.id, B.tenant.id]), LOUNGE_HALL_RECT)
    : null;
  const at = pair?.a ?? A.targetTile ?? B.targetTile;
  if (at) {
    spawnFx("fight", at.c, at.r, 15000);
    startPairSession(A.tenant.id, B.tenant.id, at, "scuffle", state.gameMs, 15000, pair ?? undefined);
  }

  // 家具遭殃(接 §7-1):混戰波及其中一人的房間設備,房東要花錢修
  const roomId = roomOfTenant(rng() < 0.5 ? A.tenant.id : B.tenant.id) ?? roomOfTenant(A.tenant.id);
  if (roomId) triggerBreakdown(roomId, "damage", rng);

  // 之後:冷戰(靜默登記,打架日誌已經夠大聲)+ 必發房東抉擇
  // 推擠演出優先演完，避免冷戰退場立即把 scuffle session 蓋掉；一般口角/修羅場仍會直接摔門。
  startFeud(A, B, true, false);
  A.pendingEvent = fightDecision(A.tenant, B.tenant);
  return true;
}
