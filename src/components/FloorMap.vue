<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { composeFloor, FLOOR_W, FLOOR_H } from "../floor/floorScene";
import { ROOM_INFO, TILE, type RoomInfo } from "../floor/map";
import { createAgents, tickAgents, type Agent } from "../floor/agents";
import { state } from "../store";
import { furnitureAt } from "../sim/placements";

const props = defineProps<{ pendingRooms: string[]; unread: Record<string, number> }>();
const emit = defineEmits<{
  enter: [room: RoomInfo];
  place: [tile: { c: number; r: number }];
  inspect: [item: { c: number; r: number; defId: string }];
}>();

const placing = computed(() => state.pendingPlace !== null);

const canvas = ref<HTMLCanvasElement | null>(null);
let agents: Agent[] = [];
let raf = 0;
let last = 0;

function loop(t: number) {
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
  last = t;
  // 有新租客入住(runtime 數量改變)→ 重建 agents
  if (agents.length !== Object.keys(state.runtimes).length) agents = createAgents();
  tickAgents(agents, dt);
  const el = canvas.value;
  if (el) composeFloor(el.getContext("2d")!, Math.floor(t / 500), agents);
  raf = requestAnimationFrame(loop);
}

onMounted(() => {
  agents = createAgents();
  raf = requestAnimationFrame(loop);
});
onUnmounted(() => cancelAnimationFrame(raf));

/** 房間標籤(百分比定位於 canvas 上);名稱依動態佔用狀態 */
const labels = computed(() =>
  ROOM_INFO.map((r) => {
    const tid = state.occupancy[r.id];
    const occupied = r.type === "facility" || !!tid;
    const name = r.type === "facility" ? r.tenantName : tid ? state.runtimes[tid]?.tenant.name ?? r.tenantName : "招租中";
    return {
      info: r,
      name,
      occupied,
      style: {
        left: `${((r.rect.c0 * TILE) / FLOOR_W) * 100}%`,
        top: `${((r.rect.r0 * TILE) / FLOOR_H) * 100}%`,
        width: `${(((r.rect.c1 - r.rect.c0 + 1) * TILE) / FLOOR_W) * 100}%`,
      },
      pending: props.pendingRooms.includes(r.id),
      unread: props.unread[r.id] ?? 0,
    };
  }),
);

function onClick(e: MouseEvent) {
  const el = canvas.value;
  if (!el) return;
  const box = el.getBoundingClientRect();
  const cx = ((e.clientX - box.left) / box.width) * FLOOR_W;
  const cy = ((e.clientY - box.top) / box.height) * FLOOR_H;
  const tc = Math.floor(cx / TILE);
  const tr = Math.floor(cy / TILE);
  if (placing.value) {
    emit("place", { c: tc, r: tr });
    return;
  }
  // 先看是否點到家具 → 顯示資訊/可賣掉
  const f = furnitureAt(tc, tr);
  if (f) {
    emit("inspect", { c: f.c, r: f.r, defId: f.defId });
    return;
  }
  // 否則點空地/房間 → 進入該房
  const hit = ROOM_INFO.find(
    (r) => tc >= r.rect.c0 && tc <= r.rect.c1 && tr >= r.rect.r0 && tr <= r.rect.r1,
  );
  if (hit) emit("enter", hit);
}
</script>

<template>
  <div class="floor-wrap">
    <canvas ref="canvas" :width="FLOOR_W" :height="FLOOR_H" @click="onClick"></canvas>
    <!-- 房間標籤覆蓋層 -->
    <button
      v-for="l in labels"
      :key="l.info.id"
      class="room-label"
      :class="{ vacant: !l.occupied }"
      :style="{ ...l.style, pointerEvents: placing ? 'none' : 'auto' }"
      @click="emit('enter', l.info)"
    >
      <span class="no">{{ l.info.label }}</span>
      <span class="name">{{ l.name }}</span>
      <span v-if="l.pending" class="pin">!</span>
      <span v-else-if="l.unread > 0" class="unread">{{ l.unread }}</span>
    </button>
    <div class="lounge-tag">交誼廳</div>
    <div class="entrance-tag">🚪 大門</div>
  </div>
</template>

<style scoped>
.floor-wrap {
  position: relative;
  line-height: 0;
}
canvas {
  width: 100%;
  height: auto;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  cursor: pointer;
  border-radius: 8px;
}

.room-label {
  position: absolute;
  /* 貼齊房間上緣的「上方」,坐在隔牆上,不遮住室內家具 */
  transform: translateY(-100%);
  display: flex;
  align-items: center;
  gap: 5px;
  justify-content: center;
  background: rgba(13, 12, 18, 0.8);
  border: 1px solid var(--line);
  color: var(--text);
  border-radius: 7px 7px 0 0;
  padding: 2px 4px 3px;
  font-size: 11px;
  line-height: 1.1;
  backdrop-filter: blur(3px);
  cursor: pointer;
}
.room-label:hover {
  border-color: var(--accent-2);
}
.room-label.vacant {
  color: var(--text-dim);
  opacity: 0.85;
}
.no {
  font-weight: 700;
  color: var(--accent);
}
.room-label.vacant .no {
  color: var(--text-dim);
}
.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bad);
  color: #fff;
  font-weight: 700;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: pulse 1.2s infinite;
}
.unread {
  min-width: 15px;
  height: 15px;
  border-radius: 999px;
  padding: 0 4px;
  background: var(--accent-2);
  color: #fff;
  font-weight: 700;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
@keyframes pulse {
  50% { transform: scale(1.25); }
}

.lounge-tag {
  position: absolute;
  left: 50%;
  top: 35%;
  transform: translate(-50%, -50%);
  font-size: 11px;
  letter-spacing: 3px;
  color: rgba(255, 255, 255, 0.35);
  line-height: 1;
  pointer-events: none;
}
.entrance-tag {
  position: absolute;
  left: 50%;
  bottom: 4px;
  transform: translateX(-50%);
  font-size: 10px;
  letter-spacing: 1px;
  color: rgba(255, 233, 168, 0.75);
  line-height: 1;
  pointer-events: none;
}
</style>
