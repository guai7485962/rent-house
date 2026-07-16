/**
 * AI 觀察回饋(docs/AI觀察回饋設計.md)。
 * 第一期 statNudge:AI 在每日 narrate 回應附上 observation(對今天素材的「情緒解讀」),
 * 消毒夾值後小幅推動租客數值,並寫一行 🔮 日誌讓玩家看到因果。
 * 第二期 selfBehavior:observation 可再附 behavior——「房客自己的決定」,
 * 不需玩家拍板,直接讓他 1~2 天的行為看得見地改變(🌀 日誌),玩家拍板的指令永遠優先。
 * 跨租客關係 nudge(受限版):AI 可對「今日素材中真的出現過的鄰居」給 ±2 關係推力;
 * 向上永遠推不過 74(戀愛門檻 75 前一格)——成為情侶等重大轉變仍只走既有機制。
 *
 * 硬規則(比照 cleanEffect / sanitizeDirective):
 * - nudge 只開放 mood/stress/energy/wellbeing(±3)與 affinity(±2);
 *   satisfaction 是衍生公式、money 是房東代理權,一律不開放。
 * - behavior 只能從自發子集白名單選(adopt_cat 除外)、days 夾 1~2、
 *   已有進行中指令 → 丟棄、每租客冷卻 3 遊戲日、過期補寫(隔 >1 日)不套用。
 * - rel 的對象名字必須是現任租客且出現在今日素材,否則丟棄;delta 夾 ±2。
 * - 全部 delta、嚴格夾值;未知欄位丟棄;沒有任何內容 → 整包丟棄。
 * - 只在 AI 成功路徑套用(applyDiaryEffects),不消耗模擬 RNG,
 *   balance 快照與 headless 測試不受影響。
 */
import { clamp, gameDayIndex, GAME_START, pushSocialLog, state, type TenantRuntime } from "./gameState";
import { DIRECTIVES, sanitizeSelfBehavior, type DirectiveId } from "./directives";
import { adjustRelationship, getRel } from "./social";
import { sanitizeReasonText } from "./narrativeQuality";

/** 可推的數值軸與各自上限(affinity 進租金公式,量級對齊收租涓流 +0.6~1/日) */
const NUDGE_LIMITS = { mood: 3, stress: 3, energy: 3, wellbeing: 3, affinity: 2 } as const;
type NudgeStat = keyof typeof NUDGE_LIMITS;
const NUDGE_LABELS: Record<NudgeStat, string> = { mood: "心情", stress: "壓力", energy: "精力", wellbeing: "健康", affinity: "好感" };

/** 自發行為冷卻(遊戲日):AI 不能天天替房客做決定 */
const SELF_BEHAVIOR_COOLDOWN_DAYS = 3;

/** 關係推力上限:向上永遠推不過 74(自然相遇 75 才會觸發戀情/摯友線) */
const REL_LIMIT = 2;
const REL_CAP = 74;

export interface ObservationUpdate {
  nudge: Record<NudgeStat, number>;
  /** 自發行為(消毒後;null = 這次只有情緒微調) */
  behavior: { id: DirectiveId; days: number } | null;
  /** 跨租客關係推力(消毒後;套用時還要驗證對象存在且出現在今日素材) */
  rel: { name: string; delta: number } | null;
  reason: string;
}

const clampNum = (v: unknown, limit: number): number =>
  typeof v === "number" && isFinite(v) ? Math.max(-limit, Math.min(limit, Math.round(v))) : 0;

/** 消毒:夾值 + 白名單欄位;推力/行為/關係全空,或缺 reason → 整包丟棄(回 null) */
export function sanitizeObservation(raw: unknown): ObservationUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (r.nudge && typeof r.nudge === "object" ? r.nudge : {}) as Record<string, unknown>;
  const nudge = {} as Record<NudgeStat, number>;
  let any = false;
  for (const key of Object.keys(NUDGE_LIMITS) as NudgeStat[]) {
    nudge[key] = clampNum(n[key], NUDGE_LIMITS[key]);
    if (nudge[key] !== 0) any = true;
  }
  const behavior = sanitizeSelfBehavior(r.behavior);
  let rel: ObservationUpdate["rel"] = null;
  if (r.rel && typeof r.rel === "object") {
    const rr = r.rel as Record<string, unknown>;
    const name = typeof rr.name === "string" ? rr.name.trim().slice(0, 24) : "";
    const delta = clampNum(rr.delta, REL_LIMIT);
    if (name && delta !== 0) rel = { name, delta };
  }
  const reason = typeof r.reason === "string" ? sanitizeReasonText(r.reason) : "";
  if ((!any && !behavior && !rel) || !reason) return null;
  return { nudge, behavior, rel, reason };
}

/** 套用推力(含受限的關係推力)+ 寫 🔮 因果日誌;再嘗試自發行為(🌀 日誌)。
 *  diaryGameMs = 這篇日記所屬的遊戲時間:待補日記隔太久才升級時,行為反應已過時,只套數值不套行為。
 *  todayLog = 這篇日記的今日素材:關係推力的對象必須真的出現在素材裡,AI 不能憑空點名。 */
export function applyObservation(rt: TenantRuntime, obs: ObservationUpdate, diaryGameMs: number, todayLog: string[] = []) {
  const s = rt.tenant.stats;
  const parts: string[] = [];
  for (const key of Object.keys(NUDGE_LIMITS) as NudgeStat[]) {
    const d = obs.nudge[key];
    if (!d) continue;
    s[key] = clamp(s[key] + d, 0, 100);
    parts.push(`${NUDGE_LABELS[key]} ${d > 0 ? "+" : ""}${d}`);
  }
  const relPart = applyRelNudge(rt, obs.rel, todayLog);
  if (relPart) parts.push(relPart);
  if (parts.length) pushSocialLog(rt, `🔮 觀察影響:${obs.reason}(${parts.join("、")})`, "notable");
  if (obs.behavior) applySelfBehavior(rt, obs.behavior, obs.reason, diaryGameMs);
}

/** 受限的跨租客關係推力:對象必須是現任租客且出現在今日素材;向上推不過 REL_CAP(74)。
 *  回傳日誌片段(套用成功)或 null(任何防線擋下)。 */
function applyRelNudge(rt: TenantRuntime, rel: ObservationUpdate["rel"], todayLog: string[]): string | null {
  if (!rel) return null;
  const other = Object.values(state.runtimes).find(
    (o) => o.tenant.id !== rt.tenant.id && o.tenant.name === rel.name,
  );
  if (!other) return null;
  if (!todayLog.some((line) => line.includes(rel.name))) return null; // 今日素材沒出現這位鄰居 → 丟棄
  let d = rel.delta;
  if (d > 0) {
    const cur = getRel(rt.tenant.id, other.tenant.id)?.value ?? 0;
    d = Math.min(d, Math.max(0, REL_CAP - cur)); // 不得把關係「推」過戀愛/摯友門檻
    if (d <= 0) return null;
  }
  adjustRelationship(rt.tenant.id, other.tenant.id, d);
  return `與${other.tenant.name}的關係 ${d > 0 ? "+" : ""}${d}`;
}

/** 自發行為:通過全部防線才生效(進行中指令優先、3 日冷卻、過期補寫不套用)。
 *  不在此立即重定位(避免 observationEffects → tick 的循環 import);
 *  下一個 hourlyTick(≤1 遊戲小時)自然依新指令行動。 */
function applySelfBehavior(rt: TenantRuntime, behavior: { id: DirectiveId; days: number }, reason: string, diaryGameMs: number) {
  const today = gameDayIndex();
  const diaryDay = Math.floor((diaryGameMs - GAME_START.getTime()) / (24 * 3600 * 1000));
  if (today - diaryDay > 1) return; // 待補日記隔太久:過時的行為反應不補套
  if (rt.directive) return; // 已有進行中指令(不論來源):玩家拍板的永遠優先,也不疊自發
  if (today - (rt.lastSelfBehaviorDay ?? -99) < SELF_BEHAVIOR_COOLDOWN_DAYS) return;
  const def = DIRECTIVES[behavior.id];
  rt.directive = { id: behavior.id, untilDay: today + behavior.days, source: "ai" };
  rt.lastSelfBehaviorDay = today;
  pushSocialLog(rt, `🌀 ${reason}——${def.startText}`, "major");
}
