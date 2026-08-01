/**
 * 像素美術系統 v2 —— 俯視 3/4 視角(Modern-Interiors 風格)
 *
 * 設計原則(對應兩張參考圖):
 * - 地面:俯視平面(你從斜上方看地板,往後略微收窄透視)
 * - 物件:正面站立的 sprite,底部帶接地陰影
 * - 每種材質用 5 階色階(hi / light / mid / dark / outline)產生體積感
 * - 所有東西釘在 TILE 格線上 → 人與家具比例一致
 *
 * 這裡只放「與租客無關」的基元與 sprite;場景組裝在 scene.ts。
 * 之後導入真素材包(如 LimeZu Modern Interiors)只需替換繪圖來源,
 * scene.ts 的座標/格線邏輯不變。
 */

export type Ctx = CanvasRenderingContext2D;
export type Palette = Record<string, string>;

export const TILE = 16;

// ---------------------------------------------------------------------------
// 顏色工具:由單一 base 產生 5 階色階(關鍵:讓平面有體積)
// ---------------------------------------------------------------------------

function clamp8(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 依百分比提亮(+)或壓暗(-) */
export function shade(hex: string, pct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = pct / 100;
  const adj = (c: number) => (f >= 0 ? c + (255 - c) * f : c * (1 + f));
  const h = (c: number) => clamp8(adj(c)).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export interface Ramp {
  hi: string;
  light: string;
  mid: string;
  dark: string;
  out: string;
}

/** 由中間色產生完整色階;描邊統一偏冷深色 */
export function ramp(mid: string): Ramp {
  return {
    hi: shade(mid, 30),
    light: shade(mid, 14),
    mid,
    dark: shade(mid, -20),
    out: shade(mid, -48),
  };
}

// ---------------------------------------------------------------------------
// 基礎繪圖
// ---------------------------------------------------------------------------

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** 帶 1px 描邊的矩形 */
export function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, outline: string) {
  rect(ctx, x, y, w, h, outline);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

/**
 * 3/4 立體塊:正面 + 頂面高光 + 左側光 + 底部陰影 + 描邊。
 * 這是所有家具的基礎形狀,讓平面看起來有厚度。
 */
export function block(ctx: Ctx, x: number, y: number, w: number, h: number, r: Ramp, topFace = 3) {
  // 描邊
  rect(ctx, x, y, w, h, r.out);
  // 正面(中間色)
  rect(ctx, x + 1, y + 1, w - 2, h - 2, r.mid);
  // 頂面(高光,光源左上)
  rect(ctx, x + 1, y + 1, w - 2, topFace, r.hi);
  rect(ctx, x + 1, y + 1 + topFace, w - 2, 1, r.light);
  // 左側受光
  rect(ctx, x + 1, y + 1, 1, h - 2, r.light);
  // 右側 / 底部陰影
  rect(ctx, x + w - 2, y + 1 + topFace, 1, h - 2 - topFace, r.dark);
  rect(ctx, x + 1, y + h - 2, w - 2, 1, r.dark);
}

/** 接地陰影(壓扁的橢圓,大幅提升「站在地上」的可信度) */
export function groundShadow(ctx: Ctx, cx: number, y: number, w: number) {
  ctx.fillStyle = "rgba(20, 14, 34, 0.28)";
  const layers = [
    [w, 2],
    [w - 4, 1],
  ];
  let oy = 0;
  for (const [lw, lh] of layers) {
    ctx.fillRect(Math.round(cx - lw / 2), y + oy, lw, lh);
    oy += lh;
  }
}

// ---------------------------------------------------------------------------
// 字元點陣圖繪製
// ---------------------------------------------------------------------------

export function drawSprite(ctx: Ctx, rows: string[], x: number, y: number, pal: Palette) {
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      const c = pal[row[i]];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// 非租客固定調色盤(角色的 h/t/d/F 由 scene.ts 依租客注入)
// ---------------------------------------------------------------------------

export const BASE_PAL: Palette = {
  m: "#b85f68", // mouth / warm facial accent
  k: "#241b33", // 描邊/深
  p: "#efe7d6", // 枕頭
  P: "#cfc4ae", // 枕頭陰影
  b: "#7b83c8", // 毯子
  B: "#5a62a4", // 毯子深
  o: "#e8944a", // 橘貓
  O: "#c26f2e", // 橘貓深
  w: "#f4ede0", // 白/毛肚
  s: "#8fd0ff", // 水藍(眼淚/蒸氣)
  r: "#ff7d92", // 紅(愛心)
  y: "#ffd66e", // 黃(音符)
};

// ---------------------------------------------------------------------------
// 角色 sprite(正面站立,tokens: h H 髮 / F f 膚 / t T j 衣 / d D 褲 / k 鞋)
// ---------------------------------------------------------------------------

/** 站姿 11x19 */
export const CHAR_STAND = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHFFFFfh..",
  ".hFFFFFFh..",
  ".hFkFFkFh..",
  ".hFFFFFFh..",
  "..fFFmFf...",
  "...fFFf....",
  "..jTTttj...",
  ".jTTttttj..",
  ".FTTttttjF.",
  ".FjTTttjF..",
  "..jTtttj...",
  "..dddddd...",
  "..dDDDDd...",
  "..dd..dd...",
  "..dd..dd...",
  "..kk..kk...",
];

/** 坐姿 11x14(用於椅子/沙發/地板) */
export const CHAR_SIT = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHFFFFfh..",
  ".hFFFFFFh..",
  ".hFkFFkFh..",
  ".hFFFFFFh..",
  "..fFFmFf...",
  "...fFFf....",
  "...jTTttj..",
  "..jTTttttj.",
  ".FjTtttjF..",
  ".ddFddFdd..",
  ".dD.kk.Dd..",
];

/** 走路 A(下半身左移)11x19 */
export const CHAR_WALK_A = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHFFFFfh..",
  ".hFFFFFFh..",
  ".hFkFFkFh..",
  ".hFFFFFFh..",
  "..fFFmFf...",
  "...fFFf....",
  "...jTTttj..",
  "..FTTttttj.",
  ".FjTTttttj.",
  "..jTTttj.F.",
  "...Tttt.F..",
  "..dddddd...",
  "..dDDDDd...",
  ".dd...dd...",
  "dd.....dd..",
  "kk.....kk..",
];

/** 走路 B(下半身右移)11x19 */
export const CHAR_WALK_B = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHFFFFfh..",
  ".hFFFFFFh..",
  ".hFkFFkFh..",
  ".hFFFFFFh..",
  "..fFFmFf...",
  "...fFFf....",
  "...jTTttj..",
  ".jTTttttF..",
  ".jTTttttjF.",
  ".F.jTTttj..",
  "..F.Tttt...",
  "..dddddd...",
  "..dDDDDd...",
  "...dd...dd.",
  "..dd.....dd",
  "..kk.....kk",
];

/** 坐姿(背對,桌前工作用)11x12 */
export const CHAR_SIT_BACK = [
  "...hhhh....",
  "..hhhhhh...",
  ".hhhhhhhh..",
  ".hHhhhhHh..",
  ".hhhhhhhh..",
  "..TTtttj...",
  ".TTttttjj..",
  ".TTttttjj..",
  ".TTttttjj..",
  "..jttttj...",
  "..dddddd...",
  ".ddd..ddd..",
];

// ---------------------------------------------------------------------------
// 四方向人物:背面(上)與側面(左右)。正面沿用上方既有 sprite。
//
// 設計語言(三個視角共用 11 寬骨架,所以髮型/配件疊層座標可共用一套原點):
// - **背面**:rows0-8 全是髮色,**沒有 `k` 眼睛、沒有 `m` 嘴**,後頸露一小段暗膚 `f`。
//   這是「這個人背對鏡頭」唯一且最強的辨識訊號;衣服改用 `CHAR_SIT_BACK` 的
//   「左亮右暗、無領口」打光,和正面的對稱領口分開。
// - **側面**:頭部左半是髮、右半是臉,**只有一顆眼睛**。臉的右緣逐列外推再內收
//   (row2→col8 額、row3-5→col9 眉/鼻樑/鼻尖、row6→col7 人中內縮兩格、row7→col7 唇、
//   row8→col5 頸),這條起伏才是「這是側臉不是正臉」的關鍵;頭頂也往後(左)偏一格。
//   軀幹收窄成 6 寬(正面是 8 寬)、**只露一隻手**,腳掌朝前伸出。
//   側面只畫「朝右」一份,朝左用 `mirrorSprite()` 水平鏡射(見下方常數)。
// ---------------------------------------------------------------------------

/** 人物視角。side_l 是 side_r 的水平鏡射,不另外手繪。 */
export type CharView = "front" | "back" | "side_r" | "side_l";

/** 水平鏡射一張點陣圖(逐列反轉;所有角色 sprite 都是等寬的定寬列) */
export function mirrorSprite(rows: string[]): string[] {
  return rows.map((row) => [...row].reverse().join(""));
}

/** 站姿(背對)11x19 */
export const CHAR_STAND_BACK = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  "..hhhhhh...",
  "...ffff....",
  "..TTtttj...",
  ".TTttttjj..",
  ".FTTttttjF.",
  ".FTTtttjjF.",
  "..Ttttjj...",
  "..dddddd...",
  "..dDDDDd...",
  "..dd..dd...",
  "..dd..dd...",
  "..kk..kk...",
];

/** 走路 A(背對;下半身左移)11x19 */
export const CHAR_WALK_BACK_A = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  "..hhhhhh...",
  "...ffff....",
  "..TTtttj...",
  ".TTttttjjF.",
  ".TTttttjjF.",
  "FTTtttjj...",
  "..Ttttj....",
  "..dddddd...",
  "..dDDDDd...",
  "...dd...dd.",
  "..dd.....dd",
  "..kk.....kk",
];

/** 走路 B(背對;下半身右移)11x19 */
export const CHAR_WALK_BACK_B = [
  "...hHh.....",
  "..hHHhhh...",
  ".hHHhhhhh..",
  ".hHhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  ".hhhhhhhh..",
  "..hhhhhh...",
  "...ffff....",
  "..TTtttj...",
  "FTTttttjj..",
  "FTTttttjj..",
  "..TTtttjjF.",
  "...Ttttj...",
  "..dddddd...",
  "..dDDDDd...",
  ".dd...dd...",
  "dd.....dd..",
  "kk.....kk..",
];

/** 站姿(側面朝右)11x19 */
export const CHAR_STAND_SIDE_R = [
  "..hHh......",
  ".hHHhhhh...",
  ".hhhhhFFf..",
  ".hhhhFFFf..",
  ".hhhhFFFFf.",
  ".hhhhFFkFf.",
  ".hhhhFFf...",
  "..hhFFmf...",
  "...fff.....",
  "..jTTttj...",
  "..jTTttj...",
  ".FjTTttj...",
  ".FjTTttj...",
  "..jTtttj...",
  "..ddddd....",
  "..dDDDd....",
  "..dddd.....",
  "...ddd.....",
  "...kkkk....",
];

/** 走路 A(側面朝右;開步)11x19 */
export const CHAR_WALK_SIDE_R_A = [
  "..hHh......",
  ".hHHhhhh...",
  ".hhhhhFFf..",
  ".hhhhFFFf..",
  ".hhhhFFFFf.",
  ".hhhhFFkFf.",
  ".hhhhFFf...",
  "..hhFFmf...",
  "...fff.....",
  "..jTTttj...",
  "..jTTttjF..",
  "..jTTttjF..",
  ".FjTTttj...",
  "..jTtttj...",
  "..ddddd....",
  "..dDDDd....",
  "..dd.dd....",
  ".dd...dd...",
  ".kkk..kkk..",
];

/** 走路 B(側面朝右;過步)11x19 */
export const CHAR_WALK_SIDE_R_B = [
  "..hHh......",
  ".hHHhhhh...",
  ".hhhhhFFf..",
  ".hhhhFFFf..",
  ".hhhhFFFFf.",
  ".hhhhFFkFf.",
  ".hhhhFFf...",
  "..hhFFmf...",
  "...fff.....",
  "..jTTttj...",
  ".FjTTttj...",
  ".FjTTttj...",
  "..jTTttjF..",
  "..jTtttj...",
  "..ddddd....",
  "..dDDDd....",
  "..ddddd....",
  "..dd.dd....",
  "..kk..kkk..",
];

/** 側面朝左:朝右版本的水平鏡射,不另外手繪(單一事實來源) */
export const CHAR_STAND_SIDE_L = mirrorSprite(CHAR_STAND_SIDE_R);
export const CHAR_WALK_SIDE_L_A = mirrorSprite(CHAR_WALK_SIDE_R_A);
export const CHAR_WALK_SIDE_L_B = mirrorSprite(CHAR_WALK_SIDE_R_B);

/** 依視角查站/走 A/走 B 三張基底 sprite */
export const CHAR_SPRITES: Record<CharView, { stand: string[]; walkA: string[]; walkB: string[] }> = {
  front: { stand: CHAR_STAND, walkA: CHAR_WALK_A, walkB: CHAR_WALK_B },
  back: { stand: CHAR_STAND_BACK, walkA: CHAR_WALK_BACK_A, walkB: CHAR_WALK_BACK_B },
  side_r: { stand: CHAR_STAND_SIDE_R, walkA: CHAR_WALK_SIDE_R_A, walkB: CHAR_WALK_SIDE_R_B },
  side_l: { stand: CHAR_STAND_SIDE_L, walkA: CHAR_WALK_SIDE_L_A, walkB: CHAR_WALK_SIDE_L_B },
};

/** 躺姿 22x7(頭在左,蓋毯子) */
export const CHAR_LIE = [
  "...hhh................",
  ".hHHhhh..bbbbbbbbbbb..",
  ".hHFFfh..bBbbbbbbbBb..",
  ".hFkFfh..bbbbbbbbbbb..",
  ".hFFFfh..bBbbbbbbbBb..",
  "pppppp...bbbbbbbbbbb..",
  ".PPPP.....BBBBBBBB....",
];

// ---------------------------------------------------------------------------
// 貓
// ---------------------------------------------------------------------------

/** 貓坐姿 9x8 */
export const CAT_SIT = [
  ".k.....k.",
  ".ooo.ooo.",
  ".ooooooo.",
  ".oOkOkOo.",
  ".ooowooo.",
  "ooooooooo",
  "oOoooooOo",
  ".oo...oo.",
];

/** 貓睡姿 11x5 */
export const CAT_SLEEP = [
  "..oooooo...",
  ".oooooooOo.",
  "oOoowoooooo",
  ".oooooooOo.",
  "..oo...oo..",
];

/** 貓探頭 9x4 */
export const CAT_PEEK = [
  ".k.....k.",
  ".ooo.ooo.",
  ".oOkOkOo.",
  ".ooowooo.",
];

// ---------------------------------------------------------------------------
// 狀態小圖示
// ---------------------------------------------------------------------------

export const ICON_HEART = [
  ".rr.rr.",
  "rrrrrrr",
  "rrrrrrr",
  ".rrrrr.",
  "..rrr..",
  "...r...",
];

export const ICON_NOTE = [
  "...y..",
  "...yy.",
  "...y.y",
  "...y..",
  "..yy..",
  ".yyy..",
  ".yy...",
];

export const ICON_SWEAT = [
  "..s.",
  ".ss.",
  "ssss",
  "ssss",
  ".ss.",
];

export const ICON_EXCLAIM = [
  "rr",
  "rr",
  "rr",
  "..",
  "rr",
];

export const ICON_PHONE = [
  "kkk",
  "ksk",
  "ksk",
  "kkk",
];

export function drawZzz(ctx: Ctx, x: number, y: number, frame: number) {
  const dy = frame % 2 === 0 ? 0 : -1;
  const z = (zx: number, zy: number, s: number) => {
    rect(ctx, zx, zy, s, 1, BASE_PAL.w);
    rect(ctx, zx + s - 2, zy + 1, 1, 1, BASE_PAL.w);
    if (s > 3) rect(ctx, zx + 1, zy + 2, 1, 1, BASE_PAL.w);
    rect(ctx, zx, zy + (s > 3 ? 3 : 2), s, 1, BASE_PAL.w);
  };
  z(x, y + 6 + dy, 3);
  z(x + 4, y + 3 - dy, 4);
  z(x + 9, y + dy, 5);
}

export function drawSteam(ctx: Ctx, x: number, y: number, frame: number) {
  const pts = frame % 2 === 0 ? [[0, 4], [2, 2], [1, 0]] : [[1, 4], [0, 2], [2, 0]];
  for (const [dx, dy] of pts) rect(ctx, x + dx, y + dy, 1, 1, "#d3cce0");
}
