/**
 * 家具渲染器 —— 讀 FurnitureDef,畫在樓層/房間的 canvas 上。
 *
 * 兩條路徑:
 *  - sprite.kind   → 專屬繪圖函式(下方 KIND_DRAWERS,精緻)
 *  - sprite.recipe → 通用「零件清單」解譯器(純資料,新增家具零程式)
 */
import {
  type Ctx,
  ramp,
  shade,
  rect,
  block,
  groundShadow,
} from "../pixel/sprites";
import { TILE } from "../floor/map";
import { tryDrawLimezuFurniture } from "../art/limezu";
import type { FurnitureDef, FurnKind, SpritePart } from "./catalog";
import { normalizeRotation, type FurnitureRotation } from "./rotation";

/** 依 def 在 (x,y)=左上角像素 畫出家具 */
export function drawDef(ctx: Ctx, def: FurnitureDef, x: number, y: number, rotation: FurnitureRotation = 0) {
  const w = def.footprint.w * TILE;
  const h = def.footprint.h * TILE;
  const rot = normalizeRotation(rotation);
  if (rot !== 0) {
    ctx.save();
    ctx.translate(x, y);
    if (rot === 90) {
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rot === 180) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    } else {
      ctx.translate(0, w);
      ctx.rotate(-Math.PI / 2);
    }
    drawUnrotated(ctx, def, 0, 0, w, h);
    ctx.restore();
    return;
  }
  drawUnrotated(ctx, def, x, y, w, h);
}

function drawUnrotated(ctx: Ctx, def: FurnitureDef, x: number, y: number, w: number, h: number) {
  if (tryDrawLimezuFurniture(ctx, def.id, x, y, w, h)) return;
  if ("recipe" in def.sprite) {
    drawRecipe(ctx, def.sprite.recipe, x, y);
    return;
  }
  const drawer = KIND_DRAWERS[def.sprite.kind];
  if (drawer) drawer(ctx, x, y, w, h);
  // 同 kind 的主題家具再疊專屬像素細節,讓商店新品在樓層上不只是改名字。
  if (def.id === "canopy_bed") drawCanopyTrim(ctx, x, y, w, h);
  else if (def.id === "loveseat") drawLoveseatTrim(ctx, x, y, w, h);
  else if (def.id === "romantic_table") drawDateTableTrim(ctx, x, y, w, h);
}

function drawCanopyTrim(ctx: Ctx, x: number, y: number, w: number, h: number) {
  const frame = "#70465d";
  const cloth = "#d98ba5";
  rect(ctx, x + 1, y + 1, 2, h - 2, frame);
  rect(ctx, x + w - 3, y + 1, 2, h - 2, frame);
  rect(ctx, x + 1, y + 1, w - 2, 2, frame);
  rect(ctx, x + 3, y + 3, 4, h - 6, cloth);
  rect(ctx, x + w - 7, y + 3, 4, h - 6, cloth);
  rect(ctx, x + 4, y + 4, 1, h - 8, "#efb7c8");
}

function drawLoveseatTrim(ctx: Ctx, x: number, y: number, w: number, h: number) {
  rect(ctx, x + 2, y + h - 4, w - 4, 2, "#9d5571");
  rect(ctx, x + w - 10, y + 3, 6, 5, "#d5688d");
  rect(ctx, x + w - 8, y + 4, 2, 2, "#f1a9be");
}

function drawDateTableTrim(ctx: Ctx, x: number, y: number, w: number, h: number) {
  const cx = Math.floor(x + w / 2);
  const cy = Math.floor(y + h / 2);
  rect(ctx, cx - 1, cy - 4, 3, 4, "#f3d9b1");
  rect(ctx, cx, cy - 6, 1, 2, "#ffd66e");
  rect(ctx, cx - 5, cy + 2, 3, 2, "#c95f72");
  rect(ctx, cx + 3, cy + 2, 3, 2, "#c95f72");
}

/** 零件清單解譯器:未來新增方正家具完全不用寫程式 */
function drawRecipe(ctx: Ctx, parts: SpritePart[], ox: number, oy: number) {
  for (const p of parts) {
    if (p.shape === "block") {
      block(ctx, ox + p.x, oy + p.y, p.w, p.h, ramp(p.color), p.top ?? 3);
    } else {
      rect(ctx, ox + p.x, oy + p.y, p.w, p.h, p.color);
    }
  }
}

type Drawer = (ctx: Ctx, x: number, y: number, w: number, h: number) => void;

const KIND_DRAWERS: Partial<Record<FurnKind, Drawer>> = {
  bed(ctx, x, y, w, h) {
    const wood = ramp("#7a5636");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, wood, 2);
    rect(ctx, x + 4, y + 4, w - 8, 6, "#efe7d6");
    rect(ctx, x + 4, y + 4, w - 8, 2, "#fbf6ea");
    rect(ctx, x + 3, y + 12, w - 6, h - 16, "#7b83c8");
    rect(ctx, x + 3, y + 12, w - 6, 3, "#8a92d4");
    rect(ctx, x + 3, y + h - 5, w - 6, 1, "#5a62a4");
  },
  desk(ctx, x, y, w, h) {
    drawDesk(ctx, x, y, w, h, false);
  },
  mic_desk(ctx, x, y, w, h) {
    drawDesk(ctx, x, y, w, h, true);
  },
  tv(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    // 電視櫃
    block(ctx, x + 1, y + h - 8, w - 2, 7, ramp("#5b4636"), 2);
    // 螢幕
    block(ctx, x + 3, y + 1, w - 6, h - 9, ramp("#2a2740"), 2);
    rect(ctx, x + 5, y + 3, w - 10, h - 13, "#5a8fe0");
    rect(ctx, x + 6, y + 4, 6, 1, "#a8ccff");
    rect(ctx, x + 6, y + 6, 9, 1, "#cfe0ff");
    // 主機 + 指示燈
    rect(ctx, x + 4, y + h - 6, 8, 3, "#20202c");
    rect(ctx, x + 5, y + h - 5, 1, 1, "#6fd08c");
  },
  chair(ctx, x, y, w, h) {
    const wood = ramp("#8a6444");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 5);
    block(ctx, x + 3, y + 2, w - 6, 7, wood, 2);
    block(ctx, x + 2, y + 9, w - 4, 5, wood, 2);
    rect(ctx, x + 3, y + 13, 2, 3, wood.dark);
    rect(ctx, x + w - 5, y + 13, 2, 3, wood.dark);
  },
  beanbag(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 3);
    const c = ramp("#c46f7a");
    rect(ctx, x + 2, y + 5, w - 4, h - 6, c.mid);
    rect(ctx, x + 3, y + 4, w - 6, 3, c.hi);
    rect(ctx, x + 2, y + h - 3, w - 4, 1, c.dark);
    rect(ctx, x + 4, y + 7, w - 10, 2, c.light);
  },
  bookshelf(ctx, x, y, w, h) {
    const wood = ramp("#7a5636");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, wood, 2);
    const books = ["#b0567a", "#5d7fa3", "#6fd08c", "#ffd66e", "#c46f7a", "#7b83c8"];
    for (let shelf = 0; shelf < 3; shelf++) {
      const sy = y + 3 + shelf * ((h - 6) / 3);
      rect(ctx, x + 2, sy + (h - 6) / 3 - 2, w - 4, 1, wood.dark);
      for (let b = 0; b < w - 6; b += 3) {
        rect(ctx, x + 3 + b, sy, 2, (h - 6) / 3 - 3, books[(shelf * 3 + b) % books.length]);
      }
    }
  },
  wardrobe(ctx, x, y, w, h) {
    const wood = ramp("#6d5236");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, wood, 2);
    rect(ctx, x + w / 2, y + 3, 1, h - 6, wood.dark); // 對開門縫
    rect(ctx, x + w / 2 - 3, y + h / 2, 2, 1, "#ffd66e");
    rect(ctx, x + w / 2 + 2, y + h / 2, 2, 1, "#ffd66e");
  },
  dresser(ctx, x, y, w, h) {
    const wood = ramp("#7a5636");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 2, w - 2, h - 3, wood, 3);
    rect(ctx, x + 3, y + 6, w - 6, 1, shade("#7a5636", -30));
    rect(ctx, x + w / 2 - 1, y + 4, 2, 1, "#ffd66e");
    rect(ctx, x + w / 2 - 1, y + 9, 2, 1, "#ffd66e");
  },
  cat_tower(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 3);
    // 柱
    rect(ctx, x + w / 2 - 2, y + 4, 4, h - 6, "#b89a7a");
    // 平台
    block(ctx, x + 2, y + h - 8, w - 4, 5, ramp("#8a6a4c"), 2);
    block(ctx, x + 3, y + 1, w - 6, 5, ramp("#9c7a58"), 2);
    // 洞
    rect(ctx, x + w / 2 - 2, y + h - 14, 4, 5, "#3a2f26");
  },
  plant(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 8);
    rect(ctx, x + 5, y + 10, 6, 5, "#8a5a3a");
    rect(ctx, x + 5, y + 10, 6, 1, "#a06a46");
    rect(ctx, x + 6, y + 4, 4, 7, "#4e9e63");
    rect(ctx, x + 4, y + 6, 3, 4, "#57ab6d");
    rect(ctx, x + 9, y + 6, 3, 4, "#42925a");
  },
  lamp(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 7);
    rect(ctx, x + 7, y + 6, 2, 9, "#6a6f86"); // 燈桿
    rect(ctx, x + 5, y + 1, 6, 5, "#ffe9a8"); // 燈罩
    rect(ctx, x + 5, y + 1, 6, 1, "#fff4cc");
    rect(ctx, x + 5, y + 14, 6, 1, "#4a4d5c");
  },
  aroma(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 6);
    rect(ctx, x + 6, y + 9, 5, 5, "#d3ccdd"); // 機身
    rect(ctx, x + 6, y + 9, 5, 1, "#e6e0ee");
    rect(ctx, x + 8, y + 5, 1, 1, "#cfc8dd"); // 蒸氣
    rect(ctx, x + 7, y + 3, 1, 1, "#cfc8dd");
  },
  easel(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, 8);
    rect(ctx, x + 4, y + 2, 8, 9, "#e9e2d0"); // 畫布
    rect(ctx, x + 5, y + 3, 6, 3, "#b0567a");
    rect(ctx, x + 5, y + 7, 4, 2, "#5d7fa3");
    rect(ctx, x + 3, y + 3, 1, 12, "#6d5236"); // 腳架
    rect(ctx, x + 12, y + 3, 1, 12, "#6d5236");
    rect(ctx, x + 7, y + 11, 1, 4, "#6d5236");
  },
  sofa(ctx, x, y, w, h) {
    const fab = ramp("#c9a274");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, fab, 4);
    const seats = Math.max(2, Math.round(w / TILE));
    for (let i = 1; i < seats; i++)
      rect(ctx, x + 1 + (i * (w - 2)) / seats, y + 5, 1, h - 8, shade("#c9a274", -18));
    rect(ctx, x + 4, y + 3, 6, 5, "#b0567a");
  },
  dining_table(ctx, x, y, w, h) {
    const wood = ramp("#8a6444");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 3);
    // 桌面
    block(ctx, x + 3, y + 5, w - 6, h - 10, wood, 3);
    rect(ctx, x + 5, y + 7, w - 10, 2, shade("#8a6444", 22));
    // 四張椅子(俯視,凸出桌邊)
    const ch = ramp("#6d5236");
    block(ctx, x + 5, y + 1, w - 10, 4, ch, 2); // 上
    block(ctx, x + 5, y + h - 5, w - 10, 4, ch, 2); // 下
    block(ctx, x + 1, y + 6, 4, h - 12, ch, 2); // 左
    block(ctx, x + w - 5, y + 6, 4, h - 12, ch, 2); // 右
  },
  coffee_machine(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 9);
    block(ctx, x + 3, y + 4, 10, 11, ramp("#3f3a4e"), 2);
    rect(ctx, x + 5, y + 6, 6, 3, "#20202c"); // 面板
    rect(ctx, x + 6, y + 7, 1, 1, "#6fd08c");
    rect(ctx, x + 6, y + 11, 4, 3, "#cfc8dd"); // 咖啡杯位
  },
  bar(ctx, x, y, w, h) {
    const wood = ramp("#5b4636");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 4, w - 2, h - 5, wood, 3);
    rect(ctx, x + 1, y + 4, w - 2, 2, shade("#5b4636", 26)); // 檯面
    // 高腳椅
    rect(ctx, x + 4, y + 1, 3, 3, "#3a3450");
    rect(ctx, x + w - 7, y + 1, 3, 3, "#3a3450");
    rect(ctx, x + 5, y + 4, 1, 2, "#2c2840");
    rect(ctx, x + w - 6, y + 4, 1, 2, "#2c2840");
  },
  washer(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 9);
    block(ctx, x + 3, y + 3, 10, 12, ramp("#c9cdd8"), 2);
    rect(ctx, x + 5, y + 6, 6, 6, "#3a4258"); // 玻璃門
    rect(ctx, x + 6, y + 7, 4, 4, "#5a6a8a");
    rect(ctx, x + 5, y + 4, 3, 1, "#8a90a0"); // 面板
  },
  stove(ctx, x, y, w, h) {
    const m = ramp("#54596e");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, m, 3);
    rect(ctx, x + 4, y + 4, 4, 4, "#2c2840");
    rect(ctx, x + 9, y + 4, 3, 3, "#2c2840");
    rect(ctx, x + 5, y + 5, 2, 2, "#ff7d3a");
  },
  counter(ctx, x, y, w, h) {
    const m = ramp("#6a6f86");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 1, w - 2, h - 2, m, 4);
    rect(ctx, x + 1, y + 1, w - 2, 3, shade("#6a6f86", 24));
    rect(ctx, x + 6, y + 7, 4, 4, "#cfc8dd");
  },
  fridge(ctx, x, y, w, h) {
    const m = ramp("#c9cdd8");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 2, y + 1, w - 4, h - 2, m, 2);
    rect(ctx, x + 2, y + h / 2, w - 4, 1, shade("#c9cdd8", -25));
    rect(ctx, x + w - 5, y + 5, 1, 4, "#8a90a0");
    rect(ctx, x + w - 5, y + h / 2 + 3, 1, 4, "#8a90a0");
  },
  table(ctx, x, y, w, h) {
    const wood = ramp("#8a6444");
    groundShadow(ctx, x + w / 2, y + h - 1, w - 3);
    block(ctx, x + 3, y + 3, w - 6, h - 6, wood, 3);
    rect(ctx, x + 5, y + 5, w - 10, 2, shade("#8a6444", 22));
  },
  rug(ctx, x, y, w, h) {
    rect(ctx, x + 1, y + 1, w - 2, h - 2, "#8a5a6e");
    rect(ctx, x + 4, y + 4, w - 8, h - 8, "#9c6a7e");
    rect(ctx, x + 7, y + 7, w - 14, h - 14, "#7d4f61");
    for (let i = x + 3; i < x + w - 2; i += 4) {
      rect(ctx, i, y, 2, 1, "#6e4557");
      rect(ctx, i, y + h - 1, 2, 1, "#6e4557");
    }
  },
  mat(ctx, x, y, w, h) {
    rect(ctx, x + 1, y + 4, w - 2, h - 7, "#5b6b8a");
    rect(ctx, x + 3, y + 6, w - 6, h - 11, "#6d7d9c");
  },
  toilet(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 8);
    // 水箱
    block(ctx, x + 4, y + 1, 8, 4, ramp("#dfe4ea"), 1);
    // 座體 + 蓋
    block(ctx, x + 4, y + 5, 8, 8, ramp("#eef2f6"), 2);
    rect(ctx, x + 5, y + 7, 6, 5, "#c6ccd4"); // 座圈
    rect(ctx, x + 6, y + 8, 4, 3, "#aeb6c0"); // 內圈
  },
  sink(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 8);
    block(ctx, x + 3, y + 6, 10, 8, ramp("#dfe4ea"), 2);
    rect(ctx, x + 5, y + 8, 6, 3, "#aeb6c0"); // 盆
    rect(ctx, x + 7, y + 3, 2, 4, "#9aa0a8"); // 水龍頭
    rect(ctx, x + 7, y + 3, 3, 1, "#9aa0a8");
    // 鏡子(牆上)
    rect(ctx, x + 5, y, 6, 3, "#8fd0ff");
  },
  bathtub(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    block(ctx, x + 1, y + 2, w - 2, h - 3, ramp("#e6ebf0"), 3);
    rect(ctx, x + 3, y + 4, w - 6, h - 7, "#a9d6ec"); // 水面
    rect(ctx, x + 4, y + 5, w - 10, 1, "#c6e6f4"); // 高光
    rect(ctx, x + w - 5, y + 4, 2, 3, "#9aa0a8"); // 水龍頭
  },
  shower(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    // 磁磚後牆(濕區)
    block(ctx, x + 1, y + 1, w - 2, h - 4, ramp("#8fb2c4"), 2);
    for (let ty = y + 3; ty < y + h - 4; ty += 4) rect(ctx, x + 2, ty, w - 4, 1, "#7ba0b4");
    for (let tx = x + 5; tx < x + w - 2; tx += 5) rect(ctx, tx, y + 2, 1, h - 7, "#7ba0b4");
    // 蓮蓬頭 + 水線
    rect(ctx, x + 4, y + 1, 4, 2, "#9aa0a8");
    rect(ctx, x + 5, y + 3, 1, 4, "#bfe0f0");
    rect(ctx, x + 6, y + 4, 1, 5, "#bfe0f0");
    // 地面排水 + 積水高光
    rect(ctx, x + w / 2 - 2, y + h - 5, 4, 2, "#6b8a9a");
    // 玻璃隔間門(半透明藍,前緣)
    rect(ctx, x + 1, y + h - 4, w - 2, 3, "rgba(180,220,240,0.45)");
    rect(ctx, x + 1, y + h - 4, w - 2, 1, "#dff0f8");
    rect(ctx, x + w - 3, y + 2, 2, h - 5, "rgba(200,230,245,0.5)"); // 玻璃側框反光
  },
  drying_rack(ctx, x, y, w, h) {
    groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
    // 橫桿
    rect(ctx, x + 2, y + 3, w - 4, 1, "#9aa0b4");
    rect(ctx, x + 2, y + 3, 1, h - 5, "#8a90a4"); // 兩側支架
    rect(ctx, x + w - 3, y + 3, 1, h - 5, "#8a90a4");
    // 掛著的衣服
    const clothes = ["#b0567a", "#5d7fa3", "#6fd08c", "#ffd66e", "#c46f7a"];
    for (let i = 0, cx = x + 4; cx < x + w - 4; i++, cx += 4) {
      rect(ctx, cx, y + 4, 3, h - 8, clothes[i % clothes.length]);
      rect(ctx, cx, y + 4, 3, 1, "#e9e4f2");
    }
  },
  laundry_basket(ctx, x, y) {
    groundShadow(ctx, x + TILE / 2, y + TILE - 1, 8);
    block(ctx, x + 3, y + 7, 10, 7, ramp("#c8a878"), 2);
    // 編織紋
    rect(ctx, x + 3, y + 9, 10, 1, "#a8895e");
    rect(ctx, x + 3, y + 11, 10, 1, "#a8895e");
    // 冒出的衣服
    rect(ctx, x + 5, y + 4, 4, 4, "#b0567a");
    rect(ctx, x + 8, y + 5, 3, 3, "#5d7fa3");
  },
};

function drawDesk(ctx: Ctx, x: number, y: number, w: number, h: number, mic: boolean) {
  const wood = ramp("#4b4266");
  groundShadow(ctx, x + w / 2, y + h - 1, w - 2);
  block(ctx, x + 1, y + 3, w - 2, h - 4, wood, 2);
  const on = "#7db4ff";
  rect(ctx, x + 4, y + 1, 10, 6, "#181225");
  rect(ctx, x + 5, y + 2, 8, 4, on);
  if (w >= 32) {
    rect(ctx, x + 16, y + 1, 9, 6, "#181225");
    rect(ctx, x + 17, y + 2, 7, 4, shade(on, -18));
  }
  if (mic) {
    rect(ctx, x + w - 6, y + 2, 2, 6, "#9aa0b4");
    rect(ctx, x + w - 8, y - 1, 6, 4, "#2c2840");
    rect(ctx, x + w - 4, y - 1, 1, 1, "#ff4d5e");
  }
}
