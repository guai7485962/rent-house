/**
 * 「每日 AI 敘事」的前端接縫。
 * narrateDay() 打同源 /api/narrate(由 Cloudflare Worker 呼叫 Claude)。
 * 無後端 / 無金鑰 / 離線時,自動 fallback 成模板日記,遊戲照跑。
 */

import { DAILY_TEMPLATES } from "../content/observationLines";

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
  /** 同棟其他在住租客的名字(讓 AI 能點名鄰居製造跨租客劇情) */
  neighbors: string[];
  /** 滾動劇情摘要(上次 AI 回寫的 summaryUpdate)——跨日連貫性的關鍵 */
  summary: string;
}

export interface NarrateResult {
  diary: string;
  newMemory: { label: string; hint: string } | null;
  /** AI 依當前處境可選附上的原始抉擇事件(由 store 消毒夾值後才採用) */
  event: unknown;
  /** AI 回寫的新劇情摘要(取代舊摘要,下次餵回去);null = 沿用舊的 */
  summaryUpdate: string | null;
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
      const data = (await res.json()) as {
        diary?: string;
        newMemory?: { label: string; hint: string } | null;
        event?: unknown;
        summaryUpdate?: string | null;
      };
      if (data.diary)
        return {
          diary: data.diary,
          newMemory: data.newMemory ?? null,
          event: data.event ?? null,
          summaryUpdate: typeof data.summaryUpdate === "string" ? data.summaryUpdate.slice(0, 220).trim() || null : null,
          ai: true,
        };
    }
  } catch {
    /* 離線 / 無後端 → 走 fallback */
  }
  return { diary: templateDiary(ctx), newMemory: null, event: null, summaryUpdate: null, ai: false };
}

/** 無 AI 時的模板日記:從多樣模板庫隨機挑一句 + 補上當天重點 */
export function templateDiary(ctx: NarrateCtx): string {
  const tpl = DAILY_TEMPLATES[Math.floor(Math.random() * DAILY_TEMPLATES.length)]
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{time\}/g, "夜裡");
  const parts: string[] = [tpl];
  if (ctx.events.length) parts.push(ctx.events[0].replace(/^【.*?】/, "").trim() + "。");
  else if (ctx.relationships.length) parts.push(`和鄰居:${ctx.relationships[0]}。`);
  return parts.join("");
}
