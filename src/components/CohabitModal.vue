<script setup lang="ts">
import { resolveCohabit } from "../store";

const props = defineProps<{ aName: string; bName: string }>();
</script>

<template>
  <div class="overlay">
    <div class="card">
      <div class="emoji">❤️🏠</div>
      <h3>同居申請</h3>
      <p class="desc">
        {{ props.aName }} 和 {{ props.bName }} 感情穩定,想搬進同一間房一起住。
        同意的話,其中一間房會空出來(可再招租),但你會少收一份租金。
      </p>
      <div class="actions">
        <button class="no" @click="resolveCohabit(false)">再考慮</button>
        <button class="yes" @click="resolveCohabit(true)">祝福他們同居</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 140; background: rgba(8,7,12,0.7); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { width: 100%; max-width: 340px; background: var(--panel-2); border: 1px solid #d9548a; border-radius: 16px; padding: 22px 20px; text-align: center; animation: pop 0.25s ease-out; }
@keyframes pop { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.emoji { font-size: 34px; }
h3 { font-size: 17px; margin: 8px 0 6px; }
.desc { font-size: 13px; color: var(--text-dim); line-height: 1.7; margin-bottom: 18px; }
.actions { display: flex; gap: 10px; }
.no { flex: 1; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 11px 0; font-size: 13.5px; }
.yes { flex: 1.4; background: linear-gradient(135deg, #d9548a, #b8437a); color: #fff; font-weight: 700; border-radius: 10px; padding: 11px 0; font-size: 13.5px; }
</style>
