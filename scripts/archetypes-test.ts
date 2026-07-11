/**
 * 角色庫擴充(§9-2)驗證:
 * - 15 種原型:key 都對得上作息目錄、職業不重複、租金/偏好合理
 * - 新作息原型 24 小時全覆蓋、無非法資料(載入時零警告)
 * - 新相容度規則:健身同好加分、愛管閒事 vs 夜貓扣分
 * - 招租整合:應徵者能抽到新職業並正常入住走作息
 */
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => warns.push(args.join(" "));

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { ARCHETYPES, generateApplicants } = await import("../src/sim/recruit");
const { ARCHETYPE_ROUTINES } = await import("../src/sim/routine");
const { compatibility } = await import("../src/sim/social");
const { state, moveIn, debugStepHour } = await import("../src/store");
import type { Tenant } from "../src/types";
console.warn = origWarn;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 原型庫 ---
check("原型達 15 種", ARCHETYPES.length === 15, `實際 ${ARCHETYPES.length}`);
check("每種原型的作息 key 都存在", ARCHETYPES.every((a) => !!ARCHETYPE_ROUTINES[a.key]));
const jobs = new Set(ARCHETYPES.map((a) => a.occupation));
check("職業不重複", jobs.size === ARCHETYPES.length);
check("租金都在 8000~20000", ARCHETYPES.every((a) => a.monthlyRent >= 8000 && a.monthlyRent <= 20000));
check("每種原型有 2 個核心標籤", ARCHETYPES.every((a) => a.coreTags.length === 2));
check("每種原型有偏好", ARCHETYPES.every((a) => Object.keys(a.preferences).length >= 2));

// --- 作息資料健全(載入零警告 = 無非法 role/state、無缺漏小時) ---
check("作息目錄載入零警告", warns.length === 0, warns.slice(0, 3).join(" | "));
check("7 套作息原型 24 小時全覆蓋", Object.values(ARCHETYPE_ROUTINES).every((t) => t.length === 24 && t.every((s) => !!s.role && !!s.state)));
check("night_shift 深夜外出上班", ARCHETYPE_ROUTINES.night_shift[2].role === "out");
check("early_riser 清晨出門", ARCHETYPE_ROUTINES.early_riser[7].role === "out");
check("homebody 白天在家", ARCHETYPE_ROUTINES.homebody[10].role !== "out");
check("night_creator 深夜趕稿", ARCHETYPE_ROUTINES.night_creator[1].state === "working_at_desk");

// --- 相容度新規則 ---
const T = (ids: string[]): Tenant => ({ id: ids.join("_"), name: "x", coreTags: ids.map((i) => ({ id: i, label: i, behaviorHint: "" })), memoryTags: [] }) as unknown as Tenant;
check("健身×健身 加分", compatibility(T(["fitness", "early_bird"]), T(["fitness", "early_bird"])) > compatibility(T(["early_bird"]), T(["early_bird"])));
check("愛管閒事 vs 夜貓 扣分", compatibility(T(["busybody", "early_bird"]), T(["night_owl", "wfh"])) < compatibility(T(["early_bird"]), T(["night_owl", "wfh"])));
check("溫柔照護 與誰都合", compatibility(T(["caring"]), T(["noisy"])) > compatibility(T([]), T(["noisy"])));

// --- 招租整合:大量抽樣能抽到新職業 ---
const seen = new Set<string>();
for (let i = 0; i < 60; i++) for (const ap of generateApplicants("r303")) seen.add(ap.occupation);
check("抽樣 60 批能抽到 10+ 種職業", seen.size >= 10, `實際 ${seen.size} 種`);
check("能抽到新職業(護理師/甜點師/漫畫家其一)", ["夜班護理師", "甜點師", "漫畫家"].some((j) => seen.has(j)));

// 讓一位新原型角色入住並跑 24 小時(作息健全)
let target = null as ReturnType<typeof generateApplicants>[number] | null;
for (let i = 0; i < 200 && !target; i++) {
  target = generateApplicants("r303").find((a) => ["night_shift", "early_riser", "homebody", "night_creator"].includes(a.archetypeKey)) ?? null;
}
check("抽到新作息原型的應徵者", !!target);
if (target) {
  moveIn("r303", target);
  const rt = state.runtimes[target.id];
  for (let i = 0; i < 24; i++) debugStepHour();
  check("新原型入住後 24 小時模擬無崩潰、有日誌", !!rt && rt.log.length > 0);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
