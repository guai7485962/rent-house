/**
 * 部件化外觀(§9-1)驗證:
 * - 所有髮型×配件圖層繪製不越界(sprite 11 寬)、非 short/none 有實際像素
 * - randomAppearance 變化量足夠、配件比例合理
 * - getTheme 被 Appearance 覆蓋(髮/衣/褲/膚色)
 * - moveIn 整合:入住者有外觀、渲染層有登錄
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { drawAppearanceOverlay, randomAppearance, ALL_HAIR_STYLES, ALL_ACCESSORIES } = await import("../src/pixel/parts");
const {
  BASE_PAL,
  CHAR_STAND,
  CHAR_SIT,
  CHAR_WALK_A,
  CHAR_WALK_B,
  CHAR_SIT_BACK,
  CHAR_LIE,
} = await import("../src/pixel/sprites");
const { setCustomAppearance, getCustomAppearance, getTheme } = await import("../src/pixel/scene");
const { state, getApplicants, moveIn } = await import("../src/store");
import type { Appearance } from "../src/types";
import type { Ctx } from "../src/pixel/sprites";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 1. 圖層不越界 + 有像素 ---
function mockCtx() {
  const pixels: { x: number; y: number }[] = [];
  return {
    ctx: { fillStyle: "", fillRect: (x: number, y: number) => pixels.push({ x, y }) } as unknown as Ctx,
    pixels,
  };
}
let allInBounds = true;
let allInVerticalBounds = true;
let missingPixels: string[] = [];
for (const hs of ALL_HAIR_STYLES) {
  for (const acc of ALL_ACCESSORIES) {
    const { ctx, pixels } = mockCtx();
    const ap: Appearance = { hairStyle: hs, hairColor: "#111111", shirt: "#222222", pants: "#333333", skin: "#444444", accessory: acc };
    drawAppearanceOverlay(ctx, ap, 0, 0);
    if (pixels.some((p) => p.x < 0 || p.x > 10)) allInBounds = false;
    if (pixels.some((p) => p.y < -2 || p.y > 10)) allInVerticalBounds = false;
    if (hs !== "short" || acc !== "none") {
      if (pixels.length === 0) missingPixels.push(`${hs}+${acc}`);
    }
  }
}
check("所有髮型×配件像素都在 sprite 11 寬內", allInBounds);
check("非預設組合都有實際像素", missingPixels.length === 0, missingPixels.join(","));

// --- 2. 隨機外觀變化量 ---
check("所有髮型與配件維持頭部垂直對位", allInVerticalBounds);

const spriteEntries = [
  ["stand", CHAR_STAND, 19, 11],
  ["sit", CHAR_SIT, 14, 11],
  ["walkA", CHAR_WALK_A, 19, 11],
  ["walkB", CHAR_WALK_B, 19, 11],
  ["sitBack", CHAR_SIT_BACK, 12, 11],
  ["lie", CHAR_LIE, 7, 22],
] as const;
const allowedTokens = new Set([".", ...Object.keys(BASE_PAL), ..."hHfFtTjdD"]);
check(
  "共用人物姿勢維持各自固定寬度與高度",
  spriteEntries.every(([, rows, height, width]) => rows.length === height && rows.every((row) => row.length === width)),
);
check(
  "共用人物姿勢只使用已定義的角色色票 token",
  spriteEntries.every(([, rows]) => rows.every((row) => [...row].every((token) => allowedTokens.has(token)))),
);
check(
  "站走坐姿都有雙眼與嘴部表情",
  [CHAR_STAND, CHAR_SIT, CHAR_WALK_A, CHAR_WALK_B]
    .every((rows) => rows[5].split("k").length - 1 === 2 && rows[7].includes("m")),
);
check(
  "走路雙幀同時改變手臂與腿部",
  CHAR_WALK_A.slice(9, 14).join("") !== CHAR_WALK_B.slice(9, 14).join("")
    && CHAR_WALK_A.slice(16).join("") !== CHAR_WALK_B.slice(16).join(""),
);

const signature = (hairStyle: Appearance["hairStyle"], accessory: Appearance["accessory"]) => {
  const { ctx, pixels } = mockCtx();
  drawAppearanceOverlay(ctx, {
    hairStyle,
    hairColor: "#553322",
    shirt: "#222222",
    pants: "#333333",
    skin: "#d9a67a",
    accessory,
  }, 0, 0);
  return pixels.map((p) => `${p.x},${p.y}`).sort().join("|");
};
check(
  "五種髮型都有可辨識的不同輪廓",
  new Set(ALL_HAIR_STYLES.map((hair) => signature(hair, "none"))).size === ALL_HAIR_STYLES.length,
);
check(
  "六種配件都有可辨識的不同輪廓",
  new Set(ALL_ACCESSORIES.map((accessory) => signature("short", accessory))).size === ALL_ACCESSORIES.length,
);

const combos = new Set<string>();
let noneCount = 0;
for (let i = 0; i < 200; i++) {
  const a = randomAppearance();
  combos.add(`${a.hairStyle}|${a.hairColor}|${a.shirt}|${a.accessory}`);
  if (a.accessory === "none") noneCount++;
}
check("200 抽有 >60 種不同組合", combos.size > 60, `實際 ${combos.size}`);
check("無配件比例合理(4~8 成)", noneCount >= 80 && noneCount <= 160, `none=${noneCount}`);

// --- 3. getTheme 覆蓋 ---
const ap: Appearance = { hairStyle: "long", hairColor: "#abc123", shirt: "#def456", pants: "#123abc", skin: "#456def", accessory: "cap" };
setCustomAppearance("test_x", ap);
const th = getTheme("test_x");
check("getTheme 髮色被覆蓋", th.hair === "#abc123");
check("getTheme 衣/褲/膚被覆蓋", th.shirt === "#def456" && th.pants === "#123abc" && th.skin === "#456def");
check("getCustomAppearance 取得登錄", getCustomAppearance("test_x")?.hairStyle === "long");

// --- 4. moveIn 整合 ---
const cand = getApplicants("r303")[0];
check("應徵者自帶外觀", !!cand.appearance);
moveIn("r303", cand);
const rt = state.runtimes[cand.id];
check("入住後租客帶外觀", !!rt?.tenant.appearance);
check("渲染層已登錄外觀", getCustomAppearance(cand.id) !== null);
// 辨識度補強(見 distinct-test):種子租客現在也有固定部件外觀(刺蝟頭+眼鏡),配色沿用原 Theme
check("種子租客(陳家豪)有固定部件外觀", getCustomAppearance("tenant_chen_engineer")?.hairStyle === "spiky");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
