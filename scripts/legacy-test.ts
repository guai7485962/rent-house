/**
 * 傳承系統(成就冊 + 歷任房客名冊)驗證:
 * - unlock:解鎖一次、去重、彈通知;未知 id 忽略
 * - 事件型成就:打架→brawl(透過 tryFight)
 * - 累積型成就:客滿/滿 30 天/資產/初戀(透過 legacyPass 輪詢)
 * - 名冊:moveOut 記一筆(名字/住幾天/原因/代表記憶),farewell/veteran 成就
 * - 存檔往返保留 achievements/alumni/moveInMs
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, unlock, legacyPass, recordAlumnus, ACHIEVEMENTS, moveIn, moveOut, gameDayIndex } = await import("../src/store");
const { generateApplicants } = await import("../src/sim/recruit");
const { relationships, pairKey } = await import("../src/sim/social");
const { tryFight } = await import("../src/sim/conflicts");
const { save, load } = await import("../src/sim/persistence");
const { makeRuntime, tenants } = await import("../src/sim/gameState");
const { toTraditional } = await import("../src/sim/narrativeQuality");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- unlock 基本行為 ---
check("成就清單有 26 項(含心願 2+玩家目標批 8+圓夢畢業批 4+第二批 2)", ACHIEVEMENTS.length === 26);
check("隱藏成就有標記(鐵面/桃李滿樓/雨天/雙雙圓夢)", ACHIEVEMENTS.filter((a) => a.hidden).length === 4);
check("第二批新成就:名人堂 + 見字如面", ACHIEVEMENTS.some((a) => a.id === "hall_of_fame") && ACHIEVEMENTS.some((a) => a.id === "first_letter"));
unlock("first_love");
check("解鎖後進 achievements", state.achievements.includes("first_love"));
check("解鎖彈了通知", state.noticeLog.some((n) => n.text.includes("成就解鎖")));
const n1 = state.achievements.length;
unlock("first_love");
check("重複解鎖不重複記錄", state.achievements.length === n1);
unlock("不存在的成就");
check("未知 id 忽略", !state.achievements.includes("不存在的成就"));

// --- 事件型:打架 → brawl ---
const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
A.targetTile = { c: 7, r: 10 };
B.targetTile = { c: 7, r: 11 };
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 5, romantic: false, cohabitOffered: false };
A.tenant.stats.stress = 95;
B.tenant.stats.stress = 95;
// compatibility ≤ -3 需要「吵 vs 安靜」:gamer vs perfectionist(見 social.compatibility)
A.tenant.coreTags = [{ id: "gamer", label: "[電競]", behaviorHint: "", acquiredAt: "", source: "ai_event", intensity: 1 }] as any;
B.tenant.coreTags = [{ id: "perfectionist", label: "[完美主義]", behaviorHint: "", acquiredAt: "", source: "ai_event", intensity: 1 }] as any;
A.pendingEvent = null;
B.pendingEvent = null;
const fought = tryFight(A, B, () => 0.01); // 前置條件都成立 + rng 偏低 → 必打
check("打架觸發(前置條件成立)", fought);
check("打架 → 解鎖 brawl", state.achievements.includes("brawl"));

// --- 累積型:legacyPass 輪詢 ---
// 客滿:先湊滿四房
if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
if (!state.occupancy.r304) moveIn("r304", generateApplicants("r304")[0]);
legacyPass();
check("四房住滿 → full_house", state.achievements.includes("full_house"));

// 初戀輪詢:給一對 romantic 關係
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 90, romantic: true, cohabitOffered: false };
state.achievements.splice(state.achievements.indexOf("first_love"), 1); // 移掉事件型解的,測輪詢也能補
legacyPass();
check("有戀愛關係 → 輪詢補 first_love", state.achievements.includes("first_love"));

// 資產:直接把現金拉高
state.money = 200000;
legacyPass();
check("資產破 15 萬 → tycoon", state.achievements.includes("tycoon"));

// 成長特質輪詢:1 個 → 見證成長;4 個 → 桃李滿樓(隱藏)
A.tenant.growthTags = ["more_confident"] as any;
legacyPass();
check("有成長特質 → first_growth", state.achievements.includes("first_growth") && !state.achievements.includes("growth_full"));
A.tenant.growthTags = ["more_confident", "resilient", "grounded", "hopeful"] as any;
legacyPass();
check("集滿 4 個 → growth_full", state.achievements.includes("growth_full"));

// --- 名冊:moveOut 記一筆 ---
const before = state.alumni.length;
const victimId = state.occupancy.r303;
const victim = state.runtimes[victimId];
victim.moveInMs = state.gameMs - 5 * 24 * 3600 * 1000; // 假裝住了 5 天
victim.tenant.recentSummary = "一個安靜但可靠的房客,總是準時交租。";
const victimName = victim.tenant.name;
moveOut(victimId, "測試退租");
check("moveOut → 名冊多一筆", state.alumni.length === before + 1);
const rec = state.alumni[0];
check("名冊:名字正確", rec.name === victimName);
check("名冊:住了 5 天", rec.daysLived === 5, `實際 ${rec.daysLived}`);
check("名冊:離開原因", rec.reason === "測試退租");
check("名冊:代表記憶取自摘要", rec.memory.includes("準時交租"));
check("送走第一位 → farewell 成就", state.achievements.includes("farewell"));

// --- 告別信(畢業型才有,模板生成 + 轉繁) ---
{
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  seed.id = "al_grad"; seed.name = "告別鼓手"; seed.occupation = "樂團鼓手";
  const rtG = makeRuntime(seed, "304", 70, []);
  rtG.moveInMs = state.gameMs - 8 * 24 * 3600 * 1000; // 假裝住了 8 天
  rtG.tenant.recentSummary = "在頂樓練鼓的夜晚,和大家一起等日出。";
  rtG.wish = { id: "stage_dream", progress: 100, fulfilledDay: gameDayIndex() - 6, graduateDay: gameDayIndex(), announced: true };
  state.runtimes["al_grad"] = rtG;
  recordAlumnus(rtG, "圓夢離開:站上一次正式的舞台");
  const rec = state.alumni[0];
  check("畢業型 → 附告別信", typeof rec.farewell === "string" && rec.farewell!.length > 20);
  check("告別信含住了幾天與署名", rec.farewell!.includes("8 天") && rec.farewell!.includes("告別鼓手 敬上"));
  check("告別信已轉繁(toTraditional 冪等)", rec.farewell === toTraditional(rec.farewell!));
  state.alumni.shift(); // 清掉這筆,不干擾後續存檔往返的名冊順序斷言
  delete state.runtimes["al_grad"];
}
// --- 非畢業離開者沒有告別信 ---
{
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  seed.id = "al_evict"; seed.name = "被請離者"; seed.occupation = "上班族";
  const rtE = makeRuntime(seed, "304", 70, []);
  rtE.moveInMs = state.gameMs - 3 * 24 * 3600 * 1000;
  state.runtimes["al_evict"] = rtE; // 未指派/未實現心願 → 無告別信
  recordAlumnus(rtE, "遭房東強制請離");
  check("非畢業離開者 → 無告別信", state.alumni[0].farewell === undefined);
  state.alumni.shift(); // 清掉這筆,還原名冊順序
  delete state.runtimes["al_evict"];
}

// --- 存檔往返 ---
save();
const achCount = state.achievements.length;
const alumniCount = state.alumni.length;
state.achievements.splice(0);
state.alumni.splice(0);
load();
check("存檔往返:achievements 還原", state.achievements.length === achCount && state.achievements.includes("brawl"));
check("存檔往返:alumni 還原", state.alumni.length === alumniCount && state.alumni[0]?.name === victimName);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
