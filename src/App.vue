<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import FloorMap from "./components/FloorMap.vue";
import PixelDollhouse from "./components/PixelDollhouse.vue";
import LogFeed from "./components/LogFeed.vue";
import DecisionModal from "./components/DecisionModal.vue";
import FurnitureShop from "./components/FurnitureShop.vue";
import RecruitPanel from "./components/RecruitPanel.vue";
import FurnitureInfo from "./components/FurnitureInfo.vue";
import RelationshipsPanel from "./components/RelationshipsPanel.vue";
import CohabitModal from "./components/CohabitModal.vue";
import FinancePanel from "./components/FinancePanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import RentPanel from "./components/RentPanel.vue";
import UpgradePanel from "./components/UpgradePanel.vue";
import { listRelationships } from "./sim/social";
import type { RoomInfo } from "./floor/map";
import { roomAttributes } from "./sim/placements";
import { getDef } from "./furniture/catalog";
import { DIRECTIVES } from "./sim/directives";
import {
  state,
  activeRuntime,
  hasAnyPending,
  clockLabel,
  unreadCount,
  markSeen,
  startFastForward,
  decide,
  gameDayIndex,
  initGame,
  stopGame,
  resume,
  placeAt,
  cancelPlacing,
  sellFurnitureAt,
  roomOfTenant,
  startMoving,
  cancelMoving,
  moveFurnitureTo,
  canDropAt,
} from "./store";

type View = "floor" | "room";
const view = ref<View>("floor");
const showSummary = ref(false);
const showShop = ref(false);
const showRels = ref(false);
const showFinance = ref(false);
const showNotices = ref(false);
const showSettings = ref(false);
const showRent = ref(false);
/** 開啟中的改建面板房間 id(佔用房從房間細看進、空房從招租面板進) */
const upgradeRoom = ref<string | null>(null);
/** 只有「承租人」能談房租(同居者不付租) */
const isLeaseHolder = computed(() => Object.values(state.occupancy).includes(state.activeId));
function fmtMs(ms: number) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const recruitRoom = ref<string | null>(null);
const inspectItem = ref<{ c: number; r: number; defId: string } | null>(null);
const vacantNote = ref("");
const sinceMs = ref(0);

const rt = activeRuntime;

// 各房間的租客(含同居者)→ 事件紅點/未讀徽章都要涵蓋
const pendingRooms = computed(() => {
  const out = new Set<string>();
  for (const rt of Object.values(state.runtimes)) {
    if (!rt.pendingEvent) continue;
    const roomId = roomOfTenant(rt.tenant.id);
    if (roomId) out.add(roomId);
  }
  return [...out];
});

const unreadRooms = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const rt of Object.values(state.runtimes)) {
    const roomId = roomOfTenant(rt.tenant.id);
    if (roomId) out[roomId] = (out[roomId] ?? 0) + unreadCount(rt.tenant.id);
  }
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

function toast(msg: string, ms = 2200) {
  vacantNote.value = msg;
  window.setTimeout(() => (vacantNote.value = ""), ms);
}

const pendingName = computed(() => (state.pendingPlace ? getDef(state.pendingPlace).name : ""));
const movingName = computed(() => (state.pendingMove ? getDef(state.pendingMove.defId).name : ""));

function onStartMove() {
  const item = inspectItem.value;
  if (!item) return;
  inspectItem.value = null;
  if (startMoving(item.c, item.r).ok) toast("📦 點地圖任一格,把家具搬過去");
}

// 目前這位租客的感情狀態(顯示在房間細看抬頭)
const partnerLine = computed(() => {
  const id = state.activeId;
  const bonds = listRelationships().filter(
    (r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId],
  );
  const other = (r: { aId: string; bId: string }) => (r.aId === id ? r.bId : r.aId);
  const love = bonds.find((r) => r.romantic);
  if (love) return `❤️ 與 ${state.runtimes[other(love)].tenant.name} 交往中`;
  const friend = bonds.find((r) => r.value >= 50);
  if (friend) return `🤝 與 ${state.runtimes[other(friend)].tenant.name} 是好友`;
  return "";
});

// --- 擺放/移動預覽(8-2):第一次點格只畫半透明 footprint,再點「確認」才成交 ---
const previewTile = ref<{ c: number; r: number } | null>(null);
const previewOk = computed(() => (previewTile.value ? canDropAt(previewTile.value.c, previewTile.value.r) : false));
const preview = computed(() => {
  const t = previewTile.value;
  const defId = state.pendingMove?.defId ?? state.pendingPlace;
  if (!t || !defId) return null;
  const def = getDef(defId);
  return { c: t.c, r: t.r, w: def.footprint.w, h: def.footprint.h, ok: previewOk.value };
});
// 進入/離開擺放與移動模式時,清掉殘留的預覽
watch(
  () => [state.pendingPlace, state.pendingMove] as const,
  () => (previewTile.value = null),
);

/** 點地圖 → 更新預覽位置(點另一格 = 換位置預覽) */
function onPlace(tile: { c: number; r: number }) {
  previewTile.value = tile;
}

/** 按下確認 → 真正成交(此時才扣款/搬動) */
function confirmPlace() {
  const t = previewTile.value;
  if (!t) return;
  if (state.pendingMove) {
    const name = movingName.value;
    const res = moveFurnitureTo(t.c, t.r);
    toast(res.ok ? `已搬好:${name}` : `搬不了:${res.reason}`);
  } else {
    const name = pendingName.value;
    const res = placeAt(t.c, t.r);
    toast(res.ok ? `已擺放:${name}` : `放不了:${res.reason}`);
  }
  previewTile.value = null;
}

/** 取消擺放/移動模式(未確認前不會有任何扣款或搬動) */
function cancelMode() {
  previewTile.value = null;
  if (state.pendingMove) cancelMoving();
  else cancelPlacing();
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
  ...rt.value.tenant.coreTags.map((t) => ({ label: t.label, core: true, fade: 1 })),
  // 記憶越淡,chip 越透明(生命週期可視化)
  ...rt.value.tenant.memoryTags.map((t) => ({ label: t.label, core: false, fade: 0.45 + 0.55 * (t.intensity ?? 1) })),
]);

/** 進行中的行為指令(AI/事件造成的可見行為改變),顯示在標籤列最前 */
const directiveChip = computed(() => {
  const d = rt.value?.directive;
  if (!d) return null;
  const left = d.untilDay - gameDayIndex() + 1;
  if (left <= 0) return null;
  return `${DIRECTIVES[d.id].label} · 剩 ${left} 天`;
});

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const activeRoomId = computed(() => roomOfTenant(state.activeId) ?? "");

// 同房的另一位租客(同居中)→ 房間細看可切換查看
const roomMates = computed(() => {
  const roomId = activeRoomId.value;
  if (!roomId) return [];
  return Object.values(state.runtimes)
    .filter((r) => r.tenant.id !== state.activeId && roomOfTenant(r.tenant.id) === roomId)
    .map((r) => ({ id: r.tenant.id, name: r.tenant.name }));
});
function switchTenant(id: string) {
  state.activeId = id;
  sinceMs.value = state.runtimes[id].lastSeenMs;
  markSeen(id);
}
const roomAttrs = computed(() => {
  const a = roomAttributes(activeRoomId.value);
  return Object.entries(a)
    .filter(([, v]) => v)
    .map(([k, v]) => ({ label: ATTR_LABEL[k] ?? k, value: v as number }));
});

/** 點數值名稱 → 一句話說明(8-5) */
const STAT_HELP: Record<string, string> = {
  心情: "心情:短期情緒,會自然回到這個人的性格基準;戀愛/朋友會墊高基準。",
  壓力: "壓力:太高會失眠、崩潰、觸發事件,還會慢慢蛀掉健康;放鬆能降。",
  精力: "精力:睡覺充電、工作直播消耗;太低會累到壓力上升、健康變差。",
  健康: "健康:身心狀態,慢慢變化;長期高壓/透支會生病(要花錢處理!)。",
  好感: "好感:對你(房東)的信任,影響繳租意願;你的抉擇會改變它。",
  整潔: "整潔:房間狀態,反映租客的生活習慣。",
  滿意: "滿意:綜合心情/好感/壓力/健康/精力/房間裝潢;長期過低會退租!",
};
function explainStat(key: string) {
  toast(STAT_HELP[key] ?? "", 4200);
}

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
      <button class="bell" @click="showNotices = true">🔔</button>
      <button class="bell" @click="showSettings = true">⚙️</button>
    </div>
  </header>

  <!-- ============ 樓層總覽 ============ -->
  <main v-if="view === 'floor'" class="floor-main">
    <div v-if="state.pendingPlace" class="place-bar">
      🪑 擺放:<b>{{ pendingName }}</b>
      <span v-if="!previewTile" class="pb-hint">點地圖選位置</span>
      <button v-else class="confirm" :disabled="!previewOk" @click="confirmPlace()">
        {{ previewOk ? "✓ 確認放這裡" : "✕ 這裡放不下" }}
      </button>
      <button class="cancel" @click="cancelMode()">取消</button>
    </div>
    <div v-else-if="state.pendingMove" class="place-bar">
      📦 移動:<b>{{ movingName }}</b>
      <span v-if="!previewTile" class="pb-hint">點地圖選新位置</span>
      <button v-else class="confirm" :disabled="!previewOk" @click="confirmPlace()">
        {{ previewOk ? "✓ 確認搬這裡" : "✕ 這裡放不下" }}
      </button>
      <button class="cancel" @click="cancelMode()">取消</button>
    </div>
    <p v-else class="hint">點房間看觀察 · 點家具查看/移動/賣掉 · 現實 1 天 = 遊戲 7 天</p>
    <div class="map-viewport">
      <FloorMap
        :pending-rooms="pendingRooms"
        :unread="unreadRooms"
        :preview="preview"
        @enter="onEnterRoom"
        @place="onPlace"
        @inspect="inspectItem = $event"
      />
    </div>

    <div class="floor-actions">
      <button class="shop-btn" @click="showShop = true">🛒 家具商店</button>
      <button class="rel-btn" @click="showRels = true">💞 關係</button>
      <button class="rel-btn" @click="showFinance = true">💰 收支</button>
      <button class="advance" :disabled="state.ffRemaining > 0" @click="startFastForward(6)">
        {{ state.ffRemaining > 0 ? "⏳ 快轉中…" : "⏩ 6 小時" }}
      </button>
      <button class="advance" :disabled="state.ffRemaining > 0" @click="startFastForward(24)">⏩ 1 天</button>
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
      <span v-if="partnerLine" class="rbond">{{ partnerLine }}</span>
    </div>
    <div class="room-tools">
      <span class="rent-now">月租 ${{ rt.tenant.finance.monthlyRent.toLocaleString() }}</span>
      <button v-if="isLeaseHolder" class="rent-btn" @click="showRent = true">💲 談房租</button>
      <span v-else class="rent-note">同居中(不另收租)</span>
      <button class="rent-btn" @click="upgradeRoom = activeRoomId">🔨 改建</button>
    </div>
    <div v-if="roomMates.length" class="mates">
      <button v-for="m in roomMates" :key="m.id" class="mate" @click="switchTenant(m.id)">
        👥 查看同住的 {{ m.name }}
      </button>
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
        <label @click="explainStat('心情')">心情</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.mood + '%', background: statColor(rt.tenant.stats.mood) }"></div></div>
        <span>{{ Math.round(rt.tenant.stats.mood) }}</span>
      </div>
      <div class="stat">
        <label @click="explainStat('壓力')">壓力</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.stress + '%', background: statColor(rt.tenant.stats.stress, true) }"></div></div>
        <span>{{ Math.round(rt.tenant.stats.stress) }}</span>
      </div>
      <div class="stat">
        <label @click="explainStat('精力')">精力</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.energy + '%', background: statColor(rt.tenant.stats.energy) }"></div></div>
        <span>{{ Math.round(rt.tenant.stats.energy) }}</span>
      </div>
      <div class="stat">
        <label @click="explainStat('健康')">健康</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.wellbeing + '%', background: statColor(rt.tenant.stats.wellbeing) }"></div></div>
        <span>{{ Math.round(rt.tenant.stats.wellbeing) }}</span>
      </div>
      <div class="stat">
        <label @click="explainStat('好感')">好感</label>
        <div class="bar"><div :style="{ width: rt.tenant.stats.affinity + '%', background: statColor(rt.tenant.stats.affinity) }"></div></div>
        <span>{{ Math.round(rt.tenant.stats.affinity) }}</span>
      </div>
      <div class="stat">
        <label @click="explainStat('整潔')">整潔</label>
        <div class="bar"><div :style="{ width: rt.cleanliness + '%', background: statColor(rt.cleanliness) }"></div></div>
        <span>{{ Math.round(rt.cleanliness) }}</span>
      </div>
      <div class="stat span2">
        <label @click="explainStat('滿意')">滿意</label>
        <div class="bar"><div :style="{ width: Math.round(rt.satisfaction) + '%', background: statColor(rt.satisfaction) }"></div></div>
        <span>{{ Math.round(rt.satisfaction) }}</span>
      </div>
    </section>
    <p v-if="rt.unhappyHours >= 24" class="warn">⚠ {{ rt.tenant.name }} 住得不開心,再不改善可能會退租。</p>

    <section class="tags">
      <span v-if="directiveChip" class="chip dir">{{ directiveChip }}</span>
      <span v-for="t in allTags" :key="t.label" class="chip" :class="{ mem: !t.core }" :style="{ opacity: t.fade }">{{ t.label }}</span>
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

  <!-- 通知歷史(toast 錯過了這裡都在) -->
  <div v-if="showNotices" class="notice-overlay" @click.self="showNotices = false">
    <div class="notice-panel">
      <header class="np-head">
        <div class="np-ttl">🔔 通知紀錄</div>
        <button class="np-x" @click="showNotices = false">✕</button>
      </header>
      <div class="np-list">
        <p v-if="!state.noticeLog.length" class="np-empty">還沒有任何大事發生。</p>
        <div v-for="(n, i) in [...state.noticeLog].reverse()" :key="i" class="np-item">
          <span class="np-time">{{ fmtMs(n.gameMs) }}</span>
          <span class="np-text">{{ n.text }}</span>
        </div>
      </div>
    </div>
  </div>

  <SettingsPanel v-if="showSettings" @close="showSettings = false" />
  <RentPanel v-if="showRent" :tenant-id="state.activeId" @close="showRent = false" @done="toast($event, 3600)" />
  <UpgradePanel v-if="upgradeRoom" :room-id="upgradeRoom" @close="upgradeRoom = null" @done="toast($event, 3200)" />
  <FurnitureShop v-if="showShop" @close="showShop = false" />
  <RelationshipsPanel v-if="showRels" @close="showRels = false" />
  <FinancePanel v-if="showFinance" @close="showFinance = false" />
  <CohabitModal
    v-if="state.pendingCohabit"
    :a-name="state.pendingCohabit.aName"
    :b-name="state.pendingCohabit.bName"
  />
  <RecruitPanel v-if="recruitRoom" :room-id="recruitRoom" @close="recruitRoom = null" @upgrade="upgradeRoom = $event" />
  <FurnitureInfo
    v-if="inspectItem"
    :c="inspectItem.c"
    :r="inspectItem.r"
    :def-id="inspectItem.defId"
    @close="inspectItem = null"
    @sell="onSell"
    @move="onStartMove"
  />
</template>

<style scoped>
header {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 14px 12px 10px; flex-wrap: nowrap;
}
.title { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ver { font-size: 10px; color: var(--text-dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; vertical-align: 2px; }
.meta { display: flex; gap: 7px; align-items: center; font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
.bell { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 3px 6px; font-size: 12.5px; }
/* 窄螢幕:藏 prototype 徽章,保住一行 */
@media (max-width: 430px) {
  .ver { display: none; }
}

.notice-overlay { position: fixed; inset: 0; z-index: 125; background: rgba(8,7,12,0.7); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.notice-panel { width: 100%; max-width: 430px; max-height: 70vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; }
.np-head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.np-ttl { font-weight: 700; font-size: 15px; }
.np-x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }
.np-list { overflow-y: auto; padding: 8px 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.np-empty { font-size: 12.5px; color: var(--text-dim); text-align: center; padding: 20px 0; }
.np-item { display: flex; gap: 8px; font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
.np-time { color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
.np-text { line-height: 1.5; }

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
.place-bar .pb-hint { color: var(--text-dim); }
.place-bar .confirm { background: rgba(90,208,106,0.16); border: 1px solid var(--good); color: #b6ffbe; font-weight: 700; border-radius: 8px; padding: 3px 12px; font-size: 12px; }
.place-bar .confirm:disabled { background: rgba(232,101,122,0.12); border-color: var(--bad); color: #ff9aa8; opacity: 0.9; }

.back { align-self: flex-start; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 13px; }
.back:hover { border-color: var(--accent-2); }

.room-head { display: flex; align-items: baseline; gap: 8px; }
.room-tools { display: flex; align-items: center; gap: 8px; }
.rent-now { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.rent-btn { background: var(--panel); border: 1px solid var(--accent); color: #ffd6a3; border-radius: 999px; padding: 3px 12px; font-size: 12px; }
.rent-note { font-size: 11.5px; color: var(--text-dim); }
.mates { display: flex; gap: 6px; }
.mate { background: var(--panel); border: 1px solid #d9548a; color: #f0a8c6; border-radius: 999px; padding: 4px 12px; font-size: 12px; }
.rno { font-weight: 700; color: var(--accent); font-size: 15px; }
.rname { font-weight: 600; font-size: 15px; }
.rjob { font-size: 12px; color: var(--text-dim); }

.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
.stat { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.stat label { color: var(--text-dim); white-space: nowrap; cursor: pointer; border-bottom: 1px dotted var(--line); }
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
.chip.dir { border-color: #5ad06a; color: #b6ffbe; background: rgba(90, 208, 106, 0.08); }

.summary { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; cursor: pointer; font-size: 12.5px; }
.summary-head { display: flex; justify-content: space-between; color: var(--text-dim); }
.summary p { margin-top: 8px; line-height: 1.7; color: var(--text); }
.arrow { font-size: 10px; }

.floor-actions { display: flex; gap: 8px; }
.shop-btn { flex: 1; background: var(--panel-2); border: 1px solid var(--accent-2); color: #cdbcff; font-size: 14px; font-weight: 600; border-radius: 12px; padding: 13px 0; }
.shop-btn:hover { background: #322c46; }
.rel-btn { flex: 0.7; background: var(--panel-2); border: 1px solid #d9548a; color: #f0a8c6; font-size: 14px; font-weight: 600; border-radius: 12px; padding: 13px 0; }
.rbond { font-size: 11.5px; color: #f0a8c6; margin-left: auto; align-self: center; }
.advance { flex: 1; background: linear-gradient(135deg, var(--accent), #ff9440); color: #2b1a05; font-size: 14px; font-weight: 700; border-radius: 12px; padding: 13px 0; box-shadow: 0 6px 20px rgba(255, 180, 94, 0.25); transition: transform 0.1s; }
.advance:hover { transform: translateY(-1px); }
.advance:disabled { opacity: 0.55; transform: none; cursor: wait; }

.toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); background: rgba(13,12,18,0.92); border: 1px solid var(--line); color: var(--text); padding: 8px 16px; border-radius: 999px; font-size: 12.5px; z-index: 50; max-width: 90%; text-align: center; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
