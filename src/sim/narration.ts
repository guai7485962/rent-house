/**
 * 每日 AI 敘事(store 拆分:narration 模組)。
 * 換日時為每位租客產生一篇日記(live 走 /api/narrate、否則模板),
 * 並把 AI 回傳的新記憶/抉擇事件消毒後接進遊戲。
 * (設計檢討 §1 的連續性摘要、narrate 佇列/節流之後也放這裡。)
 */
import { narrateDay, templateDiary, type NarrateCtx, type NarrateResult } from "./narrate";
import { sanitizeAiEvent } from "./events";
import { listRelationships } from "./social";
import { state, fmt, gameDayIndex, pushMemory, LOG_CAP, type TenantRuntime } from "./gameState";
import { save } from "./persistence";

/** 換日時,為每位租客產生一篇「當日日記」(live 才呼叫 AI,否則模板) */
export async function produceDailyDiaries(live: boolean) {
  const dayLabel = `第 ${gameDayIndex() + 1} 天`;
  const ids = Object.keys(state.runtimes);
  for (const id of ids) {
    const rt = state.runtimes[id];
    if (!rt) continue;
    const ctx = buildNarrateCtx(rt, dayLabel);
    const result: NarrateResult = live
      ? await narrateDay(ctx)
      : { diary: templateDiary(ctx), newMemory: null, event: null, ai: false };
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
  };
}
