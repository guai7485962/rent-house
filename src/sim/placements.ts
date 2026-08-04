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
import { INITIAL_PLACEMENTS, ROOM_RECTS, FACILITY_RECTS, CAFE_RECTS, buildGrid, isWalkable, type Placement } from "../floor/map";
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
  const placed = starterPlacementsAgainst(placements.list);
  for (const p of placed) addPlacement(p);
  return placed;
}

/**
 * 算出「在 `existing` 這批擺放之下,贈品組還有哪幾件放得進去」——**不碰模組狀態**。
 *
 * 存在的理由:`placeCafeStarterSet()` 只在按下開張的那一刻跑一次,
 * 所以**在本功能上線前就已經開張的舊存檔永遠拿不到贈品,咖啡廳會永遠是空的**
 * (2026-08-03 使用者實玩回報)。補救要在 `persistence.ts` 的 v6 → v7 升級裡做,
 * 而升級是在 `placements.list` 還原**之前**對序列化存檔動手,那時模組狀態還是舊的
 * ⇒ 不能直接用讀模組的 `canPlaceFree()`,必須吃外部清單。
 */
export function starterPlacementsAgainst(existing: readonly Placement[]): Placement[] {
  const grid = buildGrid();
  const occ = new Set<string>();
  for (const p of existing) {
    const fp = placementFootprint(p);
    for (let dr = 0; dr < fp.h; dr++)
      for (let dc = 0; dc < fp.w; dc++) occ.add(`${p.c + dc},${p.r + dr}`);
  }
  const placed: Placement[] = [];
  for (const seed of CAFE_STARTER_PLACEMENTS) {
    const fp = rotatedFootprint(getDef(seed.defId), 0);
    const region = grid[seed.r]?.[seed.c];
    if (!region || !FLOOR_REGIONS.has(region)) continue;
    if (!fits(seed.c, seed.r, fp.w, fp.h, region, grid, occ)) continue;
    placed.push({ defId: seed.defId, room: region, c: seed.c, r: seed.r, rotation: 0 });
    // 同一批內後面的件數也要看得到前面剛放的,否則會互相重疊
    for (let dr = 0; dr < fp.h; dr++)
      for (let dc = 0; dc < fp.w; dc++) occ.add(`${seed.c + dc},${seed.r + dr}`);
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
// ---------------------------------------------------------------------------
// P2:席次與吧台一律「查玩家實際擺的家具」,不再有硬編座位表
// ---------------------------------------------------------------------------

interface SeatTile { c: number; r: number }

/**
 * 一個內用席位:顧客**坐著的格**與他**走得到的格**。
 *
 * `seat: "on"`(椅子)的家具格本身是障礙,尋路走不進去 ⇒ `stand` 是它的互動格,
 * 畫面再把坐姿畫到 `seat` 上(同 `agents.ts` 對沙發/床的作法)。
 * `seat: "at"`(圓桌)本來就是坐在家具前面 ⇒ 兩者同一格。
 */
export interface CafeSeatSpot {
  seat: SeatTile;
  stand: SeatTile;
  defId: string;
}

const seatKey = (t: SeatTile) => `${t.c},${t.r}`;

/**
 * 🔴 內用席次 = 一樓四區裡 `seat` 欄位不為空的家具(設計文件 §4.6)。
 *
 * 取代 P1 之前 `floor/guestAgents.ts` 的硬編 `CAFE_GUEST_PREFERRED_SEATS`——
 * 那張表正是「顧客站在空地板上」的根因(開張贈品刻意避開那六格)。
 * 現在顧客坐在玩家真的買、真的擺的椅子上;拆掉椅子不會壞,只是席次變少
 * ⇒ 更多人只能外帶。**沒有任何 UI 鎖定邏輯。**
 *
 * 回傳序固定為 (r, c, defId),與呼叫次序無關 ⇒ 席次分配是決定性的。
 */
export function cafeSeatSpots(): CafeSeatSpot[] {
  const grid = buildGrid();
  const occ = occupiedSet();
  const walkable = (c: number, r: number) => {
    const cell = grid[r]?.[c];
    return !!cell && isWalkable(cell) && !occ.has(`${c},${r}`);
  };
  // 🔴 只認「顧客真的走得到」的到達格。實測過:開張贈品的左側椅子,它的互動格
  // (1,44)被自己那張圓桌與另一張椅子圍成死角,可走但走不到——顧客會永遠卡住。
  const reachable = cafeReachableTiles(walkable);
  const usable = (c: number, r: number) => walkable(c, r) && reachable.has(`${c},${r}`);
  const spots: CafeSeatSpot[] = [];
  const usedSeat = new Set<string>();
  const usedStand = new Set<string>();
  const seatFurniture = placements.list
    .filter((p) => CAFE_PLACEMENT_REGION_SET.has(p.room) && !!getDef(p.defId).seat)
    .sort((a, b) => a.r - b.r || a.c - b.c || a.defId.localeCompare(b.defId));
  for (const p of seatFurniture) {
    const def = getDef(p.defId);
    const interact = placementInteract(p);
    const stand = usable(interact.c, interact.r) ? { c: interact.c, r: interact.r } : ringUsable(p, usable);
    if (!stand) continue; // 椅子被家具圍死 ⇒ 這張不算席次(不硬塞、不穿牆)
    const seat = def.seat === "on" ? { c: p.c, r: p.r } : { ...stand };
    if (usedSeat.has(seatKey(seat)) || usedStand.has(seatKey(stand))) continue;
    usedSeat.add(seatKey(seat));
    usedStand.add(seatKey(stand));
    spots.push({ seat, stand, defId: p.defId });
  }
  return spots;
}

/**
 * 從店門(`cafe_entrance`)泛洪出來的可達格集合。
 *
 * 刻意自己寫一次 BFS 而不是借 `floor/pathfind.ts`:那支檔案 import 本檔,
 * 反向 import 會變成循環相依。範圍只有一樓 16×52 的網格,成本可以忽略。
 */
function cafeReachableTiles(walkable: (c: number, r: number) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue: SeatTile[] = [];
  const door = CAFE_RECTS.cafe_entrance;
  for (let c = door.c0; c <= door.c1; c++) {
    if (!walkable(c, door.r0)) continue;
    seen.add(`${c},${door.r0}`);
    queue.push({ c, r: door.r0 });
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const c = cur.c + dc;
      const r = cur.r + dr;
      const key = `${c},${r}`;
      if (seen.has(key) || !walkable(c, r)) continue;
      seen.add(key);
      queue.push({ c, r });
    }
  }
  return seen;
}

/** 家具外圈第一個「可走且走得到」的格(固定掃描序);全被擋住回 null。 */
function ringUsable(p: Placement, usable: (c: number, r: number) => boolean): SeatTile | null {
  const fp = placementFootprint(p);
  for (let dr = -1; dr <= fp.h; dr++) {
    for (let dc = -1; dc <= fp.w; dc++) {
      if (dc >= 0 && dc < fp.w && dr >= 0 && dr < fp.h) continue;
      const c = p.c + dc;
      const r = p.r + dr;
      if (usable(c, r)) return { c, r };
    }
  }
  return null;
}

/** 開張贈品的吧台座標(設計文件 §4.9);沒擺吧台時的點餐位就以此格前方推算。 */
export const CAFE_COUNTER_TILE: SeatTile = { c: 3, r: 38 };

/**
 * 點餐位:吧台**前方**那一排可走格(顧客站這裡點餐)。
 *
 * 多於一格是刻意的——同一小時會有好幾位顧客一起進來,只有一格會互相卡死。
 * 位置一律由 `placements` 推算,玩家把吧台搬走,點餐位就跟著搬。
 */
export function cafeCounterSpots(): SeatTile[] {
  const grid = buildGrid();
  const occ = occupiedSet();
  const walkable = (c: number, r: number) => {
    const cell = grid[r]?.[c];
    return !!cell && isWalkable(cell) && !occ.has(`${c},${r}`);
  };
  const counter = placements.list
    .filter((p) => CAFE_PLACEMENT_REGION_SET.has(p.room) && p.defId === "cafe_counter")
    .sort((a, b) => a.r - b.r || a.c - b.c)[0];
  const spots: SeatTile[] = [];
  if (counter) {
    const fp = placementFootprint(counter);
    const front = placementInteract(counter);
    // 由互動格往兩側展開,序固定:互動格 → 右 → 左 → 更右 → 更左
    const columns = [front.c];
    for (let d = 1; d <= fp.w; d++) { columns.push(front.c + d); columns.push(front.c - d); }
    for (const c of columns) if (walkable(c, front.r)) spots.push({ c, r: front.r });
  }
  if (spots.length > 0) return spots;
  // 沒擺吧台(玩家拆了/舊存檔):退回吧台區 row-major 第一格可走地板,行為不崩。
  const box = CAFE_RECTS.cafe_counter;
  for (let r = box.r0; r <= box.r1; r++) {
    for (let c = box.c0; c <= box.c1; c++) if (walkable(c, r)) return [{ c, r }];
  }
  return [{ ...CAFE_COUNTER_TILE }];
}

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
