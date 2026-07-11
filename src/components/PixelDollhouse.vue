<script setup lang="ts">
/**
 * 房間細看(工作項 9 重畫):不再用獨立的舊 3/4 場景,而是「跟著租客的實景鏡頭」——
 * 直接渲染樓層實景(與 FloorMap 同一套 composeFloor:真實家具擺設、部件化外觀、
 * 互動/事件特效、日夜色調),裁切租客所在位置放大 3 倍。租客走到交誼廳/浴室,鏡頭跟過去;
 * 外出時鏡頭停在他的房間。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { TenantVisualState } from "../types";
import { composeFloor, FLOOR_W, FLOOR_H } from "../floor/floorScene";
import { createAgents, tickAgents, type Agent } from "../floor/agents";
import { TILE } from "../floor/map";
import { roomRect } from "../sim/placements";
import { state, roomOfTenant } from "../store";

const props = defineProps<{
  tenantId: string;
  visualState: TenantVisualState;
  roomNo: string;
}>();

// 相機視窗:8×7 格,放大 3 倍(手機面板寬度下每格 48px,看得清部件外觀)
const VIEW_W = 8 * TILE;
const VIEW_H = 7 * TILE;
const SCALE = 3;
const CANVAS_W = VIEW_W * SCALE;
const CANVAS_H = VIEW_H * SCALE;

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

const canvas = ref<HTMLCanvasElement | null>(null);
let agents: Agent[] = [];
let raf = 0;
let last = 0;
// 離屏:整張樓層先畫好,再裁鏡頭範圍放大(imageSmoothing 關 = 保持像素感)
const off = document.createElement("canvas");
off.width = FLOOR_W;
off.height = FLOOR_H;
let camX = -1; // 相機左上(px);-1 = 尚未定位,首幀直接跳到位
let camY = -1;

/** 鏡頭目標中心:租客 agent 位置;外出/找不到 → 他的房間中心 */
function cameraTarget(): { x: number; y: number } {
  const a = agents.find((x) => x.tenantId === props.tenantId);
  if (a && !a.hidden) return { x: a.px + TILE / 2, y: a.py + TILE / 2 };
  const rect = roomRect(roomOfTenant(props.tenantId) ?? "");
  if (rect) return { x: ((rect.c0 + rect.c1 + 1) / 2) * TILE, y: ((rect.r0 + rect.r1 + 1) / 2) * TILE };
  return { x: FLOOR_W / 2, y: FLOOR_H / 2 };
}

const clampCam = (v: number, max: number) => Math.min(Math.max(v, 0), max);

function loop(t: number) {
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
  last = t;
  if (agents.length !== Object.keys(state.runtimes).length) agents = createAgents();
  tickAgents(agents, dt);

  const el = canvas.value;
  if (el) {
    const offCtx = off.getContext("2d")!;
    composeFloor(offCtx, Math.floor(t / 500), agents, undefined, new Date(state.gameMs).getHours());

    // 鏡頭緩動跟隨(首幀直接就位)
    const tgt = cameraTarget();
    const wantX = clampCam(tgt.x - VIEW_W / 2, FLOOR_W - VIEW_W);
    const wantY = clampCam(tgt.y - VIEW_H / 2, FLOOR_H - VIEW_H);
    if (camX < 0) {
      camX = wantX;
      camY = wantY;
    } else {
      camX += (wantX - camX) * Math.min(1, dt * 5);
      camY += (wantY - camY) * Math.min(1, dt * 5);
    }

    const ctx = el.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.drawImage(off, Math.round(camX), Math.round(camY), VIEW_W, VIEW_H, 0, 0, CANVAS_W, CANVAS_H);
  }
  raf = requestAnimationFrame(loop);
}

onMounted(() => {
  agents = createAgents();
  raf = requestAnimationFrame(loop);
});
onUnmounted(() => cancelAnimationFrame(raf));
</script>

<template>
  <div class="pixel-room">
    <canvas ref="canvas" :width="CANVAS_W" :height="CANVAS_H"></canvas>
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
