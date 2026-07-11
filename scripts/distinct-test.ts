/**
 * 角色辨識度(§9-1 補強)驗證:
 * - 種子租客有固定部件外觀(陳=刺蝟頭+眼鏡、林=長髮+耳機),配色沿用原專屬 Theme
 * - refreshAppearances 部件去重:同住者髮型彼此不同、配件(非 none)不重複
 * - 穩定性:重複刷新不會反覆換造型
 * - 存檔往返:外觀入檔、讀回一致
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, refreshAppearances } = await import("../src/sim/gameState");
const { getCustomAppearance, getTheme } = await import("../src/pixel/scene");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { save, load } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 種子租客固定部件外觀(模組載入時已刷新)---
const chen = getCustomAppearance("tenant_chen_engineer");
const lin = getCustomAppearance("tenant_lin_asmr");
check("陳家豪:刺蝟頭+眼鏡", chen?.hairStyle === "spiky" && chen?.accessory === "glasses");
check("林小婕:長髮+耳機", lin?.hairStyle === "long" && lin?.accessory === "headphones");
check("外觀寫回 tenant(會入存檔)", !!state.runtimes["tenant_chen_engineer"].tenant.appearance);
check("配色沿用原專屬 Theme(陳的衣服還是藍)", getTheme("tenant_chen_engineer").shirt === "#5f86b0");
check("兩位種子髮型不同", chen?.hairStyle !== lin?.hairStyle);

// --- 部件去重:招滿 4 房,髮型彼此不同 ---
moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
refreshAppearances();
const residents = Object.values(state.occupancy);
const aps = residents.map((tid) => state.runtimes[tid].tenant.appearance!);
check("4 位住戶都有部件外觀", aps.every((a) => !!a));
const styles = aps.map((a) => a.hairStyle);
check("4 位住戶髮型彼此不同", new Set(styles).size === styles.length, styles.join(","));
const accs = aps.map((a) => a.accessory).filter((a) => a !== "none");
check("配件(非 none)不重複", new Set(accs).size === accs.length, accs.join(","));

// --- 穩定性:重複刷新不換造型 ---
const snapshot = JSON.stringify(aps);
refreshAppearances();
refreshAppearances();
check("重複刷新造型不變", JSON.stringify(residents.map((tid) => state.runtimes[tid].tenant.appearance)) === snapshot);

// --- 存檔往返 ---
save();
check("讀檔成功", load());
const chen2 = getCustomAppearance("tenant_chen_engineer");
check("讀檔後種子外觀一致", chen2?.hairStyle === "spiky" && chen2?.accessory === "glasses");
const styles2 = Object.values(state.occupancy).map((tid) => state.runtimes[tid].tenant.appearance!.hairStyle);
check("讀檔後住戶髮型仍彼此不同", new Set(styles2).size === styles2.length);

// --- 舊存檔相容:種子沒有 appearance → load 補上 ---
const raw = JSON.parse(mem["rent_house_save_v1"]);
delete raw.runtimes.tenant_chen_engineer.tenant.appearance;
mem["rent_house_save_v1"] = JSON.stringify(raw);
check("舊檔(無外觀)讀檔成功", load());
check("舊檔種子自動補上固定外觀", state.runtimes["tenant_chen_engineer"].tenant.appearance?.hairStyle === "spiky");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
