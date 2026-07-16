/**
 * AI 觀察回饋第一期(docs/AI觀察回饋設計.md):每日情緒微調 statNudge。
 * AI 在每日 narrate 回應附上 observation(對今天素材的「情緒解讀」),
 * 消毒夾值後小幅推動租客數值,並寫一行 🔮 日誌讓玩家看到因果。
 *
 * 硬規則(比照 cleanEffect / sanitizeDirective):
 * - 只開放 mood/stress/energy/wellbeing(±3)與 affinity(±2);
 *   satisfaction 是衍生公式、money 是房東代理權,一律不開放。
 * - 全部 delta、嚴格夾值;未知欄位丟棄;沒有任何非零推力 → 整包丟棄。
 * - 只在 AI 成功路徑套用(applyDiaryEffects),不消耗模擬 RNG,
 *   balance 快照與 headless 測試不受影響。
 */
import { clamp, pushSocialLog, type TenantRuntime } from "./gameState";

/** 可推的數值軸與各自上限(affinity 進租金公式,量級對齊收租涓流 +0.6~1/日) */
const NUDGE_LIMITS = { mood: 3, stress: 3, energy: 3, wellbeing: 3, affinity: 2 } as const;
type NudgeStat = keyof typeof NUDGE_LIMITS;
const NUDGE_LABELS: Record<NudgeStat, string> = { mood: "心情", stress: "壓力", energy: "精力", wellbeing: "健康", affinity: "好感" };

export interface ObservationUpdate {
  nudge: Record<NudgeStat, number>;
  reason: string;
}

const clampNum = (v: unknown, limit: number): number =>
  typeof v === "number" && isFinite(v) ? Math.max(-limit, Math.min(limit, Math.round(v))) : 0;

/** 消毒:夾值 + 白名單欄位;沒有任何非零推力或缺 reason 就整包丟棄(回 null) */
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
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 60) : "";
  if (!any || !reason) return null;
  return { nudge, reason };
}

/** 套用推力 + 寫 🔮 因果日誌(玩家在房間日誌/Feed 看得到「為什麼」) */
export function applyObservation(rt: TenantRuntime, obs: ObservationUpdate) {
  const s = rt.tenant.stats;
  const parts: string[] = [];
  for (const key of Object.keys(NUDGE_LIMITS) as NudgeStat[]) {
    const d = obs.nudge[key];
    if (!d) continue;
    s[key] = clamp(s[key] + d, 0, 100);
    parts.push(`${NUDGE_LABELS[key]} ${d > 0 ? "+" : ""}${d}`);
  }
  if (!parts.length) return;
  pushSocialLog(rt, `🔮 觀察影響:${obs.reason}(${parts.join("、")})`, "notable");
}
