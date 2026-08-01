/**
 * 部件化外觀(§9-1)驗證:
 * - 所有髮型×配件圖層繪製不越界(sprite 11 寬)、非 short/none 有實際像素
 * - randomAppearance 變化量足夠、配件比例合理
 * - getTheme 被 Appearance 覆蓋(髮/衣/褲/膚色)
 * - moveIn 整合:入住者有外觀、渲染層有登錄
 * - 四方向(§facing4):背面/側面基底 sprite 的尺寸、色票、臉部有無;
 *   三個視角的疊層各自不越界且輪廓互異;側面左右互為鏡射;
 *   `agentView()` 的方向推導優先序
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
  CHAR_STAND_BACK,
  CHAR_WALK_BACK_A,
  CHAR_WALK_BACK_B,
  CHAR_STAND_SIDE_R,
  CHAR_WALK_SIDE_R_A,
  CHAR_WALK_SIDE_R_B,
  CHAR_SPRITES,
  mirrorSprite,
} = await import("../src/pixel/sprites");
const { agentView, clearFacingMemory } = await import("../src/floor/floorScene");
const { setCustomAppearance, getCustomAppearance, getTheme } = await import("../src/pixel/scene");
const { state, getApplicants, moveIn } = await import("../src/store");
import type { Appearance } from "../src/types";
import type { CharView, Ctx } from "../src/pixel/sprites";
import type { Agent } from "../src/floor/agents";

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
const ALL_VIEWS: CharView[] = ["front", "back", "side_r", "side_l"];
/** 背面刻意不畫的配件(從背後看不到鏡片);其餘每個視角都必須有像素 */
const HIDDEN_ON_BACK = new Set(["glasses", "round_glasses"]);
const overlayPixels = (view: CharView, hs: Appearance["hairStyle"], acc: Appearance["accessory"], color = "#111111") => {
  const { ctx, pixels } = mockCtx();
  drawAppearanceOverlay(ctx, { hairStyle: hs, hairColor: color, shirt: "#222222", pants: "#333333", skin: "#444444", accessory: acc }, 0, 0, view);
  return pixels;
};

let allInBounds = true;
let allInVerticalBounds = true;
let backHairInBounds = true;
let missingPixels: string[] = [];
let wrongBackAccessory: string[] = [];
for (const view of ALL_VIEWS) {
  for (const hs of ALL_HAIR_STYLES) {
    for (const acc of ALL_ACCESSORIES) {
      const pixels = overlayPixels(view, hs, acc);
      if (pixels.some((p) => p.x < 0 || p.x > 10)) allInBounds = false;
      // 正面/側面維持原本的頭部垂直帶;背面的長髮與馬尾**刻意**垂到上背(rows9-13),
      // 所以另給一條較寬、但仍止於軀幹下緣(row13)的帶,不會掉到腿上。
      const loose = view === "back" || view === "side_r" || view === "side_l";
      if (!loose && pixels.some((p) => p.y < -2 || p.y > 10)) allInVerticalBounds = false;
      if (loose && pixels.some((p) => p.y < -2 || p.y > 13)) backHairInBounds = false;
      const shouldBeEmpty = hs === "short" && (acc === "none" || (view === "back" && HIDDEN_ON_BACK.has(acc)));
      if (!shouldBeEmpty && pixels.length === 0) missingPixels.push(`${view}/${hs}+${acc}`);
    }
  }
}
for (const acc of ALL_ACCESSORIES) {
  // 背面:眼鏡類必須完全不畫;其餘(none 除外)必須有像素
  const only = overlayPixels("back", "short", acc).length - overlayPixels("back", "short", "none").length;
  if (HIDDEN_ON_BACK.has(acc) ? only !== 0 : acc !== "none" && only <= 0) wrongBackAccessory.push(acc);
}
check("四視角所有髮型×配件像素都在 sprite 11 寬內", allInBounds);
check("非預設組合都有實際像素(背面眼鏡類除外)", missingPixels.length === 0, missingPixels.join(","));
check("背面眼鏡類不畫、其餘配件有畫", wrongBackAccessory.length === 0, wrongBackAccessory.join(","));
check("背面/側面疊層最多垂到軀幹下緣(row13)", backHairInBounds);

// 側面左右必須互為鏡射(單一手繪來源;鏡射軸 = sprite 11 寬)
let mirrorOk = true;
for (const hs of ALL_HAIR_STYLES)
  for (const acc of ALL_ACCESSORIES) {
    const r = overlayPixels("side_r", hs, acc).map((p) => `${10 - p.x},${p.y}`).sort().join("|");
    const l = overlayPixels("side_l", hs, acc).map((p) => `${p.x},${p.y}`).sort().join("|");
    if (r !== l) mirrorOk = false;
  }
check("側面朝左疊層是朝右的水平鏡射", mirrorOk);

// --- 2. 隨機外觀變化量 ---
check("所有髮型與配件維持頭部垂直對位", allInVerticalBounds);

const spriteEntries = [
  ["stand", CHAR_STAND, 19, 11],
  ["sit", CHAR_SIT, 14, 11],
  ["walkA", CHAR_WALK_A, 19, 11],
  ["walkB", CHAR_WALK_B, 19, 11],
  ["sitBack", CHAR_SIT_BACK, 12, 11],
  ["lie", CHAR_LIE, 7, 22],
  ["standBack", CHAR_STAND_BACK, 19, 11],
  ["walkBackA", CHAR_WALK_BACK_A, 19, 11],
  ["walkBackB", CHAR_WALK_BACK_B, 19, 11],
  ["standSide", CHAR_STAND_SIDE_R, 19, 11],
  ["walkSideA", CHAR_WALK_SIDE_R_A, 19, 11],
  ["walkSideB", CHAR_WALK_SIDE_R_B, 19, 11],
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

// --- 2b. 四方向基底 sprite ---
const HEAD = (rows: readonly string[]) => rows.slice(0, 9).join("");
const BACK_SPRITES = [CHAR_STAND_BACK, CHAR_WALK_BACK_A, CHAR_WALK_BACK_B];
const SIDE_SPRITES = [CHAR_STAND_SIDE_R, CHAR_WALK_SIDE_R_A, CHAR_WALK_SIDE_R_B];
check(
  "背面三張都看不到臉(頭部無 k 眼睛、全圖無 m 嘴)",
  BACK_SPRITES.every((rows) => !HEAD(rows).includes("k") && !rows.join("").includes("m")),
);
check(
  "側面三張都只有一顆眼睛與一張嘴",
  SIDE_SPRITES.every((rows) => HEAD(rows).split("k").length - 1 === 1 && rows.join("").split("m").length - 1 === 1),
);
/** 軀幹輪廓寬度:rows9-13 之中最寬的一列(含手,取首末實心格的跨距) */
const torsoSpan = (rows: readonly string[]) =>
  Math.max(...rows.slice(9, 14).map((row) => row.replace(/\.+$/, "").length - row.search(/[^.]/)));
check(
  "側面軀幹輪廓比正面窄(只露一隻手)",
  SIDE_SPRITES.every((rows) => torsoSpan(rows) < torsoSpan(CHAR_STAND)),
  `側面 ${SIDE_SPRITES.map(torsoSpan).join("/")} vs 正面 ${torsoSpan(CHAR_STAND)}`,
);
check(
  "背面/側面走路雙幀同時改變手臂與腿部",
  HEAD(CHAR_WALK_BACK_A) === HEAD(CHAR_STAND_BACK)
    && CHAR_WALK_BACK_A.slice(9, 14).join("") !== CHAR_WALK_BACK_B.slice(9, 14).join("")
    && CHAR_WALK_BACK_A.slice(16).join("") !== CHAR_WALK_BACK_B.slice(16).join("")
    && CHAR_WALK_SIDE_R_A.slice(9, 14).join("") !== CHAR_WALK_SIDE_R_B.slice(9, 14).join("")
    && CHAR_WALK_SIDE_R_A.slice(16).join("") !== CHAR_WALK_SIDE_R_B.slice(16).join(""),
);
check("mirrorSprite 兩次還原(對合)", mirrorSprite(mirrorSprite(CHAR_STAND_SIDE_R)).join("|") === CHAR_STAND_SIDE_R.join("|"));
check(
  "CHAR_SPRITES 的 side_l 就是 side_r 的鏡射,front 維持原有 sprite",
  CHAR_SPRITES.side_l.stand.join("|") === mirrorSprite(CHAR_SPRITES.side_r.stand).join("|")
    && CHAR_SPRITES.side_l.walkA.join("|") === mirrorSprite(CHAR_SPRITES.side_r.walkA).join("|")
    && CHAR_SPRITES.side_l.walkB.join("|") === mirrorSprite(CHAR_SPRITES.side_r.walkB).join("|")
    && CHAR_SPRITES.front.stand === CHAR_STAND,
);
check(
  "四個視角的站姿輪廓互不相同(一眼可分)",
  new Set(ALL_VIEWS.map((v) => CHAR_SPRITES[v].stand.join("|"))).size === 4,
);

// --- 2c. 方向推導優先序(agentView;規則見 floorScene 的註解) ---
const mkAgent = (o: Partial<Agent>): Agent => ({
  tenantId: "view_probe", c: 5, r: 5, px: 80, py: 80, path: [], goal: null,
  moving: false, hidden: false, walkPhase: 0, vs: "idle", pose: null, facing: 0,
  poseRotation: 0, poseOffsetX: 0, poseOffsetY: 0, seatBack: false, ...o,
});
const walkTo = (dc: number, dr: number) => mkAgent({ moving: true, path: [{ c: 5 + dc, r: 5 + dr }] });
clearFacingMemory();
check(
  "規則2:移動中由 path[0] 推出四方向",
  agentView(walkTo(0, 1)) === "front" && agentView(walkTo(0, -1)) === "back"
    && agentView(walkTo(1, 0)) === "side_r" && agentView(walkTo(-1, 0)) === "side_l",
);
clearFacingMemory();
check("規則4:零記憶且靜止 → 正面", agentView(mkAgent({})) === "front");
clearFacingMemory();
agentView(walkTo(0, -1));
check("規則3:靜止沿用最後已知方向", agentView(mkAgent({})) === "back");
check(
  "規則1:stand_face 的 facing 優先於記憶",
  agentView(mkAgent({ pose: "stand_face", facing: 1 })) === "side_r"
    && agentView(mkAgent({ pose: "stand_face", facing: -1 })) === "side_l",
);
check("規則1:facing=0(垂直相鄰)不強制側面,落回記憶", agentView(mkAgent({ pose: "stand_face", facing: 0 })) === "side_l");
check("例外:cook_pair 一律正面(料理提示像素是照正面畫的)", agentView(mkAgent({ pose: "cook_pair" })) === "front");
clearFacingMemory();
check("clearFacingMemory 後回到決定性的正面", agentView(mkAgent({})) === "front");

const signature = (hairStyle: Appearance["hairStyle"], accessory: Appearance["accessory"], view: CharView = "front") =>
  overlayPixels(view, hairStyle, accessory, "#553322").map((p) => `${p.x},${p.y}`).sort().join("|");
check(
  "四視角的五種髮型都有可辨識的不同輪廓",
  ALL_VIEWS.every((v) => new Set(ALL_HAIR_STYLES.map((hair) => signature(hair, "none", v))).size === ALL_HAIR_STYLES.length),
);
check(
  "六種配件都有可辨識的不同輪廓",
  new Set(ALL_ACCESSORIES.map((accessory) => signature("short", accessory))).size === ALL_ACCESSORIES.length,
);
check(
  "側面六種配件仍互異;背面扣掉刻意不畫的眼鏡類後互異",
  new Set(ALL_ACCESSORIES.map((a) => signature("short", a, "side_r"))).size === ALL_ACCESSORIES.length
    && new Set(ALL_ACCESSORIES.filter((a) => !HIDDEN_ON_BACK.has(a)).map((a) => signature("short", a, "back"))).size
      === ALL_ACCESSORIES.length - HIDDEN_ON_BACK.size,
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
