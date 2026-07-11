/**
 * 部件化外觀(§9-1):髮型/配件的像素圖層 + 隨機外觀生成。
 *
 * 圖層對齊 CHAR_* sprite 的原點(11 寬;頭在 rows0-8、眼睛在 row5 cols3/6、肩在 row9)。
 * 基底 sprite 自帶短髮(palette h/H 已用 hairColor 上色),其餘髮型是「加畫」在上面:
 * 長髮=兩側垂下、馬尾=右後方辮子、刺蝟=頭頂尖刺、鮑伯=兩側加寬。
 * 配件畫在最上層(眼鏡/圓框眼鏡/棒球帽/蝴蝶結/耳機)。
 */
import type { Ctx } from "./sprites";
import type { Appearance, HairStyle, AccessoryKind } from "../types";

interface Overlay {
  dy: number; // 相對 sprite 原點的縱向位移(可為負 = 畫到頭頂上方)
  rows: string[]; // "X" = 上色(11 寬)
  color?: string; // 配件用固定色;髮型不填(用 hairColor)
}

function pat(ctx: Ctx, rows: string[], x: number, y: number, color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++)
      if (rows[r][c] === "X") ctx.fillRect(x + c, y + r, 1, 1);
}

/** 髮型圖層(short = 用基底自帶的短髮,無疊加) */
const HAIR_OVERLAYS: Record<HairStyle, Overlay | null> = {
  short: null,
  long: {
    dy: 3,
    rows: [
      "X........X.",
      "X........X.",
      "X........X.",
      "X........X.",
      "X........X.",
      ".X......X..",
    ],
  },
  ponytail: {
    dy: 1,
    rows: [
      ".........X.",
      ".........XX",
      ".........XX",
      "..........X",
      "..........X",
      ".........X.",
    ],
  },
  spiky: {
    dy: -2,
    rows: [
      "..X.X.X.X..",
      "..XXXXXXX..",
    ],
  },
  bob: {
    dy: 2,
    rows: [
      ".X.......X.",
      "XX.......XX",
      "XX.......XX",
      ".X.......X.",
    ],
  },
};

/** 配件圖層(可多段;各自有固定色) */
const ACCESSORY_OVERLAYS: Record<AccessoryKind, Overlay[]> = {
  none: [],
  glasses: [{ dy: 5, color: "#23252e", rows: [".XXXXXXXX.."] }],
  round_glasses: [
    {
      dy: 4,
      color: "#f2f2f2",
      rows: ["..XXX.XXX..", "..X.X.X.X..", "..XXX.XXX.."],
    },
  ],
  cap: [
    {
      dy: -1,
      color: "#3a66aa",
      rows: ["..XXXXXX...", ".XXXXXXXX..", ".XXXXXXXXX."],
    },
  ],
  bow: [
    {
      dy: 0,
      color: "#ff88b0",
      rows: [".......X.X.", "........X.."],
    },
  ],
  headphones: [
    { dy: 1, color: "#2a2d38", rows: [".XXXXXXXX.."] },
    { dy: 4, color: "#2a2d38", rows: ["XX......XX.", "XX......XX."] },
  ],
};

/** 在基底 sprite 上疊畫髮型與配件((x,y) = sprite 繪製原點) */
export function drawAppearanceOverlay(ctx: Ctx, ap: Appearance, x: number, y: number) {
  const hair = HAIR_OVERLAYS[ap.hairStyle];
  if (hair) pat(ctx, hair.rows, x, y + hair.dy, ap.hairColor);
  for (const seg of ACCESSORY_OVERLAYS[ap.accessory] ?? []) {
    pat(ctx, seg.rows, x, y + seg.dy, seg.color!);
  }
}

// ---------------------------------------------------------------------------
// 隨機外觀生成(招租應徵者用)
// ---------------------------------------------------------------------------

export const HAIR_COLORS = ["#241f2c", "#4a3a2a", "#7a4530", "#b58a4a", "#2c2620", "#5a3020", "#c8a050", "#8a4a5a"];
export const SHIRT_COLORS = ["#5aa06a", "#c85a4a", "#d0a040", "#3fa0a0", "#b070c8", "#e8e2d4", "#4a6ac8", "#d97a3a"];
export const PANTS_COLORS = ["#3d4257", "#4a4055", "#3a4a5a", "#5a4a60", "#44503a", "#6a4a3a"];
export const SKIN_TONES = ["#f0c19a", "#e8b088", "#f4c9a6", "#d99a6c"];

export const ALL_HAIR_STYLES: HairStyle[] = ["short", "long", "ponytail", "spiky", "bob"];
export const ALL_ACCESSORIES: AccessoryKind[] = ["none", "glasses", "round_glasses", "cap", "bow", "headphones"];

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

/** 隨機一套外觀(約 4 成帶配件,避免人人都戴東西) */
export function randomAppearance(): Appearance {
  const withAcc = Math.random() < 0.4;
  return {
    hairStyle: pick(ALL_HAIR_STYLES),
    hairColor: pick(HAIR_COLORS),
    shirt: pick(SHIRT_COLORS),
    pants: pick(PANTS_COLORS),
    skin: pick(SKIN_TONES),
    accessory: withAcc ? pick(ALL_ACCESSORIES.filter((a) => a !== "none")) : "none",
  };
}
