<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { composeFloor, drawFootprintPreview, type FloorMark } from "../floor/floorScene";
import { ROOM_INFO, TILE, type RoomInfo } from "../floor/map";
import { createAgents, tickAgents, type Agent } from "../floor/agents";
import { createPetAgents, petAgentSignature, tickPetAgents, type PetAgent } from "../floor/petAgents";
import { createVacuumAgents, vacuumAgentSignature, tickVacuumAgents, vacuumCellKeys, type VacuumAgent } from "../floor/vacuumAgents";
import { layoutFloorTags } from "../floor/tagLayout";
import { groupSceneView, type GroupScene } from "../floor/groupScene";
import { renderFloorViewport, viewportRect } from "../floor/viewport";
import { getTheme } from "../pixel/scene";
import { state } from "../store";
import { furnitureAt, roomRect } from "../sim/placements";
import type { FurnitureRotation } from "../furniture/rotation";

const props = defineProps<{
  pendingRooms: string[];
  unread: Record<string, number>;
  /** 擺放/移動預覽 footprint(App 在玩家點格後傳入;null = 無預覽) */
  preview?: { c: number; r: number; w: number; h: number; rotation: FurnitureRotation; ok: boolean } | null;
}>();
const emit = defineEmits<{
  enter: [room: RoomInfo];
  place: [tile: { c: number; r: number }];
  inspect: [item: { c: number; r: number; defId: string; rotation: FurnitureRotation }];
}>();

const FLOOR_VIEWS = {
  "3f": { id: "3f", floor: "3F", label: "租屋樓", rect: viewportRect(0, 0, 16 * TILE, 33 * TILE) },
  "1f": { id: "1f", floor: "1F", label: "寵物咖啡廳", rect: viewportRect(0, 34 * TILE, 16 * TILE, 18 * TILE) },
} as const;
type FloorViewId = keyof typeof FLOOR_VIEWS;

const floorView = ref<FloorViewId>("3f");
const activeFloorView = computed(() => FLOOR_VIEWS[floorView.value]);
const canvasWidth = computed(() => activeFloorView.value.rect.width);
const canvasHeight = computed(() => activeFloorView.value.rect.height);
const isTenantFloor = computed(() => floorView.value === "3f");
const floorPageNavigation = computed(() => isTenantFloor.value
  ? { target: "1f" as const, icon: "☕", label: "前往 1F 寵物咖啡廳" }
  : { target: "3f" as const, icon: "🏠", label: "返回 3F 租屋樓" });

/** 玩家看到的是兩個獨立樓層頁面；底層仍只切換共用 grid 的固定 viewport。 */
function switchFloorPage() {
  floorView.value = floorPageNavigation.value.target;
}

const placing = computed(() => state.pendingPlace !== null || state.pendingMove !== null);

const canvas = ref<HTMLCanvasElement | null>(null);
let agents: Agent[] = [];
let petAgents: PetAgent[] = [];
let petSignature = "";
let vacuumAgents: VacuumAgent[] = [];
let vacuumSignature = "";
let raf = 0;
let last = 0;

/** 跟著人走的名字標籤(誰是誰一眼可辨);每幀使用角色當下座標，不做延遲補間。 */
const agentTags = ref<{ id: string; name: string; left: string; top: string; color: string }[]>([]);
const eventScene = ref<GroupScene | null>(null);

function actorStyle(actor: GroupScene["actors"][number]) {
  return {
    "--actor-hair": actor.hair,
    "--actor-shirt": actor.shirt,
    "--actor-pants": actor.pants,
    "--actor-skin": actor.skin,
  };
}

function loop(t: number) {
  try {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    // 掃地機器人(買/賣/移動時位置會變 → 重建);先算出它們當下所在格,讓租客避讓不疊格
    const nextVacuumSignature = vacuumAgentSignature();
    if (nextVacuumSignature !== vacuumSignature) {
      vacuumAgents = createVacuumAgents();
      vacuumSignature = nextVacuumSignature;
    }
    const vacuumBlocked = vacuumCellKeys(vacuumAgents);
    // 有新租客入住(runtime 數量改變)→ 重建 agents
    if (agents.length !== Object.keys(state.runtimes).length) agents = createAgents();
    tickAgents(agents, dt, vacuumBlocked);
    // 掃地機避讓租客(讀租客當幀座標);純外觀,不動任何模擬
    tickVacuumAgents(vacuumAgents, dt, agents);
    // 寵物貓(領養/退租時數量會變 → 重建)
    const nextPetSignature = petAgentSignature();
    if (nextPetSignature !== petSignature) {
      petAgents = createPetAgents();
      petSignature = nextPetSignature;
    }
    tickPetAgents(petAgents, dt);
    eventScene.value = groupSceneView(state.gameMs);
    const el = canvas.value;
    if (el) {
      const ctx = el.getContext("2d")!;
      // 設備故障(§7-1)→ 房間中上方掛閃爍警示三角
      const marks: FloorMark[] = [];
      for (const roomId of Object.keys(state.breakdowns)) {
        const rect = roomRect(roomId);
        if (rect) marks.push({ c: Math.floor((rect.c0 + rect.c1) / 2), r: rect.r0 + 1 });
      }
      const view = activeFloorView.value.rect;
      // 1F 在 CAFE-03 擴充地圖前位於現有畫布外；先清可見 canvas，切換時才能正確顯示空白。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      renderFloorViewport(ctx, view, 1, () => {
        composeFloor(ctx, Math.floor(t / 500), agents, marks, new Date(state.gameMs).getHours(), petAgents, vacuumAgents);
        const pv = props.preview;
        if (pv) drawFootprintPreview(ctx, pv.c, pv.r, pv.w, pv.h, pv.ok, pv.rotation);
      });
    }
    const rawTags = [
        ...agents
          .filter((a) => !a.hidden)
          .map((a) => ({
            id: a.tenantId,
            name: state.runtimes[a.tenantId]?.tenant.name ?? "",
            x: a.px + TILE / 2,
            y: a.py - 8,
            kind: "tenant" as const,
            color: getTheme(a.tenantId).shirt,
          })),
        ...petAgents.map((p) => ({
          id: `pet_${p.petId}`,
          name: `${p.kind === "dog" ? "🐕" : "🐈"}${p.name}`,
          x: p.px + TILE / 2,
          y: p.py + 2,
          kind: "pet" as const,
          color: p.kind === "dog" ? "#c9823d" : "#e0913f",
        })),
    ];
    const view = activeFloorView.value.rect;
    const visibleTags = rawTags
      .filter((tag) => tag.x >= view.x && tag.x <= view.x + view.width && tag.y >= view.y && tag.y <= view.y + view.height)
      .map((tag) => ({ ...tag, x: tag.x - view.x, y: tag.y - view.y }));
    agentTags.value = layoutFloorTags(visibleTags, view.width, view.height).map((tag) => ({
      id: tag.id,
      name: tag.name,
      left: `${(tag.drawX / view.width) * 100}%`,
      top: `${(tag.drawY / view.height) * 100}%`,
      color: tag.color,
    }));
  } finally {
    // 單幀出錯也不讓渲染迴圈死掉(否則畫面會永久停格/消失)
    raf = requestAnimationFrame(loop);
  }
}

onMounted(() => {
  agents = createAgents();
  raf = requestAnimationFrame(loop);
});
onUnmounted(() => cancelAnimationFrame(raf));

/** 房間標籤(百分比定位於 canvas 上);名稱依動態佔用狀態 */
const labels = computed(() =>
  ROOM_INFO.filter((r) => {
    const view = activeFloorView.value.rect;
    const x0 = r.rect.c0 * TILE;
    const y0 = r.rect.r0 * TILE;
    return x0 >= view.x && x0 < view.x + view.width && y0 >= view.y && y0 < view.y + view.height;
  }).map((r) => {
    const view = activeFloorView.value.rect;
    const tid = state.occupancy[r.id];
    const occupied = r.type === "facility" || !!tid;
    const name = r.type === "facility" ? r.tenantName : tid ? state.runtimes[tid]?.tenant.name ?? r.tenantName : "招租中";
    return {
      info: r,
      name,
      occupied,
      style: {
        left: `${((r.rect.c0 * TILE - view.x) / view.width) * 100}%`,
        top: `${((r.rect.r0 * TILE - view.y) / view.height) * 100}%`,
        width: `${(((r.rect.c1 - r.rect.c0 + 1) * TILE) / view.width) * 100}%`,
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
  const view = activeFloorView.value.rect;
  const cx = view.x + ((e.clientX - box.left) / box.width) * view.width;
  const cy = view.y + ((e.clientY - box.top) / box.height) * view.height;
  const tc = Math.floor(cx / TILE);
  const tr = Math.floor(cy / TILE);
  if (placing.value) {
    emit("place", { c: tc, r: tr });
    return;
  }
  // 先看是否點到家具 → 顯示資訊/可賣掉
  const f = furnitureAt(tc, tr);
  if (f) {
    emit("inspect", { c: f.c, r: f.r, defId: f.defId, rotation: f.rotation ?? 0 });
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
  <section
    class="floor-shell"
    :class="`floor-page-${floorView}`"
    :aria-label="`${activeFloorView.floor} ${activeFloorView.label}頁面`"
  >
    <header class="floor-page-header">
      <div class="floor-page-heading">
        <span>目前樓層</span>
        <h2>{{ isTenantFloor ? "🏠" : "☕" }} {{ activeFloorView.floor }} {{ activeFloorView.label }}</h2>
      </div>
      <button
        type="button"
        class="floor-page-nav"
        :aria-label="floorPageNavigation.label"
        @click="switchFloorPage"
      >
        <span class="floor-page-nav-icon">{{ floorPageNavigation.icon }}</span>
        <span>{{ floorPageNavigation.label }}</span>
        <span class="floor-page-nav-arrow" aria-hidden="true">›</span>
      </button>
    </header>
    <div :key="floorView" class="floor-wrap">
      <canvas
        ref="canvas"
        :width="canvasWidth"
        :height="canvasHeight"
        :aria-label="`${activeFloorView.floor} ${activeFloorView.label}地圖`"
        @click="onClick"
      ></canvas>
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
      <div v-if="isTenantFloor" class="lounge-tag">交誼廳</div>
      <div v-if="isTenantFloor" class="entrance-tag">🚪 大門</div>
      <div
        v-if="eventScene && isTenantFloor"
        class="event-scene"
        :class="[eventScene.venue, eventScene.layout, { cinematic: eventScene.venue === 'rooftop' || eventScene.layout === 'farewell' }]"
      >
        <div class="event-scene-title">{{ eventScene.venue === "rooftop" ? "🌇 頂樓" : "🎬 現場" }} · {{ eventScene.title }}</div>
        <div v-if="eventScene.venue === 'rooftop' || eventScene.layout === 'farewell'" class="event-actors">
          <div v-for="actor in eventScene.actors" :key="actor.tenantId" class="event-actor">
            <span class="pixel-person" :style="actorStyle(actor)">
              <i class="hair"></i><i class="head"></i><i class="body"></i><i class="legs"></i>
            </span>
            <span>{{ actor.name }}</span>
          </div>
        </div>
        <div v-if="eventScene.venue === 'rooftop'" class="roof-rail"></div>
        <div v-if="eventScene.layout === 'farewell'" class="party-decor">🎈　✨　🎉　✨　🎈</div>
      </div>
      <!-- 跟著人走的名字標籤 -->
      <div v-for="tag in agentTags" :key="tag.id" class="agent-tag" :style="{ left: tag.left, top: tag.top, borderColor: tag.color }">
        {{ tag.name }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.floor-shell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.floor-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 9px;
  background: rgba(36, 31, 51, 0.78);
  border: 1px solid var(--line);
  border-radius: 10px;
  line-height: 1.2;
}
.floor-page-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.floor-page-heading > span {
  color: var(--text-dim);
  font-size: 9px;
  letter-spacing: 1px;
}
.floor-page-heading h2 {
  margin: 0;
  color: #fff4df;
  font-size: 13px;
  white-space: nowrap;
}
.floor-page-nav {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 5px;
  min-height: 38px;
  padding: 6px 8px;
  color: #fff4df;
  background: rgba(255, 180, 94, 0.14);
  border: 1px solid rgba(255, 180, 94, 0.62);
  border-radius: 8px;
  cursor: pointer;
  font-size: 10px;
  text-align: left;
}
.floor-page-nav:hover {
  background: rgba(255, 180, 94, 0.22);
}
.floor-page-nav-icon { font-size: 14px; }
.floor-page-nav-arrow { color: var(--accent); font-size: 18px; line-height: 1; }
.floor-page-1f .floor-page-header {
  background: linear-gradient(135deg, rgba(62, 45, 50, 0.92), rgba(36, 31, 51, 0.82));
  border-color: rgba(255, 180, 94, 0.42);
}
.floor-wrap {
  position: relative;
  line-height: 0;
  animation: floor-page-enter 160ms ease-out;
}
@keyframes floor-page-enter {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .floor-wrap { animation: none; }
}
.event-scene {
  position: absolute;
  z-index: 8;
  left: 50%;
  top: 27%;
  transform: translateX(-50%);
  max-width: 88%;
  padding: 5px 9px;
  border: 1px solid rgba(238, 190, 111, 0.7);
  border-radius: 8px;
  background: rgba(20, 17, 28, 0.88);
  color: #ffe9bc;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  line-height: 1.25;
}
.event-scene-title { font-size: 10px; font-weight: 700; white-space: nowrap; text-align: center; }
.event-scene.cinematic {
  top: 4%;
  width: 74%;
  min-height: 58px;
  padding: 7px 10px 8px;
  overflow: hidden;
}
.event-scene.rooftop {
  border-color: rgba(247, 176, 94, 0.8);
  background: linear-gradient(#584f85 0%, #c47a66 58%, #20233c 59%, #141522 100%);
}
.event-scene.farewell {
  top: 29%;
  background: linear-gradient(180deg, rgba(76, 45, 75, 0.96), rgba(31, 24, 38, 0.96));
}
.event-actors { display: flex; justify-content: center; align-items: flex-end; gap: 8px; margin-top: 7px; }
.event-actor { display: flex; flex-direction: column; align-items: center; gap: 2px; color: #fff8e8; font-size: 8px; }
.pixel-person { position: relative; display: block; width: 12px; height: 22px; image-rendering: pixelated; }
.pixel-person i { position: absolute; display: block; }
.pixel-person .hair { left: 2px; top: 0; width: 8px; height: 5px; background: var(--actor-hair); border-radius: 2px 2px 0 0; }
.pixel-person .head { left: 3px; top: 4px; width: 6px; height: 5px; background: var(--actor-skin); }
.pixel-person .body { left: 2px; top: 9px; width: 8px; height: 8px; background: var(--actor-shirt); }
.pixel-person .legs { left: 3px; top: 17px; width: 6px; height: 5px; background: var(--actor-pants); border-left: 2px solid rgba(10, 10, 15, 0.35); }
.roof-rail { height: 2px; margin: 3px -10px -5px; background: #c7b792; box-shadow: 0 3px 0 #6b5f57; }
.party-decor { position: absolute; inset: 27px 0 auto; text-align: center; font-size: 9px; opacity: 0.9; }
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

.agent-tag {
  position: absolute;
  transform: translate(-50%, -100%);
  pointer-events: none;
  font-size: 9.5px;
  line-height: 1.2;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(13, 12, 18, 0.72);
  border: 1px solid;
  color: #f2ecf7;
  white-space: nowrap;
  z-index: 2;
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
