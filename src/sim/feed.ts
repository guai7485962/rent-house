/**
 * 全棟動態 Feed(設計檢討 §3):把所有租客的重要日誌/當日觀察/房東介入
 * 與系統通知匯成一條時間軸,當作「看故事」的主動線。
 *
 * 只做讀取彙整,不寫任何模擬狀態;minor 日誌(睡覺/洗澡等流水帳)不進 Feed,
 * 想看細節仍然是點房間看完整日誌。
 */
import { state, fmt } from "./gameState";
import type { AiFallbackReason, AiProvider } from "./narrate";

export interface FeedEntry {
  gameMs: number;
  timeLabel: string;
  text: string;
  /** diary=當日觀察 · decision=房東介入 · event=重要日誌 · notice=系統通知 */
  kind: "diary" | "decision" | "event" | "notice";
  importance: "notable" | "major";
  /** 系統通知沒有租客歸屬(tenantId 為空 = 不能點進房間) */
  tenantId?: string;
  tenantName?: string;
  roomNo?: string;
  ai?: boolean;
  aiPending?: boolean;
  aiProvider?: AiProvider;
  aiFallbackReason?: AiFallbackReason;
}

/** Feed 只顯示最近的 N 則(日誌本身另有 LOG_CAP,這裡再收斂一次) */
export const FEED_CAP = 60;

/** 匯整所有租客日誌 + 系統通知,新到舊。在 computed 內呼叫即可自動追蹤 */
export function buildFeed(): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const rt of Object.values(state.runtimes)) {
    const meta = { tenantId: rt.tenant.id, tenantName: rt.tenant.name, roomNo: rt.roomNo };
    for (const e of rt.log) {
      if (e.decisionNote) {
        out.push({ gameMs: e.gameMs, timeLabel: e.timeLabel, text: e.decisionNote, kind: "decision", importance: "notable", ...meta });
      } else if (e.daily || e.ai) {
        out.push({
          gameMs: e.gameMs, timeLabel: e.timeLabel, text: e.text, kind: "diary", importance: "notable",
          ai: e.ai, aiPending: e.aiPending, aiProvider: e.aiProvider, aiFallbackReason: e.aiFallbackReason, ...meta,
        });
      } else if (e.importance !== "minor") {
        out.push({ gameMs: e.gameMs, timeLabel: e.timeLabel, text: e.text, kind: "event", importance: e.importance, ...meta });
      }
    }
  }
  for (const n of state.noticeLog) {
    out.push({ gameMs: n.gameMs, timeLabel: fmt(n.gameMs), text: n.text, kind: "notice", importance: "major" });
  }
  out.sort((a, b) => b.gameMs - a.gameMs);
  return out.slice(0, FEED_CAP);
}

/** 未讀動態數(晚於上次看 Feed 的時間點) */
export function feedUnreadCount(): number {
  let n = 0;
  for (const e of buildFeed()) {
    if (e.gameMs > state.feedSeenMs) n++;
    else break; // 已排序:遇到第一則舊的就能停
  }
  return n;
}

/** 進入動態分頁時呼叫;之後的 5 秒定期存檔會把 feedSeenMs 一起落盤 */
export function markFeedSeen() {
  state.feedSeenMs = state.gameMs;
}
