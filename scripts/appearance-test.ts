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
let missingPixels: string[] = [];
for (const hs of ALL_HAIR_STYLES) {
  for (const acc of ALL_ACCESSORIES) {
    const { ctx, pixels } = mockCtx();
    const ap: Appearance = { hairStyle: hs, hairColor: "#111111", shirt: "#222222", pants: "#333333", skin: "#444444", accessory: acc };
    drawAppearanceOverlay(ctx, ap, 0, 0);
    if (pixels.some((p) => p.x < 0 || p.x > 10)) allInBounds = false;
    if (hs !== "short" || acc !== "none") {
      if (pixels.length === 0) missingPixels.push(`${hs}+${acc}`);
    }
  }
}
check("所有髮型×配件像素都在 sprite 11 寬內", allInBounds);
check("非預設組合都有實際像素", missingPixels.length === 0, missingPixels.join(","));

// --- 2. 隨機外觀變化量 ---
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
check("種子租客(陳家豪)不受影響", getCustomAppearance("tenant_chen_engineer") === null);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
