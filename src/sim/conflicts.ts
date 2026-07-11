/**
 * 衝突系統(設計檢討 §10-2 衝突批):冷戰 + 打架——「看得見的不和」。
 *
 * 冷戰(feud):大吵/打架後 3 遊戲日互相迴避——不去有對方在的交誼廳、相遇不互動、
 * 關係每日小扣;期滿氣消,自動解除。
 * 打架:關係 <20 + 相容度 ≤ -3 + 雙方壓力 ≥80 才可能觸發 → 打鬥雲演出(遮蔽式,不見血)
 * → 雙方受傷(wellbeing↓)+ 家具損壞(接 §7-1 維修系統)+ 必發房東抉擇(調解/各打五十/警告)。
 */
import type { Tenant } from "../types";
import type { EventDef } from "./events";
import { pairKey, getRel, adjustRelationship, compatibility } from "./social";
import { state, clamp, notify, pushMemory, pushSocialLog, roomOfTenant, type TenantRuntime } from "./gameState";
import { triggerBreakdown } from "./maintenance";
import { spawnFx } from "../floor/fx";
import { startPairSession } from "../floor/pairSession";
import { MS_PER_GAME_HOUR } from "./clock";

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
export function startFeud(A: TenantRuntime, B: TenantRuntime, quiet = false) {
  state.feuds[pairKey(A.tenant.id, B.tenant.id)] = { untilMs: state.gameMs + FEUD_DAYS * 24 * MS_PER_GAME_HOUR };
  pushMemory(A.tenant, FEUD_MEMORY, `和${B.tenant.name}徹底鬧翻,現在連交誼廳都刻意錯開。`, "ai_event");
  pushMemory(B.tenant, FEUD_MEMORY, `和${A.tenant.name}徹底鬧翻,現在連交誼廳都刻意錯開。`, "ai_event");
  if (!quiet) {
    pushSocialLog(A, `❄️ 和 ${B.tenant.name} 徹底鬧翻,進入冷戰,互相當作看不見。`, "major");
    pushSocialLog(B, `❄️ 和 ${A.tenant.name} 徹底鬧翻,進入冷戰,互相當作看不見。`, "major");
    notify(`❄️ ${A.tenant.name} 和 ${B.tenant.name} 鬧翻了,進入冷戰`);
  }
}

/** 解除冷戰(期滿或房東調解成功):移除登記與 [冷戰中] 記憶 + 日誌 */
export function endFeud(aId: string, bId: string, reason: "expired" | "mediated") {
  const k = pairKey(aId, bId);
  if (!state.feuds[k]) return;
  delete state.feuds[k];
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
 * 嘗試觸發打架(socialPass 相遇前呼叫)。條件全中才擲骰:
 * 關係 <20 + 相容度 ≤ -3 + 雙方壓力 ≥80 + 非冷戰中。回傳 true = 打起來了(這對這小時到此為止)。
 */
export function tryFight(A: TenantRuntime, B: TenantRuntime, rng: () => number = Math.random): boolean {
  if ((getRel(A.tenant.id, B.tenant.id)?.value ?? 0) >= 20) return false;
  if (compatibility(A.tenant, B.tenant) > -3) return false;
  if (A.tenant.stats.stress < 80 || B.tenant.stats.stress < 80) return false;
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
  const line = (o: string) => `💢 和 ${o} 大打出手,場面一度失控,兩人都掛了彩!`;
  pushSocialLog(A, line(B.tenant.name), "major");
  pushSocialLog(B, line(A.tenant.name), "major");
  pushMemory(A.tenant, "[大打出手]", `和${B.tenant.name}打了一架,臉上還掛著瘀青。`, "ai_event");
  pushMemory(B.tenant, "[大打出手]", `和${A.tenant.name}打了一架,臉上還掛著瘀青。`, "ai_event");
  notify(`💢 ${A.tenant.name} 和 ${B.tenant.name} 在交誼廳大打出手!`);

  // 演出:打鬥雲(遮蔽式,不見血)——兩人 sprite 隱藏,只剩一團雲 + 星星
  const at = A.targetTile ?? B.targetTile;
  if (at) {
    spawnFx("fight", at.c, at.r, 15000);
    startPairSession(A.tenant.id, B.tenant.id, at, "hidden", state.gameMs, 15000);
  }

  // 家具遭殃(接 §7-1):混戰波及其中一人的房間設備,房東要花錢修
  const roomId = roomOfTenant(rng() < 0.5 ? A.tenant.id : B.tenant.id) ?? roomOfTenant(A.tenant.id);
  if (roomId) triggerBreakdown(roomId, "damage", rng);

  // 之後:冷戰(靜默登記,打架日誌已經夠大聲)+ 必發房東抉擇
  startFeud(A, B, true);
  A.pendingEvent = fightDecision(A.tenant, B.tenant);
  return true;
}
