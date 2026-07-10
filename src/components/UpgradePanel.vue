<script setup lang="ts">
import { computed } from "vue";
import { UPGRADES, roomUpgradeIds, upgradeRentBonus } from "../sim/upgrades";
import { state, buyUpgrade } from "../store";

const props = defineProps<{ roomId: string }>();
const emit = defineEmits<{ close: []; done: [text: string] }>();

const roomNo = computed(() => props.roomId.replace(/^r/, ""));
const installed = computed(() => roomUpgradeIds(props.roomId));
const bonusPct = computed(() => Math.round(upgradeRentBonus(props.roomId) * 100));

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const attrChips = (attrs: Record<string, number | undefined>) =>
  Object.entries(attrs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${ATTR_LABEL[k] ?? k}+${v}`);

function onBuy(id: string, name: string) {
  const res = buyUpgrade(props.roomId, id);
  if (res.ok) {
    emit("done", `✅ ${roomNo.value} 房「${name}」改建完成!`);
  } else {
    emit("done", `改建失敗:${res.reason}`);
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">🔨 {{ roomNo }} 房改建</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <p class="hint">
        改建是<b>一次性大額投資、不可退</b>:永久提高房間屬性,拉高應徵者的租金行情
        <template v-if="bonusPct">(目前行情 +{{ bonusPct }}%)</template>,對在住租客談漲租也更站得住腳。
      </p>

      <div class="list">
        <div v-for="u in UPGRADES" :key="u.id" class="item" :class="{ done: installed.includes(u.id) }">
          <div class="row1">
            <span class="icon">{{ u.icon }}</span>
            <span class="name">{{ u.name }}</span>
            <span class="price" v-if="!installed.includes(u.id)">${{ u.price.toLocaleString() }}</span>
            <span class="owned" v-else>✓ 已完成</span>
          </div>
          <p class="desc">{{ u.desc }}</p>
          <div class="chips">
            <span v-for="c in attrChips(u.attributes)" :key="c" class="a">{{ c }}</span>
            <span class="a">租金行情 +{{ Math.round(u.rentBonus * 100) }}%</span>
            <span class="a">談漲租容忍 +{{ Math.round(u.tolBonus * 100) }}%</span>
          </div>
          <button
            v-if="!installed.includes(u.id)"
            class="buy"
            :disabled="state.money < u.price"
            @click="onBuy(u.id, u.name)"
          >
            {{ state.money < u.price ? "金錢不足" : `動工(-$${u.price.toLocaleString()})` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 135; background: rgba(8,7,12,0.72); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 84vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; animation: up 0.25s ease-out; }
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }

.hint { font-size: 12px; color: var(--text-dim); line-height: 1.7; padding: 10px 16px 4px; }
.hint b { color: var(--accent); }

.list { overflow-y: auto; padding: 8px 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.item { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.item.done { opacity: 0.75; border-color: var(--good); }
.row1 { display: flex; align-items: baseline; gap: 8px; }
.icon { font-size: 16px; }
.name { font-weight: 700; font-size: 15px; }
.price { margin-left: auto; font-size: 14px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
.owned { margin-left: auto; font-size: 12.5px; color: var(--good); font-weight: 700; }
.desc { font-size: 12.5px; line-height: 1.6; color: var(--text); opacity: 0.9; margin: 6px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.a { font-size: 11px; color: var(--good); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.buy { width: 100%; background: rgba(255,180,94,0.14); border: 1px solid var(--accent); color: #ffd6a3; font-weight: 700; font-size: 13.5px; border-radius: 8px; padding: 9px 0; }
.buy:disabled { opacity: 0.5; }
</style>
