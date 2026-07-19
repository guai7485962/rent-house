import type { Ctx } from "../pixel/sprites";

/**
 * LimeZu Modern Interiors 的專案專用 atlas。
 *
 * 原始付費素材不進版控;只把遊戲實際使用的核准素材重組成專案小圖
 * (由 scripts/build-limezu-atlas.py 依 scripts/limezu-manifest.json 產生,
 * 兩張 atlas 的 frame 表與 manifest 一一對應,limezu-art-test.ts 交叉驗證)。
 * atlas 尚未載入、瀏覽器不支援 Image、或繪製失敗時一律回傳 false,
 * 由 furniture/render.ts 與 floorScene.ts 保留的程序繪圖完整接手。
 */
export const LIMEZU_ATLAS_URL = "/assets/limezu/furniture.png";
export const LIMEZU_FLOOR_ATLAS_URL = "/assets/limezu/floors.png";
export const LIMEZU_WALL_ATLAS_URL = "/assets/limezu/walls.png";

export const LIMEZU_FURNITURE_IDS = [
  "single_bed",
  "gaming_desk",
  "wardrobe",
  "dresser",
  "floor_lamp",
  "plant",
  "bath_plant",
  "tv_console",
  "lounge_tv",
  "fridge",
  "stove",
  "counter",
  "coffee_machine",
  "dining_table",
  "toilet",
  "shower",
  "washing_machine",
  "laundry_washer",
  "shared_sofa",
  "loveseat",
  "lounge_plant",
  "wood_chair",
  "coffee_table",
] as const;

export type LimezuFurnitureId = (typeof LIMEZU_FURNITURE_IDS)[number];

interface AtlasFrame {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 相對家具 footprint 左上角的繪製偏移;保留 LimeZu 原圖 1:1 像素。 */
  dx: number;
  dy: number;
}

/**
 * 固定的 128x128 atlas 版面(與 scripts/limezu-manifest.json 同步)。
 * dx = 水平置中於 footprint,dy = 底邊貼齊 footprint 底邊、高度往上長。
 * laundry_washer 與 washing_machine 共用同一格(manifest 中為 alias)。
 * y=96 起為第二批(Generic theme sheet)交誼廳/房間家具。
 */
export const LIMEZU_FURNITURE_FRAMES: Readonly<Record<LimezuFurnitureId, AtlasFrame>> = {
  single_bed: { sx: 92, sy: 40, sw: 36, sh: 25, dx: -2, dy: 7 },
  gaming_desk: { sx: 0, sy: 40, sw: 28, sh: 30, dx: 2, dy: -14 },
  wardrobe: { sx: 64, sy: 0, sw: 16, sh: 40, dx: 0, dy: -8 },
  dresser: { sx: 59, sy: 70, sw: 15, sh: 18, dx: 0, dy: -2 },
  floor_lamp: { sx: 96, sy: 0, sw: 15, sh: 33, dx: 0, dy: -17 },
  plant: { sx: 28, sy: 40, sw: 14, sh: 29, dx: 1, dy: -13 },
  bath_plant: { sx: 103, sy: 70, sw: 12, sh: 14, dx: 2, dy: 2 },
  tv_console: { sx: 0, sy: 0, sw: 32, sh: 40, dx: 0, dy: -24 },
  lounge_tv: { sx: 32, sy: 0, sw: 32, sh: 40, dx: 0, dy: -24 },
  fridge: { sx: 80, sy: 0, sw: 16, sh: 36, dx: 0, dy: -4 },
  stove: { sx: 0, sy: 70, sw: 16, sh: 25, dx: 0, dy: -9 },
  counter: { sx: 74, sy: 70, sw: 29, sh: 14, dx: 1, dy: 2 },
  coffee_machine: { sx: 45, sy: 70, sw: 14, sh: 19, dx: 1, dy: -3 },
  dining_table: { sx: 62, sy: 40, sw: 30, sh: 26, dx: 1, dy: 6 },
  toilet: { sx: 111, sy: 0, sw: 14, sh: 35, dx: 1, dy: -19 },
  shower: { sx: 16, sy: 70, sw: 29, sh: 25, dx: 1, dy: 7 },
  washing_machine: { sx: 42, sy: 40, sw: 20, sh: 29, dx: -2, dy: -13 },
  laundry_washer: { sx: 42, sy: 40, sw: 20, sh: 29, dx: -2, dy: -13 },
  shared_sofa: { sx: 0, sy: 96, sw: 48, sh: 26, dx: 0, dy: -10 },
  loveseat: { sx: 48, sy: 96, sw: 30, sh: 18, dx: 1, dy: -2 },
  lounge_plant: { sx: 78, sy: 96, sw: 16, sh: 31, dx: 0, dy: -15 },
  wood_chair: { sx: 94, sy: 96, sw: 14, sh: 22, dx: 1, dy: -6 },
  coffee_table: { sx: 108, sy: 96, sw: 14, sh: 14, dx: 1, dy: 2 },
};

/** 地板 atlas 中有專屬三變體列的房間(與 manifest floors 的 row 順序同步)。 */
export const LIMEZU_FLOOR_ROOM_IDS = [
  "r301",
  "r302",
  "r303",
  "r304",
  "lounge",
  "bathroom",
  "laundry",
] as const;

export type LimezuFloorRoomId = (typeof LIMEZU_FLOOR_ROOM_IDS)[number];

interface FloorFrame {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function floorRow(row: number): readonly [FloorFrame, FloorFrame, FloorFrame] {
  return [
    { sx: 0, sy: row * 16, sw: 16, sh: 16 },
    { sx: 16, sy: row * 16, sw: 16, sh: 16 },
    { sx: 32, sy: row * 16, sw: 16, sh: 16 },
  ] as const;
}

/** roomId → 三個 16x16 變體;只供 floorScene 的房內覆蓋使用。 */
export const LIMEZU_FLOOR_FRAMES: Readonly<
  Record<LimezuFloorRoomId, readonly [FloorFrame, FloorFrame, FloorFrame]>
> = {
  r301: floorRow(0),
  r302: floorRow(1),
  r303: floorRow(2),
  r304: floorRow(3),
  lounge: floorRow(4),
  bathroom: floorRow(5),
  laundry: floorRow(6),
};

/**
 * 牆面 atlas(第三批):Room_Builder 紫色牆套 + 橙色踢腳條。
 * cap_* = 北緣頂蓋(白色蓋條+牆身)、body_* = 牆身延伸;
 * mid/left/right/both 依「該側鄰格非牆」帶深色收邊線;
 * baseboard = 16x6 橙踢腳條,鋪在南向牆面(幾何沿用程序牆的 6px 面)。
 */
export const LIMEZU_WALL_PIECE_IDS = [
  "cap_mid",
  "cap_left",
  "cap_right",
  "cap_both",
  "body_mid",
  "body_left",
  "body_right",
  "body_both",
  "baseboard",
] as const;

export type LimezuWallPieceId = (typeof LIMEZU_WALL_PIECE_IDS)[number];

interface WallFrame {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 固定 64x48 walls.png 版面(與 scripts/limezu-manifest.json walls 同步)。 */
export const LIMEZU_WALL_FRAMES: Readonly<Record<LimezuWallPieceId, WallFrame>> = {
  cap_mid: { sx: 0, sy: 0, sw: 16, sh: 16 },
  cap_left: { sx: 16, sy: 0, sw: 16, sh: 16 },
  cap_right: { sx: 32, sy: 0, sw: 16, sh: 16 },
  cap_both: { sx: 48, sy: 0, sw: 16, sh: 16 },
  body_mid: { sx: 0, sy: 16, sw: 16, sh: 16 },
  body_left: { sx: 16, sy: 16, sw: 16, sh: 16 },
  body_right: { sx: 32, sy: 16, sw: 16, sh: 16 },
  body_both: { sx: 48, sy: 16, sw: 16, sh: 16 },
  baseboard: { sx: 0, sy: 32, sw: 16, sh: 6 },
};

type AtlasImage = CanvasImageSource;
type LoadableImage = CanvasImageSource & {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  decoding?: "async" | "sync" | "auto";
};

let atlas: AtlasImage | null = null;
let preloadPromise: Promise<boolean> | null = null;
let warned = false;
let floorAtlas: AtlasImage | null = null;
let floorPreloadPromise: Promise<boolean> | null = null;
let floorWarned = false;
let wallAtlas: AtlasImage | null = null;
let wallPreloadPromise: Promise<boolean> | null = null;
let wallWarned = false;

function warnOnce(message: string, cause?: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`[limezu] ${message}`, cause ?? "");
}

function warnFloorOnce(message: string, cause?: unknown) {
  if (floorWarned) return;
  floorWarned = true;
  console.warn(`[limezu] ${message}`, cause ?? "");
}

function warnWallOnce(message: string, cause?: unknown) {
  if (wallWarned) return;
  wallWarned = true;
  console.warn(`[limezu] ${message}`, cause ?? "");
}

/** 非阻塞預載;永遠 resolve,避免美術檔讓整個遊戲啟動失敗。 */
export function preloadLimezuFurnitureAtlas(url = LIMEZU_ATLAS_URL): Promise<boolean> {
  if (atlas) return Promise.resolve(true);
  if (preloadPromise) return preloadPromise;
  if (typeof Image === "undefined") return Promise.resolve(false);

  preloadPromise = new Promise<boolean>((resolve) => {
    let image: LoadableImage;
    try {
      image = new Image() as LoadableImage;
      image.decoding = "async";
    } catch (error) {
      warnOnce("無法建立家具 atlas 圖像,改用程序繪圖。", error);
      resolve(false);
      return;
    }

    image.onload = () => {
      atlas = image;
      resolve(true);
    };
    image.onerror = () => {
      warnOnce("家具 atlas 載入失敗,改用程序繪圖。");
      resolve(false);
    };

    try {
      image.src = url;
    } catch (error) {
      warnOnce("設定家具 atlas 路徑失敗,改用程序繪圖。", error);
      resolve(false);
    }
  });

  return preloadPromise;
}

/** 地板 atlas 非阻塞預載;失敗時保留 floorScene 已畫好的程序地板。 */
export function preloadLimezuFloorAtlas(url = LIMEZU_FLOOR_ATLAS_URL): Promise<boolean> {
  if (floorAtlas) return Promise.resolve(true);
  if (floorPreloadPromise) return floorPreloadPromise;
  if (typeof Image === "undefined") return Promise.resolve(false);

  floorPreloadPromise = new Promise<boolean>((resolve) => {
    let image: LoadableImage;
    try {
      image = new Image() as LoadableImage;
      image.decoding = "async";
    } catch (error) {
      warnFloorOnce("無法建立地板 atlas 圖像,保留程序地板。", error);
      resolve(false);
      return;
    }

    image.onload = () => {
      floorAtlas = image;
      resolve(true);
    };
    image.onerror = () => {
      warnFloorOnce("地板 atlas 載入失敗,保留程序地板。");
      resolve(false);
    };

    try {
      image.src = url;
    } catch (error) {
      warnFloorOnce("設定地板 atlas 路徑失敗,保留程序地板。", error);
      resolve(false);
    }
  });

  return floorPreloadPromise;
}

/** 牆面 atlas 非阻塞預載;失敗時 floorScene 保留整套程序牆。 */
export function preloadLimezuWallAtlas(url = LIMEZU_WALL_ATLAS_URL): Promise<boolean> {
  if (wallAtlas) return Promise.resolve(true);
  if (wallPreloadPromise) return wallPreloadPromise;
  if (typeof Image === "undefined") return Promise.resolve(false);

  wallPreloadPromise = new Promise<boolean>((resolve) => {
    let image: LoadableImage;
    try {
      image = new Image() as LoadableImage;
      image.decoding = "async";
    } catch (error) {
      warnWallOnce("無法建立牆面 atlas 圖像,保留程序牆。", error);
      resolve(false);
      return;
    }

    image.onload = () => {
      wallAtlas = image;
      resolve(true);
    };
    image.onerror = () => {
      warnWallOnce("牆面 atlas 載入失敗,保留程序牆。");
      resolve(false);
    };

    try {
      image.src = url;
    } catch (error) {
      warnWallOnce("設定牆面 atlas 路徑失敗,保留程序牆。", error);
      resolve(false);
    }
  });

  return wallPreloadPromise;
}

function isLimezuFurnitureId(id: string): id is LimezuFurnitureId {
  return Object.prototype.hasOwnProperty.call(LIMEZU_FURNITURE_FRAMES, id);
}

function isLimezuFloorRoomId(id: string): id is LimezuFloorRoomId {
  return Object.prototype.hasOwnProperty.call(LIMEZU_FLOOR_FRAMES, id);
}

/** 成功畫出 atlas 家具時回傳 true;false 代表呼叫端必須走既有 fallback。 */
export function tryDrawLimezuFurniture(
  ctx: Ctx,
  furnitureId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (!atlas || !isLimezuFurnitureId(furnitureId)) return false;
  const frame = LIMEZU_FURNITURE_FRAMES[furnitureId];
  try {
    // 不縮放:避免像素素材模糊;高家具可從 footprint 往上延伸。
    ctx.drawImage(
      atlas,
      frame.sx,
      frame.sy,
      frame.sw,
      frame.sh,
      x + frame.dx,
      y + frame.dy,
      frame.sw,
      frame.sh,
    );
    return true;
  } catch (error) {
    warnOnce("家具 atlas 繪製失敗,改用程序繪圖。", error);
    return false;
  }
}

/** 成功以 1:1 像素畫出一格房間地板時回傳 true;false 時保留既有程序底圖。 */
export function tryDrawLimezuFloor(
  ctx: Ctx,
  roomId: string,
  variant: number,
  x: number,
  y: number,
): boolean {
  if (!floorAtlas || !isLimezuFloorRoomId(roomId) || !Number.isInteger(variant)) return false;
  const frame = LIMEZU_FLOOR_FRAMES[roomId][variant];
  if (!frame) return false;
  try {
    ctx.drawImage(floorAtlas, frame.sx, frame.sy, frame.sw, frame.sh, x, y, frame.sw, frame.sh);
    return true;
  } catch (error) {
    warnFloorOnce("地板 atlas 繪製失敗,保留程序地板。", error);
    return false;
  }
}

function isLimezuWallPieceId(id: string): id is LimezuWallPieceId {
  return Object.prototype.hasOwnProperty.call(LIMEZU_WALL_FRAMES, id);
}

/**
 * 成功以 1:1 像素畫出一個牆件(頂蓋/牆身 16x16、踢腳條 16x6)時回傳 true;
 * false 代表呼叫端必須畫回既有程序牆。
 */
export function tryDrawLimezuWallPiece(ctx: Ctx, pieceId: string, x: number, y: number): boolean {
  if (!wallAtlas || !isLimezuWallPieceId(pieceId)) return false;
  const frame = LIMEZU_WALL_FRAMES[pieceId];
  try {
    ctx.drawImage(wallAtlas, frame.sx, frame.sy, frame.sw, frame.sh, x, y, frame.sw, frame.sh);
    return true;
  } catch (error) {
    warnWallOnce("牆面 atlas 繪製失敗,保留程序牆。", error);
    return false;
  }
}

/** @internal 僅供確定性測試隔離模組狀態。 */
export function resetLimezuFurnitureAtlasForTests() {
  atlas = null;
  preloadPromise = null;
  warned = false;
}

/** @internal 僅供確定性測試隔離地板 atlas 載入狀態。 */
export function resetLimezuFloorAtlasForTests() {
  floorAtlas = null;
  floorPreloadPromise = null;
  floorWarned = false;
}

/** @internal 僅供確定性測試隔離牆面 atlas 載入狀態。 */
export function resetLimezuWallAtlasForTests() {
  wallAtlas = null;
  wallPreloadPromise = null;
  wallWarned = false;
}
