import type { Ctx } from "../pixel/sprites";

/**
 * LimeZu Modern Interiors 的專案專用家具 atlas。
 *
 * 原始付費素材不進版控；只把遊戲實際使用的核准素材重組成專案小圖。
 * atlas 尚未載入、瀏覽器不支援 Image、或繪製失敗時一律回傳 false，
 * 由 furniture/render.ts 保留的程序繪圖完整接手。
 */
export const LIMEZU_ATLAS_URL = "/assets/limezu/mvp301.png";
export const LIMEZU_R301_FLOOR_URL = "/assets/limezu/r301-floor.png";

export const LIMEZU_FURNITURE_IDS = [
  "single_bed",
  "gaming_desk",
] as const;

export type LimezuFurnitureId = (typeof LIMEZU_FURNITURE_IDS)[number];

interface AtlasFrame {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 相對家具 footprint 左上角的繪製偏移；保留 LimeZu 原圖 1:1 像素。 */
  dx: number;
  dy: number;
}

/**
 * 固定的 64x30 atlas 版面。素材整合時只裁透明邊並放進對應格位，
 * runtime 不必知道原始付費素材的檔名或資料夾結構。
 */
export const LIMEZU_FURNITURE_FRAMES: Readonly<Record<LimezuFurnitureId, AtlasFrame>> = {
  single_bed: { sx: 0, sy: 0, sw: 36, sh: 25, dx: -2, dy: 7 },
  gaming_desk: { sx: 36, sy: 0, sw: 28, sh: 30, dx: 2, dy: -14 },
};

/** 301 地板小圖中的三個 16x16 變體；只供 floorScene 的 301 固定區域使用。 */
export const LIMEZU_R301_FLOOR_FRAMES = [
  { sx: 0, sy: 0, sw: 16, sh: 16 },
  { sx: 16, sy: 0, sw: 16, sh: 16 },
  { sx: 32, sy: 0, sw: 16, sh: 16 },
] as const;

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
let r301Floor: AtlasImage | null = null;
let r301FloorPreloadPromise: Promise<boolean> | null = null;
let r301FloorWarned = false;

function warnOnce(message: string, cause?: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`[limezu] ${message}`, cause ?? "");
}

function warnR301FloorOnce(message: string, cause?: unknown) {
  if (r301FloorWarned) return;
  r301FloorWarned = true;
  console.warn(`[limezu] ${message}`, cause ?? "");
}

/** 非阻塞預載；永遠 resolve，避免美術檔讓整個遊戲啟動失敗。 */
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
      warnOnce("無法建立家具 atlas 圖像，改用程序繪圖。", error);
      resolve(false);
      return;
    }

    image.onload = () => {
      atlas = image;
      resolve(true);
    };
    image.onerror = () => {
      warnOnce("家具 atlas 載入失敗，改用程序繪圖。");
      resolve(false);
    };

    try {
      image.src = url;
    } catch (error) {
      warnOnce("設定家具 atlas 路徑失敗，改用程序繪圖。", error);
      resolve(false);
    }
  });

  return preloadPromise;
}

/** 301 地板非阻塞預載；失敗時保留 floorScene 已畫好的程序地板。 */
export function preloadLimezuR301Floor(url = LIMEZU_R301_FLOOR_URL): Promise<boolean> {
  if (r301Floor) return Promise.resolve(true);
  if (r301FloorPreloadPromise) return r301FloorPreloadPromise;
  if (typeof Image === "undefined") return Promise.resolve(false);

  r301FloorPreloadPromise = new Promise<boolean>((resolve) => {
    let image: LoadableImage;
    try {
      image = new Image() as LoadableImage;
      image.decoding = "async";
    } catch (error) {
      warnR301FloorOnce("無法建立 301 地板圖像，保留程序地板。", error);
      resolve(false);
      return;
    }

    image.onload = () => {
      r301Floor = image;
      resolve(true);
    };
    image.onerror = () => {
      warnR301FloorOnce("301 地板載入失敗，保留程序地板。");
      resolve(false);
    };

    try {
      image.src = url;
    } catch (error) {
      warnR301FloorOnce("設定 301 地板路徑失敗，保留程序地板。", error);
      resolve(false);
    }
  });

  return r301FloorPreloadPromise;
}

function isLimezuFurnitureId(id: string): id is LimezuFurnitureId {
  return Object.prototype.hasOwnProperty.call(LIMEZU_FURNITURE_FRAMES, id);
}

/** 成功畫出 atlas 家具時回傳 true；false 代表呼叫端必須走既有 fallback。 */
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
    // 不縮放：避免像素素材模糊；高家具可從 footprint 往上延伸。
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
    warnOnce("家具 atlas 繪製失敗，改用程序繪圖。", error);
    return false;
  }
}

/** 成功以 1:1 像素畫出一格 301 地板時回傳 true；false 時保留既有程序底圖。 */
export function tryDrawLimezuR301Floor(
  ctx: Ctx,
  variant: number,
  x: number,
  y: number,
): boolean {
  if (!r301Floor || !Number.isInteger(variant)) return false;
  const frame = LIMEZU_R301_FLOOR_FRAMES[variant];
  if (!frame) return false;
  try {
    ctx.drawImage(r301Floor, frame.sx, frame.sy, frame.sw, frame.sh, x, y, frame.sw, frame.sh);
    return true;
  } catch (error) {
    warnR301FloorOnce("301 地板繪製失敗，保留程序地板。", error);
    return false;
  }
}

/** @internal 僅供確定性測試隔離模組狀態。 */
export function resetLimezuFurnitureAtlasForTests() {
  atlas = null;
  preloadPromise = null;
  warned = false;
}

/** @internal 僅供確定性測試隔離 301 地板載入狀態。 */
export function resetLimezuR301FloorForTests() {
  r301Floor = null;
  r301FloorPreloadPromise = null;
  r301FloorWarned = false;
}
