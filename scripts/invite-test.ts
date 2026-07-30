/**
 * 特邀租客(§9-3)驗證:
 * - 消毒:白名單/夾值(作息原型、外觀部件、數值、租金、偏好)
 * - 硬規則:isAdult !== true 一律拒收;未成年關鍵字前端快篩
 * - canRomance:未成年角色整條戀愛線被擋
 * - 整合:消毒後的應徵者入住 → isAdult/外觀正確落地
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { sanitizeInvited, looksMinor } = await import("../src/sim/invite");
const { canRomance } = await import("../src/sim/social");
const { getCustomAppearance } = await import("../src/pixel/scene");
const { state, moveIn } = await import("../src/store");
const { relLuma, clampLuma, separateHairFromSkin } = await import("../src/pixel/color");
const {
  HAIR_COLORS, SHIRT_COLORS, PANTS_COLORS, SKIN_TONES,
  HAIR_LUMA_BAND, SHIRT_LUMA_BAND, PANTS_LUMA_BAND, MIN_HAIR_SKIN_DELTA,
  sanitizeAppearanceColors,
} = await import("../src/pixel/parts");
import type { Tenant } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const validRaw = {
  occupation: "狙擊手",
  bio: "沉默寡言,觀察力極強,愛喝黑咖啡。",
  isAdult: true,
  gender: "male",
  attractedTo: ["female"],
  archetypeKey: "freelancer",
  coreTags: [
    { id: "sniper", label: "[神射手]", behaviorHint: "行事冷靜精準。" },
    { id: "coffee", label: "[黑咖啡成癮]", behaviorHint: "整天一杯接一杯。" },
  ],
  stats: { mood: 65, stress: 35, wellbeing: 75, energy: 70, affinity: 50 },
  preferences: { soundproof: 7, style: 4 },
  monthlyRent: 17777,
  appearance: { hairStyle: "short", hairColor: "#241f2c", shirt: "#3a3d46", pants: "#30363f", skin: "#e8b088", accessory: "cap" },
};

// --- 1. 正常消毒 ---
const ok1 = sanitizeInvited("赤井秀一", validRaw, undefined, "dog");
check("合法角色通過消毒", ok1.ok && !!ok1.applicant);
check("租金取整到百位且夾範圍", ok1.applicant!.monthlyRent === 17800);
check("作息原型合法沿用", ok1.applicant!.archetypeKey === "freelancer");
check("外觀部件沿用", ok1.applicant!.appearance!.accessory === "cap");
check("isAdult = true", ok1.applicant!.isAdult === true);
check("玩家指定特邀租客帶狗", ok1.applicant!.pet?.kind === "dog");
const playerGender = sanitizeInvited("花木蘭", { ...validRaw, gender: "male" }, "female");
check("建立畫面指定的性別優先於 AI 猜測", playerGender.applicant?.gender === "female");
check("預設不帶寵物", !playerGender.applicant?.pet);
const invitedCat = sanitizeInvited("貓奴店長", validRaw, "nonbinary", "cat");
check("玩家指定特邀租客帶貓", invitedCat.applicant?.pet?.kind === "cat");
const invalidPet = sanitizeInvited("奇獸愛好者", validRaw, "male", "rabbit" as any);
check("未知寵物選項安全回退為不帶寵物", !invalidPet.applicant?.pet);

// --- 2. 未成年拒收 ---
check("isAdult:false → 拒收", !sanitizeInvited("某角色", { ...validRaw, isAdult: false }).ok);
check("isAdult 缺欄 → 拒收", !sanitizeInvited("某角色", { ...validRaw, isAdult: undefined }).ok);
check("isAdult:'true'(字串)→ 拒收(嚴格)", !sanitizeInvited("某角色", { ...validRaw, isAdult: "true" }).ok);
check("關鍵字快篩:小學生", looksMinor("小學生外表的名偵探"));
check("關鍵字快篩:高中", looksMinor("普通的高中女生"));
check("關鍵字快篩:成人描述不誤擋", !looksMinor("沉默寡言的狙擊手,晝伏夜出"));

// --- 3. 垃圾欄位 → 白名單預設 ---
const dirty = sanitizeInvited("測試", {
  isAdult: true,
  archetypeKey: "hacker_9000",
  gender: "robot",
  attractedTo: ["female", "toaster"],
  coreTags: "not-an-array",
  stats: { mood: 999, stress: -50 },
  preferences: { magic: 99, cozy: 99 },
  monthlyRent: 999999,
  // skin 給極淺的池內色,讓髮膚 ΔL 對任何髮色回退值都必然達標
  // → 「回退到池內色」這條斷言才是決定性的(不會被 ΔL 微調弄成 flaky)
  appearance: { hairStyle: "mohawk", hairColor: "red", skin: "#ffdbac", accessory: "sword" },
});
check("非法原型 → office", dirty.applicant!.archetypeKey === "office");
check("非法性別 → nonbinary、取向過濾", dirty.applicant!.gender === "nonbinary" && dirty.applicant!.attractedTo.length === 1);
check("沒 coreTags → 補預設", dirty.applicant!.coreTags.length === 1);
check("租金夾到上限 20000", dirty.applicant!.monthlyRent === 20000);
check("非法偏好被剔除、合法夾 1~8", dirty.applicant!.preferences.cozy === 8 && !("magic" in dirty.applicant!.preferences));
check("非法髮型/配件 → short/none", dirty.applicant!.appearance!.hairStyle === "short" && dirty.applicant!.appearance!.accessory === "none");
// ⚠️ 舊版這裡只驗 hex 格式,是假保護(`#fdfdfd` 也能通過)。改成實質斷言:
// 回退色必須真的在池內,而且整組顏色都通過亮度帶/白名單/髮膚分離。
const dirtyAp = dirty.applicant!.appearance!;
check("非法色碼 → 回退池內色(實質:真的在 HAIR_COLORS 裡)", HAIR_COLORS.includes(dirtyAp.hairColor));
check("回退後髮色仍在亮度帶內", relLuma(dirtyAp.hairColor) >= HAIR_LUMA_BAND.lo && relLuma(dirtyAp.hairColor) <= HAIR_LUMA_BAND.hi);
check("回退後膚色在白名單內", SKIN_TONES.includes(dirtyAp.skin));
check("回退後髮膚亮度差達標", Math.abs(relLuma(dirtyAp.hairColor) - relLuma(dirtyAp.skin)) >= MIN_HAIR_SKIN_DELTA);

// --- 4. canRomance 擋未成年 ---
const adult = { isAdult: true, gender: "male", attractedTo: ["female"] } as unknown as Tenant;
const adultF = { isAdult: true, gender: "female", attractedTo: ["male"] } as unknown as Tenant;
const minorF = { isAdult: false, gender: "female", attractedTo: ["male"] } as unknown as Tenant;
const legacy = { gender: "female", attractedTo: ["male"] } as unknown as Tenant; // 內建角色(無欄位=成年)
check("成人×成人 → 可戀愛", canRomance(adult, adultF));
check("成人×未成年 → 擋", !canRomance(adult, minorF));
check("內建角色(無 isAdult 欄)視為成年", canRomance(adult, legacy));

// --- 5. 整合:入住 ---
moveIn("r304", ok1.applicant!);
const rt = state.runtimes[ok1.applicant!.id];
check("特邀租客入住 r304", !!rt && state.occupancy.r304 === ok1.applicant!.id);
check("Tenant.isAdult = true", rt!.tenant.isAdult === true);
check("外觀已登錄渲染層", getCustomAppearance(ok1.applicant!.id)?.accessory === "cap");
check("指定的狗隨特邀租客入住", state.pets[ok1.applicant!.id]?.kind === "dog");
check("入住狗的飼主正確", state.pets[ok1.applicant!.id]?.ownerId === ok1.applicant!.id);

// --- 6. AI 色碼安全化(亮度帶 / 膚色白名單 / 髮膚分離 / 冪等 / 護欄)---
//
// 這裡刻意**不用「vs 背景」的 WCAG 對比**:專案自家色池對背景的 CR 幾乎全在 1.0~1.3
// (SHIRT `#5aa06a` vs r301 地板 `#b08a5e` → CR 1.00),那套模型會把現有美術整批判成違規;
// 背景也不是常數(各區地板亮度 0.215~0.617,夜間 tint 還會再壓縮)。
// 改用背景無關的「per-slot 亮度帶 + 髮膚 ΔL」,並用下面的護欄證明沒誤殺自家色池。

const inBand = (hex: string, band: { lo: number; hi: number }) => {
  const l = relLuma(hex);
  return l >= band.lo && l <= band.hi;
};
const dL = (a: string, b: string) => Math.abs(relLuma(a) - relLuma(b));
const colorRaw = (ap: Record<string, string>) => ({ ...validRaw, appearance: { hairStyle: "short", accessory: "none", ...ap } });
const sanAp = (ap: Record<string, string>) => sanitizeInvited("色測", colorRaw(ap)).applicant!.appearance!;

// 6a. 亮度帶夾值(「只驗格式」擋不住的那些)
const whiteHair = sanAp({ hairColor: "#fdfdfd", shirt: "#5aa06a", pants: "#3d4257", skin: "#f0c19a" });
check("#fdfdfd 髮色 → 夾到帶上限內", inBand(whiteHair.hairColor, HAIR_LUMA_BAND),
  `${whiteHair.hairColor} L=${relLuma(whiteHair.hairColor).toFixed(4)} > ${HAIR_LUMA_BAND.hi}`);
const blackShirt = sanAp({ hairColor: "#241f2c", shirt: "#000000", pants: "#3d4257", skin: "#f0c19a" });
check("#000000 衣色 → 抬到帶下限以上", inBand(blackShirt.shirt, SHIRT_LUMA_BAND),
  `${blackShirt.shirt} L=${relLuma(blackShirt.shirt).toFixed(4)} < ${SHIRT_LUMA_BAND.lo}`);
const whitePants = sanAp({ hairColor: "#241f2c", shirt: "#5aa06a", pants: "#ffffff", skin: "#f0c19a" });
check("#ffffff 褲色 → 夾到帶上限內", inBand(whitePants.pants, PANTS_LUMA_BAND),
  `${whitePants.pants} L=${relLuma(whitePants.pants).toFixed(4)} > ${PANTS_LUMA_BAND.hi}`);

// 6b. 色相保留:用 R/G/B 的**相對大小關係**驗(shade 往白內插會洗掉飽和度,不能比精確值)
const order = (hex: string): [boolean, boolean, boolean] => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return [r > g, g > b, r > b];
};
const sameOrder = (a: string, b: string) => order(a).every((v, i) => v === order(b)[i]);
const redHair = sanAp({ hairColor: "#ff0000", shirt: "#5aa06a", pants: "#3d4257", skin: "#f0c19a" });
check("#ff0000 髮色夾後仍是紅系(R/G/B 大小關係不變)", sameOrder(redHair.hairColor, "#ff0000"), redHair.hairColor);
// 真的會被夾的亮紅:確認夾值本身也不翻轉色相
const litRedHair = clampLuma("#ffcccc", HAIR_LUMA_BAND);
check("被夾的亮紅髮色仍是紅系", sameOrder(litRedHair, "#ffcccc") && inBand(litRedHair, HAIR_LUMA_BAND), litRedHair);
const litGreenShirt = clampLuma("#ccffcc", SHIRT_LUMA_BAND);
check("被夾的亮綠衣色仍是綠系", sameOrder(litGreenShirt, "#ccffcc") && inBand(litGreenShirt, SHIRT_LUMA_BAND), litGreenShirt);

// 6c. 膚色走白名單(零 RNG 的最近距離 snap)
const greenSkin = sanAp({ hairColor: "#241f2c", shirt: "#5aa06a", pants: "#3d4257", skin: "#00ff00" });
check("膚色 #00ff00 → snap 到 SKIN_TONES 之內", SKIN_TONES.includes(greenSkin.skin), greenSkin.skin);
check("SKIN_TONES 已擴充到 8 色以上", SKIN_TONES.length >= 8, String(SKIN_TONES.length));

// 6d. 冪等性:夾值會在 invite → makeRuntime → 每次 load 反覆執行,不冪等會讓髮色每讀一次檔就暗一階
const idemCases = [
  { hairColor: "#fdfdfd", shirt: "#000000", pants: "#ffffff", skin: "#00ff00" },
  { hairColor: "#c8a050", shirt: "#e8e2d4", pants: "#3d4257", skin: "#d99a6c" },
  { hairColor: "#ff0000", shirt: "#0000ff", pants: "#00ff00", skin: "#ffffff" },
  { hairColor: "#000000", shirt: "#ffffff", pants: "#000000", skin: "#8d5524" },
];
let idemOk = true;
let idemDetail = "";
for (const c of idemCases) {
  const once = sanitizeAppearanceColors(c);
  const twice = sanitizeAppearanceColors(once);
  if (JSON.stringify(once) !== JSON.stringify(twice)) {
    idemOk = false;
    idemDetail = `${JSON.stringify(once)} → ${JSON.stringify(twice)}`;
  }
}
check("冪等性 sanitize(sanitize(x)) === sanitize(x)", idemOk, idemDetail);

// 6e. 髮膚分離:任意輸入下 |L(hair) − L(skin)| >= 0.10
let sepOk = true;
let sepDetail = "";
const sepProbes = ["#fdfdfd", "#000000", "#ff0000", "#c8a050", "#8a4a5a", "#241f2c", "#7f7f7f", "#b58a4a"];
for (const h of sepProbes) {
  for (const s of [...SKIN_TONES, "#00ff00", "#ffffff", "#000000", "#123456"]) {
    const out = sanitizeAppearanceColors({ hairColor: h, shirt: "#5aa06a", pants: "#3d4257", skin: s });
    if (dL(out.hairColor, out.skin) < MIN_HAIR_SKIN_DELTA - 1e-9) {
      sepOk = false;
      sepDetail = `hair ${h} + skin ${s} → ${out.hairColor}/${out.skin} ΔL=${dL(out.hairColor, out.skin).toFixed(4)}`;
    }
  }
}
check(`髮膚亮度差 >= ${MIN_HAIR_SKIN_DELTA}(${sepProbes.length}×${SKIN_TONES.length + 4} 組)`, sepOk, sepDetail);
// 膚色極深時「往暗夾」走不通,分離函式必須改往亮夾(白名單擋掉了這種膚色,純防禦)
const deepSkinSep = separateHairFromSkin("#241f2c", "#000000", HAIR_LUMA_BAND, MIN_HAIR_SKIN_DELTA);
check("膚色極深時改往亮夾仍達標", dL(deepSkinSep, "#000000") >= MIN_HAIR_SKIN_DELTA && inBand(deepSkinSep, HAIR_LUMA_BAND), deepSkinSep);

// 6f. 🔴 護欄:現有四個色池的**每一色**經 per-slot 夾值後必須原樣返回。
// 這是本方案相對「vs 背景」方案的關鍵分野 —— 沒有它就無法證明沒把自家美術判違規。
// ⚠️ 這幾條只驗 **per-slot 夾值**(只呼叫 clampLuma),**不經過髮膚 ΔL**。
//    跨 slot 的 blast radius 由下面 6g 的「10 組」釘死,兩者不可互相取代。
const guard = (name: string, pool: readonly string[], band: { lo: number; hi: number }) => {
  const bad = pool.filter((c) => clampLuma(c, band) !== c);
  check(`護欄:${name} ${pool.length} 色 per-slot 夾值後原樣返回`, bad.length === 0, bad.join(","));
};
guard("HAIR_COLORS", HAIR_COLORS, HAIR_LUMA_BAND);
guard("SHIRT_COLORS", SHIRT_COLORS, SHIRT_LUMA_BAND);
guard("PANTS_COLORS", PANTS_COLORS, PANTS_LUMA_BAND);
// ⚠️ 髮色寫死 #241f2c(L 0.0154)對 9 色膚色 ΔL 都遠超門檻,所以這條也**沒有觸發 ΔL 路徑**
const skinBad = SKIN_TONES.filter((c) => sanitizeAppearanceColors({ hairColor: "#241f2c", shirt: "#5aa06a", pants: "#3d4257", skin: c }).skin !== c);
check(`護欄:SKIN_TONES ${SKIN_TONES.length} 色 snap 後原樣返回(未觸發 ΔL)`, skinBad.length === 0, skinBad.join(","));
// 種子租客(SEED_APPEARANCES)的手繪配色也必須毫髮無傷 → ui:shot 才會 pixel 完全相同
const seedAps = [
  { hairColor: "#3a3346", shirt: "#5f86b0", pants: "#464b63", skin: "#f0c19a" },
  { hairColor: "#8a5540", shirt: "#df90ae", pants: "#6f5d80", skin: "#f4c9a6" },
];
const seedBad = seedAps.filter((a) => JSON.stringify(sanitizeAppearanceColors(a)) !== JSON.stringify(a));
check("護欄:種子租客固定外觀消毒後不變", seedBad.length === 0, JSON.stringify(seedBad));

// 6g. 🔴 釘死 ΔL 的 blast radius:自家 HAIR × SKIN 全交叉 8×9 = 72 組,恰好 10 組會被調整。
// 這 10 組的**期望輸出**寫死在下表 —— 以後誰動亮度帶或膚色池,這個影響面就會被測試叫住,
// 不會像現在這樣只靠日誌裡的一句話記錄。
const DELTA_ADJUSTED: [hair: string, skin: string, expected: string][] = [
  ["#4a3a2a", "#8d5524", "#32271d"],
  ["#7a4530", "#8d5524", "#3d2318"],
  ["#7a4530", "#a5673f", "#75422e"],
  ["#b58a4a", "#b57a52", "#836436"],
  ["#b58a4a", "#c68e6a", "#a17b42"],
  ["#5a3020", "#8d5524", "#3f2217"],
  ["#c8a050", "#d99a6c", "#b08d46"],
  ["#c8a050", "#c68e6a", "#9c7d3e"],
  ["#8a4a5a", "#8d5524", "#3e2128"],
  ["#8a4a5a", "#a5673f", "#763f4d"],
];
const adjusted: string[] = [];
const wrong: string[] = [];
const expectedMap = new Map(DELTA_ADJUSTED.map(([h, s, e]) => [`${h}|${s}`, e]));
for (const h of HAIR_COLORS) {
  for (const s of SKIN_TONES) {
    const out = sanitizeAppearanceColors({ hairColor: h, shirt: "#5aa06a", pants: "#3d4257", skin: s });
    const exp = expectedMap.get(`${h}|${s}`);
    if (out.hairColor !== h) adjusted.push(`${h}|${s}`);
    if (exp === undefined && out.hairColor !== h) wrong.push(`未預期被調整 ${h}+${s} → ${out.hairColor}`);
    if (exp !== undefined && out.hairColor !== exp) wrong.push(`${h}+${s} 期望 ${exp} 實得 ${out.hairColor}`);
  }
}
check(
  `ΔL blast radius 釘死:HAIR×SKIN ${HAIR_COLORS.length * SKIN_TONES.length} 組中恰 ${DELTA_ADJUSTED.length} 組被調整`,
  adjusted.length === DELTA_ADJUSTED.length && wrong.length === 0,
  `實得 ${adjusted.length} 組;${wrong.join(" / ")}`,
);

// 6h. 格式回退:第 2、3 道防線(makeRuntime / load)沒有 pickColor 擋在前面,
// 而 importSave() 會吃玩家提供的任意 JSON。髒格式必須在消毒函式內部就被換掉,
// 否則渲染層的 shade() 會 parseInt("") → NaN → 產生 #ffNaNNaN 這種無效 fillStyle。
const isHex6 = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
const dirtyColorCases: Record<string, unknown>[] = [
  { hairColor: "red", shirt: "not-a-color", pants: "#GGGGGG", skin: "purple" },
  { hairColor: "#fff", shirt: "#fff", pants: "#fff", skin: "#fff" }, // 三碼 hex 是合法 CSS,但渲染層吃不下
  { hairColor: "", shirt: "#12345", pants: "#1234567", skin: "rgb(1,2,3)" },
  { hairColor: null, shirt: undefined, pants: 12345, skin: { r: 1 } },
];
let dirtyOk = true;
let dirtyDetail = "";
for (const c of dirtyColorCases) {
  const out = sanitizeAppearanceColors(c as any);
  const allHex = isHex6(out.hairColor) && isHex6(out.shirt) && isHex6(out.pants) && isHex6(out.skin);
  const bandOk = inBand(out.hairColor, HAIR_LUMA_BAND) && inBand(out.shirt, SHIRT_LUMA_BAND) && inBand(out.pants, PANTS_LUMA_BAND);
  const skinOk = SKIN_TONES.includes(out.skin);
  const sepOk2 = dL(out.hairColor, out.skin) >= MIN_HAIR_SKIN_DELTA;
  const idem = JSON.stringify(sanitizeAppearanceColors(out)) === JSON.stringify(out);
  if (!(allHex && bandOk && skinOk && sepOk2 && idem)) {
    dirtyOk = false;
    dirtyDetail = `${JSON.stringify(c)} → ${JSON.stringify(out)}`;
  }
}
check(`髒格式色碼 ${dirtyColorCases.length} 組全部回退成合法池內色(且在帶內、冪等)`, dirtyOk, dirtyDetail);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
