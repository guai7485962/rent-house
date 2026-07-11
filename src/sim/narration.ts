/**
 * 每日 AI 敘事(store 拆分:narration 模組)。
 * 換日時為每位租客產生一篇日記(live 走 /api/narrate、否則模板),
 * 並把 AI 回傳的新記憶/抉擇事件消毒後接進遊戲。
 * (設計檢討 §1 的連續性摘要、narrate 佇列/節流之後也放這裡。)
 */
import { narrateDay, templateDiary, type NarrateCtx, type NarrateResult } from "./narrate";
import { sanitizeAiEvent } from "./events";
import { sanitizeArcUpdate } from "./arcs";
import { listRelationships } from "./social";
import { state, fmt, gameDayIndex, pushMemory, pushSocialLog, notify, LOG_CAP, type TenantRuntime } from "./gameState";
import { save } from "./persistence";

/** 日記佇列節奏(測試可調):
 *  gapMs = 每位租客間隔(把整批打散,避免撞 Gemini 免費層每分鐘限流,也讓日記「一篇篇出爐」);
 *  retryMs = 收到 429 後的重試等待(429 常常只是每分鐘限流,不是當日額度用盡——等窗口過再試一次) */
export const diaryTiming = { gapMs: 25_000, retryMs: 70_000 };

/** 額度提示只彈一次(下次 AI 成功時重置,額度恢復又能提示) */
let quotaNoticeShown = false;
/** 重試後仍 429 → 視為當日額度真的用盡,這批剩下的直接走模板(換日重置再試) */
let quotaHold = false;

/** 測試注入點:替換實際的 narrate 呼叫 */
let narrateImpl: (ctx: NarrateCtx) => Promise<NarrateResult> = narrateDay;
export function setNarrateImplForTest(fn: typeof narrateImpl) {
  narrateImpl = fn;
}

interface DiaryJob {
  id: string;
  gameMs: number; // 入列當下的遊戲時間(日記要落在正確的那一天)
  ctx: NarrateCtx; // 入列當下就組好 context(快轉時延後生成也不會拿到隔天的狀態)
  live: boolean;
}
const diaryQueue: DiaryJob[] = [];
let diaryRunning = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 換日時,為每位租客產生一篇「當日日記」。
 *  live=false(離線/快轉補敘)→ 模板「同步」落地,行為與時序都和排程前一致;
 *  live=true → 進錯開佇列,一次一篇、拉開間隔(避免撞免費層每分鐘限流)。 */
export function produceDailyDiaries(live: boolean): Promise<void> {
  const dayLabel = `第 ${gameDayIndex() + 1} 天`;
  quotaHold = false; // 新的一天:重新嘗試 AI(額度每日重置)
  for (const id of Object.keys(state.runtimes)) {
    const rt = state.runtimes[id];
    if (!rt) continue;
    const job: DiaryJob = { id, gameMs: state.gameMs, ctx: buildNarrateCtx(rt, dayLabel), live };
    if (live) diaryQueue.push(job);
    else applyDiaryResult(job, { diary: templateDiary(job.ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false });
  }
  return processDiaryQueue();
}

/** 佇列處理器:一次一篇、間隔 gapMs;429 先當限流等 retryMs 重試,重試仍 429 才判定額度用盡 */
async function processDiaryQueue(): Promise<void> {
  if (diaryRunning) return;
  diaryRunning = true;
  try {
    let first = true;
    while (diaryQueue.length > 0) {
      if (!first && !quotaHold) await sleep(diaryTiming.gapMs);
      first = false;
      const job = diaryQueue.shift()!;
      if (!state.runtimes[job.id]) continue; // 期間可能已退租
      applyDiaryResult(job, await generateDiary(job));
    }
  } finally {
    diaryRunning = false;
  }
}

async function generateDiary(job: DiaryJob): Promise<NarrateResult> {
  if (job.live && !quotaHold) {
    let res = await narrateImpl(job.ctx);
    if (res.quota) {
      await sleep(diaryTiming.retryMs); // 429 多半是每分鐘限流:等窗口過,再給一次機會
      res = await narrateImpl(job.ctx);
    }
    if (res.ai) {
      quotaNoticeShown = false; // AI 恢復正常 → 之後再用盡可以重新提示
      return res;
    }
    if (res.quota) {
      quotaHold = true; // 重試仍 429 → 當日額度真的用盡
      if (!quotaNoticeShown) {
        quotaNoticeShown = true;
        notify("⚠️ 今日 AI 額度已用完,觀察日記暫用內建模板(每日重置後自動恢復)");
      }
    } else {
      return res; // 離線/解析失敗等:narrateDay 已內建模板 fallback,直接採用
    }
  }
  return { diary: templateDiary(job.ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false };
}

function applyDiaryResult(job: DiaryJob, result: NarrateResult) {
  const cur = state.runtimes[job.id];
  if (!cur) return;
  cur.log.push({
    gameMs: job.gameMs,
    timeLabel: fmt(job.gameMs),
    text: result.diary,
    visualState: cur.tenant.visualState,
    importance: "major",
    ai: result.ai,
    daily: true,
  });
  if (cur.log.length > LOG_CAP) cur.log.splice(0, cur.log.length - LOG_CAP);
  if (result.newMemory) pushMemory(cur.tenant, result.newMemory.label, result.newMemory.hint, "ai_event");
  // 連續性摘要:AI 回寫的新摘要取代舊的,下一天餵回去 → 日記能接續昨天的劇情
  if (result.summaryUpdate) cur.tenant.recentSummary = result.summaryUpdate;
  applyArcUpdate(cur, result.arcUpdate); // 劇情弧:開新弧/推進/收束(消毒後才採用)
  // AI 依當前處境提議的抉擇事件 → 消毒夾值後設為待決(與規則式事件共用冷卻,不覆蓋既有)
  if (result.event && !cur.pendingEvent && gameDayIndex() - cur.lastEventDay >= 2) {
    const roster: Record<string, string> = {};
    for (const o of Object.values(state.runtimes)) if (o.tenant.id !== cur.tenant.id) roster[o.tenant.name] = o.tenant.id;
    const ev = sanitizeAiEvent(result.event, roster);
    if (ev) {
      cur.pendingEvent = ev;
      cur.lastEventDay = gameDayIndex();
    }
  }
  save();
}

/** 套用 AI 的劇情弧更新:開新弧/推進都寫回 runtime;收束時清弧 + 留一筆記憶與日誌(進 Feed) */
function applyArcUpdate(rt: TenantRuntime, raw: unknown) {
  const action = sanitizeArcUpdate(raw, rt.arc);
  if (!action) return;
  if (action.kind === "start") {
    rt.arc = action.arc;
    pushSocialLog(rt, `📖 新篇章開始:「${action.arc.theme}」`, "notable");
  } else if (action.kind === "advance") {
    rt.arc = action.arc;
  } else {
    rt.arc = null;
    pushMemory(rt.tenant, `[經歷:${action.theme}]`, "這段經歷已成為他的一部分", "ai_event");
    pushSocialLog(rt, `📕 篇章落幕:「${action.theme}」`, "notable");
  }
}

/** 從 runtime 組出當天的敘事 context */
function buildNarrateCtx(rt: TenantRuntime, dayLabel: string): NarrateCtx {
  const dayAgo = state.gameMs - 24 * 3600 * 1000;
  const today = rt.log.filter((e) => e.gameMs >= dayAgo);
  const todayLog = today.map((e) => e.text).filter((t) => t && t.length > 0).slice(-12);
  const events = today.map((e) => e.decisionNote).filter((t): t is string => !!t);
  const id = rt.tenant.id;
  const relationships = listRelationships()
    .filter((r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId])
    .map((r) => {
      const otherId = r.aId === id ? r.bId : r.aId;
      return `與 ${state.runtimes[otherId].tenant.name} ${r.label}`;
    });
  const neighbors = Object.values(state.runtimes)
    .filter((o) => o.tenant.id !== id)
    .map((o) => o.tenant.name);
  return {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    bio: rt.tenant.bio,
    dayLabel,
    coreTags: rt.tenant.coreTags.map((t) => t.label),
    memoryTags: rt.tenant.memoryTags.map((t) => t.label),
    stats: { mood: rt.tenant.stats.mood, stress: rt.tenant.stats.stress, affinity: rt.tenant.stats.affinity, satisfaction: Math.round(rt.satisfaction) },
    todayLog,
    relationships,
    events,
    neighbors,
    summary: rt.tenant.recentSummary,
    arc: rt.arc ? { theme: rt.arc.theme, stage: rt.arc.stage, maxStage: rt.arc.maxStage, summary: rt.arc.summary } : null,
    flags: [...rt.flags],
  };
}
