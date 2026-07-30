<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  state,
  HOUSE_PET_OWNER,
  PERMANENT_HOUSE_PET_LIMIT,
  IN_HOUSE_FOSTER_LIMIT,
  housePetEntries,
  permanentHousePetEntries,
  fosterHousePetEntries,
  needsHousePetReview,
  petRehomingDaysLeft,
  startHousePetRehoming,
  cancelHousePetRehoming,
  resolveHousePetOverload,
  petIcon,
} from "../store";

const emit = defineEmits<{ close: []; done: [message: string] }>();
const tab = ref<"current" | "homes">("current");
const selectedKeep = ref<string[]>([]);
const armedPetId = ref<string | null>(null);

const housePets = computed(() => housePetEntries()
  .sort((a, b) => a[1].sinceMs - b[1].sinceMs || a[0].localeCompare(b[0])));
const residentPets = computed(() => Object.entries(state.pets)
  .filter(([, pet]) => pet.ownerId !== HOUSE_PET_OWNER)
  .map(([id, pet]) => ({ id, pet, owner: state.runtimes[pet.ownerId]?.tenant.name ?? "房客" })));
const permanentCount = computed(() => permanentHousePetEntries().length);
const fosterCount = computed(() => fosterHousePetEntries().length);

watch(
  () => housePets.value.filter(([, pet]) => (pet.housePlacement ?? "permanent") === "permanent").map(([id]) => id).join("|"),
  () => {
    if (!needsHousePetReview()) {
      selectedKeep.value = [];
      return;
    }
    selectedKeep.value = permanentHousePetEntries()
      .sort((a, b) => a[1].sinceMs - b[1].sinceMs || a[0].localeCompare(b[0]))
      .slice(0, PERMANENT_HOUSE_PET_LIMIT)
      .map(([id]) => id);
  },
  { immediate: true },
);

function toggleKeep(id: string) {
  if (selectedKeep.value.includes(id)) {
    selectedKeep.value = selectedKeep.value.filter((petId) => petId !== id);
  } else if (selectedKeep.value.length < PERMANENT_HOUSE_PET_LIMIT) {
    selectedKeep.value = [...selectedKeep.value, id];
  }
}

function confirmOverload() {
  const result = resolveHousePetOverload(selectedKeep.value);
  emit("done", result.text);
}

function startRehome(id: string) {
  if (armedPetId.value !== id) {
    armedPetId.value = id;
    return;
  }
  const result = startHousePetRehoming(id, "adopter");
  armedPetId.value = null;
  emit("done", result.text);
}

function cancelRehome(id: string) {
  const result = cancelHousePetRehoming(id);
  emit("done", result.text);
}

function placementLabel(pet: (typeof state.pets)[string]) {
  if (pet.housePlacement === "foster") return `公寓中途 · 剩 ${petRehomingDaysLeft(pet)} 天`;
  if (pet.housePlacement === "partner_foster") return `合作中途 · 剩 ${petRehomingDaysLeft(pet)} 天`;
  return "永久樓寵物";
}

function fmtDay(ms: number) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <div class="pet-overlay" @click.self="emit('close')">
    <div class="pet-panel">
      <header>
        <div>
          <strong>🐾 公寓寵物</strong>
          <small>永久 {{ permanentCount }}/{{ PERMANENT_HOUSE_PET_LIMIT }} · 公寓中途 {{ fosterCount }}/{{ IN_HOUSE_FOSTER_LIMIT }}</small>
        </div>
        <button class="close" @click="emit('close')">✕</button>
      </header>

      <div class="tabs">
        <button :class="{ on: tab === 'current' }" @click="tab = 'current'">現在 {{ Object.keys(state.pets).length }}</button>
        <button :class="{ on: tab === 'homes' }" @click="tab = 'homes'">幸福新家 {{ state.petHomes.length }}</button>
      </div>

      <div v-if="tab === 'current'" class="list">
        <section v-if="needsHousePetReview()" class="review">
          <strong>⚠️ 樓寵物安置會議</strong>
          <p>舊存檔的永久樓寵物超過名額。請選擇 2 隻永久留下，其餘會依序進入公寓或合作中途，不會突然消失。</p>
          <div class="keep-grid">
            <button
              v-for="[id, pet] in housePets.filter(([, candidate]) => (candidate.housePlacement ?? 'permanent') === 'permanent')"
              :key="id"
              :class="{ picked: selectedKeep.includes(id) }"
              @click="toggleKeep(id)"
            >
              {{ petIcon(pet) }} {{ pet.name }} <span>{{ selectedKeep.includes(id) ? "留下" : "送養" }}</span>
            </button>
          </div>
          <button class="confirm" :disabled="selectedKeep.length !== PERMANENT_HOUSE_PET_LIMIT" @click="confirmOverload">
            確認安置
          </button>
        </section>

        <template v-if="housePets.length">
          <h3>公寓照顧</h3>
          <article v-for="[id, pet] in housePets" :key="id" class="pet-card" :class="pet.housePlacement ?? 'permanent'">
            <div class="pet-icon">{{ petIcon(pet) }}</div>
            <div class="pet-body">
              <div class="pet-name">{{ pet.name }} <span>{{ pet.kind === "dog" ? "狗" : "貓" }}</span></div>
              <div class="pet-status">{{ placementLabel(pet) }}</div>
              <div v-if="pet.formerOwnerName" class="pet-origin">原主人：{{ pet.formerOwnerName }}</div>
            </div>
            <button
              v-if="(pet.housePlacement ?? 'permanent') === 'permanent' && !needsHousePetReview()"
              class="rehome"
              :class="{ armed: armedPetId === id }"
              @click="startRehome(id)"
            >
              {{ armedPetId === id ? "再按一次確認" : "替牠找新家" }}
            </button>
            <button
              v-else-if="pet.housePlacement === 'foster' || pet.housePlacement === 'partner_foster'"
              class="cancel"
              @click="cancelRehome(id)"
            >
              取消媒合
            </button>
          </article>
        </template>

        <template v-if="residentPets.length">
          <h3>跟房客一起住</h3>
          <article v-for="{ id, pet, owner } in residentPets" :key="id" class="pet-card resident">
            <div class="pet-icon">{{ petIcon(pet) }}</div>
            <div class="pet-body">
              <div class="pet-name">{{ pet.name }} <span>{{ pet.kind === "dog" ? "狗" : "貓" }}</span></div>
              <div class="pet-status">跟著 {{ owner }} 居住</div>
              <div class="pet-origin">房東不能替房客的寵物送養</div>
            </div>
          </article>
        </template>

        <p v-if="!housePets.length && !residentPets.length" class="empty">公寓目前沒有動物入住。</p>
      </div>

      <div v-else class="list">
        <p v-if="!state.petHomes.length" class="empty">還沒有送養紀錄。完成媒合後，牠們的新生活會留在這裡。</p>
        <article v-for="home in state.petHomes" :key="home.id" class="home-card">
          <div class="pet-icon">{{ home.kind === "dog" ? "🐕" : "🐈" }}</div>
          <div>
            <div class="pet-name">{{ home.name }} <span>相伴 {{ home.daysTogether }} 天</span></div>
            <div class="home-dest">🏡 {{ home.destination }} · {{ fmtDay(home.leftMs) }}</div>
            <p>{{ home.note }}</p>
          </div>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pet-overlay { position: fixed; inset: 0; z-index: 45; display: flex; align-items: flex-end; justify-content: center; background: rgba(8, 7, 12, 0.72); backdrop-filter: blur(2px); }
.pet-panel { width: 100%; max-width: 430px; max-height: 86vh; display: flex; flex-direction: column; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; padding: 14px 14px 20px; animation: up 0.2s ease-out; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
header strong { display: block; font-size: 16px; }
header small { display: block; margin-top: 3px; color: var(--text-dim); font-size: 11.5px; }
.close { border: 0; background: transparent; color: var(--text-dim); font-size: 18px; }
.tabs { display: flex; gap: 8px; margin: 12px 0; }
.tabs button { flex: 1; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text-dim); font-size: 13px; }
.tabs button.on { color: #fff; border-color: #d69963; background: rgba(214, 153, 99, 0.22); font-weight: 700; }
.list { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
h3 { margin: 7px 2px 1px; font-size: 12px; color: var(--text-dim); font-weight: 600; }
.review { padding: 11px; border: 1px solid #e2a45e; border-radius: 12px; background: rgba(226, 164, 94, 0.1); }
.review p { margin: 5px 0 9px; color: var(--text-dim); font-size: 12px; line-height: 1.5; }
.keep-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.keep-grid button { display: flex; justify-content: space-between; gap: 5px; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font-size: 12px; }
.keep-grid button span { color: var(--text-dim); }
.keep-grid button.picked { border-color: var(--good); background: rgba(83, 196, 126, 0.12); }
.keep-grid button.picked span { color: var(--good); }
.confirm { width: 100%; margin-top: 9px; padding: 8px; border: 0; border-radius: 8px; background: var(--good); color: #102317; font-weight: 700; }
.confirm:disabled { opacity: 0.45; }
.pet-card, .home-card { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 11px; background: var(--panel); }
.pet-card.foster { border-color: #d69963; }
.pet-card.partner_foster { border-color: #7fa9d8; opacity: 0.9; }
.pet-icon { flex: 0 0 34px; font-size: 26px; text-align: center; }
.pet-body { min-width: 0; flex: 1; }
.pet-name { font-size: 14px; font-weight: 700; }
.pet-name span { margin-left: 5px; color: var(--text-dim); font-size: 11px; font-weight: 400; }
.pet-status { margin-top: 2px; color: #e7b579; font-size: 11.5px; }
.pet-origin { margin-top: 2px; color: var(--text-dim); font-size: 10.5px; }
.rehome, .cancel { flex: 0 0 auto; padding: 7px 8px; border-radius: 8px; background: transparent; font-size: 11px; }
.rehome { border: 1px solid #d69963; color: #f0bd82; }
.rehome.armed { border-color: #ff8f70; color: #ffb39c; background: rgba(255, 143, 112, 0.1); }
.cancel { border: 1px solid var(--line); color: var(--text-dim); }
.home-card { align-items: flex-start; }
.home-dest { margin-top: 3px; color: var(--good); font-size: 11.5px; }
.home-card p { margin: 5px 0 0; color: var(--text-dim); font-size: 11.5px; line-height: 1.5; }
.empty { padding: 22px 10px; color: var(--text-dim); text-align: center; font-size: 12.5px; }
</style>
