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
const { classifyDeparture } = await import("../src/sim/legacy");

// 簡體字偵測(比照事件消毒):告別信全部必須是繁體
const SIMP_RE = /[们过这么后来东乐话说觉别买卖钱贝见风飞车专业欢兴学随写垃圾还惊场满门问间闻阔]/;

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
// --- 所有離開原因都留告別留言(使用者硬底線:每個離開的都要有)---
// reason → 語氣類別的分流(涵蓋所有 moveOut 呼叫來源)
check("路徑分類:強制請離 → forced", classifyDeparture("遭房東強制請離") === "forced");
check("路徑分類:AI 事件請走 → forced", classifyDeparture("你請他搬走了") === "forced");
check("路徑分類:協議解約 → agreement", classifyDeparture("與房東協議解約(補償 $2,000)") === "agreement");
check("路徑分類:分手搬走 → breakup", classifyDeparture("分手後無處可住,搬離公寓") === "breakup");
check("路徑分類:長期不滿退租 → unhappy", classifyDeparture("對居住品質長期不滿") === "unhappy");
check("路徑分類:未預期原因 → generic 兜底", classifyDeparture("測試退租") === "generic");

// 每種離開原因都產生非空、繁體、個人化(住幾天/最好鄰居/代表記憶)的告別信
{
  // 建一位有性格與代表記憶的離開者,錄進名冊後取回條目再清掉(還原名冊順序)
  const recordDeparture = (id: string, reason: string) => {
    const seed = JSON.parse(JSON.stringify(tenants[0]));
    seed.id = id; seed.name = "離開者阿明"; seed.occupation = "上班族";
    seed.coreTags = [{ id: "perfectionist", label: "[完美主義]", behaviorHint: "" }];
    const rt = makeRuntime(seed, "304", 70, []);
    rt.moveInMs = state.gameMs - 4 * 24 * 3600 * 1000; // 假裝住了 4 天
    rt.tenant.recentSummary = "總把公共廚房擦得發亮的可靠房客。";
    rt.wish = undefined; // 未圓夢 → 走被迫離開句庫
    state.runtimes[id] = rt;
    recordAlumnus(rt, reason);
    const entry = state.alumni[0];
    state.alumni.shift();
    delete state.runtimes[id];
    return entry;
  };
  const reasons: Array<[string, string]> = [
    ["forced", "遭房東強制請離"],
    ["ai_evict", "你請他搬走了"],
    ["agreement", "與房東協議解約(補償 $2,000)"],
    ["breakup", "分手後無處可住,搬離公寓"],
    ["unhappy", "對居住品質長期不滿"],
    ["unexpected", "某種沒預料到的離開"],
  ];
  for (const [tag, reason] of reasons) {
    const e = recordDeparture(`al_dep_${tag}`, reason);
    const fw = e.farewell;
    check(`「${reason}」→ 告別信非空`, typeof fw === "string" && fw!.length > 20, `farewell=${fw}`);
    check(`「${reason}」→ 已轉繁(無簡體、toTraditional 冪等)`, !!fw && !SIMP_RE.test(fw) && fw === toTraditional(fw));
    check(`「${reason}」→ 摻入住了幾天`, !!fw && fw.includes("4 天"));
    check(`「${reason}」→ 摻入代表記憶`, !!fw && fw.includes("擦得發亮"));
    check(`「${reason}」→ 摻入最好鄰居(無鄰居時回退全樓)`, !!fw && fw.includes("這棟樓的每一個人"));
  }
  // 強制離開句庫必摻性格(coreTags):forced 三句都用到 persona
  const forcedE = recordDeparture("al_dep_persona", "遭房東強制請離");
  check("被迫離開信摻入性格 coreTags(完美主義)", !!forcedE.farewell && forcedE.farewell.includes("完美主義"));
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
