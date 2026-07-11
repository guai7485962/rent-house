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

/** narrate 節流:多位租客串行、每次間隔 ≥4 秒(Gemini 免費層 RPM 低,快轉跨多日尤其容易連發) */
const NARRATE_GAP_MS = 4000;

/** 額度提示只彈一次(下次 AI 成功時重置,額度恢復又能提示) */
let quotaNoticeShown = false;

/** 換日時,為每位租客產生一篇「當日日記」(live 才呼叫 AI,否則模板) */
export async function produceDailyDiaries(live: boolean) {
  const dayLabel = `第 ${gameDayIndex() + 1} 天`;
  const ids = Object.keys(state.runtimes);
  let liveNow = live;
  let first = true;
  for (const id of ids) {
    const rt = state.runtimes[id];
    if (!rt) continue;
    if (liveNow && !first) await new Promise((r) => setTimeout(r, NARRATE_GAP_MS));
    first = false;
    const ctx = buildNarrateCtx(rt, dayLabel);
    const result: NarrateResult = liveNow
      ? await narrateDay(ctx)
      : { diary: templateDiary(ctx), newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false };
    if (result.ai) {
      quotaNoticeShown = false; // AI 恢復正常 → 之後再用盡可以重新提示
    } else if (result.quota) {
      liveNow = false; // 額度已盡:這批剩下的直接走模板,不再白打 API
      if (!quotaNoticeShown) {
        quotaNoticeShown = true;
        notify("⚠️ 今日 AI 額度已用完,觀察日記暫用內建模板(每日重置後自動恢復)");
      }
    }
    const cur = state.runtimes[id];
    if (!cur) continue; // 期間可能已退租
    cur.log.push({
      gameMs: state.gameMs,
      timeLabel: fmt(state.gameMs),
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
