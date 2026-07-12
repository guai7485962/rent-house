/**
 * 寵物貓系統驗證:
 * - 種子貓:陳家豪的橘貓「橘子」開局就在
 * - hangout 每小時輪換且都是合法區域(飼主房/交誼廳/別人的房)
 * - 串門子:親貓的人被療癒(心情↑、關係↑)、怕貓/潔癖的人被嚇到(壓力↑、關係↓)
 * - 搗蛋:打破東西 / 隨地大小便(清潔度↓、有冷卻不連發)
 * - adoptCat:一人一隻不重複;飼主退租貓跟著走;存檔往返保留
 * - 日記整合:飼主的 narrate ctx 帶「養了一隻貓」
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { petsPass, adoptCat, catAttitude, ensurePets, mischiefRelief } = await import("../src/sim/pets");
const { produceDailyDiaries, setNarrateImplForTest, diaryTiming } = await import("../src/sim/narration");
const { relationships, pairKey } = await import("../src/sim/social");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn, moveOut } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");
const { state } = await import("../src/store");
import type { NarrateCtx, NarrateResult } from "../src/sim/narrate";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const CHEN = "tenant_chen_engineer";
const LIN = "tenant_lin_asmr";

// --- 種子貓 ---
check("種子貓:陳家豪開局就養橘子", state.pets[CHEN]?.name === "橘子" && state.pets[CHEN]?.kind === "cat");
check("橘子是橘貓(color 0)", state.pets[CHEN]?.color === 0);

// --- 對貓的態度判定 ---
const mk = (label: string) => ({ id: "x", label, behaviorHint: "", acquiredAt: "", source: "ai_event" as const, intensity: 1 });
const tenantLike = { ...state.runtimes[LIN].tenant, coreTags: [mk("貓奴")], memoryTags: [], occupation: "上班族", bio: "" };
const tenantHate = { ...state.runtimes[LIN].tenant, coreTags: [mk("潔癖")], memoryTags: [], occupation: "上班族", bio: "" };
const tenantMeh = { ...state.runtimes[LIN].tenant, coreTags: [mk("樂觀")], memoryTags: [], occupation: "上班族", bio: "平凡人" };
check("態度:貓奴 → like", catAttitude(tenantLike) === "like");
check("態度:潔癖 → dislike", catAttitude(tenantHate) === "dislike");
check("態度:無關標籤 → neutral", catAttitude(tenantMeh) === "neutral");

// --- hangout 輪換:全是合法區域,且逛得夠廣 ---
const chenRoom = "r301";
const seen = new Set<string>();
for (let i = 0; i < 300; i++) {
  petsPass();
  seen.add(state.pets[CHEN].hangout);
}
const legal = new Set(["r301", "r302", "lounge", ...Object.keys(state.occupancy)]);
check("hangout 全是合法區域", [...seen].every((h) => legal.has(h)), JSON.stringify([...seen]));
check("會待在自己房", seen.has(chenRoom));
check("會去交誼廳", seen.has("lounge"));
check("會溜進別人的房", [...seen].some((h) => h !== chenRoom && h !== "lounge"));

// --- 串門子:親貓的鄰居被療癒 ---
const lin = state.runtimes[LIN];
lin.tenant.coreTags = [mk("貓奴")];
lin.tenant.visualState = "idle";
const clearPetCd = () => {
  for (const k of Object.keys(state.interactionCooldowns)) if (k.startsWith("pet|")) delete state.interactionCooldowns[k];
};
relationships[pairKey(CHEN, LIN)] = { value: 40, romantic: false, cohabitOffered: false };
const relOf = () => relationships[pairKey(CHEN, LIN)].value;
let relBefore = relOf();
lin.log.splice(0);
for (let i = 0; i < 400 && !lin.log.some((e) => e.text.includes("療癒")); i++) {
  clearPetCd();
  petsPass();
}
check("親貓鄰居:出現被療癒日誌", lin.log.some((e) => e.text.includes("蹭他的腳邊")));
check("親貓鄰居:飼主也有一筆(串門子)", state.runtimes[CHEN].log.some((e) => e.text.includes("串門子")));
check("親貓鄰居:關係上升", relOf() > relBefore, `${relBefore} → ${relOf()}`);

// --- 串門子:怕貓/潔癖的鄰居被嚇到 ---
lin.tenant.coreTags = [mk("潔癖")];
lin.tenant.stats.stress = 40;
relationships[pairKey(CHEN, LIN)] = { value: 40, romantic: false, cohabitOffered: false };
relBefore = relOf();
lin.log.splice(0);
for (let i = 0; i < 400 && !lin.log.some((e) => e.text.includes("嚇了他一大跳")); i++) {
  clearPetCd();
  petsPass();
}
check("潔癖鄰居:出現被嚇到日誌", lin.log.some((e) => e.text.includes("嚇了他一大跳")));
check("潔癖鄰居:壓力上升", lin.tenant.stats.stress > 40);
check("潔癖鄰居:關係下降", relOf() < relBefore, `${relBefore} → ${relOf()}`);

// --- 搗蛋:打破東西 / 隨地大小便(多跑幾輪必出) ---
const chen = state.runtimes[CHEN];
chen.log.splice(0);
lin.log.splice(0);
for (let i = 0; i < 600; i++) {
  clearPetCd();
  petsPass();
}
check("搗蛋:出現打破東西事件", chen.log.some((e) => e.text.includes("摔得粉碎") || e.text.includes("打破")));
check("搗蛋:出現隨地大小便事件", chen.log.some((e) => e.text.includes("驚喜")) || lin.log.some((e) => e.text.includes("驚喜")));

// --- 冷卻:不清冷卻連跑 5 小時,搗蛋最多各一次 ---
chen.log.splice(0);
lin.log.splice(0);
clearPetCd();
for (let i = 0; i < 5; i++) petsPass();
const breaks = chen.log.filter((e) => e.text.includes("摔得粉碎")).length;
const poops = [...chen.log, ...lin.log].filter((e) => e.text.includes("驚喜")).length;
check("冷卻生效:5 小時內打破 ≤1 次", breaks <= 1, `實際 ${breaks}`);
check("冷卻生效:5 小時內大小便 ≤2 筆(苦主+飼主各一)", poops <= 2, `實際 ${poops}`);

// --- adoptCat ---
check("adoptCat:已有貓的人不重複領養", adoptCat(CHEN) === null);
const newPet = adoptCat(LIN);
check("adoptCat:林小姐領到一隻貓", !!newPet && state.pets[LIN]?.name === newPet!.name);
check("adoptCat:非橘子花色(1~3)", !!newPet && newPet!.color >= 1 && newPet!.color <= 3);
check("adoptCat:有系統通知", state.noticeLog.some((n) => n.text.includes("養了一隻貓")));

// --- adoptCat preset(應徵者自帶貓:指定名字/花色,§A-1)---
delete state.pets[LIN];
adoptCat(LIN, { name: "指定貓", color: 2 });
check("adoptCat preset:名字/花色照給", state.pets[LIN]?.name === "指定貓" && state.pets[LIN]?.color === 2);

// --- catAttitude 接受應徵者結構子集(§A-1 招租卡用)---
check("catAttitude:貓奴描述 → like", catAttitude({ coreTags: [{ label: "[貓奴]" }], occupation: "上班族", bio: "" }) === "like");
check("catAttitude:潔癖 → dislike", catAttitude({ coreTags: [{ label: "[潔癖]" }], occupation: "", bio: "" }) === "dislike");
check("catAttitude:一般人 → neutral", catAttitude({ coreTags: [{ label: "[樂觀]" }], occupation: "工程師", bio: "平凡" }) === "neutral");

// --- 貓咪家具降低搗蛋(§A-2:貓砂盆/貓跳台)---
// r301 種子就有貓跳台(橘子的跳台),r302 無任何貓咪家具 → 用兩間對照
const { addPlacement } = await import("../src/sim/placements");
const chenPet = state.pets[CHEN]; // r301(有貓跳台)
const linPet = state.pets[LIN]; // r302(無貓咪家具)
check("r302 無貓咪家具:兩乘數皆 1", mischiefRelief(linPet).break === 1 && mischiefRelief(linPet).poop === 1);
check("r301 種子有貓跳台:破壞乘數 = 0.3", mischiefRelief(chenPet).break === 0.3);
check("r301 無貓砂盆:大小便乘數 = 1", mischiefRelief(chenPet).poop === 1);
addPlacement({ defId: "litter_box", c: 2, r: 2, room: "r301" } as any);
check("加貓砂盆後:大小便乘數降到 0.15", mischiefRelief(chenPet).poop === 0.15);
addPlacement({ defId: "cat_tower", c: 12, r: 2, room: "r302" } as any);
check("給 r302 加貓跳台:破壞乘數降到 0.3", mischiefRelief(linPet).break === 0.3);

// --- 招租:應徵者約兩成自帶貓(統計)---
const { generateApplicants: genApp } = await import("../src/sim/recruit");
let withPet = 0;
let sampled = 0;
for (let i = 0; i < 120; i++) {
  for (const a of genApp("r304")) {
    sampled++;
    if (a.pet) {
      withPet++;
      if (!(typeof a.pet.name === "string" && a.pet.color >= 1 && a.pet.color <= 3)) { withPet = -999; break; }
    }
  }
}
check("應徵者帶貓:比例落在合理區間(5%~40%)", withPet > 0 && withPet / sampled >= 0.05 && withPet / sampled <= 0.4, `${withPet}/${sampled}`);

// --- 存檔往返 ---
save();
const petCountBefore = Object.keys(state.pets).length;
state.pets[CHEN].name = "被改壞的名字";
check("存檔往返:load 還原貓資料", load() && state.pets[CHEN]?.name === "橘子" && Object.keys(state.pets).length === petCountBefore);

// --- 飼主退租 → 貓跟著走 ---
moveIn("r303", generateApplicants("r303")[0]);
const newId = state.occupancy.r303;
adoptCat(newId);
check("新住戶領養成功", !!state.pets[newId]);
moveOut(newId, "測試退租");
petsPass();
check("飼主退租:貓跟著搬走", !state.pets[newId]);

// --- 日記整合:narrate ctx 帶養貓 flag ---
diaryTiming.gapMs = 1;
let chenCtx: NarrateCtx | null = null;
setNarrateImplForTest(async (ctx) => {
  if (ctx.name === state.runtimes[CHEN].tenant.name) chenCtx = ctx;
  const r: NarrateResult = { diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: true };
  return r;
});
await produceDailyDiaries(true);
check("日記 ctx:飼主帶「養了一隻貓」flag", !!chenCtx && (chenCtx as NarrateCtx).flags.some((f) => f.includes("養了一隻貓「橘子」")));

// --- ensurePets 冪等 ---
ensurePets();
check("ensurePets 冪等:不會生出第二隻", Object.keys(state.pets).filter((k) => k === CHEN).length === 1);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
