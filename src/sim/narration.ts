/**
 * 每日 AI 敘事(store 拆分:narration 模組)。
 * 每位租客有自己的「日記時段」(diaryHour):不再全擠在 0 點,而是錯開在
 * 一天中不同的遊戲小時各生成一篇(1 遊戲小時 ≈ 8.6 現實分鐘 → API 呼叫
 * 自然拉開幾十分鐘,幾乎不會撞 Gemini 免費層限流)。
 * live 走 /api/narrate、否則模板;AI 回傳的新記憶/抉擇事件消毒後接進遊戲。
 */
import { narrateDay, templateDiary, type AiFallbackReason, type NarrateCtx, type NarrateResult } from "./narrate";
import { sanitizeAiEvent } from "./events";
import { sanitizeArcUpdate } from "./arcs";
import { listRelationships } from "./social";
import { state, fmt, gameDayIndex, pushMemory, pushSocialLog, notify, LOG_CAP, type TenantRuntime } from "./gameState";
import { save } from "./persistence";

/** 日記佇列節奏(測試可調):
 *  gapMs = 每位租客間隔(把整批打散,避免撞 Gemini 免費層每分鐘限流,也讓日記「一篇篇出爐」);
 *  retryMs = 收到 429 後的重試等待(429 常常只是每分鐘限流,不是當日額度用盡——等窗口過再試一次) */
export const diaryTiming = { gapMs: 25_000, retryMs: 70_000, deferredMinGapMs: 60_000, deferredMaxGapMs: 90_000 };

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
  diaryId: string;
  gameMs: number; // 入列當下的遊戲時間(日記要落在正確的那一天)
  ctx: NarrateCtx; // 入列當下就組好 context(快轉時延後生成也不會拿到隔天的狀態)
  live: boolean;
}
const diaryQueue: DiaryJob[] = [];
let diaryRun: Promise<void> | null = null;
let deferredRun: Promise<void> | null = null;
let deferredBudget = 4;
let diarySerial = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 日記時段候選(彼此拉開;依序發給租客,4 人時為 22/9/14/18 點) */
const DIARY_SLOTS = [22, 9, 14, 18, 7, 12, 16, 20, 11, 15, 21, 8];

/** 幫還沒有日記時段的租客指派一個(避開其他人已占用的時段;存檔載入/新入住都會補) */
export function ensureDiaryHours() {
  for (const rt of Object.values(state.runtimes)) {
    if (rt.diaryHour >= 0 && rt.diaryHour <= 23) continue;
    const used = new Set(Object.values(state.runtimes).map((o) => o.diaryHour));
    rt.diaryHour = DIARY_SLOTS.find((h) => !used.has(h)) ?? DIARY_SLOTS[Math.floor(Math.random() * DIARY_SLOTS.length)];
  }
}

/** 換日重置:額度每日重置,新的一天重新嘗試 AI(tick 在跨日時呼叫) */
export function resetDiaryQuota() {
  quotaHold = false;
}

/** 為單一租客產生「這一天」的日記:live 進錯開佇列、否則模板同步落地 */
function produceDiaryFor(rt: TenantRuntime, live: boolean): void {
  const job: DiaryJob = {
    id: rt.tenant.id,
    diaryId: `diary_${rt.tenant.id}_${state.gameMs}_${++diarySerial}`,
    gameMs: state.gameMs,
    ctx: buildNarrateCtx(rt, `第 ${gameDayIndex() + 1} 天`),
    live,
  };
  if (live) {
    diaryQueue.push(job);
    void processDiaryQueue();
  } else {
    applyDiaryResult(job, {
      diary: templateDiary(job.ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
      ai: false, fallbackReason: "catchup",
    });
  }
}

/** 每小時檢查:輪到誰的日記時段就生成(每人每日一篇;tick 每小時呼叫)。
 *  這就是「AI 事件分散」的核心——四個人不再同時打 API,而是各自的時段到了才打。 */
export function diaryPass(hour: number, live: boolean) {
  ensureDiaryHours();
  const day = gameDayIndex();
  for (const rt of Object.values(state.runtimes)) {
    if (rt.diaryHour !== hour || rt.lastDiaryDay === day) continue;
    rt.lastDiaryDay = day;
    produceDiaryFor(rt, live);
  }
}

/** 一次為全員產生日記(整批;測試與舊呼叫點用。正常遊戲流程走 diaryPass 錯開)。
 *  live=false(離線/快轉補敘)→ 模板「同步」落地;live=true → 進佇列一次一篇。 */
export function produceDailyDiaries(live: boolean): Promise<void> {
  quotaHold = false; // 整批重來:重新嘗試 AI
  for (const rt of Object.values(state.runtimes)) produceDiaryFor(rt, live);
  return processDiaryQueue();
}

/** 佇列處理器:一次一篇、間隔 gapMs;429 先當限流等 retryMs 重試,重試仍 429 才判定額度用盡。
 *  已在跑就回傳同一個進行中的 promise(await 它 = 等整批清完) */
function processDiaryQueue(): Promise<void> {
  if (!diaryRun) {
    diaryRun = drainDiaryQueue().finally(() => {
      diaryRun = null;
      if (diaryQueue.length > 0) void processDiaryQueue(); // 收尾瞬間又有新篇入列 → 重啟
    });
  }
  return diaryRun;
}

async function drainDiaryQueue(): Promise<void> {
  let first = true;
  while (diaryQueue.length > 0) {
    if (!first && !quotaHold) await sleep(diaryTiming.gapMs);
    first = false;
    const job = diaryQueue.shift()!;
    if (!state.runtimes[job.id]) continue; // 期間可能已退租
    applyDiaryResult(job, await generateDiary(job));
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
  return {
    diary: templateDiary(job.ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
    ai: false, fallbackReason: quotaHold ? "quota" : "unknown",
  };
}

function applyDiaryResult(job: DiaryJob, result: NarrateResult) {
  const cur = state.runtimes[job.id];
  if (!cur) return;
  const fallbackReason = result.fallbackReason ?? (job.live ? "unknown" : "catchup");
  if (!result.ai) queuePendingDiary(job, fallbackReason);
  cur.log.push({
    gameMs: job.gameMs,
    timeLabel: fmt(job.gameMs),
    text: result.diary,
    visualState: cur.tenant.visualState,
    importance: "major",
    ai: result.ai,
    daily: true,
    diaryId: job.diaryId,
    aiPending: !result.ai,
    aiProvider: result.provider,
    aiFallbackReason: result.ai ? undefined : fallbackReason,
  });
  if (cur.log.length > LOG_CAP) cur.log.splice(0, cur.log.length - LOG_CAP);
  if (result.ai) applyDiaryEffects(cur, result);
  save();
}

function applyDiaryEffects(cur: TenantRuntime, result: NarrateResult) {
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
}

function queuePendingDiary(job: DiaryJob, reason: AiFallbackReason) {
  for (let i = state.pendingDiaries.length - 1; i >= 0; i--) {
    const old = state.pendingDiaries[i];
    if (old.tenantId !== job.id) continue;
    const oldLog = state.runtimes[old.tenantId]?.log.find((entry) => entry.diaryId === old.diaryId);
    if (oldLog) oldLog.aiPending = false;
    state.pendingDiaries.splice(i, 1);
  }
  state.pendingDiaries.push({ diaryId: job.diaryId, tenantId: job.id, gameMs: job.gameMs, ctx: job.ctx });
  while (state.pendingDiaries.length > 12) {
    const dropped = state.pendingDiaries.shift()!;
    const droppedLog = state.runtimes[dropped.tenantId]?.log.find((entry) => entry.diaryId === dropped.diaryId);
    if (droppedLog) droppedLog.aiPending = false;
  }
  const log = state.runtimes[job.id]?.log.find((entry) => entry.diaryId === job.diaryId);
  if (log) log.aiFallbackReason = reason;
}

/** 回到前景後，用少量、錯開的免費請求把內建日記原地升級；每個瀏覽器工作階段最多四篇。 */
export function resumeDeferredDiaries(max = 4): Promise<void> {
  if (!deferredRun) deferredRun = drainDeferredDiaries(max).finally(() => (deferredRun = null));
  return deferredRun;
}

async function drainDeferredDiaries(max: number) {
  if (diaryRun) await diaryRun;
  let attempted = 0;
  while (state.pendingDiaries.length && attempted < max && deferredBudget > 0) {
    if (attempted > 0) {
      const span = Math.max(0, diaryTiming.deferredMaxGapMs - diaryTiming.deferredMinGapMs);
      await sleep(diaryTiming.deferredMinGapMs + Math.floor(Math.random() * (span + 1)));
    }
    if (typeof document !== "undefined" && document.hidden) break;
    if (quotaHold) break;
    const pending = state.pendingDiaries[0];
    const rt = state.runtimes[pending.tenantId];
    const log = rt?.log.find((entry) => entry.diaryId === pending.diaryId && entry.aiPending);
    if (!rt || !log) {
      state.pendingDiaries.shift();
      continue;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      log.aiFallbackReason = "offline";
      save();
      break;
    }
    attempted++;
    deferredBudget--;
    const result = await generateDiary({ id: pending.tenantId, diaryId: pending.diaryId, gameMs: pending.gameMs, ctx: pending.ctx, live: true });
    if (!result.ai) {
      log.aiFallbackReason = result.fallbackReason ?? (result.quota ? "quota" : "unknown");
      save();
      break;
    }
    log.text = result.diary;
    log.ai = true;
    log.aiPending = false;
    log.aiProvider = result.provider;
    log.aiFallbackReason = undefined;
    state.pendingDiaries.shift();
    applyDiaryEffects(rt, result);
    save();
  }
}

export function resetDeferredDiaryBudgetForTest(value = 4) {
  deferredBudget = value;
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
    flags: [...rt.flags, ...(state.pets[id] ? [`養了一隻貓「${state.pets[id].name}」`] : [])],
    eventDue: !rt.pendingEvent && gameDayIndex() - Math.max(rt.lastEventDay, 0) >= 3,
  };
}
