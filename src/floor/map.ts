/**
 * 樓層網格地圖資料(正俯視 tile grid,類星露谷)
 *
 * 核心原則:一切嚴格對齊 TILE 網格。
 * - 角色佔位 1×1
 * - 家具佔位為整數格(1×1 / 2×1 / 2×2 …),佔用格 walkable=false
 * - 每件家具有 interact 站立點(walkable=true),供日後尋路使用
 *
 * 格局(直式,可上下捲動):
 *   [ 301 ][走廊][ 302 ]
 *   [ ---- 中央交誼廳 ---- ]
 *   [ 303 ][走廊][ 304 ]
 *   [ 廁所浴室 ][走廊][ 洗衣晾衣間 ]   ← 共用設施
 *              [ 大門 ]
 */

export const TILE = 16;
export const GRID_W = 16;
export const GRID_H = 33;

export type Region =
  | "outside"
  | "wall"
  | "r301"
  | "r302"
  | "r303"
  | "r304"
  | "bathroom"
  | "laundry"
  | "lounge"
  | "door"
  | "entrance";

interface Rect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** 四間套房的地板範圍(含邊界,inclusive) */
export const ROOM_RECTS: Record<string, Rect> = {
  r301: { c0: 1, r0: 1, c1: 5, r1: 7 },
  r302: { c0: 10, r0: 1, c1: 14, r1: 7 },
  r303: { c0: 1, r0: 16, c1: 5, r1: 22 },
  r304: { c0: 10, r0: 16, c1: 14, r1: 22 },
};

/** 共用設施(廁所浴室 / 洗衣晾衣間)—— 位於最底層 */
export const FACILITY_RECTS: Record<string, Rect> = {
  bathroom: { c0: 1, r0: 24, c1: 5, r1: 30 },
  laundry: { c0: 10, r0: 24, c1: 14, r1: 30 },
};

/** 交誼廳 = 中央縱向走廊 + 中段橫向大廳 */
const LOUNGE_RECTS: Rect[] = [
  { c0: 7, r0: 1, c1: 8, r1: 31 }, // 縱向走廊(貫穿上下到大門)
  { c0: 1, r0: 9, c1: 14, r1: 14 }, // 橫向大廳(沙發+共用廚房)
];

/** 房內隔間牆(乾濕分離等)—— 在區域填完後覆蓋為牆 */
const PARTITIONS: Rect[] = [
  { c0: 1, r0: 27, c1: 5, r1: 27 }, // 浴室:上淋浴間 / 下馬桶間 的隔間牆
];

/** 房間通往走廊的門(牆上的開口) */
const DOORS: Array<{ c: number; r: number }> = [
  { c: 6, r: 4 }, // 301 → 走廊
  { c: 9, r: 4 }, // 302 → 走廊
  { c: 6, r: 19 }, // 303 → 走廊
  { c: 9, r: 19 }, // 304 → 走廊
  { c: 6, r: 25 }, // 浴室 · 淋浴間 → 走廊
  { c: 6, r: 29 }, // 浴室 · 馬桶間 → 走廊
  { c: 9, r: 27 }, // 洗衣晾衣間 → 走廊
];

/** 大門(樓層出入口,最底) */
const ENTRANCE: Array<{ c: number; r: number }> = [
  { c: 7, r: 32 },
  { c: 8, r: 32 },
];

function inRect(c: number, r: number, box: Rect) {
  return c >= box.c0 && c <= box.c1 && r >= box.r0 && r <= box.r1;
}

/** 產生完整區域網格 */
export function buildGrid(): Region[][] {
  const grid: Region[][] = [];
  for (let r = 0; r < GRID_H; r++) {
    const row: Region[] = [];
    for (let c = 0; c < GRID_W; c++) {
      let cell: Region = "wall";
      for (const [id, box] of Object.entries(ROOM_RECTS)) {
        if (inRect(c, r, box)) cell = id as Region;
      }
      for (const [id, box] of Object.entries(FACILITY_RECTS)) {
        if (inRect(c, r, box)) cell = id as Region;
      }
      for (const box of LOUNGE_RECTS) {
        if (inRect(c, r, box)) cell = "lounge";
      }
      for (const box of PARTITIONS) {
        if (inRect(c, r, box)) cell = "wall";
      }
      row.push(cell);
    }
    grid.push(row);
  }
  for (const d of DOORS) grid[d.r][d.c] = "door";
  for (const e of ENTRANCE) grid[e.r][e.c] = "entrance";
  return grid;
}

export function isWalkable(cell: Region) {
  return cell !== "wall" && cell !== "outside";
}

// ---------------------------------------------------------------------------
// 家具擺放(只放「目錄 id + 座標」;佔位/外觀/互動點全部由 catalog.ts 查)
// 這就是「單一資料來源」的關鍵:新增/換家具只改 defId,不動這裡的結構。
// ---------------------------------------------------------------------------

export interface Placement {
  defId: string; // 對應 catalog.ts 的 FurnitureDef.id
  room: string;
  c: number; // 左上角格座標
  r: number;
  /** 順時針旋轉角度；舊存檔缺欄位視為 0。 */
  rotation?: 0 | 90 | 180 | 270;
}

/** 開場預設家具(動態家具狀態的種子;之後由 sim/placements.ts 管理可變副本) */
export const INITIAL_PLACEMENTS: Placement[] = [
  // ---- 301 陳家豪(工作狂 / 夜貓 / 養貓)----
  { defId: "single_bed", room: "r301", c: 1, r: 1 },
  { defId: "gaming_desk", room: "r301", c: 4, r: 1 },
  { defId: "beanbag", room: "r301", c: 4, r: 3 },
  { defId: "tv_console", room: "r301", c: 3, r: 6 },
  { defId: "cat_tower", room: "r301", c: 1, r: 6 },

  // ---- 302 林小婕(實況主 / 聲音敏感 / 自律)----
  { defId: "single_bed", room: "r302", c: 13, r: 1 },
  { defId: "mic_desk", room: "r302", c: 10, r: 1 },
  { defId: "floor_lamp", room: "r302", c: 12, r: 3 },
  { defId: "aroma", room: "r302", c: 10, r: 6 },
  { defId: "plant", room: "r302", c: 11, r: 7 },
  { defId: "bookshelf", room: "r302", c: 14, r: 6 },

  // ---- 303 / 304 空房(招租中,基本床)----
  { defId: "single_bed", room: "r303", c: 1, r: 16 },
  { defId: "single_bed", room: "r304", c: 13, r: 16 },

  // ---- 中央交誼廳:廚房群 ----
  { defId: "fridge", room: "lounge", c: 1, r: 9 },
  { defId: "stove", room: "lounge", c: 2, r: 9 },
  { defId: "counter", room: "lounge", c: 3, r: 9 },
  { defId: "coffee_machine", room: "lounge", c: 5, r: 9 },
  { defId: "lounge_plant", room: "lounge", c: 6, r: 9 },
  { defId: "dining_table", room: "lounge", c: 2, r: 11 },
  { defId: "washing_machine", room: "lounge", c: 5, r: 12 },

  // ---- 中央交誼廳:客廳群(社交點)----
  { defId: "lounge_rug", room: "lounge", c: 9, r: 11 },
  { defId: "lounge_tv", room: "lounge", c: 10, r: 9 },
  { defId: "bar_counter", room: "lounge", c: 13, r: 9 },
  { defId: "coffee_table", room: "lounge", c: 11, r: 12 },
  { defId: "shared_sofa", room: "lounge", c: 10, r: 13 },
  { defId: "entrance_mat", room: "lounge", c: 7, r: 31 },

  // ---- 廁所 + 浴室(乾濕分離,cols1-5)----
  // 淋浴間(rows24-26,濕區)
  { defId: "shower", room: "bathroom", c: 1, r: 24 },
  { defId: "bath_plant", room: "bathroom", c: 5, r: 24 },
  // 馬桶間(rows28-30,乾區)
  { defId: "toilet", room: "bathroom", c: 1, r: 28 },
  { defId: "bath_sink", room: "bathroom", c: 4, r: 28 },

  // ---- 洗衣晾衣間(cols10-14, rows24-30)----
  { defId: "laundry_washer", room: "laundry", c: 10, r: 24 },
  { defId: "laundry_washer", room: "laundry", c: 11, r: 24 },
  { defId: "drying_rack", room: "laundry", c: 13, r: 24 },
  { defId: "utility_sink", room: "laundry", c: 10, r: 29 },
  { defId: "laundry_basket", room: "laundry", c: 12, r: 30 },
];

// ---------------------------------------------------------------------------
// 房間資訊(給 DOM 標籤 + 點擊命中判定)
// ---------------------------------------------------------------------------

export interface RoomInfo {
  id: string;
  label: string;
  /** tenant = 出租套房;facility = 共用設施 */
  type: "tenant" | "facility";
  tenantId: string | null;
  tenantName: string;
  occupied: boolean;
  rect: Rect;
}

export const ROOM_INFO: RoomInfo[] = [
  { id: "r301", label: "301", type: "tenant", tenantId: "tenant_chen_engineer", tenantName: "陳家豪", occupied: true, rect: ROOM_RECTS.r301 },
  { id: "r302", label: "302", type: "tenant", tenantId: "tenant_lin_asmr", tenantName: "林小婕", occupied: true, rect: ROOM_RECTS.r302 },
  { id: "r303", label: "303", type: "tenant", tenantId: null, tenantName: "招租中", occupied: false, rect: ROOM_RECTS.r303 },
  { id: "r304", label: "304", type: "tenant", tenantId: null, tenantName: "招租中", occupied: false, rect: ROOM_RECTS.r304 },
  { id: "bathroom", label: "🚿", type: "facility", tenantId: null, tenantName: "廁所 · 浴室", occupied: true, rect: FACILITY_RECTS.bathroom },
  { id: "laundry", label: "🧺", type: "facility", tenantId: null, tenantName: "洗衣晾衣間", occupied: true, rect: FACILITY_RECTS.laundry },
];

/** 租客在樓層上的站立格(系統未做前為靜態預設點) */
export const TENANT_SPOTS: Array<{ tenantId: string; c: number; r: number }> = [
  { tenantId: "tenant_chen_engineer", c: 3, r: 4 },
  { tenantId: "tenant_lin_asmr", c: 11, r: 4 },
];
