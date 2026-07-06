<script setup lang="ts">
import { computed } from "vue";
import { listRelationships } from "../sim/social";
import { state } from "../store";

const emit = defineEmits<{ close: [] }>();

const name = (id: string) => state.runtimes[id]?.tenant.name ?? "已搬走";

const rels = computed(() =>
  listRelationships().filter((r) => state.runtimes[r.aId] && state.runtimes[r.bId]),
);
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">💞 鄰居關係</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div v-if="rels.length === 0" class="empty">
        鄰居們還不熟。讓他們在交誼廳多碰面(佈置沙發/電視/餐桌),關係就會開始發展。
      </div>

      <div v-else class="list">
        <div v-for="r in rels" :key="r.aId + r.bId" class="row" :class="{ love: r.romantic }">
          <span class="pair">{{ name(r.aId) }} <span class="amp">×</span> {{ name(r.bId) }}</span>
          <span class="tier">{{ r.romantic ? "❤️ " : "" }}{{ r.label }}</span>
          <div class="bar"><div :style="{ width: r.value + '%' }"></div></div>
        </div>
      </div>

      <p class="foot">關係由個性是否合拍決定;夠熟且互有好感(依性別/取向)才會發展成情侶。</p>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 120; background: rgba(8,7,12,0.72); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 82vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; animation: up 0.25s ease-out; }
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }
.empty { padding: 24px 18px; color: var(--text-dim); font-size: 13px; line-height: 1.7; text-align: center; }
.list { overflow-y: auto; padding: 10px 16px; display: flex; flex-direction: column; gap: 10px; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.row.love { border-color: #d9548a; background: rgba(217,84,138,0.08); }
.pair { font-size: 13.5px; font-weight: 600; }
.amp { color: var(--text-dim); margin: 0 2px; }
.tier { font-size: 12px; color: var(--accent); text-align: right; }
.bar { grid-column: 1 / -1; height: 6px; background: #17151f; border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; background: linear-gradient(90deg, var(--accent-2), #d9548a); border-radius: 4px; transition: width 0.5s; }
.foot { font-size: 11.5px; color: var(--text-dim); padding: 8px 16px 16px; line-height: 1.6; }
</style>
