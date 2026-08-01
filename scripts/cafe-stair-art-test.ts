/** CAFE-04 樓板分隔帶與樓梯程序 fallback 的像素邊界／指紋回歸。 */
import { createHash } from "node:crypto";
import { drawFloorDivider, drawStairs, FLOOR_H, FLOOR_W } from "../src/floor/floorScene";
import { resetLimezuWallAtlasForTests } from "../src/art/limezu";
import { TILE } from "../src/floor/map";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

class PixelCtx {
  fillStyle = "#000000";
  readonly buf = new Uint8Array(FLOOR_W * FLOOR_H * 4);

  fillRect(x: number, y: number, w: number, h: number) {
    const color = this.fillStyle;
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    for (let py = Math.max(0, y); py < Math.min(FLOOR_H, y + h); py++) {
      for (let px = Math.max(0, x); px < Math.min(FLOOR_W, x + w); px++) {
        const i = (py * FLOOR_W + px) * 4;
        this.buf[i] = r;
        this.buf[i + 1] = g;
        this.buf[i + 2] = b;
        this.buf[i + 3] = 255;
      }
    }
  }
}

resetLimezuWallAtlasForTests();
const ctx = new PixelCtx();
drawFloorDivider(ctx as any);
drawStairs(ctx as any);

const y0 = 32 * TILE;
const y1 = 36 * TILE;
const band = ctx.buf.subarray(y0 * FLOOR_W * 4, y1 * FLOOR_W * 4);
const hash = createHash("sha256").update(band).digest("hex");
const alphaAt = (x: number, y: number) => ctx.buf[(y * FLOOR_W + x) * 4 + 3];

check("FLOOR_H 已隨 52 rows 更新為 832", FLOOR_H === 832);
check(
  "row 33 樓板切面橫跨完整 256px（樓梯開口由後續 dispatch 覆蓋）",
  Array.from({ length: FLOOR_W }, (_, x) => alphaAt(x, 33 * TILE)).every((a) => a === 255),
);
check(
  "樓梯恰佔 cols 7-8、rows 32-35 的 32x64 邊界",
  alphaAt(7 * TILE, 32 * TILE) === 255
    && alphaAt(9 * TILE - 1, 36 * TILE - 1) === 255
    && alphaAt(7 * TILE - 1, 32 * TILE) === 0
    && alphaAt(9 * TILE, 32 * TILE) === 0,
);
check(
  "CAFE-04 繪製不污染 rows 0-31 或 row 36 以下",
  ctx.buf.subarray(0, y0 * FLOOR_W * 4).every((v) => v === 0)
    && ctx.buf.subarray(y1 * FLOOR_W * 4).every((v) => v === 0),
);
check(
  "樓梯／切面 fallback 像素指紋固定",
  hash === "c9c90a8edb8ca21fed44c3c2ed3f5e43fe50348933089cc4c43d2004adf5a8bf",
  hash,
);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
