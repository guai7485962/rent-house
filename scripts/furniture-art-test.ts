/** 301 三件程序家具的像素邊界與辨識特徵回歸。 */
import { getDef } from "../src/furniture/catalog";
import { drawDef } from "../src/furniture/render";

interface FillCall {
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

class RecorderCtx {
  fillStyle = "";
  globalAlpha = 1;
  fills: FillCall[] = [];
  saves = 0;
  restores = 0;
  rotations: number[] = [];
  translations: Array<[number, number]> = [];

  fillRect(x: number, y: number, w: number, h: number) {
    this.fills.push({ color: String(this.fillStyle), x, y, w, h });
  }
  save() { this.saves++; }
  restore() { this.restores++; }
  translate(x: number, y: number) { this.translations.push([x, y]); }
  rotate(radians: number) { this.rotations.push(radians); }
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}`);
  }
}

function hasFill(calls: FillCall[], color: string, x: number, y: number, w: number, h: number) {
  return calls.some((call) => call.color === color
    && call.x === x && call.y === y && call.w === w && call.h === h);
}

const cases = [
  { id: "beanbag", width: 16, height: 16 },
  { id: "tv_console", width: 32, height: 16 },
  { id: "cat_tower", width: 16, height: 32 },
] as const;

for (const item of cases) {
  const ctx = new RecorderCtx();
  drawDef(ctx as any, getDef(item.id), 0, 0, 0);
  check(`${item.id} 有程序像素輸出`, ctx.fills.length > 0);
  check(`${item.id} 只使用整數像素`, ctx.fills.every((call) =>
    [call.x, call.y, call.w, call.h].every(Number.isInteger)));
  check(`${item.id} 本體與接地陰影不超出允許畫框`, ctx.fills.every((call) =>
    call.w > 0 && call.h > 0
    && call.x >= 0 && call.x + call.w <= item.width
    && call.y >= 0 && call.y + call.h <= item.height + 2));

  for (const rotation of [90, 180, 270] as const) {
    const rotated = new RecorderCtx();
    drawDef(rotated as any, getDef(item.id), 0, 0, rotation);
    check(`${item.id} ${rotation} 度沿用安全 Canvas transform`,
      rotated.fills.length === ctx.fills.length
      && rotated.saves === 1 && rotated.restores === 1
      && rotated.rotations.length === 1 && rotated.translations.length === 2);
  }
}

const beanbag = new RecorderCtx();
drawDef(beanbag as any, getDef("beanbag"), 0, 0);
check("懶骨頭具有上窄下寬的鬆軟色塊",
  hasFill(beanbag.fills, "#b96f74", 4, 9, 8, 4)
  && beanbag.fills.some((call) => call.x === 2 && call.w === 12));

const tv = new RecorderCtx();
drawDef(tv as any, getDef("tv_console"), 0, 0);
check("電視櫃具有薄螢幕與獨立遊戲主機",
  hasFill(tv.fills, "#608fbd", 5, 3, 18, 4)
  && hasFill(tv.fills, "#d8d4cb", 24, 4, 5, 8));
check("電視櫃具有可辨識控制器按鍵",
  hasFill(tv.fills, "#7da6cc", 7, 11, 1, 1)
  && hasFill(tv.fills, "#d9818f", 10, 11, 1, 1));

const catTower = new RecorderCtx();
drawDef(catTower as any, getDef("cat_tower"), 0, 0);
check("貓跳台具有貓洞而非書架輪廓",
  hasFill(catTower.fills, "#322a29", 9, 21, 4, 5)
  && catTower.fills.some((call) => call.x === 10 && call.y === 5 && call.w === 3 && call.h === 22));
check("貓跳台具有垂掛玩具",
  hasFill(catTower.fills, "#d28b63", 1, 20, 3, 3));

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
