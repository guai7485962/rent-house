<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { RoomPropState, TenantVisualState } from "../types";
import { SCENE_W, SCENE_H, composeScene } from "../pixel/scene";

const props = defineProps<{
  tenantId: string;
  visualState: TenantVisualState;
  roomProps: RoomPropState[];
  cleanliness: number;
  roomNo: string;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let frame = 0;
let timer: number | undefined;

const STATE_LABEL: Record<TenantVisualState, string> = {
  idle: "發呆中",
  sleeping_on_bed: "熟睡中",
  sleeping_on_couch: "沙發上睡死",
  working_at_desk: "工作中",
  gaming: "打電動",
  streaming: "直播中",
  eating: "進食中",
  cooking: "下廚中",
  playing_with_cat: "逗貓中",
  crying: "情緒崩潰",
  pacing: "焦慮踱步",
  away: "外出中",
  showering: "沐浴中",
  cleaning: "打掃中",
  talking_on_phone: "講電話",
  watching_tv: "看電視",
  eating_at_table: "用餐中",
  reading: "看書中",
  painting: "作畫中",
  using_appliance: "使用家電",
};

const label = computed(() => STATE_LABEL[props.visualState]);
const isAway = computed(() => props.visualState === "away");

function draw() {
  const el = canvas.value;
  if (!el) return;
  const ctx = el.getContext("2d")!;
  ctx.clearRect(0, 0, SCENE_W, SCENE_H);
  composeScene(ctx, {
    tenantId: props.tenantId,
    visualState: props.visualState,
    roomProps: props.roomProps,
    cleanliness: props.cleanliness,
    frame,
  });
}

onMounted(() => {
  draw();
  timer = window.setInterval(() => {
    frame++;
    draw();
  }, 550);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

watch(
  () => [props.tenantId, props.visualState, props.roomProps, props.cleanliness],
  () => draw(),
  { deep: true },
);
</script>

<template>
  <div class="pixel-room">
    <canvas ref="canvas" :width="SCENE_W" :height="SCENE_H"></canvas>
    <div class="room-no">{{ roomNo }}</div>
    <div class="state-badge">
      <span class="dot" :class="{ away: isAway }"></span>
      {{ label }}
    </div>
  </div>
</template>

<style scoped>
.pixel-room {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--line);
  background: #241f33;
  line-height: 0;
}

canvas {
  width: 100%;
  height: auto;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.room-no {
  position: absolute;
  right: 10px;
  top: 8px;
  font-size: 11px;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.4);
  line-height: 1;
}

.state-badge {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(13, 12, 18, 0.75);
  border: 1px solid var(--line);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.2;
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
</style>
