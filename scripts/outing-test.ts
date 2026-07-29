/**
 * 樓外世界錨點(sim/outing.ts)驗證:
 * - 零 RNG:outingEncounterPass / outingSpot 期間不呼叫 Math.random(呼叫次數必須為 0)
 * - 決定性:同一遊戲日、同一批租客重複跑,巧遇對象與文案完全一致
 * - 前 OUTING_FIRST_DAY 天不觸發(balance-test 的 10 遊戲日碰不到本系統 → 快照零漂移)
 * - 相位偏移:新局全體 pair 的首次巧遇分散在多天,不集中(用真實 pairKey 驗分佈)
 * - **兩人目的地必須相同**才算碰到面(文案不矛盾 + 密度不爆的關鍵條件)
 * - **每日全域鎖**:全樓一個遊戲日最多成立一次巧遇
 * - pair 級冷卻不短於 OUTING_MIN_GAP_DAYS,且冷卻入存檔(reload 後不會馬上再巧遇)
 * - 有 pendingEvent(被事件凍結、visualState 停在舊值)的租客不參與
 * - 排序無關性:打亂 state.runtimes 的鍵插入順序後,巧遇對象與文案不變
 * - 精確副作用:關係恰好 +1、且只動到該對;所有 stats/金錢完全不變
 * - 佔位符:{o} 含 $& / $` 時不會被當成 replacement pattern 展開
 * - 目的地文本:outingSpot 對同一人同一天同一時段穩定;away 觀察句確實來自目的地池
 *
 * 註 1:新局的種子租客只有兩位,單一 pair 驗不出「節流/排序/相位」這幾件事,
 * 因此本測試會用 makeRuntime 補兩位純測試用租客(不進 occupancy,存檔測試前先移除)。
 * 註 2:加上「同地點」條件後,哪一對會在哪個小時成立已不可用寫死索引預測,
 * 所有需要「有一次巧遇」的測試一律用 probeFire() 掃出真正成立的 (day, offset) 再斷言。
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
/** 巧遇的迭代次序固定依 id 排序 */
const sortedIds = ids.slice().sort((a, b) => a.localeCompare(b));
const allPairs: string[] = [];
for (let i = 0; i < sortedIds.length; i++)
  for (let j = i + 1; j < sortedIds.length; j++) allPairs.push(pairKey(sortedIds[i], sortedIds[j]));
/** 相位偏移最大的 pair 也一定過了門檻的那一天 */
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
const outingLogs = (id: string) => (state.runtimes[id]?.log ?? []).filter((l) => l.text.startsWith("🏪"));
const firedIds = () => sortedIds.filter((id) => outingLogs(id).length > 0);
const allOutings = () => sortedIds.flatMap((id) => outingLogs(id).map((l) => `${id}:${l.text}`));
/** 完整清場:冷卻、日誌、全員外出 */
function reset() {
  resetOutingCooldown();
  clearLogs();
  awayAll();
}
/**
 * 從乾淨冷卻表出發,掃出「第 day 天第一個真的成立巧遇的小時」;找不到回 null。
 * 回傳時 state 就停在成立當下(日誌與冷卻都已寫入)。
 */
function probeOffset(day: number, outIds?: string[]): number | null {
  for (let off = 0; off < 24; off++) {
    resetOutingCooldown();
    clearLogs();
    setDayHour(day, off);
    if (outIds) awayOnly(outIds); else awayAll();
    outingEncounterPass(curHour());
    if (firedIds().length) return off;
  }
  return null;
}
function probeFire(fromDay: number, outIds?: string[], span = 20): { day: number; offset: number } | null {
  for (let d = fromDay; d < fromDay + span; d++) {
    const off = probeOffset(d, outIds);
    if (off !== null) return { day: d, offset: off };
  }
  return null;
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
// 用**真實 pairKey**算相位(不是合成鍵 t_i|t_{i+1}),驗的才是實際行為
const phases = allPairs.map((pk) => outingIndex(`phase|${pk}`, OUTING_PHASE_SPAN));
check("相位:真實 pairKey 的相位偏移散在多個值上", new Set(phases).size >= 2,
  JSON.stringify(allPairs.map((pk, i) => `${pk}=${phases[i]}`)));
check("相位:相位偏移一律落在 [0, OUTING_PHASE_SPAN)", phases.every((p) => p >= 0 && p < OUTING_PHASE_SPAN));

reset();
const firstDayByPair: Record<string, number> = {};
for (let d = OUTING_FIRST_DAY; d < OUTING_FIRST_DAY + 60; d++) {
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
check("相位:首次巧遇一律不早於門檻", firstDays.every((d) => d >= OUTING_FIRST_DAY), JSON.stringify(firstDays));
// 分佈斷言:不能有任何一天吃掉一半以上的 pair。只驗 `new Set(...).size >= 2` 的話,
// 「N-1 對擠同一天 + 1 對落另一天」這種雜湊退化仍會綠燈。
const firstDayHistogram: Record<number, number> = {};
for (const d of firstDays) firstDayHistogram[d] = (firstDayHistogram[d] ?? 0) + 1;
const maxSameDay = Math.max(...Object.values(firstDayHistogram));
check("相位:單日首次巧遇數不超過總 pair 數的一半", maxSameDay <= allPairs.length / 2,
  `單日最大 ${maxSameDay} / 總 pair ${allPairs.length};分佈=${JSON.stringify(firstDayHistogram)}`);

// --- 3. 同地點條件 + 每日全域鎖 --------------------------------------------------
const FIRE = probeFire(ALL_READY_DAY);
check("掃描:全員外出時確實找得到成立的小時", FIRE !== null, "20 天內都沒有任何一對碰到面");
const fireDay = FIRE!.day;
const fireOffset = FIRE!.offset;
/** 重現「那一次成立」的乾淨情境 */
function fireOnce() {
  resetOutingCooldown();
  clearLogs();
  setDayHour(fireDay, fireOffset);
  awayAll();
  outingEncounterPass(curHour());
}
fireOnce();
const firedPair = firedIds();
check("節流:全樓一次只成立 1 對(共 2 則日誌)", allOutings().length === 2, `實際 ${allOutings().length} 則`);
check("同地點:成立的兩位目的地完全相同",
  firedPair.length === 2
  && outingSpot(state.runtimes[firedPair[0]], fireDay, curHour()) === outingSpot(state.runtimes[firedPair[1]], fireDay, curHour()),
  JSON.stringify(firedPair.map((id) => `${id}=${outingSpot(state.runtimes[id], fireDay, curHour())}`)));
check("同地點:文案裡的地點就是兩人共同的目的地",
  outingLogs(firedPair[0])[0].text.includes(outingSpotLabel(outingSpot(state.runtimes[firedPair[0]], fireDay, curHour()))),
  outingLogs(firedPair[0])[0].text);
check("觸發:文字以「🏪 」開頭", allOutings().every((t) => t.slice(t.indexOf(":") + 1).startsWith("🏪 ")));
check("觸發:沒有殘留未代換的佔位符", allOutings().every((t) => !/[{}]/.test(t)));
check("觸發:日誌 importance 為 notable(會進 Feed)",
  state.runtimes[firedPair[0]].log.every((l) => l.importance === "notable"));
check("觸發:文案含對方名字", outingLogs(firedPair[0])[0].text.includes(state.runtimes[firedPair[1]].tenant.name));
check("觸發:兩人各留一句,而且不是同一句(視角不同)",
  outingLogs(firedPair[0])[0].text !== outingLogs(firedPair[1])[0].text);

// 每日全域鎖:成立之後,同一遊戲日剩下的每一小時都不得再成立第二對
for (let off = 0; off < 24; off++) {
  if (off === fireOffset) continue;
  setDayHour(fireDay, off);
  awayAll();
  outingEncounterPass(curHour());
}
check("每日全域鎖:成立當天其餘 23 小時不再有第二對", allOutings().length === 2,
  `實際 ${allOutings().length} 則:${JSON.stringify(allOutings())}`);
check("每日全域鎖:鎖寫在 interactionCooldowns['outing|__day']",
  state.interactionCooldowns["outing|__day"] === fireDay, `${state.interactionCooldowns["outing|__day"]}`);

// --- 4. 少於兩人外出就不觸發 ----------------------------------------------------
reset();
setDayHour(ALL_READY_DAY, 0);
awayOnly([sortedIds[0]]);
outingEncounterPass(curHour());
check("觸發條件:只有一人外出時不巧遇", allOutings().length === 0, JSON.stringify(allOutings()));

// --- 5. pendingEvent 的租客不參與 ------------------------------------------------
const FROZEN = firedPair[0];
const pendingStub = {
  id: "test_pending", title: "測試待決", description: "測試用",
  choices: [{ id: "a", label: "選項甲", hint: "無" }],
} as any;
resetOutingCooldown();
clearLogs();
setDayHour(fireDay, fireOffset);
awayAll();
state.runtimes[FROZEN].pendingEvent = pendingStub;
outingEncounterPass(curHour());
check("pendingEvent:同一小時原本會成立的那一對,凍結其中一位後不成立",
  outingLogs(FROZEN).length === 0, JSON.stringify(allOutings()));
// 其他人照常:往後掃到下一次成立,名單不得含被凍結者
let otherFired = false;
outer: for (let d = fireDay; d < fireDay + 20; d++) {
  for (let off = 0; off < 24; off++) {
    setDayHour(d, off);
    awayAll();
    state.runtimes[FROZEN].pendingEvent = pendingStub; // awayAll 會清掉 pendingEvent,重新掛回
    outingEncounterPass(curHour());
    if (firedIds().length) { otherFired = true; break outer; }
  }
}
check("pendingEvent:其他人照常巧遇,且成立名單不含被凍結者",
  otherFired && outingLogs(FROZEN).length === 0, JSON.stringify(allOutings()));
state.runtimes[FROZEN].pendingEvent = null;

// --- 6. pair 冷卻間隔 + 稀疏度 ---------------------------------------------------
// 只讓固定兩人外出,排除「誰先成立」的競爭。加上同地點條件後,間隔 = 冷卻(4~5 天)
// + 等到兩人目的地再次一致,因此**下限**仍是 OUTING_MIN_GAP_DAYS,上限會被拉長。
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
/** 間隔的合理上界:超過這個就等於「設計上幾乎不會再發生」,要當成 bug 抓 */
const GAP_SANE_MAX = 12;
check("冷卻:40 遊戲日內確實反覆巧遇(稀疏但不是永不觸發)", fireDays.length >= 6,
  `實際 ${fireDays.length} 次:${JSON.stringify(fireDays)}`);
check("冷卻:間隔一律不短於 OUTING_MIN_GAP_DAYS", gaps.length > 0 && gaps.every((g) => g >= OUTING_MIN_GAP_DAYS),
  JSON.stringify(gaps));
check(`冷卻:間隔不會長到形同不觸發(≤ ${GAP_SANE_MAX} 遊戲日)`, gaps.every((g) => g <= GAP_SANE_MAX), JSON.stringify(gaps));
check("冷卻:仍有間隔落在純冷卻下限帶(4~5 天),同地點條件沒有拖垮節奏",
  gaps.some((g) => g <= OUTING_MIN_GAP_DAYS + OUTING_GAP_SPAN - 1), JSON.stringify(gaps));
check("冷卻:間隔不等長(不會全樓同步)", new Set(gaps).size >= 2, JSON.stringify(gaps));
check("冷卻:同一天不會補第二次", new Set(fireDays).size === fireDays.length, JSON.stringify(fireDays));

// 全員外出的高競爭情境:每對間隔仍不短於 4 天,且每個遊戲日全樓最多成立一次
reset();
const lastFire: Record<string, number> = {};
const houseGaps: number[] = [];
const firesPerDay: Record<number, number> = {};
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
      firesPerDay[cd] = (firesPerDay[cd] ?? 0) + 1;
    }
  }
}
check("冷卻:全員外出的競爭情境下,間隔仍不短於 4 天", houseGaps.length > 0 && houseGaps.every((g) => g >= OUTING_MIN_GAP_DAYS),
  JSON.stringify(houseGaps.filter((g) => g < OUTING_MIN_GAP_DAYS)));
check("每日全域鎖:全員外出 31 天,任何一天都只成立 1 對",
  Object.values(firesPerDay).length > 0 && Object.values(firesPerDay).every((n) => n === 1), JSON.stringify(firesPerDay));

// --- 7. 零 RNG ------------------------------------------------------------------
fireOnce();
const callsBefore = randomCalls;
outingEncounterPass(curHour());
for (const id of sortedIds) for (let h = 0; h < 24; h++) outingSpot(state.runtimes[id], ALL_READY_DAY, h);
const rngUsed = randomCalls - callsBefore;
check("零 RNG:outingEncounterPass/outingSpot 期間不呼叫 Math.random", rngUsed === 0, `實際呼叫 ${rngUsed} 次`);

// --- 8. 決定性 ------------------------------------------------------------------
function transcript(): string {
  fireOnce();
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
resetOutingCooldown();
clearLogs();
setDayHour(fireDay, fireOffset);
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
check("副作用:變動的正是成立的那一對", changed[0] === pairKey(firedPair[0], firedPair[1]), `${changed[0]}`);
check("副作用:mood/stress/energy/滿意度/金錢完全不變", statsBefore === statsAfter);
check("副作用:確實有巧遇(不是空轉才沒變)", allOutings().length === 2);

// --- 11. 佔位符跳脫:{o} 含 $& / $` 時不得被當成 replacement pattern ---------------
// 名字不參與任何雜湊(選句與選地點只吃 id),改名不會換掉成立的那一對
const nameA = state.runtimes[firedPair[0]].tenant.name;
const nameB = state.runtimes[firedPair[1]].tenant.name;
state.runtimes[firedPair[0]].tenant.name = "阿$&明$`";
state.runtimes[firedPair[1]].tenant.name = "小$&華$`";
fireOnce();
const dollarTexts = allOutings();
check("跳脫:$& / $` 不會被展開成 replacement pattern",
  dollarTexts.length === 2 && !dollarTexts.some((t) => /[{}]/.test(t)), JSON.stringify(dollarTexts));
check("跳脫:名字原樣保留", outingLogs(firedPair[0])[0].text.includes("小$&華$`")
  && outingLogs(firedPair[1])[0].text.includes("阿$&明$`"), JSON.stringify(dollarTexts));
state.runtimes[firedPair[0]].tenant.name = nameA;
state.runtimes[firedPair[1]].tenant.name = nameB;

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
const seedSorted = seedIds.slice().sort((a, b) => a.localeCompare(b));
const S_A = seedSorted[0];
const S_B = seedSorted[1];
const SEED_FIRE = probeFire(ALL_READY_DAY, [S_A, S_B]);
check("存檔:種子兩位租客確實找得到會碰面的小時", SEED_FIRE !== null);
const cdKey = `outing|${pairKey(S_A, S_B)}`;
check("存檔:冷卻寫在 interactionCooldowns(值為遊戲日序號)", state.interactionCooldowns[cdKey] === SEED_FIRE!.day,
  `${state.interactionCooldowns[cdKey]} vs ${SEED_FIRE!.day}`);
save();
resetOutingCooldown();
check("存檔:load 前冷卻確實被清掉", state.interactionCooldowns[cdKey] === undefined);
load();
check("存檔:冷卻完整還原", state.interactionCooldowns[cdKey] === SEED_FIRE!.day);
check("存檔:每日全域鎖也一併還原", state.interactionCooldowns["outing|__day"] === SEED_FIRE!.day);
setDayHour(SEED_FIRE!.day + 1, 0);
awayOnly([S_A, S_B]);
const beforeReload = outingLogs(S_A).length;
outingEncounterPass(curHour());
check("存檔:reload 後隔天不會馬上又巧遇", outingLogs(S_A).length === beforeReload);

// --- 14. resetOutingCooldown 清乾淨 ----------------------------------------------
resetOutingCooldown();
check("resetOutingCooldown:清掉所有 outing| 冷卻(含每日全域鎖)",
  !Object.keys(state.interactionCooldowns).some((k) => k.startsWith("outing|")));
for (const rt of Object.values(state.runtimes)) rt.log.splice(0, rt.log.length);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
