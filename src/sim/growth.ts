/** 劇情弧收束後可獲得的永久成長特質。AI 只能選 id，效果與顯示文字都由本地白名單決定。 */

export interface GrowthTagDefinition {
  label: string;
  hint: string;
  baseline: { mood?: number; stress?: number };
}

export const GROWTH_TAGS = {
  more_confident: { label: "[更有自信]", hint: "經歷過挑戰後，更相信自己能處理下一個難題。", baseline: { mood: 3 } },
  resilient: { label: "[更能承受挫折]", hint: "遇到不順時比較能穩住情緒，不會立刻被壓垮。", baseline: { mood: 2, stress: -1 } },
  asks_for_help: { label: "[學會示弱]", hint: "願意承認需要幫忙，不再把所有壓力都悶在心裡。", baseline: { stress: -3 } },
  grounded: { label: "[腳步更穩]", hint: "知道自己能控制什麼，日常較不容易被焦慮拉走。", baseline: { stress: -2 } },
  hopeful: { label: "[重新抱有希望]", hint: "低潮過後仍願意期待下一件好事。", baseline: { mood: 3 } },
  patient: { label: "[更有耐心]", hint: "面對等待與摩擦時，較能留出轉圜空間。", baseline: { stress: -2 } },
  decisive: { label: "[更敢做決定]", hint: "做過艱難選擇後，面對猶豫時更能向前一步。", baseline: { mood: 2, stress: -1 } },
  lets_go: { label: "[學會放下]", hint: "接受有些事已經結束，不再反覆消耗自己。", baseline: { stress: -3 } },
} as const satisfies Record<string, GrowthTagDefinition>;

export type GrowthTagId = keyof typeof GROWTH_TAGS;
export const MAX_GROWTH_TAGS = 4;

export function sanitizeGrowthTagId(raw: unknown): GrowthTagId | null {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(GROWTH_TAGS, raw)
    ? raw as GrowthTagId
    : null;
}

/** 舊檔／匯入檔正規化：只留白名單、去重，並限制永久效果堆疊數。 */
export function sanitizeGrowthTags(raw: unknown): GrowthTagId[] {
  if (!Array.isArray(raw)) return [];
  const out: GrowthTagId[] = [];
  for (const item of raw) {
    const id = sanitizeGrowthTagId(item);
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_GROWTH_TAGS) break;
  }
  return out;
}

/** 授予一個永久成長特質；重複、未知或已達上限時不變更。 */
export function grantGrowthTag(holder: { growthTags?: GrowthTagId[] }, raw: unknown): GrowthTagDefinition | null {
  const current = sanitizeGrowthTags(holder.growthTags);
  holder.growthTags = current;
  const id = sanitizeGrowthTagId(raw);
  if (!id || current.includes(id) || current.length >= MAX_GROWTH_TAGS) return null;
  current.push(id);
  return GROWTH_TAGS[id];
}

/** 永久特質只改 homeostasis 基準，不直接修改當下數值。 */
export function growthBaselineDelta(raw: unknown): { mood: number; stress: number } {
  let mood = 0;
  let stress = 0;
  for (const id of sanitizeGrowthTags(raw)) {
    const baseline: GrowthTagDefinition["baseline"] = GROWTH_TAGS[id].baseline;
    mood += baseline.mood ?? 0;
    stress += baseline.stress ?? 0;
  }
  return { mood, stress };
}
