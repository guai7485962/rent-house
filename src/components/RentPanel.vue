<script setup lang="ts">
import { computed, ref } from "vue";
import { state, previewRent, proposeRent, previewEviction, evictTenant, type EvictionMode } from "../store";

const props = defineProps<{ tenantId: string }>();
const emit = defineEmits<{ close: []; done: [text: string]; evicted: [] }>();

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
const evictionMode = ref<EvictionMode | null>(null);
const evictionError = ref("");
const eviction = computed(() => evictionMode.value ? previewEviction(props.tenantId, evictionMode.value) : null);

function onConfirm() {
  const res = proposeRent(props.tenantId, proposed.value);
  emit("done", res.text);
  emit("close");
}

function requestEviction(mode: EvictionMode) {
  evictionError.value = "";
  evictionMode.value = mode;
}

function confirmEviction() {
  if (!evictionMode.value) return;
  const result = evictTenant(props.tenantId, evictionMode.value);
  if (!result.ok) {
    evictionError.value = result.text;
    return;
  }
  emit("evicted");
  emit("close");
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="card" v-if="rt">
      <div class="head">
        <span class="ttl">📄 租約管理 · {{ rt.tenant.name }}</span>
        <button class="x" @click="emit('close')">✕</button>
      </div>

      <section v-if="pv" class="rent-section">
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
        <p v-if="onCooldown" class="verdict bad">才剛談過,{{ pv.cooldownLeft }} 遊戲日後才能再談。</p>
        <p v-else-if="verdictInfo" class="verdict" :class="verdictInfo.cls">預感:{{ verdictInfo.label }}</p>

        <div class="actions rent-actions">
          <button class="confirm" :disabled="pctStep === 0 || onCooldown" @click="onConfirm">開口談房租</button>
        </div>
      </section>
      <p v-else class="cohabit-note">這位住戶目前是同居者,沒有獨立月租,但仍可在下方終止居住。</p>

      <section class="end-section">
        <div class="end-title">終止居住</div>
        <p class="hint">房客離開後會進入歷任房客名冊;寵物、關係與同居資料會一併正確處理。</p>
        <div class="end-options">
          <button class="end-option agreement" @click="requestEviction('agreement')">
            <b>🤝 協議解約</b>
            <span>支付一個月租金作為搬遷補償,其他住戶不受影響。</span>
          </button>
          <button class="end-option forced" @click="requestEviction('forced')">
            <b>🚪 強制請離</b>
            <span>不需付錢,但全體住戶的好感與滿意度都會下降。</span>
          </button>
        </div>

        <div v-if="evictionMode && eviction" class="confirm-box" :class="evictionMode">
          <b v-if="evictionMode === 'agreement'">確定支付 ${{ eviction.cost.toLocaleString() }}，和 {{ rt.tenant.name }} 協議解約？</b>
          <b v-else>確定強制請 {{ rt.tenant.name }} 搬走？</b>
          <p v-if="eviction.handoffName">{{ eviction.handoffName }} 目前與他同居，離開後將接手這間房與租約。</p>
          <p v-else-if="eviction.isLeaseHolder">這間房會立即空出，可以重新招租。</p>
          <p v-else>他會搬離目前同居的房間，原承租人會留下。</p>
          <p v-if="evictionMode === 'forced'" class="danger-copy">其他住戶會因為缺乏安全感而降低好感、滿意度與心情。</p>
          <p v-if="evictionMode === 'agreement' && !eviction.canAfford" class="verdict bad">現金不足，無法支付搬遷補償。</p>
          <p v-if="evictionError" class="verdict bad">{{ evictionError }}</p>
          <div class="actions">
            <button class="cancel" @click="evictionMode = null">取消</button>
            <button class="evict-confirm" :class="evictionMode" :disabled="evictionMode === 'agreement' && !eviction.canAfford" @click="confirmEviction">
              {{ evictionMode === "agreement" ? "支付並解約" : "確認強制請離" }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 130; background: rgba(8,7,12,0.6); display: flex; align-items: flex-end; justify-content: center; }
.card { width: 100%; max-width: 430px; max-height: 92vh; overflow-y: auto; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; padding: 16px; animation: up 0.2s ease-out; }
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
.rent-section { margin-top: 4px; }
.rent-actions { justify-content: flex-end; }
.rent-actions .confirm { flex: 0 0 55%; }
.cohabit-note { margin: 12px 2px; padding: 10px; border-radius: 10px; background: var(--panel); color: var(--text-dim); font-size: 12px; line-height: 1.6; }
.end-section { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; }
.end-title { font-weight: 700; font-size: 14px; color: #ffb6b6; }
.end-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.end-option { min-width: 0; text-align: left; border-radius: 11px; padding: 10px; display: flex; flex-direction: column; gap: 5px; }
.end-option b { font-size: 13px; }
.end-option span { font-size: 10.5px; line-height: 1.45; color: var(--text-dim); }
.end-option.agreement { background: rgba(90,208,106,0.08); border: 1px solid rgba(90,208,106,0.45); color: #b6ffbe; }
.end-option.forced { background: rgba(255,92,92,0.08); border: 1px solid rgba(255,92,92,0.5); color: #ffb6b6; }
.confirm-box { margin-top: 10px; padding: 11px; border-radius: 11px; font-size: 12px; line-height: 1.55; }
.confirm-box.agreement { border: 1px solid rgba(90,208,106,0.45); background: rgba(90,208,106,0.07); }
.confirm-box.forced { border: 1px solid rgba(255,92,92,0.55); background: rgba(255,92,92,0.08); }
.confirm-box p { margin: 5px 0 0; color: var(--text-dim); }
.confirm-box .danger-copy { color: #ffb6b6; }
.evict-confirm { flex: 1; border-radius: 10px; padding: 10px 4px; font-size: 13px; font-weight: 700; }
.evict-confirm.agreement { background: rgba(90,208,106,0.16); border: 1px solid var(--good); color: #b6ffbe; }
.evict-confirm.forced { background: rgba(255,92,92,0.16); border: 1px solid var(--bad); color: #ffb6b6; }
.evict-confirm:disabled { opacity: 0.45; }
</style>
