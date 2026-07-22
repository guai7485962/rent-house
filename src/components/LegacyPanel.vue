<script setup lang="ts">
/** 傳承(§G-7/G-8):成就冊 + 歷任房客名冊。純唯讀翻閱。 */
import { computed, ref } from "vue";
import { state, ACHIEVEMENTS, unlock } from "../store";

const emit = defineEmits<{ close: [] }>();
const tab = ref<"ach" | "alumni">("ach");

const unlocked = computed(() => new Set(state.achievements));
const gotCount = computed(() => ACHIEVEMENTS.filter((a) => unlocked.value.has(a.id)).length);

// 展開中的告別信(以離開時間為穩定 key,避免名冊順序變動時錯位)
const openLetters = ref<Set<number>>(new Set());
function toggleLetter(key: number) {
  const next = new Set(openLetters.value);
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    unlock("first_letter"); // ✉️ 見字如面:首次展開告別信(冪等)
  }
  openLetters.value = next;
}

function fmtMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <div class="lg-overlay" @click.self="emit('close')">
    <div class="lg-panel">
      <header class="lg-head">
        <div class="lg-ttl">🏆 傳承</div>
        <button class="lg-x" @click="emit('close')">✕</button>
      </header>

      <div class="lg-tabs">
        <button :class="{ on: tab === 'ach' }" @click="tab = 'ach'">成就 {{ gotCount }}/{{ ACHIEVEMENTS.length }}</button>
        <button :class="{ on: tab === 'alumni' }" @click="tab = 'alumni'">歷任房客 {{ state.alumni.length }}</button>
      </div>

      <!-- 成就冊 -->
      <div v-if="tab === 'ach'" class="lg-list">
        <div v-for="a in ACHIEVEMENTS" :key="a.id" class="ach" :class="{ locked: !unlocked.has(a.id) }">
          <span class="ach-ic">{{ unlocked.has(a.id) ? a.icon : "🔒" }}</span>
          <div class="ach-body">
            <div class="ach-lb">{{ unlocked.has(a.id) ? a.label : "??????" }}</div>
            <!-- 隱藏成就:解鎖前連達成條件都不透露,留探索樂趣 -->
            <div class="ach-desc">{{ unlocked.has(a.id) || !a.hidden ? a.desc : "???(隱藏成就,達成後揭曉)" }}</div>
          </div>
        </div>
      </div>

      <!-- 歷任房客名冊 -->
      <div v-else class="lg-list">
        <p v-if="!state.alumni.length" class="lg-empty">還沒有房客離開。好好對待他們吧。</p>
        <div v-for="(al, i) in state.alumni" :key="i" class="al">
          <div class="al-top">
            <span class="al-name">{{ al.name }}</span>
            <span class="al-occ">{{ al.occupation }}</span>
            <span class="al-days">住了 {{ al.daysLived }} 天</span>
          </div>
          <div class="al-memory">「{{ al.memory }}」</div>
          <div class="al-foot">{{ fmtMs(al.leftMs) }} 離開 · {{ al.reason }}</div>
          <template v-if="al.farewell">
            <button class="al-letter-btn" @click="toggleLetter(al.leftMs)">
              {{ openLetters.has(al.leftMs) ? "✉️ 收起告別信" : "✉️ 展開告別信" }}
            </button>
            <div v-if="openLetters.has(al.leftMs)" class="al-letter">{{ al.farewell }}</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lg-overlay {
  position: fixed;
  inset: 0;
  background: rgba(8, 7, 12, 0.72);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 40;
  backdrop-filter: blur(2px);
}
.lg-panel {
  width: 100%;
  max-width: 460px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--panel, #1b1826);
  border: 1px solid var(--line);
  border-radius: 16px 16px 0 0;
  padding: 14px 14px 20px;
}
.lg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.lg-ttl {
  font-size: 16px;
  font-weight: 700;
}
.lg-x {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 18px;
  cursor: pointer;
}
.lg-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.lg-tabs button {
  flex: 1;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
}
.lg-tabs button.on {
  background: var(--accent, #7c6cff);
  border-color: var(--accent, #7c6cff);
  color: #fff;
  font-weight: 700;
}
.lg-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lg-empty {
  color: var(--text-dim);
  text-align: center;
  padding: 24px 0;
  font-size: 13px;
}

.ach {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--line);
}
.ach.locked {
  opacity: 0.55;
}
.ach-ic {
  font-size: 22px;
  width: 28px;
  text-align: center;
}
.ach-lb {
  font-weight: 700;
  font-size: 14px;
}
.ach-desc {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-top: 1px;
}

.al {
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--line);
}
.al-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.al-name {
  font-weight: 700;
  font-size: 14px;
}
.al-occ {
  font-size: 11.5px;
  color: var(--text-dim);
}
.al-days {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--accent-2, #8fd0ff);
}
.al-memory {
  font-size: 12.5px;
  margin: 5px 0 4px;
  line-height: 1.45;
  color: var(--text);
}
.al-foot {
  font-size: 11px;
  color: var(--text-dim);
}
.al-letter-btn {
  margin-top: 8px;
  width: 100%;
  padding: 7px 0;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: rgba(124, 108, 255, 0.1);
  color: var(--accent-2, #8fd0ff);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.al-letter {
  margin-top: 8px;
  padding: 12px 13px;
  border-radius: 10px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent, #7c6cff);
  background: rgba(255, 255, 255, 0.05);
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text);
  letter-spacing: 0.2px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
