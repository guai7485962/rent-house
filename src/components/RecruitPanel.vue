<script setup lang="ts">
import { computed } from "vue";
import type { Applicant } from "../sim/recruit";
import { roomAttributes } from "../sim/placements";
import { moveIn, getApplicants } from "../store";

const props = defineProps<{ roomId: string }>();
const emit = defineEmits<{ close: [] }>();

// 每遊戲日換一批(存在 store,開關面板/重整頁面不重抽;星等隨當前裝潢即時更新)
const applicants = computed<Applicant[]>(() => getApplicants(props.roomId));

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const attrs = computed(() =>
  Object.entries(roomAttributes(props.roomId)).filter(([, v]) => v).map(([k, v]) => ({ label: ATTR_LABEL[k] ?? k, value: v as number })),
);
const roomNo = computed(() => props.roomId.replace(/^r/, ""));

function accept(a: Applicant) {
  moveIn(props.roomId, a);
  emit("close");
}
function stars(n: number) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">🔑 {{ roomNo }} 房招租</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="room-attrs">
        <span class="lbl">目前裝潢屬性:</span>
        <template v-if="attrs.length">
          <span v-for="a in attrs" :key="a.label" class="a">{{ a.label }}+{{ a.value }}</span>
        </template>
        <span v-else class="empty">尚未裝潢(先去家具商店佈置,能吸引更契合的租客)</span>
      </div>

      <div class="hint">契合度越高的租客,越滿意這個房間、越準時交租。每個遊戲日會換一批應徵者。</div>

      <div class="list">
        <div v-for="a in applicants" :key="a.id" class="app">
          <div class="row1">
            <span class="name">{{ a.name }}</span>
            <span class="job">{{ a.occupation }}</span>
            <span class="stars">{{ stars(a.stars) }}</span>
          </div>
          <p class="bio">{{ a.bio }}</p>
          <div class="row2">
            <span v-for="t in a.coreTags" :key="t.id" class="tag">{{ t.label }}</span>
            <span class="rent">月租 ${{ a.monthlyRent.toLocaleString() }}</span>
          </div>
          <button class="accept" @click="accept(a)">讓 {{ a.name }} 入住</button>
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

.room-attrs { padding: 10px 16px 4px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.room-attrs .lbl { color: var(--text-dim); }
.room-attrs .a { color: var(--good); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.room-attrs .empty { color: var(--text-dim); }
.hint { font-size: 11.5px; color: var(--text-dim); padding: 2px 16px 6px; }

.list { overflow-y: auto; padding: 4px 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.app { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.row1 { display: flex; align-items: baseline; gap: 8px; }
.name { font-weight: 700; font-size: 15px; }
.job { font-size: 12px; color: var(--text-dim); }
.stars { margin-left: auto; color: var(--accent); font-size: 13px; letter-spacing: 1px; }
.bio { font-size: 12.5px; line-height: 1.6; color: var(--text); opacity: 0.9; margin: 6px 0; }
.row2 { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--accent-2); color: #c9befc; }
.rent { margin-left: auto; font-size: 12px; color: var(--accent); }
.accept { width: 100%; background: linear-gradient(135deg, var(--accent-2), #7059d6); color: #fff; font-weight: 700; font-size: 13.5px; border-radius: 8px; padding: 9px 0; }
</style>
