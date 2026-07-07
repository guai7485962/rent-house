<script setup lang="ts">
import type { EventDef } from "../sim/events";

defineProps<{ event: EventDef; tenantName: string }>();
const emit = defineEmits<{ decide: [choiceId: string, label: string] }>();
</script>

<template>
  <div class="overlay">
    <div class="modal" :class="{ ai: event.ai }">
      <div class="tag">
        <span v-if="event.ai" class="ai-badge">✨ AI 事件</span>
        ⚠ 房東抉擇 — {{ tenantName }}
      </div>
      <h2>{{ event.title }}</h2>
      <p class="desc">{{ event.description }}</p>
      <div class="choices">
        <button
          v-for="c in event.choices"
          :key="c.id"
          class="choice"
          @click="emit('decide', c.id, c.label)"
        >
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
  border: 1px solid var(--accent);
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  animation: pop 0.25s ease-out;
}

@keyframes pop {
  from { transform: scale(0.92); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.tag {
  font-size: 11px;
  color: var(--accent);
  letter-spacing: 1px;
  margin-bottom: 8px;
}
.modal.ai { border-color: var(--accent-2); }
.ai-badge {
  color: #cdbcff;
  background: rgba(143, 123, 255, 0.16);
  border: 1px solid var(--accent-2);
  border-radius: 999px;
  padding: 1px 7px;
  margin-right: 6px;
  letter-spacing: 0;
}

h2 {
  font-size: 18px;
  margin-bottom: 10px;
}

.desc {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text);
  opacity: 0.9;
  margin-bottom: 16px;
}

.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

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
.choice:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.choice:active {
  transform: translateY(0);
}
.label {
  font-size: 14.5px;
  font-weight: 600;
}
.hint {
  font-size: 11.5px;
  color: var(--text-dim);
}
</style>
