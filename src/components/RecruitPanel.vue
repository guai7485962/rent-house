<script setup lang="ts">
import { computed, ref } from "vue";
import { rescoreApplicants, type Applicant } from "../sim/recruit";
import { roomAttributes } from "../sim/placements";
import { requestInvite, sanitizeInvited, looksMinor } from "../sim/invite";
import { moveIn, getApplicants } from "../store";
import { relistApplicants, RELIST_COST } from "../sim/tenancy";
import { petAttitude } from "../sim/pets";
import { state } from "../sim/gameState";
import type { Gender, PetKind } from "../types";

// 樓內已有該物種時才提示相性；自帶寵物優先顯示。
const floorPetKinds = computed(() => [...new Set(Object.values(state.pets).map((pet) => pet.kind ?? "cat"))] as PetKind[]);
function petNote(a: Applicant): string {
  if (a.pet) return `${(a.pet.kind ?? "cat") === "dog" ? "🐕 自帶狗" : "🐈 自帶貓"}`;
  return floorPetKinds.value.map((kind) => {
    const attitude = petAttitude(a, kind);
    if (attitude === "neutral") return "";
    if (kind === "dog") return attitude === "like" ? "🐕 親狗" : "😰 怕狗/潔癖";
    return attitude === "like" ? "🐈 親貓" : "🙀 怕貓/潔癖";
  }).filter(Boolean).join(" · ");
}

const props = defineProps<{ roomId: string }>();
const emit = defineEmits<{ close: []; upgrade: [roomId: string] }>();

// 每遊戲日換一批(存在 store,開關面板/重整頁面不重抽;星等隨當前裝潢即時更新)
const applicants = computed<Applicant[]>(() => getApplicants(props.roomId));

// ---- 特邀租客(§9-3):名字+個性描述 → AI 生成角色 → 消毒 → 入住 ----
const showInvite = ref(false);
const invName = ref("");
const invDesc = ref("");
const invGender = ref<Gender>("male");
const invBusy = ref(false);
const invError = ref("");

async function submitInvite() {
  const name = invName.value.trim();
  const desc = invDesc.value.trim();
  invError.value = "";
  if (!name || !desc) {
    invError.value = "請填寫名字與個性描述。";
    return;
  }
  if (looksMinor(desc) || looksMinor(name)) {
    invError.value = "特邀租客僅接受成年角色,未成年角色不會被生成。";
    return;
  }
  invBusy.value = true;
  const res = await requestInvite(name, desc, invGender.value);
  invBusy.value = false;
  if (!res.ok) {
    invError.value =
      res.reason === "quota" ? "今日 AI 額度已用完,明天再試。" : res.reason === "offline" ? "連不上伺服器,稍後再試。" : "AI 生成失敗,換個描述再試一次。";
    return;
  }
  const s = sanitizeInvited(name, res.raw, invGender.value);
  if (!s.ok || !s.applicant) {
    invError.value = s.reason ?? "生成的角色資料不完整。";
    return;
  }
  rescoreApplicants([s.applicant], props.roomId); // 依當前裝潢算契合星等
  moveIn(props.roomId, s.applicant);
  emit("close");
}

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const attrs = computed(() =>
  Object.entries(roomAttributes(props.roomId)).filter(([, v]) => v).map(([k, v]) => ({ label: ATTR_LABEL[k] ?? k, value: v as number })),
);
const roomNo = computed(() => props.roomId.replace(/^r/, ""));
const GENDER_LABEL: Record<Gender, string> = { male: "男", female: "女", nonbinary: "非二元" };

function accept(a: Applicant) {
  moveIn(props.roomId, a);
  emit("close");
}

// 重新刊登(§7-1 招租費用):不想等明天,花小錢立刻換一批應徵者
const relistNote = ref("");
function relist() {
  const res = relistApplicants(props.roomId);
  if (!res.ok) {
    relistNote.value = `無法重新刊登:${res.reason}`;
    window.setTimeout(() => (relistNote.value = ""), 2000);
  }
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
        <button class="reno" @click="emit('upgrade', props.roomId)">🔨 改建</button>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="room-attrs">
        <span class="lbl">目前裝潢屬性:</span>
        <template v-if="attrs.length">
          <span v-for="a in attrs" :key="a.label" class="a">{{ a.label }}+{{ a.value }}</span>
        </template>
        <span v-else class="empty">尚未裝潢(先去家具商店佈置,能吸引更契合的租客)</span>
      </div>

      <div class="hint">
        契合度越高的租客,越滿意這個房間、越準時交租。每個遊戲日會換一批應徵者。
        <button class="relist" :disabled="state.money < RELIST_COST" @click="relist">🔁 重新刊登 ${{ RELIST_COST }}</button>
      </div>
      <p v-if="relistNote" class="inv-err" style="padding: 0 16px">{{ relistNote }}</p>

      <div class="list">
        <div v-for="a in applicants" :key="a.id" class="app">
          <div class="row1">
            <span class="name">{{ a.name }}</span>
            <span class="gender">{{ GENDER_LABEL[a.gender] }}</span>
            <span class="job">{{ a.occupation }}</span>
            <span v-if="petNote(a)" class="catnote" :class="{ warn: petNote(a).includes('怕') }">{{ petNote(a) }}</span>
            <span class="stars">{{ stars(a.stars) }}</span>
          </div>
          <p class="bio">{{ a.bio }}</p>
          <div class="row2">
            <span v-for="t in a.coreTags" :key="t.id" class="tag">{{ t.label }}</span>
            <span class="rent">月租 ${{ a.monthlyRent.toLocaleString() }}</span>
          </div>
          <button class="accept" @click="accept(a)">讓 {{ a.name }} 入住</button>
        </div>

        <!-- 特邀租客 -->
        <div class="invite">
          <button v-if="!showInvite" class="inv-toggle" @click="showInvite = true">✉️ 特邀租客(AI 依你的描述生成角色)</button>
          <div v-else class="inv-form">
            <div class="inv-ttl">✉️ 特邀租客</div>
            <input v-model="invName" class="inv-name" maxlength="12" placeholder="名字(例:赤井秀一)" />
            <label class="inv-gender">
              <span>性別</span>
              <select v-model="invGender" aria-label="特邀租客性別">
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="nonbinary">非二元</option>
              </select>
            </label>
            <textarea
              v-model="invDesc"
              class="inv-desc"
              maxlength="200"
              rows="3"
              placeholder="個性描述(例:沉默寡言的狙擊手,觀察力極強,愛喝黑咖啡,晝伏夜出)"
            ></textarea>
            <p class="inv-note">僅接受成年角色;你指定的性別會直接採用,AI 只生成職業/性格/作息/外觀,消毒後入住本房。</p>
            <p v-if="invError" class="inv-err">{{ invError }}</p>
            <div class="inv-actions">
              <button class="inv-cancel" :disabled="invBusy" @click="showInvite = false">取消</button>
              <button class="inv-go" :disabled="invBusy" @click="submitInvite">{{ invBusy ? "生成中…" : "邀請入住" }}</button>
            </div>
          </div>
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
.x { background: none; color: var(--text-dim); font-size: 16px; }
.reno { margin-left: auto; margin-right: 10px; background: var(--panel); border: 1px solid var(--accent); color: #ffd6a3; border-radius: 999px; padding: 3px 12px; font-size: 12px; }

.room-attrs { padding: 10px 16px 4px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.room-attrs .lbl { color: var(--text-dim); }
.room-attrs .a { color: var(--good); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.room-attrs .empty { color: var(--text-dim); }
.hint { font-size: 11.5px; color: var(--text-dim); padding: 2px 16px 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.relist { background: var(--panel); border: 1px solid var(--accent); color: #ffd6a3; border-radius: 999px; padding: 3px 10px; font-size: 11.5px; white-space: nowrap; }
.relist:disabled { opacity: 0.45; }

.list { overflow-y: auto; padding: 4px 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.app { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.row1 { display: flex; align-items: baseline; gap: 8px; }
.name { font-weight: 700; font-size: 15px; }
.job { font-size: 12px; color: var(--text-dim); }
.gender { font-size: 10.5px; color: #ddd2ff; border: 1px solid var(--line); border-radius: 999px; padding: 1px 6px; }
.catnote { font-size: 11px; color: #cdbcff; border: 1px solid var(--accent-2); border-radius: 999px; padding: 1px 7px; }
.catnote.warn { color: #ffc9a3; border-color: #c78a5a; }
.stars { margin-left: auto; color: var(--accent); font-size: 13px; letter-spacing: 1px; }
.bio { font-size: 12.5px; line-height: 1.6; color: var(--text); opacity: 0.9; margin: 6px 0; }
.row2 { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--accent-2); color: #c9befc; }
.rent { margin-left: auto; font-size: 12px; color: var(--accent); }
.accept { width: 100%; background: linear-gradient(135deg, var(--accent-2), #7059d6); color: #fff; font-weight: 700; font-size: 13.5px; border-radius: 8px; padding: 9px 0; }

.invite { margin-top: 2px; }
.inv-toggle { width: 100%; background: var(--panel); border: 1px dashed var(--accent-2); color: #cdbcff; font-size: 12.5px; border-radius: 12px; padding: 10px 0; }
.inv-form { background: var(--panel); border: 1px solid var(--accent-2); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.inv-ttl { font-weight: 700; font-size: 13.5px; color: #cdbcff; }
.inv-name, .inv-desc { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 13px; padding: 8px 10px; width: 100%; }
.inv-gender { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 12px; }
.inv-gender select { flex: 1; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 13px; padding: 7px 9px; }
.inv-desc { resize: none; line-height: 1.5; }
.inv-note { font-size: 11px; color: var(--text-dim); line-height: 1.5; }
.inv-err { font-size: 12px; color: var(--bad); }
.inv-actions { display: flex; gap: 8px; }
.inv-cancel { flex: 0.6; background: var(--panel-2); border: 1px solid var(--line); color: var(--text-dim); border-radius: 8px; padding: 8px 0; font-size: 12.5px; }
.inv-go { flex: 1; background: linear-gradient(135deg, var(--accent-2), #7059d6); color: #fff; font-weight: 700; font-size: 13px; border-radius: 8px; padding: 8px 0; }
.inv-go:disabled { opacity: 0.6; }
</style>
