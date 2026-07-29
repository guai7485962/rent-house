/**
 * 樓外世界錨點(sim/outing.ts)驗證:
 * - 零 RNG:outingEncounterPass / outingSpot 期間不呼叫 Math.random(呼叫次數必須為 0)
 * - 決定性:同一遊戲日、同一批租客重複跑,巧遇對象與文案完全一致
 * - 前 OUTING_FIRST_DAY 天不觸發(balance-test 的 10 遊戲日碰不到本系統 → 快照零漂移)
 * - 相位偏移:新局全體 pair 的首次巧遇不集中在同一天
 * - pair 級冷卻間隔決定性地落在 4~5 遊戲日,且冷卻入存檔(reload 後不會馬上再巧遇)
 * - 一次 pass 最多成立 1 對(同一小時多人外出也只推一組日誌)
 * - 有 pendingEvent(被事件凍結、visualState 停在舊值)的租客不參與
 * - 排序無關性:打亂 state.runtimes 的鍵插入順序後,巧遇對象與文案不變
 * - 精確副作用:關係恰好 +1、且只動到該對;所有 stats/金錢完全不變
 * - 佔位符:{o} 含 $& / $` 時不會被當成 replacement pattern 展開
 * - 目的地文本:outingSpot 對同一人同一天同一時段穩定;away 觀察句確實來自目的地池
 *
 * 註:新局的種子租客只有兩位,單一 pair 驗不出「節流/排序/相位」這幾件事,
 * 因此本測試會用 makeRuntime 補兩位純測試用租客(不進 occupancy,存檔測試前先移除)。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32);本測試同時會統計 Math.random 呼叫次數
let __seed = 20260729;
let randomCalls = 0;
Math.random = () => {
  randomCalls++;
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state } = await import("../src/store");
const {
  outingEncounterPass, resetOutingCooldown, outingSpot, outingSpotLines, outingSpotLabel, outingIndex,
  OUTING_FIRST_DAY, OUTING_MIN_GAP_DAYS, OUTING_GAP_SPAN, OUTING_PHASE_SPAN, OUTING_BOND, OUTING_SPOTS,
} = await import("../src/sim/outing");
const { GAME_START, makeRuntime } = await import("../src/sim/gameState");
const { relationships, pairKey } = await import("../src/sim/social");
const { save, load } = await import("../src/sim/persistence");
const { generateHourly } = await import("../src/sim/generate");
const { OBSERVATION_LINES } = await import("../src/content/observationLines");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
/** 把遊戲時間放到第 day 個遊戲日開始後的第 offset 小時(gameDayIndex 以 GAME_START 的 22:00 為原點) */
function setDayHour(day: number, offset = 12) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + offset * 3600 * 1000;
}
/** 目前這一小時的本地時鐘(遊戲作息全用本地 getHours(),測試不硬寫數字) */
const curHour = () => new Date(state.gameMs).getHours();

const seedIds = Object.keys(state.runtimes).slice();
/** 補測試租客:只塞進 runtimes(巧遇只讀 runtimes),存檔測試前會先移除 */
const EXTRA_IDS = ["zz_outing_c", "zz_outing_d"];
for (const [i, id] of EXTRA_IDS.entries()) {
  const t = JSON.parse(JSON.stringify(state.runtimes[seedIds[0]].tenant));
  t.id = id;
  t.name = `測試租客${i + 1}`;
  t.memoryTags = [];
  t.visualState = "idle";
  state.runtimes[id] = makeRuntime(t, `90${i}`, 70, []);
}
const ids = Object.keys(state.runtimes).slice();
/** 巧遇的迭代次序固定依 id 排序,測試也用同一組排序來預期「誰會先成立」 */
const sortedIds = ids.slice().sort((a, b) => a.localeCompare(b));
const allPairs: string[] = [];
for (let i = 0; i < sortedIds.length; i++)
  for (let j = i + 1; j < sortedIds.length; j++) allPairs.push(pairKey(sortedIds[i], sortedIds[j]));
/**
 * 相位偏移最大的 pair 也一定過了門檻的那一天。首次巧遇被 phase 散在
 * 第 OUTING_FIRST_DAY ~ +OUTING_PHASE_SPAN-1 天,要驗「全員都已就緒」的情境
 * 一律用這一天當起點,而不是 OUTING_FIRST_DAY。
 */
const ALL_READY_DAY = OUTING_FIRST_DAY + OUTING_PHASE_SPAN - 1;

function awayAll() {
  for (const rt of Object.values(state.runtimes)) {
    rt.tenant.visualState = "away";
    rt.pendingEvent = null;
  }
}
/** 只讓指定的人外出,其他人留在房裡(排除「誰先成立」的競爭,才驗得準冷卻間隔) */
function awayOnly(outIds: string[]) {
  for (const rt of Object.values(state.runtimes)) {
    rt.tenant.visualState = outIds.includes(rt.tenant.id) ? "away" : "idle";
    rt.pendingEvent = null;
  }
}
function clearLogs() {
  for (const rt of Object.values(state.runtimes)) rt.log.splice(0, rt.log.length);
}
const outingLogs = (id: string) => state.runtimes[id].log.filter((l) => l.text.startsWith("🏪"));
const allOutings = () => sortedIds.flatMap((id) => outingLogs(id).map((l) => `${id}:${l.text}`));
/** 完整清場:冷卻、日誌、全員外出 */
function reset() {
  resetOutingCooldown();
  clearLogs();
  awayAll();
}
/** 數值快照(巧遇只准動關係值,其餘一律不得變) */
function statsSnapshot(): string {
  return JSON.stringify(sortedIds.map((id) => {
    const rt = state.runtimes[id];
    return { s: rt.tenant.stats, sat: rt.satisfaction, unhappy: rt.unhappyHours, flags: rt.flags.length, money: state.money };
  }));
}
const relSnapshot = (): Record<string, number> =>
  Object.fromEntries(Object.entries(relationships).map(([k, r]) => [k, r.value]));

check("測試前置:至少四位租客(兩位種子 + 兩位測試租客)", ids.length >= 4, `ids=${ids.length}`);
check("門檻涵蓋 balance-test 的 10 遊戲日", OUTING_FIRST_DAY > 10, `OUTING_FIRST_DAY=${OUTING_FIRST_DAY}`);
check("目的地表:至少 6 個目的地,任何小時都有候選", OUTING_SPOTS.length >= 6
  && Array.from({ length: 24 }, (_, h) => OUTING_SPOTS.filter((s) => h >= s.from && h <= s.to).length).every((n) => n >= 2));

// --- 1. 前 OUTING_FIRST_DAY 天完全不觸發 ---------------------------------------
reset();
for (let d = 0; d < OUTING_FIRST_DAY; d++) {
  for (let h = 0; h < 24; h++) {
    setDayHour(d, h);
    awayAll();
    outingEncounterPass(curHour());
  }
}
check("門檻:前 14 個遊戲日一次巧遇都不產生", allOutings().length === 0, `實際 ${allOutings().length} 則`);

// --- 2. 相位偏移:新局全體 pair 不會在第 14 天同時巧遇 --------------------------
const probePhases = Array.from({ length: 24 }, (_, i) => outingIndex(`phase|t_${i}|t_${i + 1}`, OUTING_PHASE_SPAN));
check("相位:雜湊確實把 pair 散在多個相位上", new Set(probePhases).size >= 3, JSON.stringify(probePhases));
check("相位:相位偏移一律落在 [0, OUTING_PHASE_SPAN)", probePhases.every((p) => p >= 0 && p < OUTING_PHASE_SPAN));

reset();
const firstDayByPair: Record<string, number> = {};
for (let d = OUTING_FIRST_DAY; d < OUTING_FIRST_DAY + OUTING_PHASE_SPAN + 4; d++) {
  for (let h = 0; h < 24; h++) {
    setDayHour(d, h);
    awayAll();
    outingEncounterPass(curHour());
    // 冷卻值就是「最近一次巧遇的遊戲日序號」,第一次出現時記下來即為首次巧遇日
    for (const pk of allPairs) {
      const cd = state.interactionCooldowns[`outing|${pk}`];
      if (cd !== undefined && firstDayByPair[pk] === undefined) firstDayByPair[pk] = cd;
    }
  }
}
const firstDays = allPairs.map((pk) => firstDayByPair[pk]).filter((d) => d !== undefined);
check("相位:每一對最終都會巧遇", firstDays.length === allPairs.length, `${firstDays.length}/${allPairs.length}`);
check("相位:首次巧遇日不集中在同一天(至少橫跨 2 天)", new Set(firstDays).size >= 2, JSON.stringify(firstDays));
check("相位:首次巧遇一律不早於門檻", firstDays.every((d) => d >= OUTING_FIRST_DAY), JSON.stringify(firstDays));

// --- 3. 一次 pass 最多成立 1 對 -------------------------------------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayAll();
outingEncounterPass(curHour());
check("節流:全員外出時一次 pass 只成立 1 對(共 2 則日誌)", allOutings().length === 2, `實際 ${allOutings().length} 則`);
check("節流:成立的是 id 排序最前的兩位", outingLogs(sortedIds[0]).length === 1 && outingLogs(sortedIds[1]).length === 1,
  JSON.stringify(allOutings()));
check("觸發:文字以「🏪 」開頭", allOutings().every((t) => t.slice(t.indexOf(":") + 1).startsWith("🏪 ")));
check("觸發:沒有殘留未代換的佔位符", allOutings().every((t) => !/[{}]/.test(t)));
check("觸發:日誌 importance 為 notable(會進 Feed)",
  state.runtimes[sortedIds[0]].log.every((l) => l.importance === "notable"));
check("觸發:文案含對方名字與目的地名稱",
  outingLogs(sortedIds[0])[0].text.includes(state.runtimes[sortedIds[1]].tenant.name)
  && OUTING_SPOTS.some((s) => outingLogs(sortedIds[0])[0].text.includes(s.label)));
check("觸發:兩人各留一句,而且不是同一句(視角不同)",
  outingLogs(sortedIds[0])[0].text !== outingLogs(sortedIds[1])[0].text);

// --- 4. 少於兩人外出就不觸發 ----------------------------------------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayOnly([sortedIds[0]]);
outingEncounterPass(curHour());
check("觸發條件:只有一人外出時不巧遇", allOutings().length === 0, JSON.stringify(allOutings()));

// --- 5. pendingEvent 的租客不參與 ------------------------------------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayAll();
state.runtimes[sortedIds[0]].pendingEvent = {
  id: "test_pending",
  title: "測試待決",
  description: "測試用",
  choices: [{ id: "a", label: "選項甲", hint: "無" }],
} as any;
outingEncounterPass(curHour());
check("pendingEvent:被事件凍結的租客不參與巧遇", outingLogs(sortedIds[0]).length === 0);
check("pendingEvent:其餘的人照常成立一對", allOutings().length === 2
  && outingLogs(sortedIds[1]).length === 1 && outingLogs(sortedIds[2]).length === 1, JSON.stringify(allOutings()));
state.runtimes[sortedIds[0]].pendingEvent = null;

// --- 6. pair 冷卻間隔 4~5 遊戲日 + 稀疏度 ----------------------------------------
// 只讓固定兩人外出,排除「誰先成立」的競爭,間隔才驗得準
const PAIR_A = sortedIds[0];
const PAIR_B = sortedIds[1];
reset();
const fireDays: number[] = [];
for (let d = ALL_READY_DAY; d <= ALL_READY_DAY + 40; d++) {
  for (let h = 0; h < 24; h++) {
    setDayHour(d, h);
    awayOnly([PAIR_A, PAIR_B]);
    const before = outingLogs(PAIR_A).length;
    outingEncounterPass(curHour());
    if (outingLogs(PAIR_A).length > before) fireDays.push(d);
  }
}
const gaps = fireDays.slice(1).map((d, i) => d - fireDays[i]);
check("冷卻:40 遊戲日內確實反覆巧遇(稀疏但不是永不觸發)", fireDays.length >= 8, `實際 ${fireDays.length} 次:${JSON.stringify(fireDays)}`);
check("冷卻:間隔一律落在 4~5 遊戲日", gaps.length > 0
  && gaps.every((g) => g >= OUTING_MIN_GAP_DAYS && g <= OUTING_MIN_GAP_DAYS + OUTING_GAP_SPAN - 1), JSON.stringify(gaps));
check("冷卻:間隔不等長(4 與 5 都出現過,不會全樓同步)", new Set(gaps).size >= 2, JSON.stringify(gaps));
check("冷卻:同一天不會補第二次", new Set(fireDays).size === fireDays.length, JSON.stringify(fireDays));

// 全員外出的高競爭情境下,冷卻仍然不可能短於 4 天
reset();
const lastFire: Record<string, number> = {};
const houseGaps: number[] = [];
for (let d = ALL_READY_DAY; d <= ALL_READY_DAY + 30; d++) {
  for (let h = 0; h < 24; h++) {
    setDayHour(d, h);
    awayAll();
    outingEncounterPass(curHour());
    for (const pk of allPairs) {
      const cd = state.interactionCooldowns[`outing|${pk}`];
      if (cd === undefined || cd === lastFire[pk]) continue;
      if (lastFire[pk] !== undefined) houseGaps.push(cd - lastFire[pk]);
      lastFire[pk] = cd;
    }
  }
}
check("冷卻:全員外出的競爭情境下,間隔仍不短於 4 天", houseGaps.length > 0 && houseGaps.every((g) => g >= OUTING_MIN_GAP_DAYS),
  JSON.stringify(houseGaps.filter((g) => g < OUTING_MIN_GAP_DAYS)));

// --- 7. 零 RNG ------------------------------------------------------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayAll();
const callsBefore = randomCalls;
outingEncounterPass(curHour());
for (const id of sortedIds) for (let h = 0; h < 24; h++) outingSpot(state.runtimes[id], ALL_READY_DAY, h);
const rngUsed = randomCalls - callsBefore;
check("零 RNG:outingEncounterPass/outingSpot 期間不呼叫 Math.random", rngUsed === 0, `實際呼叫 ${rngUsed} 次`);

// --- 8. 決定性 ------------------------------------------------------------------
function transcript(): string {
  reset();
  setDayHour(ALL_READY_DAY, 3);
  awayAll();
  outingEncounterPass(curHour());
  return allOutings().join("\n");
}
const runA = transcript();
const runB = transcript();
check("決定性:同一天同一批租客兩次跑出完全相同的對象與文案", runA === runB, `\n  A=${runA}\n  B=${runB}`);
check("決定性:文案有實際內容", runA.split("\n").length === 2 && runA.length > 20, runA);

// --- 9. 排序無關性:打亂 runtimes 鍵插入順序,結果不變 ---------------------------
function reorderRuntimes(order: string[]) {
  const snapshot = order.map((id) => [id, state.runtimes[id]] as const);
  for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
  for (const [id, rt] of snapshot) state.runtimes[id] = rt;
}
const originalOrder = Object.keys(state.runtimes).slice();
reorderRuntimes(originalOrder.slice().reverse());
check("排序:鍵插入順序確實被打亂", Object.keys(state.runtimes)[0] !== originalOrder[0]);
const runReversed = transcript();
reorderRuntimes(originalOrder);
check("排序:打亂鍵順序後巧遇對象與文案完全相同", runReversed === runA, `\n  正序=${runA}\n  逆序=${runReversed}`);

// --- 10. 精確副作用:關係恰好 +1,只動到該對,其餘一律不變 -----------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayAll();
const relBefore = relSnapshot();
const statsBefore = statsSnapshot();
outingEncounterPass(curHour());
const relAfter = relSnapshot();
const statsAfter = statsSnapshot();
const changed = Object.keys({ ...relBefore, ...relAfter })
  .filter((k) => (relAfter[k] ?? 0) !== (relBefore[k] ?? 0));
check("副作用:只有一對關係值變動", changed.length === 1, JSON.stringify(changed));
check("副作用:變動幅度恰好 +1", changed.length === 1 && (relAfter[changed[0]] ?? 0) - (relBefore[changed[0]] ?? 0) === OUTING_BOND,
  JSON.stringify(changed.map((k) => [k, relBefore[k], relAfter[k]])));
check("副作用:變動的正是成立的那一對", changed[0] === pairKey(sortedIds[0], sortedIds[1]), changed[0]);
check("副作用:mood/stress/energy/滿意度/金錢完全不變", statsBefore === statsAfter);
check("副作用:確實有巧遇(不是空轉才沒變)", allOutings().length === 2);

// --- 11. 佔位符跳脫:{o} 含 $& / $` 時不得被當成 replacement pattern ---------------
const nameA = state.runtimes[sortedIds[0]].tenant.name;
const nameB = state.runtimes[sortedIds[1]].tenant.name;
state.runtimes[sortedIds[0]].tenant.name = "阿$&明$`";
state.runtimes[sortedIds[1]].tenant.name = "小$&華$`";
reset();
setDayHour(ALL_READY_DAY, 0);
awayAll();
outingEncounterPass(curHour());
const dollarTexts = allOutings();
check("跳脫:$& / $` 不會被展開成 replacement pattern",
  dollarTexts.length === 2 && !dollarTexts.some((t) => /[{}]/.test(t)), JSON.stringify(dollarTexts));
check("跳脫:名字原樣保留", outingLogs(sortedIds[0])[0].text.includes("小$&華$`")
  && outingLogs(sortedIds[1])[0].text.includes("阿$&明$`"), JSON.stringify(dollarTexts));
state.runtimes[sortedIds[0]].tenant.name = nameA;
state.runtimes[sortedIds[1]].tenant.name = nameB;

// --- 12. 目的地文本 --------------------------------------------------------------
const rtA = state.runtimes[sortedIds[0]];
check("目的地:同一人同一天同一時段結果穩定",
  Array.from({ length: 5 }, () => outingSpot(rtA, ALL_READY_DAY, 15)).every((s, _, arr) => s === arr[0]));
check("目的地:同一時段內每個小時都是同一個地點(14~17 為午後)",
  new Set([14, 15, 16, 17].map((h) => outingSpot(rtA, ALL_READY_DAY, h))).size === 1,
  JSON.stringify([14, 15, 16, 17].map((h) => outingSpot(rtA, ALL_READY_DAY, h))));
check("目的地:跨天會變(不是永遠同一個地點)",
  new Set(Array.from({ length: 30 }, (_, d) => outingSpot(rtA, ALL_READY_DAY + d, 15))).size >= 2);
check("目的地:不同租客同一時段不會被綁在一起",
  new Set(sortedIds.map((id) => outingSpot(state.runtimes[id], ALL_READY_DAY, 15))).size >= 2,
  JSON.stringify(sortedIds.map((id) => outingSpot(state.runtimes[id], ALL_READY_DAY, 15))));
check("目的地:回傳的 id 一律認得,且有對應句池與名稱", Array.from({ length: 24 }, (_, h) => outingSpot(rtA, ALL_READY_DAY, h))
  .every((id) => (outingSpotLines(id)?.length ?? 0) >= 13 && outingSpotLabel(id).length > 0));
check("目的地:合理時段(凌晨三點不會在公園/夜市/早餐店)",
  !["park", "nightmarket", "breakfast"].includes(outingSpot(rtA, ALL_READY_DAY, 3)), outingSpot(rtA, ALL_READY_DAY, 3));

const spotId = outingSpot(rtA, ALL_READY_DAY, 15);
const genCtx = {
  tenantId: rtA.tenant.id, tenantName: rtA.tenant.name, hour: 15, timeLabel: "15:00",
  state: "away" as const, isDeviation: false, recentSummary: "",
};
const withSpot = Array.from({ length: 40 }, () => generateHourly({ ...genCtx, outingSpot: spotId }).logText);
check("目的地:away 觀察句確實改從目的地池取",
  withSpot.every((t) => outingSpotLines(spotId)!.includes(t)), JSON.stringify(withSpot.slice(0, 2)));
check("目的地:句子沒有 emoji 前綴(走一般觀察日誌路徑)", withSpot.every((t) => !/^\p{Extended_Pictographic}/u.test(t)));
check("目的地:確實抽得到多句(不是永遠同一句)", new Set(withSpot).size >= 3, `${new Set(withSpot).size}`);
const awayFallback = (t: string) => OBSERVATION_LINES.away!.some((l) => l.replace(/\{time\}/g, "午後") === t);
const noSpot = Array.from({ length: 40 }, () => generateHourly({ ...genCtx }).logText);
check("目的地:沒帶 outingSpot 時 fallback 回原本的空房間句池", noSpot.every(awayFallback), JSON.stringify(noSpot.slice(0, 2)));
const unknown = generateHourly({ ...genCtx, outingSpot: "no_such_spot" }).logText;
check("目的地:認不得的 id 也 fallback 回空房間句池,不會拋錯", awayFallback(unknown), unknown);
const nonAway = generateHourly({ ...genCtx, state: "idle" as any, outingSpot: spotId }).logText;
check("目的地:非 away 狀態不受影響", OBSERVATION_LINES.idle!.includes(nonAway), nonAway);
const awayEffect = generateHourly({ ...genCtx, outingSpot: spotId }).statDeltas;
check("目的地:換池不改數值效果(仍套用 away 的 EFFECT)",
  awayEffect.stress === 2 && awayEffect.energy === -3, JSON.stringify(awayEffect));

// --- 13. 冷卻入存檔:reload 後不會馬上再巧遇 -------------------------------------
// 存檔測試必須在真正的種子租客上做,先移除測試租客(它們不在 occupancy 裡)
for (const id of EXTRA_IDS) delete state.runtimes[id];
const S_A = seedIds.slice().sort((a, b) => a.localeCompare(b))[0];
const S_B = seedIds.slice().sort((a, b) => a.localeCompare(b))[1];
resetOutingCooldown();
state.runtimes[S_A].log.splice(0, state.runtimes[S_A].log.length);
setDayHour(ALL_READY_DAY, 0);
awayOnly([S_A, S_B]);
outingEncounterPass(curHour());
const cdKey = `outing|${pairKey(S_A, S_B)}`;
check("存檔:冷卻寫在 interactionCooldowns(值為遊戲日序號)", state.interactionCooldowns[cdKey] === ALL_READY_DAY,
  `${state.interactionCooldowns[cdKey]}`);
save();
resetOutingCooldown();
check("存檔:load 前冷卻確實被清掉", state.interactionCooldowns[cdKey] === undefined);
load();
check("存檔:冷卻完整還原", state.interactionCooldowns[cdKey] === ALL_READY_DAY);
setDayHour(ALL_READY_DAY + 1, 0);
awayOnly([S_A, S_B]);
const beforeReload = outingLogs(S_A).length;
outingEncounterPass(curHour());
check("存檔:reload 後隔天不會馬上又巧遇", outingLogs(S_A).length === beforeReload);

// --- 14. resetOutingCooldown 清乾淨 ----------------------------------------------
resetOutingCooldown();
check("resetOutingCooldown:清掉所有 outing| 冷卻", !Object.keys(state.interactionCooldowns).some((k) => k.startsWith("outing|")));
for (const rt of Object.values(state.runtimes)) rt.log.splice(0, rt.log.length);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
