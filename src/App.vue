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
import LegacyPanel from "./components/LegacyPanel.vue";
import GroupDecisionModal from "./components/GroupDecisionModal.vue";
import RentPanel from "./components/RentPanel.vue";
import UpgradePanel from "./components/UpgradePanel.vue";
import FeedPanel from "./components/FeedPanel.vue";
import { listRelationships } from "./sim/social";
import type { RoomInfo } from "./floor/map";
import { roomAttributes } from "./sim/placements";
import { getDef } from "./furniture/catalog";
import { rotatedFootprint, type FurnitureRotation } from "./furniture/rotation";
import { DIRECTIVES } from "./sim/directives";
import { todayWeather, weatherLabel } from "./sim/weather";
import { GROWTH_TAGS } from "./sim/growth";
import { repairBreakdown, getBreakdownDef } from "./sim/maintenance";
import {
  state,
  activeRuntime,
  hasAnyPending,
  clockLabel,
  unreadCount,
  markSeen,
  startFastForward,
  decide,
  resolveGroupEvent,
  gameDayIndex,
  initGame,
  stopGame,
  resume,
  resumeDeferredDiaries,
  placeAt,
  cancelPlacing,
  sellFurnitureAt,
  roomOfTenant,
  startMoving,
  cancelMoving,
  moveFurnitureTo,
  rotatePendingFurniture,
  canDropAt,
  feedUnreadCount,
  markFeedSeen,
} from "./store";

type View = "floor" | "room" | "feed";
const view = ref<View>("floor");
/** 進房間前所在的分頁(回上一頁用:從動態點進來就回動態) */
const roomFrom = ref<"floor" | "feed">("floor");
/** 這次進動態分頁時的「上次已讀」快照(NEW 標記基準) */
const feedSinceMs = ref(0);
const showSummary = ref(false);
const showShop = ref(false);
const showRels = ref(false);
const showFinance = ref(false);
const showNotices = ref(false);
const showSettings = ref(false);
const showLegacy = ref(false);
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
const inspectItem = ref<{ c: number; r: number; defId: string; rotation: FurnitureRotation } | null>(null);
const vacantNote = ref("");
const sinceMs = ref(0);
let diaryRetryTimer: number | null = null;

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

/** 底部導覽「動態」徽章:待決事件優先(紅),否則未讀動態數(紫) */
const pendingCount = computed(() => Object.values(state.runtimes).filter((r) => r.pendingEvent).length);
const feedUnread = computed(() => feedUnreadCount());

// 進動態分頁:快照上次已讀點(給 NEW 標記)後立即標為已讀;離開時再標一次,
// 把停留期間湧入的動態也吸收掉,徽章才不會馬上又亮
watch(view, (nv, ov) => {
  if (nv === "feed") {
    feedSinceMs.value = state.feedSeenMs;
    markFeedSeen();
  } else if (ov === "feed") {
    markFeedSeen();
  }
});

/** 從動態時間軸/事件中心點某則 → 跳進該租客房間 */
function gotoTenant(tid: string) {
  const target = state.runtimes[tid];
  if (!target) return;
  roomFrom.value = view.value === "feed" ? "feed" : "floor";
  state.activeId = tid;
  sinceMs.value = target.lastSeenMs;
  markSeen(tid);
  view.value = "room";
}

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
  window.addEventListener("online", onOnline);
  void resumeDeferredDiaries(2);
  // 玩家一直停在前景時也要重試，不能只有切回分頁才會補；每輪最多兩篇，真正請求仍會錯開。
  diaryRetryTimer = window.setInterval(() => {
    if (!document.hidden && navigator.onLine !== false) void resumeDeferredDiaries(2);
  }, 3 * 60_000);
});
onUnmounted(() => {
  stopGame();
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("online", onOnline);
  if (diaryRetryTimer != null) window.clearInterval(diaryRetryTimer);
});
function onVisible() {
  if (!document.hidden) {
    resume();
    void resumeDeferredDiaries(2);
  }
}
function onOnline() {
  void resumeDeferredDiaries(2);
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
  roomFrom.value = "floor";
  state.activeId = tid;
  sinceMs.value = state.runtimes[tid].lastSeenMs; // 進房前快照
  markSeen(tid); // 清未讀徽章
  view.value = "room";
}

function toast(msg: string, ms = 2200) {
  vacantNote.value = msg;
  window.setTimeout(() => (vacantNote.value = ""), ms);
}

/** 主動請離後離開已不存在的房客細看，回樓層查看空房／接手者。 */
function onTenantEvicted() {
  showRent.value = false;
  view.value = "floor";
}

const pendingName = computed(() => (state.pendingPlace ? getDef(state.pendingPlace).name : ""));
const movingName = computed(() => (state.pendingMove ? getDef(state.pendingMove.defId).name : ""));
const rotationLabel = computed(() => `${state.pendingRotation}°`);

function onStartMove() {
  const item = inspectItem.value;
  if (!item) return;
  inspectItem.value = null;
  if (startMoving(item.c, item.r).ok) toast("📦 點地圖任一格,把家具搬過去");
}

// 目前這位租客的感情狀態(顯示在房間細看抬頭)
const partnerLine = computed(() => {
  const id = state.activeId;
  const bonds = listRelationships((tenantId) => state.runtimes[tenantId]?.tenant).filter(
    (r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId],
  );
  const other = (r: { aId: string; bId: string }) => (r.aId === id ? r.bId : r.aId);
  const love = bonds.find((r) => r.romantic);
  if (love) return `❤️ 與 ${state.runtimes[other(love)].tenant.name} 交往中`;
  const friend = bonds.find((r) => r.value >= 50);
  if (friend) return `🤝 與 ${state.runtimes[other(friend)].tenant.name} 是${friend.label}`;
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
  const fp = rotatedFootprint(def, state.pendingRotation);
  return { c: t.c, r: t.r, w: fp.w, h: fp.h, rotation: state.pendingRotation, ok: previewOk.value };
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
  ...rt.value.tenant.coreTags.map((t) => ({ label: t.label, core: true, growth: false, fade: 1, hint: t.behaviorHint })),
  ...(rt.value.tenant.growthTags ?? []).map((id) => ({
    label: `🌱 ${GROWTH_TAGS[id].label}`,
    core: false,
    growth: true,
    fade: 1,
    hint: GROWTH_TAGS[id].hint,
  })),
  // 記憶越淡,chip 越透明(生命週期可視化)
  ...rt.value.tenant.memoryTags.map((t) => ({ label: t.label, core: false, growth: false, fade: 0.45 + 0.55 * (t.intensity ?? 1), hint: t.behaviorHint })),
]);

/** 進行中的劇情弧(AI 連載主線),顯示在標籤列最前 */
const arcChip = computed(() => {
  const a = rt.value?.arc;
  return a ? `📖 ${a.theme}${a.partnerName ? `(與${a.partnerName})` : ""} · ${a.stage}/${a.maxStage}` : null;
});

/** 今日天氣(header 只放 emoji 省空間;完整名稱放 title 提示) */
const weatherFull = computed(() => weatherLabel(todayWeather()));
const weatherEmoji = computed(() => weatherFull.value.split(" ")[0]);

/** 進行中的行為指令(AI/事件造成的可見行為改變),顯示在標籤列最前 */
const directiveChip = computed(() => {
  const d = rt.value?.directive;
  if (!d) return null;
  const left = d.untilDay - gameDayIndex() + 1;
  if (left <= 0) return null;
  // source=ai:AI 觀察的自發行為(房客自己的決定);缺省/choice = 玩家事件拍板
  return `${DIRECTIVES[d.id].label}${d.source === "ai" ? "(自發)" : ""} · 剩 ${left} 天`;
});

const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
const activeRoomId = computed(() => roomOfTenant(state.activeId) ?? "");

// 設備故障(§7-1):這間房待修的故障 → 房間細看顯示警示 + 修理按鈕
const roomBreakdown = computed(() => {
  const bd = state.breakdowns[activeRoomId.value];
  if (!bd) return null;
  const def = getBreakdownDef(bd.defId);
  if (!def) return null;
  const days = Math.floor((state.gameMs - bd.sinceMs) / 86_400_000);
  return { icon: def.icon, label: def.label, cost: bd.cost, days };
});
function doRepair() {
  const res = repairBreakdown(activeRoomId.value);
  toast(res.ok ? "🔧 修好了!住戶鬆了一口氣。" : `無法修理:${res.reason}`, 3000);
}

// 同房的另一位租客(同居中)→ 房間細看可切換查看
const roomMates = computed(() => {
  const roomId = activeRoomId.value;
  if (!roomId) return [];
  return Object.values(state.runtimes)
    .filter((r) => r.tenant.id !== state.activeId && roomOfTenant(r.tenant.id) === roomId)
    .map((r) => ({ id: r.tenant.id, name: r.tenant.name }));
});
// 房間細看的滑動退出手勢(往左滑退出;水平位移夠大、垂直很小才算,避免和捲動打架)
let swipeX = 0;
let swipeY = 0;
function onRoomTouchStart(e: TouchEvent) {
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
}
function onRoomTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  // 明顯的水平滑動(左或右皆可,iOS 習慣右滑返回)且水平為主 → 退出房間
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) view.value = roomFrom.value;
}

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

function onGroupResolve(choiceId: string) {
  resolveGroupEvent(choiceId);
}
</script>

<template>
  <header>
    <div class="title">🏠 房東監視中</div>
    <div class="meta">
      <span :title="weatherFull">{{ weatherEmoji }} {{ clockLabel }}</span>
      <span>💰 {{ state.money.toLocaleString() }}</span>
      <button class="bell" @click="showLegacy = true">🏆</button>
      <button class="bell" @click="showNotices = true">🔔</button>
      <button class="bell" @click="showSettings = true">⚙️</button>
    </div>
  </header>

  <!-- ============ 樓層總覽 ============ -->
  <main v-if="view === 'floor'" class="floor-main">
    <div v-if="state.pendingPlace" class="place-bar">
      🪑 擺放:<b>{{ pendingName }}</b>
      <span v-if="!previewTile" class="pb-hint">點地圖選位置</span>
      <button class="rotate" @click="rotatePendingFurniture()">↻ {{ rotationLabel }}</button>
      <button v-if="previewTile" class="confirm" :disabled="!previewOk" @click="confirmPlace()">
        {{ previewOk ? "✓ 確認放這裡" : "✕ 這裡放不下" }}
      </button>
      <button class="cancel" @click="cancelMode()">取消</button>
    </div>
    <div v-else-if="state.pendingMove" class="place-bar">
      📦 移動:<b>{{ movingName }}</b>
      <span v-if="!previewTile" class="pb-hint">點地圖選新位置</span>
      <button class="rotate" @click="rotatePendingFurniture()">↻ {{ rotationLabel }}</button>
      <button v-if="previewTile" class="confirm" :disabled="!previewOk" @click="confirmPlace()">
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

  <!-- ============ 動態 Feed ============ -->
  <main v-else-if="view === 'feed'" class="feed-main">
    <FeedPanel :since-ms="feedSinceMs" @goto="gotoTenant" />
    <transition name="fade">
      <div v-if="vacantNote" class="toast">{{ vacantNote }}</div>
    </transition>
  </main>

  <!-- ============ 房間細看 ============ -->
  <main v-else class="room-main" @touchstart.passive="onRoomTouchStart" @touchend.passive="onRoomTouchEnd">
    <button class="back" @click="view = roomFrom">{{ roomFrom === "feed" ? "← 回動態" : "← 回樓層" }}</button>

    <div class="room-head">
      <span class="rno">{{ rt.roomNo }}</span>
      <span class="rname">{{ rt.tenant.name }}</span>
      <span class="rjob">{{ rt.tenant.occupation }}</span>
      <span v-if="partnerLine" class="rbond">{{ partnerLine }}</span>
      <span v-if="state.pets[rt.tenant.id]" class="rpet">🐈 {{ state.pets[rt.tenant.id].name }}</span>
    </div>
    <div class="room-tools">
      <span class="rent-now">月租 ${{ rt.tenant.finance.monthlyRent.toLocaleString() }}</span>
      <button class="rent-btn" @click="showRent = true">📄 租約管理</button>
      <span v-if="!isLeaseHolder" class="rent-note">同居中(不另收租)</span>
      <button class="rent-btn" @click="upgradeRoom = activeRoomId">🔨 改建</button>
    </div>
    <div v-if="roomBreakdown" class="breakdown-bar">
      <span class="bd-text">
        {{ roomBreakdown.icon }} {{ roomBreakdown.label }}<template v-if="roomBreakdown.days >= 1">(已拖 {{ roomBreakdown.days }} 天,住戶越來越不滿)</template>
      </span>
      <button class="bd-btn" :disabled="state.money < roomBreakdown.cost" @click="doRepair">
        🔧 修理 ${{ roomBreakdown.cost.toLocaleString() }}
      </button>
    </div>
    <div v-if="roomMates.length" class="mates">
      <button v-for="m in roomMates" :key="m.id" class="mate" @click="switchTenant(m.id)">
        👥 查看同住的 {{ m.name }}
      </button>
    </div>

    <PixelDollhouse :key="rt.tenant.id" :tenant-id="rt.tenant.id" :visual-state="rt.tenant.visualState" :room-no="rt.roomNo" />

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
      <span v-if="arcChip" class="chip arc">{{ arcChip }}</span>
      <span v-if="directiveChip" class="chip dir">{{ directiveChip }}</span>
      <span v-for="t in allTags" :key="t.label" class="chip" :class="{ mem: !t.core && !t.growth, growth: t.growth }" :style="{ opacity: t.fade }" :title="t.hint">{{ t.label }}</span>
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
      <p v-if="showSummary && rt.arc" class="arc-sum">📖 {{ rt.arc.theme }}{{ rt.arc.partnerName ? `(與 ${rt.arc.partnerName} 共同)` : "" }}(第 {{ rt.arc.stage }}/{{ rt.arc.maxStage }} 章):{{ rt.arc.summary }}</p>
    </section>

    <LogFeed :entries="rt.log" :since-ms="sinceMs" />
  </main>

  <!-- ============ 底部導覽(§3:樓層/動態/收支/關係)============ -->
  <nav class="bottom-nav">
    <button :class="{ on: view === 'floor' || (view === 'room' && roomFrom === 'floor') }" @click="view = 'floor'">
      <span class="nav-ic">🏠</span><span class="nav-lb">樓層</span>
    </button>
    <button :class="{ on: view === 'feed' || (view === 'room' && roomFrom === 'feed') }" @click="view = 'feed'">
      <span class="nav-ic">📰</span><span class="nav-lb">動態</span>
      <em v-if="pendingCount" class="nbadge red">{{ pendingCount }}</em>
      <em v-else-if="feedUnread && view !== 'feed'" class="nbadge">{{ feedUnread > 99 ? "99+" : feedUnread }}</em>
    </button>
    <button :class="{ on: showFinance }" @click="showFinance = true">
      <span class="nav-ic">💰</span><span class="nav-lb">收支</span>
    </button>
    <button :class="{ on: showRels }" @click="showRels = true">
      <span class="nav-ic">💞</span><span class="nav-lb">關係</span>
    </button>
  </nav>

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
  <LegacyPanel v-if="showLegacy" @close="showLegacy = false" />
  <RentPanel v-if="showRent" :tenant-id="state.activeId" @close="showRent = false" @done="toast($event, 3600)" @evicted="onTenantEvicted" />
  <UpgradePanel v-if="upgradeRoom" :room-id="upgradeRoom" @close="upgradeRoom = null" @done="toast($event, 3200)" />
  <FurnitureShop v-if="showShop" @close="showShop = false" />
  <RelationshipsPanel v-if="showRels" @close="showRels = false" />
  <FinancePanel v-if="showFinance" @close="showFinance = false" />
  <CohabitModal
    v-if="state.pendingCohabit"
    :a-name="state.pendingCohabit.aName"
    :b-name="state.pendingCohabit.bName"
  />
  <GroupDecisionModal
    v-if="state.pendingGroupEvent"
    :event="state.pendingGroupEvent"
    @resolve="onGroupResolve"
  />
  <RecruitPanel v-if="recruitRoom" :room-id="recruitRoom" @close="recruitRoom = null" @upgrade="upgradeRoom = $event" />
  <FurnitureInfo
    v-if="inspectItem"
    :c="inspectItem.c"
    :r="inspectItem.r"
    :def-id="inspectItem.defId"
    :rotation="inspectItem.rotation"
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

main { flex: 1; min-height: 0; padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.room-main { overflow-y: auto; }
.floor-main { overflow: hidden; padding-bottom: 12px; }
.feed-main { overflow-y: auto; padding-top: 10px; }

.bottom-nav {
  display: flex; gap: 4px; flex-shrink: 0;
  border-top: 1px solid var(--line); background: var(--panel-2);
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
}
.bottom-nav button {
  flex: 1; position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px;
  background: none; color: var(--text-dim); border-radius: 10px; padding: 5px 0 4px;
}
.bottom-nav button.on { color: var(--accent); background: rgba(255, 180, 94, 0.08); }
.nav-ic { font-size: 17px; line-height: 1.2; }
.nav-lb { font-size: 10px; letter-spacing: 1px; }
.nbadge {
  position: absolute; top: 0; left: 50%; margin-left: 8px;
  font-style: normal; font-size: 9px; font-weight: 700; line-height: 1.5;
  background: var(--accent-2); color: #fff; border-radius: 999px; padding: 0 5px; min-width: 16px; text-align: center;
}
.nbadge.red { background: var(--bad); }
.map-viewport {
  flex: 1; min-height: 0; overflow-y: auto;
  border: 1px solid var(--line); border-radius: 10px; background: #0d0c12;
  -webkit-overflow-scrolling: touch;
}

.hint { font-size: 12px; color: var(--text-dim); text-align: center; margin-top: 2px; }
.pending-hint { font-size: 12px; color: var(--bad); text-align: center; }
.place-bar {
  display: flex; align-items: center; gap: 8px; justify-content: center; flex-wrap: wrap;
  font-size: 12.5px; color: #cdbcff; background: rgba(143, 123, 255, 0.12);
  border: 1px solid var(--accent-2); border-radius: 10px; padding: 8px 12px;
}
.place-bar .cancel { margin-left: auto; background: var(--panel); border: 1px solid var(--line); color: var(--text-dim); border-radius: 8px; padding: 3px 10px; font-size: 12px; }
.place-bar .pb-hint { color: var(--text-dim); }
.place-bar .rotate { background: rgba(143,123,255,0.14); border: 1px solid var(--accent-2); color: #cdbcff; border-radius: 8px; padding: 3px 9px; font-size: 12px; white-space: nowrap; }
.place-bar .confirm { background: rgba(90,208,106,0.16); border: 1px solid var(--good); color: #b6ffbe; font-weight: 700; border-radius: 8px; padding: 3px 12px; font-size: 12px; }
.place-bar .confirm:disabled { background: rgba(232,101,122,0.12); border-color: var(--bad); color: #ff9aa8; opacity: 0.9; }

.back { align-self: flex-start; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 13px; }
.back:hover { border-color: var(--accent-2); }

.room-head { display: flex; align-items: baseline; gap: 8px; }
.room-tools { display: flex; align-items: center; gap: 8px; }
.rent-now { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.rent-btn { background: var(--panel); border: 1px solid var(--accent); color: #ffd6a3; border-radius: 999px; padding: 3px 12px; font-size: 12px; }
.rent-note { font-size: 11.5px; color: var(--text-dim); }
.breakdown-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #2a2013; border: 1px solid #b5872e; border-radius: var(--radius); padding: 8px 12px; }
.bd-text { font-size: 12px; color: #ffd98a; }
.bd-btn { background: #b5872e; border: none; color: #241a08; font-weight: 700; border-radius: 999px; padding: 5px 12px; font-size: 12px; white-space: nowrap; }
.bd-btn:disabled { opacity: 0.45; }
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
.chip.growth { border-color: #67d391; color: #b9f6ce; background: rgba(83, 196, 126, 0.1); }
.chip.dir { border-color: #5ad06a; color: #b6ffbe; background: rgba(90, 208, 106, 0.08); }
.chip.arc { border-color: #58a6ff; color: #a9d1ff; background: rgba(88, 166, 255, 0.08); }

.summary { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; cursor: pointer; font-size: 12.5px; }
.summary-head { display: flex; justify-content: space-between; color: var(--text-dim); }
.summary p { margin-top: 8px; line-height: 1.7; color: var(--text); }
.summary .arc-sum { font-size: 12px; color: #a9d1ff; line-height: 1.6; }
.arrow { font-size: 10px; }

.floor-actions { display: flex; gap: 8px; }
.shop-btn { flex: 1; background: var(--panel-2); border: 1px solid var(--accent-2); color: #cdbcff; font-size: 14px; font-weight: 600; border-radius: 12px; padding: 13px 0; }
.shop-btn:hover { background: #322c46; }
.rbond { font-size: 11.5px; color: #f0a8c6; margin-left: auto; align-self: center; }
.rpet { font-size: 11.5px; color: #e0b078; align-self: center; }
.advance { flex: 1; background: linear-gradient(135deg, var(--accent), #ff9440); color: #2b1a05; font-size: 14px; font-weight: 700; border-radius: 12px; padding: 13px 0; box-shadow: 0 6px 20px rgba(255, 180, 94, 0.25); transition: transform 0.1s; }
.advance:hover { transform: translateY(-1px); }
.advance:disabled { opacity: 0.55; transform: none; cursor: wait; }

.toast { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); background: rgba(13,12,18,0.92); border: 1px solid var(--line); color: var(--text); padding: 8px 16px; border-radius: 999px; font-size: 12.5px; z-index: 50; max-width: 90%; text-align: center; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
