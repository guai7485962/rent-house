import type { Tenant } from "../types";

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

/**
 * 房客在當前狀態下的滿意度目標值。
 * tick 會讓實際 satisfaction 每小時朝此目標靠近 20%；UI 只讀它來說明趨勢。
 */
export function satisfactionTarget(stats: Tenant["stats"], needsMet: number): number {
  const base = clamp(
    0.25 * clamp(stats.mood) +
      0.3 * clamp(stats.affinity) +
      0.25 * (100 - clamp(stats.stress)) +
      0.1 * clamp(stats.wellbeing) +
      0.1 * clamp(stats.energy),
  );
  return clamp(base * (0.55 + 0.45 * clamp(needsMet, 0, 1)));
}
