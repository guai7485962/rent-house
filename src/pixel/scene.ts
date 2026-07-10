/**
 * 俯視 3/4 場景合成器(Modern-Interiors 風格)
 *
 * 佈局:上方是背牆(正面),下方是俯視木地板;家具正面站立、釘在格線上。
 * 純函式:PixelDollhouse.vue 在 canvas 呼叫,scripts/render-preview.ts 離線呼叫。
 */
import type { RoomPropState, TenantVisualState } from "../types";
import {
  type Ctx,
  type Palette,
  TILE,
  BASE_PAL,
  ramp,
  shade,
  rect,
  box,
  block,
  groundShadow,
  drawSprite,
  drawZzz,
  drawSteam,
  CHAR_STAND,
  CHAR_SIT,
  CHAR_SIT_BACK,
  CHAR_LIE,
  CAT_SIT,
  CAT_SLEEP,
  CAT_PEEK,
  ICON_HEART,
  ICON_NOTE,
  ICON_SWEAT,
  ICON_EXCLAIM,
  ICON_PHONE,
} from "./sprites";

export const SCENE_W = 192; // 12 tiles
export const SCENE_H = 144; // 9 tiles
const WALL_H = 46; // 背牆高度
const FLOOR_Y = WALL_H;

export interface Theme {
  wall: string;
  floor: string;
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
  poster: "code" | "music";
}

export const THEMES: Record<string, Theme> = {
  tenant_chen_engineer: {
    wall: "#6d6790",
    floor: "#a9855c",
    hair: "#3a3346",
    shirt: "#5f86b0",
    pants: "#464b63",
    skin: "#f0c19a",
    poster: "code",
  },
  tenant_lin_asmr: {
    wall: "#7a6a94",
    floor: "#b59167",
    hair: "#8a5540",
    shirt: "#df90ae",
    pants: "#6f5d80",
    skin: "#f4c9a6",
    poster: "music",
  },
};

/** 動態入住租客的外觀配色池(依 id 分配,彼此明顯不同) */
const THEME_POOL: Theme[] = [
  { wall: "#5f6b90", floor: "#a98a5c", hair: "#4a3a2a", shirt: "#5aa06a", pants: "#3d4257", skin: "#f0c19a", poster: "code" },
  { wall: "#7a5a6a", floor: "#b0906a", hair: "#241f2c", shirt: "#c85a4a", pants: "#4a4055", skin: "#e8b088", poster: "music" },
  { wall: "#5a6a7a", floor: "#a88a66", hair: "#7a4530", shirt: "#d0a040", pants: "#3a4a5a", skin: "#f4c9a6", poster: "code" },
  { wall: "#6a5a7a", floor: "#9a8a6a", hair: "#b58a4a", shirt: "#3fa0a0", pants: "#5a4a60", skin: "#f0c19a", poster: "music" },
  { wall: "#6a7a5a", floor: "#a08a60", hair: "#2c2620", shirt: "#b070c8", pants: "#44503a", skin: "#e8b088", poster: "code" },
  { wall: "#7a6a5a", floor: "#96825e", hair: "#5a3020", shirt: "#e8e2d4", pants: "#30363f", skin: "#f4c9a6", poster: "music" },
];

const generatedThemes = new Map<string, Theme>();
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 由 store 指派的外觀索引(依房間,確保同時在住的租客配色彼此不同) */
const appearanceReg = new Map<string, number>();
export const THEME_POOL_SIZE = THEME_POOL.length;
export function setAppearance(tenantId: string, index: number) {
  appearanceReg.set(tenantId, index);
}
/** 是否為固定專屬外觀的種子租客(不佔用配色池) */
export function hasFixedTheme(tenantId: string): boolean {
  return !!THEMES[tenantId];
}

/** 取得租客外觀主題:固定兩位用專屬,動態入住者用 store 指派的索引(不同房間必不同色) */
export function getTheme(tenantId: string): Theme {
  if (THEMES[tenantId]) return THEMES[tenantId];
  const idx = appearanceReg.get(tenantId);
  if (idx != null) return THEME_POOL[idx % THEME_POOL.length];
  // 未登記(舊存檔/尚未指派)→ 退回雜湊
  let t = generatedThemes.get(tenantId);
  if (!t) {
    t = THEME_POOL[hashStr(tenantId) % THEME_POOL.length];
    generatedThemes.set(tenantId, t);
  }
  return t;
}

export interface SceneState {
  tenantId: string;
  visualState: TenantVisualState;
  roomProps: RoomPropState[];
  cleanliness: number;
  frame: number;
}

/** 依租客建立角色調色盤(含 5 階衍生) */
function charPalette(t: Theme): Palette {
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

export function composeScene(ctx: Ctx, s: SceneState) {
  const theme = getTheme(s.tenantId);
  const has = (p: RoomPropState) => s.roomProps.includes(p);
  const frame = s.frame;
  const dark = has("lights_off");
  const glow =
    has("screen_glow") ||
    ["working_at_desk", "gaming", "streaming"].includes(s.visualState);
  const pal = charPalette(theme);

  drawWall(ctx, theme);
  drawFloor(ctx, theme);
  drawWindow(ctx, 70, 8, has("curtains_closed"));
  drawPoster(ctx, 16, 12, theme.poster);
  drawClock(ctx, 138, 14);
  drawDoor(ctx, 166, 6, s.visualState === "away");
  drawBaseboard(ctx, theme);

  // ---- 家具(由後往前繪製,確保前物件蓋住後物件)----
  drawBed(ctx, 8, 52);
  drawDesk(ctx, 128, 48, glow, s.visualState === "streaming" || has("mic_setup_active"), frame);
  drawKitchen(ctx, 6, 108);
  drawSofa(ctx, 74, 94);
  drawRug(ctx, 82, 124);

  drawDirt(ctx, s.cleanliness);

  if (has("delivery_boxes_piled")) drawBoxes(ctx, 168, 112);
  if (has("trash_overflow")) drawTrash(ctx, 150, 96);
  if (has("laundry_piled")) drawLaundry(ctx, 40, 96);

  // 貓(桌上 / 沙發 / 探頭)
  if (has("cat_on_table")) drawSprite(ctx, CAT_SIT, 150, 55 + (frame % 2), BASE_PAL);
  if (has("cat_sleeping_on_couch")) drawSprite(ctx, CAT_SLEEP, 96, 104, BASE_PAL);
  if (has("cat_hiding")) drawSprite(ctx, CAT_PEEK, 60, 46, BASE_PAL);

  drawTenant(ctx, pal, s.visualState, frame);

  // ---- 關燈:夜色 + 光源保留 ----
  if (dark) {
    ctx.fillStyle = "rgba(12, 10, 32, 0.5)";
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
    if (glow) {
      ctx.fillStyle = "rgba(125, 180, 255, 0.16)";
      ctx.fillRect(124, 40, 56, 40);
      drawMonitors(ctx, 136, 52, true);
    }
    if (!has("curtains_closed")) {
      ctx.fillStyle = "rgba(245, 233, 184, 0.09)";
      ctx.fillRect(72, 6, 40, 34);
    }
  }
}

// ---------------------------------------------------------------------------
// 房間結構
// ---------------------------------------------------------------------------

function drawWall(ctx: Ctx, t: Theme) {
  // 垂直漸層:上亮下暗
  for (let y = 0; y < WALL_H; y++) {
    const k = 1 - y / WALL_H;
    rect(ctx, 0, y, SCENE_W, 1, shade(t.wall, -8 + k * 16));
  }
  // 牆頂高光線
  rect(ctx, 0, 0, SCENE_W, 1, shade(t.wall, 24));
}

function drawFloor(ctx: Ctx, t: Theme) {
  rect(ctx, 0, FLOOR_Y, SCENE_W, SCENE_H - FLOOR_Y, t.floor);
  const plankH = 12;
  for (let row = 0, y = FLOOR_Y; y < SCENE_H; row++, y += plankH) {
    // 交替板色 + 往前(下方)略提亮製造光照
    const depth = (y - FLOOR_Y) / (SCENE_H - FLOOR_Y);
    const base = shade(t.floor, -6 + depth * 10 + (row % 2 === 0 ? 0 : -4));
    rect(ctx, 0, y, SCENE_W, plankH, base);
    rect(ctx, 0, y, SCENE_W, 1, shade(t.floor, -22)); // 板縫
    // 錯縫的垂直短縫
    for (let x = row % 2 === 0 ? 30 : 0; x < SCENE_W; x += 60) {
      rect(ctx, x, y + 1, 1, plankH - 1, shade(t.floor, -18));
    }
  }
  // 牆腳投影(地板最上方一條暗帶)
  rect(ctx, 0, FLOOR_Y, SCENE_W, 3, shade(t.floor, -20));
}

function drawBaseboard(ctx: Ctx, t: Theme) {
  rect(ctx, 0, WALL_H - 4, SCENE_W, 4, shade(t.wall, -30));
  rect(ctx, 0, WALL_H - 4, SCENE_W, 1, shade(t.wall, 6));
}

function drawWindow(ctx: Ctx, x: number, y: number, closed: boolean) {
  const w = 40;
  const h = 30;
  box(ctx, x, y, w, h, "#1a2340", "#2b2338");
  // 木框
  rect(ctx, x, y, w, 2, "#3a2f26");
  if (closed) {
    for (let i = 0; i < w - 2; i += 5) {
      rect(ctx, x + 1 + i, y + 1, 4, h - 2, i % 10 === 0 ? "#7466a0" : "#8272ae");
      rect(ctx, x + 1 + i, y + 1, 1, h - 2, "#8f80b8");
    }
    rect(ctx, x, y, w, 2, "#3a2f26");
    box(ctx, x - 2, y - 1, w + 4, 3, "#5b4632", "#3a2f26"); // 窗簾桿
    return;
  }
  // 夜空
  rect(ctx, x + 28, y + 5, 5, 5, "#f5e9b8"); // 月
  rect(ctx, x + 30, y + 5, 1, 1, "#d8cc9a");
  rect(ctx, x + 6, y + 4, 1, 1, "#cfd7ff");
  rect(ctx, x + 13, y + 9, 1, 1, "#cfd7ff");
  rect(ctx, x + 20, y + 4, 1, 1, "#9aa0d0");
  // 遠方大樓
  rect(ctx, x + 4, y + 17, 7, 12, "#232c52");
  rect(ctx, x + 13, y + 13, 6, 16, "#2a3462");
  rect(ctx, x + 22, y + 19, 6, 10, "#20284a");
  rect(ctx, x + 6, y + 20, 1, 1, "#ffd66e");
  rect(ctx, x + 15, y + 16, 1, 1, "#ffd66e");
  rect(ctx, x + 15, y + 20, 1, 1, "#ffd66e");
  rect(ctx, x + 24, y + 22, 1, 1, "#ffd66e");
  // 窗框十字
  rect(ctx, x + w / 2 - 1, y + 1, 2, h - 2, "#3a2f26");
  rect(ctx, x + 1, y + h / 2 - 1, w - 2, 2, "#3a2f26");
}

function drawPoster(ctx: Ctx, x: number, y: number, type: "code" | "music") {
  box(ctx, x, y, 16, 20, type === "code" ? "#26314a" : "#4a2638", "#181225");
  if (type === "code") {
    rect(ctx, x + 3, y + 4, 6, 1, "#6fd08c");
    rect(ctx, x + 3, y + 7, 9, 1, "#8fd0ff");
    rect(ctx, x + 5, y + 10, 7, 1, "#ffd66e");
    rect(ctx, x + 3, y + 13, 5, 1, "#e8657a");
    rect(ctx, x + 3, y + 16, 8, 1, "#8fd0ff");
  } else {
    drawSprite(ctx, ICON_NOTE, x + 5, y + 6, BASE_PAL);
    rect(ctx, x + 9, y + 12, 1, 4, "#ffd66e");
  }
}

function drawClock(ctx: Ctx, x: number, y: number) {
  box(ctx, x, y, 14, 14, "#e9e2d0", "#3a2f26");
  rect(ctx, x + 6, y + 3, 1, 4, "#3a2f26"); // 時針
  rect(ctx, x + 7, y + 7, 3, 1, "#3a2f26"); // 分針
  rect(ctx, x + 6, y + 6, 2, 2, "#a83f3f");
}

// ---------------------------------------------------------------------------
// 家具(俯視 3/4:接地陰影 + 立體塊 + 頂面)
// ---------------------------------------------------------------------------

function drawBed(ctx: Ctx, x: number, y: number) {
  const w = 50;
  const h = 46;
  const wood = ramp("#7a5636");
  const sheet = ramp("#eee6d4");
  groundShadow(ctx, x + w / 2, y + h, w - 4);
  // 木床架(整體)
  block(ctx, x, y, w, h, wood, 2);
  // 床頭板(靠牆側較高,深色木紋)
  rect(ctx, x + 1, y + 1, w - 2, 7, wood.dark);
  rect(ctx, x + 1, y + 1, w - 2, 1, wood.hi);
  for (let i = x + 4; i < x + w - 4; i += 6) rect(ctx, i, y + 2, 1, 5, wood.out);
  // 床墊/床單
  rect(ctx, x + 3, y + 9, w - 6, h - 13, sheet.mid);
  rect(ctx, x + 3, y + 9, w - 6, 1, sheet.hi);
  // 兩顆枕頭
  rect(ctx, x + 5, y + 11, 18, 9, BASE_PAL.p);
  rect(ctx, x + 5, y + 11, 18, 2, "#fbf6ea");
  rect(ctx, x + 5, y + 18, 18, 1, BASE_PAL.P);
  rect(ctx, x + 25, y + 11, 18, 9, BASE_PAL.p);
  rect(ctx, x + 25, y + 11, 18, 2, "#fbf6ea");
  rect(ctx, x + 25, y + 18, 18, 1, BASE_PAL.P);
  rect(ctx, x + 23, y + 11, 2, 9, sheet.dark); // 枕頭間縫
  // 毯子(下半,含翻折邊)
  const by = y + 24;
  rect(ctx, x + 3, by, w - 6, h - 28, BASE_PAL.b);
  rect(ctx, x + 3, by, w - 6, 4, "#8a92d4"); // 翻折高光
  rect(ctx, x + 3, by + 4, w - 6, 1, BASE_PAL.B);
  rect(ctx, x + 3, by + 10, w - 6, 1, BASE_PAL.B); // 摺線
  rect(ctx, x + 3, y + h - 4, w - 6, 1, shade("#5a62a4", -20));
}

function drawDoor(ctx: Ctx, x: number, y: number, highlight: boolean) {
  const w = 20;
  const h = WALL_H - y - 1;
  const wood = ramp("#6d5236");
  box(ctx, x, y, w, h, wood.mid, wood.out);
  rect(ctx, x + 1, y + 1, w - 2, 1, wood.hi);
  rect(ctx, x + 1, y + 1, 1, h - 2, wood.light);
  // 門板凹格
  rect(ctx, x + 3, y + 4, w - 6, h * 0.4, wood.dark);
  rect(ctx, x + 3, y + 4 + h * 0.45, w - 6, h * 0.35, wood.dark);
  // 門把
  rect(ctx, x + w - 5, y + h / 2, 2, 2, "#ffd66e");
  if (highlight) {
    // 外出:門微亮,提示人從這裡離開
    rect(ctx, x, y, w, 1, "#ffe9a8");
    rect(ctx, x, y, 1, h, "#ffe9a8");
  }
}

function drawSofa(ctx: Ctx, x: number, y: number) {
  const w = 60;
  const fab = ramp("#c9a274");
  groundShadow(ctx, x + w / 2, y + 30, w - 2);
  // 椅背(後)
  block(ctx, x, y, w, 12, fab, 3);
  // 扶手
  block(ctx, x - 3, y + 6, 8, 22, fab, 3);
  block(ctx, x + w - 5, y + 6, 8, 22, fab, 3);
  // 坐墊(頂面)
  rect(ctx, x + 5, y + 12, w - 10, 14, shade("#c9a274", 12));
  rect(ctx, x + 5, y + 12, w - 10, 2, shade("#c9a274", 26));
  rect(ctx, x + (w - 10) / 2 + 4, y + 12, 1, 14, shade("#c9a274", -18)); // 坐墊分隔
  rect(ctx, x + 5, y + 25, w - 10, 1, shade("#c9a274", -22));
  // 抱枕
  rect(ctx, x + 8, y + 3, 9, 8, "#e6d6b8");
  rect(ctx, x + 8, y + 3, 9, 2, "#f0e4cc");
  rect(ctx, x + w - 17, y + 3, 9, 8, "#b0567a");
  rect(ctx, x + w - 17, y + 3, 9, 2, "#c56b8e");
  // 沙發腳
  rect(ctx, x + 2, y + 28, 3, 3, "#3a2f26");
  rect(ctx, x + w - 5, y + 28, 3, 3, "#3a2f26");
}

function drawMonitors(ctx: Ctx, x: number, y: number, lit: boolean) {
  const on = lit ? "#7db4ff" : "#242038";
  const on2 = lit ? "#5a8fe0" : "#242038";
  box(ctx, x, y, 18, 12, on, "#181225");
  box(ctx, x + 19, y + 2, 13, 10, on2, "#181225");
  if (lit) {
    rect(ctx, x + 2, y + 2, 10, 1, "#d6e9ff");
    rect(ctx, x + 2, y + 4, 13, 1, "#a8ccff");
    rect(ctx, x + 2, y + 6, 7, 1, "#d6e9ff");
    rect(ctx, x + 2, y + 8, 11, 1, "#8fb8f0");
    rect(ctx, x + 21, y + 4, 9, 1, "#cfe0ff");
    rect(ctx, x + 21, y + 7, 6, 1, "#a8ccff");
  }
  rect(ctx, x + 8, y + 12, 2, 2, "#181225");
  rect(ctx, x + 24, y + 12, 2, 2, "#181225");
}

function drawDesk(ctx: Ctx, x: number, y: number, lit: boolean, mic: boolean, frame: number) {
  const w = 52;
  const wood = ramp("#4b4266");
  groundShadow(ctx, x + w / 2, y + 46, w - 4);
  drawMonitors(ctx, x + 8, y, lit);
  // 桌面 + 桌腳
  block(ctx, x, y + 20, w, 6, wood, 2);
  rect(ctx, x + 3, y + 26, 4, 20, shade("#4b4266", -30));
  rect(ctx, x + w - 7, y + 26, 4, 20, shade("#4b4266", -30));
  // 鍵盤
  rect(ctx, x + 14, y + 17, 16, 3, "#5c5476");
  rect(ctx, x + 14, y + 17, 16, 1, "#726a8e");
  // 麥克風(直播)
  if (mic) {
    rect(ctx, x + 40, y + 8, 2, 12, "#9aa0b4");
    box(ctx, x + 37, y + 3, 8, 7, "#2c2840", "#181225");
    if (frame % 2 === 0) rect(ctx, x + 46, y + 3, 2, 2, "#ff4d5e");
  }
}

/** 辦公椅(在角色之後不畫,這裡畫椅背露出的部分)*/
function drawDeskChair(ctx: Ctx, cx: number, y: number) {
  const chair = ramp("#3f3a58");
  groundShadow(ctx, cx, y + 22, 18);
  // 椅背(在角色身後)
  block(ctx, cx - 8, y, 16, 20, chair, 3);
  rect(ctx, cx - 6, y + 2, 12, 6, shade("#3f3a58", 16));
}

function drawKitchen(ctx: Ctx, x: number, y: number) {
  const w = 30;
  const cab = ramp("#5a5f78");
  groundShadow(ctx, x + w / 2, y + 26, w - 2);
  // 流理臺
  block(ctx, x, y, w, 24, cab, 3);
  rect(ctx, x + 2, y + 5, 12, 7, shade("#5a5f78", -28)); // 櫃門
  rect(ctx, x + 16, y + 5, 12, 7, shade("#5a5f78", -28));
  rect(ctx, x + 7, y + 8, 1, 1, "#c9cde0");
  rect(ctx, x + 21, y + 8, 1, 1, "#c9cde0");
  // 檯面高光
  rect(ctx, x + 1, y + 1, w - 2, 2, shade("#5a5f78", 30));
  // 熱水壺
  box(ctx, x + 4, y - 8, 8, 8, "#dfd8e8", "#181225");
  rect(ctx, x + 12, y - 6, 2, 2, "#dfd8e8");
}

function drawRug(ctx: Ctx, x: number, y: number) {
  const w = 50;
  const h = 15;
  rect(ctx, x, y, w, h, "#8a5a6e");
  rect(ctx, x + 3, y + 2, w - 6, h - 4, "#9c6a7e");
  rect(ctx, x + 6, y + 4, w - 12, h - 8, "#7d4f61");
  rect(ctx, x + 6, y + 4, w - 12, 1, "#a87a8c");
  // 流蘇(讓它明確是地毯而非沙發裙擺)
  for (let i = x + 2; i < x + w - 1; i += 4) {
    rect(ctx, i, y - 1, 2, 1, "#6e4557");
    rect(ctx, i, y + h, 2, 1, "#6e4557");
  }
}

function drawBoxes(ctx: Ctx, x: number, y: number) {
  const c = ramp("#a9825e");
  groundShadow(ctx, x + 8, y + 22, 18);
  block(ctx, x, y + 12, 16, 12, c, 3);
  block(ctx, x + 2, y, 13, 13, ramp("#8a6a4c"), 3);
  rect(ctx, x + 7, y, 2, 13, "#c9b08e"); // 膠帶
  rect(ctx, x + 2, y + 6, 13, 1, "#c9b08e");
}

function drawTrash(ctx: Ctx, x: number, y: number) {
  groundShadow(ctx, x + 6, y + 16, 14);
  box(ctx, x + 2, y + 5, 11, 11, "#3f4a44", "#181225");
  rect(ctx, x + 2, y + 3, 11, 3, "#55645c");
  rect(ctx, x, y + 13, 2, 2, "#7a8a52");
  rect(ctx, x + 13, y + 11, 2, 2, "#a9825e");
  rect(ctx, x + 11, y + 2, 2, 2, "#8b90a8");
}

function drawLaundry(ctx: Ctx, x: number, y: number) {
  groundShadow(ctx, x + 7, y + 9, 14);
  rect(ctx, x, y + 3, 12, 5, "#5d7fa3");
  rect(ctx, x + 4, y, 9, 5, "#b0567a");
  rect(ctx, x + 2, y + 6, 13, 3, "#8b90a8");
  rect(ctx, x + 1, y + 4, 3, 2, "#6e91b5");
}

function drawDirt(ctx: Ctx, cleanliness: number) {
  if (cleanliness >= 60) return;
  const n = Math.min(14, Math.floor((60 - cleanliness) / 4));
  const seeds = [13, 47, 89, 131, 61, 103, 29, 151, 71, 119, 41, 97, 7, 167];
  for (let i = 0; i < n; i++) {
    const sx = ((seeds[i] * 7) % (SCENE_W - 12)) + 6;
    const sy = FLOOR_Y + 10 + ((seeds[i] * 13) % (SCENE_H - FLOOR_Y - 16));
    rect(ctx, sx, sy, 2, 1, "rgba(60,44,28,0.55)");
    rect(ctx, sx + 3, sy + 1, 1, 1, "rgba(60,44,28,0.55)");
  }
}

// ---------------------------------------------------------------------------
// 租客
// ---------------------------------------------------------------------------

function drawTenant(ctx: Ctx, pal: Palette, st: TenantVisualState, frame: number) {
  const bob = frame % 2;

  const stand = (x: number, y: number) => {
    groundShadow(ctx, x + 5, y + 19, 12);
    drawSprite(ctx, CHAR_STAND, x, y - bob, pal);
  };
  const sit = (x: number, y: number) => drawSprite(ctx, CHAR_SIT, x, y, pal);
  const lie = (x: number, y: number) => drawSprite(ctx, CHAR_LIE, x, y, pal);

  switch (st) {
    case "sleeping_on_bed":
      lie(16, 68);
      drawZzz(ctx, 40, 54, frame);
      break;
    case "sleeping_on_couch":
      lie(78, 100);
      drawZzz(ctx, 104, 86, frame);
      break;
    case "working_at_desk":
    case "gaming":
    case "streaming": {
      // 背對鏡頭坐在辦公椅上,面向螢幕
      const cx = 154;
      drawDeskChair(ctx, cx, 74);
      drawSprite(ctx, CHAR_SIT_BACK, cx - 5, 64 + bob, pal);
      if (st === "gaming") drawSprite(ctx, ICON_NOTE, 170, 62, BASE_PAL);
      if (st === "streaming") drawSprite(ctx, ICON_NOTE, 140, 58, BASE_PAL);
      break;
    }
    case "eating":
      stand(24, 96);
      drawSteam(ctx, 30, 86, frame);
      break;
    case "cooking":
      stand(16, 84);
      drawSteam(ctx, 22, 74, frame + 1);
      break;
    case "playing_with_cat":
      sit(72, 118);
      drawSprite(ctx, CAT_SIT, 86, 124 + bob, BASE_PAL);
      drawSprite(ctx, ICON_HEART, 82, 106 - bob, BASE_PAL);
      break;
    case "crying":
      sit(90, 120);
      rect(ctx, 94, 126 + bob, 1, 2, BASE_PAL.s);
      rect(ctx, 97, 126 + (1 - bob), 1, 2, BASE_PAL.s);
      drawSprite(ctx, ICON_SWEAT, 102, 110, BASE_PAL);
      break;
    case "pacing":
      stand(86 + (bob ? 4 : -4), 118);
      drawSprite(ctx, ICON_SWEAT, 98, 108, BASE_PAL);
      break;
    case "away":
      drawSprite(ctx, ICON_EXCLAIM, 174, 22, BASE_PAL);
      break;
    case "showering":
      drawSteam(ctx, 96, 30, frame);
      drawSteam(ctx, 100, 32, frame + 1);
      break;
    case "cleaning": {
      const cx = 90 + (bob ? 2 : 0);
      stand(cx, 116);
      rect(ctx, cx + 11, 120, 1, 14, "#8a6a4c"); // 掃把
      rect(ctx, cx + 9, 133, 4, 3, "#ffd66e");
      break;
    }
    case "talking_on_phone":
      stand(90, 118);
      drawSprite(ctx, ICON_PHONE, 100, 124, BASE_PAL);
      break;
    default: // idle
      stand(90, 118);
  }
}
