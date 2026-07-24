<script setup lang="ts">
import { computed } from "vue";
import type { RoomPropState, TenantVisualState } from "../types";

const props = defineProps<{
  visualState: TenantVisualState;
  roomProps: RoomPropState[];
  cleanliness: number;
  roomNo: string;
}>();

/** 房間內的定位點(百分比) */
const SPOTS = {
  bed: { left: 14, top: 30 },
  desk: { left: 78, top: 30 },
  sofa: { left: 38, top: 68 },
  kitchen: { left: 80, top: 72 },
  bath: { left: 46, top: 24 },
  center: { left: 52, top: 52 },
  door: { left: 8, top: 74 },
  window: { left: 46, top: 10 },
} as const;

type SpotKey = keyof typeof SPOTS;

/** 租客視覺狀態 → 定位點 / 表情 / 中文標籤 */
const STATE_MAP: Record<TenantVisualState, { spot: SpotKey; emoji: string; label: string }> = {
  idle: { spot: "center", emoji: "🧍", label: "發呆中" },
  sleeping_on_bed: { spot: "bed", emoji: "😴", label: "熟睡中" },
  sleeping_on_couch: { spot: "sofa", emoji: "😴", label: "沙發上睡死" },
  working_at_desk: { spot: "desk", emoji: "🧑‍💻", label: "工作中" },
  gaming: { spot: "desk", emoji: "🕹️", label: "打電動" },
  streaming: { spot: "desk", emoji: "🎤", label: "直播中" },
  eating: { spot: "kitchen", emoji: "🍜", label: "進食中" },
  cooking: { spot: "kitchen", emoji: "🍳", label: "下廚中" },
  playing_with_cat: { spot: "sofa", emoji: "🥰", label: "逗貓中" },
  crying: { spot: "sofa", emoji: "😭", label: "情緒崩潰" },
  pacing: { spot: "center", emoji: "😰", label: "焦慮踱步" },
  away: { spot: "door", emoji: "", label: "外出中" },
  showering: { spot: "bath", emoji: "🚿", label: "沐浴中" },
  using_toilet: { spot: "bath", emoji: "🚽", label: "使用廁所" },
  washing_at_sink: { spot: "bath", emoji: "🪥", label: "刷牙洗臉" },
  taking_bath: { spot: "bath", emoji: "🛁", label: "泡澡中" },
  waiting_for_bathroom: { spot: "door", emoji: "⏳", label: "排隊等浴室" },
  cleaning: { spot: "center", emoji: "🧹", label: "打掃中" },
  talking_on_phone: { spot: "center", emoji: "📱", label: "講電話" },
  watching_tv: { spot: "sofa", emoji: "📺", label: "看電視" },
  eating_at_table: { spot: "kitchen", emoji: "🍽️", label: "用餐中" },
  reading: { spot: "sofa", emoji: "📖", label: "看書中" },
  painting: { spot: "desk", emoji: "🎨", label: "作畫中" },
  using_appliance: { spot: "kitchen", emoji: "🧺", label: "使用家電" },
};

/** 房間小物件 → 定位點 / 圖示 */
const PROP_MAP: Record<RoomPropState, { spot: SpotKey; emoji: string; title: string }> = {
  cat_on_table: { spot: "desk", emoji: "🐈", title: "貓在桌上" },
  cat_sleeping_on_couch: { spot: "sofa", emoji: "🐈", title: "貓睡沙發" },
  cat_hiding: { spot: "bath", emoji: "🫣", title: "貓躲起來了" },
  delivery_boxes_piled: { spot: "door", emoji: "📦", title: "外送盒堆積" },
  trash_overflow: { spot: "kitchen", emoji: "🗑️", title: "垃圾滿出" },
  laundry_piled: { spot: "bed", emoji: "👕", title: "衣物堆積" },
  lights_off: { spot: "center", emoji: "", title: "燈全暗" },
  curtains_closed: { spot: "window", emoji: "", title: "窗簾拉上" },
  mic_setup_active: { spot: "desk", emoji: "🎙️", title: "麥克風亮燈" },
  screen_glow: { spot: "desk", emoji: "", title: "螢幕光" },
};

const tenantSpot = computed(() => STATE_MAP[props.visualState]);
const isAway = computed(() => props.visualState === "away");
const isDark = computed(() => props.roomProps.includes("lights_off"));
const curtains = computed(() => props.roomProps.includes("curtains_closed"));
const screenGlow = computed(() => props.roomProps.includes("screen_glow") || props.visualState === "streaming");

const visibleProps = computed(() =>
  props.roomProps
    .filter((p) => PROP_MAP[p].emoji !== "")
    .map((p) => ({ id: p, ...PROP_MAP[p], pos: SPOTS[PROP_MAP[p].spot] })),
);

/** 同一定位點的物件錯開一點,避免完全重疊 */
function propOffset(i: number) {
  return { transform: `translate(${(i % 3) * 14 - 8}px, ${Math.floor(i / 3) * -12}px)` };
}
</script>

<template>
  <div class="dollhouse" :class="{ dark: isDark }">
    <!-- 牆與地板 -->
    <div class="wall">
      <div class="window" :class="{ closed: curtains }">
        <span v-if="!curtains">🌃</span>
      </div>
      <div class="room-no">{{ roomNo }}</div>
    </div>
    <div class="floor" :style="{ filter: `saturate(${0.5 + cleanliness / 200})` }"></div>

    <!-- 家具(佔位美術) -->
    <div class="furniture" :style="{ left: SPOTS.bed.left + '%', top: SPOTS.bed.top + '%' }">🛏️</div>
    <div class="furniture" :class="{ glow: screenGlow }" :style="{ left: SPOTS.desk.left + '%', top: SPOTS.desk.top + '%' }">🖥️</div>
    <div class="furniture" :style="{ left: SPOTS.sofa.left + '%', top: SPOTS.sofa.top + '%' }">🛋️</div>
    <div class="furniture small" :style="{ left: SPOTS.kitchen.left + '%', top: SPOTS.kitchen.top + '%' }">🫖</div>
    <div class="furniture small" :style="{ left: SPOTS.door.left + '%', top: SPOTS.door.top + '%' }">🚪</div>

    <!-- 房間小物件 -->
    <div
      v-for="(p, i) in visibleProps"
      :key="p.id"
      class="prop"
      :title="p.title"
      :style="{ left: p.pos.left + '%', top: p.pos.top + '%', ...propOffset(i) }"
    >
      {{ p.emoji }}
    </div>

    <!-- 租客 -->
    <div
      v-if="!isAway"
      class="tenant"
      :style="{ left: SPOTS[tenantSpot.spot].left + '%', top: SPOTS[tenantSpot.spot].top + '%' }"
    >
      {{ tenantSpot.emoji }}
    </div>
    <div class="state-badge">
      <span class="dot" :class="{ away: isAway }"></span>
      {{ tenantSpot.label }}
    </div>

    <!-- 燈暗覆蓋層 -->
    <div v-if="isDark" class="dark-overlay"></div>
  </div>
</template>

<style scoped>
.dollhouse {
  position: relative;
  aspect-ratio: 16 / 11;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--line);
  background: #3d3752;
  transition: filter 0.6s;
}

.wall {
  position: absolute;
  inset: 0 0 42% 0;
  background: linear-gradient(180deg, #4a4363, #423b58);
}

.floor {
  position: absolute;
  inset: 58% 0 0 0;
  background: repeating-linear-gradient(
    90deg,
    #6b5642 0 34px,
    #75604b 34px 68px
  );
}

.window {
  position: absolute;
  left: 42%;
  top: 12%;
  width: 16%;
  aspect-ratio: 1;
  border-radius: 8px;
  border: 3px solid #2e2a3e;
  background: #1a2340;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}
.window.closed {
  background: repeating-linear-gradient(0deg, #5c5378 0 8px, #544b6e 8px 16px);
}

.room-no {
  position: absolute;
  right: 10px;
  top: 8px;
  font-size: 11px;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.35);
}

.furniture {
  position: absolute;
  font-size: 42px;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35));
  user-select: none;
}
.furniture.small {
  font-size: 32px;
}
.furniture.glow {
  text-shadow: 0 0 18px #7db4ff, 0 0 40px #7db4ff88;
}

.prop {
  position: absolute;
  font-size: 20px;
  transform: translate(-50%, -50%);
  z-index: 3;
  user-select: none;
}

.tenant {
  position: absolute;
  font-size: 34px;
  transform: translate(-50%, -70%);
  z-index: 4;
  animation: breathe 3s ease-in-out infinite;
  user-select: none;
}

@keyframes breathe {
  0%, 100% { transform: translate(-50%, -70%) scale(1); }
  50% { transform: translate(-50%, -70%) scale(1.06); }
}

.state-badge {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(13, 12, 18, 0.75);
  border: 1px solid var(--line);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  backdrop-filter: blur(4px);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--good);
  animation: blink 1.6s infinite;
}
.dot.away {
  background: var(--text-dim);
  animation: none;
}
@keyframes blink {
  50% { opacity: 0.3; }
}

.dark-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: radial-gradient(circle at 78% 30%, rgba(10, 10, 25, 0.25), rgba(8, 8, 16, 0.72));
  pointer-events: none;
}
</style>
