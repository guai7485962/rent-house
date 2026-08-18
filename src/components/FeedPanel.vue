<script setup lang="ts">
/**
 * 動態分頁(設計檢討 §3):
 * - 事件中心:所有待決抉擇集中在最上方(醒目色塊),點了跳進該房做決定
 * - 時間軸:全棟重要日誌/當日觀察/房東介入/系統通知,新到舊
 * 點任何有租客歸屬的動態 → emit goto 跳該房間。
 */
import { computed } from "vue";
import { state, buildFeed, floorChainView } from "../store";

const props = defineProps<{ sinceMs: number }>();
const emit = defineEmits<{ goto: [tenantId: string] }>();

/** 事件中心:待決抉擇(遊戲高潮,置頂醒目) */
const pendings = computed(() =>
  Object.values(state.runtimes)
    .filter((r) => r.pendingEvent)
    .map((r) => ({ id: r.tenant.id, name: r.tenant.name, roomNo: r.roomNo, title: r.pendingEvent!.title })),
);

const rows = computed(() => buildFeed().map((e) => ({ e, unread: e.gameMs > props.sinceMs })));
/** 本月章節(全樓事件鏈):進行中或剛完結的一條鏈,已發生的話逐條列出 */
const chain = computed(() => {
  void state.floorChain; // 依賴狀態槽,推進時重算
  return floorChainView();
});
const chainDots = computed(() => (chain.value ? Array.from({ length: chain.value.total }, (_, i) => i + 1) : []));
const chainUnread = computed(() => (chain.value?.entries ?? []).some((e) => e.gameMs > props.sinceMs));
const weeklyReports = computed(() => [...state.weeklyReports].reverse().slice(0, 4).map((report) => ({ report, unread: report.gameMs > props.sinceMs })));
const money = (value: number) => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString()}`;

const KIND_BADGE = { diary: "📖 當日觀察", decision: "🏠 房東介入", event: "◆ 事件", notice: "📢 公告" } as const;
const PROVIDER_LABEL: Record<string, string> = {
  "gemini-flash": "Gemini Flash", "gemini-flash-lite": "Gemini Lite", "workers-ai-qwen": "Workers Qwen", "workers-ai-llama": "Workers Llama", claude: "Claude",
};
// ⚠️ 這張表必須與 FeedPanel.vue / LogFeed.vue 兩處完全一致(同一份文案,兩個入口都會顯示)。
// 既有標籤文字有測試在斷言,不得更動;H 批只新增下面五個。
const FALLBACK_LABEL: Record<string, string> = {
  catchup: "掛機補進度", quota: "免費額度已滿", offline: "目前離線", no_key: "未設定服務", forbidden: "連線驗證失敗",
  parse: "AI 格式異常", upstream: "AI 暫時無回應", unknown: "稍後再試",
  timeout: "AI 回應逾時", busy: "AI 補寫排隊中", hidden: "分頁在背景", budget: "今日補寫已滿", internal: "資料異常",
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

    <section v-if="chain" class="chain-section">
      <div class="chain-title">📖 本月章節</div>
      <details class="chain-card" :class="{ unread: chainUnread }" open>
        <summary>
          <span>{{ chain.icon }} {{ chain.title }}</span>
          <small>第 {{ chain.stage }} 話 / 共 {{ chain.total }} 話</small>
          <b :class="{ done: chain.done }">{{ chain.done ? '已完結' : '連載中' }}</b>
          <em v-if="chainUnread">NEW</em>
        </summary>
        <div class="chain-body">
          <div class="chain-dots">
            <i v-for="n in chainDots" :key="n" :class="{ on: n <= chain.stage }" />
          </div>
          <ul v-if="chain.entries.length">
            <li v-for="e in chain.entries" :key="e.stage" :class="{ skipped: e.skipped }">
              <strong>{{ e.title }}</strong>
              <span>{{ e.text }}</span>
              <small v-if="e.decision">房東抉擇:{{ e.decision }}</small>
            </li>
          </ul>
          <p v-else>章節剛開始,還沒有進展。</p>
        </div>
      </details>
    </section>

    <section v-if="weeklyReports.length" class="weekly-section">
      <div class="weekly-title">📊 生活週報</div>
      <details
        v-for="({ report, unread }, i) in weeklyReports"
        :key="report.id"
        class="weekly-card"
        :class="{ unread }"
        :open="i === 0"
      >
        <summary>
          <span>第 {{ report.week }} 週</span>
          <small>第 {{ report.startDay }}–{{ report.endDay }} 天</small>
          <b :class="report.net >= 0 ? 'positive' : 'negative'">{{ money(report.net) }}</b>
          <em v-if="unread">NEW</em>
        </summary>
        <div class="weekly-body">
          <div class="cash-row">
            <span>收入 <b class="positive">+${{ report.income.toLocaleString() }}</b></span>
            <span>支出 <b class="negative">−${{ report.expense.toLocaleString() }}</b></span>
          </div>
          <div class="weekly-block">
            <strong>本週大事</strong>
            <ul v-if="report.highlights.length">
              <li v-for="(item, j) in report.highlights" :key="j">
                <span v-if="item.tenantName">{{ item.tenantName }} · </span>{{ item.text }}
              </li>
            </ul>
            <p v-else>這週沒有重大事件，大家平安過日子。</p>
          </div>
          <div class="weekly-block">
            <strong>關係變化</strong>
            <ul v-if="report.relationshipChanges.length">
              <li v-for="(rel, j) in report.relationshipChanges" :key="j">
                {{ rel.aName }} × {{ rel.bName }}
                <b :class="rel.delta >= 0 ? 'positive' : 'negative'">{{ rel.delta >= 0 ? '+' : '' }}{{ rel.delta }}</b>
                <small>{{ rel.label }} · {{ rel.current }}</small>
              </li>
            </ul>
            <p v-else>本週人際關係大致平穩。</p>
          </div>
        </div>
      </details>
    </section>

    <p v-if="!rows.length && !weeklyReports.length && !chain" class="empty">還沒有動態。時間推進後,全棟的故事會匯集在這裡。</p>

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
        <span v-else-if="row.e.aiPending" class="pending-chip">⏳ 待補 · {{ fallbackLabel(row.e.aiFallbackReason) }}</span>
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

.chain-section { display: flex; flex-direction: column; gap: 6px; }
.chain-title { font-size: 12px; font-weight: 700; color: #ffd6a3; letter-spacing: 0.5px; }
.chain-card { border: 1px solid rgba(255,180,94,0.45); border-radius: 11px; background: linear-gradient(180deg, rgba(255,180,94,0.12), rgba(255,180,94,0.03)); overflow: hidden; }
.chain-card.unread { box-shadow: 0 0 0 1px rgba(255,180,94,0.35); }
.chain-card summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; gap: 8px; padding: 9px 11px; flex-wrap: wrap; }
.chain-card summary::-webkit-details-marker { display: none; }
.chain-card summary span { font-size: 13px; font-weight: 700; color: #ffd6a3; }
.chain-card summary small { font-size: 10.5px; color: var(--text-dim); }
.chain-card summary b { margin-left: auto; font-size: 10.5px; color: var(--accent); }
.chain-card summary b.done { color: var(--text-dim); }
.chain-card summary em { font-size: 8.5px; font-style: normal; color: #ffd6a3; border: 1px solid rgba(255,180,94,0.55); border-radius: 999px; padding: 0 5px; }
.chain-body { border-top: 1px solid rgba(255,180,94,0.25); padding: 9px 11px 11px; display: grid; gap: 8px; }
.chain-dots { display: flex; gap: 6px; }
.chain-dots i { width: 100%; height: 4px; border-radius: 999px; background: rgba(255,255,255,0.10); }
.chain-dots i.on { background: var(--accent); }
.chain-body ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 7px; }
.chain-body li { display: grid; gap: 2px; }
.chain-body li.skipped { opacity: 0.55; }
.chain-body li strong { font-size: 11.5px; color: #ffd6a3; }
.chain-body li span, .chain-body p { font-size: 11.5px; line-height: 1.55; color: var(--text); margin: 0; }
.chain-body li small { font-size: 10.5px; color: var(--text-dim); }

.weekly-section { display: flex; flex-direction: column; gap: 6px; }
.weekly-title { font-size: 12px; font-weight: 700; color: #9fd4ff; letter-spacing: 0.5px; }
.weekly-card { border: 1px solid rgba(90, 170, 225, 0.45); border-radius: 11px; background: linear-gradient(180deg, rgba(70,145,200,0.12), rgba(70,145,200,0.03)); overflow: hidden; }
.weekly-card.unread { box-shadow: 0 0 0 1px rgba(90,170,225,0.35); }
.weekly-card summary { cursor: pointer; list-style: none; display: flex; align-items: baseline; gap: 8px; padding: 9px 11px; }
.weekly-card summary::-webkit-details-marker { display: none; }
.weekly-card summary span { font-size: 13px; font-weight: 700; color: #b8e2ff; }
.weekly-card summary small { font-size: 10.5px; color: var(--text-dim); }
.weekly-card summary b { margin-left: auto; font-size: 13px; }
.weekly-card summary em { font-size: 8.5px; font-style: normal; color: #b8e2ff; border: 1px solid rgba(90,170,225,0.55); border-radius: 999px; padding: 0 5px; }
.weekly-body { border-top: 1px solid rgba(90,170,225,0.25); padding: 9px 11px 11px; display: grid; gap: 9px; }
.cash-row { display: flex; gap: 16px; font-size: 11px; color: var(--text-dim); }
.weekly-block strong { display: block; font-size: 11px; color: #b8e2ff; margin-bottom: 3px; }
.weekly-block ul { margin: 0; padding-left: 17px; display: grid; gap: 3px; }
.weekly-block li, .weekly-block p { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--text); }
.weekly-block li > span, .weekly-block li > small { color: var(--text-dim); font-size: 10.5px; }
.positive { color: var(--good) !important; }
.negative { color: var(--bad) !important; }

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
