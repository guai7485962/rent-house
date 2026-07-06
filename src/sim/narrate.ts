/**
 * 「每日 AI 敘事」的前端接縫。
 * narrateDay() 打同源 /api/narrate(由 Cloudflare Worker 呼叫 Claude)。
 * 無後端 / 無金鑰 / 離線時,自動 fallback 成模板日記,遊戲照跑。
 */

export interface NarrateCtx {
  name: string;
  occupation: string;
  bio: string;
  dayLabel: string;
  coreTags: string[];
  memoryTags: string[];
  stats: { mood: number; stress: number; affinity: number; satisfaction: number };
  todayLog: string[];
  relationships: string[];
  events: string[];
}

export interface NarrateResult {
  diary: string;
  newMemory: { label: string; hint: string } | null;
  ai: boolean; // 是否真的由 AI 生成(false=模板 fallback)
}

export async function narrateDay(ctx: NarrateCtx): Promise<NarrateResult> {
  try {
    const res = await fetch("/api/narrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
    });
    if (res.ok) {
      const data = (await res.json()) as { diary?: string; newMemory?: { label: string; hint: string } | null };
      if (data.diary) return { diary: data.diary, newMemory: data.newMemory ?? null, ai: true };
    }
  } catch {
    /* 離線 / 無後端 → 走 fallback */
  }
  return { diary: templateDiary(ctx), newMemory: null, ai: false };
}

const MOOD_PHRASE = (s: NarrateCtx["stats"]) =>
  s.stress >= 75 ? "壓力全寫在臉上" : s.mood >= 68 ? "看起來心情不錯" : s.satisfaction < 35 ? "顯得有些心不在焉" : "如常地過了一天";

/** 無 AI 時的模板日記:用當天重點拼一段 */
export function templateDiary(ctx: NarrateCtx): string {
  const parts: string[] = [`${ctx.dayLabel},${ctx.name}${MOOD_PHRASE(ctx.stats)}。`];
  if (ctx.events.length) parts.push(ctx.events[0].replace(/^【.*?】/, "").trim() + "。");
  else if (ctx.relationships.length) parts.push(`和鄰居的關係:${ctx.relationships[0]}。`);
  else if (ctx.todayLog.length) parts.push(ctx.todayLog[ctx.todayLog.length - 1]);
  return parts.join("");
}
