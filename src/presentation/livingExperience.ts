import { satisfactionTarget } from "../sim/satisfaction";

export { satisfactionTarget };

export interface LivingStats {
  mood: number;
  stress: number;
  energy: number;
  wellbeing: number;
  affinity: number;
}

export type LivingTone = "danger" | "watch" | "steady" | "good";

export interface LivingExperienceInput {
  stats: LivingStats;
  satisfaction: number;
  comfort: number;
  cleanliness: number;
  needsMet: number;
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

/**
 * 「身心狀態」只是一個 UI 摘要，不參與模擬。
 * 權重直接沿用滿意度公式中的四個身心項目，再正規化為 0~100。
 */
export function mindBodyScore(stats: LivingStats): number {
  const weighted =
    0.25 * clamp(stats.mood) +
    0.25 * (100 - clamp(stats.stress)) +
    0.1 * clamp(stats.wellbeing) +
    0.1 * clamp(stats.energy);
  return Math.round(clamp(weighted / 0.7));
}

export function livingTone(score: number): LivingTone {
  const value = clamp(score);
  if (value < 35) return "danger";
  if (value < 55) return "watch";
  if (value < 75) return "steady";
  return "good";
}

/** 續住意願使用真實退租安全線：只有 <25 才會開始累積 unhappyHours。 */
export function retentionTone(score: number): LivingTone {
  const value = clamp(score);
  if (value < 25) return "danger";
  if (value < 45) return "watch";
  if (value < 75) return "steady";
  return "good";
}

export function retentionLabel(score: number): string {
  switch (retentionTone(score)) {
    case "danger": return "有退租風險";
    case "watch": return "仍在觀望";
    case "steady": return "願意續住";
    case "good": return "住得很安心";
  }
}

/**
 * 顯示當前狀態與改善方向；只讀取既有數值，不建立新狀態。
 * 優先列出玩家可採取行動的負面因素，狀況穩定時才顯示正向摘要。
 */
export function livingInfluenceNotes(input: LivingExperienceInput): string[] {
  const { stats, satisfaction, comfort, cleanliness, needsMet } = input;
  const notes: string[] = [];
  const target = satisfactionTarget(stats, needsMet);

  if (target - satisfaction >= 8) notes.push("目前狀態已改善，續住意願正在逐步回升");
  else if (satisfaction - target >= 8) notes.push("目前狀態轉差，續住意願可能逐步下降");

  if (stats.stress >= 75) notes.push("壓力偏高，正在拉低續住意願");
  if (stats.energy <= 30) notes.push("精力不足，需要休息恢復");
  if (stats.mood <= 40) notes.push("心情低落，留意最近的事件與關係");
  if (stats.wellbeing <= 40) notes.push("健康不佳，長期會影響居住感受");
  if (stats.affinity < 45) notes.push("房東信任偏低，多關心或妥善處理事件");
  if (cleanliness < 50) notes.push("房間髒亂，舒適效果正在被打折");
  if (comfort < 40) notes.push("房間品質偏低，添購合適家具可改善");
  if (needsMet < 0.8) notes.push("生活機能不完整，部分日常活動找不到設備");

  if (notes.length > 0) return notes.slice(0, 3);
  if (stats.affinity >= 75 && comfort >= 60) return ["信任與房間品質都很穩定，維持下去有利於長期續住"];
  return ["目前沒有明顯警訊；續住意願會隨日常狀態緩慢變化"];
}
