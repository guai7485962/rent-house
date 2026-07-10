/**
 * QoL 無頭測試(設計檢討 8-2 / 8-4 / 8-6):
 * - canDropAt 擺放/移動預覽判定(含移動時排除自己舊佔位)
 * - startFastForward 分批快轉(不重入、時間正確推進)
 * - exportSave / importSave / clearSave 存檔管理(mock localStorage)
 */

// 先掛一個假的 localStorage,再載入 store(node 沒有 localStorage)
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

const { state, startPlacing, cancelPlacing, startMoving, cancelMoving, canDropAt, startFastForward, exportSave, importSave, clearSave, initGame, stopGame, SAVE_VERSION } =
  await import("../src/store");
const { furnitureAt, findFreeSlot } = await import("../src/sim/placements");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

// --- 8-2 擺放預覽判定 ---
const freeSlot = findFreeSlot("r301", 1, 1)!;
check("無擺放/移動模式時 canDropAt = false", !canDropAt(freeSlot.c, freeSlot.r));
startPlacing("plant"); // 1x1 小物
check("擺放:空地可放", canDropAt(freeSlot.c, freeSlot.r));
check("擺放:牆上不可放", !canDropAt(0, 0));
const bed = furnitureAt(1, 1); // r301 單人床(見 move-test)
check("擺放:壓到既有家具不可放", bed !== null && !canDropAt(bed.c, bed.r));
cancelPlacing();

// --- 8-2 移動預覽判定(排除自己) ---
if (bed) {
  startMoving(bed.c, bed.r);
  check("移動:與自己舊佔位重疊仍可放(排除自己)", canDropAt(bed.c, bed.r + 1) || canDropAt(bed.c + 1, bed.r));
  check("移動:牆上不可放", !canDropAt(0, 0));
  cancelMoving();
  check("取消移動後家具還在原位", furnitureAt(bed.c, bed.r) !== null);
}

// --- 8-6 分批快轉 ---
const before = state.gameMs;
startFastForward(24);
startFastForward(6); // 快轉中重按應被忽略,不能疊加
check("快轉啟動後 ffRemaining > 0", state.ffRemaining > 0);
await new Promise<void>((resolve, reject) => {
  const t0 = Date.now();
  const poll = () => {
    if (state.ffRemaining === 0) return resolve();
    if (Date.now() - t0 > 10000) return reject(new Error("快轉逾時"));
    setTimeout(poll, 10);
  };
  poll();
});
check("快轉完成後 ffRemaining = 0", state.ffRemaining === 0);
check("快轉剛好推進 24 小時(重按未疊加)", state.gameMs - before === 24 * MS_PER_GAME_HOUR);

// --- 8-4 存檔管理 ---
const { buyUpgrade } = await import("../src/store");
buyUpgrade("r304", "smart_home"); // 讓存檔帶一筆升級,驗證欄位入檔
const json = exportSave();
check("匯出存檔為有效 JSON 且 v=SAVE_VERSION", !!json && JSON.parse(json!).v === SAVE_VERSION);
check("房間升級入存檔", JSON.parse(json!).upgrades?.r304?.includes("smart_home") === true);
check("匯入非 JSON → 拒絕", !importSave("這不是存檔"));
check("匯入無升級路徑的舊版 → 拒絕", !importSave('{"v":1,"runtimes":{},"occupancy":{}}'));
check("匯入缺欄位 → 拒絕", !importSave(`{"v":${SAVE_VERSION}}`));

// --- 遷移層:v2 存檔(stats 還是 hygiene、沒有 energy)應被升級後接受 ---
const v2save = JSON.parse(json!);
v2save.v = 2;
for (const rtSaved of Object.values<any>(v2save.runtimes)) {
  const st = rtSaved.tenant.stats;
  st.hygiene = st.wellbeing ?? 70;
  delete st.wellbeing;
  delete st.energy;
}
check("匯入 v2 舊檔 → 遷移成功", importSave(JSON.stringify(v2save)));
const migrated = JSON.parse(mem["rent_house_save_v1"]);
const mstats = (Object.values<any>(migrated.runtimes)[0] as any).tenant.stats;
check("遷移後 v=SAVE_VERSION", migrated.v === SAVE_VERSION);
check("遷移後 hygiene→wellbeing、補 energy", mstats.wellbeing !== undefined && mstats.hygiene === undefined && mstats.energy !== undefined);

check("匯入自己匯出的檔 → 成功", !!json && importSave(json!));

// --- 存檔往返:把 state 改壞 → initGame() 從(匯入的)存檔重載 → 應還原 ---
const sv = JSON.parse(json!);
state.money = 123456789; // 哨兵值
initGame();
stopGame();
check("重載後金錢從存檔還原(非哨兵值)", state.money !== 123456789 && Math.abs(state.money - sv.money) < 5000);
check("重載後租客數與存檔一致", Object.keys(state.runtimes).length === Object.keys(sv.runtimes).length);

clearSave();
check("清檔後 localStorage 已無存檔", mem["rent_house_save_v1"] === undefined);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
