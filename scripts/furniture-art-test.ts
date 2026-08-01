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
  { id: "lounge_tv", width: 32, height: 16 },
  { id: "lounge_console", width: 32, height: 16 },
  { id: "wood_chair", width: 16, height: 16 },
  { id: "plastic_stool", width: 16, height: 16 },
  { id: "loveseat", width: 32, height: 16 },
  { id: "shared_sofa", width: 48, height: 16 },
  { id: "cat_tower", width: 16, height: 32 },
  { id: "dog_bed", width: 32, height: 16 },
  { id: "chew_toy", width: 16, height: 16 },
  { id: "pee_pad", width: 16, height: 16 },
  { id: "cafe_counter", width: 32, height: 16 },
  { id: "espresso_machine", width: 16, height: 16 },
  { id: "cafe_display_stocked", width: 16, height: 32 },
  { id: "cafe_menu_board", width: 32, height: 32 },
  { id: "cafe_table", width: 16, height: 32 },
  { id: "cafe_chair_front", width: 16, height: 16 },
  { id: "cafe_chair_side", width: 16, height: 16 },
  { id: "cafe_cat_tower", width: 32, height: 32 },
  { id: "cafe_pet_cushion", width: 32, height: 16 },
  { id: "cafe_stock_shelf", width: 32, height: 16 },
  { id: "cafe_crate", width: 16, height: 16 },
  { id: "cafe_fridge", width: 16, height: 32 },
] as const;

check("三件狗狗家具的價格、尺寸與房內擺放設定正確",
  getDef("dog_bed").price === 2600
  && getDef("dog_bed").footprint.w === 2
  && getDef("dog_bed").placement === "room"
  && getDef("chew_toy").price === 900
  && getDef("pee_pad").price === 600);
check("功能型寵物家具會向玩家揭露實際效果",
  getDef("cat_tower").effectHint === "貓咪破壞機率 -70%"
  && getDef("litter_box").effectHint === "貓咪如廁意外 -85%"
  && getDef("chew_toy").effectHint === "狗狗破壞機率 -75%"
  && getDef("pee_pad").effectHint === "狗狗如廁意外 -85%");

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
  hasFill(tv.fills, "#477ca8", 4, 3, 17, 5)
  && hasFill(tv.fills, "#d8d4cb", 25, 3, 5, 9));
check("電視櫃具有可辨識控制器按鍵",
  hasFill(tv.fills, "#7da6cc", 7, 11, 1, 1)
  && hasFill(tv.fills, "#d9818f", 10, 11, 1, 1));

const loungeTv = new RecorderCtx();
drawDef(loungeTv as any, getDef("lounge_tv"), 0, 0);
check("交誼廳大電視具有滿版螢幕、聲霸與遙控器",
  hasFill(loungeTv.fills, "#345b78", 3, 3, 26, 5)
  && hasFill(loungeTv.fills, "#242936", 8, 11, 16, 2)
  && hasFill(loungeTv.fills, "#b9a57e", 27, 12, 2, 1));

const motionConsole = new RecorderCtx();
drawDef(motionConsole as any, getDef("lounge_console"), 0, 0);
check("體感遊戲機具有雙色感應條與兩支動態手把",
  hasFill(motionConsole.fills, "#171c29", 9, 9, 14, 2)
  && hasFill(motionConsole.fills, "#4aa9b2", 5, 11, 3, 3)
  && hasFill(motionConsole.fills, "#b45f96", 24, 11, 3, 3));
check("三款電視使用不同主畫面色與用途配件",
  hasFill(tv.fills, "#477ca8", 4, 3, 17, 5)
  && hasFill(loungeTv.fills, "#345b78", 3, 3, 26, 5)
  && hasFill(motionConsole.fills, "#54508a", 4, 3, 24, 5));

const woodChair = new RecorderCtx();
drawDef(woodChair as any, getDef("wood_chair"), 0, 0);
check("木質單椅具有鏤空直條椅背與四像素椅腳",
  hasFill(woodChair.fills, "#8a6444", 6, 3, 2, 4)
  && hasFill(woodChair.fills, "#8a6444", 9, 3, 2, 4)
  && woodChair.fills.some((call) => call.x === 3 && call.y === 12 && call.w === 2 && call.h === 4));

const plasticStool = new RecorderCtx();
drawDef(plasticStool as any, getDef("plastic_stool"), 0, 0);
check("塑膠椅凳具有藍綠弧面座與張開椅腳",
  hasFill(plasticStool.fills, "#3f9da0", 3, 5, 10, 4)
  && hasFill(plasticStool.fills, "#a6ded1", 5, 6, 6, 1)
  && hasFill(plasticStool.fills, "#23575f", 3, 15, 3, 1));
check("木椅與塑膠椅凳不再共用材質或輪廓",
  !woodChair.fills.some((call) => call.color === "#3f9da0")
  && !plasticStool.fills.some((call) => call.color === "#8a6444"));

const loveseat = new RecorderCtx();
drawDef(loveseat as any, getDef("loveseat"), 0, 0);
check("戀人雙人沙發具有雙座分界與兩色抱枕",
  hasFill(loveseat.fills, "#b96882", 4, 8, 11, 4)
  && hasFill(loveseat.fills, "#b96882", 17, 8, 11, 4)
  && hasFill(loveseat.fills, "#e6b0a8", 6, 5, 5, 3)
  && hasFill(loveseat.fills, "#815a91", 21, 5, 5, 3));

const sharedSofa = new RecorderCtx();
drawDef(sharedSofa as any, getDef("shared_sofa"), 0, 0);
check("共用沙發具有三個獨立坐墊與寬版藍綠輪廓",
  hasFill(sharedSofa.fills, "#5d8e90", 5, 8, 11, 4)
  && hasFill(sharedSofa.fills, "#56878a", 18, 8, 11, 4)
  && hasFill(sharedSofa.fills, "#5d8e90", 31, 8, 11, 4)
  && hasFill(sharedSofa.fills, "#d9a36f", 7, 5, 5, 3));

const catTower = new RecorderCtx();
drawDef(catTower as any, getDef("cat_tower"), 0, 0);
check("貓跳台具有貓洞而非書架輪廓",
  hasFill(catTower.fills, "#322a29", 9, 21, 4, 5)
  && catTower.fills.some((call) => call.x === 10 && call.y === 5 && call.w === 3 && call.h === 22));
check("貓跳台具有垂掛玩具",
  hasFill(catTower.fills, "#d28b63", 1, 20, 3, 3));

const dogBed = new RecorderCtx();
drawDef(dogBed as any, getDef("dog_bed"), 0, 0);
check("狗狗睡墊有柔軟內墊與骨頭徽記",
  hasFill(dogBed.fills, "#ead0ae", 8, 7, 16, 6)
  && hasFill(dogBed.fills, "#f5ead3", 14, 8, 4, 2));

const chewToy = new RecorderCtx();
drawDef(chewToy as any, getDef("chew_toy"), 0, 0);
check("耐咬玩具有紅色橡膠骨頭輪廓",
  hasFill(chewToy.fills, "#70352c", 5, 7, 7, 3)
  && chewToy.fills.some((call) => call.x === 2 && call.y === 8));

const peePad = new RecorderCtx();
drawDef(peePad as any, getDef("pee_pad"), 0, 0);
check("寵物尿墊有藍邊與吸水內層",
  hasFill(peePad.fills, "#a9c6d2", 2, 5, 12, 8)
  && hasFill(peePad.fills, "#eef3ea", 3, 6, 10, 6));

const cafeCounter = new RecorderCtx();
drawDef(cafeCounter as any, getDef("cafe_counter"), 0, 0);
check("咖啡廳吧台 fallback 具有粉色檯面與獨立收銀區",
  hasFill(cafeCounter.fills, "#e3a1ac", 2, 5, 28, 2)
  && hasFill(cafeCounter.fills, "#4b4658", 21, 2, 7, 4));

const cafeFridge = new RecorderCtx();
drawDef(cafeFridge as any, getDef("cafe_fridge"), 0, 0);
check("咖啡廳冷藏櫃 fallback 具有上下雙冷藏窗",
  hasFill(cafeFridge.fills, "#7896a4", 4, 5, 8, 10)
  && hasFill(cafeFridge.fills, "#7896a4", 4, 18, 8, 9));

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
