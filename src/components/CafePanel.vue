<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { CAFE_INGREDIENTS } from "../content/cafeIngredients";
import {
  buyCafeUpgrade,
  advanceCafeResearch,
  availableCafeResearch,
  avgTicket,
  cafeAmbianceMultiplier,
  cafeCapability,
  CAFE_AMBIANCE_FULL_POINTS,
  CAFE_AMBIANCE_SWING,
  cafeIngredientMenuUse,
  cafeIngredientShortageBlame,
  cafeItemShortageCauses,
  cafeRecipeLines,
  cafeResearchDaysLeft,
  cafeSalesRanking,
  cafeStaffCount,
  CAFE_MAX_EXTRA_STAFF,
  CAFE_STAFF_WAGE,
  CAFE_RESEARCH,
  CAFE_SALES_WINDOW_DAYS,
  CAFE_OPENING_COST,
  CAFE_UPGRADES,
  consumeStock,
  dailyDemand,
  fireCafeStaff,
  getCafeResearch,
  getCafeUpgrade,
  hireCafeStaff,
  menuItems,
  openCafe,
  startCafeResearch,
  suggestedStandingOrders,
  suggestStandingOrdersFromSales,
  type CafeInvestmentResult,
} from "../sim/cafe";
import { removeCafeGuest } from "../sim/cafeGuests";
import { isVacant, ROOM_APPEARANCE } from "../sim/gameState";
import { acceptCafeGuestAdoption } from "../sim/pets";
import { save } from "../sim/persistence";
import { CAFE_PLACEMENT_REGIONS, cafeAmbiancePoints, cafeSeatSpots, getPlacements, placeCafeStarterSet } from "../sim/placements";
import { acceptCafeGuestApplicant } from "../sim/recruit";
import { addMoney, gameDayIndex, permanentHousePetEntries, state } from "../store";
import type { CafeGuest } from "../types";
import OpsTabs, { type OpsTab } from "./OpsTabs.vue";

const emit = defineEmits<{ close: []; done: [text: string]; switchTab: [tab: OpsTab] }>();

const initialOrders = Object.keys(state.cafe.standingOrders).length
  ? state.cafe.standingOrders
  : suggestedStandingOrders();
const orderDraft = reactive<Record<string, number>>({ ...initialOrders });
const selectedPet = reactive<Record<string, string>>({});
const selectedRoom = reactive<Record<string, string>>({});

const latest = computed(() => state.cafe.history.at(-1) ?? null);
/**
 * 🔴 P4b 修 bug:面板的產能一直讀「沒帶席次與員工」的 `cafeCapability()`。
 *
 * P4a 把產能改成 `min(外帶底量 + 席次 × 迴轉率, 員工數 × 每人杯數)`,不帶參數會退回
 * 「席次不設限 + 只有首位店員」的預設值 ⇒ 面板顯示的「產能 N 單」與 `tick.ts`
 * 真的用來夾客流的那個數字對不起來(雇了人也不會動)。這裡餵進與 `cafeHourlyPass()`
 * **完全相同的兩個輸入**:`cafeSeatSpots().length` 與 `state.cafe.extraStaff`。
 *
 * `placements` 是 reactive ⇒ 玩家搬椅子,這個數字立刻跟著動。
 */
const seatCount = computed(() => cafeSeatSpots().length);
const capability = computed(() => cafeCapability(state.cafe.upgrades, {
  seats: seatCount.value,
  extraStaff: state.cafe.extraStaff,
}));
// P4b 人力區塊:人數含開張費已付的首位店員,日薪只算第二位起(§4.9)。
const staffCount = computed(() => cafeStaffCount(state.cafe.extraStaff));
const extraStaffCount = computed(() => staffCount.value - 1);
const todaySales = computed(() => state.cafe.sales.find((row) => row.day === currentDay.value) ?? null);
const todayServed = computed(() => todaySales.value?.served ?? 0);
const loadPercent = computed(() => (capability.value.capacity > 0
  ? Math.min(100, Math.round((todayServed.value / capability.value.capacity) * 100))
  : 0));
/** 進度條轉紅的門檻:已經吃掉九成產能 ⇒ 畫面上的隊伍差不多也排起來了。 */
const loadFull = computed(() => loadPercent.value >= 90);
const adoptGuests = computed(() => state.cafe.guests.filter((guest) => guest.intent === "adopt"));
const rentGuests = computed(() => state.cafe.guests.filter((guest) => guest.intent === "rent"));
const eligiblePets = computed(() => permanentHousePetEntries().map(([id, pet]) => ({ id, pet })));
const vacantRooms = computed(() => Object.keys(ROOM_APPEARANCE)
  .filter((roomId) => isVacant(roomId))
  .map((roomId) => ({ id: roomId, label: `${roomId.replace(/^r/, "")} 房` })));
const predictedDemand = computed(() => dailyDemand(latest.value?.guests ?? 0));
const predictedSupply = computed(() => consumeStock(state.cafe.stock, predictedDemand.value));
const predictedShortages = computed(() => predictedSupply.value.shortages.map((id) =>
  CAFE_INGREDIENTS.find((item) => item.id === id)?.name ?? id));
const currentDay = computed(() => gameDayIndex());
// 氛圍加成的讀取面:placements 是 reactive,搬動/賣出家具後這兩個數字會立刻跟著動。
const ambiancePoints = computed(() => cafeAmbiancePoints());
const ambianceMultiplier = computed(() => cafeAmbianceMultiplier(ambiancePoints.value));
const cafeFurnitureCount = computed(() =>
  getPlacements().filter((p) => (CAFE_PLACEMENT_REGIONS as readonly string[]).includes(p.room)).length);
const activeResearch = computed(() => state.cafe.research ? getCafeResearch(state.cafe.research.id) : undefined);
const researchDaysLeft = computed(() => cafeResearchDaysLeft(state.cafe, currentDay.value));
const researchProgress = computed(() => {
  if (!state.cafe.research || researchDaysLeft.value === null) return 0;
  const duration = Math.max(1, state.cafe.research.days);
  return Math.min(100, Math.max(0, Math.round((1 - researchDaysLeft.value / duration) * 100)));
});
const completedResearch = computed(() => new Set(state.cafe.completed));
const completedResearchCount = computed(() => CAFE_RESEARCH.filter((item) => completedResearch.value.has(item.id)).length);
const availableResearchIds = computed(() => new Set(availableCafeResearch(state.cafe).map((item) => item.id)));
const remainingResearch = computed(() => CAFE_RESEARCH.filter((item) =>
  !completedResearch.value.has(item.id) && item.id !== state.cafe.research?.id));
const cafeMenu = computed(() => menuItems(state.cafe.completed));
// P3 銷售排行:過去 7 個遊戲日各品項的賣出杯數與缺貨次數(資料來自 P1 的 state.cafe.sales)。
const salesRanking = computed(() => cafeSalesRanking(state.cafe.sales, cafeMenu.value, CAFE_SALES_WINDOW_DAYS));
const salesDays = computed(() => state.cafe.sales.slice(-CAFE_SALES_WINDOW_DAYS).length);
const salesHasData = computed(() => salesRanking.value.some((row) => row.sold > 0 || row.missed > 0));
const salesTotalMissed = computed(() => salesRanking.value.reduce((sum, row) => sum + row.missed, 0));
/** 長條圖用的相對長度;沒有任何銷量時全部顯示 0 寬(不會出現 0/0 的 NaN)。 */
const salesTopSold = computed(() => salesRanking.value.reduce((best, row) => Math.max(best, row.sold), 0));
const soldBarWidth = (sold: number) => (salesTopSold.value > 0 ? Math.round((sold / salesTopSold.value) * 100) : 0);
const cafeAverageTicket = computed(() => avgTicket(state.cafe.completed));
/**
 * 熱銷品 = 過去 7 日**實際賣最多**的菜單品項。
 *
 * 2026-08-08 之前這裡是「預估消耗最大的原料 → `usedIn[0]`」,而 `usedIn` 是
 * P1 之前的手寫字串、早就與菜單對不上(它會顯示「美式咖啡」,菜單上叫
 * 「招牌美式咖啡」)。`usedIn` 已整個移除,這裡改讀真的賣出份數——
 * 面板上的每一個商品名,現在都來自菜單本身。
 */
const hotItem = computed(() => {
  const best = salesRanking.value[0];
  if (!best || best.sold <= 0) return "尚無資料";
  return best.name;
});

// ---------------------------------------------------------------------------
// 🔴 缺貨 → 原料的歸因(使用者 2026-08-08:「不知道那個商品缺貨我要多進的是什麼原料」)
//
// 兩張表本來各說各話:銷售排行只講「品項缺貨 N 次」,常備量只講「原料庫存幾單位」。
// 下面三個 computed 就是那條缺掉的橋,而且**兩邊講的是同一份資料**:
//   1. `itemShortage()`  品項 → 當時真的缺的原料 + 要補多少(讀實際 `missedBy` 紀錄)
//   2. `itemRecipe()`    品項 → 配方(沒缺過時的說明,也是舊存檔的退路)
//   3. `ingredientUse()` / `blame` 原料 → 餵哪些品項 + 最近害幾單做不出來
// ---------------------------------------------------------------------------

/** 過去 7 日各原料害了幾單做不出來(來自逐位結帳當下記的 `missing`)。 */
const shortageBlame = computed(() => cafeIngredientShortageBlame(state.cafe.sales, CAFE_SALES_WINDOW_DAYS));
/** 某品項缺貨的實際原因(缺哪個原料、那些單子共需幾單位)。 */
const itemShortage = (itemId: string) =>
  cafeItemShortageCauses(state.cafe.sales, itemId, cafeMenu.value, CAFE_SALES_WINDOW_DAYS);
/** 某品項的配方明細(唯一事實來源是 `recipe`)。 */
const itemRecipe = (itemId: string) =>
  cafeRecipeLines(cafeMenu.value.find((item) => item.id === itemId));
/** 某原料餵得到的菜單品項(取代已移除的 `usedIn`)。 */
const ingredientUse = (ingredientId: string) => cafeIngredientMenuUse(ingredientId, cafeMenu.value);
/** 全店層級:過去 7 日最該補的原料(害最多單的那些),給排行卡的總結用。 */
const topBlamed = computed(() => CAFE_INGREDIENTS
  .map((item) => ({ id: item.id, name: item.name, times: shortageBlame.value[item.id] ?? 0 }))
  .filter((row) => row.times > 0)
  .sort((a, b) => b.times - a.times));

const trackLabel = { coffee: "咖啡", bakery: "烘焙", pet: "寵物餐" } as const;
const audienceLabel: Record<string, string> = {
  daily: "日常客",
  single_origin: "單品愛好者",
  photo: "拍照客",
  cold_drink: "冰飲客",
  sweet: "甜食客",
  afternoon_tea: "下午茶客",
  family: "親子／打卡客",
  pet_family: "寵物家庭",
  pet_companion: "毛孩同行客",
  celebration: "慶生客",
};

/**
 * `afterCommit` 在扣款之後、`save()` 之前跑,回傳要接在成功訊息後面的補述。
 * 開張贈品要走這條路(擺放會動 `placements`,必須一起進存檔)。
 */
function commitInvestment(result: CafeInvestmentResult, successText: string, afterCommit?: () => string) {
  if (!result.ok) {
    emit("done", `操作失敗:${result.reason}`);
    return;
  }
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳支出", result.category ?? "cafe");
  const extra = afterCommit?.() ?? "";
  save();
  emit("done", successText + extra);
}

/**
 * 開張。開張費 $12,000 的文案本來就含「第一批備品」,所以基本家具是**免費贈送**
 * (`placeCafeStarterSet()` 完全不碰金流)。
 *
 * 只擺一次:`openCafe()` 已開張時直接 reject ⇒ `afterCommit` 不會跑第二次。
 * 存檔往返只還原 `placements` 陣列、不重跑本函式;玩家事後搬走或賣掉也不會被塞回來。
 */
function onOpen() {
  commitInvestment(openCafe(state.cafe, state.money), "☕ 一樓寵物咖啡廳正式開張!", () => {
    const placed = placeCafeStarterSet();
    return placed.length > 0 ? `已免費擺上 ${placed.length} 件基本家具,可自由搬動或賣出` : "";
  });
}

function onBuy(id: string, name: string) {
  commitInvestment(buyCafeUpgrade(state.cafe, state.money, id), `✅ 「${name}」投資完成!`);
}

/**
 * 雇用/資遣。**不扣任何一次性費用**——薪資是 `tick.ts` 日結時扣的固定成本
 * (`hireCafeStaff()` 的註解說明了為什麼不共用投資那條路)。這裡只寫回 state 並存檔,
 * 吧台後的人數下一幀就跟著變(`FloorMap` 讀同一個 `cafeStaffCount()`)。
 */
function onHire() {
  const result = hireCafeStaff(state.cafe);
  if (!result.ok) { emit("done", `無法雇用:${result.reason}`); return; }
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `👤 已雇用第 ${result.extraStaff + 1} 位店員,日薪合計 −$${result.dailyWage.toLocaleString()}`);
}

function onFire() {
  const result = fireCafeStaff(state.cafe);
  if (!result.ok) { emit("done", `無法資遣:${result.reason}`); return; }
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `已資遣一位店員,現在吧台後有 ${result.extraStaff + 1} 人,日薪合計 −$${result.dailyWage.toLocaleString()}`);
}

function onStartResearch(id: string) {
  const result = startCafeResearch(state.cafe, state.money, id, currentDay.value);
  if (!result.ok) {
    emit("done", `無法開始研發：${result.reason}`);
    return;
  }
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳研發", result.category ?? "cafe");
  save();
  emit("done", `🧪 「${result.research?.name ?? id}」開始研發，${result.research?.days ?? 0} 天後完成`);
}

function researchRequirement(item: (typeof CAFE_RESEARCH)[number]) {
  const missingResearch = item.requiresResearch
    .filter((id) => !completedResearch.value.has(id))
    .map((id) => getCafeResearch(id)?.name ?? id);
  const missingUpgrades = item.requiresUpgrades
    .filter((id) => !state.cafe.upgrades.includes(id))
    .map((id) => getCafeUpgrade(id)?.name ?? id);
  return [...missingResearch, ...missingUpgrades].join("＋");
}

function researchButtonText(item: (typeof CAFE_RESEARCH)[number]) {
  if (state.cafe.research) return "已有研發進行中";
  const missing = researchRequirement(item);
  if (missing) return `需先完成 ${missing}`;
  if (state.money < item.cost) return "資金不足";
  return `投入 $${item.cost.toLocaleString()} · ${item.days} 天`;
}

watch(currentDay, (day) => {
  const result = advanceCafeResearch(state.cafe, day);
  if (!result.changed) return;
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `🎉 「${result.completed?.name ?? "咖啡廳研發"}」完成，新品已加入菜單`);
}, { immediate: true });

/**
 * 常備量的輸入夾值。
 *
 * 🔴 2026-08-08 修 bug:上限原本是 **99**,但內建建議值裡咖啡豆就是 **130**,
 * 「依上週銷量建議」在成長期之後更會算到 140+。玩家一按「套用常備量」,
 * 咖啡豆就被無聲砍到 99 ⇒ 每天固定撲空、面板卻只寫「招牌美式咖啡 缺貨 N」,
 * 正是使用者回報的「原料和商品對不起來、賺不太到錢」。
 *
 * 實測(招牌 Lv4 + 4 位額外店員、每天照建議值套用、56 天平均):
 * 上限 99 ⇒ 撲空 4.4/日、營收 $1,796;上限 999 ⇒ 撲空 0.5/日、營收 $1,929。
 *
 * 999 不是平衡旋鈕而是防呆:名店期尖峰需求約 240 單位,999 遠高於它,
 * 又擋得住手滑連按把數字灌成天文數字(進貨錢是當場真的扣的)。
 */
const MAX_STANDING_ORDER = 999;
function safeUnits(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_STANDING_ORDER, Math.max(0, Math.floor(n))) : 0;
}

function resetSuggestedOrders() {
  Object.assign(orderDraft, suggestedStandingOrders());
}

/**
 * 拍板 Q3 的懶人路線:一鍵把常備量草稿設成「過去 7 個遊戲日的實際消耗」。
 *
 * 算式與 fallback 全部在 `suggestStandingOrdersFromSales()`(純函式、有測試);
 * 這裡只負責寫進草稿並告訴玩家依據了幾天資料——**還是要按「套用常備量」才生效**,
 * 與既有的「恢復建議」按鈕行為一致,不會偷偷改玩家的設定。
 */
function suggestOrdersFromSales() {
  const result = suggestStandingOrdersFromSales(state.cafe.sales, cafeMenu.value, CAFE_SALES_WINDOW_DAYS);
  Object.assign(orderDraft, result.orders);
  emit("done", result.fallback
    ? "📈 還沒有銷售紀錄，先帶入內建建議值；營業幾天後再按一次會更準"
    : `📈 已依過去 ${result.days} 個遊戲日的尖峰銷量填好草稿，確認後按「套用常備量」`);
}

function applyStandingOrders() {
  state.cafe.standingOrders = Object.fromEntries(
    CAFE_INGREDIENTS.map((item) => [item.id, safeUnits(orderDraft[item.id])]),
  );
  Object.assign(orderDraft, state.cafe.standingOrders);
  save();
  emit("done", "📦 常備量已套用，明天開店前（09:00）會依這份清單進貨");
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

/** 空的 v-model 會讓 <select> 顯示空白列，所以顯示值一律回退到第一間空房，跟接受時的回退一致。 */
function onSelectRoom(guestId: string, event: Event) {
  selectedRoom[guestId] = (event.target as HTMLSelectElement).value;
}

function onAcceptRentInquiry(guest: CafeGuest) {
  const available = vacantRooms.value;
  const roomId = available.some((room) => room.id === selectedRoom[guest.id])
    ? selectedRoom[guest.id]
    : available[0]?.id;
  if (!roomId) {
    emit("done", "目前沒有空房可以帶咖啡廳顧客看");
    return;
  }
  const result = acceptCafeGuestApplicant(guest, roomId);
  if (result.ok) removeHandledGuest(guest.id);
  emit("done", result.text);
}

function onDeclineRentInquiry(guest: CafeGuest) {
  removeHandledGuest(guest.id);
  emit("done", `已婉拒 ${guest.name} 的租屋詢問，空房繼續照原本的招租流程走`);
}

const money = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString()}`;
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel" aria-label="咖啡廳營運面板">
      <OpsTabs active="cafe" @select="emit('switchTab', $event)" @close="emit('close')" />

      <div class="body">
        <section v-if="!state.cafe.open" class="opening-card">
          <span class="opening-icon">☕</span>
          <h3>把一樓正式打開吧</h3>
          <p>完成執照、設備檢查與第一批備品，<b>並免費附贈整套店面家具</b>(吧台 ×1、小圓桌 ×3、
            椅子 ×6)。開張後才會產生客流、補貨與日結紀錄;家具的舒適與風格還會轉成<b>氛圍加成</b>,
            讓客流變多。</p>
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
              <div><span>一樓家具</span><b>{{ cafeFurnitureCount }} 件</b></div>
              <div><span>氛圍加成</span><b>客流 ×{{ ambianceMultiplier.toFixed(2) }}</b></div>
            </div>
            <p class="alert" :class="ambiancePoints > 0 ? 'good' : 'warn'">
              🪑 氛圍 {{ ambiancePoints }} / {{ CAFE_AMBIANCE_FULL_POINTS }} 點（一樓家具的舒適＋風格總和，滿點客流 +{{ Math.round(CAFE_AMBIANCE_SWING * 100) }}%）。
            </p>
            <p v-if="latest && latest.guests >= capability.capacity" class="alert warn">⚙️ 最近一次已滿載，可考慮增加設備。</p>
            <p v-if="predictedShortages.length" class="alert bad">⚠️ 依最近客流預估會缺：{{ predictedShortages.join("、") }}</p>
            <p v-else-if="latest" class="alert good">✓ 目前庫存足以應付最近一次的客流。</p>
            <p v-else class="empty">完成第一次日結後，這裡會顯示熱銷品與缺貨預估。</p>
          </section>

          <section class="card research-card" aria-label="咖啡廳研發">
            <div class="section-head">
              <div><span class="kicker">RESEARCH</span><h3>新品研發</h3></div>
              <span class="research-count">{{ completedResearchCount }} / {{ CAFE_RESEARCH.length }}</span>
            </div>
            <p class="section-note">同時只能進行一項；倒數以遊戲日計算，完成後新品會直接加入菜單。</p>

            <article v-if="state.cafe.research" class="active-research">
              <div class="active-research-head">
                <div>
                  <span>研發進行中</span>
                  <b>{{ activeResearch?.name ?? state.cafe.research.id }}</b>
                </div>
                <strong>{{ researchDaysLeft ?? 0 }} 天</strong>
              </div>
              <p>{{ activeResearch?.effect ?? "這項研發資料等待後續版本修復。" }}</p>
              <div class="progress" role="progressbar" :aria-valuenow="researchProgress" aria-valuemin="0" aria-valuemax="100">
                <i :style="{ width: `${researchProgress}%` }"></i>
              </div>
              <small>已投入 ${{ state.cafe.research.invested.toLocaleString() }} · 進度 {{ researchProgress }}%</small>
            </article>

            <p v-if="!remainingResearch.length && !state.cafe.research" class="research-complete">🏆 前兩層研發已全部完成</p>
            <div v-else-if="!state.cafe.research" class="research-list">
              <article v-for="item in remainingResearch" :key="item.id" class="research-item" :class="{ locked: !availableResearchIds.has(item.id) }">
                <div class="research-item-head">
                  <b>{{ item.name }}</b>
                  <span>{{ trackLabel[item.track] }} · 第 {{ item.level }} 層</span>
                </div>
                <p>{{ item.effect }}</p>
                <small>完成後：{{ item.menuItem }} ${{ item.menuPrice }} · {{ audienceLabel[item.audience] }}</small>
                <button
                  class="secondary research-action"
                  :disabled="!availableResearchIds.has(item.id) || state.money < item.cost"
                  @click="onStartResearch(item.id)"
                >
                  {{ researchButtonText(item) }}
                </button>
              </article>
            </div>
            <p v-else class="research-paused">其餘研發已暫停選擇；目前項目完成後會重新開放。</p>
          </section>

          <section class="card menu-card" aria-label="咖啡廳菜單">
            <div class="section-head">
              <div><span class="kicker">MENU</span><h3>目前菜單</h3></div>
              <span class="ticket">平均客單 ${{ cafeAverageTicket }}</span>
            </div>
            <div class="menu-list">
              <div v-for="item in cafeMenu" :key="item.id" class="menu-item">
                <span><b>{{ item.name }}</b><small>{{ audienceLabel[item.audience] }}</small></span>
                <strong>${{ item.price }}</strong>
              </div>
            </div>
            <p class="menu-note">完成 2／5 項第二層研發時，平均客單會提升到 $37／$38。</p>
          </section>

          <section class="card sales-card" aria-label="咖啡廳銷售排行">
            <div class="section-head">
              <div><span class="kicker">SALES</span><h3>銷售排行</h3></div>
              <span class="window">過去 {{ salesDays }} 日</span>
            </div>
            <p v-if="!salesHasData" class="empty">還沒有銷售紀錄；營業一天之後這裡會列出每個品項賣了幾杯、又有幾次做不出來。</p>
            <template v-else>
              <p class="section-note">依賣出杯數排序。<b class="miss-word">缺貨次數</b>是有人想買、你卻做不出來的次數——那是正在流掉的錢。每一列都寫著它吃哪些原料。</p>
              <ol class="rank-list">
                <li v-for="(row, i) in salesRanking" :key="row.id" class="rank-row" :class="{ quiet: row.sold === 0 }">
                  <div class="rank-main">
                    <span class="rank-no">{{ i + 1 }}</span>
                    <div class="rank-body">
                      <div class="rank-line">
                        <b>{{ row.name }}</b>
                        <span class="rank-sold">{{ row.sold }} 杯</span>
                      </div>
                      <div class="rank-bar"><i :style="{ width: `${soldBarWidth(row.sold)}%` }"></i></div>
                    </div>
                    <span v-if="row.missed > 0" class="rank-miss">缺貨 {{ row.missed }}</span>
                    <span v-else class="rank-ok">—</span>
                  </div>
                  <!-- 🔴 缺貨 → 原料:讀的是結帳當下真的不夠的那項原料,不是拿配方猜的 -->
                  <p v-if="row.missed > 0 && itemShortage(row.id).length" class="rank-fix">
                    <span class="fix-tag">要補</span>
                    <span v-for="cause in itemShortage(row.id)" :key="cause.id" class="fix-item">
                      <b>{{ cause.name }}</b>
                      <small v-if="cause.units > 0">每份 ×{{ cause.units }}，這 {{ cause.times }} 單共差 {{ cause.unitsShort }} 單位</small>
                      <small v-else>害了 {{ cause.times }} 單</small>
                    </span>
                  </p>
                  <p v-else class="rank-recipe">
                    <span class="recipe-tag">配方</span>
                    <span v-if="itemRecipe(row.id).length">
                      <span v-for="line in itemRecipe(row.id)" :key="line.id" class="recipe-item">{{ line.name }} ×{{ line.units }}</span>
                    </span>
                    <span v-else class="recipe-empty">尚未登記</span>
                  </p>
                </li>
              </ol>
              <p v-if="salesTotalMissed > 0" class="alert warn miss-total">
                過去 {{ salesDays }} 日共 {{ salesTotalMissed }} 位客人空手離開。
                <template v-if="topBlamed.length">
                  <br>最該補的是<b class="blame-name" v-for="(row, i) in topBlamed" :key="row.id">{{ i > 0 ? "、" : "" }}{{ row.name }}（{{ row.times }} 單）</b>——到下面的「常備量」把它調高。
                </template>
                <template v-else><br>照上面每一列的配方，把對應的原料常備量調高。</template>
              </p>
              <p v-else class="miss-none">過去 {{ salesDays }} 日沒有任何一位客人撲空，備料節奏抓得剛好。</p>
            </template>
          </section>

          <section class="card">
            <div class="section-head">
              <div><span class="kicker">STOCK</span><h3>常備量</h3></div>
              <div class="order-tools">
                <button class="ghost" @click="resetSuggestedOrders">恢復建議</button>
                <button class="ghost suggest" @click="suggestOrdersFromSales">依上週銷量建議</button>
              </div>
            </div>
            <p class="section-note">每天<b>開店前（09:00）</b>自動補到這個數量、當場扣款；先改草稿，按下套用才會保存。
              每一列都寫著這個原料<b>餵哪些商品</b>，以及它最近<b class="miss-word">害幾單做不出來</b>。</p>
            <div class="order-list">
              <label v-for="item in CAFE_INGREDIENTS" :key="item.id" class="order-row" :class="{ blamed: (shortageBlame[item.id] ?? 0) > 0 }">
                <span>
                  <b>{{ item.name }}</b>
                  <small>庫存 {{ state.cafe.stock[item.id] ?? 0 }} · 單價 ${{ item.unitPrice }}</small>
                  <!-- 🔴 原料 → 品項:從 recipe 推導,不再讀已移除的 usedIn 字串 -->
                  <small class="order-use">
                    <template v-if="ingredientUse(item.id).length">
                      用於 <em v-for="(use, i) in ingredientUse(item.id)" :key="use.id">{{ i > 0 ? "、" : "" }}{{ use.name }} ×{{ use.units }}</em>
                    </template>
                    <template v-else>目前菜單沒有商品用到它</template>
                  </small>
                  <small v-if="(shortageBlame[item.id] ?? 0) > 0" class="order-blame">
                    ⚠️ 過去 {{ salesDays }} 日害 {{ shortageBlame[item.id] }} 單做不出來
                  </small>
                </span>
                <input v-model.number="orderDraft[item.id]" type="number" inputmode="numeric" min="0" :max="MAX_STANDING_ORDER" :aria-label="`${item.name}常備量`">
              </label>
            </div>
            <button class="primary compact" @click="applyStandingOrders">套用常備量</button>
          </section>

          <section class="card staff-card" aria-label="咖啡廳人力">
            <div class="section-head">
              <div><span class="kicker">STAFF</span><h3>人力</h3></div>
              <span class="staff-wage">日薪合計 −${{ capability.dailyWage.toLocaleString() }}</span>
            </div>
            <div class="staff-line">
              <span class="staff-faces" aria-hidden="true">{{ "👤".repeat(Math.min(6, staffCount)) }}<b v-if="staffCount > 6">×{{ staffCount }}</b></span>
              <span class="staff-count">目前 {{ staffCount }} 人<small>（首位店員的薪水已含在每日固定開銷裡）</small></span>
            </div>
            <div class="staff-load">
              <div class="staff-load-line">
                <span>今日負荷</span>
                <b :class="{ full: loadFull }">已處理 {{ todayServed }} / 產能 {{ capability.capacity }} 杯</b>
              </div>
              <div class="progress load" :class="{ full: loadFull }" role="progressbar" :aria-valuenow="loadPercent" aria-valuemin="0" aria-valuemax="100">
                <i :style="{ width: `${loadPercent}%` }"></i>
              </div>
              <small>產能 = min(席次 {{ seatCount }} 張換算的內用量, {{ staffCount }} 人 × {{ capability.cupsPerStaff }} 杯)</small>
            </div>
            <p class="alert" :class="loadFull ? 'warn' : 'good'">
              {{ loadFull
                ? "🧍 今天已經做到產能上限——想再多賣就得補人或加席次,否則吧台前只會越排越長。"
                : "產能還有餘裕。真正該雇人的訊號在畫面上：吧台前排起隊、店員忙個不停。" }}
            </p>
            <div class="staff-actions">
              <button class="secondary" :disabled="extraStaffCount >= CAFE_MAX_EXTRA_STAFF" @click="onHire">
                {{ extraStaffCount >= CAFE_MAX_EXTRA_STAFF ? "已達人力上限" : `雇用（−$${CAFE_STAFF_WAGE}/日）` }}
              </button>
              <button class="ghost fire" :disabled="extraStaffCount <= 0" @click="onFire">
                {{ extraStaffCount <= 0 ? "只剩首位店員" : "資遣" }}
              </button>
            </div>
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

          <section class="card rent-card">
            <div class="section-head">
              <div><span class="kicker">RENT</span><h3>租屋詢問</h3></div>
              <span class="count rent-count">{{ rentGuests.length }}</span>
            </div>
            <p v-if="!rentGuests.length" class="empty">目前沒有顧客詢問租屋。</p>
            <article v-for="guest in rentGuests" :key="guest.id" class="rent-inquiry">
              <div class="guest-line"><span>🔑</span><b>{{ guest.name }}</b><small>在打聽樓上有沒有空房</small></div>
              <select
                v-if="vacantRooms.length"
                :value="selectedRoom[guest.id] || vacantRooms[0].id"
                :aria-label="`${guest.name}的帶看房間`"
                @change="onSelectRoom(guest.id, $event)"
              >
                <option v-for="room in vacantRooms" :key="room.id" :value="room.id">🚪 帶看 {{ room.label }}</option>
              </select>
              <p v-else class="alert warn">目前沒有空房可以帶看。</p>
              <div class="adoption-actions">
                <button class="decline" @click="onDeclineRentInquiry(guest)">婉拒</button>
                <button class="accept rent-accept" :disabled="!vacantRooms.length" @click="onAcceptRentInquiry(guest)">安排看房</button>
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
/* 2026-08-09:標題列換成與收支面板共用的 `OpsTabs`(兩者現在是同一顆入口的兩個分頁)。 */
.kicker { color: #d9a778; font-size: 9px; font-weight: 800; letter-spacing: 1.7px; }
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
.capacity, .balance, .count, .research-count, .ticket { margin-left: auto; color: var(--text-dim); font-size: 11px; white-space: nowrap; }
.count { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: rgba(220,100,130,0.18); color: #f4b0c4; font-weight: 700; }
.research-count { color: #b9f6ce; font-weight: 700; }
.ticket { color: #ffd39a; font-weight: 700; }
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
.order-tools { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.order-tools .ghost { margin-left: 0; }
.ghost.suggest { color: #ffd6a3; background: rgba(255,180,94,0.12); border-color: rgba(255,180,94,0.55); font-weight: 700; }

/* P3 銷售排行 —— 缺貨次數要比賣出杯數更搶眼:那是玩家在虧錢的訊號 */
.window { color: var(--text-dim); font-size: 10.5px; }
.miss-word { color: #ff9fae; }
.rank-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rank-row { padding: 7px 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.rank-main { display: flex; align-items: center; gap: 8px; }
/* 🔴 缺貨 → 原料:整列裡最該被看到的一行,所以給它邊框與紅底 */
.rank-fix { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 7px; margin: 6px 0 0; padding: 5px 7px; border-radius: 7px; border: 1px solid rgba(232,101,122,0.4); background: rgba(232,101,122,0.1); font-size: 10px; line-height: 1.4; }
.fix-tag { flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(232,101,122,0.3); color: #ffd7dd; font-size: 9px; font-weight: 800; }
.fix-item b { color: #ffacb7; font-size: 11px; }
.fix-item small { margin-left: 4px; color: var(--text-dim); font-size: 9.5px; }
.rank-recipe { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; margin: 5px 0 0; color: var(--text-dim); font-size: 9.5px; line-height: 1.4; }
.recipe-tag { flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,0.06); color: #c7bdaf; font-size: 9px; font-weight: 700; }
.recipe-item + .recipe-item::before { content: "・"; }
.recipe-empty { font-style: italic; }
.blame-name { color: #ffd7a8; }
.rank-row.quiet { opacity: 0.5; }
.rank-no { flex: none; display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: rgba(255,180,94,0.16); color: #ffd39a; font-size: 9.5px; font-weight: 800; }
.rank-body { flex: 1; min-width: 0; }
.rank-line { display: flex; align-items: baseline; gap: 8px; }
.rank-line b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.rank-sold { margin-left: auto; color: #ffd39a; font-size: 10.5px; font-weight: 700; white-space: nowrap; }
.rank-bar { margin-top: 4px; height: 4px; border-radius: 3px; background: rgba(255,255,255,0.06); overflow: hidden; }
.rank-bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #cf8b5b, #e8b271); }
.rank-miss { flex: none; padding: 3px 7px; border-radius: 999px; background: rgba(232,101,122,0.18); border: 1px solid rgba(232,101,122,0.5); color: #ffacb7; font-size: 10px; font-weight: 800; white-space: nowrap; }
.rank-ok { flex: none; width: 34px; text-align: center; color: var(--text-dim); font-size: 10px; }
.miss-total { font-weight: 700; }
.miss-none { margin: 8px 0 0; color: var(--good); font-size: 10.8px; line-height: 1.45; }
.order-list, .upgrade-list { display: flex; flex-direction: column; gap: 7px; }
.order-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.order-row > span { min-width: 0; display: flex; flex-direction: column; }
.order-row b { font-size: 12px; }
.order-row small { color: var(--text-dim); font-size: 9.5px; }
/* 🔴 原料 → 品項(從 recipe 推導)與「最近害幾單做不出來」 */
.order-row.blamed { border: 1px solid rgba(232,101,122,0.42); background: rgba(232,101,122,0.07); }
.order-use { margin-top: 2px; line-height: 1.4; }
.order-use em { font-style: normal; color: #d9c7a8; }
.order-blame { margin-top: 3px; color: #ffacb7 !important; font-weight: 700; line-height: 1.4; }
.order-row input { margin-left: auto; width: 58px; min-width: 0; padding: 6px; border-radius: 7px; border: 1px solid var(--line); background: #17151f; color: var(--text); text-align: center; font: inherit; font-size: 12px; }
.upgrade { padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,0.02); }
.upgrade.owned { border-color: rgba(83,196,126,0.4); opacity: 0.76; }
.upgrade-head { display: flex; align-items: baseline; gap: 8px; }
.upgrade-head b { font-size: 12.5px; }
.upgrade-head strong, .owned-label { margin-left: auto; color: var(--accent); font-size: 11.5px; white-space: nowrap; }
.owned-label { color: var(--good); }
.upgrade p { margin: 5px 0 8px; color: var(--text-dim); font-size: 10.5px; line-height: 1.45; }
.secondary { width: 100%; padding: 7px; color: #ffd6a3; background: rgba(255,180,94,0.1); border: 1px solid rgba(255,180,94,0.55); font-size: 11.5px; }
.active-research { padding: 11px; border: 1px solid rgba(113,207,145,0.38); border-radius: 11px; background: linear-gradient(135deg, rgba(71,149,100,0.11), rgba(255,180,94,0.06)); }
.active-research-head { display: flex; align-items: center; gap: 10px; }
.active-research-head div { min-width: 0; }
.active-research-head span { display: block; color: #a9e8bd; font-size: 9.5px; font-weight: 700; }
.active-research-head b { display: block; margin-top: 2px; font-size: 13.5px; }
.active-research-head strong { margin-left: auto; color: #ffd39a; font-size: 18px; white-space: nowrap; }
.active-research p { margin: 8px 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.5; }
.active-research small { display: block; margin-top: 6px; color: var(--text-dim); font-size: 9.5px; }
.progress { height: 6px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,0.08); }
.progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #76d39a, #ffc477); transition: width 0.25s ease; }
/* P4b 人力區塊(§4.9):人數、今日負荷進度條、雇用/資遣 */
.staff-card .staff-wage { color: #ffb1a4; font-size: 10.5px; white-space: nowrap; }
.staff-line { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.staff-faces { font-size: 15px; line-height: 1; letter-spacing: -1px; }
.staff-faces b { margin-left: 3px; font-size: 11px; color: #ffd39a; }
.staff-count { color: var(--text); font-size: 11.5px; }
.staff-count small { display: block; color: var(--text-dim); font-size: 9.5px; }
.staff-load-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 10.5px; color: var(--text-dim); }
.staff-load-line b { color: #ffe0b4; font-size: 12px; }
.staff-load-line b.full { color: #ff9f9f; }
.progress.load i { background: linear-gradient(90deg, #76d39a, #ffc477); }
.progress.load.full i { background: linear-gradient(90deg, #ff9f6b, #ff6b6b); }
.staff-load small { display: block; margin-top: 5px; color: var(--text-dim); font-size: 9.5px; }
.staff-actions { display: grid; grid-template-columns: 1.6fr 1fr; gap: 7px; margin-top: 9px; }
.staff-actions .fire { color: #ffb1a4; border-color: rgba(255,140,140,0.4); }
.research-list { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; }
.research-item { padding: 10px; border: 1px solid rgba(255,180,94,0.24); border-radius: 10px; background: rgba(255,180,94,0.035); }
.research-item.locked { border-color: var(--line); background: rgba(255,255,255,0.015); }
.research-item-head { display: flex; align-items: baseline; gap: 7px; }
.research-item-head b { font-size: 12.5px; }
.research-item-head span { margin-left: auto; color: #d9a778; font-size: 9.5px; white-space: nowrap; }
.research-item p { margin: 5px 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.45; }
.research-item > small { color: #c7bdaf; font-size: 9.5px; }
.research-action { margin-top: 8px; }
.research-complete { margin: 3px 0 0; padding: 11px; border-radius: 9px; color: #b9f6ce; background: rgba(83,196,126,0.08); text-align: center; font-size: 11.5px; }
.research-paused { margin: 8px 0 0; color: var(--text-dim); font-size: 10px; text-align: center; }
.menu-list { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.menu-item { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.menu-item > span { min-width: 0; }
.menu-item b, .menu-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item b { font-size: 10.8px; }
.menu-item small { margin-top: 2px; color: var(--text-dim); font-size: 8.8px; }
.menu-item strong { margin-left: auto; color: #ffd39a; font-size: 11px; }
.menu-note { margin: 8px 0 0; color: var(--text-dim); font-size: 9.5px; line-height: 1.45; }
.adoption { padding: 10px; border-radius: 10px; border: 1px solid rgba(220,100,130,0.35); background: rgba(220,100,130,0.06); }
.adoption + .adoption { margin-top: 8px; }
.guest-line { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
.guest-line b { font-size: 12.5px; }
.guest-line small { min-width: 0; color: var(--text-dim); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adoption select, .rent-inquiry select { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: #17151f; font-size: 12px; }
.adoption-actions { display: grid; grid-template-columns: 1fr 1.35fr; gap: 7px; margin-top: 8px; }
.decline, .accept { padding: 8px; font-size: 11.5px; }
.decline { color: var(--text-dim); background: transparent; border: 1px solid var(--line); }
.accept { color: #21131a; background: #e99ab4; }
.rent-inquiry { padding: 10px; border-radius: 10px; border: 1px solid rgba(143,123,255,0.35); background: rgba(143,123,255,0.06); }
.rent-inquiry + .rent-inquiry { margin-top: 8px; }
.rent-count { background: rgba(143,123,255,0.18); color: #cdbcff; }
.accept.rent-accept { color: #17132c; background: #b5a8f4; }

@media (max-width: 390px) {
  .body { padding-left: 11px; padding-right: 11px; }
  .opening-card, .card { padding: 11px; }
  .overview span { font-size: 9.5px; }
  .overview strong { font-size: 14px; }
}
</style>
