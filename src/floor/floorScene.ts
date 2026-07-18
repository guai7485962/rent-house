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
  CHAR_SIT,
} from "../pixel/sprites";
import type { Agent } from "./agents";
import type { PetAgent } from "./petAgents";
import { activeFx, type Fx } from "./fx";
import { getTheme, getCustomAppearance } from "../pixel/scene";
import { drawAppearanceOverlay } from "../pixel/parts";
import { TILE, GRID_W, GRID_H, buildGrid, TENANT_SPOTS } from "./map";
import { getDef } from "../furniture/catalog";
import { drawDef } from "../furniture/render";
import { getPlacements } from "../sim/placements";
import type { FurnitureRotation } from "../furniture/rotation";
import { tryDrawLimezuR301Floor } from "../art/limezu";

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

/** 樓層警示標記(維修系統等):在某格上方畫閃爍的警告小圖示 */
export interface FloorMark {
  c: number;
  r: number;
}

/** 日夜色調(工作項 9):依遊戲小時回傳疊在整個樓層上的色調;白天 null = 不疊 */
export function dayNightTint(hour: number): { color: string; alpha: number } | null {
  if (hour >= 21 || hour <= 4) return { color: "#141840", alpha: 0.32 }; // 深夜:靛藍
  if (hour <= 6) return { color: "#5a3c6e", alpha: 0.18 }; // 拂曉:紫粉
  if (hour <= 15) return null; // 白天
  if (hour <= 17) return { color: "#ff9a4d", alpha: 0.1 }; // 傍晚:斜陽
  if (hour <= 19) return { color: "#7c4630", alpha: 0.16 }; // 黃昏:暖褐
  return { color: "#141840", alpha: 0.24 }; // 入夜
}

export function composeFloor(ctx: Ctx, frame: number, agents?: Agent[], marks?: FloorMark[], hour?: number, pets?: PetAgent[]) {
  rect(ctx, 0, 0, FLOOR_W, FLOOR_H, "#0d0c12");

  drawFloorTiles(ctx);
  drawR301FloorOverlay(ctx);
  drawWalls(ctx);
  drawEntrance(ctx);

  // 家具:讀 PLACEMENTS(id+座標)→ 查目錄 → drawDef。
  // 由上而下(r 由小到大)繪製,讓前方物件蓋住後方。
  const sorted = [...getPlacements()].sort((a, b) => a.r - b.r);
  for (const p of sorted) drawDef(ctx, getDef(p.defId), p.c * TILE, p.r * TILE, p.rotation ?? 0);

  if (agents || pets) {
    // 人與貓依 y 混排,讓靠下(近鏡頭)的蓋住上方;外出者不畫
    const items: { y: number; draw: () => void }[] = [];
    const catPairs = activeCatPairs(pets ?? []);
    for (const [a, b] of catPairs) {
      items.push({ y: Math.min(a.py, b.py) + 2, draw: () => drawCatPairGround(ctx, a, b, frame) });
    }
    for (const a of agents ?? []) {
      if (a.hidden) continue;
      items.push({ y: a.py, draw: () => { drawAgent(ctx, a); drawAmbient(ctx, a, frame); } });
    }
    for (const p of pets ?? []) items.push({ y: p.py + 4, draw: () => drawCat(ctx, p, frame) });
    for (const it of items.sort((m, n) => m.y - n.y)) it.draw();
    for (const [a, b] of catPairs) drawCatPairAction(ctx, a, b, frame);
    for (const f of activeFx()) drawFx(ctx, f, frame); // 互動/事件演出(愛心/怒氣/心碎/對話)
  } else {
    // 離線預覽:靜態站立
    for (const spot of TENANT_SPOTS) {
      const px = spot.c * TILE;
      const py = spot.r * TILE;
      groundShadow(ctx, px + TILE / 2, py + TILE - 1, 11);
      drawSprite(ctx, CHAR_STAND, px + 3, py - 4 - (frame % 2), charPalette(spot.tenantId));
    }
  }

  // 日夜色調(工作項 9;疊在場景之上、警示之下——警示要保持醒目)
  const tint = hour != null ? dayNightTint(hour) : null;
  if (tint) {
    ctx.save();
    ctx.globalAlpha = tint.alpha;
    ctx.fillStyle = tint.color;
    ctx.fillRect(0, 0, FLOOR_W, FLOOR_H);
    ctx.restore();
  }
  if (marks) for (const m of marks) drawWarnMark(ctx, m, frame); // 設備故障等警示(§7-1)
}

/** 擺放/移動預覽:半透明 footprint 疊在地圖上(可放=綠、不可=紅),再點確認才成交 */
export function drawFootprintPreview(ctx: Ctx, c: number, r: number, w: number, h: number, ok: boolean, rotation: FurnitureRotation = 0) {
  const x = c * TILE;
  const y = r * TILE;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = ok ? "#5ad06a" : "#e5395a";
  ctx.fillRect(x, y, w * TILE, h * TILE);
  ctx.restore();
  ctx.strokeStyle = ok ? "#b6ffbe" : "#ffb3c1";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w * TILE - 1, h * TILE - 1);
  // 中央方向箭頭；正方形家具旋轉時也看得出朝向。
  const cx = x + (w * TILE) / 2;
  const cy = y + (h * TILE) / 2;
  ctx.fillStyle = ok ? "#d9ffdc" : "#ffd7df";
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.fillRect(-1, -6, 2, 9);
  ctx.fillRect(-4, -6, 8, 2);
  ctx.fillRect(-3, -4, 6, 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 演出層(設計檢討 §10-4):互動特效 + 隨狀態的環境演出
// ---------------------------------------------------------------------------

/** 依 pattern 畫 1px 像素圖("X" = 上色) */
function pxPat(ctx: Ctx, pattern: string[], x: number, y: number, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let r = 0; r < pattern.length; r++)
    for (let c = 0; c < pattern[r].length; c++)
      if (pattern[r][c] === "X") ctx.fillRect(x + c, y + r, 1, 1);
  ctx.restore();
}

const PAT_HEART = [".X.X.", "XXXXX", ".XXX.", "..X.."];
const PAT_BANG = ["X", "X", "X", ".", "X"]; // 驚嘆號

/** 設備故障警示:黃色三角 + 驚嘆號,慢閃(§7-1 讓「壞掉」在樓層一眼看到) */
function drawWarnMark(ctx: Ctx, m: { c: number; r: number }, frame: number) {
  if (frame % 3 === 2) return; // 閃爍:亮兩拍、暗一拍
  const x = m.c * TILE + 2; // 三角頂點的中心欄
  const y = m.r * TILE - 10;
  // 深色底三角(當描邊)+ 黃色內三角
  ctx.fillStyle = "#5c4300";
  for (let row = 0; row < 9; row++) {
    const half = Math.ceil(((row + 1) / 9) * 6);
    ctx.fillRect(x + 6 - half, y + row, half * 2 - 1, 1);
  }
  ctx.fillStyle = "#ffd23e";
  for (let row = 2; row < 8; row++) {
    const half = Math.max(1, Math.ceil(((row + 1) / 9) * 6) - 1);
    ctx.fillRect(x + 6 - half, y + row, half * 2 - 1, 1);
  }
  pxPat(ctx, PAT_BANG, x + 6, y + 3, "#5c4300");
}
const PAT_CRACK = ["..X..", ".X...", "..X..", ".X..."];
const PAT_ANGER = ["X...X", ".X.X.", ".....", ".X.X.", "X...X"];
const PAT_Z = ["XXX", ".X.", "XXX"];
const PAT_STAR = ["..X..", ".XXX.", "XX.XX", ".XXX.", "..X.."];
const PAT_NOTE = [".XX", ".X.", ".X.", "XX."];

/** 互動/事件演出:掛在格子上方,輕微上下漂 */
function drawFx(ctx: Ctx, f: Fx, frame: number) {
  const x = f.c * TILE;
  const y = f.r * TILE;
  const bob = frame % 3;
  if (f.kind === "hearts") {
    pxPat(ctx, PAT_HEART, x + 2, y - 9 - bob, "#ff6b9d");
    pxPat(ctx, PAT_HEART, x + 9, y - 13 - ((frame + 1) % 3), "#ff9ec2", 0.9);
  } else if (f.kind === "heartbreak") {
    pxPat(ctx, PAT_HEART, x + 5, y - 11 - (frame % 2), "#9aa0aa");
    pxPat(ctx, PAT_CRACK, x + 5, y - 11 - (frame % 2), "#3a3d46");
  } else if (f.kind === "anger") {
    pxPat(ctx, PAT_ANGER, x + 5, y - 11, frame % 2 ? "#ff5a5a" : "#ff9a7a");
  } else if (f.kind === "chat") {
    // 小對話泡泡 + 閃爍的點點
    ctx.fillStyle = "#f5f2ea";
    ctx.fillRect(x + 3, y - 10, 9, 6);
    ctx.fillRect(x + 5, y - 4, 2, 1); // 泡泡尾巴
    ctx.fillStyle = "#6a6456";
    const dots = frame % 2 ? 3 : 2;
    for (let i = 0; i < dots; i++) ctx.fillRect(x + 5 + i * 2, y - 8, 1, 1);
  } else if (f.kind === "steam") {
    // 霧氣(遮蔽式演出:一起洗澡等)
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(x + 1, y - 6 - bob, 3, 3);
    ctx.fillRect(x + 7, y - 11 - ((frame + 1) % 3), 3, 3);
    ctx.fillRect(x + 12, y - 5 - ((frame + 2) % 3), 3, 3);
    ctx.fillRect(x + 5, y - 15 - bob, 2, 2);
    ctx.restore();
  } else if (f.kind === "lights") {
    // 關燈(遮蔽式演出:房間局部變暗 + 一顆小愛心)
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#0a0912";
    ctx.fillRect(x - TILE, y - TILE, TILE * 3, TILE * 2.5);
    ctx.restore();
    pxPat(ctx, PAT_HEART, x + 5, y - 4 - bob, "#ff9ec2", 0.85);
  } else if (f.kind === "fight") {
    // 打鬥雲(遮蔽式演出:卡通打鬥雲 + 飛出的星星,不見血)
    ctx.fillStyle = frame % 2 ? "#c9c4bd" : "#b7b1a8";
    ctx.fillRect(x - 2, y - 8 - bob, 8, 6);
    ctx.fillRect(x + 4, y - 11 - bob, 8, 6);
    ctx.fillRect(x + 9, y - 6 - bob, 7, 5);
    ctx.fillRect(x + 2, y - 4 - bob, 10, 5);
    ctx.fillStyle = "#8f887d";
    ctx.fillRect(x + 3, y - 7 - bob, 4, 3); // 雲內陰影
    ctx.fillRect(x + 9, y - 9 - bob, 3, 2);
    const star = frame % 2 ? "#ffd23e" : "#fff3b0";
    pxPat(ctx, PAT_STAR, x - 5, y - 13 - ((frame + 1) % 3), star);
    pxPat(ctx, PAT_STAR, x + 14, y - 15 - bob, star);
    pxPat(ctx, PAT_STAR, x + 16, y - 2 - ((frame + 2) % 3), star);
  } else if (f.kind === "slam") {
    // 冷戰摔門:門板震動 + 驚嘆號/撞擊線,不依賴音效也能看懂「砰」的一下
    const shake = frame % 2;
    rect(ctx, x + 4 + shake, y - 10, 8, 10, "#4b2f24");
    rect(ctx, x + 5 + shake, y - 9, 6, 9, "#9a6240");
    rect(ctx, x + 10 + shake, y - 5, 1, 1, "#ffd27a");
    pxPat(ctx, PAT_BANG, x + 13, y - 13, "#ffcf4a");
    rect(ctx, x + 1 - shake, y - 8, 2, 1, "#ff8a5b");
    rect(ctx, x, y - 5, 3, 1, "#ff8a5b");
  }
}

/** 隨狀態的環境演出:睡覺 Zzz、直播音符、洗澡蒸氣、崩潰淚滴 */
function drawAmbient(ctx: Ctx, a: Agent, frame: number) {
  const bob = frame % 2;
  const px = a.px + a.poseOffsetX;
  const py = a.py + a.poseOffsetY;
  if (a.vs === "sleeping_on_bed") {
    pxPat(ctx, PAT_Z, px + 9, py - 7 - bob, "#cfd6ff", 0.9);
    pxPat(ctx, PAT_Z, px + 13, py - 12 - bob, "#aab4e8", 0.7);
  } else if (a.vs === "streaming") {
    pxPat(ctx, PAT_NOTE, a.px + 10, a.py - 9 - bob, "#cfe0ff", 0.9);
  } else if (a.vs === "showering") {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(a.px + 1, a.py - 6 - bob, 2, 2);
    ctx.fillRect(a.px + 6, a.py - 10 - ((frame + 1) % 3), 2, 2);
    ctx.fillRect(a.px + 11, a.py - 5 - ((frame + 2) % 3), 2, 2);
    ctx.restore();
  } else if (a.vs === "washing_at_sink") {
    ctx.fillStyle = "#8fd3ff";
    ctx.fillRect(a.px + 2, a.py + 7 + bob, 2, 1);
    ctx.fillRect(a.px + 11, a.py + 8 - bob, 2, 1);
  } else if (a.vs === "taking_bath") {
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(px + 2, py + 2 - bob, 2, 2);
    ctx.fillRect(px + 12, py + 4 - ((frame + 1) % 2), 1, 1);
  } else if (a.vs === "using_toilet" || a.vs === "waiting_for_bathroom") {
    ctx.fillStyle = "#cfd6ff";
    ctx.fillRect(a.px + 5, a.py - 5, 2, 2);
    ctx.fillRect(a.px + 9, a.py - 5, 2, 2);
    ctx.fillRect(a.px + 13, a.py - 5, 2, 2);
  } else if (a.vs === "crying") {
    ctx.fillStyle = "#7fb4ff";
    ctx.fillRect(a.px + 2, a.py - 2 + bob, 1, 2);
    ctx.fillRect(a.px + 13, a.py - 3 + ((frame + 1) % 2), 1, 2);
  }
}

function drawAgent(ctx: Ctx, a: Agent) {
  const pal = charPalette(a.tenantId);
  // §10-6 雙人圖式:互動 session 抵達定點後坐下/躺下(還在走路時照常走)
  if (!a.moving && a.pose === "lie") {
    drawLying(ctx, a, pal);
    return;
  }
  if (!a.moving && a.pose === "sit" && a.seatBack) drawActivityChair(ctx, a);
  groundShadow(ctx, a.px + TILE / 2, a.py + TILE - 1, 11);
  if (!a.moving && a.pose === "sit") {
    // 坐姿 14 行(站姿 19):底邊貼齊同一地面線 → 頭自然比站著矮一截
    drawSprite(ctx, CHAR_SIT, a.px + 3, a.py + 1, pal);
    const apSit = getCustomAppearance(a.tenantId);
    if (apSit) drawAppearanceOverlay(ctx, apSit, a.px + 3, a.py + 1);
    return;
  }
  let sprite = CHAR_STAND;
  let yoff = 0;
  if (a.moving) {
    const step = Math.floor(a.walkPhase) % 2 === 0;
    sprite = step ? CHAR_WALK_A : CHAR_WALK_B;
    yoff = step ? 0 : -1; // 走路上下彈跳
  }
  drawSprite(ctx, sprite, a.px + 3, a.py - 4 + yoff, pal);
  // 部件化外觀(§9-1):在基底 sprite 上疊髮型/配件
  const ap = getCustomAppearance(a.tenantId);
  if (ap) drawAppearanceOverlay(ctx, ap, a.px + 3, a.py - 4 + yoff);
  if (!a.moving && a.pose === "stand_face") drawFacingCue(ctx, a, pal);
  else if (!a.moving && a.pose === "cook_pair") drawCookingCue(ctx, a, pal);
}

/** 正面基底上補一顆朝同伴方向的眼睛與鼻尖，讓相鄰兩人明確互看。 */
function drawFacingCue(ctx: Ctx, a: Agent, pal: Palette) {
  if (!a.facing) return;
  const x = a.px + 3;
  const y = a.py - 4;
  const eyeX = a.facing > 0 ? x + 6 : x + 3;
  const noseX = a.facing > 0 ? x + 8 : x + 1;
  rect(ctx, eyeX, y + 5, 1, 1, shade(pal.F, -55));
  rect(ctx, noseX, y + 6, 1, 1, pal.F);
}

/** 並肩料理:抬起靠流理台的一隻手，搭配鍋鏟像素，和一般站姿區分。 */
function drawCookingCue(ctx: Ctx, a: Agent, pal: Palette) {
  const x = a.px + 3;
  const y = a.py - 4;
  rect(ctx, x + 1, y + 10, 2, 1, pal.F);
  rect(ctx, x, y + 8, 1, 3, shade(pal.F, -12));
  rect(ctx, x, y + 5, 1, 4, "#5f6470");
  rect(ctx, x - 1, y + 4, 3, 1, "#353943");
}

/** 桌前／電視前的單人座椅，先畫在角色背後，讓坐姿不會像蹲在地上。 */
function drawActivityChair(ctx: Ctx, a: Agent) {
  const x = a.px;
  const y = a.py;
  rect(ctx, x + 3, y + 4, 10, 7, "#5b4636");
  rect(ctx, x + 4, y + 5, 8, 2, "#8a6444");
  rect(ctx, x + 2, y + 11, 12, 3, "#6d5236");
  rect(ctx, x + 3, y + 14, 2, 2, "#3f342d");
  rect(ctx, x + 11, y + 14, 2, 2, "#3f342d");
}

// ---------------------------------------------------------------------------
// 寵物貓(寵物系統):走路/坐/捲成一團睡,四種花色
// ---------------------------------------------------------------------------

const CAT_PALS = [
  { body: "#e0913f", dark: "#b46c22", belly: "#f6cb9e", eye: "#26232f", patch: false }, // 橘貓
  { body: "#413e4e", dark: "#2b2937", belly: "#8d89a0", eye: "#ffd23e", patch: false }, // 黑貓
  { body: "#eae5da", dark: "#c6bfb0", belly: "#faf7f0", eye: "#26232f", patch: false }, // 白貓
  { body: "#eae5da", dark: "#c6bfb0", belly: "#faf7f0", eye: "#26232f", patch: true }, // 三花
];

function drawCat(ctx: Ctx, a: PetAgent, frame: number) {
  const pal = CAT_PALS[a.color] ?? CAT_PALS[0];
  const x = a.px + 1; // 貓佔位 14px 寬,置中於 16px tile
  const y = a.py;
  const f = a.facing;
  /** 依面向鏡射的水平座標(off = 面向右時的偏移) */
  const fx = (off: number, w = 1) => x + (f > 0 ? off : 14 - off - w);

  groundShadow(ctx, x + 7, y + TILE - 2, 8);

  if (a.sleeping) {
    // 捲成一團睡:橢圓身體 + 貼著的頭 + 圍上來的尾巴 + Zzz
    rect(ctx, x + 3, y + 8, 8, 1, pal.body);
    rect(ctx, x + 2, y + 9, 10, 4, pal.body);
    rect(ctx, x + 3, y + 12, 8, 1, pal.dark);
    rect(ctx, x + 8, y + 7, 4, 2, pal.body); // 頭靠在身上
    rect(ctx, x + 8, y + 6, 1, 1, pal.dark); // 耳
    rect(ctx, x + 11, y + 6, 1, 1, pal.dark);
    rect(ctx, x + 2, y + 11, 3, 1, pal.dark); // 尾巴圍到身前
    if (pal.patch) {
      rect(ctx, x + 4, y + 9, 3, 2, "#cd7f32");
      rect(ctx, x + 8, y + 10, 2, 2, "#413e4e");
    }
    pxPat(ctx, PAT_Z, x + 12, y + 1 - (frame % 2), "#cfd6ff", 0.8);
    return;
  }

  if (!a.moving) {
    // 端坐:直立身體 + 頭 + 收在腳邊的尾巴
    rect(ctx, x + 4, y + 8, 5, 5, pal.body);
    rect(ctx, x + 5, y + 10, 2, 3, pal.belly); // 胸口
    rect(ctx, x + 4, y + 4, 5, 4, pal.body); // 頭
    rect(ctx, x + 4, y + 3, 1, 1, pal.dark); // 耳
    rect(ctx, x + 8, y + 3, 1, 1, pal.dark);
    rect(ctx, x + 5, y + 5, 1, 1, pal.eye); // 眼(眨眼:偶爾閉上)
    rect(ctx, x + 7, y + 5, 1, 1, frame % 7 === 3 ? pal.body : pal.eye);
    rect(ctx, x + 9, y + 12, 3, 1, pal.dark); // 尾巴
    rect(ctx, x + 11, y + 11, 1, 1, pal.dark);
    if (pal.patch) {
      rect(ctx, x + 4, y + 4, 2, 2, "#cd7f32");
      rect(ctx, x + 7, y + 9, 2, 2, "#413e4e");
    }
    return;
  }

  // 走路:水平身體 + 前方的頭 + 交替的四肢 + 翹起的尾巴
  rect(ctx, fx(2, 8), y + 8, 8, 3, pal.body);
  rect(ctx, fx(3, 6), y + 10, 6, 1, pal.belly);
  rect(ctx, fx(9, 4), y + 5, 4, 4, pal.body); // 頭
  rect(ctx, fx(9, 1), y + 4, 1, 1, pal.dark); // 耳
  rect(ctx, fx(12, 1), y + 4, 1, 1, pal.dark);
  rect(ctx, fx(12, 1), y + 6, 1, 1, pal.eye); // 眼
  const stepA = Math.floor(a.walkPhase) % 2 === 0;
  const legs = stepA ? [3, 8] : [4, 7];
  for (const off of legs) rect(ctx, fx(off, 1), y + 11, 1, 2, pal.body);
  rect(ctx, fx(1, 1), y + 5, 1, 2, pal.dark); // 尾巴翹起
  rect(ctx, fx(2, 1), y + 7, 1, 1, pal.dark);
  if (pal.patch) {
    rect(ctx, fx(4, 3), y + 8, 3, 2, "#cd7f32");
    rect(ctx, fx(10, 2), y + 5, 2, 2, "#413e4e");
  }
}

function activeCatPairs(pets: PetAgent[]): [PetAgent, PetAgent][] {
  const byOwner = new Map(pets.map((p) => [p.ownerId, p]));
  const pairs: [PetAgent, PetAgent][] = [];
  for (const leader of pets) {
    if (!leader.pairLeader || !leader.pairAction || !leader.pairWith) continue;
    const partner = byOwner.get(leader.pairWith);
    if (partner) pairs.push([leader, partner]);
  }
  return pairs;
}

/** 共眠與搗蛋先鋪共享道具，讓互動看起來是同一幕而非兩隻碰巧站附近。 */
function drawCatPairGround(ctx: Ctx, a: PetAgent, b: PetAgent, frame: number) {
  if (!a.pairAction) return;
  const minX = Math.min(a.px, b.px);
  const maxX = Math.max(a.px, b.px) + TILE;
  const minY = Math.min(a.py, b.py);
  const maxY = Math.max(a.py, b.py) + TILE;
  const cx = Math.floor((minX + maxX) / 2);
  const cy = Math.floor((minY + maxY) / 2);
  if (a.pairAction === "nap") {
    // 同一塊柔軟小墊＋縫線，呼應概念圖中兩隻貓捲成一團的輪廓。
    const w = Math.min(30, maxX - minX + 8);
    rect(ctx, cx - Math.floor(w / 2), cy + 4, w, 8, "#6f5572");
    rect(ctx, cx - Math.floor(w / 2) + 1, cy + 5, w - 2, 5, "#a57e91");
    for (let x = cx - Math.floor(w / 2) + 3; x < cx + w / 2 - 2; x += 4) rect(ctx, x, cy + 9, 2, 1, "#d2a2ad");
  } else if (a.pairAction === "mischief") {
    // 被兩位主子拆開的小紙箱；箱蓋與紙屑各自有清楚輪廓。
    rect(ctx, cx - 5, cy + 4, 10, 7, "#8c5b31");
    rect(ctx, cx - 4, cy + 5, 8, 5, "#c18548");
    rect(ctx, cx - 6, cy + 3, 5, 2, "#d29a5b");
    rect(ctx, cx + 1, cy + 3, 5, 2, "#d29a5b");
    const hop = frame % 2;
    rect(ctx, cx - 9, cy + 9 - hop, 2, 1, "#d7ae72");
    rect(ctx, cx + 8, cy + 7 + hop, 2, 2, "#d7ae72");
  }
}

/** 五種雙貓事件各有獨立、無文字的像素演出。 */
function drawCatPairAction(ctx: Ctx, a: PetAgent, b: PetAgent, frame: number) {
  if (!a.pairAction) return;
  const ax = a.px + TILE / 2, ay = a.py + 5;
  const bx = b.px + TILE / 2, by = b.py + 5;
  const cx = Math.floor((ax + bx) / 2), cy = Math.floor((ay + by) / 2);
  const bob = frame % 2;
  if (a.pairAction === "chase") {
    // 腳後速度線與灰塵，方向跟著各自面向。
    for (const cat of [a, b]) {
      const tailX = cat.px + (cat.facing > 0 ? 0 : 13);
      rect(ctx, tailX, cat.py + 8 + bob, 3, 1, "#f1d5a1");
      rect(ctx, tailX + (cat.facing > 0 ? -2 : 3), cat.py + 11 - bob, 2, 2, "#d8b883");
    }
  } else if (a.pairAction === "groom") {
    // 舔毛的小粉線與上浮愛心；不蓋住兩隻貓的臉。
    rect(ctx, cx - 1, cy - 5 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx + 1, cy - 5 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx, cy - 4 - bob, 1, 2, "#e95783");
    rect(ctx, cx - 2, cy + 1, 4, 1, "#ffc0ce");
  } else if (a.pairAction === "nap") {
    // 共享的 Z 字節奏，比兩顆獨立泡泡更像一起睡。
    rect(ctx, cx + 2, cy - 8 - bob, 4, 1, "#cfd6ff");
    rect(ctx, cx + 5, cy - 7 - bob, 1, 1, "#cfd6ff");
    rect(ctx, cx + 2, cy - 6 - bob, 4, 1, "#cfd6ff");
  } else if (a.pairAction === "territory") {
    // 中間鋸齒狀火花與兩側炸毛線，保留明顯安全距離。
    rect(ctx, cx, cy - 5 - bob, 2, 2, "#f0c14b");
    rect(ctx, cx - 2, cy - 3 - bob, 2, 2, "#d95454");
    rect(ctx, cx + 2, cy - 1 - bob, 2, 2, "#d95454");
    rect(ctx, Math.floor(ax) - 7, Math.floor(ay) - 3, 3, 1, "#f4e9da");
    rect(ctx, Math.floor(bx) + 4, Math.floor(by) - 3, 3, 1, "#f4e9da");
  } else {
    // 紙箱上方跳動的驚嘆星芒，強調「一起闖禍」。
    rect(ctx, cx, cy - 7 - bob, 1, 5, "#ffd66e");
    rect(ctx, cx - 2, cy - 5 - bob, 5, 1, "#ffd66e");
    rect(ctx, cx - 1, cy - 6 - bob, 3, 3, "#fff0a8");
  }
}

/** 躺姿(§10-6 lie:賴床)——頭枕左側 + 蓋著被子的身體(被子用衣服色,一眼認得出是誰) */
function drawLying(ctx: Ctx, a: Agent, pal: Palette) {
  const ox = a.px + a.poseOffsetX;
  const oy = a.py + a.poseOffsetY;
  const rr = (x: number, y: number, w: number, h: number, color: string) => {
    if (a.poseRotation === 90) rect(ctx, ox + TILE - y - h, oy + x, h, w, color);
    else if (a.poseRotation === 180) rect(ctx, ox + TILE - x - w, oy + TILE - y - h, w, h, color);
    else if (a.poseRotation === 270) rect(ctx, ox + y, oy + TILE - x - w, h, w, color);
    else rect(ctx, ox + x, oy + y, w, h, color);
  };
  rr(7, 3, 8, 10, shade(pal.t, -22)); // 被子滾邊
  rr(8, 4, 7, 8, pal.t); // 被子
  rr(8, 7, 7, 1, shade(pal.t, 22)); // 摺線高光
  rr(2, 4, 5, 3, pal.h); // 頭髮
  rr(2, 7, 5, 3, pal.F); // 臉
  rr(3, 8, 1, 1, shade(pal.F, -40)); // 閉眼
  rr(5, 8, 1, 1, shade(pal.F, -40));
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

/** 只覆蓋 301 室內的 5x7 格；圖片不可用時下方程序地板完整保留。 */
function drawR301FloorOverlay(ctx: Ctx) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      tryDrawLimezuR301Floor(ctx, (c + 2 * r) % 3, 16 + c * TILE, 16 + r * TILE);
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
