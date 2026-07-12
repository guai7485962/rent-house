<script setup lang="ts">
/** 群體事件抉擇(§C-7):一件全樓事務,房東的選擇一次影響整群人。 */
import { computed } from "vue";
import type { GroupEvent } from "../types";
import { state } from "../store";

const props = defineProps<{ event: GroupEvent }>();
const emit = defineEmits<{ resolve: [choiceId: string] }>();

const names = computed(() =>
  props.event.participantIds.map((id) => state.runtimes[id]?.tenant.name).filter(Boolean).join("、"),
);
</script>

<template>
  <div class="overlay">
    <div class="modal">
      <div class="tag">🏢 全樓事務 — 房東抉擇</div>
      <h2>{{ event.title }}</h2>
      <p class="who">牽涉:{{ names }}</p>
      <p class="desc">{{ event.description }}</p>
      <div class="choices">
        <button v-for="c in event.choices" :key="c.id" class="choice" @click="emit('resolve', c.id)">
          <span class="label">{{ c.label }}</span>
          <span class="hint">{{ c.hint }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(8, 7, 12, 0.72);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.modal {
  width: 100%;
  max-width: 390px;
  background: var(--panel-2);
  border: 1px solid var(--accent-2, #8f7bff);
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  animation: pop 0.25s ease-out;
}
@keyframes pop {
  from { transform: scale(0.92); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.tag { font-size: 11px; color: var(--accent-2, #cdbcff); letter-spacing: 1px; margin-bottom: 8px; }
h2 { font-size: 18px; margin-bottom: 4px; }
.who { font-size: 11.5px; color: var(--text-dim); margin-bottom: 10px; }
.desc { font-size: 13.5px; line-height: 1.7; color: var(--text); opacity: 0.9; margin-bottom: 16px; }
.choices { display: flex; flex-direction: column; gap: 8px; }
.choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 14px;
  color: var(--text);
  transition: border-color 0.15s, transform 0.1s;
}
.choice:hover { border-color: var(--accent-2, #8f7bff); transform: translateY(-1px); }
.choice:active { transform: translateY(0); }
.label { font-size: 14.5px; font-weight: 600; }
.hint { font-size: 11.5px; color: var(--text-dim); }
</style>
