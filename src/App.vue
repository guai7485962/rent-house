<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import FloorMap from "./components/FloorMap.vue";
import PixelDollhouse from "./components/PixelDollhouse.vue";
import LogFeed from "./components/LogFeed.vue";
import DecisionModal from "./components/DecisionModal.vue";
import FurnitureShop from "./components/FurnitureShop.vue";
import RecruitPanel from "./components/RecruitPanel.vue";
import FurnitureInfo from "./components/FurnitureInfo.vue";
import type { RoomInfo } from "./floor/map";
import { roomAttributes } from "./sim/placements";
import { getDef } from "./furniture/catalog";
import {
  state,
  activeRuntime,
  hasAnyPending,
  clockLabel,
  unreadCount,
  markSeen,
  fastForward,
  decide,
  initGame,
  stopGame,
  resume,
  placeAt,
  cancelPlacing,
  sellFurnitureAt,
} from "./store";

type View = "floor" | "room";
const view = ref<View>("floor");
const showSummary = ref(false);
const showShop = ref(false);
const recruitRoom = ref<string | null>(null);
const inspectItem = ref<{ c: number; r: number; defId: string } | null>(null);
const vacantNote = ref("");
const sinceMs = ref(0);

const rt = activeRuntime;

const pendingRooms = computed(() =>
  Object.entries(state.occupancy)
    .filter(([, tid]) => state.runtimes[tid]?.pendingEvent)
    .map(([roomId]) => roomId),
);

const unreadRooms = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const [roomId, tid] of Object.entries(state.occupancy)) out[roomId] = unreadCount(tid);
  return out;
});

initGame();
onMounted(() => {
  // 分頁重新可見時補進度(掛機回來)
  document.addEventListener("visibilitychange", onVisible);
});
onUnmounted(() => {
  stopGame();
  document.removeEventListener("visibilitychange", onVisible);
});
function onVisible() {
  if (!document.hidden) resume();
}

// 系統通知(如退租)→ 彈 toast
watch(
  () => state.notice,
  (msg) => {
    if (msg) {
      toast(msg);
      state.notice = "";
      if (view.value === "room" && !state.runtimes[state.activeId]) view.value = "floor";
    }
  },
);

function onEnterRoom(room: RoomInfo) {
  if (room.type === "facility") {
    toast(`${room.tenantName}:全體租客共用設施。`);
    return;
  }
  const tid = state.occupancy[room.id];
  if (!tid) {
    recruitRoom.value = room.id; // 空房 → 開招租面板
    return;
  }
  state.activeId = tid;
  sinceMs.value = state.runtimes[tid].lastSeenMs; // 進房前快照
  markSeen(tid); // 清未讀徽章
  view.value = "room";
}

function toast(msg: string) {
  vacantNote.value = msg;
  window.setTimeout(() => (vacantNote.value = ""), 2200);
}

const pendingName = computed(() => (state.pendingPlace ? getDef(state.pendingPlace).name : ""));

function onPlace(tile: { c: number; r: number }) {
  const name = pendingName.value;
  const res = placeAt(tile.c, tile.r);
  toast(res.ok ? `已擺放:${name}` : `放不了:${res.reason}`);
}

function onSell() {
  const item = inspectItem.value;
  if (!item) return;
  const name = getDef(item.defId).name;
  const res = sellFurnitureAt(item.c, item.r);
  inspectItem.value = null;
  if (res.ok) toast(`已賣掉:${name},退回 $${res.refund?.toLocaleString()}`);
}

const allTags = computed(() => [
  ...rt.value.tenant.coreTags.map((t) => ({ label: t.label, core: true })),
  ...rt.value.tenant.memoryTags.map((t) => ({ label: t.label, core: false })),
]);

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const activeRoomId = computed(() =>
  Object.entries(state.occupancy).find(([, tid]) => tid === state.activeId)?.[0] ?? "",
);
const roomAttrs = computed(() => {
  const a = roomAttributes(activeRoomId.value);
  return Object.entries(a)
    .filter(([, v]) => v)
    .map(([k, v]) => ({ label: ATTR_LABEL[k] ?? k, value: v as number }));
});

function statColor(v: number, invert = false) {
  const good = invert ? v < 40 : v > 60;
  const bad = invert ? v > 75 : v < 30;
  return bad ? "var(--bad)" : good ? "var(--good)" : "var(--accent)";
}

function onDecide(choiceId: string, label: string) {
  decide(rt.value.tenant.id, choiceId, label);
}
</script>

<template>
  <header>
    <div class="title">🏠 房東監視中 <span class="ver">prototype</span></div>
    <div class="meta">
      <span>🕐 {{ clockLabel }}</span>
      <span>💰 {{ state.money.toLocaleString() }}</span>
    </div>
  </header>

  <!-- ============ 樓層總覽 ============ -->
  <main v-if="view === 'floor'" class="floor-main">
    <p v-if="!state.pendingPlace" class="hint">點房間看觀察 · 點家具查看/賣掉 · 現實 1 天 = 遊戲 8 天</p>
    <div v-else class="place-bar">
      🪑 擺放中:<b>{{ pendingName }}</b> — 點地圖任一格放置
      <button class="cancel" @click="cancelPlacing()">取消</button>
    </div>
    <div class="map-viewport">
      <FloorMap
        :pending-rooms="pendingRooms"
        :unread="unreadRooms"
        @enter="onEnterRoom"
        @place="onPlace"
        @inspect="inspectItem = $event"
      />
    </div>

    <div class="floor-actions">
      <button class="shop-btn" @click="showShop = true">🛒 家具商店</button>
      <button class="advance" @click="fastForward(6)">⏩ 快轉 6 小時</button>
    </div>
    <p v-if="hasAnyPending" class="pending-hint">🔴 有房間出現突發事件,點進去做決定。</p>
    <transition name="fade">
      <div v-if="vacantNote" class="toast">{{ vacantNote }}</div>
    </transition>
  </main>

  <!-- ============ 房間細看 ============ -->
  <main v-else class="room-main">
    <button class="back" @click="view = 'floor'">← 回樓層</button>

    <div class="room-head">
      <span class="rno">{{ rt.roomNo }}</span>
      <span class="rname">{{ rt.tenant.name }}</span>
      <span class="rjob">{{ rt.tenant.occupation }}</span>
    </div>

    <PixelDollhouse
      :tenant-id="rt.tenant.id"
      :visual-state="rt.tenant.visualState"
      :room-props="rt.roomProps"
      :cleanliness="rt.cleanliness"
      :room-no="rt.roomNo"
    />

    <section class="stats">
      <div class="stat">
        <label>心情</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.mood + '%', background: statColor(rt.tenant.stats.mood) }"></div></div>
        <span>{{ rt.tenant.stats.mood }}</span>
      </div>
      <div class="stat">
        <label>壓力</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.stress + '%', background: statColor(rt.tenant.stats.stress, true) }"></div></div>
        <span>{{ rt.tenant.stats.stress }}</span>
      </div>
      <div class="stat">
        <label>好感</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.affinity + '%', background: statColor(rt.tenant.stats.affinity) }"></div></div>
        <span>{{ rt.tenant.stats.affinity }}</span>
      </div>
      <div class="stat">
        <label>整潔</label>
        <div class="bar"><div :style="{ width: rt.cleanliness + '%', background: statColor(rt.cleanliness) }"></div></div>
        <span>{{ rt.cleanliness }}</span>
      </div>
      <div class="stat span2">
        <label>滿意</label>
        <div class="bar"><div :style="{ width: Math.round(rt.satisfaction) + '%', background: statColor(rt.satisfaction) }"></div></div>
        <span>{{ Math.round(rt.satisfaction) }}</span>
      </div>
    </section>
    <p v-if="rt.unhappyHours >= 24" class="warn">⚠ {{ rt.tenant.name }} 住得不開心,再不改善可能會退租。</p>

    <section class="tags">
      <span v-for="t in allTags" :key="t.label" class="chip" :class="{ mem: !t.core }">{{ t.label }}</span>
    </section>

    <section v-if="roomAttrs.length" class="attrs">
      <span class="attrs-title">房間屬性</span>
      <span v-for="a in roomAttrs" :key="a.label" class="attr" :class="{ neg: a.value < 0 }">
        {{ a.label }} {{ a.value > 0 ? "+" : "" }}{{ a.value }}
      </span>
    </section>

    <section class="summary" @click="showSummary = !showSummary">
      <div class="summary-head">
        📋 近期摘要(AI 記憶)
        <span class="arrow">{{ showSummary ? "▲" : "▼" }}</span>
      </div>
      <p v-if="showSummary">{{ rt.tenant.recentSummary }}</p>
    </section>

    <LogFeed :entries="rt.log" :since-ms="sinceMs" />
  </main>

  <DecisionModal
    v-if="view === 'room' && rt.pendingEvent"
    :event="rt.pendingEvent"
    :tenant-name="rt.tenant.name"
    @decide="onDecide"
  />

  <FurnitureShop v-if="showShop" @close="showShop = false" />
  <RecruitPanel v-if="recruitRoom" :room-id="recruitRoom" @close="recruitRoom = null" />
  <FurnitureInfo
    v-if="inspectItem"
    :c="inspectItem.c"
    :r="inspectItem.r"
    :def-id="inspectItem.defId"
    @close="inspectItem = null"
    @sell="onSell"
  />
</template>

<style scoped>
header {
  display: flex; justify-content: space-between; align-items: center; padding: 14px 16px 10px;
}
.title { font-weight: 700; font-size: 16px; }
.ver { font-size: 10px; color: var(--text-dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; vertical-align: 2px; }
.meta { display: flex; gap: 12px; font-size: 12.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

main { flex: 1; min-height: 0; padding: 0 16px 24px; display: flex; flex-direction: column; gap: 12px; }
.room-main { overflow-y: auto; }
.floor-main { overflow: hidden; padding-bottom: 16px; }
.map-viewport {
  flex: 1; min-height: 0; overflow-y: auto;
  border: 1px solid var(--line); border-radius: 10px; background: #0d0c12;
  -webkit-overflow-scrolling: touch;
}

.hint { font-size: 12px; color: var(--text-dim); text-align: center; margin-top: 2px; }
.pending-hint { font-size: 12px; color: var(--bad); text-align: center; }
.place-bar {
  display: flex; align-items: center; gap: 8px; justify-content: center;
  font-size: 12.5px; color: #cdbcff; background: rgba(143, 123, 255, 0.12);
  border: 1px solid var(--accent-2); border-radius: 10px; padding: 8px 12px;
}
.place-bar .cancel { margin-left: auto; background: var(--panel); border: 1px solid var(--line); color: var(--text-dim); border-radius: 8px; padding: 3px 10px; font-size: 12px; }

.back { align-self: flex-start; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 13px; }
.back:hover { border-color: var(--accent-2); }

.room-head { display: flex; align-items: baseline; gap: 8px; }
.rno { font-weight: 700; color: var(--accent); font-size: 15px; }
.rname { font-weight: 600; font-size: 15px; }
.rjob { font-size: 12px; color: var(--text-dim); }

.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
.stat { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.stat label { color: var(--text-dim); white-space: nowrap; }
.stat span { width: 24px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-dim); }
.bar { flex: 1; height: 7px; background: #17151f; border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; border-radius: 4px; transition: width 0.6s ease, background 0.6s; }
.stat.span2 { grid-column: 1 / -1; }
.warn { font-size: 12px; color: var(--bad); }

.attrs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.attrs-title { font-size: 11px; color: var(--text-dim); }
.attr { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); color: var(--good); }
.attr.neg { color: var(--bad); }

.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--accent-2); color: #c9befc; background: rgba(143, 123, 255, 0.08); }
.chip.mem { border-color: var(--accent); color: #ffd6a3; background: rgba(255, 180, 94, 0.08); }

.summary { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; cursor: pointer; font-size: 12.5px; }
.summary-head { display: flex; justify-content: space-between; color: var(--text-dim); }
.summary p { margin-top: 8px; line-height: 1.7; color: var(--text); }
.arrow { font-size: 10px; }

.floor-actions { display: flex; gap: 8px; }
.shop-btn { flex: 1; background: var(--panel-2); border: 1px solid var(--accent-2); color: #cdbcff; font-size: 14px; font-weight: 600; border-radius: 12px; padding: 13px 0; }
.shop-btn:hover { background: #322c46; }
.advance { flex: 1; background: linear-gradient(135deg, var(--accent), #ff9440); color: #2b1a05; font-size: 14px; font-weight: 700; border-radius: 12px; padding: 13px 0; box-shadow: 0 6px 20px rgba(255, 180, 94, 0.25); transition: transform 0.1s; }
.advance:hover { transform: translateY(-1px); }

.toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); background: rgba(13,12,18,0.92); border: 1px solid var(--line); color: var(--text); padding: 8px 16px; border-radius: 999px; font-size: 12.5px; z-index: 50; max-width: 90%; text-align: center; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
