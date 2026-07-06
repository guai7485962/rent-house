/**
 * 樓層地圖渲染器(正俯視 3/4,嚴格對齊 tile 網格)
 * 純函式:FloorMap.vue 在 canvas 呼叫,scripts/render-floor.ts 離線預覽。
 */
import {
  type Ctx,
  type Palette,
  BASE_PAL,
  ramp,
  shade,
  rect,
  box,
  block,
  groundShadow,
  drawSprite,
  CHAR_STAND,
  CHAR_WALK_A,
  CHAR_WALK_B,
} from "../pixel/sprites";
import type { Agent } from "./agents";
import { getTheme } from "../pixel/scene";
import { TILE, GRID_W, GRID_H, buildGrid, TENANT_SPOTS } from "./map";
import { getDef } from "../furniture/catalog";
import { drawDef } from "../furniture/render";
import { getPlacements } from "../sim/placements";

export const FLOOR_W = GRID_W * TILE; // 256
export const FLOOR_H = GRID_H * TILE; // 384

const GRID = buildGrid();

/** 各區地板底色(讓 4 房 + 大廳一眼可分) */
const FLOOR_TINT: Record<string, string> = {
  r301: "#b08a5e", // 暖木(工程師)
  r302: "#b6926a", // 略帶粉的暖木(實況主)
  r303: "#8f8676", // 灰(空房)
  r304: "#8f8676",
  lounge: "#a5825a", // 交誼廳
  bathroom: "#8ea6b0", // 藍灰磁磚(浴室)
  laundry: "#9aa2a8", // 灰磁磚(洗衣間)
  door: "#9a7a52",
  entrance: "#8a6a44",
};

/** 磁磚地板的區域(方格縫,而非木紋)*/
const TILED: Record<string, true> = { bathroom: true, laundry: true };

function charPalette(tenantId: string): Palette {
  const t = getTheme(tenantId);
  return {
    ...BASE_PAL,
    h: t.hair,
    H: shade(t.hair, 26),
    F: t.skin,
    f: shade(t.skin, -16),
    t: t.shirt,
    T: shade(t.shirt, 20),
    j: shade(t.shirt, -22),
    d: t.pants,
    D: shade(t.pants, -22),
  };
}

export function composeFloor(ctx: Ctx, frame: number, agents?: Agent[]) {
  rect(ctx, 0, 0, FLOOR_W, FLOOR_H, "#0d0c12");

  drawFloorTiles(ctx);
  drawWalls(ctx);
  drawEntrance(ctx);

  // 家具:讀 PLACEMENTS(id+座標)→ 查目錄 → drawDef。
  // 由上而下(r 由小到大)繪製,讓前方物件蓋住後方。
  const sorted = [...getPlacements()].sort((a, b) => a.r - b.r);
  for (const p of sorted) drawDef(ctx, getDef(p.defId), p.c * TILE, p.r * TILE);

  if (agents) {
    // 依 y 排序,讓靠下(近鏡頭)的人蓋住上方;外出者不畫
    for (const a of [...agents].sort((x, y) => x.py - y.py)) {
      if (!a.hidden) drawAgent(ctx, a);
    }
  } else {
    // 離線預覽:靜態站立
    for (const spot of TENANT_SPOTS) {
      const px = spot.c * TILE;
      const py = spot.r * TILE;
      groundShadow(ctx, px + TILE / 2, py + TILE - 1, 11);
      drawSprite(ctx, CHAR_STAND, px + 3, py - 4 - (frame % 2), charPalette(spot.tenantId));
    }
  }
}

function drawAgent(ctx: Ctx, a: Agent) {
  groundShadow(ctx, a.px + TILE / 2, a.py + TILE - 1, 11);
  let sprite = CHAR_STAND;
  let yoff = 0;
  if (a.moving) {
    const step = Math.floor(a.walkPhase) % 2 === 0;
    sprite = step ? CHAR_WALK_A : CHAR_WALK_B;
    yoff = step ? 0 : -1; // 走路上下彈跳
  }
  drawSprite(ctx, sprite, a.px + 3, a.py - 4 + yoff, charPalette(a.tenantId));
}

// ---------------------------------------------------------------------------
// 地板
// ---------------------------------------------------------------------------

function drawFloorTiles(ctx: Ctx) {
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const cell = GRID[r][c];
      if (cell === "wall") continue;
      const x = c * TILE;
      const y = r * TILE;
      const base = FLOOR_TINT[cell] ?? "#a5825a";
      // 棋盤微差
      const tint = (c + r) % 2 === 0 ? 0 : -4;
      rect(ctx, x, y, TILE, TILE, shade(base, tint));
      // tile 縫
      rect(ctx, x, y, TILE, 1, shade(base, -14));
      rect(ctx, x, y, 1, TILE, shade(base, -10));
      if (TILED[cell]) {
        // 磁磚:半格再切一次,呈現方格
        rect(ctx, x + TILE / 2, y, 1, TILE, shade(base, -10));
        rect(ctx, x, y + TILE / 2, TILE, 1, shade(base, -12));
      } else {
        // 木板橫紋
        rect(ctx, x, y + 8, TILE, 1, shade(base, -8));
      }
    }
  }
  // 門檻 / 大門地墊
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++) {
      if (GRID[r][c] === "door") {
        const x = c * TILE, y = r * TILE;
        rect(ctx, x + 2, y + 2, TILE - 4, TILE - 4, "#7a5c3a");
        rect(ctx, x + 2, y + 2, TILE - 4, 2, "#8a6c48");
      }
      if (GRID[r][c] === "entrance") {
        const x = c * TILE, y = r * TILE;
        rect(ctx, x + 1, y + 3, TILE - 2, TILE - 5, "#4d3d2a");
        rect(ctx, x + 3, y + 5, TILE - 6, 1, "#6d5540");
      }
    }
}

/** 大門(樓層出入口):明顯的雙開木門 */
function drawEntrance(ctx: Ctx) {
  let minC = GRID_W, maxC = -1, rr = -1;
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++)
      if (GRID[r][c] === "entrance") {
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        rr = r;
      }
  if (rr < 0) return;
  const x = minC * TILE;
  const y = rr * TILE;
  const w = (maxC - minC + 1) * TILE;
  const h = TILE;
  const wood = ramp("#8a6a44");
  // 門框
  box(ctx, x - 1, y - 2, w + 2, h + 2, wood.dark, "#2c2018");
  // 兩扇門板
  block(ctx, x, y, w / 2, h, wood, 2);
  block(ctx, x + w / 2, y, w / 2, h, wood, 2);
  rect(ctx, x + 2, y + 2, w / 2 - 4, h - 4, shade("#8a6a44", -20)); // 凹格
  rect(ctx, x + w / 2 + 2, y + 2, w / 2 - 4, h - 4, shade("#8a6a44", -20));
  // 金色對開把手
  rect(ctx, x + w / 2 - 2, y + h / 2 - 1, 2, 3, "#ffd66e");
  rect(ctx, x + w / 2, y + h / 2 - 1, 2, 3, "#ffd66e");
  // 門外暖光(底緣透出)
  rect(ctx, x, y + h - 1, w, 1, "#ffe9a8");
  rect(ctx, x + 1, y - 2, w - 2, 1, shade("#8a6a44", 20));
}

// ---------------------------------------------------------------------------
// 牆(俯視 3/4:牆體 + 南面稍矮的正面,製造厚度)
// ---------------------------------------------------------------------------

function drawWalls(ctx: Ctx) {
  const wallTop = "#5b5470";
  const wallFace = "#413a55";
  const wallHi = "#6e6688";
  const wallSh = "#2c2740";
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (GRID[r][c] !== "wall") continue;
      const x = c * TILE;
      const y = r * TILE;
      const below = r + 1 < GRID_H ? GRID[r + 1][c] : "outside";
      const faceVisible = below !== "wall"; // 牆南側露出正面
      rect(ctx, x, y, TILE, TILE, wallTop);
      rect(ctx, x, y, TILE, 2, wallHi); // 頂面高光
      rect(ctx, x, y, 1, TILE, shade(wallTop, 8));
      if (faceVisible) {
        // 南面正面(有厚度感)
        rect(ctx, x, y + TILE - 6, TILE, 6, wallFace);
        rect(ctx, x, y + TILE - 6, TILE, 1, shade(wallFace, 14));
        rect(ctx, x, y + TILE - 1, TILE, 1, wallSh);
      } else {
        rect(ctx, x, y + TILE - 1, TILE, 1, wallSh);
      }
    }
  }
}
