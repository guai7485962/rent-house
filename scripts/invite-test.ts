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
  appearance: { hairStyle: "mohawk", hairColor: "red", accessory: "sword" },
});
check("非法原型 → office", dirty.applicant!.archetypeKey === "office");
check("非法性別 → nonbinary、取向過濾", dirty.applicant!.gender === "nonbinary" && dirty.applicant!.attractedTo.length === 1);
check("沒 coreTags → 補預設", dirty.applicant!.coreTags.length === 1);
check("租金夾到上限 20000", dirty.applicant!.monthlyRent === 20000);
check("非法偏好被剔除、合法夾 1~8", dirty.applicant!.preferences.cozy === 8 && !("magic" in dirty.applicant!.preferences));
check("非法髮型/配件 → short/none", dirty.applicant!.appearance!.hairStyle === "short" && dirty.applicant!.appearance!.accessory === "none");
check("非法色碼 → 回退池內色", /^#[0-9a-fA-F]{6}$/.test(dirty.applicant!.appearance!.hairColor));

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

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
