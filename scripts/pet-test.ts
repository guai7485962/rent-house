/**
 * 貓狗寵物系統驗證:
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

// 固定亂數種子(mulberry32),讓機率型測試在任何環境(含 CI)可重現
let __seed = 20260710;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { petsPass, adoptCat, adoptPet, catAttitude, petAttitude, ensurePets, mischiefRelief, resolveCatPairs, resolveDogPairs, resolveCrossSpeciesPairs } = await import("../src/sim/pets");
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
check("物種態度:狗派只親狗、不會被誤判親貓", petAttitude({ ...tenantMeh, coreTags: [mk("狗派")] }, "dog") === "like" && petAttitude({ ...tenantMeh, coreTags: [mk("狗派")] }, "cat") === "neutral");
check("物種態度:怕狗只排斥狗", petAttitude({ ...tenantMeh, coreTags: [mk("怕狗")] }, "dog") === "dislike" && petAttitude({ ...tenantMeh, coreTags: [mk("怕狗")] }, "cat") === "neutral");

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

// --- 雙貓互動:同區域會演出追逐/理毛/共眠/地盤戰/聯手搗蛋,並有配對冷卻 ---
const pairActions = ["chase", "groom", "nap", "territory", "mischief"] as const;
const seenPairActions = new Set<string>();
state.runtimes[CHEN].log.splice(0);
state.runtimes[LIN].log.splice(0);
for (let i = 0; i < pairActions.length; i++) {
  state.gameMs += 11 * 3600 * 1000;
  chenPet.hangout = linPet.hangout = "lounge";
  const action = resolveCatPairs(() => (i + 0.1) / pairActions.length, true);
  if (action) seenPairActions.add(action);
}
check("雙貓互動:五種事件都可觸發", pairActions.every((a) => seenPairActions.has(a)), JSON.stringify([...seenPairActions]));
check("雙貓互動:雙方飼主都有日誌", state.runtimes[CHEN].log.some((e) => e.text.includes("雙貓互動")) && state.runtimes[LIN].log.some((e) => e.text.includes("雙貓互動")));
check("雙貓互動:兩隻貓保存同一場配對演出", chenPet.pairWith === LIN && linPet.pairWith === CHEN && chenPet.pairAction === linPet.pairAction);
const blockedByPairCooldown = resolveCatPairs(() => 0, true);
check("雙貓互動:同一對冷卻內不連發", blockedByPairCooldown === null);
const { createPetAgents, petAgentSignature, tickPetAgents } = await import("../src/floor/petAgents");
const pairedAgents = createPetAgents();
tickPetAgents(pairedAgents, 0.016);
check("雙貓互動:樓層 agent 收到同步演出狀態", pairedAgents.filter((a) => a.pairAction === chenPet.pairAction).length === 2 && pairedAgents.filter((a) => a.pairLeader).length === 1);

// --- 狗:領養、渲染 agent、貓配對隔離、舊 preset 相容 ---
delete chenPet.pairWith; delete chenPet.pairAction; delete chenPet.pairUntilMs;
delete state.pets[LIN];
const dog = adoptPet(LIN, { name: "可樂", color: 2, kind: "dog" });
check("adoptPet:可領養指定名字/花色的狗", dog?.kind === "dog" && dog.name === "可樂" && dog.color === 2);
check("adoptPet:狗使用狗圖示通知", state.noticeLog.some((n) => n.text.includes("🐕") && n.text.includes("可樂")));
check("狗不誤吃貓跳台/貓砂盆減免", !!dog && mischiefRelief(dog).break === 1 && mischiefRelief(dog).poop === 1);
addPlacement({ defId: "dog_bed", c: 10, r: 3, room: "r302" } as any);
check("狗狗睡墊提供舒適度但不取代功能用品", !!dog && mischiefRelief(dog).break === 1 && mischiefRelief(dog).poop === 1);
addPlacement({ defId: "chew_toy", c: 12, r: 3, room: "r302" } as any);
check("耐咬玩具讓狗狗破壞倍率降到 0.25", !!dog && mischiefRelief(dog).break === 0.25);
addPlacement({ defId: "pee_pad", c: 13, r: 3, room: "r302" } as any);
check("寵物尿墊讓狗狗如廁意外倍率降到 0.15", !!dog && mischiefRelief(dog).poop === 0.15);
check("狗狗家具不會改變貓咪家具效果", mischiefRelief(chenPet).break === 0.3 && mischiefRelief(chenPet).poop === 0.15);
const dogAgents = createPetAgents();
check("樓層 agent 保留狗物種與四花色", dogAgents.some((a) => a.petId === LIN && a.kind === "dog" && a.color === 2));
const dogSignature = petAgentSignature();
const savedLinDog = state.pets[LIN];
delete state.pets[LIN];
state.pets["same_count_dog"] = { ...savedLinDog, ownerId: CHEN };
check("寵物一進一出但總數不變 → agent signature 仍會變", petAgentSignature() !== dogSignature);
delete state.pets["same_count_dog"];
state.pets[LIN] = savedLinDog;
if (dog) dog.hangout = chenPet.hangout = "lounge";
state.gameMs += 11 * 3600 * 1000;
check("狗不會觸發雙貓互動", resolveCatPairs(() => 0, true) === null);

// --- 雙狗互動:追球／互聞／共眠 ---
const savedChenCatForPairs = state.pets[CHEN];
state.pets[CHEN] = { ...savedChenCatForPairs, name: "阿福", kind: "dog", color: 0, ownerId: CHEN };
const dogPairActions = ["fetch", "sniff", "nap"] as const;
const seenDogPairActions = new Set<string>();
state.runtimes[CHEN].log.splice(0);
state.runtimes[LIN].log.splice(0);
for (let i = 0; i < dogPairActions.length; i++) {
  state.gameMs += 11 * 3600 * 1000;
  state.pets[CHEN].hangout = state.pets[LIN].hangout = "lounge";
  const action = resolveDogPairs(() => (i + 0.1) / dogPairActions.length, true);
  if (action) seenDogPairActions.add(action);
}
check("雙狗互動:追球／互聞／共眠都可觸發", dogPairActions.every((a) => seenDogPairActions.has(a)), JSON.stringify([...seenDogPairActions]));
check("雙狗互動:雙方飼主都有日誌", state.runtimes[CHEN].log.some((e) => e.text.includes("雙狗互動")) && state.runtimes[LIN].log.some((e) => e.text.includes("雙狗互動")));
check("雙狗互動:兩隻狗保存同一場同步演出", state.pets[CHEN].pairWith === LIN && state.pets[LIN].pairWith === CHEN && state.pets[CHEN].pairAction === state.pets[LIN].pairAction);
const dogPairAgents = createPetAgents();
tickPetAgents(dogPairAgents, 0.016);
check("雙狗互動:樓層 agent 收到共眠狀態", dogPairAgents.filter((a) => a.pairAction === "nap").length === 2 && dogPairAgents.some((a) => a.sleeping));
delete state.pets[CHEN].pairWith; delete state.pets[CHEN].pairAction; delete state.pets[CHEN].pairUntilMs;
delete state.pets[LIN].pairWith; delete state.pets[LIN].pairAction; delete state.pets[LIN].pairUntilMs;
check("雙狗互動:同一對冷卻內不連發", resolveDogPairs(() => 0, true) === null);

// --- 舊存檔 kind fallback + 貓狗友善／退避 ---
state.gameMs += 11 * 3600 * 1000;
state.pets[CHEN] = { ...savedChenCatForPairs, kind: undefined as any };
ensurePets();
check("舊存檔寵物缺 kind → ensurePets 正規化為貓", state.pets[CHEN].kind === "cat");
const crossActions = ["greet", "avoid"] as const;
const seenCrossActions = new Set<string>();
state.runtimes[CHEN].log.splice(0);
state.runtimes[LIN].log.splice(0);
for (let i = 0; i < crossActions.length; i++) {
  state.gameMs += 11 * 3600 * 1000;
  state.pets[CHEN].hangout = state.pets[LIN].hangout = "lounge";
  const action = resolveCrossSpeciesPairs(() => (i + 0.1) / crossActions.length, true);
  if (action) seenCrossActions.add(action);
}
check("貓狗相遇:友善／退避都可觸發", crossActions.every((a) => seenCrossActions.has(a)), JSON.stringify([...seenCrossActions]));
check("貓狗相遇:雙方飼主都有日誌", state.runtimes[CHEN].log.some((e) => e.text.includes("貓狗相遇")) && state.runtimes[LIN].log.some((e) => e.text.includes("貓狗相遇")));
const crossAgents = createPetAgents();
tickPetAgents(crossAgents, 0.016);
check("貓狗退避:樓層 agent 同步狀態且至少一方開始拉開距離", crossAgents.filter((a) => a.pairAction === "avoid").length === 2 && crossAgents.some((a) => a.pairAction === "avoid" && a.moving));
delete state.pets[CHEN].pairWith; delete state.pets[CHEN].pairAction; delete state.pets[CHEN].pairUntilMs;
delete state.pets[LIN].pairWith; delete state.pets[LIN].pairAction; delete state.pets[LIN].pairUntilMs;

delete state.pets[LIN];
adoptPet(LIN, { name: "舊池貓", color: 1 });
check("舊 applicant preset 缺 kind → 視為貓", state.pets[LIN]?.kind === "cat");
delete state.pets[LIN];
adoptPet(LIN, { name: "可樂", color: 2, kind: "dog" });

// --- 招租:總寵物率維持約兩成,其中同時有貓與狗 ---
const { generateApplicants: genApp } = await import("../src/sim/recruit");
let withPet = 0;
let withCat = 0;
let withDog = 0;
let sampled = 0;
for (let i = 0; i < 120; i++) {
  for (const a of genApp("r304")) {
    sampled++;
    if (a.pet) {
      withPet++;
      if (a.pet.kind === "dog") withDog++; else withCat++;
      if (!(typeof a.pet.name === "string" && a.pet.color >= 0 && a.pet.color <= 3)) { withPet = -999; break; }
    }
  }
}
check("應徵者自帶寵物:總比例落在合理區間(5%~40%)", withPet > 0 && withPet / sampled >= 0.05 && withPet / sampled <= 0.4, `${withPet}/${sampled}`);
check("應徵者自帶寵物:貓狗都會出現", withCat > 0 && withDog > 0, `cat=${withCat}, dog=${withDog}`);

// --- 貓咪觀察筆記(彩蛋):7 遊戲日一篇,進 Feed ---
const { catJournalPass } = await import("../src/sim/pets");
for (const k of Object.keys(state.interactionCooldowns)) if (k.includes("|journal")) delete state.interactionCooldowns[k];
state.runtimes[CHEN].log.splice(0);
catJournalPass();
check("貓咪筆記:飼主 Feed 出現一篇觀察筆記", state.runtimes[CHEN].log.some((e) => e.text.includes("的觀察筆記") && e.importance === "notable"));
const journalCount1 = state.runtimes[CHEN].log.filter((e) => e.text.includes("觀察筆記")).length;
catJournalPass(); // 冷卻內再呼叫不應再發
check("貓咪筆記:7 日冷卻內不重複發", state.runtimes[CHEN].log.filter((e) => e.text.includes("觀察筆記")).length === journalCount1);
state.gameMs += 8 * 24 * 3600 * 1000; // 過 8 遊戲日 → 冷卻解除
catJournalPass();
check("貓咪筆記:過 7 日後再發一篇", state.runtimes[CHEN].log.filter((e) => e.text.includes("觀察筆記")).length === journalCount1 + 1);

// --- 存檔往返 ---
save();
const petCountBefore = Object.keys(state.pets).length;
state.pets[CHEN].name = "被改壞的名字";
check("存檔往返:load 還原貓資料", load() && state.pets[CHEN]?.name === "橘子" && Object.keys(state.pets).length === petCountBefore);
check("存檔往返:保留狗的物種/名字/花色", state.pets[LIN]?.kind === "dog" && state.pets[LIN]?.name === "可樂" && state.pets[LIN]?.color === 2);

// --- 備份提醒:匯出即記下 lastBackupMs,並存檔往返保留 ---
const { exportSave } = await import("../src/sim/persistence");
state.lastBackupMs = 0;
exportSave();
check("匯出備份 → 記下 lastBackupMs", state.lastBackupMs > 0);
const bk = state.lastBackupMs;
state.lastBackupMs = 0;
load();
check("lastBackupMs 存檔往返保留", state.lastBackupMs === bk);

// --- 飼主退租 → 貓跟著走 ---
moveIn("r303", generateApplicants("r303")[0]);
const newId = state.occupancy.r303;
adoptPet(newId, { name: "搬家狗", color: 0, kind: "dog" });
check("新住戶領養狗成功", state.pets[newId]?.kind === "dog");
moveOut(newId, "測試退租");
petsPass();
check("飼主退租:狗跟著搬走", !state.pets[newId]);

// --- 日記整合:narrate ctx 帶養貓 flag ---
diaryTiming.gapMs = 1;
let chenCtx: NarrateCtx | null = null;
let linCtx: NarrateCtx | null = null;
setNarrateImplForTest(async (ctx) => {
  if (ctx.name === state.runtimes[CHEN].tenant.name) chenCtx = ctx;
  if (ctx.name === state.runtimes[LIN].tenant.name) linCtx = ctx;
  const r: NarrateResult = { diary: `AI:${ctx.name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: true };
  return r;
});
await produceDailyDiaries(true);
check("日記 ctx:飼主帶「養了一隻貓」flag", !!chenCtx && (chenCtx as NarrateCtx).flags.some((f) => f.includes("養了一隻貓「橘子」")));
check("日記 ctx:狗飼主帶「養了一隻狗」flag", !!linCtx && (linCtx as NarrateCtx).flags.some((f) => f.includes("養了一隻狗「可樂」")));

// --- ensurePets 冪等 ---
ensurePets();
check("ensurePets 冪等:不會生出第二隻", Object.keys(state.pets).filter((k) => k === CHEN).length === 1);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
