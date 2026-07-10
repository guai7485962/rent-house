<script setup lang="ts">
import { computed, ref } from "vue";
import { state, previewRent, proposeRent } from "../store";

const props = defineProps<{ tenantId: string }>();
const emit = defineEmits<{ close: []; done: [text: string] }>();

const rt = computed(() => state.runtimes[props.tenantId]);
const curRent = computed(() => rt.value?.tenant.finance.monthlyRent ?? 0);

/** 提案幅度(%),5% 一格;金額四捨五入到 $50 */
const pctStep = ref(0);
const STEPS = [-20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30];
const proposed = computed(() => Math.round((curRent.value * (1 + pctStep.value / 100)) / 50) * 50);

const pv = computed(() => previewRent(props.tenantId, proposed.value));

const VERDICT: Record<string, { label: string; cls: string }> = {
  cut: { label: "會很感激(好感↑ 收入↓)", cls: "good" },
  safe: { label: "應該會接受(輕微傷感情)", cls: "good" },
  risky: { label: "有點冒險…會勉強接受但很不爽", cls: "warn" },
  reject: { label: "八成會翻臉拒絕!(關係惡化)", cls: "bad" },
};
const verdictInfo = computed(() => (pv.value && pctStep.value !== 0 ? VERDICT[pv.value.verdict] : null));
const onCooldown = computed(() => (pv.value?.cooldownLeft ?? 0) > 0);

function onConfirm() {
  const res = proposeRent(props.tenantId, proposed.value);
  emit("done", res.text);
  emit("close");
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="card" v-if="rt">
      <div class="head">
        <span class="ttl">💲 和 {{ rt.tenant.name }} 談房租</span>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <div class="row cur">
        <span>目前月租</span>
        <b>${{ curRent.toLocaleString() }}</b>
      </div>
      <p class="hint">滿意度和好感越高,越談得動漲租;漲太兇會被回絕、關係惡化,甚至萌生退租念頭。</p>

      <div class="steps">
        <button
          v-for="s in STEPS"
          :key="s"
          class="step"
          :class="{ on: pctStep === s, cut: s < 0, raise: s > 0 }"
          @click="pctStep = s"
        >
          {{ s > 0 ? "+" : "" }}{{ s }}%
        </button>
      </div>

      <div class="row next">
        <span>提案月租</span>
        <b>${{ proposed.toLocaleString() }}</b>
      </div>
      <p v-if="onCooldown" class="verdict bad">才剛談過,{{ pv!.cooldownLeft }} 遊戲日後才能再談。</p>
      <p v-else-if="verdictInfo" class="verdict" :class="verdictInfo.cls">預感:{{ verdictInfo.label }}</p>

      <div class="actions">
        <button class="cancel" @click="emit('close')">算了</button>
        <button class="confirm" :disabled="pctStep === 0 || onCooldown" @click="onConfirm">開口談</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 130; background: rgba(8,7,12,0.6); display: flex; align-items: flex-end; justify-content: center; }
.card { width: 100%; max-width: 430px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; padding: 16px; animation: up 0.2s ease-out; }
@keyframes up { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.head { display: flex; align-items: baseline; }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }

.row { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 2px 2px; font-size: 13px; }
.row span { color: var(--text-dim); font-size: 12px; }
.row.cur b { font-size: 16px; }
.row.next b { font-size: 20px; color: var(--accent); }
.hint { font-size: 11.5px; color: var(--text-dim); line-height: 1.6; margin: 4px 0 8px; }

.steps { display: flex; flex-wrap: wrap; gap: 5px; }
.step { background: var(--panel); border: 1px solid var(--line); color: var(--text-dim); border-radius: 8px; padding: 5px 0; font-size: 12px; flex: 1 0 16%; }
.step.cut.on { background: rgba(90,208,106,0.16); border-color: var(--good); color: #b6ffbe; }
.step.raise.on { background: rgba(255,180,94,0.16); border-color: var(--accent); color: #ffd6a3; }
.step.on { font-weight: 700; }

.verdict { font-size: 12.5px; margin: 4px 2px 0; }
.verdict.good { color: var(--good); }
.verdict.warn { color: var(--accent); }
.verdict.bad { color: var(--bad); }

.actions { display: flex; gap: 8px; margin-top: 12px; }
.cancel { flex: 0.7; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 10px 0; font-size: 13.5px; }
.confirm { flex: 1; background: rgba(255,180,94,0.14); border: 1px solid var(--accent); color: #ffd6a3; font-weight: 700; border-radius: 10px; padding: 10px 0; font-size: 13.5px; }
.confirm:disabled { opacity: 0.5; }
</style>
