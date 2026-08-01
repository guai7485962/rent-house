/**
 * 部件化外觀(§9-1):髮型/配件的像素圖層 + 隨機外觀生成。
 *
 * 圖層對齊 CHAR_* sprite 的原點(11 寬;頭在 rows0-8、眼睛在 row5 cols3/6、肩在 row9)。
 * 基底 sprite 自帶短髮(palette h/H 已用 hairColor 上色),其餘髮型是「加畫」在上面:
 * 長髮=兩側垂下、馬尾=右後方辮子、刺蝟=頭頂尖刺、鮑伯=兩側加寬。
 * 配件畫在最上層(眼鏡/圓框眼鏡/棒球帽/蝴蝶結/耳機)。
 */
import { shade, type CharView, type Ctx } from "./sprites";
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

/** 角色 sprite 的固定寬度;疊層鏡射一律以這個寬度為軸,不用逐列長度(避免短列位移) */
export const SPRITE_W = 11;

function pat(ctx: Ctx, rows: string[], x: number, y: number, color: string, mirror = false) {
  ctx.fillStyle = color;
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++)
      if (rows[r][c] === "X") ctx.fillRect(x + (mirror ? SPRITE_W - 1 - c : c), y + r, 1, 1);
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

// ---------------------------------------------------------------------------
// 四方向:背面／側面的髮型與配件疊層
//
// ⚠️ 這裡**只新增 Record 的 value**(新視角常數),`ALL_HAIR_STYLES` /
//    `ALL_ACCESSORIES` / `SKIN_TONES` 三個陣列一個字元都沒動 —— 它們被
//    `randomAppearance()` 的 `pick()` 消耗,動了會位移 seeded 序列。
//
// 座標系與正面完全相同(11 寬、以 sprite 原點為 (0,0)),因此:
// - 背面基底的頭部是 rows0-8 全髮 → 髮型疊層只有「超出頭部輪廓」的部分看得見,
//   所以背面版刻意把長髮/鮑伯畫成**蓋住後頸與上背的簾子**、馬尾畫成**沿背脊垂下的辮子**,
//   這些都是正面看不到、背面才成立的辨識點。
// - 側面基底的頭部是 cols1-4 髮、cols5-9 臉 → 髮量往**後腦(左)**堆,朝右版本畫一份,
//   朝左由 `drawAppearanceOverlay` 以 SPRITE_W 為軸鏡射。
// ---------------------------------------------------------------------------

/** 疊層視角:side_r / side_l 共用同一份 "side" 圖層(繪製時鏡射) */
type OverlayView = "front" | "back" | "side";

/** 背面髮型:沒有瀏海遮擋,改用「後腦簾子/辮子」當辨識點 */
const HAIR_OVERLAYS_BACK: Record<HairStyle, HairOverlay> = {
  short: {
    accent: { dy: 1, rows: ["...XXX.....", "..X........"] }, // 頭頂反光
  },
  long: {
    base: {
      dy: 2,
      rows: [
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        "..XXXXXX...",
        "...XXXX....",
        "...XXXX....", // 一路蓋過後頸與上背:背面才成立的「長」
      ],
    },
    accent: { dy: 3, rows: [".XX........", ".X.........", ".X........."] },
  },
  ponytail: {
    base: {
      dy: 5,
      rows: [
        "....XXX....",
        "....XXX....",
        "....XXX....",
        "....XXX....",
        "....XXX....",
        "....XXX....",
        ".....XX....",
        ".....X.....", // 沿背脊垂下的辮子:背面獨有
      ],
    },
    accent: { dy: 4, rows: ["...XXXXX...", "....XXX...."] }, // 束起的髮圈
  },
  spiky: {
    base: { dy: -2, rows: ["..X.X.X.X..", "..XXXXXXX.."] }, // 尖刺從背後看仍然一樣
    accent: { dy: -2, rows: ["....X.X...."] },
  },
  bob: {
    base: {
      dy: 2,
      rows: [
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        ".XXXXXXXX..",
        "XXXXXXXXXX.", // 下擺外翻:鮑伯的招牌
      ],
    },
    accent: { dy: 2, rows: ["..XXX......"] },
  },
};

/** 側面髮型(朝右;朝左鏡射):髮量堆在後腦(左),輪廓往左外擴 */
const HAIR_OVERLAYS_SIDE: Record<HairStyle, HairOverlay> = {
  short: {
    accent: { dy: 1, rows: ["..XX.......", ".X........."] },
  },
  long: {
    base: {
      dy: 2,
      rows: [
        ".XX........",
        ".XX........",
        "XXX........",
        "XXX........",
        "XXX........",
        "XXX........",
        ".XX........",
        ".XX........",
        ".XX........",
        "..X........", // 垂到肩胛下
      ],
    },
    accent: { dy: 3, rows: [".X.........", ".X........."] },
  },
  ponytail: {
    base: {
      dy: 1,
      rows: [
        "..X........",
        "XXX........", // 高處束起、往後翹出輪廓外
        "XX.........",
        "X..........",
        "X..........",
        "X..........",
        ".X.........",
        ".X.........",
        ".X.........",
        "..X........",
        "..X........",
        "..X........", // 細辮子一路垂過肩後:和鮑伯(齊頸即止)、長髮(整片簾子)分開
      ],
    },
    accent: { dy: 1, rows: ["..XX.......", "..X........"] },
  },
  spiky: {
    base: { dy: -2, rows: ["..X.X.X....", "..XXXXX...."] },
    accent: { dy: -2, rows: ["...X.X....."] },
  },
  bob: {
    base: {
      dy: 2,
      rows: [
        ".XX........",
        "XXX........",
        "XXX........",
        "XXX........",
        "XXXX.......", // 齊下巴、下擺外翻
        ".XXX.......",
      ],
    },
    accent: { dy: 2, rows: ["..XX......."] },
  },
};

/**
 * 背面配件:**看不見的就不畫**(比硬畫更正確)。
 * - `glasses` / `round_glasses` → 空陣列(從背後完全看不到鏡片)
 * - `cap` → 畫,但去掉向前的帽簷、補一條後扣帶
 * - `bow` → 畫(髮上的蝴蝶結從背後最清楚;位置是正面的鏡射)
 * - `headphones` → 畫(頭帶 + 雙耳罩,背面反而最完整)
 */
const ACCESSORY_OVERLAYS_BACK: Record<AccessoryKind, Overlay[]> = {
  none: [],
  glasses: [],
  round_glasses: [],
  cap: [
    { dy: -1, color: "#3a66aa", rows: ["..XXXXXX...", ".XXXXXXXX..", ".XXXXXXXX.."] },
    { dy: 2, color: "#31578e", rows: ["....XX....."] }, // 後扣帶
  ],
  bow: [{ dy: 2, color: "#ff88b0", rows: [".X.X.......", "..X........"] }],
  headphones: [
    { dy: 1, color: "#2a2d38", rows: [".XXXXXXXX.."] },
    { dy: 4, color: "#2a2d38", rows: ["XX......XX.", "XX......XX."] },
  ],
};

/**
 * 側面配件:多數可見但要改位置。
 * - `glasses` / `round_glasses` → 只剩**一片鏡片 + 一根鏡腳**往後延到耳朵
 * - `cap` → 帽簷**向前伸出**輪廓外,是側面最強的辨識點
 * - `bow` → 移到腦後
 * - `headphones` → 頭帶 + **單邊耳罩**(遠側那顆被頭擋住)
 */
const ACCESSORY_OVERLAYS_SIDE: Record<AccessoryKind, Overlay[]> = {
  none: [],
  glasses: [{ dy: 5, color: "#23252e", rows: ["....XXXXX.."] }], // 單片鏡片(col7 眼睛)+ 往後的鏡腳
  round_glasses: [
    { dy: 4, color: "#34313b", rows: ["......XXX..", "....XXX.X..", "......XX..."] },
  ],
  cap: [
    { dy: -1, color: "#3a66aa", rows: ["..XXXX.....", ".XXXXXX....", ".XXXXXXX..."] },
    { dy: 2, color: "#31578e", rows: [".....XXXXX."] }, // 向前伸出的帽簷,側面最強辨識點
  ],
  bow: [{ dy: 1, color: "#ff88b0", rows: [".X.X.......", "..X........"] }],
  headphones: [
    { dy: 1, color: "#2a2d38", rows: [".XXXXXXX..."] },
    { dy: 4, color: "#2a2d38", rows: ["...XX......", "...XX......"] },
  ],
};

const HAIR_BY_VIEW: Record<OverlayView, Record<HairStyle, HairOverlay>> = {
  front: HAIR_OVERLAYS,
  back: HAIR_OVERLAYS_BACK,
  side: HAIR_OVERLAYS_SIDE,
};

const ACCESSORY_BY_VIEW: Record<OverlayView, Record<AccessoryKind, Overlay[]>> = {
  front: ACCESSORY_OVERLAYS,
  back: ACCESSORY_OVERLAYS_BACK,
  side: ACCESSORY_OVERLAYS_SIDE,
};

/**
 * 所有疊層列的寬度清單(給 `scripts/appearance-test.ts` 用)。
 *
 * ⚠️ 存在的理由:`pat()` 的鏡射是 `SPRITE_W - 1 - c`,**以固定 11 為軸**而不是逐列長度。
 * 只要有人寫了一列不是 11 寬的疊層,朝左側面就會靜默位移 1px——而
 * 「`side_l` 疊層 === `side_r` 的鏡射」那條測試**抓不到**,因為它兩邊用同一個公式,
 * 誤差會對消。所以必須另外直接斷言「每一列都剛好 SPRITE_W 寬」。
 */
export function overlayRowWidths(): { id: string; width: number }[] {
  const out: { id: string; width: number }[] = [];
  for (const [view, table] of Object.entries(HAIR_BY_VIEW))
    for (const [style, ov] of Object.entries(table))
      for (const [part, seg] of [["base", ov.base], ["accent", ov.accent]] as const)
        seg?.rows.forEach((row, i) => out.push({ id: `hair/${view}/${style}/${part}[${i}]`, width: row.length }));
  for (const [view, table] of Object.entries(ACCESSORY_BY_VIEW))
    for (const [kind, segs] of Object.entries(table))
      segs.forEach((seg, s) => seg.rows.forEach((row, i) => out.push({ id: `acc/${view}/${kind}/${s}[${i}]`, width: row.length })));
  return out;
}

/** 視角 → (疊層表, 是否水平鏡射)。只有朝左的側面需要鏡射。 */
export function overlayViewOf(view: CharView): { key: OverlayView; mirror: boolean } {
  if (view === "back") return { key: "back", mirror: false };
  if (view === "side_r") return { key: "side", mirror: false };
  if (view === "side_l") return { key: "side", mirror: true };
  return { key: "front", mirror: false };
}

/**
 * 在基底 sprite 上疊畫髮型與配件((x,y) = sprite 繪製原點)。
 * `view` 預設 `"front"`,所以既有呼叫端(坐姿、離線 renderer)行為完全不變。
 */
export function drawAppearanceOverlay(ctx: Ctx, ap: Appearance, x: number, y: number, view: CharView = "front") {
  const { key, mirror } = overlayViewOf(view);
  const hair = HAIR_BY_VIEW[key][ap.hairStyle];
  if (hair.base) pat(ctx, hair.base.rows, x, y + hair.base.dy, ap.hairColor, mirror);
  if (hair.accent) pat(ctx, hair.accent.rows, x, y + hair.accent.dy, shade(ap.hairColor, 24), mirror);
  for (const seg of ACCESSORY_BY_VIEW[key][ap.accessory] ?? []) {
    pat(ctx, seg.rows, x, y + seg.dy, seg.color!, mirror);
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
