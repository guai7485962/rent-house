<script setup lang="ts">
import { computed, reactive } from "vue";
import { CAFE_INGREDIENTS } from "../content/cafeIngredients";
import {
  buyCafeUpgrade,
  cafeCapability,
  CAFE_OPENING_COST,
  CAFE_UPGRADES,
  consumeStock,
  dailyDemand,
  openCafe,
  suggestedStandingOrders,
  type CafeInvestmentResult,
} from "../sim/cafe";
import { removeCafeGuest } from "../sim/cafeGuests";
import { acceptCafeGuestAdoption } from "../sim/pets";
import { save } from "../sim/persistence";
import { addMoney, permanentHousePetEntries, state } from "../store";
import type { CafeGuest } from "../types";

const emit = defineEmits<{ close: []; done: [text: string] }>();

const initialOrders = Object.keys(state.cafe.standingOrders).length
  ? state.cafe.standingOrders
  : suggestedStandingOrders();
const orderDraft = reactive<Record<string, number>>({ ...initialOrders });
const selectedPet = reactive<Record<string, string>>({});

const latest = computed(() => state.cafe.history.at(-1) ?? null);
const capability = computed(() => cafeCapability(state.cafe.upgrades));
const adoptGuests = computed(() => state.cafe.guests.filter((guest) => guest.intent === "adopt"));
const eligiblePets = computed(() => permanentHousePetEntries().map(([id, pet]) => ({ id, pet })));
const predictedDemand = computed(() => dailyDemand(latest.value?.guests ?? 0));
const predictedSupply = computed(() => consumeStock(state.cafe.stock, predictedDemand.value));
const predictedShortages = computed(() => predictedSupply.value.shortages.map((id) =>
  CAFE_INGREDIENTS.find((item) => item.id === id)?.name ?? id));
const hotItem = computed(() => {
  if (!latest.value?.guests) return "尚無資料";
  const winner = CAFE_INGREDIENTS.reduce((best, item) =>
    (predictedDemand.value[item.id] ?? 0) > (predictedDemand.value[best.id] ?? 0) ? item : best,
  CAFE_INGREDIENTS[0]);
  return winner.usedIn[0] ?? winner.name;
});

function commitInvestment(result: CafeInvestmentResult, successText: string) {
  if (!result.ok) {
    emit("done", `操作失敗:${result.reason}`);
    return;
  }
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳支出", result.category ?? "cafe");
  save();
  emit("done", successText);
}

function onOpen() {
  commitInvestment(openCafe(state.cafe, state.money), "☕ 一樓寵物咖啡廳正式開張!");
}

function onBuy(id: string, name: string) {
  commitInvestment(buyCafeUpgrade(state.cafe, state.money, id), `✅ 「${name}」投資完成!`);
}

function safeUnits(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(99, Math.max(0, Math.floor(n))) : 0;
}

function resetSuggestedOrders() {
  Object.assign(orderDraft, suggestedStandingOrders());
}

function applyStandingOrders() {
  state.cafe.standingOrders = Object.fromEntries(
    CAFE_INGREDIENTS.map((item) => [item.id, safeUnits(orderDraft[item.id])]),
  );
  Object.assign(orderDraft, state.cafe.standingOrders);
  save();
  emit("done", "📦 常備量已套用，下次日結會依這份清單補貨");
}

function removeHandledGuest(guestId: string) {
  const next = removeCafeGuest(state.cafe.guests, guestId);
  state.cafe.guests.splice(0, state.cafe.guests.length, ...next);
  save();
}

function onAcceptAdoption(guest: CafeGuest) {
  const available = eligiblePets.value;
  const petId = available.some((entry) => entry.id === selectedPet[guest.id])
    ? selectedPet[guest.id]
    : available[0]?.id;
  if (!petId) {
    emit("done", "目前沒有可由咖啡廳顧客認養的永久樓寵物");
    return;
  }
  const result = acceptCafeGuestAdoption(guest, petId);
  if (result.ok) removeHandledGuest(guest.id);
  emit("done", result.text);
}

function onDeclineAdoption(guest: CafeGuest) {
  removeHandledGuest(guest.id);
  emit("done", `已婉拒 ${guest.name} 的認養詢問，寵物仍留在樓裡`);
}

const money = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString()}`;
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel" aria-label="咖啡廳營運面板">
      <header class="head">
        <div>
          <div class="eyebrow">1F PET CAFÉ</div>
          <h2>☕ 寵物咖啡廳營運</h2>
        </div>
        <button class="close" aria-label="關閉咖啡廳面板" @click="emit('close')">✕</button>
      </header>

      <div class="body">
        <section v-if="!state.cafe.open" class="opening-card">
          <span class="opening-icon">☕</span>
          <h3>把一樓正式打開吧</h3>
          <p>完成執照、設備檢查與第一批備品。開張後才會產生客流、補貨與日結紀錄。</p>
          <div class="opening-money">
            <span>開張費</span><strong>${{ CAFE_OPENING_COST.toLocaleString() }}</strong>
          </div>
          <div class="opening-money subtle">
            <span>目前資金</span><b>${{ state.money.toLocaleString() }}</b>
          </div>
          <button class="primary" :disabled="state.money < CAFE_OPENING_COST" @click="onOpen">
            {{ state.money < CAFE_OPENING_COST ? "資金不足" : `支付 $${CAFE_OPENING_COST.toLocaleString()}，正式開張` }}
          </button>
          <p class="micro">開張後不可退費；常備量仍由你決定，不會暗自替你進貨。</p>
        </section>

        <template v-else>
          <section class="overview" aria-label="咖啡廳營運摘要">
            <div><span>最近單數</span><strong>{{ latest?.guests ?? "—" }}</strong></div>
            <div><span>人氣</span><strong>{{ Math.round(state.cafe.popularity) }}</strong></div>
            <div><span>最近淨利</span><strong :class="{ loss: (latest?.net ?? 0) < 0 }">{{ latest ? money(latest.net) : "—" }}</strong></div>
          </section>

          <section class="card status-card">
            <div class="section-head">
              <div><span class="kicker">TODAY</span><h3>營運觀察</h3></div>
              <span class="capacity">產能 {{ capability.capacity }} 單</span>
            </div>
            <div class="status-grid">
              <div><span>熱銷品</span><b>{{ hotItem }}</b></div>
              <div><span>最近營收</span><b>{{ latest ? money(latest.revenue) : "尚無資料" }}</b></div>
            </div>
            <p v-if="latest && latest.guests >= capability.capacity" class="alert warn">⚙️ 最近一次已滿載，可考慮增加設備。</p>
            <p v-if="predictedShortages.length" class="alert bad">⚠️ 依最近客流預估會缺：{{ predictedShortages.join("、") }}</p>
            <p v-else-if="latest" class="alert good">✓ 目前庫存足以應付最近一次的客流。</p>
            <p v-else class="empty">完成第一次日結後，這裡會顯示熱銷品與缺貨預估。</p>
          </section>

          <section class="card">
            <div class="section-head">
              <div><span class="kicker">STOCK</span><h3>常備量</h3></div>
              <button class="ghost" @click="resetSuggestedOrders">恢復建議</button>
            </div>
            <p class="section-note">每天日結後自動補到這個數量；先改草稿，按下套用才會保存。</p>
            <div class="order-list">
              <label v-for="item in CAFE_INGREDIENTS" :key="item.id" class="order-row">
                <span><b>{{ item.name }}</b><small>庫存 {{ state.cafe.stock[item.id] ?? 0 }} · 單價 ${{ item.unitPrice }}</small></span>
                <input v-model.number="orderDraft[item.id]" type="number" inputmode="numeric" min="0" max="99" :aria-label="`${item.name}常備量`">
              </label>
            </div>
            <button class="primary compact" @click="applyStandingOrders">套用常備量</button>
          </section>

          <section class="card">
            <div class="section-head">
              <div><span class="kicker">INVEST</span><h3>永久投資</h3></div>
              <span class="balance">${{ state.money.toLocaleString() }}</span>
            </div>
            <p class="section-note">一次性、不可退；購買後永久生效。</p>
            <div class="upgrade-list">
              <article v-for="item in CAFE_UPGRADES" :key="item.id" class="upgrade" :class="{ owned: state.cafe.upgrades.includes(item.id) }">
                <div class="upgrade-head">
                  <b>{{ item.name }}</b>
                  <span v-if="state.cafe.upgrades.includes(item.id)" class="owned-label">✓ 已完成</span>
                  <strong v-else>${{ item.price.toLocaleString() }}</strong>
                </div>
                <p>{{ item.effect }}</p>
                <button
                  v-if="!state.cafe.upgrades.includes(item.id)"
                  class="secondary"
                  :disabled="state.money < item.price"
                  @click="onBuy(item.id, item.name)"
                >
                  {{ state.money < item.price ? "金錢不足" : `投資 −$${item.price.toLocaleString()}` }}
                </button>
              </article>
            </div>
          </section>

          <section class="card adoption-card">
            <div class="section-head">
              <div><span class="kicker">ADOPTION</span><h3>認養詢問</h3></div>
              <span class="count">{{ adoptGuests.length }}</span>
            </div>
            <p v-if="!adoptGuests.length" class="empty">目前沒有顧客詢問認養。</p>
            <article v-for="guest in adoptGuests" :key="guest.id" class="adoption">
              <div class="guest-line"><span>💗</span><b>{{ guest.name }}</b><small>想認識一隻樓寵物</small></div>
              <select v-if="eligiblePets.length" v-model="selectedPet[guest.id]" :aria-label="`${guest.name}的認養對象`">
                <option value="">選擇認養對象</option>
                <option v-for="entry in eligiblePets" :key="entry.id" :value="entry.id">
                  {{ entry.pet.kind === "dog" ? "🐕" : "🐈" }} {{ entry.pet.name }}
                </option>
              </select>
              <p v-else class="alert warn">目前沒有可認養的永久樓寵物。</p>
              <div class="adoption-actions">
                <button class="decline" @click="onDeclineAdoption(guest)">婉拒</button>
                <button class="accept" :disabled="!eligiblePets.length" @click="onAcceptAdoption(guest)">接受認養</button>
              </div>
            </article>
          </section>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 138; background: rgba(8,7,12,0.74); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 88vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 18px 18px 0 0; display: flex; flex-direction: column; animation: up 0.24s ease-out; overflow: hidden; }
@keyframes up { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 11px; border-bottom: 1px solid var(--line); background: linear-gradient(135deg, rgba(207,139,91,0.16), rgba(91,126,96,0.12)); }
.head h2 { margin: 1px 0 0; font-size: 16px; }
.eyebrow, .kicker { color: #d9a778; font-size: 9px; font-weight: 800; letter-spacing: 1.7px; }
.close { margin-left: auto; background: none; color: var(--text-dim); font-size: 17px; padding: 8px; }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px calc(22px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 11px; }
.opening-card, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 13px; }
.opening-card { text-align: center; padding: 20px 16px 16px; background: linear-gradient(145deg, rgba(191,119,70,0.13), rgba(82,127,94,0.12)); }
.opening-icon { display: block; font-size: 38px; margin-bottom: 5px; }
.opening-card h3 { margin: 0 0 7px; font-size: 17px; }
.opening-card > p { color: var(--text-dim); font-size: 12px; line-height: 1.65; }
.opening-money { display: flex; justify-content: space-between; align-items: baseline; margin-top: 13px; padding: 9px 11px; border-top: 1px solid var(--line); font-size: 12px; }
.opening-money strong { color: var(--accent); font-size: 20px; }
.opening-money.subtle { margin-top: 0; padding-top: 3px; border-top: 0; color: var(--text-dim); }
.opening-money.subtle b { color: var(--text); }
.primary, .secondary, .accept, .decline, .ghost { border-radius: 9px; font-weight: 700; }
.primary { width: 100%; margin-top: 8px; padding: 10px; color: #271808; background: linear-gradient(135deg, var(--accent), #ff9440); }
.primary:disabled, .secondary:disabled, .accept:disabled { opacity: 0.45; }
.primary.compact { margin-top: 10px; padding: 9px; font-size: 13px; }
.micro { margin: 9px 0 0; font-size: 10.5px !important; }
.overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.overview div { min-width: 0; padding: 10px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; text-align: center; }
.overview span { display: block; color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.overview strong { display: block; margin-top: 3px; color: #bdf1ca; font-size: 16px; overflow: hidden; text-overflow: ellipsis; }
.overview strong.loss { color: #ff9aa8; }
.section-head { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
.section-head h3 { margin: 1px 0 0; font-size: 14.5px; }
.capacity, .balance, .count { margin-left: auto; color: var(--text-dim); font-size: 11px; white-space: nowrap; }
.count { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: rgba(220,100,130,0.18); color: #f4b0c4; font-weight: 700; }
.section-note, .empty { margin: 0 0 8px; color: var(--text-dim); font-size: 11px; line-height: 1.55; }
.status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.status-grid div { min-width: 0; padding: 8px 9px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.status-grid span { display: block; color: var(--text-dim); font-size: 10px; }
.status-grid b { display: block; margin-top: 2px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alert { margin: 8px 0 0; padding: 7px 9px; border-radius: 8px; font-size: 10.8px; line-height: 1.45; }
.alert.warn { color: #ffd98a; background: rgba(181,135,46,0.11); }
.alert.bad { color: #ffacb7; background: rgba(232,101,122,0.1); }
.alert.good { color: #b9f6ce; background: rgba(83,196,126,0.09); }
.ghost { margin-left: auto; padding: 5px 8px; color: #cdbcff; background: rgba(143,123,255,0.1); border: 1px solid rgba(143,123,255,0.4); font-size: 10.5px; }
.order-list, .upgrade-list { display: flex; flex-direction: column; gap: 7px; }
.order-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.order-row > span { min-width: 0; display: flex; flex-direction: column; }
.order-row b { font-size: 12px; }
.order-row small { color: var(--text-dim); font-size: 9.5px; }
.order-row input { margin-left: auto; width: 58px; min-width: 0; padding: 6px; border-radius: 7px; border: 1px solid var(--line); background: #17151f; color: var(--text); text-align: center; font: inherit; font-size: 12px; }
.upgrade { padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,0.02); }
.upgrade.owned { border-color: rgba(83,196,126,0.4); opacity: 0.76; }
.upgrade-head { display: flex; align-items: baseline; gap: 8px; }
.upgrade-head b { font-size: 12.5px; }
.upgrade-head strong, .owned-label { margin-left: auto; color: var(--accent); font-size: 11.5px; white-space: nowrap; }
.owned-label { color: var(--good); }
.upgrade p { margin: 5px 0 8px; color: var(--text-dim); font-size: 10.5px; line-height: 1.45; }
.secondary { width: 100%; padding: 7px; color: #ffd6a3; background: rgba(255,180,94,0.1); border: 1px solid rgba(255,180,94,0.55); font-size: 11.5px; }
.adoption { padding: 10px; border-radius: 10px; border: 1px solid rgba(220,100,130,0.35); background: rgba(220,100,130,0.06); }
.adoption + .adoption { margin-top: 8px; }
.guest-line { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
.guest-line b { font-size: 12.5px; }
.guest-line small { min-width: 0; color: var(--text-dim); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adoption select { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: #17151f; font-size: 12px; }
.adoption-actions { display: grid; grid-template-columns: 1fr 1.35fr; gap: 7px; margin-top: 8px; }
.decline, .accept { padding: 8px; font-size: 11.5px; }
.decline { color: var(--text-dim); background: transparent; border: 1px solid var(--line); }
.accept { color: #21131a; background: #e99ab4; }

@media (max-width: 390px) {
  .body { padding-left: 11px; padding-right: 11px; }
  .opening-card, .card { padding: 11px; }
  .overview span { font-size: 9.5px; }
  .overview strong { font-size: 14px; }
}
</style>
