<script setup lang="ts">
import { computed } from "vue";
import { getDef, type FurnCategory } from "../furniture/catalog";

const props = defineProps<{ c: number; r: number; defId: string }>();
const emit = defineEmits<{ close: []; sell: [] }>();

const def = computed(() => getDef(props.defId));
const refund = computed(() => Math.round(def.value.price / 2));

const CAT_LABEL: Record<FurnCategory, string> = {
  sleep: "睡眠", work: "工作", av: "影音", seating: "座椅",
  kitchen: "餐廚", storage: "收納", ambiance: "氛圍", utility: "機能",
};
const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const attrs = computed(() => Object.entries(def.value.attributes).filter(([, v]) => v));
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="card">
      <div class="head">
        <span class="cat">{{ CAT_LABEL[def.category] }}</span>
        <span class="name">{{ def.name }}</span>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <div class="chips">
        <span class="fp">佔 {{ def.footprint.w }}×{{ def.footprint.h }} 格</span>
        <span v-for="[k, v] in attrs" :key="k" class="a">{{ ATTR_LABEL[k] ?? k }}{{ v! > 0 ? "+" : "" }}{{ v }}</span>
        <span v-if="def.social" class="social">社交點</span>
      </div>

      <p v-if="def.promptHints.length" class="hint">「{{ def.promptHints[0] }}」</p>

      <div class="actions">
        <button class="cancel" @click="emit('close')">關閉</button>
        <button class="sell" @click="emit('sell')">賣掉(退 ${{ refund.toLocaleString() }})</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 130; background: rgba(8,7,12,0.6); display: flex; align-items: flex-end; justify-content: center; }
.card { width: 100%; max-width: 430px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; padding: 16px; animation: up 0.2s ease-out; }
@keyframes up { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.head { display: flex; align-items: baseline; gap: 8px; }
.cat { font-size: 11px; color: var(--text-dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.name { font-weight: 700; font-size: 16px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 0; }
.fp { font-size: 11px; color: var(--text-dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.a { font-size: 11px; color: var(--good); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.social { font-size: 11px; color: var(--accent-2); border: 1px solid var(--accent-2); border-radius: 999px; padding: 1px 8px; }
.hint { font-size: 12.5px; color: var(--text-dim); line-height: 1.6; margin-bottom: 12px; }

.actions { display: flex; gap: 8px; }
.cancel { flex: 1; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 10px 0; font-size: 13.5px; }
.sell { flex: 1; background: rgba(232,101,122,0.14); border: 1px solid var(--bad); color: #ff9aa8; font-weight: 700; border-radius: 10px; padding: 10px 0; font-size: 13.5px; }
</style>
