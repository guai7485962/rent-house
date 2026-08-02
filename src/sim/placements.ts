/**
 * 動態家具擺放狀態(單一可變來源)。
 *
 * 原本家具是寫死的常數;經濟系統要能買/擺/移除,所以改成 reactive 陣列 +
 * 變更版本號。渲染(floorScene)、尋路(pathfind)、作息(routine)全部改讀
 * getPlacements();障礙格靠 version 快取,家具一變就重算。
 *
 * 放在獨立模組避免 store ↔ routine 的循環依賴。
 */
import { reactive } from "vue";
import { INITIAL_PLACEMENTS, ROOM_RECTS, FACILITY_RECTS, buildGrid, type Placement } from "../floor/map";
import { getDef } from "../furniture/catalog";
import { normalizeRotation, rotateGridOffset, rotatedFootprint, type FurnitureRotation } from "../furniture/rotation";
import { upgradeAttributes } from "./upgrades";
import type { RoomAttribute } from "../types";

export const ROOM_ATTRIBUTES: RoomAttribute[] = ["tech", "cozy", "noise", "soundproof", "storage", "style"];

export const placements = reactive({
  list: INITIAL_PLACEMENTS.map((p) => ({ ...p })) as Placement[],
  version: 0,
});

export function getPlacements(): Placement[] {
  return placements.list;
}

export function addPlacement(p: Placement) {
  placements.list.push({ ...p, rotation: normalizeRotation(p.rotation) });
  placements.version++;
}

export function placementRotation(p: Placement): FurnitureRotation {
  return normalizeRotation(p.rotation);
}

export function placementFootprint(p: Placement): { w: number; h: number } {
  return rotatedFootprint(getDef(p.defId), placementRotation(p));
}

export function placementInteract(p: Placement): { c: number; r: number } {
  const def = getDef(p.defId);
  const off = rotateGridOffset(def.interact, def.footprint, placementRotation(p));
  return { c: p.c + off.dc, r: p.r + off.dr };
}

/** 查詢某格上是哪一件家具(涵蓋其佔位範圍);沒有回傳 null */
export function furnitureAt(c: number, r: number): Placement | null {
  for (let i = placements.list.length - 1; i >= 0; i--) {
    const p = placements.list[i];
    const fp = placementFootprint(p);
    if (c >= p.c && c < p.c + fp.w && r >= p.r && r < p.r + fp.h) return p;
  }
  return null;
}

export function removePlacementAt(c: number, r: number): Placement | null {
  const idx = placements.list.findIndex((p) => {
    const fp = placementFootprint(p);
    return c >= p.c && c < p.c + fp.w && r >= p.r && r < p.r + fp.h;
  });
  if (idx < 0) return null;
  const [removed] = placements.list.splice(idx, 1);
  placements.version++;
  return removed;
}

/** 只移除命中格上的紀念物；不會誤刪同格或跨格覆蓋的一般家具。 */
export function removeMemorialPlacementAt(c: number, r: number): Placement | null {
  let idx = -1;
  for (let i = placements.list.length - 1; i >= 0; i--) {
    const p = placements.list[i];
    if (!p.memorial) continue;
    const fp = placementFootprint(p);
    if (c >= p.c && c < p.c + fp.w && r >= p.r && r < p.r + fp.h) { idx = i; break; }
  }
  if (idx < 0) return null;
  const [removed] = placements.list.splice(idx, 1);
  placements.version++;
  return removed;
}

/** 某房間由家具累積出的屬性總和(疊加一次性升級改建的永久加成) */
export function roomAttributes(roomId: string): Partial<Record<RoomAttribute, number>> {
  const totals: Partial<Record<RoomAttribute, number>> = { ...upgradeAttributes(roomId) };
  for (const p of placements.list) {
    if (p.room !== roomId) continue;
    const def = getDef(p.defId);
    for (const [k, v] of Object.entries(def.attributes)) {
      totals[k as RoomAttribute] = (totals[k as RoomAttribute] ?? 0) + (v ?? 0);
    }
  }
  return totals;
}

/** 房間矩形(套房或設施) */
export function roomRect(roomId: string) {
  return ROOM_RECTS[roomId] ?? FACILITY_RECTS[roomId] ?? null;
}

/** 在房間內找一塊 w×h 的空位(不壓到牆與現有家具);找不到回傳 null */
export function findFreeSlot(roomId: string, w: number, h: number): { c: number; r: number } | null {
  const rect = roomRect(roomId);
  if (!rect) {
    // lounge 沒有單一矩形,用 region 掃全圖
    return findFreeSlotByRegion(roomId, w, h);
  }
  const grid = buildGrid();
  const occ = occupiedSet();
  for (let r = rect.r0; r + h - 1 <= rect.r1; r++) {
    for (let c = rect.c0; c + w - 1 <= rect.c1; c++) {
      if (fits(c, r, w, h, roomId, grid, occ)) return { c, r };
    }
  }
  return null;
}

function findFreeSlotByRegion(roomId: string, w: number, h: number): { c: number; r: number } | null {
  const grid = buildGrid();
  const occ = occupiedSet();
  for (let r = 0; r + h - 1 < grid.length; r++) {
    for (let c = 0; c + w - 1 < grid[0].length; c++) {
      if (fits(c, r, w, h, roomId, grid, occ)) return { c, r };
    }
  }
  return null;
}

function occupiedSet(exclude?: { c: number; r: number }): Set<string> {
  const occ = new Set<string>();
  for (const p of placements.list) {
    if (exclude && p.c === exclude.c && p.r === exclude.r) continue; // 移動判定:自己的舊佔位不算擋路
    const fp = placementFootprint(p);
    for (let dr = 0; dr < fp.h; dr++)
      for (let dc = 0; dc < fp.w; dc++) occ.add(`${p.c + dc},${p.r + dr}`);
  }
  return occ;
}

// 樓梯與兩個出入口刻意排除，避免自由擺放堵住跨樓層唯一動線。
const FLOOR_REGIONS = new Set([
  "r301", "r302", "r303", "r304", "lounge", "bathroom", "laundry",
  "cafe_floor", "cafe_counter", "cafe_pet", "cafe_back",
]);

/**
 * 自由擺放判定:footprint 是否能放在 (c,r)(全部落在同一個房間地板、不壓牆、不重疊)。
 * 可放回傳該區房間 id(供記錄家具屬於哪間);不可放回傳 null。
 * exclude:移動既有家具時傳原位左上角,判定時跳過它自己的佔位。
 */
export function canPlaceFree(c: number, r: number, w: number, h: number, exclude?: { c: number; r: number }): string | null {
  const grid = buildGrid();
  const region = grid[r]?.[c];
  if (!region || !FLOOR_REGIONS.has(region)) return null;
  const occ = occupiedSet(exclude);
  if (!fits(c, r, w, h, region, grid, occ)) return null;
  return region;
}

// ---------------------------------------------------------------------------
// 一樓寵物咖啡廳:開張贈品與氛圍點數
// ---------------------------------------------------------------------------

/** 一樓咖啡廳的四個可擺放區域(`floor/map.ts` 的 `CAFE_RECTS` 去掉樓梯與店門)。 */
export const CAFE_PLACEMENT_REGIONS = ["cafe_floor", "cafe_counter", "cafe_pet", "cafe_back"] as const;
const CAFE_PLACEMENT_REGION_SET: ReadonlySet<string> = new Set(CAFE_PLACEMENT_REGIONS);

/**
 * 開張時免費送的基本配置(吧台 + 三組桌椅)。
 *
 * ### 為什麼寫死座標而不是用 `findFreeSlot()` 自動找位
 *
 * 自動找位是 row-major 掃描,會把十件家具全部擠在主廳左上角,看起來像倉庫不像店面。
 * 這份座標是照設計文件 §3 的分區手排的,且滿足三個硬條件:
 *
 * 1. **不碰中央走道 c7 / c8** —— 那是樓梯↔店門的唯一動線(`guestAgents.ts:66` 也刻意跳過)。
 * 2. **不佔 `CAFE_GUEST_PREFERRED_SEATS` 的六格**(`floor/guestAgents.ts:19`),
 *    顧客才會照原本的偏好序坐在桌邊,而不是被擠去 fallback 掃描的角落。
 * 3. 每件椅子的 interact 站立格都留空,`routine.standingTile()` 第一輪就命中。
 *
 * 座標的合法性不靠人工保證:`placeCafeStarterSet()` 一律過 `canPlaceFree()`,
 * `scripts/cafe-furniture-test.ts` 也逐件重驗。
 */
export const CAFE_STARTER_PLACEMENTS: readonly { defId: string; c: number; r: number }[] = [
  { defId: "cafe_counter", c: 3, r: 38 },      // 點餐吧台(cafe_counter 區)
  { defId: "cafe_table", c: 2, r: 43 },        // 左側第一桌
  { defId: "cafe_chair_front", c: 1, r: 43 },
  { defId: "cafe_chair_side", c: 3, r: 43 },
  { defId: "cafe_table", c: 2, r: 45 },        // 左側第二桌
  { defId: "cafe_chair_front", c: 1, r: 45 },
  { defId: "cafe_chair_side", c: 3, r: 45 },
  { defId: "cafe_table", c: 11, r: 36 },       // 靠樓梯側的窗邊桌
  { defId: "cafe_chair_front", c: 10, r: 36 },
  { defId: "cafe_chair_side", c: 12, r: 36 },
];

/**
 * 擺上開張贈品。**免費**(不碰金流)、**只在開張成功那一刻呼叫一次**
 * (`CafePanel.onOpen` → `openCafe()` 成功;`openCafe()` 本身會擋重複開張)。
 *
 * 冪等性靠的是呼叫點而不是這裡的判斷:本函式沒有「已經送過了」的旗標,
 * 因為存檔往返不會重跑它,玩家事後搬走/賣掉家具也不會重跑它。
 * 每件都先過 `canPlaceFree()`,擋到就整件跳過 —— 絕不覆蓋玩家既有的擺放。
 *
 * @returns 實際擺上的件數清單(給 UI 講「已免費擺上 N 件」)。
 */
export function placeCafeStarterSet(): Placement[] {
  const placed: Placement[] = [];
  for (const seed of CAFE_STARTER_PLACEMENTS) {
    const def = getDef(seed.defId);
    const fp = rotatedFootprint(def, 0);
    const room = canPlaceFree(seed.c, seed.r, fp.w, fp.h);
    if (!room) continue;
    const p: Placement = { defId: seed.defId, room, c: seed.c, r: seed.r, rotation: 0 };
    addPlacement(p);
    placed.push(p);
  }
  return placed;
}

/**
 * 一樓四個咖啡廳區域裡,玩家實際擺著的家具的 `cozy + style` 總和。
 *
 * 這是「氛圍加成」的唯一輸入(`sim/cafe.ts` 的 `cafeAmbianceMultiplier()`)。
 * 只讀 `placements`,不讀 `upgrades`(五項永久投資走的是 `cafeCapability()` 那條路,
 * 兩者刻意不互相灌水);負值屬性夾成 0,免得未來有家具用負 cozy 做「髒亂」時
 * 把氛圍拉成負數。
 */
export function cafeAmbiancePoints(): number {
  let points = 0;
  for (const p of placements.list) {
    if (!CAFE_PLACEMENT_REGION_SET.has(p.room)) continue;
    const attrs = getDef(p.defId).attributes;
    points += Math.max(0, attrs.cozy ?? 0) + Math.max(0, attrs.style ?? 0);
  }
  return points;
}

function fits(c: number, r: number, w: number, h: number, roomId: string, grid: string[][], occ: Set<string>) {
  for (let dr = 0; dr < h; dr++)
    for (let dc = 0; dc < w; dc++) {
      const cc = c + dc;
      const rr = r + dr;
      if (grid[rr]?.[cc] !== roomId) return false;
      if (occ.has(`${cc},${rr}`)) return false;
    }
  return true;
}
