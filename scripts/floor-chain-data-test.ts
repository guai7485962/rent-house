/**
 * 月度全樓事件鏈**資料檔**(src/content/floorChains.ts)驗證。
 * 對照 scripts/floor-chain-test.ts(那支驗的是 sim 流程),本支驗的是內容與掛勾:
 *
 * 1. 🔴 抽檔前後逐位元不變:既有 3 條鏈對照凍結基準 scripts/floor-chain-baseline.json
 *    (基準由抽檔當下的 `git show HEAD:src/sim/floorChain.ts` 產出),除了「追加」旁白
 *    變體池 `notices` 之外不得有任何差異;
 * 2. 8 條鏈的資料完整性:4 階段、剛好一個抉擇階段、每個抉擇 3 個選項且三種型態齊全、
 *    新鏈的數值落在規格帶內、hint 講得清代價;
 * 3. 決定性:同輸入同輸出、全程零 Math.random(含真的領養小貓的那條路徑);
 * 4. 旁白變體:每階段 ≥3 句可選、同一次跑動內四話不逐字重複、換一次開章日會換句;
 * 5. 與既有系統的掛勾真的生效:整潔/身心/積怨/寵物/咖啡廳聲譽/記憶標籤;
 * 6. `{alumni}` 記號一定會被替換掉(名冊空的時候退回泛稱)。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子並統計呼叫次數(本系統應該一次都不呼叫)
let __seed = 20260807;
let randomCalls = 0;
Math.random = () => {
  randomCalls++;
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { readFileSync } = await import("node:fs");
const { state } = await import("../src/store");
const { FLOOR_CHAINS, LITTER_KITTEN_NAMES } = await import("../src/content/floorChains");
const { floorChainPass, resolveChainEvent, resetFloorChain, STAGE_DAYS } = await import("../src/sim/floorChain");
const { GAME_START } = await import("../src/sim/gameState");
const { getRel, adjustTension } = await import("../src/sim/social");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const ids = Object.keys(state.runtimes).sort();
const setDay = (d: number) => { state.gameMs = GAME_START.getTime() + d * DAY_MS + 12 * 3600 * 1000; };

// ===========================================================================
// 1. 🔴 抽檔前後逐位元不變
// ===========================================================================
const baseline = JSON.parse(readFileSync("scripts/floor-chain-baseline.json", "utf8")) as any[];
const dropNotices = (v: unknown) => JSON.parse(JSON.stringify(v, (k, val) => (k === "notices" ? undefined : val)));

check("基準檔:凍結的是抽檔前的三條鏈", baseline.length === 3 &&
  JSON.stringify(baseline.map((d) => d.id)) === JSON.stringify(["urban_renewal", "typhoon_night", "roof_leak"]));
check("🔴 抽檔:既有三條鏈與凍結基準逐位元相同(扣除追加的 notices)",
  JSON.stringify(dropNotices(FLOOR_CHAINS.slice(0, 3))) === JSON.stringify(baseline),
  firstJsonDiff(JSON.stringify(dropNotices(FLOOR_CHAINS.slice(0, 3))), JSON.stringify(baseline)));
check("🔴 抽檔:既有三條鏈仍排在最前面(選鏈順序不被新鏈插隊)",
  JSON.stringify(FLOOR_CHAINS.slice(0, 3).map((d) => d.id)) === JSON.stringify(baseline.map((d) => d.id)));

// 除了 notices 之外不得有新增的欄位
let extraKeys: string[] = [];
for (let i = 0; i < 3; i++) {
  const known = new Set(Object.keys(baseline[i]));
  extraKeys.push(...Object.keys(FLOOR_CHAINS[i]).filter((k) => !known.has(k)));
  FLOOR_CHAINS[i].stages.forEach((st, si) => {
    const knownStage = new Set(Object.keys(baseline[i].stages[si]));
    extraKeys.push(...Object.keys(st).filter((k) => k !== "notices" && !knownStage.has(k)));
  });
}
check("🔴 抽檔:既有三條鏈沒有多出 notices 以外的欄位", extraKeys.length === 0, extraKeys.join(","));

function firstJsonDiff(a: string, b: string): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return `\n  第 ${i} 個字元起:\n  now  =${a.slice(Math.max(0, i - 60), i + 60)}\n  base =${b.slice(Math.max(0, i - 60), i + 60)}`;
  return "";
}

// ===========================================================================
// 2. 8 條鏈的資料完整性
// ===========================================================================
const NEW_IDS = ["noise_complaint_chain", "water_outage", "stray_litter", "night_market", "old_resident_return"];
check("鏈數:3 → 8(一個月一條,約一年不重複)", FLOOR_CHAINS.length === 8);
check("鏈 id:五條新鏈都在,且 id 不重複",
  NEW_IDS.every((id) => FLOOR_CHAINS.some((d) => d.id === id)) &&
  new Set(FLOOR_CHAINS.map((d) => d.id)).size === 8);
check("結構:每條鏈都是 4 階段", FLOOR_CHAINS.every((d) => d.stages.length === 4));
check("結構:每條鏈剛好一個抉擇階段", FLOOR_CHAINS.every((d) => d.stages.filter((s) => s.decision).length === 1));
check("結構:每個抉擇剛好 3 個選項且 id 不重複", FLOOR_CHAINS.every((d) => d.stages.every((s) => {
  if (!s.decision) return true;
  return s.decision.choices.length === 3 && new Set(s.decision.choices.map((c) => c.id)).size === 3;
})));
check("結構:每條鏈都有伏筆旗標且為純中文(可安全餵 AI)",
  FLOOR_CHAINS.every((d) => d.stages.some((s) => s.flag && !/[A-Za-z]/.test(s.flag))));
check("結構:每階段都有標題、旁白與 ≥3 句個人日誌",
  FLOOR_CHAINS.every((d) => d.stages.every((s) => !!s.title && !!s.notice && s.lines.length >= 3)));

const decisionsOf = (d: (typeof FLOOR_CHAINS)[number]) => d.stages.find((s) => s.decision)!.decision!.choices;
const newChains = FLOOR_CHAINS.filter((d) => NEW_IDS.includes(d.id));

// 三種選項型態:花錢買最好結果 / 不花錢出力(bond 高) / 擺爛(負值)
check("選項型態:每條新鏈都有一個花錢選項($900~$3,000 且標題寫出金額)", newChains.every((d) => {
  const paid = decisionsOf(d).filter((c) => c.money);
  return paid.length === 1 && paid[0].money! <= -900 && paid[0].money! >= -3000 && paid[0].label.includes("$");
}));
check("選項型態:每條新鏈都有一個不花錢但 bond ≥3 的出力選項", newChains.every((d) =>
  decisionsOf(d).some((c) => !c.money && (c.bond ?? 0) >= 3)));
check("選項型態:每條新鏈都有一個擺爛選項(數值為負、不花錢)", newChains.every((d) =>
  decisionsOf(d).some((c) => !c.money && Object.values(c.all ?? {}).some((v) => v < 0))));
check("選項型態:擺爛不會把人推到不可回復(單次負值不超過 8、壓力不超過 +6)", newChains.every((d) =>
  decisionsOf(d).every((c) => Object.entries(c.all ?? {}).every(([k, v]) =>
    v >= -8 && (k !== "stress" || v <= 6)))));
check("選項型態:每個 hint 都講清楚代價(≥8 字)", FLOOR_CHAINS.every((d) =>
  d.stages.every((s) => (s.decision?.choices ?? []).every((c) => c.hint.length >= 8))));

// 數值幅度(規格 §4.4;既有三條是抽檔前的既成事實,不套新帶)
const inBand = (all: Record<string, number> | undefined) => Object.entries(all ?? {}).every(([k, v]) => {
  if (k === "satisfaction") return Math.abs(v) <= 8;
  if (k === "affinity") return Math.abs(v) <= 6;
  if (k === "stress") return Math.abs(v) <= 6;
  if (k === "mood") return Math.abs(v) <= 8;
  return false;
});
check("數值:新鏈的抉擇效果落在規格帶內(sat±8/aff±6/stress±6/mood±8)",
  newChains.every((d) => decisionsOf(d).every((c) => inBand(c.all as any))));
check("數值:新鏈的每話效果也落在規格帶內",
  newChains.every((d) => d.stages.every((s) => inBand(s.effect as any))));
check("數值:bond 一律 0~4", FLOOR_CHAINS.every((d) => d.stages.every((s) =>
  (s.bond === undefined || (s.bond >= -1 && s.bond <= 4)) &&
  (s.decision?.choices ?? []).every((c) => c.bond === undefined || (c.bond >= 0 && c.bond <= 4)))));

// 內容硬規則
const allText = JSON.stringify(FLOOR_CHAINS);
check("內容:抉擇不含驅逐/強制搬離", !/驅逐|趕走|強制搬離|請他搬走/.test(
  FLOOR_CHAINS.flatMap((d) => d.stages.flatMap((s) => (s.decision?.choices ?? []).map((c) => `${c.label}${c.hint}`))).join("")));
check("內容:不含未成年戀愛線或露骨字眼", !/未成年|國中生|高中生|裸|性愛/.test(allText));
check("內容:文案沒有殘留未定義的替換記號",
  !/\{(?!alumni\})[a-zA-Z_]+\}/.test(allText));

// ===========================================================================
// 3~6. 實跑八條鏈:決定性、旁白變體、掛勾、{alumni}
// ===========================================================================
function resetAll() {
  resetFloorChain();
  for (const rt of Object.values(state.runtimes)) {
    rt.log.splice(0, rt.log.length);
    rt.flags.splice(0, rt.flags.length);
    rt.tenant.visualState = "idle";
    rt.pendingEvent = null;
    rt.satisfaction = 60;
    rt.cleanliness = 70;
    rt.tenant.stats.mood = 60;
    rt.tenant.stats.stress = 30;
    rt.tenant.stats.affinity = 50;
    rt.tenant.stats.wellbeing = 60;
    rt.tenant.memoryTags.splice(0, rt.tenant.memoryTags.length);
  }
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      adjustTension(ids[i], ids[j], 0); // 確保關係存在後再壓成固定值
      const rel = getRel(ids[i], ids[j])!;
      rel.value = 20;
      rel.tension = 30;
    }
  state.noticeLog.splice(0, state.noticeLog.length);
  state.money = 200000;
  for (const k of Object.keys(state.pets)) delete (state.pets as any)[k];
  state.cafe.open = false;
  state.cafe.popularity = 0;
  state.alumni.splice(0, state.alumni.length);
}

/** 指定鏈 id 從第一話跑到收束(或只跑 maxStages 話);choicePick 決定抉擇要選第幾個選項 */
function runChain(chainId: string, choicePick: number, startDay = 40, maxStages = 6) {
  setDay(startDay);
  state.floorChain = {
    chainId, stage: 0, startDay, lastAdvanceDay: startDay - STAGE_DAYS, entries: [], done: false,
  };
  const notices: string[] = [];
  let chosen = "";
  for (let s = 0; s < maxStages && !state.floorChain?.done; s++) {
    setDay(startDay + s * STAGE_DAYS);
    floorChainPass();
    const ev = state.pendingChainEvent;
    if (ev) {
      const c = ev.choices[Math.min(choicePick, ev.choices.length - 1)];
      chosen = c.id;
      resolveChainEvent(c.id);
    }
  }
  for (const e of state.floorChain!.entries) notices.push(e.text);
  return { notices, chosen, entries: state.floorChain!.entries.slice() };
}

/** 完整轉錄(給決定性比對) */
function transcript(chainId: string, pick: number, startDay = 40): string {
  resetAll();
  const r = runChain(chainId, pick, startDay);
  const out = [`chain=${chainId}`, `chosen=${r.chosen}`, `money=${state.money}`, ...r.notices];
  for (const id of ids) {
    const rt = state.runtimes[id];
    out.push(`${id}|${rt.satisfaction}|${rt.cleanliness}|${rt.tenant.stats.mood}|${rt.tenant.stats.stress}|${rt.tenant.stats.wellbeing}`);
    out.push(`${id}|log=${rt.log.map((l) => l.text).join("¶")}`);
    out.push(`${id}|mem=${rt.tenant.memoryTags.map((m) => m.label).join(",")}`);
  }
  out.push(`pets=${JSON.stringify(Object.entries(state.pets).map(([k, p]: any) => `${k}:${p.name}:${p.color}`).sort())}`);
  return out.join("\n");
}

const rngBefore = randomCalls;
let allDeterministic = true;
let allComplete = true;
let allNoticesDistinct = true;
for (const def of FLOOR_CHAINS) {
  for (let pick = 0; pick < 3; pick++) {
    const a = transcript(def.id, pick);
    const b = transcript(def.id, pick);
    if (a !== b) { allDeterministic = false; console.log(`   ↳ 不決定性:${def.id} pick=${pick}`); }
    const r = runChainFresh(def.id, pick);
    if (r.entries.length !== 4 || r.entries.some((e) => !e.title || !e.text)) allComplete = false;
    if (new Set(r.notices).size !== 4) { allNoticesDistinct = false; console.log(`   ↳ 旁白重複:${def.id}`); }
  }
}
function runChainFresh(chainId: string, pick: number) {
  resetAll();
  return runChain(chainId, pick);
}
check("決定性:八條鏈 × 三種選項,同輸入兩次跑出完全相同的轉錄", allDeterministic);
check("完整性:八條鏈 × 三種選項都跑得完四話,每話有標題與旁白", allComplete);
check("旁白:同一條鏈同一次跑動的四話旁白不逐字重複", allNoticesDistinct);
check("零 RNG:整段實跑(含領養小貓)不呼叫 Math.random", randomCalls - rngBefore === 0, `實際 ${randomCalls - rngBefore} 次`);

// 旁白變體池:每階段 ≥3 句可選(notice + 2~3 變體)
check("旁白:每階段至少 3 句可選", FLOOR_CHAINS.every((d) => d.stages.every((s) => 1 + (s.notices?.length ?? 0) >= 3)));
const allNotices = FLOOR_CHAINS.flatMap((d) => d.stages.flatMap((s) => [s.notice, ...(s.notices ?? [])]));
check("旁白:全部旁白句彼此不重複", new Set(allNotices).size === allNotices.length, `${allNotices.length} 句`);
// 換一次開章日就換一批句子(避免變體池形同虛設)
let variedChains = 0;
for (const def of FLOOR_CHAINS) {
  resetAll();
  const a = runChain(def.id, 0, 40).notices.join("|");
  resetAll();
  const b = runChain(def.id, 0, 41).notices.join("|");
  if (a !== b) variedChains++;
}
check("旁白:換一個開章日,多數鏈會換掉旁白(變體池真的有作用)", variedChains >= 6, `${variedChains}/8 條有變化`);

// --- 掛勾:停水 → 身心 + 整潔 -------------------------------------------------
resetAll();
const wbBefore = state.runtimes[ids[0]].tenant.stats.wellbeing;
const clBefore = state.runtimes[ids[0]].cleanliness;
runChain("water_outage", 2, 40); // pick=2 → 擺爛,不會被補水抵銷
check("掛勾:停水擺爛 → 身心健康下降", state.runtimes[ids[0]].tenant.stats.wellbeing < wbBefore,
  `${wbBefore} → ${state.runtimes[ids[0]].tenant.stats.wellbeing}`);
resetAll();
runChain("water_outage", 0, 40); // pick=0 → 叫水車
check("掛勾:停水叫水車 → 整潔補回來", state.runtimes[ids[0]].cleanliness >= clBefore,
  `${clBefore} → ${state.runtimes[ids[0]].cleanliness}`);

// --- 掛勾:噪音 → 積怨 ------------------------------------------------------
resetAll();
const tenBefore = getRel(ids[0], ids[1])!.tension;
runChain("noise_complaint_chain", 0, 40); // 隔音
const tenAfterFix = getRel(ids[0], ids[1])!.tension;
resetAll();
runChain("noise_complaint_chain", 2, 40); // 擺爛
const tenAfterIgnore = getRel(ids[0], ids[1])!.tension;
check("掛勾:噪音做隔音 → 兩兩積怨下降", tenAfterFix < tenBefore, `${tenBefore} → ${tenAfterFix}`);
check("掛勾:噪音擺爛 → 兩兩積怨上升", tenAfterIgnore > tenBefore, `${tenBefore} → ${tenAfterIgnore}`);

// --- 掛勾:小貓 → 真的領養(adopt_cat 的規則路徑)------------------------------
resetAll();
runChain("stray_litter", 0, 40); // 送養
check("掛勾:小貓選送養 → 不會多出寵物", Object.keys(state.pets).length === 0);
resetAll();
const rngPet = randomCalls;
runChain("stray_litter", 1, 40); // 留下
const pets = Object.values(state.pets) as any[];
check("🔴 掛勾:小貓選留下 → 真的多一隻貓(adopt_cat 的非 AI 路徑)", pets.length === 1 && pets[0].kind === "cat");
check("掛勾:小貓的名字與花色都是決定性挑的(不吃 Math.random)",
  randomCalls - rngPet === 0 && !!pets[0] && LITTER_KITTEN_NAMES.includes(pets[0].name) && pets[0].color >= 1 && pets[0].color <= 3,
  pets[0] ? `${pets[0].name}/${pets[0].color}` : "沒有貓");
const petName = pets[0]?.name;
resetAll();
runChain("stray_litter", 1, 40);
check("掛勾:同輸入領養到同一隻貓", (Object.values(state.pets)[0] as any)?.name === petName);

// --- 掛勾:夜市 → 咖啡廳聲譽 + 整潔 -------------------------------------------
resetAll();
runChain("night_market", 2, 40, 2); // 只跑到第二話(油煙那一話),還沒被第四話收攤補回來
check("掛勾:夜市油煙 → 房間整潔下降", state.runtimes[ids[0]].cleanliness < 70, `${state.runtimes[ids[0]].cleanliness}`);
check("掛勾:咖啡廳沒開張就不動聲譽", state.cafe.popularity === 0);
resetAll();
runChain("night_market", 2, 40); // 整條跑完:收攤後整潔回到原點(不會永久扣)
check("掛勾:夜市收攤後整潔回到原水位(不留永久債)", state.runtimes[ids[0]].cleanliness === 70, `${state.runtimes[ids[0]].cleanliness}`);
resetAll();
state.cafe.open = true;
state.cafe.popularity = 40;
runChain("night_market", 0, 40);
check("掛勾:咖啡廳開張時,夜市人潮會推高聲譽", state.cafe.popularity > 40, `${state.cafe.popularity}`);

// --- 掛勾:舊房客 → 記憶標籤 + {alumni} 替換 -----------------------------------
resetAll();
const r0 = runChain("old_resident_return", 1, 40); // 陪大家整理
check("掛勾:舊房客陪整理 → 參與者留下記憶標籤",
  state.runtimes[ids[0]].tenant.memoryTags.some((m) => m.label === "和舊房客的重逢"));
check("{alumni}:名冊空的時候退回泛稱,不留下記號",
  r0.notices.every((t) => !t.includes("{alumni}")) && r0.notices.some((t) => t.includes("以前那位房客")));
resetAll();
state.alumni.unshift({ name: "周佩瑜", occupation: "設計師", daysLived: 120, reason: "搬去和家人住", leftMs: state.gameMs, memory: "常在交誼廳畫圖" } as any);
const r1 = runChain("old_resident_return", 1, 40);
check("{alumni}:名冊有人時代入最近離開的房客名字",
  r1.notices.some((t) => t.includes("周佩瑜")) && r1.notices.every((t) => !t.includes("{alumni}")));
const logText = state.runtimes[ids[0]].log.map((l) => l.text).join("");
check("{alumni}:個人日誌也一起代入,不會漏字", !logText.includes("{alumni}"));

resetAll();
console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
