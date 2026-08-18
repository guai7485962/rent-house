/**
 * 每日 AI 敘事(store 拆分:narration 模組)。
 * 每位租客有自己的「日記時段」(diaryHour):不再全擠在 0 點,而是錯開在
 * 一天中不同的遊戲小時各生成一篇(1 遊戲小時 ≈ 8.6 現實分鐘 → API 呼叫
 * 自然拉開幾十分鐘,幾乎不會撞 Gemini 免費層限流)。
 * live 走 /api/narrate、否則模板;AI 回傳的新記憶/抉擇事件消毒後接進遊戲。
 */
import {
  narrateDay,
  narrateTiming,
  templateDiary,
  type AiFallbackReason,
  type NarrativeFocus,
  type NarrateCafeCtx,
  type NarrateCtx,
  type NarrateResult,
} from "./narrate";
import {
  cafeNarrativeBrief,
  cafeOpsNarrativeLine,
  cafePopularityTrend,
  cafeRegularNarrativeLines,
  cafeStorageCapacity,
  menuItems,
} from "./cafe";
import { CAFE_GUEST_ADOPTION_DESTINATION } from "./pets";
import { cafeBackStoragePoints, cafeServiceStations } from "./placements";
import { sanitizeAiEvent } from "./events";
import { applyArcTone, sanitizeArcUpdate } from "./arcs";
import { getRel, listRelationships } from "./social";
import { state, clamp, fmt, gameDayIndex, pushArcHistory, pushMemory, pushSocialLog, notify, LOG_CAP, type TenantRuntime } from "./gameState";
import { save } from "./persistence";
import { noiseComplaintEligible, roomAcousticsForTenant } from "./acoustics";
import { sanitizeContextLine, sanitizeSummaryText, selectDiverseNarrativeLines, selectImportantNarrativeLines } from "./narrativeQuality";
import { applyObservation, sanitizeObservation } from "./observationEffects";
import { todayWeather, weatherLabel } from "./weather";
import { weekdayLabel } from "./week";
import { tenantFinanceBrief } from "./economy";
import { GROWTH_TAGS, grantGrowthTag } from "./growth";
import { boostWishFromArc, wishBrief } from "./wishes";
import { unlock } from "./legacy";

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

/** 測試注入點:讓 buildNarrateCtx() 對指定租客丟例外。
 *  正式執行永遠是 null(零成本),存在的理由是 `narrate-resilience-test.ts` 要能證明
 *  「ctx 組裝爆炸不會炸穿 hourlyTick」—— 用髒資料模擬會連帶弄壞其他 pass,失去針對性。 */
let ctxFaultForTest: ((rt: TenantRuntime) => void) | null = null;
export function setCtxFaultForTest(fn: ((rt: TenantRuntime) => void) | null) {
  ctxFaultForTest = fn;
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
/** 每次啟動 drainDeferredDiaries() 都換一張票:被「放生」的舊 run 之後才 settle 時,
 *  它的 finally 不可以把新 run 的 deferredRun 清掉(否則同時兩輪在跑) */
let deferredRunToken = 0;
let deferredRunStartedAt = 0;
/** deferredRun 掛超過這個時間仍未 settle → 判定卡死,允許重新起一輪。
 *  單輪最壞時間:2 篇 × (45s 逾時 + 70s 429 重試 + 45s 第二次逾時) + 90s 間隔 ≈ 5.5 分鐘,
 *  所以門檻設 8 分鐘,不會誤殺正常流程,又不會像過去那樣卡到重新整理為止。 */
export const DEFERRED_RUN_STALE_MS = 8 * 60_000;
const DEFERRED_DAILY_BUDGET = 6;
let deferredBudget = DEFERRED_DAILY_BUDGET;
let deferredBudgetDay = -1;
let diarySerial = 0;
/** 最近一次「升級沒有發生」的原因與時間(給 rentDebug.narrateStatus() 看,不入存檔) */
let lastDeferredExit: { reason: AiFallbackReason | "stalled" | "done"; at: number } | null = null;
/** 最近一次 ctx 組裝／日記產生的例外(給 rentDebug.narrateStatus() 看,不入存檔) */
let lastNarrationError: { tenantId: string; message: string; at: number } | null = null;

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
  deferredBudget = DEFERRED_DAILY_BUDGET;
  deferredBudgetDay = gameDayIndex();
}

/** ctx 組裝爆掉時的最小可用 context:每一欄都是常數或帶預設的直接欄位,本身不可能再丟例外。
 *  templateDiary() 只需要 name/stats/relationships/events/weekday/weather 就能產出一句話。 */
function safeNarrateCtx(rt: TenantRuntime, dayLabel: string): NarrateCtx {
  // 每一欄都自帶保險:安全 ctx 是「最後一道防線」,它自己再丟例外就前功盡棄了。
  const pick = <T>(read: () => T, fallback: T): T => {
    try {
      const value = read();
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  };
  return {
    name: pick(() => rt.tenant.name, "租客"),
    occupation: pick(() => rt.tenant.occupation, ""),
    bio: pick(() => rt.tenant.bio, ""),
    dayLabel,
    coreTags: [],
    memoryTags: [],
    stats: {
      mood: pick(() => rt.tenant.stats.mood, 50),
      stress: pick(() => rt.tenant.stats.stress, 50),
      affinity: pick(() => rt.tenant.stats.affinity, 50),
      satisfaction: 50,
    },
    room: { noise: 0, soundproof: 0, treated: false, complaintRisk: false },
    todayLog: [],
    relationships: [],
    events: [],
    neighbors: [],
    summary: "",
    arc: null,
    flags: [],
    eventDue: false,
  };
}

/** 為單一租客產生「這一天」的日記:live 進錯開佇列、否則模板同步落地。
 *
 *  🔴 H 批:整段包 try/catch。這個函式在 `diaryPass()` 裡被呼叫,而 `diaryPass()` 位於
 *  `hourlyTick()` 的倒數第二段 —— 任何例外炸出去都會讓它**後面**的 collectRent()／
 *  resetDiaryQuota()／wishPass()／floorChainPass()／save() 全部不執行,並且一路炸穿
 *  syncToNow() 與 setInterval,遊戲從此靜止。寧可寫出一篇模板日記,也不能讓例外逃出去。 */
function produceDiaryFor(rt: TenantRuntime, live: boolean): void {
  const dayLabel = `第 ${gameDayIndex() + 1} 天(${weekdayLabel(state.gameMs)})`;
  let job: DiaryJob;
  let ctxFailed = false;
  try {
    job = {
      id: rt.tenant.id,
      diaryId: `diary_${rt.tenant.id}_${state.gameMs}_${++diarySerial}`,
      gameMs: state.gameMs,
      ctx: buildNarrateCtx(rt, dayLabel),
      live,
    };
  } catch (err) {
    ctxFailed = true;
    recordNarrationError(rt, err, "buildNarrateCtx");
    job = {
      id: rt?.tenant?.id ?? "unknown",
      diaryId: `diary_${rt?.tenant?.id ?? "unknown"}_${state.gameMs}_${++diarySerial}`,
      gameMs: state.gameMs,
      ctx: safeNarrateCtx(rt, dayLabel),
      live: false, // 髒 ctx 不送 API:送出去也只會被 worker 打回來
    };
  }
  try {
    if (job.live) {
      diaryQueue.push(job);
      void processDiaryQueue();
    } else {
      applyDiaryResult(job, {
        diary: templateDiary(job.ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
        ai: false, fallbackReason: ctxFailed ? "internal" : "catchup",
      });
    }
  } catch (err) {
    recordNarrationError(rt, err, "produceDiaryFor");
  }
}

function recordNarrationError(rt: TenantRuntime | undefined, err: unknown, where: string) {
  const message = `${where}: ${err instanceof Error ? err.message : String(err)}`;
  lastNarrationError = { tenantId: rt?.tenant?.id ?? "unknown", message, at: Date.now() };
  if (typeof console !== "undefined") console.error("[narration] 日記產生失敗,已降級成模板", message, err);
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
  if (result.ai) applyDiaryEffects(cur, result, job.gameMs, job.ctx.todayLog);
  save();
}

function applyDiaryEffects(cur: TenantRuntime, result: NarrateResult, diaryGameMs: number, todayLog: string[]) {
  if (result.newMemory) pushMemory(cur.tenant, result.newMemory.label, result.newMemory.hint, "ai_event");
  // 觀察回饋:AI 對今天素材的情緒解讀 → 消毒後小幅推數值(🔮)+ 可能的自發行為(🌀)
  // todayLog 用來驗證跨租客關係推力:AI 點名的鄰居必須真的出現在今日素材裡
  const obs = sanitizeObservation(result.observation);
  if (obs) applyObservation(cur, obs, diaryGameMs, todayLog);
  // 連續性摘要:AI 回寫的新摘要取代舊的,下一天餵回去 → 日記能接續昨天的劇情
  if (result.summaryUpdate) cur.tenant.recentSummary = result.summaryUpdate;
  applyArcUpdate(cur, result.arcUpdate); // 劇情弧:開新弧/推進/收束(消毒後才採用)
  // AI 依當前處境提議的抉擇事件 → 消毒夾值後設為待決(與規則式事件共用冷卻,不覆蓋既有)
  if (result.event && !cur.pendingEvent && gameDayIndex() - cur.lastEventDay >= 3) {
    const roster: Record<string, string> = {};
    for (const o of Object.values(state.runtimes)) if (o.tenant.id !== cur.tenant.id) roster[o.tenant.name] = o.tenant.id;
    const ev = sanitizeAiEvent(result.event, roster, cur.tenant.name);
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

function refreshDeferredBudget() {
  const day = gameDayIndex();
  if (deferredBudgetDay === day) return;
  deferredBudgetDay = day;
  deferredBudget = DEFERRED_DAILY_BUDGET;
}

/**
 * 提早退出時,把原因寫進**佇列最前面那一篇**的 fallbackReason —— chip 才顯示得出
 * 「為什麼還沒補上」。過去這四條路徑全部靜默 break,玩家只看到永遠的「⏳ 待補 · 掛機補進度」。
 * 只有真的改變時才 save(),避免每 3 分鐘的定時重試把存檔寫爛。
 */
function markDeferredExit(reason: AiFallbackReason | "stalled" | "done") {
  lastDeferredExit = { reason, at: Date.now() };
  if (reason === "stalled" || reason === "done") return;
  const pending = state.pendingDiaries[0];
  if (!pending) return;
  const log = state.runtimes[pending.tenantId]?.log.find((entry) => entry.diaryId === pending.diaryId && entry.aiPending);
  if (!log || log.aiFallbackReason === reason) return;
  log.aiFallbackReason = reason;
  save();
}

/** 回到前景或前景定時器觸發時，用少量、錯開的免費請求把內建日記原地升級。 */
export function resumeDeferredDiaries(max = 2): Promise<void> {
  refreshDeferredBudget();
  // 🔴 H 批:卡死自癒。narrateDay() 已有 45 秒逾時,理論上 deferredRun 一定 settle;
  // 這裡是第二道保險 —— 只要有任何未來的路徑讓 promise 永不 settle,超過門檻就放生重來,
  // 而不是像過去那樣每次都在第一行 return、一路卡到玩家重新整理。
  if (deferredRun && Date.now() - deferredRunStartedAt > DEFERRED_RUN_STALE_MS) {
    markDeferredExit("stalled");
    deferredRun = null; // 舊 run 之後才 settle 也無妨:token 對不上,不會清掉新的
  }
  if (deferredRun) {
    markDeferredExit("busy"); // 上一輪還在跑 → 這次請求排隊,不是壞掉
    return deferredRun;
  }
  const token = ++deferredRunToken;
  deferredRunStartedAt = Date.now();
  deferredRun = drainDeferredDiaries(max).finally(() => {
    if (deferredRunToken === token) deferredRun = null;
  });
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
    if (typeof document !== "undefined" && document.hidden) {
      markDeferredExit("hidden"); // 分頁在背景是正常狀態;onVisible 會再呼叫 resumeDeferredDiaries()
      return;
    }
    if (quotaHold) {
      markDeferredExit("quota");
      return;
    }
    const pending = state.pendingDiaries[0];
    const rt = state.runtimes[pending.tenantId];
    const log = rt?.log.find((entry) => entry.diaryId === pending.diaryId && entry.aiPending);
    if (!rt || !log) {
      state.pendingDiaries.shift();
      continue;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      log.aiFallbackReason = "offline";
      lastDeferredExit = { reason: "offline", at: Date.now() };
      save();
      return;
    }
    attempted++;
    deferredBudget--;
    const result = await generateDiary({ id: pending.tenantId, diaryId: pending.diaryId, gameMs: pending.gameMs, ctx: pending.ctx, live: true });
    if (!result.ai) {
      const reason = result.fallbackReason ?? (result.quota ? "quota" : "unknown");
      log.aiFallbackReason = reason;
      lastDeferredExit = { reason, at: Date.now() };
      save();
      return;
    }
    log.text = result.diary;
    log.ai = true;
    log.aiPending = false;
    log.aiProvider = result.provider;
    log.aiFallbackReason = undefined;
    state.pendingDiaries.shift();
    applyDiaryEffects(rt, result, pending.gameMs, pending.ctx.todayLog);
    save();
  }
  // 迴圈條件把關的第三個提早退出:今日升級次數用完(換遊戲日 refreshDeferredBudget() 自動恢復)。
  if (state.pendingDiaries.length && deferredBudget <= 0) markDeferredExit("budget");
  else if (!state.pendingDiaries.length) markDeferredExit("done");
}

export function resetDeferredDiaryBudgetForTest(value = 4) {
  deferredBudget = value;
  deferredBudgetDay = gameDayIndex();
}

/** 測試用:把升級管線的模組層狀態清回原點(卡死自癒/提早退出測試之間要互不汙染) */
export function resetNarrationRuntimeForTest() {
  deferredRun = null;
  deferredRunStartedAt = 0;
  deferredRunToken++;
  lastDeferredExit = null;
  lastNarrationError = null;
  quotaHold = false;
  quotaNoticeShown = false;
}

export interface NarrateStatus {
  /** 當日額度已判定用盡(換遊戲日 resetDiaryQuota() 會清掉) */
  quotaHold: boolean;
  /** 今日還剩幾次「原地升級」請求 */
  deferredBudget: number;
  deferredBudgetDay: number;
  gameDay: number;
  /** 還在等 AI 補寫的日記篇數 */
  pendingDiaries: number;
  /** 佇列最前面那一篇(下一個會被升級的) */
  frontPending: { tenantId: string; diaryId: string; reason: string | null } | null;
  /** 即時佇列(live 日記)狀態 */
  liveQueue: number;
  liveRunPending: boolean;
  /** 升級迴圈是否還在跑;卡死時 ageMs 會一路長大 */
  deferredRunPending: boolean;
  deferredRunAgeMs: number | null;
  deferredRunStale: boolean;
  /** 最近一次「沒補成」的原因與時間 */
  lastExit: { reason: string; agoMs: number; at: string } | null;
  /** 最近一次 ctx 組裝/日記產生的例外 */
  lastError: { tenantId: string; message: string; agoMs: number; at: string } | null;
  /** 目前生效的 fetch 逾時 */
  fetchTimeoutMs: number;
  staleThresholdMs: number;
}

/**
 * 🔴 H 批:玩家/開發者可用的診斷出口(`rentDebug.narrateStatus()`)。
 * **唯讀** —— 不打任何請求、不改任何狀態、不寫存檔。專門回答「AI 日記到底卡在哪」。
 */
export function narrateStatus(): NarrateStatus {
  const now = Date.now();
  const front = state.pendingDiaries[0];
  const frontLog = front
    ? state.runtimes[front.tenantId]?.log.find((entry) => entry.diaryId === front.diaryId)
    : undefined;
  const age = deferredRun ? now - deferredRunStartedAt : null;
  return {
    quotaHold,
    deferredBudget,
    deferredBudgetDay,
    gameDay: gameDayIndex(),
    pendingDiaries: state.pendingDiaries.length,
    frontPending: front
      ? { tenantId: front.tenantId, diaryId: front.diaryId, reason: frontLog?.aiFallbackReason ?? null }
      : null,
    liveQueue: diaryQueue.length,
    liveRunPending: diaryRun !== null,
    deferredRunPending: deferredRun !== null,
    deferredRunAgeMs: age,
    deferredRunStale: age !== null && age > DEFERRED_RUN_STALE_MS,
    lastExit: lastDeferredExit
      ? { reason: lastDeferredExit.reason, agoMs: now - lastDeferredExit.at, at: new Date(lastDeferredExit.at).toISOString() }
      : null,
    lastError: lastNarrationError
      ? {
          tenantId: lastNarrationError.tenantId,
          message: lastNarrationError.message,
          agoMs: now - lastNarrationError.at,
          at: new Date(lastNarrationError.at).toISOString(),
        }
      : null,
    fetchTimeoutMs: narrateTiming.timeoutMs,
    staleThresholdMs: DEFERRED_RUN_STALE_MS,
  };
}

/** 雙人弧成立門檻:至少是朋友(關係值 35)或情侶,故事線才可能自然涉及兩人 */
const PAIR_ARC_MIN_REL = 35;

/** 套用 AI 的劇情弧更新:開新弧/推進都寫回 runtime;收束時清弧 + 留一筆記憶與日誌(進 Feed)。
 *  推進/收束的 tone(觀察回饋第三期)轉成固定小幅 mood/stress 脈衝——劇情反映在數值曲線上。
 *  雙人弧:開弧可指定另一位主角(兩份同 id 的弧);推進同步對方 stage/summary、收束兩人一起落幕。
 *  tone 脈衝與 growthTag 只作用在「這篇日記的主人」——對方的情緒由他自己的日記推進時自己決定。 */
function applyArcUpdate(rt: TenantRuntime, raw: unknown) {
  const prevArc = rt.arc;
  const action = sanitizeArcUpdate(raw, rt.arc);
  if (!action) return;
  if (action.kind === "start") {
    action.arc.lastProgressDay = gameDayIndex();
    const partner = resolveArcPartner(rt, action.withName);
    if (partner) {
      rt.arc = { ...action.arc, partnerId: partner.tenant.id, partnerName: partner.tenant.name };
      partner.arc = { ...action.arc, partnerId: rt.tenant.id, partnerName: rt.tenant.name };
      pushSocialLog(rt, `📖 新篇章開始(與 ${partner.tenant.name} 共同):「${action.arc.theme}」`, "notable");
      pushSocialLog(partner, `📖 新篇章開始(與 ${rt.tenant.name} 共同):「${action.arc.theme}」`, "notable");
    } else {
      rt.arc = action.arc;
      pushSocialLog(rt, `📖 新篇章開始:「${action.arc.theme}」`, "notable");
    }
  } else if (action.kind === "advance") {
    const progressed = !!prevArc
      && (action.arc.stage > prevArc.stage || action.arc.summary !== prevArc.summary);
    // 模型重送原 stage/summary 是 no-op,不可藉此永遠重設 stall 時鐘。
    if (progressed) action.arc.lastProgressDay = gameDayIndex();
    rt.arc = action.arc;
    if (progressed) applyArcTone(rt, "advance", action.tone);
    const partner = pairArcPartner(action.arc);
    if (partner) partner.arc = {
      ...partner.arc!,
      stage: action.arc.stage,
      summary: action.arc.summary,
      lastProgressDay: action.arc.lastProgressDay,
    };
  } else {
    rt.arc = null;
    applyArcTone(rt, "conclude", action.tone);
    boostWishFromArc(rt, action.tone); // 篇章好好落幕 = 人生心願也往前一步(down 收場不加)
    const growth = grantGrowthTag(rt.tenant, action.growthTag);
    pushArcHistory(rt, action.theme); // 演過的主題記下來,明天起要求 AI 換題材
    pushMemory(rt.tenant, `[經歷:${action.theme}]`, "這段經歷已成為他的一部分", "ai_event");
    pushSocialLog(rt, `📕 篇章落幕:「${action.theme}」`, "notable");
    if (growth) pushSocialLog(rt, `🌱 成長:${growth.label}——${growth.hint}`, "notable");
    // 雙人弧一起落幕:對方也留記憶與日誌(tone/growth 不擴散,那是日記主人自己的情緒與成長)
    const partner = pairArcPartner(prevArc);
    if (partner) {
      partner.arc = null;
      pushArcHistory(partner, action.theme); // 雙人弧:兩人都算演過這條主題
      pushMemory(partner.tenant, `[經歷:${action.theme}]`, "這段共同經歷已成為他的一部分", "ai_event");
      pushSocialLog(partner, `📕 篇章落幕:「${action.theme}」`, "notable");
      unlock("pair_arc"); // 成就:共同篇章(第一條雙人弧圓滿落幕)
    }
  }
}

/** 開雙人弧的守門:對方必須是現任租客、自己沒點名自己、對方沒有進行中的弧、關係至少朋友/情侶 */
function resolveArcPartner(rt: TenantRuntime, withName: string | null): TenantRuntime | null {
  if (!withName) return null;
  const partner = Object.values(state.runtimes).find(
    (o) => o.tenant.id !== rt.tenant.id && o.tenant.name === withName,
  );
  if (!partner || partner.arc) return null;
  const rel = getRel(rt.tenant.id, partner.tenant.id);
  if (!rel || (!rel.romantic && rel.value < PAIR_ARC_MIN_REL)) return null;
  return partner;
}

/** 取雙人弧的另一位主角(仍在住、且手上是同一條弧才算) */
function pairArcPartner(arc: { id: string; partnerId?: string } | null): TenantRuntime | null {
  if (!arc?.partnerId) return null;
  const partner = state.runtimes[arc.partnerId];
  return partner?.arc?.id === arc.id ? partner : null;
}

// ---------------------------------------------------------------------------
// 🔴 D 批:樓下咖啡廳的唯讀背景(設計文件 §4.13)
// ---------------------------------------------------------------------------

/** 咖啡廳 context 各欄位的字數上限(worker 端 `clampCafeCtx()` 用同一組數字再夾一次)。 */
const CAFE_CTX_BRIEF_MAX = 48;
const CAFE_CTX_LINE_MAX = 28;
/** 送養新聞的保鮮期(遊戲日):再舊就不是新聞了。 */
const CAFE_CTX_ADOPTION_FRESH_DAYS = 3;
const CAFE_CTX_DAY_MS = 24 * 3600 * 1000;
/** 寵物名只取前幾字(存檔可改的自由字串)。 */
const CAFE_CTX_PET_NAME_MAX = 8;

/**
 * 組出當天的咖啡廳背景。**全體在住租客共用同一份**(咖啡廳在所有人樓下,是共享環境)。
 *
 * 🔴 三件事這裡不做,而且刻意不做:
 * - **不寫 `state.cafe`** —— 本函式只讀。AI 這條路本批新增**零個寫入面**。
 * - **不參與 `focus` 計算** —— 咖啡廳只有在 `CAFE_LOG_PREFIX` 日誌真的落進那位租客的 `todayLog`
 *   時才可能成為主線,與本批之前完全相同。
 * - **不送好感數字、不送熟客的原始品項 key**。
 *
 * `brief` 消毒後為空 ⇒ 回 `null`(整個 `cafe` 不進 ctx)。
 */
export function buildCafeNarrateCtx(): NarrateCafeCtx | null {
  const cafe = state.cafe;
  if (!cafe?.open) return null; // 未開張 = 零漂移的天然閘門
  const day = gameDayIndex();
  const sales = cafe.sales ?? [];
  const todaySales = sales[sales.length - 1];
  const recent = sales.slice(-8, -1);
  const avgServed = recent.length
    ? recent.reduce((sum, row) => sum + Math.max(0, row?.served ?? 0), 0) / recent.length
    : 0;
  const brief = sanitizeContextLine(
    cafeNarrativeBrief({
      day,
      served: todaySales?.served ?? 0,
      refused: todaySales?.refused ?? 0,
      abandoned: todaySales?.abandoned ?? 0,
      revenue: todaySales?.revenue ?? 0,
      avgServed,
    }),
    CAFE_CTX_BRIEF_MAX,
  );
  if (!brief) return null;
  // 🔴 硬不變式:熟客名字 ∩ 租客名字 = ∅。現任租客的名字一律從熟客素材裡濾掉,
  // 這樣 `applyRelNudge` 的「名字出現在 todayLog」條件永遠無法被 ctx.cafe 這條路滿足。
  const tenantNames = Object.values(state.runtimes).map((rt) => rt.tenant.name);
  const menuNameById: Record<string, string> = {};
  for (const item of menuItems(cafe.completed)) menuNameById[item.id] = item.name;
  const regulars = cafeRegularNarrativeLines({
    regulars: cafe.regulars ?? [],
    day,
    menuNameById,
    excludeNames: tenantNames,
    max: 2,
  })
    .map((line) => sanitizeContextLine(line, CAFE_CTX_LINE_MAX))
    .filter(Boolean);
  const ops = sanitizeContextLine(
    cafeOpsNarrativeLine({
      cafe,
      day,
      // placements 的量在這裡取,`cafe.ts` 仍然只吃參數(同 tick.ts:cafeHourlyPass 的既有做法)。
      storageCapacity: cafeStorageCapacity(cafeBackStoragePoints()),
      stations: cafeServiceStations(),
    }) ?? "",
    CAFE_CTX_LINE_MAX,
  );
  // 寵物線:最近幾天有沒有客人把樓寵物帶回家。`petHomes` 是 unshift(最新在最前)。
  // 🔴 只用寵物名(夾 8 字並過同一道消毒);**不用 `adopterName`** —— 那是存檔可改的
  // 自由字串,而且領養人不是這棟樓的人。店貓辣椒是常設狀態不是新聞,不進 context。
  const adoption = state.petHomes.find(
    (entry) => entry.destination === CAFE_GUEST_ADOPTION_DESTINATION
      && state.gameMs - entry.leftMs <= CAFE_CTX_ADOPTION_FRESH_DAYS * CAFE_CTX_DAY_MS
      && state.gameMs >= entry.leftMs,
  );
  const petName = adoption ? sanitizeContextLine(adoption.name, CAFE_CTX_PET_NAME_MAX) : "";
  const pets = petName
    ? sanitizeContextLine(`前幾天有位客人把「${petName}」帶回家了`, CAFE_CTX_LINE_MAX)
    : "";
  return {
    brief,
    trend: cafePopularityTrend(cafe.history ?? []),
    regulars,
    ...(ops ? { ops } : {}),
    ...(pets ? { pets } : {}),
  };
}

/** tone 脈衝:查寫死的 ARC_TONE_PULSE 表,AI 只能選方向不能自訂數值 */
/** 從 runtime 組出當天的敘事 context */
export function buildNarrateCtx(rt: TenantRuntime, dayLabel: string): NarrateCtx {
  ctxFaultForTest?.(rt);
  const dayAgo = state.gameMs - 24 * 3600 * 1000;
  // 上一篇「當日觀察」不能再當成今天的原始素材，否則 AI 會摘要自己的摘要，
  // 把同一措辭逐日放大。其餘片段先做近似去重，只保留最近八個不同畫面。
  // 🔮/🌀/🌱/💤 是系統回饋日誌(含夢境彩蛋):不能回流當素材,否則 AI 會摘要自己的回饋
  // (同舊日報回灌問題);夢境本身就是既有日誌的再敘述,回流會讓同一件事被放大兩次。
  const today = rt.log.filter((e) => e.gameMs > dayAgo && !e.daily && !/^[🔮🌀🌱💤]/u.test(e.text));
  const highlights = selectImportantNarrativeLines(
    today.flatMap((entry) => [
      ...(entry.text ? [{
        text: entry.text,
        importance: entry.importance,
        gameMs: entry.gameMs,
        source: "log" as const,
      }] : []),
      ...(entry.decisionNote ? [{
        text: entry.decisionNote,
        importance: "major" as const,
        gameMs: entry.gameMs,
        source: "decision" as const,
      }] : []),
    ]),
    8,
  );
  const todayLog = highlights.map((entry) => entry.text);
  const events = selectDiverseNarrativeLines(
    highlights.filter((entry) => entry.source === "decision").map((entry) => entry.text),
    4,
  );
  const id = rt.tenant.id;
  const relationships = listRelationships((tenantId) => state.runtimes[tenantId]?.tenant)
    .filter((r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId])
    .map((r) => {
      const otherId = r.aId === id ? r.bId : r.aId;
      return `與 ${state.runtimes[otherId].tenant.name} ${r.label}`;
    });
  const neighbors = Object.values(state.runtimes)
    .filter((o) => o.tenant.id !== id)
    .map((o) => o.tenant.name);
  const acoustics = roomAcousticsForTenant(id);
  const focusDecision = [...highlights].reverse().find((entry) => entry.source === "decision");
  const focusMajor = [...highlights].reverse().find((entry) => entry.importance === "major");
  const focusNotable = [...highlights].reverse().find((entry) => entry.importance === "notable");
  // 這兩種旗標尾端是 tenant id，屬於系統配對鍵，不可直接餵給模型。
  const narrativeFlags = rt.flags.filter(
    (flag) => !flag.startsWith("冰箱食物失蹤:") && !flag.startsWith("被懷疑偷吃:"),
  );
  const narrativeFlag = narrativeFlags[0];
  const currentWish = wishBrief(rt);
  const focus: NarrativeFocus = focusDecision
    ? { kind: "decision", headline: focusDecision.text, reason: "房東今天的介入或抉擇優先於其他素材" }
    : focusMajor
      ? { kind: "major", headline: focusMajor.text, reason: "這是今天最高重要性的實際事件" }
      : rt.arc
        ? { kind: "arc", headline: `${rt.arc.theme}：${rt.arc.summary}`, reason: "今天沒有更高優先事件，接續進行中的劇情弧" }
        : rt.sideArc
          ? { kind: "arc", headline: `${rt.sideArc.theme}：${rt.sideArc.summary}`, reason: "今天沒有更高優先事件，可自然呼應並行的本地支線" }
        : focusNotable
          ? { kind: "notable", headline: focusNotable.text, reason: "這是今天最值得發展的明顯變化" }
          : narrativeFlag
            ? { kind: "flag", headline: narrativeFlag, reason: "今天素材平淡，優先自然回收未完成伏筆" }
            : currentWish
              ? { kind: "wish", headline: currentWish, reason: "今天素材平淡，以長期心願作為人物方向" }
              : { kind: "daily", headline: highlights.at(-1)?.text ?? "平靜的一天", reason: "沒有重大變化，只描寫一個具體日常畫面" };
  const tagDetails = [
    ...rt.tenant.coreTags.map((tag) => ({
      label: tag.label,
      hint: tag.behaviorHint,
      kind: "core" as const,
      intensity: 1,
    })),
    ...[...rt.tenant.memoryTags]
      .sort((a, b) =>
        (b.intensity ?? 1) - (a.intensity ?? 1)
        || String(b.acquiredAt ?? "").localeCompare(String(a.acquiredAt ?? "")),
      )
      .map((tag) => ({
        label: tag.label,
        hint: tag.behaviorHint,
        kind: "memory" as const,
        intensity: tag.intensity ?? 1,
        source: tag.source,
      })),
  ];
  return {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    bio: rt.tenant.bio,
    dayLabel,
    coreTags: rt.tenant.coreTags.map((t) => t.label),
    memoryTags: rt.tenant.memoryTags.map((t) => t.label),
    tagDetails,
    // 🔴 H 批:安全查表。舊存檔可能帶著目錄裡已不存在的 growth tag id ——
    // 直接 GROWTH_TAGS[id].label 會丟 TypeError,一路炸穿 diaryPass → hourlyTick,
    // 讓同一個 tick 後面的收租/額度重置/心願/樓層事件鏈與 save() 全部不執行。
    growthTags: (rt.tenant.growthTags ?? []).flatMap((id) => {
      const label: string | undefined = GROWTH_TAGS[id]?.label;
      return label ? [label] : [];
    }),
    stats: { mood: rt.tenant.stats.mood, stress: rt.tenant.stats.stress, affinity: rt.tenant.stats.affinity, satisfaction: Math.round(rt.satisfaction) },
    room: {
      noise: acoustics.noise,
      soundproof: acoustics.soundproof,
      treated: acoustics.treated,
      complaintRisk: noiseComplaintEligible(rt),
    },
    todayLog,
    todayHighlights: highlights.map(({ text, importance, source }) => ({ text, importance, source })),
    focus,
    relationships,
    events,
    neighbors,
    summary: sanitizeSummaryText(rt.tenant.recentSummary, [rt.tenant.name]),
    arc: rt.arc
      ? { theme: rt.arc.theme, stage: rt.arc.stage, maxStage: rt.arc.maxStage, summary: rt.arc.summary, with: rt.arc.partnerName ?? null }
      : null,
    sideArc: rt.sideArc
      ? { theme: rt.sideArc.theme, stage: rt.sideArc.stage, maxStage: rt.sideArc.maxStage, summary: rt.sideArc.summary }
      : null,
    // 演過的主題:AI 開新弧時據此避開重複題材(worker 端還會再夾一次條數/長度)
    pastArcThemes: [...(rt.arcHistory ?? [])],
    flags: [...narrativeFlags, ...(state.pets[id] ? [`養了一隻${state.pets[id].kind === "dog" ? "狗" : "貓"}「${state.pets[id].name}」`] : [])],
    eventDue: !rt.pendingEvent && gameDayIndex() - Math.max(rt.lastEventDay, 0) >= 3,
    weather: weatherLabel(todayWeather()),
    weekday: weekdayLabel(state.gameMs),
    finance: tenantFinanceBrief(rt) ?? undefined,
    wish: currentWish,
    // 🔴 D 批:咖啡廳背景(全體在住租客共用同一份;未開張 ⇒ undefined ⇒ prompt 少幾行)
    cafe: buildCafeNarrateCtx() ?? undefined,
  };
}
