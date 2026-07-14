/**
 * 每週生活報告驗證：7 日節奏、收支區間、重大事件、關係 delta、未讀與存檔相容。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, GAME_START, fmt, gameDayIndex } = await import("../src/sim/gameState");
const { relationships, pairKey } = await import("../src/sim/social");
const { weeklyReportPass, currentRelationshipSnapshot, WEEKLY_REPORT_CAP } = await import("../src/sim/weeklyReport");
const { feedUnreadCount } = await import("../src/sim/feed");
const { save, load, SAVE_KEY } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY = 24 * 3600 * 1000;
const A = state.runtimes["tenant_chen_engineer"];
const B = state.runtimes["tenant_lin_asmr"];
for (const rt of Object.values(state.runtimes)) rt.log.splice(0);
state.ledger.splice(0);
state.noticeLog.splice(0);
state.weeklyReports.splice(0);
state.lastWeeklyReportDay = 0;
for (const key of Object.keys(state.weeklyRelationshipSnapshot)) delete state.weeklyRelationshipSnapshot[key];
for (const key of Object.keys(relationships)) delete relationships[key];

state.gameMs = GAME_START.getTime() + 6 * DAY;
check("未滿 7 日不產生週報", weeklyReportPass() === null);

state.gameMs = GAME_START.getTime() + 7 * DAY;
const recentMs = state.gameMs - DAY;
const oldMs = state.gameMs - 8 * DAY;
state.ledger.push(
  { gameMs: oldMs, label: "上週收入", amount: 9999, category: "rent" },
  { gameMs: recentMs, label: "本週租金", amount: 1200, category: "rent" },
  { gameMs: recentMs + 1, label: "本週修繕", amount: -300, category: "upkeep" },
);
A.log.push(
  { gameMs: oldMs, timeLabel: fmt(oldMs), text: "上週舊事", visualState: "idle", importance: "major" },
  { gameMs: recentMs, timeLabel: fmt(recentMs), text: "本週發生重大轉折", visualState: "idle", importance: "major" },
  { gameMs: recentMs + 1, timeLabel: fmt(recentMs + 1), text: "本週值得記下的小事", visualState: "idle", importance: "notable" },
  { gameMs: recentMs + 2, timeLabel: fmt(recentMs + 2), text: "普通流水帳", visualState: "idle", importance: "minor" },
);
B.log.push({ gameMs: recentMs + 3, timeLabel: fmt(recentMs + 3), text: "另一位房客的重要事件", visualState: "idle", importance: "major" });

const key = pairKey(A.tenant.id, B.tenant.id);
relationships[key] = { value: 10, romantic: false, cohabitOffered: false };
Object.assign(state.weeklyRelationshipSnapshot, currentRelationshipSnapshot());
relationships[key].value = 28;

const report = weeklyReportPass();
check("第 7 日產生第一份週報", !!report && report.week === 1 && report.startDay === 1 && report.endDay === 7);
check("只彙整本週收支", report?.income === 1200 && report.expense === 300 && report.net === 900);
check("最多收錄 3 件重大/重要事件", report?.highlights.length === 3);
check("排除上週舊事與 minor 流水帳", !!report && report.highlights.every((h) => h.text !== "上週舊事" && h.text !== "普通流水帳"));
check("關係變化記錄 +18 與目前階段", report?.relationshipChanges[0]?.delta === 18 && report.relationshipChanges[0]?.current === 28);
check("報告完成後更新關係基準", state.weeklyRelationshipSnapshot[key] === 28);
check("同一天不重複產生", weeklyReportPass() === null);
check("週報上限為 12 份", WEEKLY_REPORT_CAP === 12);

state.feedSeenMs = state.gameMs - 1;
check("新週報會計入動態未讀徽章", feedUnreadCount() >= 1);

save();
state.weeklyReports.splice(0);
state.lastWeeklyReportDay = -99;
for (const k of Object.keys(state.weeklyRelationshipSnapshot)) delete state.weeklyRelationshipSnapshot[k];
check("讀檔成功", load());
check("週報/日期/關係基準存檔往返", state.weeklyReports.length === 1 && state.lastWeeklyReportDay === 7 && state.weeklyRelationshipSnapshot[key] === 28);

// 模擬舊存檔缺少週報欄位：應從載入當下建立基準，不立刻補一份假週報。
const oldSave = JSON.parse(mem[SAVE_KEY]);
delete oldSave.weeklyReports;
delete oldSave.lastWeeklyReportDay;
delete oldSave.weeklyRelationshipSnapshot;
mem[SAVE_KEY] = JSON.stringify(oldSave);
state.weeklyReports.push(report!);
state.lastWeeklyReportDay = -99;
for (const k of Object.keys(state.weeklyRelationshipSnapshot)) delete state.weeklyRelationshipSnapshot[k];
check("舊存檔仍可載入", load());
check("舊存檔不補假週報", state.weeklyReports.length === 0);
check("舊存檔以載入日與當下關係建立基準", state.lastWeeklyReportDay === gameDayIndex() && state.weeklyRelationshipSnapshot[key] === 28);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
