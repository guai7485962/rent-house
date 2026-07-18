/** LimeZu 家具 atlas 的預載、映射與程序繪圖 fallback 回歸。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LIMEZU_FURNITURE_IDS,
  LIMEZU_FURNITURE_FRAMES,
  LIMEZU_R301_FLOOR_FRAMES,
  preloadLimezuFurnitureAtlas,
  preloadLimezuR301Floor,
  resetLimezuFurnitureAtlasForTests,
  resetLimezuR301FloorForTests,
  tryDrawLimezuFurniture,
  tryDrawLimezuR301Floor,
} from "../src/art/limezu";
import { getDef } from "../src/furniture/catalog";
import { drawDef } from "../src/furniture/render";
import { composeFloor } from "../src/floor/floorScene";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const APPROVED_IDS = ["single_bed", "gaming_desk"] as const;
const RETIRED_IDS = ["beanbag", "tv_console", "cat_tower"] as const;

const atlasBytes = readFileSync(fileURLToPath(new URL("../public/assets/limezu/mvp301.png", import.meta.url)));
const atlasWidth = atlasBytes.readUInt32BE(16);
const atlasHeight = atlasBytes.readUInt32BE(20);
const floorBytes = readFileSync(fileURLToPath(new URL("../public/assets/limezu/r301-floor.png", import.meta.url)));
const floorWidth = floorBytes.readUInt32BE(16);
const floorHeight = floorBytes.readUInt32BE(20);
const frames = Object.entries(LIMEZU_FURNITURE_FRAMES);
const overlaps = frames.some(([idA, a], index) => frames.slice(index + 1).some(([idB, b]) =>
  idA !== idB
  && a.sx < b.sx + b.sw
  && a.sx + a.sw > b.sx
  && a.sy < b.sy + b.sh
  && a.sy + a.sh > b.sy,
));
const floorOverlaps = LIMEZU_R301_FLOOR_FRAMES.some((a, index) =>
  LIMEZU_R301_FLOOR_FRAMES.slice(index + 1).some((b) =>
    a.sx < b.sx + b.sw && a.sx + a.sw > b.sx && a.sy < b.sy + b.sh && a.sy + a.sh > b.sy,
  ),
);

check(
  "runtime 白名單只保留核准的床與電競桌",
  JSON.stringify(LIMEZU_FURNITURE_IDS) === JSON.stringify(APPROVED_IDS),
);
check("atlas 已縮為只容納核准 frame 的 64x30", atlasWidth === 64 && atlasHeight === 30);
check(
  "所有 source rect 均在 atlas 邊界內",
  frames.every(([, f]) => f.sx >= 0 && f.sy >= 0 && f.sw > 0 && f.sh > 0
    && f.sx + f.sw <= atlasWidth && f.sy + f.sh <= atlasHeight),
);
check("核准 source rect 互不重疊", !overlaps);
check("301 地板小圖為 48x16", floorWidth === 48 && floorHeight === 16);
check(
  "三個 301 地板 frame 都是 16x16 且在小圖邊界內",
  LIMEZU_R301_FLOOR_FRAMES.length === 3
    && LIMEZU_R301_FLOOR_FRAMES.every((f) => f.sw === 16 && f.sh === 16
      && f.sx >= 0 && f.sy >= 0 && f.sx + f.sw <= floorWidth && f.sy + f.sh <= floorHeight),
);
check("三個 301 地板 frame 互不重疊", !floorOverlaps);

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
resetLimezuR301FloorForTests();
delete (globalThis as any).Image;
check("Node 無 Image 時預載安全回傳 false", await preloadLimezuFurnitureAtlas() === false);
check("Node 無 Image 時 301 地板預載安全回傳 false", await preloadLimezuR301Floor() === false);

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
check("並行預載共用同一 promise 與 Image", loadedA && loadedB && imageInstances === 1);

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
check("未知家具 id 不會誤畫 atlas", !tryDrawLimezuFurniture(atlasCtx as any, "double_bed", 0, 0, 48, 32) && atlasCtx.drawCalls.length === 1);

for (const id of RETIRED_IDS) {
  check(`${id} 已退出 atlas runtime 映射`, !tryDrawLimezuFurniture(atlasCtx as any, id, 0, 0, 32, 32));
  const fallback = new FakeCtx();
  drawDef(fallback as any, getDef(id), 0, 0);
  check(`${id} 恢復既有程序繪圖`, fallback.drawCalls.length === 0 && fallback.fillCount > 0);
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
check("drawImage 失敗時仍回退程序繪圖且只警告一次", throwingCtx.fillCount > 0 && warnings === 1);
console.warn = originalWarn;

resetLimezuFurnitureAtlasForTests();
const fallbackCtx = new FakeCtx();
drawDef(fallbackCtx as any, getDef("single_bed"), 0, 0);
check("atlas 未載入時完整回退既有程序繪圖", fallbackCtx.drawCalls.length === 0 && fallbackCtx.fillCount > 0);

resetLimezuR301FloorForTests();
const floorFallbackCtx = new FakeCtx();
composeFloor(floorFallbackCtx as any, 0);
check("301 地板未載入時不畫圖片且程序地板仍有內容", floorFallbackCtx.drawCalls.length === 0 && floorFallbackCtx.fillCount > 0);

const floorImageInstancesBefore = imageInstances;
const [floorLoadedA, floorLoadedB] = await Promise.all([
  preloadLimezuR301Floor("/fake-r301-floor.png"),
  preloadLimezuR301Floor("/ignored-r301-floor.png"),
]);
check("301 地板並行預載共用同一 promise 與 Image", floorLoadedA && floorLoadedB && imageInstances === floorImageInstancesBefore + 1);

const oneFloorCtx = new FakeCtx();
const oneFloorDrawn = tryDrawLimezuR301Floor(oneFloorCtx as any, 2, 16, 16);
const oneFloorArgs = oneFloorCtx.drawCalls[0] ?? [];
check(
  "單格 301 地板維持 1:1 像素",
  oneFloorDrawn && oneFloorArgs[1] === 32 && oneFloorArgs[2] === 0
    && oneFloorArgs[3] === 16 && oneFloorArgs[4] === 16
    && oneFloorArgs[5] === 16 && oneFloorArgs[6] === 16
    && oneFloorArgs[7] === 16 && oneFloorArgs[8] === 16,
);
check("非法 301 地板 variant 不繪製", !tryDrawLimezuR301Floor(oneFloorCtx as any, 3, 0, 0) && oneFloorCtx.drawCalls.length === 1);

const floorComposeCtx = new FakeCtx();
composeFloor(floorComposeCtx as any, 0);
const floorCalls = floorComposeCtx.drawCalls;
check("composeFloor 只畫 301 的 5x7 共 35 格", floorCalls.length === 35);
check(
  "301 地板 35 格全部在 [16,96)x[16,128) 內",
  floorCalls.every((args) => Number(args[5]) >= 16 && Number(args[5]) + Number(args[7]) <= 96
    && Number(args[6]) >= 16 && Number(args[6]) + Number(args[8]) <= 128),
);
check(
  "301 地板使用 (c + 2*r) % 3 固定圖樣",
  floorCalls.every((args, i) => {
    const c = i % 5;
    const r = Math.floor(i / 5);
    const frame = LIMEZU_R301_FLOOR_FRAMES[(c + 2 * r) % 3];
    return args[1] === frame.sx && args[2] === frame.sy
      && args[5] === 16 + c * 16 && args[6] === 16 + r * 16;
  }),
);

warnings = 0;
console.warn = () => { warnings++; };
const throwingFloorCtx = new ThrowingDrawCtx();
const floorDrawFailedA = tryDrawLimezuR301Floor(throwingFloorCtx as any, 0, 16, 16);
const floorDrawFailedB = tryDrawLimezuR301Floor(throwingFloorCtx as any, 1, 32, 16);
console.warn = originalWarn;
check("301 地板 drawImage 失敗安全回傳 false 且只警告一次", !floorDrawFailedA && !floorDrawFailedB && warnings === 1);

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
check("載入失敗永遠 resolve false 且只警告一次", !failedA && !failedB && warnings === 1);

resetLimezuR301FloorForTests();
warnings = 0;
console.warn = () => { warnings++; };
const failedFloorA = await preloadLimezuR301Floor("/missing-floor.png");
const failedFloorB = await preloadLimezuR301Floor("/missing-floor-again.png");
console.warn = originalWarn;
check("301 地板載入失敗永遠 resolve false 且只警告一次", !failedFloorA && !failedFloorB && warnings === 1);

if (originalImage === undefined) delete (globalThis as any).Image;
else (globalThis as any).Image = originalImage;

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
