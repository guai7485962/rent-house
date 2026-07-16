/**
 * 劇情弧 StoryArc(設計檢討 §2):每位租客 0~1 條進行中的「連載」骨架,
 * AI 每日推進一步或收束。
 *
 * 安全原則(同 AI 事件):AI 回的 arcUpdate 一律經 sanitizeArcUpdate 消毒——
 * 字串截斷、stage 只能前進最多 +1、maxStage 夾 2~6、進行中不准換主題。
 *
 * arc tone(AI 觀察回饋第三期):推進/收束可附 tone(enum 白名單,未知值忽略),
 * 轉成固定的小幅 mood/stress 脈衝——連載劇情反映在數值曲線上,弧不再只是文字。
 * 脈衝表寫死在 ARC_TONE_PULSE,AI 只能選方向、不能自訂數值。
 * 收束時另可選一個 growthTag 白名單 id；永久效果同樣由本地固定表決定。
 */

import { sanitizeGrowthTagId, type GrowthTagId } from "./growth";

export interface StoryArc {
  id: string;
  /** 弧主題(例:「與貓的秘密同居」) */
  theme: string;
  /** 目前推進到第幾步(1 起算) */
  stage: number;
  maxStage: number;
  /** 這條弧的進展摘要(AI 每日回寫) */
  summary: string;
  /** 雙人弧:另一位主角(兩位租客各持一份同 id 的弧,推進/收束互相同步;缺省 = 單人弧) */
  partnerId?: string;
  partnerName?: string;
}

/** 這一步對租客情緒的方向(AI 只能從 enum 選;省略/未知 = 無脈衝) */
export type ArcTone = "up" | "down" | "tense";

/** tone → mood/stress 脈衝(寫死;推進小步、收束較大的收尾情緒) */
export const ARC_TONE_PULSE: Record<"advance" | "conclude", Record<ArcTone, { mood?: number; stress?: number }>> = {
  advance: { up: { mood: 3 }, down: { mood: -3 }, tense: { stress: 4 } },
  conclude: { up: { mood: 8, stress: -6 }, down: { mood: -8 }, tense: { stress: -8 } }, // tense 收束 = 如釋重負
};

/** 消毒結果:開新弧 / 推進 / 收束;不合格回 null(整個忽略) */
export type ArcAction =
  | { kind: "start"; arc: StoryArc; withName: string | null }
  | { kind: "advance"; arc: StoryArc; tone: ArcTone | null }
  | { kind: "conclude"; theme: string; tone: ArcTone | null; growthTag: GrowthTagId | null };

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
      // 雙人弧候選對象:只截字串;是否成立(對方存在/沒有進行中的弧/關係夠熟)由 applyArcUpdate 把關
      withName: str(r.with, 20) || null,
    };
  }

  const stage = int(r.stage, current.stage, Math.min(current.stage + 1, current.maxStage), current.stage);
  const summary = str(r.summary, 160) || current.summary;
  const tone: ArcTone | null = r.tone === "up" || r.tone === "down" || r.tone === "tense" ? r.tone : null;
  if (r.done === true || (stage >= current.maxStage && r.done !== false)) {
    return { kind: "conclude", theme: current.theme, tone, growthTag: sanitizeGrowthTagId(r.growthTag) };
  }
  return { kind: "advance", arc: { ...current, stage, summary }, tone };
}
