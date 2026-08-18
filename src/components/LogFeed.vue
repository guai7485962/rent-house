<script setup lang="ts">
import { computed } from "vue";
import type { LogEntry } from "../store";

const props = defineProps<{ entries: LogEntry[]; sinceMs: number }>();

const IMPORTANCE_ICON = { minor: "·", notable: "◆", major: "★" } as const;
const PROVIDER_LABEL: Record<string, string> = {
  "gemini-flash": "Gemini Flash", "gemini-flash-lite": "Gemini Lite", "workers-ai-qwen": "Workers Qwen", "workers-ai-llama": "Workers Llama", claude: "Claude",
};
const FALLBACK_LABEL: Record<string, string> = {
  catchup: "掛機補進度", quota: "免費額度已滿", offline: "目前離線", no_key: "未設定服務", forbidden: "連線驗證失敗",
  parse: "AI 格式異常", upstream: "AI 暫時無回應", unknown: "稍後再試",
};
const providerLabel = (provider?: string) => provider ? PROVIDER_LABEL[provider] ?? "AI" : "AI";
const fallbackLabel = (reason?: string) => reason ? FALLBACK_LABEL[reason] ?? "稍後再試" : "內建";

/** 新到舊排列;標記自上次查看後的未讀 */
const rows = computed(() =>
  [...props.entries]
    .reverse()
    .map((e) => ({ e, unread: e.gameMs > props.sinceMs })),
);
const unreadCount = computed(() => rows.value.filter((r) => r.unread).length);
</script>

<template>
  <div class="feed">
    <div v-if="entries.length === 0" class="empty">尚無觀察紀錄。時間推進後這裡會累積日誌。</div>

    <template v-for="(row, i) in rows" :key="i">
      <!-- 未讀區塊結束、已讀開始 → 分隔線 -->
      <div v-if="i === unreadCount && unreadCount > 0" class="divider">—— 以下為上次已看過 ——</div>

      <div v-if="row.e.decisionNote" class="decision-note" :class="{ unread: row.unread }">
        🏠 {{ row.e.decisionNote }}
        <span class="time">{{ row.e.timeLabel }}</span>
      </div>
      <div v-else-if="row.e.daily || row.e.ai" class="diary" :class="{ unread: row.unread }">
        <div class="diary-head">
          <span class="badge">📖 當日觀察</span>
          <span v-if="row.e.ai" class="ai-chip">✨ {{ providerLabel(row.e.aiProvider) }}</span>
          <span v-else-if="row.e.aiPending" class="pending-chip">⏳ 待補 · {{ fallbackLabel(row.e.aiFallbackReason) }}</span>
          <span v-else class="fallback-chip">
            內建<template v-if="row.e.aiFallbackReason"> · {{ fallbackLabel(row.e.aiFallbackReason) }}</template>
          </span>
          <span class="time">{{ row.e.timeLabel }}</span>
          <span v-if="row.unread" class="new-dot">NEW</span>
        </div>
        <p class="text">{{ row.e.text }}</p>
      </div>
      <div v-else class="log" :class="[row.e.importance, { unread: row.unread }]">
        <div class="log-head">
          <span class="imp">{{ IMPORTANCE_ICON[row.e.importance] }}</span>
          <span class="time">{{ row.e.timeLabel }}</span>
          <span v-if="row.unread" class="new-dot">NEW</span>
        </div>
        <p class="text">{{ row.e.text }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.feed { display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--text-dim); font-size: 13px; text-align: center; padding: 24px 0; }

.divider {
  text-align: center; font-size: 11px; color: var(--text-dim);
  margin: 6px 0; letter-spacing: 1px;
}

.log {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 12px;
}
.log.notable { border-color: #55507a; }
.log.major { border-color: var(--accent); background: linear-gradient(180deg, rgba(255,180,94,0.08), transparent); }
.log.unread { border-color: var(--accent-2); box-shadow: 0 0 0 1px rgba(143,123,255,0.25); }

.log-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3px; }
.imp { color: var(--accent); font-size: 11px; }
.log.minor .imp { color: var(--text-dim); }
.time { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.new-dot {
  margin-left: auto; font-size: 9px; font-weight: 700; letter-spacing: 1px;
  color: #cdbcff; background: rgba(143,123,255,0.16);
  border: 1px solid var(--accent-2); border-radius: 999px; padding: 0 6px;
}
.text { font-size: 13.5px; line-height: 1.65; }

.decision-note {
  font-size: 12.5px; color: var(--accent);
  background: rgba(255,180,94,0.08); border: 1px solid rgba(255,180,94,0.35);
  border-radius: 10px; padding: 8px 12px;
}
.decision-note .time { margin-left: 6px; }

.diary {
  background: linear-gradient(180deg, rgba(143,123,255,0.10), rgba(143,123,255,0.02));
  border: 1px solid var(--accent-2); border-radius: 10px; padding: 9px 12px;
}
.diary.unread { box-shadow: 0 0 0 1px rgba(143,123,255,0.3); }
.diary-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.diary .badge { font-size: 11px; font-weight: 700; color: #cdbcff; }
.diary .ai-chip { font-size: 9px; font-weight: 700; letter-spacing: 0.5px; color: #cdbcff; background: rgba(143,123,255,0.18); border: 1px solid var(--accent-2); border-radius: 999px; padding: 0 6px; }
.diary .pending-chip, .diary .fallback-chip { font-size: 9px; font-weight: 700; border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.diary .pending-chip { color: #ffd6a3; border: 1px solid var(--accent); background: rgba(255,180,94,0.12); }
.diary .fallback-chip { color: var(--text-dim); border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
.diary .text { font-size: 13.5px; line-height: 1.75; color: #e8e2ff; }
</style>
