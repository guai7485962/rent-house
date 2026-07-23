/** 設定頁除錯 Log：全域狀態、現役 tags/logs、歷任房客離場快照與舊檔相容。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, buildDebugLog, exportDebugLog, DEBUG_LOG_VERSION } = await import("../src/store");
const { recordAlumnus } = await import("../src/sim/legacy");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
}

const current = state.runtimes["tenant_chen_engineer"];
current.log.push({
  gameMs: state.gameMs,
  timeLabel: "7/5 22:00",
  text: "除錯匯出測試日誌",
  visualState: "idle",
  importance: "major",
});

const fixedNow = Date.parse("2026-07-23T12:34:56.000Z");
const initial = buildDebugLog(fixedNow);
const currentOut = initial.currentTenants.find((tenant) => tenant.tenantId === current.tenant.id);
check("格式版本與產生時間固定", initial.debugLogVersion === DEBUG_LOG_VERSION && initial.generatedAt === "2026-07-23T12:34:56.000Z");
check("輸出全域遊戲狀態", initial.globalState.money === state.money && initial.globalState.occupancy === state.occupancy);
check("輸出世界家具／升級／關係", Array.isArray(initial.world.placements) && Array.isArray(initial.world.relationships) && !!initial.world.upgrades);
check("現役房客包含完整 tenant tags", !!currentOut && currentOut.tenant.coreTags.length === current.tenant.coreTags.length && currentOut.tenant.memoryTags.length === current.tenant.memoryTags.length);
check("現役房客包含完整 log", !!currentOut && currentOut.log.some((entry) => entry.text === "除錯匯出測試日誌"));

recordAlumnus(current, "除錯快照測試");
const alumnus = state.alumni[0];
check("離場名冊保存 tenant id 與 tags", alumnus.debugSnapshot?.tenantId === current.tenant.id && alumnus.debugSnapshot.coreTags.length === current.tenant.coreTags.length);
check("離場名冊保存完整 logs", alumnus.debugSnapshot?.log.some((entry) => entry.text === "除錯匯出測試日誌") === true);

state.alumni.push({
  name: "早期房客", occupation: "測試員", daysLived: 3, reason: "舊檔", leftMs: state.gameMs,
  memory: "只有舊版摘要", farewell: "再見",
});
const parsed = JSON.parse(exportDebugLog(fixedNow));
const old = parsed.formerTenants.find((entry: any) => entry.name === "早期房客");
check("匯出歷任房客的新快照", parsed.formerTenants.some((entry: any) => entry.debugSnapshot?.log?.some((log: any) => log.text === "除錯匯出測試日誌")));
check("舊存檔缺快照時有明確說明", old?.debugSnapshotAvailable === false && old.debugSnapshotNote.includes("未保存"));
check("漂亮排版 JSON 可直接解析", exportDebugLog(fixedNow).includes("\n  \"debugLogVersion\""));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail) process.exit(1);
