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

const FLOOR_REGIONS = new Set(["r301", "r302", "r303", "r304", "lounge", "bathroom", "laundry"]);

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
