/**
 * 部件化外觀(§9-1):髮型/配件的像素圖層 + 隨機外觀生成。
 *
 * 圖層對齊 CHAR_* sprite 的原點(11 寬;頭在 rows0-8、眼睛在 row5 cols3/6、肩在 row9)。
 * 基底 sprite 自帶短髮(palette h/H 已用 hairColor 上色),其餘髮型是「加畫」在上面:
 * 長髮=兩側垂下、馬尾=右後方辮子、刺蝟=頭頂尖刺、鮑伯=兩側加寬。
 * 配件畫在最上層(眼鏡/圓框眼鏡/棒球帽/蝴蝶結/耳機)。
 */
import { shade, type Ctx } from "./sprites";
import { clampLuma, hexToRgb, nearestInPool, separateHairFromSkin, type LumaBand } from "./color";
import type { Appearance, HairStyle, AccessoryKind } from "../types";

/** 消毒只碰四個顏色欄位;髮型/配件走各自的白名單,不在這裡處理 */
export type AppearanceColors = Pick<Appearance, "hairColor" | "shirt" | "pants" | "skin">;

interface Overlay {
  dy: number; // 相對 sprite 原點的縱向位移(可為負 = 畫到頭頂上方)
  rows: string[]; // "X" = 上色(11 寬)
  color?: string; // 配件用固定色;髮型不填(用 hairColor)
}

interface HairOverlay {
  base?: Overlay;
  accent?: Overlay;
}

function pat(ctx: Ctx, rows: string[], x: number, y: number, color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++)
      if (rows[r][c] === "X") ctx.fillRect(x + c, y + r, 1, 1);
}

/** 髮型圖層(short 保留基底輪廓，只補一小段高光) */
const HAIR_OVERLAYS: Record<HairStyle, HairOverlay> = {
  short: {
    accent: { dy: 0, rows: ["....XX.....", "...X......."] },
  },
  long: {
    base: {
      dy: 2,
      rows: [
        ".X.......X.",
        "XX.......XX",
        "XX.......XX",
        "XX.......XX",
        ".X.......X.",
        ".X.......X.",
        "..X.....X..",
      ],
    },
    accent: { dy: 3, rows: [".X.........", ".X.........", "..........X"] },
  },
  ponytail: {
    base: {
      dy: 1,
      rows: [
        ".........X.",
        "........XXX",
        ".........XX",
        ".........XX",
        "..........X",
        ".........X.",
        "........X..",
      ],
    },
    accent: { dy: 2, rows: [".........X.", "..........X", "..........X"] },
  },
  spiky: {
    base: { dy: -2, rows: ["..X.X.X.X..", "..XXXXXXX.."] },
    accent: { dy: -2, rows: ["....X.X...."] },
  },
  bob: {
    base: {
      dy: 2,
      rows: [
        ".X.......X.",
        "XX.......XX",
        "XX.......XX",
        "XX.......XX",
        ".XX.....XX.",
        "..X.....X..",
      ],
    },
    accent: { dy: 3, rows: [".X.........", ".X.........", "..X........"] },
  },
};

/** 配件圖層(可多段;各自有固定色) */
const ACCESSORY_OVERLAYS: Record<AccessoryKind, Overlay[]> = {
  none: [],
  glasses: [{ dy: 5, color: "#23252e", rows: ["..XXX.XXX.."] }],
  round_glasses: [
    {
      dy: 4,
      color: "#34313b",
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
  if (hair.base) pat(ctx, hair.base.rows, x, y + hair.base.dy, ap.hairColor);
  if (hair.accent) pat(ctx, hair.accent.rows, x, y + hair.accent.dy, shade(ap.hairColor, 24));
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
/** 膚色白名單(§9-3 消毒:AI 的 skin 一律 snap 到最近的一色)。
 *  ⚠️ 只能 append 到尾端,不得重排或刪除 —— `pick()` 消耗的隨機數個數必須不變,
 *  否則 `randomAppearance()` 會位移 seeded 序列、炸掉 balance 快照。 */
export const SKIN_TONES = [
  // 原始 4 色(L = 0.590 / 0.500 / 0.638 / 0.390)
  "#f0c19a", "#e8b088", "#f4c9a6", "#d99a6c",
  // 擴充(append only):往深與往極淺各補,覆蓋更廣的膚色範圍
  "#8d5524", // L 0.123
  "#a5673f", // L 0.181
  "#b57a52", // L 0.244
  "#c68e6a", // L 0.324
  "#ffdbac", // L 0.749
];

export const ALL_HAIR_STYLES: HairStyle[] = ["short", "long", "ponytail", "spiky", "bob"];
export const ALL_ACCESSORIES: AccessoryKind[] = ["none", "glasses", "round_glasses", "cap", "bow", "headphones"];

// ---------------------------------------------------------------------------
// AI 色碼安全化(§9-3):per-slot 亮度帶 + 膚色白名單 + 髮膚 ΔL 分離
// ---------------------------------------------------------------------------

/**
 * 各槽位的相對亮度帶(WCAG relative luminance,見 `./color.ts` 的 `relLuma`)。
 * **每條帶都必須涵蓋自家色池的實測範圍**,否則就會把現有美術
 * 判成違規(見 `scripts/invite-test.ts` 的護欄測試)。實測值:
 *
 * - HAIR  池 L ∈ [0.015, 0.380](`#241f2c` ~ `#c8a050`)→ 帶 [0.010, 0.42]
 * - SHIRT 池 L ∈ [0.159, 0.763](`#4a6ac8` ~ `#e8e2d4`)→ 帶 [0.12, 0.80]
 * - PANTS 池 L ∈ [0.056, 0.083](`#3d4257` ~ `#6a4a3a`)→ 帶 [0.04, 0.30]
 *
 * ⚠️ PANTS 是**刻意放寬**的:實測池極窄(寬度僅 0.027),若照抄會把 AI 給的任何
 * 合理淺色褲子壓成全黑。放寬到 0.30 讓卡其/淺牛仔仍可用,同時擋掉白褲。
 */
export const HAIR_LUMA_BAND: LumaBand = { lo: 0.010, hi: 0.42 };
export const SHIRT_LUMA_BAND: LumaBand = { lo: 0.12, hi: 0.80 };
export const PANTS_LUMA_BAND: LumaBand = { lo: 0.04, hi: 0.30 };

/** 髮色與膚色的最小亮度差(背景無關、永遠成立的唯一對比對象) */
export const MIN_HAIR_SKIN_DELTA = 0.10;

/** 格式不合法時的 per-slot 回退色(決定性、零 RNG:一律取該池首色) */
const COLOR_FALLBACK = {
  hairColor: HAIR_COLORS[0],
  shirt: SHIRT_COLORS[0],
  pants: PANTS_COLORS[0],
  skin: SKIN_TONES[0],
} as const;

/**
 * 格式回退:不是合法 `#rrggbb` 就換成該槽位的池首色。
 *
 * ⚠️ 三碼 hex(`#fff`)雖然是合法 CSS,這裡**一律視為不合法**——渲染層的 `shade()`
 * 用 `hex.slice(1,3)`／`(3,5)`／`(5,7)` 硬切六碼,吃到三碼會 `parseInt("")` → `NaN`
 * → 產生 `#ffNaNNaN` 這種無效 `fillStyle`,畫面直接壞掉。
 */
const coerceHex = (v: unknown, fallback: string): string =>
  typeof v === "string" && hexToRgb(v) ? v : fallback;

/**
 * 把一組外觀顏色消毒成「可辨識」的版本。
 *
 * 形狀刻意照抄 `sanitizeGrowthTags`:**純函式、無副作用、可重入、冪等**。
 * 掛在三處邊界(invite 源頭 / makeRuntime / load),既有存檔裡的髒顏色也會被就地修好。
 *
 * - **格式回退**:四個槽位都先確認是合法 `#rrggbb`,否則換成該池首色。
 * - `skin`:snap 到 `SKIN_TONES` 最近一色(膚色沒有創意空間,零 RNG)。
 * - `hairColor` / `shirt` / `pants`:夾進亮度帶,**色相保留**。
 * - 最後把髮色與膚色拉開至少 `MIN_HAIR_SKIN_DELTA`(只動髮色)。
 *
 * 格式回退**必須在這裡做**,不能只靠 `invite.ts` 的 `pickColor`:第 2、3 道防線
 * (`makeRuntime` / `load`)沒有任何格式驗證,而 `importSave()` 會吃玩家提供的任意 JSON。
 * 回退色本身都是池內色(在帶內、snap 為 identity),所以不影響冪等與護欄。
 */
export function sanitizeAppearanceColors<T extends AppearanceColors>(ap: T): T {
  const skin = nearestInPool(coerceHex(ap.skin, COLOR_FALLBACK.skin), SKIN_TONES);
  const clamped = clampLuma(coerceHex(ap.hairColor, COLOR_FALLBACK.hairColor), HAIR_LUMA_BAND);
  const hairColor = separateHairFromSkin(clamped, skin, HAIR_LUMA_BAND, MIN_HAIR_SKIN_DELTA);
  return {
    ...ap,
    hairColor,
    shirt: clampLuma(coerceHex(ap.shirt, COLOR_FALLBACK.shirt), SHIRT_LUMA_BAND),
    pants: clampLuma(coerceHex(ap.pants, COLOR_FALLBACK.pants), PANTS_LUMA_BAND),
    skin,
  };
}

/** 就地消毒一個可能為 undefined 的 `Appearance`(給 makeRuntime / load 這種改物件的邊界用) */
export function sanitizeAppearanceInPlace(ap: Appearance | undefined): void {
  if (!ap) return;
  const safe = sanitizeAppearanceColors(ap);
  ap.hairColor = safe.hairColor;
  ap.shirt = safe.shirt;
  ap.pants = safe.pants;
  ap.skin = safe.skin;
}

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
