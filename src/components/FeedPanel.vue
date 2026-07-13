<script setup lang="ts">
/**
 * 動態分頁(設計檢討 §3):
 * - 事件中心:所有待決抉擇集中在最上方(醒目色塊),點了跳進該房做決定
 * - 時間軸:全棟重要日誌/當日觀察/房東介入/系統通知,新到舊
 * 點任何有租客歸屬的動態 → emit goto 跳該房間。
 */
import { computed } from "vue";
import { state, buildFeed } from "../store";

const props = defineProps<{ sinceMs: number }>();
const emit = defineEmits<{ goto: [tenantId: string] }>();

/** 事件中心:待決抉擇(遊戲高潮,置頂醒目) */
const pendings = computed(() =>
  Object.values(state.runtimes)
    .filter((r) => r.pendingEvent)
    .map((r) => ({ id: r.tenant.id, name: r.tenant.name, roomNo: r.roomNo, title: r.pendingEvent!.title })),
);

const rows = computed(() => buildFeed().map((e) => ({ e, unread: e.gameMs > props.sinceMs })));

const KIND_BADGE = { diary: "📖 當日觀察", decision: "🏠 房東介入", event: "◆ 事件", notice: "📢 公告" } as const;
const PROVIDER_LABEL: Record<string, string> = {
  "gemini-flash": "Gemini Flash", "gemini-flash-lite": "Gemini Lite", "workers-ai-qwen": "Workers AI", claude: "Claude",
};
const FALLBACK_LABEL: Record<string, string> = {
  catchup: "掛機補進度", quota: "免費額度已滿", offline: "目前離線", no_key: "未設定服務", forbidden: "連線驗證失敗",
  parse: "AI 格式異常", upstream: "AI 暫時無回應", unknown: "稍後再試",
};
const providerLabel = (provider?: string) => provider ? PROVIDER_LABEL[provider] ?? "AI" : "AI";
const fallbackLabel = (reason?: string) => reason ? FALLBACK_LABEL[reason] ?? "稍後再試" : "內建";
</script>

<template>
  <div class="feedwrap">
    <section v-if="pendings.length" class="event-center">
      <div class="ec-title">🔴 事件中心 · {{ pendings.length }} 件待決定</div>
      <button v-for="p in pendings" :key="p.id" class="ec-item" @click="emit('goto', p.id)">
        <span class="ec-room">{{ p.roomNo }}</span>
        <span class="ec-text">{{ p.title }}</span>
        <span class="ec-go">前往 ›</span>
      </button>
    </section>

    <p v-if="!rows.length" class="empty">還沒有動態。時間推進後,全棟的故事會匯集在這裡。</p>

    <component
      :is="row.e.tenantId ? 'button' : 'div'"
      v-for="(row, i) in rows"
      :key="i"
      class="item"
      :class="[row.e.kind, { unread: row.unread, tappable: !!row.e.tenantId, major: row.e.importance === 'major' }]"
      @click="row.e.tenantId && emit('goto', row.e.tenantId)"
    >
      <div class="item-head">
        <span class="kind">{{ KIND_BADGE[row.e.kind] }}</span>
        <span v-if="row.e.roomNo" class="who">{{ row.e.roomNo }} {{ row.e.tenantName }}</span>
        <span v-if="row.e.ai" class="ai-chip">✨ {{ providerLabel(row.e.aiProvider) }}</span>
        <span v-else-if="row.e.aiPending" class="pending-chip" :title="fallbackLabel(row.e.aiFallbackReason)">⏳ 等候 AI</span>
        <span v-else-if="row.e.kind === 'diary'" class="fallback-chip">
          內建<template v-if="row.e.aiFallbackReason"> · {{ fallbackLabel(row.e.aiFallbackReason) }}</template>
        </span>
        <span class="time">{{ row.e.timeLabel }}</span>
        <span v-if="row.unread" class="new-dot">NEW</span>
      </div>
      <p class="text">{{ row.e.text }}</p>
    </component>
  </div>
</template>

<style scoped>
.feedwrap { display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--text-dim); font-size: 13px; text-align: center; padding: 28px 0; }

.event-center {
  background: linear-gradient(180deg, rgba(232,101,122,0.14), rgba(232,101,122,0.04));
  border: 1px solid var(--bad); border-radius: 12px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.ec-title { font-size: 12px; font-weight: 700; color: #ff9aa8; letter-spacing: 0.5px; }
.ec-item {
  display: flex; align-items: center; gap: 8px; text-align: left;
  background: var(--panel); border: 1px solid rgba(232,101,122,0.45); border-radius: 10px;
  padding: 8px 10px; color: var(--text); font-size: 13px;
}
.ec-item:hover { border-color: var(--bad); }
.ec-room { font-weight: 700; color: var(--bad); font-size: 12px; }
.ec-text { flex: 1; line-height: 1.4; }
.ec-go { color: var(--text-dim); font-size: 11.5px; white-space: nowrap; }

.item {
  display: block; width: 100%; text-align: left; color: var(--text);
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px;
}
.item.tappable:hover { border-color: var(--accent-2); }
.item.major { border-color: var(--accent); background: linear-gradient(180deg, rgba(255,180,94,0.08), transparent); }
.item.diary { background: linear-gradient(180deg, rgba(143,123,255,0.10), rgba(143,123,255,0.02)); border-color: var(--accent-2); }
.item.decision { background: rgba(255,180,94,0.08); border-color: rgba(255,180,94,0.35); }
.item.notice { border-style: dashed; }
.item.unread { box-shadow: 0 0 0 1px rgba(143,123,255,0.3); }

.item-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3px; flex-wrap: nowrap; min-width: 0; }
.kind { font-size: 10.5px; font-weight: 700; color: var(--text-dim); white-space: nowrap; }
.item.diary .kind { color: #cdbcff; }
.item.decision .kind { color: var(--accent); }
.who { font-size: 11px; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-chip { font-size: 9px; font-weight: 700; color: #cdbcff; background: rgba(143,123,255,0.18); border: 1px solid var(--accent-2); border-radius: 999px; padding: 0 6px; }
.pending-chip, .fallback-chip { font-size: 9px; font-weight: 700; border-radius: 999px; padding: 0 6px; white-space: nowrap; }
.pending-chip { color: #ffd6a3; border: 1px solid var(--accent); background: rgba(255,180,94,0.12); }
.fallback-chip { color: var(--text-dim); border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
.time { margin-left: auto; font-size: 10.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
.new-dot { font-size: 9px; font-weight: 700; letter-spacing: 1px; color: #cdbcff; background: rgba(143,123,255,0.16); border: 1px solid var(--accent-2); border-radius: 999px; padding: 0 6px; }
.text { font-size: 13px; line-height: 1.6; }
</style>
