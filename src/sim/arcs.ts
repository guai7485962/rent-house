/**
 * 劇情弧 StoryArc(設計檢討 §2):每位租客 0~1 條進行中的「連載」骨架,
 * AI 每日推進一步或收束。純敘事層——不帶任何數值效果,數值仍走事件三道關卡。
 *
 * 安全原則(同 AI 事件):AI 回的 arcUpdate 一律經 sanitizeArcUpdate 消毒——
 * 字串截斷、stage 只能前進最多 +1、maxStage 夾 2~6、進行中不准換主題。
 */

export interface StoryArc {
  id: string;
  /** 弧主題(例:「與貓的秘密同居」) */
  theme: string;
  /** 目前推進到第幾步(1 起算) */
  stage: number;
  maxStage: number;
  /** 這條弧的進展摘要(AI 每日回寫) */
  summary: string;
}

/** 消毒結果:開新弧 / 推進 / 收束;不合格回 null(整個忽略) */
export type ArcAction =
  | { kind: "start"; arc: StoryArc }
  | { kind: "advance"; arc: StoryArc }
  | { kind: "conclude"; theme: string };

const str = (v: unknown, cap: number): string => (typeof v === "string" ? v : "").slice(0, cap).trim();
const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * 把 AI 回的 arcUpdate 消毒成安全動作。
 * - 沒有進行中的弧:視為開新弧(theme 必填 2~14 字,stage 從 1 開始)。
 * - 有進行中的弧:只吃 stage(最多 +1,不能倒退)與 summary;id/theme/maxStage 鎖定,AI 不能中途換故事。
 * - done=true 或推進到 maxStage 且 done!==false → 收束。
 */
export function sanitizeArcUpdate(raw: unknown, current: StoryArc | null): ArcAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (!current) {
    const theme = str(r.theme, 14);
    if (theme.length < 2) return null; // 開新弧必須有像樣的主題
    const maxStage = int(r.maxStage, 2, 6, 3);
    return {
      kind: "start",
      arc: { id: `arc_${Date.now()}`, theme, stage: 1, maxStage, summary: str(r.summary, 160) },
    };
  }

  const stage = int(r.stage, current.stage, Math.min(current.stage + 1, current.maxStage), current.stage);
  const summary = str(r.summary, 160) || current.summary;
  if (r.done === true || (stage >= current.maxStage && r.done !== false)) {
    return { kind: "conclude", theme: current.theme };
  }
  return { kind: "advance", arc: { ...current, stage, summary } };
}
