/**
 * 「每日 AI 敘事」的前端接縫。
 * narrateDay() 打同源 /api/narrate(由 Cloudflare Worker 呼叫 Workers AI／Gemini)。
 * 無後端 / 無金鑰 / 離線時,自動 fallback 成模板日記,遊戲照跑。
 */

import {
  DAILY_CAFE_TEMPLATES,
  DAILY_HAPPY_TEMPLATES,
  DAILY_LOW_MOOD_TEMPLATES,
  DAILY_SOCIAL_TEMPLATES,
  DAILY_STRESS_TEMPLATES,
  DAILY_TEMPLATES,
  DAILY_WEATHER_TEMPLATES,
  DAILY_WEEKEND_TEMPLATES,
} from "../content/observationLines";
import { sanitizeDiaryText, sanitizeSummaryText } from "./narrativeQuality";

export interface NarrativeTagDetail {
  label: string;
  hint: string;
  kind: "core" | "memory";
  /** 記憶強度；核心標籤固定視為 1。 */
  intensity: number;
  source?: "ai_event" | "landlord_decision" | "system";
}

export interface NarrativeHighlight {
  text: string;
  importance: "minor" | "notable" | "major";
  source: "log" | "decision";
}

export interface NarrativeFocus {
  kind: "decision" | "major" | "arc" | "notable" | "flag" | "wish" | "daily";
  headline: string;
  /** 說明為何這條線優先，讓模型不要自行改選次要素材。 */
  reason: string;
}

/**
 * 🔴 D 批:樓下寵物咖啡廳的當日背景。**唯讀** —— AI 不得回寫任何咖啡廳狀態。
 *
 * 全部欄位在 app 端(`narration.ts` 的 `buildCafeNarrateCtx()`)已消毒 + 夾長,
 * worker 端 `clampCafeCtx()` 會再夾一次(**不信任前端**:`state.pendingDiaries[].ctx`
 * 是整份存進 localStorage 的 ctx,載入時完全不消毒就原封 POST,那是真實存在的繞道)。
 *
 * ⚠️ 這個型別**刻意沒有** `age` / `isAdult` / `gender` / `attractedTo` 任何一欄:
 * `CafeRegular` 本來就沒有年齡與取向欄位,這裡也不新增 ⇒ 既有「未成年排除戀愛線」
 * 規則無從被咖啡廳這條路繞過。`cafe-narrate-ctx-test.ts` 有原始碼掃描斷言釘住。
 */
export interface NarrateCafeCtx {
  /** 一句話營運概況,≤48 字,無換行。空字串 = 整個 cafe 不送。 */
  brief: string;
  /** 聲譽走向。 */
  trend: "up" | "flat" | "down";
  /** 熟客素材,≤2 條、每條 ≤28 字。**已排除與現任租客同名者**。 */
  regulars: string[];
  /** 經營痕跡,≤28 字。 */
  ops?: string;
  /** 寵物線,≤28 字。 */
  pets?: string;
}

export interface NarrateCtx {
  name: string;
  occupation: string;
  bio: string;
  dayLabel: string;
  coreTags: string[];
  memoryTags: string[];
  /** 給新版敘事模型的結構化標籤；字串陣列保留供舊 Worker 相容。 */
  tagDetails?: NarrativeTagDetail[];
  /** 已獲得的永久成長特質(label)；讓 AI 避免重複授予。 */
  growthTags?: string[];
  stats: { mood: number; stress: number; affinity: number; satisfaction: number };
  /** 房間實際聲學狀態；讓 AI 不會在隔音完成後又捏造室內噪音抗議。 */
  room: { noise: number; soundproof: number; treated: boolean; complaintRisk: boolean };
  todayLog: string[];
  /** 已依重要性選材、近似去重的今日證據。 */
  todayHighlights?: NarrativeHighlight[];
  /** 程式先決定的唯一敘事主線。 */
  focus?: NarrativeFocus;
  relationships: string[];
  events: string[];
  /** 同棟其他在住租客的名字(讓 AI 能點名鄰居製造跨租客劇情) */
  neighbors: string[];
  /** 滾動劇情摘要(上次 AI 回寫的 summaryUpdate)——跨日連貫性的關鍵 */
  summary: string;
  /** 進行中的劇情弧(連載骨架;null = 沒有進行中的弧,AI 可開新弧;with = 雙人弧的另一位主角) */
  arc: { theme: string; stage: number; maxStage: number; summary: string; with?: string | null } | null;
  /** 本地規則推進的支線；只供敘事參考,AI 的 arcUpdate 不得操作它。 */
  sideArc?: { theme: string; stage: number; maxStage: number; summary: string } | null;
  /** 已完結的劇情弧主題(最近數條;讓 AI 開新弧時避開演過的題材。舊 ctx 缺省 = 不進 prompt) */
  pastArcThemes?: string[];
  /** 事件連鎖伏筆旗標(事件選項留下的,AI 用來回收伏筆) */
  flags: string[];
  /** 事件冷卻已結束；AI 可在同一次日記請求中順便產生房東抉擇事件。 */
  eventDue: boolean;
  /** 今日天氣(顯示用 label,例「🌧️ 雨天」;舊待補 ctx 缺省 = 不提天氣) */
  weather?: string;
  /** 今天星期幾(顯示用 label,例「週五」;舊待補 ctx 缺省 = 不提星期) */
  weekday?: string;
  /** 財務狀況一句話(欠租/拮据;缺省/空 = 一切正常,不進 prompt) */
  finance?: string;
  /** 人生心願一句話(長期目標與進度;缺省 = 不進 prompt;進度由本地決定,AI 只能當動機素材) */
  wish?: string;
  /** 樓下咖啡廳的當日背景(唯讀;舊 ctx 缺省 = 不進 prompt,同 weather/wish 慣例) */
  cafe?: NarrateCafeCtx;
}

export type AiProvider = "gemini-flash" | "gemini-flash-lite" | "workers-ai-qwen" | "workers-ai-llama" | "claude";
export type AiFallbackReason =
  | "catchup" | "quota" | "offline" | "no_key" | "forbidden" | "parse" | "upstream" | "unknown"
  // 🔴 H 批新增:讓「為什麼還沒補上」不再無聲。前六個是既有語意,不改字面;以下四個是新的。
  /** 請求超過 narrateTiming.timeoutMs 仍未回 → AbortController 中止(管線不會卡死) */
  | "timeout"
  /** 上一輪升級還在跑,這次請求排隊等它(正常狀態,不是壞掉) */
  | "busy"
  /** 分頁在背景 → 暫停升級,回到前景自動恢復(正常狀態,不是壞掉) */
  | "hidden"
  /** 今日升級次數(DEFERRED_DAILY_BUDGET)已用完,換遊戲日自動重置 */
  | "budget"
  /** context 組裝或日記產生時丟例外 → 降級成安全模板(不該發生,出現代表存檔有髒資料) */
  | "internal";

export interface NarrateResult {
  diary: string;
  newMemory: { label: string; hint: string } | null;
  /** AI 依當前處境可選附上的原始抉擇事件(由 store 消毒夾值後才採用) */
  event: unknown;
  /** AI 回寫的新劇情摘要(取代舊摘要,下次餵回去);null = 沿用舊的 */
  summaryUpdate: string | null;
  /** AI 回的原始劇情弧更新(由 sim/arcs 消毒後才採用);null = 不動 */
  arcUpdate: unknown;
  /** AI 回的原始每日情緒微調(由 sim/observationEffects 消毒夾值後才採用);缺省/null = 不動 */
  observation?: unknown;
  ai: boolean; // 是否真的由 AI 生成(false=模板 fallback)
  /** true = 這次 fallback 是因為 AI 每日額度用盡(前端可提示玩家) */
  quota?: boolean;
  provider?: AiProvider;
  fallbackReason?: AiFallbackReason;
}

/** fetch 逾時(毫秒)。worker 端本身有重試與 70 秒 quota sleep,設太短會誤殺正常的慢回應;
 *  但**一定要有**——沒有逾時的 fetch 只要一次不回來,resumeDeferredDiaries() 的
 *  deferredRun 就永遠不 settle,之後每次升級都在第一行 return,升級管線永久卡死到重新整理。
 *  測試可覆寫。 */
export const narrateTiming = { timeoutMs: 45_000 };

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
  // 🔴 H 批:逾時守門。AbortController 缺席(極舊環境)時退回無逾時的舊行為,不讓 narrate 直接壞掉。
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, narrateTiming.timeoutMs)
    : null;
  try {
    const res = await fetch("/api/narrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
      ...(controller ? { signal: controller.signal } : {}),
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
        observation?: unknown;
        provider?: AiProvider;
      };
      const expectedNames = [ctx.name, ...ctx.neighbors];
      if (data.diary)
        return {
          diary: sanitizeDiaryText(data.diary, expectedNames) || templateDiary(ctx),
          newMemory: data.newMemory ?? null,
          event: data.event ?? null,
          summaryUpdate: typeof data.summaryUpdate === "string" ? sanitizeSummaryText(data.summaryUpdate, expectedNames) || null : null,
          arcUpdate: data.arcUpdate ?? null,
          observation: data.observation ?? null,
          ai: true,
          provider: data.provider,
        };
    }
  } catch {
    // abort 也會走到這裡:逾時與真正的離線要分開標,玩家才知道是「AI 太慢」還是「沒網路」
    fallbackReason = timedOut ? "timeout" : "offline";
    /* 離線 / 無後端 / 逾時 → 走 fallback */
  } finally {
    // 成功、失敗、逾時三條路都會經過:計時器一定清掉,promise 一定 settle
    if (timer !== null) clearTimeout(timer);
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
  // 週末情境句:週六/週日混入(平日與缺省不混;放在天氣句前,維持天氣句在池尾的既有測試假設)
  if (ctx.weekday === "週六" || ctx.weekday === "週日") pool.push(...DAILY_WEEKEND_TEMPLATES);
  // 🔴 D 批:咖啡廳情境句。**只有真的有話可說時才混入**(有熟客素材、或聲譽走向不是持平)。
  // 這裡改變 pool.length 就會改變唯一那次抽樣的結果 —— 但 balance 快照局永遠不開張、
  // `ctx.cafe` 全程 undefined ⇒ pool 不變 ⇒ 抽樣序列位元相同(有測試明文斷言)。
  if (ctx.cafe && ((ctx.cafe.regulars?.length ?? 0) > 0 || ctx.cafe.trend !== "flat")) pool.push(...DAILY_CAFE_TEMPLATES);
  // 天氣情境句:依 ctx.weather 的 label 對回句池(缺省不混入)
  if (ctx.weather) {
    if (ctx.weather.includes("雨")) pool.push(...DAILY_WEATHER_TEMPLATES.rainy);
    else if (ctx.weather.includes("悶熱")) pool.push(...DAILY_WEATHER_TEMPLATES.sweltering);
    else if (ctx.weather.includes("晴")) pool.push(...DAILY_WEATHER_TEMPLATES.sunny);
    else if (ctx.weather.includes("陰")) pool.push(...DAILY_WEATHER_TEMPLATES.cloudy);
  }
  const tpl = pool[Math.floor(Math.random() * pool.length)]
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{time\}/g, "夜裡");
  const parts: string[] = [tpl];
  if (ctx.events.length) parts.push(ctx.events[0].replace(/^【.*?】/, "").trim() + "。");
  else if (ctx.relationships.length) parts.push(`和鄰居:${ctx.relationships[0]}。`);
  return parts.join("");
}
