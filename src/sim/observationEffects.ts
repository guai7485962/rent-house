/**
 * AI 觀察回饋(docs/AI觀察回饋設計.md)。
 * 第一期 statNudge:AI 在每日 narrate 回應附上 observation(對今天素材的「情緒解讀」),
 * 消毒夾值後小幅推動租客數值,並寫一行 🔮 日誌讓玩家看到因果。
 * 第二期 selfBehavior:observation 可再附 behavior——「房客自己的決定」,
 * 不需玩家拍板,直接讓他 1~2 天的行為看得見地改變(🌀 日誌),玩家拍板的指令永遠優先。
 *
 * 硬規則(比照 cleanEffect / sanitizeDirective):
 * - nudge 只開放 mood/stress/energy/wellbeing(±3)與 affinity(±2);
 *   satisfaction 是衍生公式、money 是房東代理權,一律不開放。
 * - behavior 只能從自發子集白名單選(adopt_cat 除外)、days 夾 1~2、
 *   已有進行中指令 → 丟棄、每租客冷卻 3 遊戲日、過期補寫(隔 >1 日)不套用。
 * - 全部 delta、嚴格夾值;未知欄位丟棄;沒有任何內容 → 整包丟棄。
 * - 只在 AI 成功路徑套用(applyDiaryEffects),不消耗模擬 RNG,
 *   balance 快照與 headless 測試不受影響。
 */
import { clamp, gameDayIndex, GAME_START, pushSocialLog, type TenantRuntime } from "./gameState";
import { DIRECTIVES, sanitizeSelfBehavior, type DirectiveId } from "./directives";

/** 可推的數值軸與各自上限(affinity 進租金公式,量級對齊收租涓流 +0.6~1/日) */
const NUDGE_LIMITS = { mood: 3, stress: 3, energy: 3, wellbeing: 3, affinity: 2 } as const;
type NudgeStat = keyof typeof NUDGE_LIMITS;
const NUDGE_LABELS: Record<NudgeStat, string> = { mood: "心情", stress: "壓力", energy: "精力", wellbeing: "健康", affinity: "好感" };

/** 自發行為冷卻(遊戲日):AI 不能天天替房客做決定 */
const SELF_BEHAVIOR_COOLDOWN_DAYS = 3;

export interface ObservationUpdate {
  nudge: Record<NudgeStat, number>;
  /** 自發行為(消毒後;null = 這次只有情緒微調) */
  behavior: { id: DirectiveId; days: number } | null;
  reason: string;
}

const clampNum = (v: unknown, limit: number): number =>
  typeof v === "number" && isFinite(v) ? Math.max(-limit, Math.min(limit, Math.round(v))) : 0;

/** 消毒:夾值 + 白名單欄位;沒有任何非零推力也沒有合法行為,或缺 reason → 整包丟棄(回 null) */
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
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 60) : "";
  if ((!any && !behavior) || !reason) return null;
  return { nudge, behavior, reason };
}

/** 套用推力 + 寫 🔮 因果日誌;再嘗試自發行為(🌀 日誌)。
 *  diaryGameMs = 這篇日記所屬的遊戲時間:待補日記隔太久才升級時,行為反應已過時,只套數值不套行為。 */
export function applyObservation(rt: TenantRuntime, obs: ObservationUpdate, diaryGameMs: number) {
  const s = rt.tenant.stats;
  const parts: string[] = [];
  for (const key of Object.keys(NUDGE_LIMITS) as NudgeStat[]) {
    const d = obs.nudge[key];
    if (!d) continue;
    s[key] = clamp(s[key] + d, 0, 100);
    parts.push(`${NUDGE_LABELS[key]} ${d > 0 ? "+" : ""}${d}`);
  }
  if (parts.length) pushSocialLog(rt, `🔮 觀察影響:${obs.reason}(${parts.join("、")})`, "notable");
  if (obs.behavior) applySelfBehavior(rt, obs.behavior, obs.reason, diaryGameMs);
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
