/** LimeZu 家具/地板 atlas 的預載、映射、manifest 一致性與程序繪圖 fallback 回歸。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LIMEZU_FURNITURE_IDS,
  LIMEZU_FURNITURE_FRAMES,
  LIMEZU_FLOOR_ROOM_IDS,
  LIMEZU_FLOOR_FRAMES,
  LIMEZU_WALL_PIECE_IDS,
  LIMEZU_WALL_FRAMES,
  preloadLimezuFurnitureAtlas,
  preloadLimezuFloorAtlas,
  preloadLimezuWallAtlas,
  resetLimezuFurnitureAtlasForTests,
  resetLimezuFloorAtlasForTests,
  resetLimezuWallAtlasForTests,
  tryDrawLimezuFurniture,
  tryDrawLimezuFloor,
  tryDrawLimezuWallPiece,
} from "../src/art/limezu";
import { getDef } from "../src/furniture/catalog";
import { drawDef } from "../src/furniture/render";
import { composeFloor } from "../src/floor/floorScene";
import { TILE, ROOM_RECTS, FACILITY_RECTS, LOUNGE_HALL_RECT, buildGrid } from "../src/floor/map";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// ---------------------------------------------------------------------------
// 靜態資產與 manifest 一致性
// ---------------------------------------------------------------------------

const APPROVED_IDS = [
  "single_bed", "gaming_desk", "wardrobe", "dresser", "floor_lamp", "plant", "bath_plant",
  "tv_console", "lounge_tv", "fridge", "stove", "counter", "coffee_machine", "dining_table",
  "toilet", "shower", "washing_machine", "laundry_washer",
  "shared_sofa", "loveseat", "lounge_plant", "wood_chair", "coffee_table",
] as const;
/** 仍走程序繪圖的手繪件(furniture-art-test.ts 鎖住指紋的三件中,tv_console 已轉入白名單)。 */
const PROCEDURAL_IDS = ["beanbag", "cat_tower"] as const;
/** 選件時因寬度/朝向/尺寸規則跳過的 id:絕不可誤入白名單。 */
const SKIPPED_IDS = ["double_bed", "bookshelf", "bathtub", "bath_sink", "lounge_rug"] as const;

interface ManifestFurniture {
  source?: string;
  crop?: [number, number, number, number];
  atlas?: [number, number];
  alias?: string;
}
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("./limezu-manifest.json", import.meta.url)), "utf8"),
) as {
  furniture_atlas: { width: number; height: number };
  furniture: Record<string, ManifestFurniture>;
  wall_atlas: { width: number; height: number };
  walls: Record<string, { source: string; crop: [number, number, number, number]; atlas: [number, number] }>;
  floor_atlas: { width: number; height: number };
  floors: Record<string, { row: number; cells: [number, number][] }>;
};

const pngSize = (rel: string) => {
  const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const atlasPng = pngSize("../public/assets/limezu/furniture.png");
const floorsPng = pngSize("../public/assets/limezu/floors.png");

check(
  "runtime 白名單 = 23 個核准 id(第一批 18 件 + Generic 第二批 5 件)",
  JSON.stringify(LIMEZU_FURNITURE_IDS) === JSON.stringify(APPROVED_IDS),
);
check(
  "跳過件(double_bed/bookshelf/bathtub/bath_sink/lounge_rug)不在白名單",
  SKIPPED_IDS.every((id) => !(LIMEZU_FURNITURE_IDS as readonly string[]).includes(id)),
);
check(
  "furniture.png 尺寸 = manifest 宣告的 128x128",
  atlasPng.width === 128 && atlasPng.height === 128
    && manifest.furniture_atlas.width === atlasPng.width
    && manifest.furniture_atlas.height === atlasPng.height,
);
check(
  "floors.png 尺寸 = manifest 宣告的 48x112",
  floorsPng.width === 48 && floorsPng.height === 112
    && manifest.floor_atlas.width === floorsPng.width
    && manifest.floor_atlas.height === floorsPng.height,
);

const frames = Object.entries(LIMEZU_FURNITURE_FRAMES);
check(
  "所有家具 frame 都在 atlas 邊界內",
  frames.every(([, f]) => f.sx >= 0 && f.sy >= 0 && f.sw > 0 && f.sh > 0
    && f.sx + f.sw <= atlasPng.width && f.sy + f.sh <= atlasPng.height),
);
// 重疊檢查:rect 完全相同視為合法共用(washing_machine / laundry_washer alias)
const overlaps = frames.some(([idA, a], index) => frames.slice(index + 1).some(([idB, b]) =>
  idA !== idB
  && !(a.sx === b.sx && a.sy === b.sy && a.sw === b.sw && a.sh === b.sh)
  && a.sx < b.sx + b.sw && a.sx + a.sw > b.sx
  && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy,
));
check("家具 frame 互不重疊(共用 alias 格除外)", !overlaps);

const resolveManifest = (id: string): ManifestFurniture | undefined => {
  const entry = manifest.furniture[id];
  if (entry?.alias) return manifest.furniture[entry.alias];
  return entry;
};
check(
  "每個白名單 id 的 frame 與 manifest 的 atlas 位置/裁切尺寸一致",
  LIMEZU_FURNITURE_IDS.every((id) => {
    const m = resolveManifest(id);
    const f = LIMEZU_FURNITURE_FRAMES[id];
    return !!m?.atlas && !!m.crop
      && m.atlas[0] === f.sx && m.atlas[1] === f.sy
      && m.crop[2] === f.sw && m.crop[3] === f.sh;
  }),
);
check(
  "dx/dy 遵守置中 + 底邊錨定規則(dx=⌊(footprint寬-sw)/2⌋,dy=footprint高-sh)",
  LIMEZU_FURNITURE_IDS.every((id) => {
    const def = getDef(id);
    const f = LIMEZU_FURNITURE_FRAMES[id];
    return f.dx === Math.floor((def.footprint.w * TILE - f.sw) / 2)
      && f.dy === def.footprint.h * TILE - f.sh;
  }),
);
check(
  "sprite 寬 ≤ footprint 寬 + 4px(選件規則)",
  LIMEZU_FURNITURE_IDS.every((id) => {
    const def = getDef(id);
    return LIMEZU_FURNITURE_FRAMES[id].sw <= def.footprint.w * TILE + 4;
  }),
);

const FLOOR_ROOMS = ["r301", "r302", "r303", "r304", "lounge", "bathroom", "laundry"] as const;
check(
  "地板房間清單 = 7 房且與 manifest floors 一致",
  JSON.stringify(LIMEZU_FLOOR_ROOM_IDS) === JSON.stringify(FLOOR_ROOMS)
    && FLOOR_ROOMS.every((room) => manifest.floors[room] !== undefined),
);
check(
  "每房 3 個 16x16 變體、列位對應 manifest row 且在 floors.png 邊界內",
  FLOOR_ROOMS.every((room) => {
    const row = manifest.floors[room].row;
    const fs = LIMEZU_FLOOR_FRAMES[room];
    return fs.length === 3 && fs.every((f, i) => f.sw === 16 && f.sh === 16
      && f.sx === i * 16 && f.sy === row * 16
      && f.sx + f.sw <= floorsPng.width && f.sy + f.sh <= floorsPng.height);
  }),
);
const allFloorFrames = FLOOR_ROOMS.flatMap((room) => [...LIMEZU_FLOOR_FRAMES[room]]);
const floorOverlaps = allFloorFrames.some((a, index) => allFloorFrames.slice(index + 1).some((b) =>
  a.sx < b.sx + b.sw && a.sx + a.sw > b.sx && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy,
));
check("21 個地板 frame 互不重疊", !floorOverlaps);
check(
  "r301 沿用現行三格(manifest cells = (4,13)(5,13)(6,13),row 0)",
  manifest.floors.r301.row === 0
    && JSON.stringify(manifest.floors.r301.cells) === JSON.stringify([[4, 13], [5, 13], [6, 13]]),
);

// ---------------------------------------------------------------------------
// runtime 載入 / 繪製 / fallback
// ---------------------------------------------------------------------------

class FakeCtx {
  fillStyle = "";
  globalAlpha = 1;
  fillCount = 0;
  drawCalls: unknown[][] = [];
  save() {}
  restore() { this.globalAlpha = 1; }
  fillRect() { this.fillCount++; }
  drawImage(...args: unknown[]) { this.drawCalls.push(args); }
}

const originalImage = (globalThis as any).Image;

resetLimezuFurnitureAtlasForTests();
resetLimezuFloorAtlasForTests();
delete (globalThis as any).Image;
check("Node 無 Image 時家具預載安全回傳 false", await preloadLimezuFurnitureAtlas() === false);
check("Node 無 Image 時地板預載安全回傳 false", await preloadLimezuFloorAtlas() === false);

let imageInstances = 0;
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "auto";
  private value = "";
  constructor() { imageInstances++; }
  set src(value: string) {
    this.value = value;
    queueMicrotask(() => this.onload?.());
  }
  get src() { return this.value; }
}

(globalThis as any).Image = FakeImage;
const [loadedA, loadedB] = await Promise.all([
  preloadLimezuFurnitureAtlas("/fake-atlas.png"),
  preloadLimezuFurnitureAtlas("/ignored-second-url.png"),
]);
check("家具並行預載共用同一 promise 與 Image", loadedA && loadedB && imageInstances === 1);

const atlasCtx = new FakeCtx();
const drawn = tryDrawLimezuFurniture(atlasCtx as any, "single_bed", 7, 9, 32, 32);
const bedFrame = LIMEZU_FURNITURE_FRAMES.single_bed;
const args = atlasCtx.drawCalls[0] ?? [];
check("已載入 atlas 可繪製已映射家具", drawn && atlasCtx.drawCalls.length === 1);
check(
  "drawImage 使用正確來源格位且維持 1:1 像素偏移",
  args[1] === bedFrame.sx && args[2] === bedFrame.sy && args[3] === bedFrame.sw && args[4] === bedFrame.sh
    && args[5] === 7 + bedFrame.dx && args[6] === 9 + bedFrame.dy
    && args[7] === bedFrame.sw && args[8] === bedFrame.sh,
);
check(
  "跳過件 id(double_bed)不會誤畫 atlas",
  !tryDrawLimezuFurniture(atlasCtx as any, "double_bed", 0, 0, 48, 32) && atlasCtx.drawCalls.length === 1,
);
check(
  "tv_console 本批已加入白名單且走 atlas",
  tryDrawLimezuFurniture(atlasCtx as any, "tv_console", 0, 0, 32, 16) && atlasCtx.drawCalls.length === 2,
);
check(
  "washing_machine 與 laundry_washer 共用同一 atlas 格",
  LIMEZU_FURNITURE_FRAMES.washing_machine.sx === LIMEZU_FURNITURE_FRAMES.laundry_washer.sx
    && LIMEZU_FURNITURE_FRAMES.washing_machine.sy === LIMEZU_FURNITURE_FRAMES.laundry_washer.sy,
);
const BATCH2_IDS = ["shared_sofa", "loveseat", "lounge_plant", "wood_chair", "coffee_table"] as const;
check(
  "第二批 5 件全部位於 atlas 新增的 y>=96 帶",
  BATCH2_IDS.every((id) => LIMEZU_FURNITURE_FRAMES[id].sy >= 96),
);
check(
  "shared_sofa 以 48px 全寬貼齊 3x1 footprint(dx=0、往上長 10px)",
  LIMEZU_FURNITURE_FRAMES.shared_sofa.sw === 48
    && LIMEZU_FURNITURE_FRAMES.shared_sofa.dx === 0
    && LIMEZU_FURNITURE_FRAMES.shared_sofa.dy === -10,
);
check(
  "第二批 id 已載入 atlas 時可繪製",
  BATCH2_IDS.every((id) => {
    const def = getDef(id);
    const c = new FakeCtx();
    return tryDrawLimezuFurniture(c as any, id, 0, 0, def.footprint.w * TILE, def.footprint.h * TILE)
      && c.drawCalls.length === 1;
  }),
);
check(
  "跳過件 lounge_rug 不會誤畫 atlas",
  !tryDrawLimezuFurniture(atlasCtx as any, "lounge_rug", 0, 0, 64, 48) && atlasCtx.drawCalls.length === 2,
);

for (const id of PROCEDURAL_IDS) {
  check(`${id} 不在 atlas runtime 映射`, !tryDrawLimezuFurniture(atlasCtx as any, id, 0, 0, 32, 32));
  const fallback = new FakeCtx();
  drawDef(fallback as any, getDef(id), 0, 0);
  check(`${id} 維持既有程序繪圖`, fallback.drawCalls.length === 0 && fallback.fillCount > 0);
}

const renderCtx = new FakeCtx();
drawDef(renderCtx as any, getDef("gaming_desk"), 0, 0);
check("drawDef 成功使用 atlas 時不疊加程序像素", renderCtx.drawCalls.length === 1 && renderCtx.fillCount === 0);

let warnings = 0;
const originalWarn = console.warn;
console.warn = () => { warnings++; };
class ThrowingDrawCtx extends FakeCtx {
  drawImage() { throw new Error("fake canvas draw failure"); }
}
const throwingCtx = new ThrowingDrawCtx();
drawDef(throwingCtx as any, getDef("gaming_desk"), 0, 0);
check("家具 drawImage 失敗時仍回退程序繪圖且只警告一次", throwingCtx.fillCount > 0 && warnings === 1);
console.warn = originalWarn;

resetLimezuFurnitureAtlasForTests();
const fallbackCtx = new FakeCtx();
drawDef(fallbackCtx as any, getDef("single_bed"), 0, 0);
check("atlas 未載入時完整回退既有程序繪圖", fallbackCtx.drawCalls.length === 0 && fallbackCtx.fillCount > 0);
const tvFallbackCtx = new FakeCtx();
drawDef(tvFallbackCtx as any, getDef("tv_console"), 0, 0);
check("atlas 未載入時 tv_console 仍走程序繪圖(furniture-art-test 前提)", tvFallbackCtx.drawCalls.length === 0 && tvFallbackCtx.fillCount > 0);
const sofaFallbackCtx = new FakeCtx();
drawDef(sofaFallbackCtx as any, getDef("shared_sofa"), 0, 0);
check("atlas 未載入時第二批家具(shared_sofa)完整回退程序繪圖", sofaFallbackCtx.drawCalls.length === 0 && sofaFallbackCtx.fillCount > 0);

// ---------------------------------------------------------------------------
// 地板覆蓋
// ---------------------------------------------------------------------------

resetLimezuFloorAtlasForTests();
const floorFallbackCtx = new FakeCtx();
composeFloor(floorFallbackCtx as any, 0);
check("地板 atlas 未載入時不畫圖片且程序地板仍有內容", floorFallbackCtx.drawCalls.length === 0 && floorFallbackCtx.fillCount > 0);

const floorImageInstancesBefore = imageInstances;
const [floorLoadedA, floorLoadedB] = await Promise.all([
  preloadLimezuFloorAtlas("/fake-floors.png"),
  preloadLimezuFloorAtlas("/ignored-floors.png"),
]);
check("地板並行預載共用同一 promise 與 Image", floorLoadedA && floorLoadedB && imageInstances === floorImageInstancesBefore + 1);

const oneFloorCtx = new FakeCtx();
const laundryFrame2 = LIMEZU_FLOOR_FRAMES.laundry[2];
const oneFloorDrawn = tryDrawLimezuFloor(oneFloorCtx as any, "laundry", 2, 160, 384);
const oneFloorArgs = oneFloorCtx.drawCalls[0] ?? [];
check(
  "單格地板維持 1:1 像素且取用該房正確變體",
  oneFloorDrawn && oneFloorArgs[1] === laundryFrame2.sx && oneFloorArgs[2] === laundryFrame2.sy
    && oneFloorArgs[3] === 16 && oneFloorArgs[4] === 16
    && oneFloorArgs[5] === 160 && oneFloorArgs[6] === 384
    && oneFloorArgs[7] === 16 && oneFloorArgs[8] === 16,
);
check("非法地板 variant 不繪製", !tryDrawLimezuFloor(oneFloorCtx as any, "laundry", 3, 0, 0) && oneFloorCtx.drawCalls.length === 1);
check("未映射房間(door)不繪製", !tryDrawLimezuFloor(oneFloorCtx as any, "door", 0, 0, 0) && oneFloorCtx.drawCalls.length === 1);

// 依 map.ts 計算期望覆蓋:各房 rect 內、且 GRID 上確實屬於該房的格(排除浴室隔間牆)。
const GRID = buildGrid();
const AREAS = [
  { room: "r301", rect: ROOM_RECTS.r301 },
  { room: "r302", rect: ROOM_RECTS.r302 },
  { room: "r303", rect: ROOM_RECTS.r303 },
  { room: "r304", rect: ROOM_RECTS.r304 },
  { room: "lounge", rect: LOUNGE_HALL_RECT },
  { room: "bathroom", rect: FACILITY_RECTS.bathroom },
  { room: "laundry", rect: FACILITY_RECTS.laundry },
] as const;
interface ExpectedCall { sx: number; sy: number; x: number; y: number }
const expected: ExpectedCall[] = [];
for (const area of AREAS) {
  for (let r = area.rect.r0; r <= area.rect.r1; r++) {
    for (let c = area.rect.c0; c <= area.rect.c1; c++) {
      if (GRID[r][c] !== area.room) continue;
      const frame = LIMEZU_FLOOR_FRAMES[area.room][(c - area.rect.c0 + 2 * (r - area.rect.r0)) % 3];
      expected.push({ sx: frame.sx, sy: frame.sy, x: c * TILE, y: r * TILE });
    }
  }
}
check("期望覆蓋共 289 格(四房 140 + 大廳 84 + 浴室 30 + 洗衣間 35)", expected.length === 289);

const floorComposeCtx = new FakeCtx();
composeFloor(floorComposeCtx as any, 0);
const floorCalls = floorComposeCtx.drawCalls;
check("composeFloor 地板 drawImage 次數 = 期望格數", floorCalls.length === expected.length);
check(
  "每格來源/目的座標與 (c+2r)%3 pattern 完全一致(含 r301 與單房版相同)",
  floorCalls.length === expected.length && floorCalls.every((call, i) =>
    call[1] === expected[i].sx && call[2] === expected[i].sy
    && call[3] === 16 && call[4] === 16
    && call[5] === expected[i].x && call[6] === expected[i].y
    && call[7] === 16 && call[8] === 16),
);
const corridorXs = new Set([7 * TILE, 8 * TILE]);
check(
  "走廊(cols 7-8 大廳帶以外)與大門列不被覆蓋",
  floorCalls.every((call) => {
    const x = Number(call[5]);
    const y = Number(call[6]);
    if (y >= 31 * TILE) return false; // 大門/門墊列
    if (corridorXs.has(x)) return y >= 9 * TILE && y <= 14 * TILE; // 只有大廳帶允許 cols7-8
    return true;
  }),
);
check(
  "浴室隔間牆列(r27,cols1-5)不被覆蓋(洗衣間側 r27 照鋪)",
  floorCalls.every((call) => Number(call[6]) !== 27 * TILE || Number(call[5]) >= 10 * TILE)
    && floorCalls.some((call) => Number(call[6]) === 27 * TILE && Number(call[5]) >= 10 * TILE),
);

warnings = 0;
console.warn = () => { warnings++; };
const throwingFloorCtx = new ThrowingDrawCtx();
const floorDrawFailedA = tryDrawLimezuFloor(throwingFloorCtx as any, "r301", 0, 16, 16);
const floorDrawFailedB = tryDrawLimezuFloor(throwingFloorCtx as any, "r302", 1, 32, 16);
console.warn = originalWarn;
check("地板 drawImage 失敗安全回傳 false 且只警告一次", !floorDrawFailedA && !floorDrawFailedB && warnings === 1);

warnings = 0;
console.warn = () => { warnings++; };
class ErrorImage extends FakeImage {
  set src(value: string) {
    void value;
    queueMicrotask(() => this.onerror?.());
  }
}
(globalThis as any).Image = ErrorImage;
const failedA = await preloadLimezuFurnitureAtlas("/missing.png");
const failedB = await preloadLimezuFurnitureAtlas("/missing-again.png");
console.warn = originalWarn;
check("家具載入失敗永遠 resolve false 且只警告一次", !failedA && !failedB && warnings === 1);

resetLimezuFloorAtlasForTests();
warnings = 0;
console.warn = () => { warnings++; };
const failedFloorA = await preloadLimezuFloorAtlas("/missing-floors.png");
const failedFloorB = await preloadLimezuFloorAtlas("/missing-floors-again.png");
console.warn = originalWarn;
check("地板載入失敗永遠 resolve false 且只警告一次", !failedFloorA && !failedFloorB && warnings === 1);

// ---------------------------------------------------------------------------
// 牆面 atlas(第三批:整棟牆面)
// ---------------------------------------------------------------------------

const wallsPng = pngSize("../public/assets/limezu/walls.png");
const WALL_PIECES = [
  "cap_mid", "cap_left", "cap_right", "cap_both",
  "body_mid", "body_left", "body_right", "body_both",
  "baseboard",
] as const;
check(
  "牆件清單 = 頂蓋/牆身各 4 向 + 踢腳條共 9 件",
  JSON.stringify(LIMEZU_WALL_PIECE_IDS) === JSON.stringify(WALL_PIECES),
);
check(
  "walls.png 尺寸 = manifest 宣告的 64x48",
  wallsPng.width === 64 && wallsPng.height === 48
    && manifest.wall_atlas.width === wallsPng.width
    && manifest.wall_atlas.height === wallsPng.height,
);
check(
  "每個牆件 frame 與 manifest 的 atlas 位置/裁切尺寸一致且在邊界內",
  WALL_PIECES.every((id) => {
    const m = manifest.walls[id];
    const f = LIMEZU_WALL_FRAMES[id];
    return !!m && m.atlas[0] === f.sx && m.atlas[1] === f.sy
      && m.crop[2] === f.sw && m.crop[3] === f.sh
      && f.sx >= 0 && f.sy >= 0
      && f.sx + f.sw <= wallsPng.width && f.sy + f.sh <= wallsPng.height;
  }),
);
check(
  "頂蓋/牆身為 16x16、踢腳條為 16x6",
  WALL_PIECES.every((id) => (id === "baseboard"
    ? LIMEZU_WALL_FRAMES[id].sw === 16 && LIMEZU_WALL_FRAMES[id].sh === 6
    : LIMEZU_WALL_FRAMES[id].sw === 16 && LIMEZU_WALL_FRAMES[id].sh === 16)),
);
const wallFrames = WALL_PIECES.map((id) => LIMEZU_WALL_FRAMES[id]);
const wallOverlaps = wallFrames.some((a, index) => wallFrames.slice(index + 1).some((b) =>
  a.sx < b.sx + b.sw && a.sx + a.sw > b.sx && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy,
));
check("牆件 frame 互不重疊", !wallOverlaps);
check(
  "牆件來源僅限 Room_Builder 牆面表與踢腳板表",
  WALL_PIECES.every((id) => {
    const m = manifest.walls[id];
    return id === "baseboard"
      ? m.source === "Room_Builder_subfiles/Room_Builder_Baseboards_16x16.png"
      : m.source === "Room_Builder_subfiles/Room_Builder_Walls_16x16.png";
  }),
);

// runtime:未載入 → 完整回退程序牆(composeFloor 不畫任何圖片)
resetLimezuFurnitureAtlasForTests();
resetLimezuFloorAtlasForTests();
resetLimezuWallAtlasForTests();
delete (globalThis as any).Image;
check("Node 無 Image 時牆面預載安全回傳 false", await preloadLimezuWallAtlas() === false);
const wallFallbackCtx = new FakeCtx();
composeFloor(wallFallbackCtx as any, 0);
check("牆面 atlas 未載入時不畫圖片且程序牆仍有內容", wallFallbackCtx.drawCalls.length === 0 && wallFallbackCtx.fillCount > 0);

(globalThis as any).Image = FakeImage;
resetLimezuWallAtlasForTests();
const wallImageInstancesBefore = imageInstances;
const [wallLoadedA, wallLoadedB] = await Promise.all([
  preloadLimezuWallAtlas("/fake-walls.png"),
  preloadLimezuWallAtlas("/ignored-walls.png"),
]);
check("牆面並行預載共用同一 promise 與 Image", wallLoadedA && wallLoadedB && imageInstances === wallImageInstancesBefore + 1);

const onePieceCtx = new FakeCtx();
const capFrame = LIMEZU_WALL_FRAMES.cap_mid;
const onePieceDrawn = tryDrawLimezuWallPiece(onePieceCtx as any, "cap_mid", 32, 128);
const onePieceArgs = onePieceCtx.drawCalls[0] ?? [];
check(
  "單一牆件維持 1:1 像素且取用正確格位",
  onePieceDrawn && onePieceArgs[1] === capFrame.sx && onePieceArgs[2] === capFrame.sy
    && onePieceArgs[3] === 16 && onePieceArgs[4] === 16
    && onePieceArgs[5] === 32 && onePieceArgs[6] === 128
    && onePieceArgs[7] === 16 && onePieceArgs[8] === 16,
);
const baseFrame = LIMEZU_WALL_FRAMES.baseboard;
const baseDrawn = tryDrawLimezuWallPiece(onePieceCtx as any, "baseboard", 16, 16 * 8 + 10);
const baseArgs = onePieceCtx.drawCalls[1] ?? [];
check(
  "踢腳條以 16x6 貼在南向面位置",
  baseDrawn && baseArgs[1] === baseFrame.sx && baseArgs[2] === baseFrame.sy
    && baseArgs[3] === 16 && baseArgs[4] === 6
    && baseArgs[5] === 16 && baseArgs[6] === 16 * 8 + 10
    && baseArgs[7] === 16 && baseArgs[8] === 6,
);
check("未知牆件 id 不繪製", !tryDrawLimezuWallPiece(onePieceCtx as any, "cap_south", 0, 0) && onePieceCtx.drawCalls.length === 2);

// composeFloor:只載牆 atlas 時,drawImage 全部來自牆件且逐格對應鄰格選件規則
interface ExpectedWallCall { sx: number; sy: number; x: number; y: number; sh: number }
const isWallAt = (rr: number, cc: number) =>
  rr >= 0 && rr < GRID.length && cc >= 0 && cc < GRID[0].length && GRID[rr][cc] === "wall";
const expectedWalls: ExpectedWallCall[] = [];
for (let r = 0; r < GRID.length; r++) {
  for (let c = 0; c < GRID[0].length; c++) {
    if (GRID[r][c] !== "wall") continue;
    const west = isWallAt(r, c - 1);
    const east = isWallAt(r, c + 1);
    const side = west && east ? "mid" : west ? "right" : east ? "left" : "both";
    const band = isWallAt(r - 1, c) ? "body" : "cap";
    const f = LIMEZU_WALL_FRAMES[`${band}_${side}` as keyof typeof LIMEZU_WALL_FRAMES];
    expectedWalls.push({ sx: f.sx, sy: f.sy, x: c * TILE, y: r * TILE, sh: 16 });
    const belowIsWall = r + 1 < GRID.length && GRID[r + 1][c] === "wall";
    if (!belowIsWall) {
      expectedWalls.push({ sx: baseFrame.sx, sy: baseFrame.sy, x: c * TILE, y: r * TILE + TILE - 6, sh: 6 });
    }
  }
}
const wallComposeCtx = new FakeCtx();
composeFloor(wallComposeCtx as any, 0);
check(
  "composeFloor 牆面 drawImage 次數 = 牆格 + 南向面格",
  wallComposeCtx.drawCalls.length === expectedWalls.length,
);
check(
  "每個牆格依北/西/東鄰格選 cap/body 與收邊變體、南向面鋪踢腳條",
  wallComposeCtx.drawCalls.length === expectedWalls.length && wallComposeCtx.drawCalls.every((call, i) =>
    call[1] === expectedWalls[i].sx && call[2] === expectedWalls[i].sy
    && call[3] === 16 && call[4] === expectedWalls[i].sh
    && call[5] === expectedWalls[i].x && call[6] === expectedWalls[i].y
    && call[7] === 16 && call[8] === expectedWalls[i].sh),
);
const firstWallCall = wallComposeCtx.drawCalls[0] ?? [];
check(
  "左上角 (0,0) 取 cap_left(北/西開放、東連牆)",
  firstWallCall[1] === LIMEZU_WALL_FRAMES.cap_left.sx && firstWallCall[2] === LIMEZU_WALL_FRAMES.cap_left.sy,
);

// drawImage 失敗 → 回退程序牆且只警告一次
warnings = 0;
console.warn = () => { warnings++; };
const throwingWallCtx = new ThrowingDrawCtx();
composeFloor(throwingWallCtx as any, 0);
console.warn = originalWarn;
check("牆面 drawImage 失敗時整棟回退程序牆且只警告一次", throwingWallCtx.fillCount > 0 && warnings === 1);

// 載入失敗 → 永遠 resolve false 且只警告一次
resetLimezuWallAtlasForTests();
(globalThis as any).Image = ErrorImage;
warnings = 0;
console.warn = () => { warnings++; };
const failedWallA = await preloadLimezuWallAtlas("/missing-walls.png");
const failedWallB = await preloadLimezuWallAtlas("/missing-walls-again.png");
console.warn = originalWarn;
check("牆面載入失敗永遠 resolve false 且只警告一次", !failedWallA && !failedWallB && warnings === 1);

if (originalImage === undefined) delete (globalThis as any).Image;
else (globalThis as any).Image = originalImage;

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
