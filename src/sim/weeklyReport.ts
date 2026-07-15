/**
 * 每週生活報告：每 7 個遊戲日彙整實際收支、重要故事與關係變化。
 * 完全讀取既有 ledger/log/relationships，不呼叫 AI、不改任何模擬數值。
 */
import { state, fmt, gameDayIndex, notify } from "./gameState";
import { relationships, tierLabel } from "./social";
import { MS_PER_GAME_HOUR } from "./clock";

const WEEK_MS = 7 * 24 * MS_PER_GAME_HOUR;
export const WEEKLY_REPORT_CAP = 12;

export interface WeeklyHighlight {
  gameMs: number;
  text: string;
  tenantId?: string;
  tenantName?: string;
  importance: "notable" | "major";
}

export interface WeeklyRelationshipChange {
  aName: string;
  bName: string;
  delta: number;
  current: number;
  label: string;
}

export interface WeeklyReport {
  id: string;
  gameMs: number;
  timeLabel: string;
  week: number;
  startDay: number;
  endDay: number;
  income: number;
  expense: number;
  net: number;
  highlights: WeeklyHighlight[];
  relationshipChanges: WeeklyRelationshipChange[];
}

/** 目前關係值快照；存進 state，供下週計算 delta。 */
export function currentRelationshipSnapshot(): Record<string, number> {
  return Object.fromEntries(Object.entries(relationships).map(([key, rel]) => [key, rel.value]));
}

function weeklyMoney(sinceMs: number) {
  let income = 0;
  let expense = 0;
  for (const txn of state.ledger) {
    if (txn.gameMs <= sinceMs || txn.gameMs > state.gameMs) continue;
    if (txn.amount > 0) income += txn.amount;
    else expense -= txn.amount;
  }
  return { income, expense, net: income - expense };
}

function weeklyHighlights(sinceMs: number): WeeklyHighlight[] {
  const candidates: (WeeklyHighlight & { score: number })[] = [];
  for (const rt of Object.values(state.runtimes)) {
    for (const entry of rt.log) {
      if (entry.gameMs <= sinceMs || entry.gameMs > state.gameMs || entry.importance === "minor" || entry.daily || entry.ai) continue;
      candidates.push({
        gameMs: entry.gameMs,
        text: entry.decisionNote ?? entry.text,
        tenantId: rt.tenant.id,
        tenantName: rt.tenant.name,
        importance: entry.importance,
        score: entry.importance === "major" || !!entry.decisionNote ? 2 : 1,
      });
    }
  }
  for (const notice of state.noticeLog) {
    if (notice.gameMs <= sinceMs || notice.gameMs > state.gameMs) continue;
    candidates.push({ gameMs: notice.gameMs, text: notice.text, importance: "major", score: 2 });
  }

  // 同一件事常同時寫進雙方日誌與通知；以正規化文字去重，保留分數高／較新的版本。
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score || b.gameMs - a.gameMs)
    .filter((item) => {
      const key = item.text.replace(/[\s、，。,.!！?？:：\d$]/g, "").slice(0, 36);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map(({ score: _score, ...item }) => item);
}

function weeklyRelationshipChanges(): WeeklyRelationshipChange[] {
  const previous = state.weeklyRelationshipSnapshot;
  const changes: WeeklyRelationshipChange[] = [];
  for (const [key, rel] of Object.entries(relationships)) {
    const before = previous[key] ?? 0;
    const delta = Math.round(rel.value - before);
    if (Math.abs(delta) < 3) continue;
    const [aId, bId] = key.split("|");
    const a = state.runtimes[aId];
    const b = state.runtimes[bId];
    if (!a || !b) continue;
    changes.push({
      aName: a.tenant.name,
      bName: b.tenant.name,
      delta,
      current: Math.round(rel.value),
      label: tierLabel(rel, a.tenant, b.tenant),
    });
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
}

/** 換日時呼叫；未滿 7 日回 null，成功則保存週報並更新下週比較基準。 */
export function weeklyReportPass(): WeeklyReport | null {
  const endDay = gameDayIndex();
  if (endDay - state.lastWeeklyReportDay < 7) return null;
  const sinceMs = state.gameMs - WEEK_MS;
  const money = weeklyMoney(sinceMs);
  const report: WeeklyReport = {
    id: `week-${endDay}-${state.gameMs}`,
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    week: Math.max(1, Math.floor(endDay / 7)),
    startDay: Math.max(1, endDay - 6),
    endDay,
    ...money,
    highlights: weeklyHighlights(sinceMs),
    relationshipChanges: weeklyRelationshipChanges(),
  };
  state.weeklyReports.push(report);
  if (state.weeklyReports.length > WEEKLY_REPORT_CAP) state.weeklyReports.splice(0, state.weeklyReports.length - WEEKLY_REPORT_CAP);
  state.lastWeeklyReportDay = endDay;
  for (const key of Object.keys(state.weeklyRelationshipSnapshot)) delete state.weeklyRelationshipSnapshot[key];
  Object.assign(state.weeklyRelationshipSnapshot, currentRelationshipSnapshot());
  notify(`📊 第 ${report.week} 週生活報告完成:本週${report.net >= 0 ? "淨賺" : "淨支出"} $${Math.abs(report.net).toLocaleString()}`);
  return report;
}
