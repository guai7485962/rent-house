<script setup lang="ts">
import { computed } from "vue";
import { state, type TxnCategory } from "../store";

const emit = defineEmits<{ close: [] }>();

const CAT_LABEL: Record<TxnCategory, string> = {
  rent: "租金收入", furniture: "家具", upgrade: "房間改建", event: "事件", upkeep: "管理費", other: "其他",
};

const DAY = 24 * 3600 * 1000;
/** 視窗損益:近 n 遊戲日的 {收入, 支出, 淨額} */
function window(nDays: number) {
  const from = state.gameMs - nDays * DAY;
  let inc = 0;
  let exp = 0;
  for (const t of state.ledger) {
    if (t.gameMs < from) continue;
    if (t.amount > 0) inc += t.amount;
    else exp -= t.amount;
  }
  return { inc, exp, net: inc - exp };
}
const today = computed(() => window(1));
const week = computed(() => window(7));

/** 近 7 遊戲日,每日淨額(長條圖用;由舊到新) */
const dailyBars = computed(() => {
  const nets = Array(7).fill(0) as number[];
  const from = state.gameMs - 7 * DAY;
  for (const t of state.ledger) {
    if (t.gameMs < from) continue;
    const idx = Math.min(6, Math.floor((t.gameMs - from) / DAY));
    nets[idx] += t.amount;
  }
  const max = Math.max(1, ...nets.map((n) => Math.abs(n)));
  return nets.map((n) => ({ net: n, h: Math.round((Math.abs(n) / max) * 30) }));
});

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
        <div class="io-cell" :class="today.net >= 0 ? 'in' : 'out'">
          <span>近 1 天損益</span><b>{{ money(today.net) }}</b>
          <i>收 ${{ today.inc.toLocaleString() }} / 支 ${{ today.exp.toLocaleString() }}</i>
        </div>
        <div class="io-cell" :class="week.net >= 0 ? 'in' : 'out'">
          <span>近 7 天損益</span><b>{{ money(week.net) }}</b>
          <i>收 ${{ week.inc.toLocaleString() }} / 支 ${{ week.exp.toLocaleString() }}</i>
        </div>
      </div>

      <div class="chart">
        <span class="chart-lbl">近 7 日每日淨額</span>
        <div class="bars">
          <div v-for="(b, i) in dailyBars" :key="i" class="bar-wrap">
            <div class="vbar" :class="b.net >= 0 ? 'pos' : 'neg'" :style="{ height: Math.max(2, b.h) + 'px' }"></div>
          </div>
        </div>
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
.io-cell i { font-size: 10px; color: var(--text-dim); font-style: normal; }
.io-cell.in b { color: var(--good); }
.io-cell.out b { color: var(--bad); }

.chart { padding: 0 16px 10px; }
.chart-lbl { font-size: 11px; color: var(--text-dim); }
.bars { display: flex; gap: 5px; align-items: flex-end; height: 34px; margin-top: 4px; }
.bar-wrap { flex: 1; display: flex; align-items: flex-end; justify-content: center; background: #17151f; border-radius: 4px; height: 100%; }
.vbar { width: 70%; border-radius: 3px 3px 0 0; }
.vbar.pos { background: var(--good); }
.vbar.neg { background: var(--bad); }

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
