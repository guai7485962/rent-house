/**
 * H 批:AI 敘事的卡死修復與診斷強化。
 *
 * 線上症狀是「當日觀察全部停在 ⏳ 待補 · 掛機補進度」——升級迴圈在改標籤之前就靜默 return 了。
 * 本測試釘住四件事:
 *   1. narrateDay() 的 fetch 有逾時,請求永遠不回來時仍會 settle(否則 deferredRun 永久 pending);
 *   2. 四個提早退出(排隊中／分頁背景／今日次數用完／額度用盡)各自留下可見標籤;
 *   3. produceDiaryFor() 的例外不會炸穿 hourlyTick(它後面的收租/額度重置/心願/存檔要照跑);
 *   4. 存檔帶著目錄裡已不存在的 growth tag id 時,buildNarrateCtx 不再丟 TypeError。
 * 另外掃描原始碼,確保兩個 Feed 元件的標籤對照表一致且涵蓋所有 AiFallbackReason。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NarrateResult } from "../src/sim/narrate";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const narration = await import("../src/sim/narration");
const { narrateDay, narrateTiming } = await import("../src/sim/narrate");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { hourlyTick } = await import("../src/sim/tick");
const { state } = await import("../src/store");

const {
  diaryTiming, narrateStatus, produceDailyDiaries, resetDeferredDiaryBudgetForTest,
  resetNarrationRuntimeForTest, resumeDeferredDiaries, setCtxFaultForTest, setNarrateImplForTest,
} = narration;
diaryTiming.gapMs = 1;
diaryTiming.retryMs = 1;
diaryTiming.deferredMinGapMs = 1;
diaryTiming.deferredMaxGapMs = 1;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const runtimes = () => Object.values(state.runtimes);
const frontReason = () => narrateStatus().frontPending?.reason ?? null;
const resetAll = () => {
  state.pendingDiaries.splice(0);
  for (const rt of runtimes()) rt.log.splice(0);
  resetNarrationRuntimeForTest();
  resetDeferredDiaryBudgetForTest(4);
};
const success = (name: string): NarrateResult => ({
  diary: `AI補寫:${name}`, newMemory: null, event: null, summaryUpdate: null, arcUpdate: null,
  ai: true, provider: "gemini-flash-lite",
});

moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
check("四位租客就緒", runtimes().length === 4);

// ─────────────────────────────────────────────────────────────────────────────
// 1. fetch 逾時:請求永遠不回來,narrateDay() 仍要 settle
// ─────────────────────────────────────────────────────────────────────────────
const realFetch = (globalThis as any).fetch;
let abortSeen = false;
(globalThis as any).fetch = (_url: string, init: any) =>
  new Promise((_resolve, reject) => {
    // 只在被 abort 時 reject —— 模擬「worker 收了請求但永遠不回應」
    init?.signal?.addEventListener("abort", () => {
      abortSeen = true;
      reject(new Error("aborted"));
    });
  });

const realTimeout = narrateTiming.timeoutMs;
narrateTiming.timeoutMs = 40;
const probeCtx = {
  name: "測試", occupation: "", bio: "", dayLabel: "第 1 天", coreTags: [], memoryTags: [],
  stats: { mood: 50, stress: 50, affinity: 50, satisfaction: 50 },
  room: { noise: 0, soundproof: 0, treated: false, complaintRisk: false },
  todayLog: [], relationships: [], events: [], neighbors: [], summary: "", arc: null,
  flags: [], eventDue: false,
};
const t0 = Date.now();
const timedOut = await narrateDay(probeCtx as any);
const elapsed = Date.now() - t0;
check("永不回應的 fetch 會被逾時中止", abortSeen);
check("逾時後 narrateDay 仍 settle 且走模板", timedOut.ai === false && timedOut.diary.length > 0);
check("逾時有專屬 fallbackReason", timedOut.fallbackReason === "timeout", `實得 ${timedOut.fallbackReason}`);
check("逾時時間符合設定(不是等到天荒地老)", elapsed < 4000, `實得 ${elapsed}ms`);

// 同樣的假 fetch 走完整升級管線:deferredRun 一定要 settle,而且留下 timeout 標籤
resetAll();
await produceDailyDiaries(false);
setNarrateImplForTest(narrateDay);
const settled = await Promise.race([
  resumeDeferredDiaries(1).then(() => "settled"),
  new Promise((r) => setTimeout(() => r("stuck"), 5000)),
]);
check("fetch 逾時後 deferredRun 確實 settle", settled === "settled");
check("deferredRun settle 後不再 pending", narrateStatus().deferredRunPending === false);
check("升級失敗留下逾時標籤", frontReason() === "timeout", `實得 ${frontReason()}`);

narrateTiming.timeoutMs = realTimeout;
if (realFetch) (globalThis as any).fetch = realFetch; else delete (globalThis as any).fetch;

// ─────────────────────────────────────────────────────────────────────────────
// 2. 四個提早退出各自留下可見標籤(過去全部靜默 break)
// ─────────────────────────────────────────────────────────────────────────────

// 2a. 上一輪還在跑 → busy
resetAll();
await produceDailyDiaries(false);
let release: (v: NarrateResult) => void = () => {};
setNarrateImplForTest(() => new Promise<NarrateResult>((r) => { release = r; }));
const inflight = resumeDeferredDiaries(1);
await new Promise((r) => setTimeout(r, 5));
const second = resumeDeferredDiaries(1);
check("重入時回傳同一個進行中的 run", second === inflight);
check("排隊中留下 busy 標籤", frontReason() === "busy", `實得 ${frontReason()}`);
check("narrateStatus 看得到 run 進行中", narrateStatus().deferredRunPending && !narrateStatus().deferredRunStale);
release(success("解鎖"));
await inflight;
check("解鎖後 busy 標籤被成功升級清掉", frontReason() !== "busy");

// 2b. 分頁在背景 → hidden(中性措辭),回前景自動恢復
resetAll();
await produceDailyDiaries(false);
setNarrateImplForTest(async (c) => success(c.name));
(globalThis as any).document = { hidden: true };
const hiddenBefore = state.pendingDiaries.length;
await resumeDeferredDiaries(1);
check("分頁隱藏時不打 API", state.pendingDiaries.length === hiddenBefore);
check("分頁隱藏留下 hidden 標籤", frontReason() === "hidden", `實得 ${frontReason()}`);
(globalThis as any).document = { hidden: false };
resetNarrationRuntimeForTest();
resetDeferredDiaryBudgetForTest(4);
await resumeDeferredDiaries(1);
check("回到前景後自動恢復升級", state.pendingDiaries.length === hiddenBefore - 1);
check("恢復後 hidden 標籤已清除", frontReason() !== "hidden");
delete (globalThis as any).document;

// 2c. 今日升級次數用完 → budget
resetAll();
await produceDailyDiaries(false);
let budgetCalls = 0;
setNarrateImplForTest(async (c) => { budgetCalls++; return success(c.name); });
resetDeferredDiaryBudgetForTest(0);
await resumeDeferredDiaries(2);
check("次數用完時不白打 API", budgetCalls === 0);
check("次數用完留下 budget 標籤", frontReason() === "budget", `實得 ${frontReason()}`);
check("narrateStatus 顯示剩餘次數為 0", narrateStatus().deferredBudget === 0);

// 2d. 當日額度用盡(quotaHold)→ quota(沿用既有標籤字串,不新增)
resetAll();
await produceDailyDiaries(false);
setNarrateImplForTest(async () => ({
  diary: "", newMemory: null, event: null, summaryUpdate: null, arcUpdate: null, ai: false, quota: true,
}));
await resumeDeferredDiaries(1);
check("重試仍 429 → quota 標籤", frontReason() === "quota", `實得 ${frontReason()}`);
check("narrateStatus 顯示 quotaHold", narrateStatus().quotaHold === true);
let afterHoldCalls = 0;
setNarrateImplForTest(async (c) => { afterHoldCalls++; return success(c.name); });
resetDeferredDiaryBudgetForTest(4);
await resumeDeferredDiaries(1);
check("quotaHold 期間直接退出、不再白打 API", afterHoldCalls === 0);
check("quotaHold 退出仍是 quota 標籤", frontReason() === "quota", `實得 ${frontReason()}`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. produceDiaryFor() 的例外不會炸穿 hourlyTick
// ─────────────────────────────────────────────────────────────────────────────
resetAll();
setNarrateImplForTest(async (c) => success(c.name));
// 這一段會刻意觸發降級路徑的 console.error;把它靜音,CI log 才看得清斷言
const realConsoleError = console.error;
console.error = () => {};
const victim = runtimes()[0];
// 只讓這一位的 ctx 組裝爆炸(用髒資料會連帶弄壞其他 pass,失去針對性)
setCtxFaultForTest((rt) => {
  if (rt.tenant.id === victim.tenant.id) throw new TypeError("測試注入:ctx 組裝失敗");
});

let threw = false;
try {
  await produceDailyDiaries(false);
} catch {
  threw = true;
}
check("ctx 組裝爆炸不會往外丟", !threw);
const victimDiary = victim.log.filter((e) => e.daily).at(-1);
check("壞掉的租客仍拿到模板日記", !!victimDiary && victimDiary.ai === false);
check("壞掉的租客留下 internal 標籤", victimDiary?.aiFallbackReason === "internal", `實得 ${victimDiary?.aiFallbackReason}`);
check("其他租客不受影響", runtimes().slice(1).every((rt) => rt.log.filter((e) => e.daily).at(-1)?.aiFallbackReason === "catchup"));
check("narrateStatus 記下最後一次例外", (narrateStatus().lastError?.message ?? "").includes("buildNarrateCtx"));

// hourlyTick:讓壞掉的租客的日記時段落在下一小時,整個 tick 仍要跑完換日結算
const hoursToMidnight = 24 - new Date(state.gameMs).getHours();
victim.diaryHour = new Date(state.gameMs + 3_600_000).getHours();
victim.lastDiaryDay = -1;
resetDeferredDiaryBudgetForTest(0);
let tickThrew = "";
try {
  for (let i = 0; i < hoursToMidnight + 1; i++) hourlyTick(false);
} catch (err) {
  tickThrew = String(err);
}
check("hourlyTick 不被日記例外炸穿", tickThrew === "", tickThrew);
check("diaryPass 之後的換日結算照常執行(額度已重置)", narrateStatus().deferredBudget > 0);
check("壞掉的租客在 tick 裡也只留下模板日記",
  victim.log.filter((e) => e.daily).at(-1)?.aiFallbackReason === "internal");
setCtxFaultForTest(null);
console.error = realConsoleError;

// ─────────────────────────────────────────────────────────────────────────────
// 4. 未知的 growth tag id 不再丟例外
// ─────────────────────────────────────────────────────────────────────────────
const { GROWTH_TAGS } = await import("../src/sim/growth");
const knownTag = Object.keys(GROWTH_TAGS)[0] as any;
resetAll();
const gv = runtimes()[0];
(gv.tenant as any).growthTags = ["[早已刪掉的舊標籤]", knownTag];
let growthThrew = false;
try {
  await produceDailyDiaries(false);
} catch {
  growthThrew = true;
}
check("未知 growth tag id 不再丟 TypeError", !growthThrew);
const gvJob = state.pendingDiaries.find((j) => j.tenantId === gv.tenant.id);
check("未知 growth tag 被安全跳過", !!gvJob && (gvJob.ctx.growthTags ?? []).length === 1);
check("已知 growth tag 仍照常帶進 ctx", (gvJob?.ctx.growthTags ?? [])[0] === (GROWTH_TAGS as any)[knownTag].label);
check("這一篇沒有被判成 internal", gv.log.filter((e) => e.daily).at(-1)?.aiFallbackReason === "catchup");
(gv.tenant as any).growthTags = [];

// ─────────────────────────────────────────────────────────────────────────────
// 5. 原始碼掃描:兩個 Feed 元件的標籤表必須一致,且涵蓋所有 AiFallbackReason
// ─────────────────────────────────────────────────────────────────────────────
const labelTable = (file: string) => {
  const src = readFileSync(join(root, file), "utf8");
  const m = src.match(/const FALLBACK_LABEL: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const hit of m[1].matchAll(/([A-Za-z_]\w*)\s*:\s*"([^"]+)"/g)) out[hit[1]] = hit[2];
  return out;
};
const feedLabels = labelTable("src/components/FeedPanel.vue");
const logLabels = labelTable("src/components/LogFeed.vue");
check("兩個元件都找得到標籤表", !!feedLabels && !!logLabels);
check("兩個元件的標籤表完全一致", JSON.stringify(feedLabels) === JSON.stringify(logLabels));

const narrateSrc = readFileSync(join(root, "src/sim/narrate.ts"), "utf8");
// 註解裡有全形/半形分號,不能用第一個 ";" 當結尾 —— 先把註解行整條剔掉再找宣告結尾。
const typeBlock = narrateSrc
  .slice(narrateSrc.indexOf("export type AiFallbackReason"))
  .split(/\r?\n/)
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join(" ");
const reasons = [...typeBlock.slice(0, typeBlock.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
check("AiFallbackReason 掃描到全部種類", reasons.length >= 13, `實得 ${reasons.length}`);
const missing = reasons.filter((r) => !(feedLabels ?? {})[r]);
check("每個 fallbackReason 都有中文標籤", missing.length === 0, `缺 ${missing.join(",")}`);
// 既有標籤文字有其他測試在斷言,這裡再釘一次,避免被順手改掉
check("既有標籤文字未被更動",
  feedLabels?.catchup === "掛機補進度" && feedLabels?.quota === "免費額度已滿"
  && feedLabels?.offline === "目前離線" && feedLabels?.unknown === "稍後再試");
check("背景分頁的措辭中性、不像故障", feedLabels?.hidden === "分頁在背景");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
