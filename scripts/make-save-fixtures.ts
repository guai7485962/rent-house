/**
 * 產生「代表性舊存檔」fixture(給 scripts/save-smoke-test.ts 用)。
 *
 * 為什麼要有這支:所有既有關卡(npm test / UI Lab / balance-test)都是**全新 session、
 * 全新 state**,沒有一關會拿一份「玩很久的既有存檔」去啟動 app ⇒
 * 「只在載入舊存檔時才炸」的例外可以一路全綠。fixture 就是那份舊存檔。
 *
 * 用法(必須固定時區,遊戲用本地時區的 getHours()/getDate() 決定作息):
 *   TZ=Asia/Taipei npx tsx scripts/make-save-fixtures.ts
 *
 * 產出(scripts/fixtures/,已入版控;改了存檔結構或發現新的真實存檔樣貌才重跑):
 *   save-veteran-v10.json   玩了 20 遊戲日的現行版存檔(多租客/關係/積怨/記憶/咖啡廳/寵物/家具)
 *   save-legacy-v8.json     同一份降版成 v8,逼載入時走 8→9→10 兩段 MIGRATIONS
 *   save-stale-ids-v10.json 同一份混入「目錄中已不存在的 id」(成長特質/行為指令/家具/研發)
 *
 * 固定 mulberry32 種子 + 固定 realAnchorMs ⇒ 重跑輸出穩定,diff 看得出是哪裡變了。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 固定種子 PRNG(mulberry32)蓋掉 Math.random —— 必須在載入 store 之前
let seed = 20260819;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, gameDayIndex, fmt } = await import("../src/sim/gameState");
const { save, SAVE_KEY } = await import("../src/sim/persistence");
const { debugStepHour } = await import("../src/sim/lifecycle");
const { getApplicants, moveIn, decide } = await import("../src/sim/tenancy");
const { openCafe, buyCafeUpgrade, hireCafeStaff, suggestedStandingOrders, CAFE_UPGRADE_IDS } = await import("../src/sim/cafe");
const { placeCafeStarterSet } = await import("../src/sim/placements");
const { adoptCat, adoptPet, randomDogPreset, ensurePets } = await import("../src/sim/pets");
const { grantGrowthTag } = await import("../src/sim/growth");
const { CAFE_RESEARCH_IDS } = await import("../src/content/cafeResearch");

/** 固定錨點:fixture 不該帶產生當下的現實時間(否則每次重跑都 diff)。 */
const FIXED_REAL_ANCHOR = Date.parse("2026-08-19T09:00:00+08:00");

// --- 1. 把空房補滿(真實玩家不會只有兩位房客)---
for (const roomId of ["r303", "r304"]) {
  const applicants = getApplicants(roomId);
  if (applicants.length > 0) moveIn(roomId, applicants[0]);
}

// --- 2. 開咖啡廳 + 投資 + 雇人(一樓咖啡廳是後期存檔的大宗狀態)---
state.money = 400_000; // 讓投資一定買得起;金額本身不是 fixture 的重點
{
  const opened = openCafe(state.cafe, state.money);
  if (opened.ok) { Object.assign(state.cafe, opened.cafe); state.money = opened.moneyAfter; }
  for (const id of Object.values(CAFE_UPGRADE_IDS)) {
    const bought = buyCafeUpgrade(state.cafe, state.money, id);
    if (bought.ok) { Object.assign(state.cafe, bought.cafe); state.money = bought.moneyAfter; }
  }
  const hired = hireCafeStaff(state.cafe);
  if (hired.ok) Object.assign(state.cafe, hired.cafe);
  // 已完成的研發:讓存檔帶著「研發過的 id」,遷移/載入都得認得
  state.cafe.completed = [...new Set([...(state.cafe.completed ?? []), Object.values(CAFE_RESEARCH_IDS)[0]])];
  Object.assign(state.cafe.standingOrders, suggestedStandingOrders()); // 有常備訂單才會進貨、才有庫存與銷售
  placeCafeStarterSet(); // 開張贈品(一樓佈置)
}

// --- 3. 寵物:一隻租客的貓 + 一隻樓寵物狗 ---
const tenantIds = () => Object.keys(state.runtimes);
adoptCat(tenantIds()[0]);
adoptPet(tenantIds()[1], randomDogPreset());
ensurePets();
// 樓寵物(原飼主搬走後由公寓接手)——repairOrphanPets 產出的正是這個形狀
{
  const housePet = state.pets[tenantIds()[1]];
  if (housePet) { housePet.ownerId = "landlord"; housePet.housePlacement = "permanent"; housePet.hangout = "lounge"; }
}

// --- 4. 跑 20 遊戲日:關係、記憶、日誌、帳、週報、心願、故事線都由模擬自己長出來 ---
for (let i = 0; i < 20 * 24; i++) {
  debugStepHour();
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent) {
      const c = rt.pendingEvent.choices[0];
      decide(rt.tenant.id, c.id, c.label);
    }
  }
  if (state.pendingGroupEvent) state.pendingGroupEvent = null; // 群體抉擇不入 fixture 的必要條件,清掉免得卡住模擬
  if (state.pendingChainEvent) state.pendingChainEvent = null;
}

// --- 5. 補上模擬不一定會長出來、但真實存檔常見的東西 ---
{
  const ids = tenantIds();
  // 永久成長特質(有效 id)
  grantGrowthTag(state.runtimes[ids[0]].tenant, "resilient");
  // 進行中的行為指令(有效 id;stale 版本會把它換成查無的 id)
  state.runtimes[ids[1]].directive = { id: "night_owl", untilDay: gameDayIndex() + 2 };
  // 冷戰(積怨)
  const pairKey = [ids[0], ids[1]].sort().join("|");
  state.feuds[pairKey] = { untilMs: state.gameMs + 3 * 24 * 3600 * 1000 };
  // 待補的 AI 日記:載入時只保留「日誌裡有對應 aiPending 條目」的 job,兩邊都要造
  const rt = state.runtimes[ids[2] ?? ids[0]];
  const diaryId = "fixture_pending_diary";
  rt.log.push({
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    text: "(這篇還在等 AI 補寫)",
    visualState: rt.tenant.visualState,
    importance: "notable",
    ai: true,
    daily: true,
    diaryId,
    aiPending: true,
  });
  state.pendingDiaries.push({
    diaryId,
    tenantId: rt.tenant.id,
    gameMs: state.gameMs,
    ctx: { name: rt.tenant.name, neighbors: [] } as any,
  });
}

save();
const veteran = JSON.parse(localStorage.getItem(SAVE_KEY)!);
veteran.realAnchorMs = FIXED_REAL_ANCHOR;
veteran.lastBackupMs = 0;

// --- 6. 降版成 v8:逼載入走 MIGRATIONS 8→9→10 兩段 ---
const legacy = JSON.parse(JSON.stringify(veteran));
legacy.v = 8;
delete legacy.cafe.sales; // v8→v9 才補上的欄位
legacy.cafe.guests = [{ id: "legacy_guest", name: "舊檔顧客", enterMs: legacy.gameMs, leaveMs: legacy.gameMs + 3600_000 }]; // 沒有 order,v9→v10 會清掉
// 舊檔沒有的選填欄位一併拔掉,逼 load() 的 `?? 預設值` 分支真的被走到
for (const k of ["feedSeenMs", "weeklyReports", "lastWeeklyReportDay", "weeklyRelationshipSnapshot", "petHomes", "scheduledCommunityEvents", "floorChain", "lastChainEndDay", "pendingChainEvent", "starterBonusGiven", "interactionCooldowns", "breakdowns"]) {
  delete legacy[k];
}
for (const rt of Object.values<any>(legacy.runtimes)) {
  delete rt.arcHistory;
  delete rt.diaryHour;
  delete rt.modelSinceCalendarDay;
  delete rt.wish;
}

// --- 7. 混入「目錄中已不存在的 id」---
// 真實情境:下架一個成長特質/行為指令/家具/研發後,老玩家的存檔裡還留著那個 id。
// 昨天的除錯已指出 GROWTH_TAGS[id] 與 DIRECTIVES[rt.directive.id] 兩處查無就丟 TypeError。
const stale = JSON.parse(JSON.stringify(veteran));
{
  const rts = Object.values<any>(stale.runtimes);
  rts[0].tenant.growthTags = [...(rts[0].tenant.growthTags ?? []), "retired_growth_tag"];
  rts[1].directive = { id: "retired_directive", untilDay: 0, source: "ai" }; // untilDay 已過 → hourlyTick 開頭就查表
  rts[2 % rts.length].archetypeKey = "retired_archetype";
  stale.placements = [...stale.placements, { defId: "retired_furniture", c: 2, r: 17, rotation: 0, roomId: "r303" }];
  stale.cafe.completed = [...(stale.cafe.completed ?? []), "retired_research"];
  stale.cafe.upgrades = [...(stale.cafe.upgrades ?? []), "retired_cafe_upgrade"];
  stale.achievements = [...(stale.achievements ?? []), "retired_achievement"];
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
mkdirSync(outDir, { recursive: true });
const write = (name: string, data: unknown) => {
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`✅ ${name}(${Math.round(JSON.stringify(data).length / 1024)} KB)`);
};
write("save-veteran-v10.json", veteran);
write("save-legacy-v8.json", legacy);
write("save-stale-ids-v10.json", stale);

console.log(`租客 ${Object.keys(veteran.runtimes).length} 位 · 家具 ${veteran.placements.length} 件 · 帳 ${veteran.ledger.length} 筆 · 咖啡廳 ${veteran.cafe?.open ? "已開張" : "未開張"} · 寵物 ${Object.keys(veteran.pets ?? {}).length} 隻`);
process.exit(0);
