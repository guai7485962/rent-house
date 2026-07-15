/**
 * 「每日 AI 敘事」的前端接縫。
 * narrateDay() 打同源 /api/narrate(由 Cloudflare Worker 呼叫 Workers AI／Gemini)。
 * 無後端 / 無金鑰 / 離線時,自動 fallback 成模板日記,遊戲照跑。
 */

import {
  DAILY_HAPPY_TEMPLATES,
  DAILY_LOW_MOOD_TEMPLATES,
  DAILY_SOCIAL_TEMPLATES,
  DAILY_STRESS_TEMPLATES,
  DAILY_TEMPLATES,
} from "../content/observationLines";
import { sanitizeDiaryText, sanitizeSummaryText } from "./narrativeQuality";

export interface NarrateCtx {
  name: string;
  occupation: string;
  bio: string;
  dayLabel: string;
  coreTags: string[];
  memoryTags: string[];
  stats: { mood: number; stress: number; affinity: number; satisfaction: number };
  /** 房間實際聲學狀態；讓 AI 不會在隔音完成後又捏造室內噪音抗議。 */
  room: { noise: number; soundproof: number; treated: boolean; complaintRisk: boolean };
  todayLog: string[];
  relationships: string[];
  events: string[];
  /** 同棟其他在住租客的名字(讓 AI 能點名鄰居製造跨租客劇情) */
  neighbors: string[];
  /** 滾動劇情摘要(上次 AI 回寫的 summaryUpdate)——跨日連貫性的關鍵 */
  summary: string;
  /** 進行中的劇情弧(連載骨架;null = 沒有進行中的弧,AI 可開新弧) */
  arc: { theme: string; stage: number; maxStage: number; summary: string } | null;
  /** 事件連鎖伏筆旗標(事件選項留下的,AI 用來回收伏筆) */
  flags: string[];
  /** 事件冷卻已結束；AI 可在同一次日記請求中順便產生房東抉擇事件。 */
  eventDue: boolean;
}

export type AiProvider = "gemini-flash" | "gemini-flash-lite" | "workers-ai-qwen" | "workers-ai-llama" | "claude";
export type AiFallbackReason = "catchup" | "quota" | "offline" | "no_key" | "forbidden" | "parse" | "upstream" | "unknown";

export interface NarrateResult {
  diary: string;
  newMemory: { label: string; hint: string } | null;
  /** AI 依當前處境可選附上的原始抉擇事件(由 store 消毒夾值後才採用) */
  event: unknown;
  /** AI 回寫的新劇情摘要(取代舊摘要,下次餵回去);null = 沿用舊的 */
  summaryUpdate: string | null;
  /** AI 回的原始劇情弧更新(由 sim/arcs 消毒後才採用);null = 不動 */
  arcUpdate: unknown;
  ai: boolean; // 是否真的由 AI 生成(false=模板 fallback)
  /** true = 這次 fallback 是因為 AI 每日額度用盡(前端可提示玩家) */
  quota?: boolean;
  provider?: AiProvider;
  fallbackReason?: AiFallbackReason;
}

function classifyFailure(status: number, error?: string): AiFallbackReason {
  if (error === "quota" || status === 429) return "quota";
  if (error === "no_key" || status === 503) return "no_key";
  if (status === 401 || status === 403) return "forbidden";
  if (error === "parse_failed") return "parse";
  if (status >= 500) return "upstream";
  return "unknown";
}

export async function narrateDay(ctx: NarrateCtx): Promise<NarrateResult> {
  let quota = false;
  let fallbackReason: AiFallbackReason = "unknown";
  try {
    const res = await fetch("/api/narrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
    });
    if (!res.ok) {
      try {
        const error = ((await res.json()) as { error?: string }).error;
        fallbackReason = classifyFailure(res.status, error);
        quota = fallbackReason === "quota";
      } catch {
        fallbackReason = classifyFailure(res.status);
      }
    }
    if (res.ok) {
      const data = (await res.json()) as {
        diary?: string;
        newMemory?: { label: string; hint: string } | null;
        event?: unknown;
        summaryUpdate?: string | null;
        arcUpdate?: unknown;
        provider?: AiProvider;
      };
      if (data.diary)
        return {
          diary: sanitizeDiaryText(data.diary) || templateDiary(ctx),
          newMemory: data.newMemory ?? null,
          event: data.event ?? null,
          summaryUpdate: typeof data.summaryUpdate === "string" ? sanitizeSummaryText(data.summaryUpdate) || null : null,
          arcUpdate: data.arcUpdate ?? null,
          ai: true,
          provider: data.provider,
        };
    }
  } catch {
    fallbackReason = "offline";
    /* 離線 / 無後端 → 走 fallback */
  }
  return { diary: templateDiary(ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false, quota, fallbackReason };
}

/** 無 AI 時的模板日記:從多樣模板庫隨機挑一句 + 補上當天重點 */
export function templateDiary(ctx: NarrateCtx): string {
  // 依當日狀態把情境句混進候選池，但仍然只抽一次亂數，避免影響其後模擬的 RNG 次序。
  const pool = [...DAILY_TEMPLATES];
  if (ctx.stats.stress >= 70) pool.push(...DAILY_STRESS_TEMPLATES);
  if (ctx.stats.mood <= 35) pool.push(...DAILY_LOW_MOOD_TEMPLATES);
  if (ctx.stats.mood >= 75 && ctx.stats.stress <= 55) pool.push(...DAILY_HAPPY_TEMPLATES);
  if (ctx.relationships.length) pool.push(...DAILY_SOCIAL_TEMPLATES);
  const tpl = pool[Math.floor(Math.random() * pool.length)]
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{time\}/g, "夜裡");
  const parts: string[] = [tpl];
  if (ctx.events.length) parts.push(ctx.events[0].replace(/^【.*?】/, "").trim() + "。");
  else if (ctx.relationships.length) parts.push(`和鄰居:${ctx.relationships[0]}。`);
  return parts.join("");
}
