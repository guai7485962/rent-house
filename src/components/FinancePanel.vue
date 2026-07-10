<script setup lang="ts">
import { computed } from "vue";
import { state, type TxnCategory } from "../store";

const emit = defineEmits<{ close: [] }>();

const CAT_LABEL: Record<TxnCategory, string> = {
  rent: "租金收入", furniture: "家具", upgrade: "房間改建", event: "事件", upkeep: "管理費", other: "其他",
};

const income = computed(() => state.ledger.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
const expense = computed(() => state.ledger.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0));

const byCat = computed(() => {
  const m: Record<string, number> = {};
  for (const t of state.ledger) m[t.category] = (m[t.category] ?? 0) + t.amount;
  return (Object.keys(CAT_LABEL) as TxnCategory[])
    .map((c) => ({ cat: c, label: CAT_LABEL[c], net: m[c] ?? 0 }))
    .filter((x) => x.net !== 0);
});

const recent = computed(() => [...state.ledger].reverse());

function tlabel(ms: number) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
}
const money = (n: number) => (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toLocaleString();
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">💰 收支</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="balance">
        <span class="lbl">目前餘額</span>
        <span class="amt">${{ state.money.toLocaleString() }}</span>
      </div>

      <div class="io">
        <div class="io-cell in"><span>總收入</span><b>+${{ income.toLocaleString() }}</b></div>
        <div class="io-cell out"><span>總支出</span><b>−${{ expense.toLocaleString() }}</b></div>
      </div>

      <div class="cats" v-if="byCat.length">
        <div v-for="c in byCat" :key="c.cat" class="cat">
          <span class="cl">{{ c.label }}</span>
          <span class="cv" :class="c.net >= 0 ? 'pos' : 'neg'">{{ money(c.net) }}</span>
        </div>
      </div>

      <div class="tx-ttl">最近交易</div>
      <div class="list">
        <div v-if="recent.length === 0" class="empty">還沒有任何收支紀錄。</div>
        <div v-for="(t, i) in recent" :key="i" class="tx">
          <span class="tlabel">{{ tlabel(t.gameMs) }}</span>
          <span class="tname">{{ t.label }}</span>
          <span class="tamt" :class="t.amount >= 0 ? 'pos' : 'neg'">{{ money(t.amount) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 120; background: rgba(8,7,12,0.72); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 84vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; animation: up 0.25s ease-out; }
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }

.balance { display: flex; align-items: baseline; justify-content: space-between; padding: 14px 16px 6px; }
.balance .lbl { font-size: 12px; color: var(--text-dim); }
.balance .amt { font-size: 26px; font-weight: 800; color: var(--accent); }

.io { display: flex; gap: 10px; padding: 6px 16px 10px; }
.io-cell { flex: 1; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; }
.io-cell span { font-size: 11px; color: var(--text-dim); }
.io-cell b { font-size: 15px; }
.io-cell.in b { color: var(--good); }
.io-cell.out b { color: var(--bad); }

.cats { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 16px 12px; }
.cat { display: flex; gap: 6px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; font-size: 12px; }
.cat .cl { color: var(--text-dim); }
.pos { color: var(--good); }
.neg { color: var(--bad); }

.tx-ttl { font-size: 12px; color: var(--text-dim); padding: 4px 16px; border-top: 1px solid var(--line); }
.list { overflow-y: auto; padding: 4px 16px 20px; display: flex; flex-direction: column; gap: 2px; }
.empty { color: var(--text-dim); font-size: 13px; text-align: center; padding: 16px 0; }
.tx { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.tlabel { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.tname { font-size: 13px; }
.tamt { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
