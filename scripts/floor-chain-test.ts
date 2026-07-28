/**
 * 月度全樓事件鏈(sim/floorChain.ts)驗證:
 * - 前 CHAIN_FIRST_DAY 天不開章(balance-test 的 10 遊戲日碰不到本系統)
 * - 階段依「距上次推進 ≥ STAGE_DAYS」推進,不到日數不推、同一天重複呼叫不重複發
 * - 關鍵階段掛出獨立抉擇槽(不動 pendingGroupEvent),待決期間鏈停在原地
 * - 抉擇效果(金錢/滿意度/關係)正確套用,並補記進章節卡
 * - 掛機補進度:拖過 CHAIN_MAX_DAYS 直接跳過中間話收束到最後一話
 * - 鏈結束清掉伏筆旗標、隔 CHAIN_REST_DAYS 才開下一條且不連續同題材
 * - 存檔往返後章節狀態(含待決抉擇)完整
 * - 零 RNG:整段推進不呼叫 Math.random,同輸入必得同輸出
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32);本測試同時會統計 Math.random 呼叫次數
let __seed = 20260710;
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
  floorChainPass, resolveChainEvent, floorChainView, resetFloorChain, chainDef,
  CHAIN_DEFS, CHAIN_FIRST_DAY, CHAIN_MAX_DAYS, CHAIN_REST_DAYS, STAGE_DAYS,
} = await import("../src/sim/floorChain");
const { GAME_START, gameDayIndex } = await import("../src/sim/gameState");
const { save, load } = await import("../src/sim/persistence");
const { getRel } = await import("../src/sim/social");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
/** 把遊戲時間放到第 day 個遊戲日的正中間(gameDayIndex 以 GAME_START 為原點) */
function setDay(day: number) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + 12 * 3600 * 1000;
}
/** 所有租客都在場、沒有卡著待決事件(章節事件才會落到每個人身上) */
function allPresent() {
  for (const rt of Object.values(state.runtimes)) {
    rt.tenant.visualState = "idle";
    rt.pendingEvent = null;
  }
}
/** 完整清空章節狀態 + 日誌,讓每個情境互不污染 */
function reset() {
  resetFloorChain();
  for (const rt of Object.values(state.runtimes)) {
    rt.log.splice(0, rt.log.length);
    rt.flags.splice(0, rt.flags.length);
  }
  state.noticeLog.splice(0, state.noticeLog.length);
  allPresent();
}

const ids = Object.keys(state.runtimes);
check("測試前置:至少兩位租客在場", ids.length >= 2);
setDay(0);
reset();

// --- 1. 開章門檻:前 CHAIN_FIRST_DAY 天不開章 ---------------------------------
let openedEarly = false;
for (let d = 0; d < CHAIN_FIRST_DAY; d++) {
  setDay(d);
  allPresent();
  if (floorChainPass()) openedEarly = true;
}
check("開章門檻:前 14 個遊戲日完全不開章", !openedEarly && state.floorChain === null);
check("開章門檻涵蓋 balance-test 的 10 遊戲日", CHAIN_FIRST_DAY > 10);

// --- 2. 第一話與推進節奏 -----------------------------------------------------
setDay(CHAIN_FIRST_DAY);
allPresent();
check("第 14 日開章:掛上第一話", floorChainPass() === true && state.floorChain?.stage === 1);
const firstChainId = state.floorChain!.chainId;
check("開章:章節 id 是已定義的鏈", !!chainDef(firstChainId));
check("開章:每位在場租客都收到一則章節日誌", ids.every((id) => state.runtimes[id].log.length >= 1));
check("開章:章節卡有一則紀錄", floorChainView()?.entries.length === 1);
check("開章:不佔用群體事務抉擇槽", state.pendingGroupEvent === null);

// 同一天重複呼叫不重複發
const logsAfterFirst = ids.map((id) => state.runtimes[id].log.length);
check("冪等:同一天重複呼叫不再推進", floorChainPass() === false);
check("冪等:同一天重複呼叫不重複寫日誌", ids.every((id, i) => state.runtimes[id].log.length === logsAfterFirst[i]));

// 未滿 STAGE_DAYS 不推進
let advancedEarly = false;
for (let d = CHAIN_FIRST_DAY + 1; d < CHAIN_FIRST_DAY + STAGE_DAYS; d++) {
  setDay(d);
  allPresent();
  if (floorChainPass()) advancedEarly = true;
}
check("節奏:未滿 4 遊戲日不推進下一話", !advancedEarly && state.floorChain?.stage === 1);

const stage1Flag = chainDef(firstChainId)!.stages[0].flag!;
check("伏筆旗標:第一話掛上純中文旗標", !!stage1Flag && !/[A-Za-z]/.test(stage1Flag) && ids.every((id) => state.runtimes[id].flags.includes(stage1Flag)));

// --- 3. 走完整條鏈(含抉擇)---------------------------------------------------
let decisionStage = 0;
let decisionLabel = "";
let moneyBefore = 0;
let satBefore = 0;
let expectMoney = 0;
let expectSat = 0;
let relBefore = getRel(ids[0], ids[1])?.value ?? 0;
let expectBond = 0;
let day = CHAIN_FIRST_DAY;
let guard = 0;
while (!state.floorChain?.done && guard++ < 40) {
  day += STAGE_DAYS;
  setDay(day);
  allPresent();
  floorChainPass();
  const ev = state.pendingChainEvent;
  if (ev) {
    decisionStage = ev.stage;
    check("抉擇:待決期間鏈停在原地", floorChainPass() === false && state.floorChain?.stage === ev.stage);
    check("抉擇:參與者都是現存租客且至少兩個選項", ev.participantIds.every((id) => !!state.runtimes[id]) && ev.choices.length >= 2);
    check("抉擇:不寫進 pendingGroupEvent", state.pendingGroupEvent === null);
    const choice = ev.choices.find((c) => c.money) ?? ev.choices[0];
    decisionLabel = choice.label;
    expectMoney = choice.money ?? 0;
    expectSat = choice.all?.satisfaction ?? 0;
    expectBond = choice.bond ?? 0;
    moneyBefore = state.money;
    satBefore = state.runtimes[ids[0]].satisfaction;
    relBefore = getRel(ids[0], ids[1])?.value ?? 0;
    check("抉擇:未知選項不生效", resolveChainEvent("__not_a_choice__") === false && state.pendingChainEvent !== null);
    check("抉擇:拍板成功並清掉待決槽", resolveChainEvent(choice.id) === true && state.pendingChainEvent === null);
    // 效果要在拍板當下量,之後的話還會再套自己的 effect/bond
    check("抉擇:金錢正確扣款", state.money === moneyBefore + expectMoney, `${moneyBefore} → ${state.money}(預期 ${moneyBefore + expectMoney})`);
    check("抉擇:滿意度依選項變動", Math.abs(state.runtimes[ids[0]].satisfaction - Math.min(100, satBefore + expectSat)) < 0.001, `${satBefore} → ${state.runtimes[ids[0]].satisfaction}`);
    check("抉擇:關係依選項變動", Math.abs((getRel(ids[0], ids[1])?.value ?? 0) - Math.min(100, relBefore + expectBond)) < 0.001, `${relBefore} → ${getRel(ids[0], ids[1])?.value}`);
  }
}
check("整條鏈:四話走完並收束", state.floorChain?.done === true && state.floorChain?.entries.length === 4);
check("整條鏈:階段序號 1~4 且不重複", JSON.stringify(state.floorChain!.entries.map((e) => e.stage)) === JSON.stringify([1, 2, 3, 4]));
check("整條鏈:每話都有標題與內文", state.floorChain!.entries.every((e) => !!e.title && !!e.text));
check("抉擇:確實出現在其中一話", decisionStage >= 1 && decisionStage <= 4);
check("抉擇:結果補記進章節卡", state.floorChain!.entries.find((e) => e.stage === decisionStage)?.decision === decisionLabel);
check("收束:伏筆旗標已清乾淨", ids.every((id) => !state.runtimes[id].flags.includes(stage1Flag)));
check("收束:記下完結的遊戲日", state.lastChainEndDay === gameDayIndex());

// --- 4. 鏈間休息與換題材 -----------------------------------------------------
const endDay = state.lastChainEndDay;
let openedTooSoon = false;
for (let d = endDay + 1; d < endDay + CHAIN_REST_DAYS; d++) {
  setDay(d);
  allPresent();
  if (floorChainPass()) openedTooSoon = true;
}
check("鏈間休息:未滿 16 遊戲日不開下一條", !openedTooSoon && state.floorChain?.done === true);
setDay(endDay + CHAIN_REST_DAYS);
allPresent();
check("鏈間休息:滿 16 遊戲日開新章", floorChainPass() === true && state.floorChain?.done === false);
check("換題材:不會連續開同一條鏈", state.floorChain?.chainId !== firstChainId);
check("換題材:新章從第一話開始", state.floorChain?.stage === 1 && state.floorChain?.entries.length === 1);

// --- 5. 掛機補進度:拖過 CHAIN_MAX_DAYS 直接收束 -------------------------------
reset();
setDay(CHAIN_FIRST_DAY);
allPresent();
floorChainPass();
const longStart = state.floorChain!.startDay;
setDay(longStart + CHAIN_MAX_DAYS);
allPresent();
check("補進度:離線太久一次收束到最後一話", floorChainPass() === true && state.floorChain?.done === true);
check("補進度:四話紀錄齊全、不卡死", state.floorChain!.entries.length === 4);
check("補進度:被跳過的中間話標記為 skipped", state.floorChain!.entries.filter((e) => e.skipped).length === 2);
check("補進度:跳過的階段不掛待決抉擇", state.pendingChainEvent === null);
check("補進度:收束後不再重複推進", floorChainPass() === false);

// --- 6. 存檔往返 -------------------------------------------------------------
reset();
setDay(CHAIN_FIRST_DAY);
allPresent();
floorChainPass();
setDay(CHAIN_FIRST_DAY + STAGE_DAYS);
allPresent();
floorChainPass();
const beforeSave = JSON.stringify({ chain: state.floorChain, pending: state.pendingChainEvent, end: state.lastChainEndDay });
save();
state.floorChain = null;
state.pendingChainEvent = null;
state.lastChainEndDay = 0;
check("存檔往返:load 前狀態確實被清掉", state.floorChain === null);
load();
const afterLoad = JSON.stringify({ chain: state.floorChain, pending: state.pendingChainEvent, end: state.lastChainEndDay });
check("存檔往返:章節鏈狀態完整還原", afterLoad === beforeSave, `\n  before=${beforeSave}\n  after =${afterLoad}`);
check("存檔往返:章節卡仍讀得到", floorChainView()?.entries.length === state.floorChain?.entries.length);

// 待決抉擇也要能存回來
reset();
state.pendingChainEvent = {
  chainId: CHAIN_DEFS[0].id,
  stage: 3,
  id: "test_pending",
  title: "測試待決",
  description: "測試用",
  participantIds: [ids[0]],
  choices: [{ id: "a", label: "選項甲", hint: "無" }],
};
save();
state.pendingChainEvent = null;
load();
check("存檔往返:待決章節抉擇保留", state.pendingChainEvent?.id === "test_pending" && state.pendingChainEvent?.stage === 3);
state.pendingChainEvent = null;

// --- 7. 零 RNG + 決定性(同輸入必得同輸出)------------------------------------
function runTranscript(): string {
  reset();
  const texts: string[] = [];
  let d = CHAIN_FIRST_DAY;
  let n = 0;
  setDay(d);
  allPresent();
  floorChainPass();
  while (!state.floorChain?.done && n++ < 20) {
    d += STAGE_DAYS;
    setDay(d);
    allPresent();
    floorChainPass();
    if (state.pendingChainEvent) resolveChainEvent(state.pendingChainEvent.choices[0].id);
  }
  texts.push(state.floorChain!.chainId);
  for (const e of state.floorChain!.entries) texts.push(`${e.stage}|${e.title}|${e.text}`);
  for (const id of ids) texts.push(...state.runtimes[id].log.map((l) => l.text));
  return texts.join("\n");
}

const callsBefore = randomCalls;
const runA = runTranscript();
const rngUsed = randomCalls - callsBefore;
check("零 RNG:整條鏈推進不呼叫 Math.random", rngUsed === 0, `實際呼叫 ${rngUsed} 次`);
const runB = runTranscript();
check("決定性:同輸入兩次跑出完全相同的章節與文案", runA === runB);
check("決定性:文案有實際內容(非空轉)", runA.split("\n").length > 6);

// --- 8. 優雅降級:沒人在場時仍推進、不炸 ---------------------------------------
reset();
setDay(CHAIN_FIRST_DAY);
for (const rt of Object.values(state.runtimes)) rt.tenant.visualState = "away";
const okEmpty = floorChainPass();
check("降級:全員外出時仍能開章(只留全樓公告)", okEmpty === true && state.floorChain?.entries.length === 1);
check("降級:沒有人在場就不掛抉擇給空名單", state.pendingChainEvent === null || state.pendingChainEvent.participantIds.length > 0);
allPresent();

// --- 9. 內容規則:三條鏈都是 4 話、抉擇不含驅逐 --------------------------------
check("內容:共三條鏈", CHAIN_DEFS.length === 3);
check("內容:每條鏈都是 4 話", CHAIN_DEFS.every((d) => d.stages.length === 4));
check("內容:每條鏈剛好一個關鍵抉擇", CHAIN_DEFS.every((d) => d.stages.filter((s) => s.decision).length === 1));
const allChoiceText = CHAIN_DEFS.flatMap((d) => d.stages.flatMap((s) => (s.decision?.choices ?? []).map((c) => `${c.label}${c.hint}`))).join("");
check("內容:抉擇不含驅逐/強制搬離", !/驅逐|趕走|強制搬離|請他搬走/.test(allChoiceText));
check("內容:每條鏈都有伏筆旗標且為純中文", CHAIN_DEFS.every((d) => d.stages.some((s) => s.flag && !/[A-Za-z]/.test(s.flag))));

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
