import type { Tenant } from "../types";

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

/**
 * 虧待度每一點壓低多少「滿意度目標」。
 *
 * 掛在 `target` 而不是掛脈衝:滿意度每小時朝目標靠近 20%,掛脈衝只留得下 ×0.21 的位移,
 * 一天內就被抹平(這正是四則規則事件從來不觸發的病根)。掛 target 才是 ×1 的真位移。
 *
 * 🔴 `dissatisfied` 的門檻是 `satisfaction < 30`,而 `tick.ts` 的不滿累積門檻是 `< 25`——
 * **`30 > 25` 這個嚴格不等式是設計契約**(警告事件必須先於退租倒數)。本係數只准調到
 * 讓虧待中的滿意度均衡值落在 30 上方一點、偶爾探底,不得把均衡值直接壓到 25 以下,
 * 否則玩家會來不及看到警告事件就被退租。
 */
export const NEGLECT_SATISFACTION_PER_POINT = 3;

/**
 * 房客在當前狀態下的滿意度目標值。
 * tick 會讓實際 satisfaction 每小時朝此目標靠近 20%；UI 只讀它來說明趨勢。
 *
 * `neglect`(虧待度 0~6,來自 `maintenance.neglectPoints`)是**第三個選填參數**:
 * 本檔是純函式模組,**不得 import `state`**——那會製造 `sim/*` 的循環 import
 * (見 `docs/系統總覽.md` 地雷紀錄)。所以比照 `baselines()` 的 comfort/communalQ 快取參數,
 * 由呼叫端算好傳進來。預設 0 ⇒ 舊呼叫端逐位元不變。
 */
export function satisfactionTarget(stats: Tenant["stats"], needsMet: number, neglect = 0): number {
  const base = clamp(
    0.25 * clamp(stats.mood) +
      0.3 * clamp(stats.affinity) +
      0.25 * (100 - clamp(stats.stress)) +
      0.1 * clamp(stats.wellbeing) +
      0.1 * clamp(stats.energy),
  );
  return clamp(base * (0.55 + 0.45 * clamp(needsMet, 0, 1)) - NEGLECT_SATISFACTION_PER_POINT * Math.max(0, neglect));
}
