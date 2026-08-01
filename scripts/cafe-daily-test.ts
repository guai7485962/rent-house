/**
 * CAFE-13:咖啡廳日結 pass 與客流公式。
 *
 * 硬把關四件事:
 * 1. **未開張時 pass 完全不動任何狀態**(money / ledger / state.cafe / 全樓日誌)——
 *    這條直接對應 `scripts/balance-snapshot.json` 的零漂移。
 * 2. **零 RNG**:日結期間覆寫 `Math.random` 計數必須是 0。
 * 3. **數值目標**(設計文件 §5.1):成熟期日淨利 ≈ 日租金的 30–50%,而且是**實算**的,
 *    日租金直接從種子局兩位租客的月租推出來,不寫死。
 * 4. **日誌前綴不在 `narration.ts` 的過濾字元類內**——咖啡廳日結是第一手世界事件,
 *    進得了 AI 素材才算接對(前例:`outing.ts` 的 🏪 巧遇)。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, GAME_START, CAFE_HISTORY_CAP } = await import("../src/sim/gameState");
const { cafeDailyPass } = await import("../src/sim/tick");
const {
  cafeCapability, cafeCrowd, cafeDailyLine, cafeTicketPrice, suggestedStandingOrders,
  CAFE_BASE_CAPACITY, CAFE_BASE_TICKET, CAFE_CROWD_PER_SIGN_LEVEL, CAFE_FIXED_COST,
  CAFE_LOG_PREFIX, CAFE_POPULARITY_MAX, CAFE_UPGRADE_IDS, CAFE_WEEKDAY_MULTIPLIER,
  nextCafePopularity,
} = await import("../src/sim/cafe");
const { weatherForDay } = await import("../src/sim/weather");
const { weekdayOf } = await import("../src/sim/week");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return originalRandom(); };
/** 只計數這段區間內的 Math.random 呼叫(載入/存檔另有既有的隨機路徑,不在觀察範圍) */
function countRandom(fn: () => void): number {
  const before = randomCalls;
  fn();
  return randomCalls - before;
}

const DAY_MS = 24 * 3600 * 1000;
const here = dirname(fileURLToPath(import.meta.url));
const setDay = (day: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS; };
const setCafe = (patch: Partial<typeof state.cafe>) => Object.assign(state.cafe, defaultCafe(), patch);
const hosts = () => Object.values(state.runtimes).sort((a, b) => a.tenant.id.localeCompare(b.tenant.id));
const hostLog = () => hosts()[0].log;
const allLogLengths = () => hosts().map((rt) => rt.log.length).join("|");
const worldSnapshot = () => JSON.stringify({
  money: state.money,
  ledger: state.ledger,
  cafe: state.cafe,
  logs: allLogLengths(),
  notices: state.noticeLog.length,
});
/** 跑 n 個遊戲日的日結(每天一次,day 從 from 起算) */
function runDays(from: number, n: number) {
  for (let day = from; day < from + n; day++) {
    setDay(day);
    cafeDailyPass();
  }
}

try {
  // =========================================================================
  // 一、🔴 未開張時完全不動任何狀態(零漂移)
  // =========================================================================
  setDay(0);
  state.money = 52000;
  state.ledger.splice(0, state.ledger.length);
  // 刻意塞滿內容:就算存檔裡已經有常備訂單、庫存、人氣與歷史,只要沒開張就一律不動
  setCafe({
    open: false,
    standingOrders: suggestedStandingOrders(),
    stock: { coffee_bean: 20, milk: 15, flour: 10, butter: 8, cat_can: 8, pet_fresh: 6 },
    popularity: 42,
    history: [{ day: -1, guests: 9, revenue: 1, cost: 2, net: -1 }],
  });
  const closedBefore = worldSnapshot();
  const closedRandom = countRandom(() => runDays(0, 30));
  check("未開張:連跑 30 個遊戲日,money / ledger / state.cafe / 全樓日誌逐欄不變",
    worldSnapshot() === closedBefore);
  check("未開張:money 一元未動", state.money === 52000, String(state.money));
  check("未開張:ledger 一筆未增", state.ledger.length === 0, String(state.ledger.length));
  check("未開張:history 一筆未增", state.cafe.history.length === 1);
  check("未開張:popularity 未動", state.cafe.popularity === 42);
  check("未開張:庫存未被消耗也未被損耗", state.cafe.stock.milk === 15 && state.cafe.stock.coffee_bean === 20);
  check("未開張:零 Math.random", closedRandom === 0, `calls=${closedRandom}`);

  // =========================================================================
  // 二、🔴 零 RNG(開張後也一樣)
  // =========================================================================
  const openStock = () => ({ coffee_bean: 20, milk: 15, flour: 10, butter: 8, cat_can: 8, pet_fresh: 6 });
  setDay(0);
  state.money = 200000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock() });
  const openRandom = countRandom(() => runDays(0, 30));
  check("開張後連跑 30 個遊戲日,日結期間零 Math.random", openRandom === 0, `calls=${openRandom}`);
  check("開張後確實有動到錢(否則上一條是假通過)", state.ledger.length > 0);
  check("ledger 全部記在 cafe 分類", state.ledger.every((t) => t.category === "cafe"));
  check("ledger 標籤涵蓋營收/進貨/固定開銷",
    ["咖啡廳營收", "咖啡廳進貨", "咖啡廳固定開銷"].every((label) => state.ledger.some((t) => t.label === label)));

  // =========================================================================
  // 三、決定性:同一天同一狀態連跑兩次結果完全相同
  // =========================================================================
  const runOnceFrom = (day: number) => {
    state.money = 200000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock(), popularity: 30 });
    const logBefore = hostLog().length;
    setDay(day);
    cafeDailyPass();
    return JSON.stringify({
      money: state.money,
      ledger: state.ledger.map((t) => ({ label: t.label, amount: t.amount, category: t.category })),
      cafe: state.cafe,
      newLogs: hostLog().slice(logBefore).map((e) => e.text),
    });
  };
  check("同一天同一狀態連跑兩次結果逐欄完全相同", runOnceFrom(11) === runOnceFrom(11));
  check("不同天結果不同(否則上一條是假通過)", runOnceFrom(11) !== runOnceFrom(12));

  // =========================================================================
  // 四、天氣與星期確實影響客流
  // =========================================================================
  const crowdOf = (weather: Parameters<typeof cafeCrowd>[0]["weather"], weekday: number) =>
    cafeCrowd({ weather, weekday, signLevel: 1, capacity: 9999, popularity: 0 }).guests;
  check("晴天客流 > 陰天 > 雨天", crowdOf("sunny", 3) > crowdOf("cloudy", 3) && crowdOf("cloudy", 3) > crowdOf("rainy", 3),
    `${crowdOf("sunny", 3)}/${crowdOf("cloudy", 3)}/${crowdOf("rainy", 3)}`);
  check("悶熱高於陰天(躲進有冷氣的店裡是加分)", crowdOf("sweltering", 3) > crowdOf("cloudy", 3));
  check("週末客流 > 週五 > 平日", crowdOf("cloudy", 6) > crowdOf("cloudy", 5) && crowdOf("cloudy", 5) > crowdOf("cloudy", 3));
  check("星期係數七日平均落在 1.00 ± 0.05",
    Math.abs(CAFE_WEEKDAY_MULTIPLIER.reduce((a, b) => a + b, 0) / 7 - 1) <= 0.05);
  check("天氣係數依 weatherForDay 分佈(晴40/陰25/雨25/悶熱10)加權後平均落在 1.00 ± 0.05", (() => {
    let sum = 0;
    for (let day = 0; day < 4000; day++) sum += crowdOf(weatherForDay(day), 3) / crowdOf("cloudy", 3);
    return Math.abs(sum / 4000 - 1) <= 0.05;
  })());
  check("產能上限確實夾住基礎客流",
    cafeCrowd({ weather: "sunny", weekday: 6, signLevel: 4, capacity: 12, popularity: 100 }).guests === 12);
  check("被夾到時 cappedByCapacity 為 true",
    cafeCrowd({ weather: "sunny", weekday: 6, signLevel: 4, capacity: 12, popularity: 100 }).cappedByCapacity === true);
  check("沒被夾到時 cappedByCapacity 為 false",
    cafeCrowd({ weather: "rainy", weekday: 1, signLevel: 1, capacity: 9999, popularity: 0 }).cappedByCapacity === false);
  check("招牌等級線性放大基礎客流",
    cafeCrowd({ weather: "cloudy", weekday: 3, signLevel: 2, capacity: 9999, popularity: 0 }).base
    === 2 * cafeCrowd({ weather: "cloudy", weekday: 3, signLevel: 1, capacity: 9999, popularity: 0 }).base);
  check("人氣 100 對基礎客流加成 25%",
    cafeCrowd({ weather: "cloudy", weekday: 3, signLevel: 1, capacity: 9999, popularity: 100 }).popularityMultiplier === 1.25);
  check("壞資料(NaN 天氣/星期/人氣)不會產生 NaN 客流", (() => {
    const r = cafeCrowd({ weather: "not_a_weather" as any, weekday: NaN, signLevel: NaN, capacity: NaN, popularity: NaN });
    return Number.isFinite(r.base) && Number.isFinite(r.guests) && r.guests >= 0;
  })());
  // 端到端:換一天天氣不同 → history 的客流不同
  const sunnyDay = Array.from({ length: 400 }, (_, i) => i).find((d) => weatherForDay(d) === "sunny" && weekdayOf(GAME_START.getTime() + d * DAY_MS) === 3)!;
  const rainyDay = Array.from({ length: 400 }, (_, i) => i).find((d) => weatherForDay(d) === "rainy" && weekdayOf(GAME_START.getTime() + d * DAY_MS) === 3)!;
  const guestsOnDay = (day: number) => {
    state.money = 200000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock() });
    setDay(day);
    cafeDailyPass();
    return state.cafe.history[state.cafe.history.length - 1].guests;
  };
  check("端到端:同為週三,晴天的實際客流高於雨天",
    guestsOnDay(sunnyDay) > guestsOnDay(rainyDay), `sunny=${guestsOnDay(sunnyDay)} rainy=${guestsOnDay(rainyDay)}`);

  // =========================================================================
  // 五、客單價與人氣
  // =========================================================================
  check("客單價 = 基礎價(研發加成留給 CAFE-16,現在恆為 0)", cafeTicketPrice([]) === CAFE_BASE_TICKET);
  check("未知研發 id 不會改變客單價", cafeTicketPrice(["research_not_yet_designed"]) === CAFE_BASE_TICKET);
  check("順利的一天人氣上升", nextCafePopularity(10, { shortages: 0, underfunded: false }) > 10);
  check("缺貨的一天人氣下降", nextCafePopularity(10, { shortages: 1, underfunded: false }) < 10);
  check("只是補不滿也會小跌", nextCafePopularity(10, { shortages: 0, underfunded: true }) < 10);
  check("人氣夾在 0~100", nextCafePopularity(0, { shortages: 3, underfunded: true }) === 0
    && nextCafePopularity(CAFE_POPULARITY_MAX, { shortages: 0, underfunded: false }) === CAFE_POPULARITY_MAX);
  check("人氣壞資料回退為 0 不產生 NaN", Number.isFinite(nextCafePopularity(NaN as any, { shortages: NaN as any, underfunded: false })));

  // =========================================================================
  // 六、🔴 錢不夠時不會變負(addMoney 的下限 0 不被誤用)
  // =========================================================================
  setDay(0);
  state.money = 0;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: {} });
  let everNegative = false;
  let everNaN = false;
  let stockEverNegative = false;
  for (let day = 0; day < 20; day++) {
    setDay(day);
    cafeDailyPass();
    if (state.money < 0) everNegative = true;
    if (!Number.isFinite(state.money)) everNaN = true;
    if (Object.values(state.cafe.stock).some((n) => n < 0)) stockEverNegative = true;
  }
  check("身無分文開店 20 天,money 從未變負", !everNegative, String(state.money));
  check("身無分文開店 20 天,money 從未變成 NaN", !everNaN);
  check("身無分文開店 20 天,庫存從未變負", !stockEverNegative);
  check("零收入零庫存時 money 停在 0(固定成本被 addMoney 夾住,不記帳也不欠債)", state.money === 0);
  check("history 的 cost 是實際扣掉的錢(帳上不夠時不會虛報)",
    state.cafe.history.every((r) => r.cost >= 0 && r.net === r.revenue - r.cost));

  // 稍微有點錢:扣款總額不得超過期初現金 + 當日營收
  setDay(5);
  state.money = 300;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock() });
  const beforeMoney = state.money;
  cafeDailyPass();
  const rec = state.cafe.history[state.cafe.history.length - 1];
  check("錢很少時:扣款總額 <= 期初現金 + 當日營收", rec.cost <= beforeMoney + rec.revenue, JSON.stringify(rec));
  check("錢很少時:money 仍非負", state.money >= 0, String(state.money));
  check("錢很少時:ledger 每一筆金額都與 money 變動對得起來",
    state.ledger.reduce((sum, t) => sum + t.amount, 0) === state.money - beforeMoney);

  // =========================================================================
  // 七、🔴 history cap 60
  // =========================================================================
  setDay(0);
  state.money = 500000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock() });
  runDays(0, 90);
  check(`history cap ${CAFE_HISTORY_CAP} 生效`, state.cafe.history.length === CAFE_HISTORY_CAP, String(state.cafe.history.length));
  check("history 最新在後(最後一筆是第 89 天)", state.cafe.history[state.cafe.history.length - 1].day === 89);
  check("history 被砍掉的是最舊的(第一筆是第 30 天)", state.cafe.history[0].day === 90 - CAFE_HISTORY_CAP);
  check("history 每一筆欄位齊全且為有限數",
    state.cafe.history.every((r) => [r.day, r.guests, r.revenue, r.cost, r.net].every((n) => Number.isFinite(n))));

  // =========================================================================
  // 八、🔴 數值目標:成熟期日淨利 ≈ 日租金的 30–50%(設計文件 §5.1)
  // =========================================================================
  // 日租金直接從種子局兩位租客的月租推,不寫死。
  const dailyRent = hosts().reduce((sum, rt) => sum + Math.round(rt.tenant.finance.monthlyRent / 30), 0);
  const measure = (label: string, upgrades: string[], popularity: number, days = 56) => {
    state.money = 5_000_000;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock(), popularity, upgrades });
    let net = 0;
    let guests = 0;
    let revenue = 0;
    for (let day = 0; day < days; day++) {
      setDay(day);
      const before = state.money;
      cafeDailyPass();
      net += state.money - before;
      const r = state.cafe.history[state.cafe.history.length - 1];
      guests += r.guests;
      revenue += r.revenue;
    }
    const avgNet = net / days;
    console.log(`   · ${label}:平均客流 ${(guests / days).toFixed(1)}、日營收 $${(revenue / days).toFixed(0)}、`
      + `日淨利 $${avgNet.toFixed(0)}(日租金 $${dailyRent} 的 ${((avgNet / dailyRent) * 100).toFixed(1)}%)`);
    return avgNet;
  };
  const matureNet = measure("成熟期(招牌+第二台咖啡機+戶外座位+大型冷藏,人氣滿)", [
    CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.secondMachine, CAFE_UPGRADE_IDS.outdoorSeats, CAFE_UPGRADE_IDS.coldStorage,
  ], CAFE_POPULARITY_MAX);
  const freshNet = measure("剛開張(零投資,人氣 0)", [], 0);
  const ratio = matureNet / dailyRent;
  check(`🔴 成熟期日淨利 $${matureNet.toFixed(0)} 落在日租金 $${dailyRent} 的 30–50%(實測 ${(ratio * 100).toFixed(1)}%)`,
    ratio >= 0.3 && ratio <= 0.5);
  check("咖啡廳不該比收租賺錢:成熟期日淨利 < 日租金", matureNet < dailyRent);
  check("剛開張不是陷阱:零投資也不會日日虧錢", freshNet > 0, `$${freshNet.toFixed(0)}`);
  check("投資有意義:成熟期日淨利明顯高於剛開張", matureNet > freshNet * 2);

  // 能力表本身
  check("零投資時招牌 1 級、產能為預設值",
    cafeCapability([]).signLevel === 1 && cafeCapability([]).capacity === CAFE_BASE_CAPACITY);
  check("招牌讓基礎客流翻倍(等級 1 → 2)", cafeCapability([CAFE_UPGRADE_IDS.signboard]).signLevel === 2);
  check("第二台咖啡機提高產能上限", cafeCapability([CAFE_UPGRADE_IDS.secondMachine]).capacity > CAFE_BASE_CAPACITY);
  check("大型冷藏放寬損耗參數", (() => {
    const s = cafeCapability([CAFE_UPGRADE_IDS.coldStorage]).spoilage;
    return (s.freeUnits ?? 0) > 0 && (s.rate ?? 1) < 0.1;
  })());
  check("戶外座位只在晴天生效", (() => {
    const withSeats = (w: Parameters<typeof cafeCrowd>[0]["weather"]) =>
      cafeCrowd({ weather: w, weekday: 3, signLevel: 1, capacity: 9999, popularity: 0, outdoorSeats: true }).base;
    const without = (w: Parameters<typeof cafeCrowd>[0]["weather"]) =>
      cafeCrowd({ weather: w, weekday: 3, signLevel: 1, capacity: 9999, popularity: 0 }).base;
    return withSeats("sunny") > without("sunny") && withSeats("rainy") === without("rainy");
  })());
  check("未知投資 id 不產生任何效果",
    JSON.stringify(cafeCapability(["not_an_upgrade"])) === JSON.stringify(cafeCapability([])));
  check("預設常備量搭配成熟期客流不會缺貨也不會損耗(照設計文件玩就順)", (() => {
    state.money = 5_000_000;
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: openStock(), popularity: CAFE_POPULARITY_MAX,
      upgrades: [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.secondMachine],
    });
    let clean = true;
    const logBefore = hostLog().length;
    runDays(0, 56);
    if (hostLog().length !== logBefore) clean = false; // 一則日誌都不該推
    return clean;
  })());

  // =========================================================================
  // 九、🔴 三個旗標各自推出對應日誌
  // =========================================================================
  const runAndCollectLogs = (patch: Partial<typeof state.cafe>, day: number, money = 200000) => {
    state.money = money;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, ...patch });
    const before = hostLog().length;
    setDay(day);
    cafeDailyPass();
    return hostLog().slice(before).map((e) => e.text);
  };

  // 缺貨:庫存有一點但不夠今天的需求
  const shortageLogs = runAndCollectLogs(
    { standingOrders: suggestedStandingOrders(), stock: { coffee_bean: 2, milk: 15, flour: 10, butter: 8, cat_can: 8, pet_fresh: 6 } },
    21,
  );
  check("缺貨 → 推一則日誌", shortageLogs.length === 1, JSON.stringify(shortageLogs));
  check("缺貨日誌就是 cafeDailyLine 的 shortage 句",
    shortageLogs[0] === cafeDailyLine({ kind: "shortage", day: 21, subject: "咖啡豆" }), shortageLogs[0]);
  check("缺貨日誌帶咖啡廳前綴", shortageLogs[0]?.startsWith(CAFE_LOG_PREFIX) === true);

  // 補不滿:庫存夠今天賣(不缺貨),但常備量設得遠超過買得起的錢
  const hugeOrders = Object.fromEntries(Object.keys(suggestedStandingOrders()).map((id) => [id, 5000]));
  const underLogs = runAndCollectLogs(
    { standingOrders: hugeOrders, stock: { coffee_bean: 60, milk: 60, flour: 60, butter: 60, cat_can: 60, pet_fresh: 60 } },
    22,
    3000,
  );
  check("補不滿 → 推一則日誌", underLogs.length === 1, JSON.stringify(underLogs));
  check("補不滿日誌是 underfunded 句(含「成」的措辭)", /成/.test(underLogs[0] ?? ""), underLogs[0]);
  check("補不滿日誌帶咖啡廳前綴", underLogs[0]?.startsWith(CAFE_LOG_PREFIX) === true);

  // 損耗:生鮮囤到遠高於免損耗額度,且不缺貨、不補貨
  const spoilLogs = runAndCollectLogs(
    { standingOrders: {}, stock: { coffee_bean: 60, milk: 100, flour: 60, butter: 60, cat_can: 60, pet_fresh: 60 } },
    23,
  );
  check("損耗 → 推一則日誌", spoilLogs.length === 1, JSON.stringify(spoilLogs));
  check("損耗日誌是 spoilage 句(提到過期/壞)", /過期|壞/.test(spoilLogs[0] ?? ""), spoilLogs[0]);
  check("損耗日誌帶咖啡廳前綴", spoilLogs[0]?.startsWith(CAFE_LOG_PREFIX) === true);

  // 平順的一天一則都不推
  const quietLogs = runAndCollectLogs({ standingOrders: suggestedStandingOrders(), stock: openStock() }, 24);
  check("平順的一天不推日誌(稀疏哲學:日結每天都跑,天天推會淹掉動態頁)", quietLogs.length === 0, JSON.stringify(quietLogs));

  // 三個旗標同時成立時仍然只推一則,且優先講缺貨
  const allThreeLogs = runAndCollectLogs(
    { standingOrders: hugeOrders, stock: { coffee_bean: 1, milk: 100, flour: 1, butter: 60, cat_can: 1, pet_fresh: 60 } },
    25,
    500,
  );
  check("三個旗標同時成立時仍然一天只推一則", allThreeLogs.length === 1, JSON.stringify(allThreeLogs));
  check("三個旗標同時成立時優先講缺貨(玩家最該知道的先講)",
    allThreeLogs[0] === cafeDailyLine({ kind: "shortage", day: 25, subject: "咖啡豆" }), allThreeLogs[0]);

  // 文案本身
  check("cafeDailyLine 決定性:同輸入永遠同一句",
    cafeDailyLine({ kind: "shortage", day: 7, subject: "牛奶" }) === cafeDailyLine({ kind: "shortage", day: 7, subject: "牛奶" }));
  check("cafeDailyLine 換天會換句(句池真的有在輪)", (() => {
    const set = new Set(Array.from({ length: 40 }, (_, d) => cafeDailyLine({ kind: "spoilage", day: d, subject: "奶油" })));
    return set.size >= 3;
  })());
  check("cafeDailyLine 三種 kind 都會把原料名寫進句子", (["shortage", "underfunded", "spoilage"] as const)
    .every((kind) => cafeDailyLine({ kind, day: 3, subject: "寵物鮮食", fulfillment: 0.4 }).includes("寵物鮮食")));
  check("cafeDailyLine 的補不滿比例夾在 1~9 成(0 成/10 成都不成句)",
    !cafeDailyLine({ kind: "underfunded", day: 1, subject: "牛奶", fulfillment: 0 }).includes("0成")
    && !cafeDailyLine({ kind: "underfunded", day: 1, subject: "牛奶", fulfillment: 1 }).includes("10成"));
  check("cafeDailyLine 空的原料名不會生出破句", cafeDailyLine({ kind: "shortage", day: 1, subject: "  " }).includes("備料"));
  check("cafeDailyLine 期間零 Math.random",
    countRandom(() => { for (let d = 0; d < 200; d++) cafeDailyLine({ kind: "shortage", day: d, subject: "牛奶" }); }) === 0);

  // =========================================================================
  // 十、🔴 日誌前綴要進得了 AI 素材
  // =========================================================================
  const narrationSrc = readFileSync(join(here, "..", "src", "sim", "narration.ts"), "utf8");
  const filterClass = narrationSrc.match(/\/\^\[([^\]]*)\]\/u/)?.[1] ?? "";
  check("找得到 narration.ts 的系統回饋過濾字元類(錨點還在)", filterClass.length > 0, filterClass);
  check("🔴 咖啡廳日誌前綴不在過濾字元類內(日結是第一手世界事件,該進 AI 素材)",
    !filterClass.includes(CAFE_LOG_PREFIX), `class=${filterClass} prefix=${CAFE_LOG_PREFIX}`);
  check("過濾字元類本身一字未動(仍是 🔮🌀🌱💤)", filterClass === "🔮🌀🌱💤", filterClass);
  check("前綴確實是未被使用過的 emoji(全 src 只有 cafe.ts 出現)", (() => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|vue)$/.test(name)) files.push(full);
      }
    };
    walk(join(here, "..", "src"));
    const hit = files.filter((f) => readFileSync(f, "utf8").includes(CAFE_LOG_PREFIX));
    return hit.length === 1 && hit[0].endsWith("cafe.ts");
  })());

  // =========================================================================
  // 十一、接線錨點:掛在 collectRent() 正後方,既有 pass 順序未動
  // =========================================================================
  const tickSrc = readFileSync(join(here, "..", "src", "sim", "tick.ts"), "utf8");
  const tickLines = tickSrc.split("\n");
  const rentLine = tickLines.findIndex((l) => /^\s*collectRent\(\);/.test(l));
  check("tick.ts 換日區塊仍有 collectRent()", rentLine >= 0);
  check("🔴 cafeDailyPass() 就掛在 collectRent() 的正後方(同一帳日)",
    /^\s*cafeDailyPass\(\);/.test(tickLines[rentLine + 1] ?? ""), (tickLines[rentLine + 1] ?? "").trim());
  check("換日區塊的既有 pass 順序未動(收租前後的鄰居仍是 relationshipDailyPass / resetDiaryQuota)",
    /relationshipDailyPass\(\);/.test(tickLines[rentLine - 1] ?? "") && /resetDiaryQuota\(\);/.test(tickLines[rentLine + 2] ?? ""));
  check("日結 pass 只有一個呼叫點(不會被別的 pass 重複呼叫)",
    (tickSrc.match(/^\s*cafeDailyPass\(\);/gm) ?? []).length === 1);
  check("日結 pass 第一行就是未開張閘門",
    /export function cafeDailyPass\(\)\s*\{\s*\n\s*const cafe = state\.cafe;\s*\n\s*if \(!cafe\.open\) return;/.test(tickSrc));

  // TxnCategory 是 additive 的
  const gameStateSrc = readFileSync(join(here, "..", "src", "sim", "gameState.ts"), "utf8");
  const txnLine = gameStateSrc.match(/export type TxnCategory = ([^;]+);/)?.[1] ?? "";
  check("TxnCategory 加了 \"cafe\"", txnLine.includes('"cafe"'), txnLine);
  check("TxnCategory 既有六項一項未刪",
    ["rent", "furniture", "upgrade", "event", "upkeep", "other"].every((c) => txnLine.includes(`"${c}"`)), txnLine);

  // 常數本身的合理性(避免有人日後隨手改壞)
  check("基礎客流 / 產能 / 客單價 / 固定成本都是正數",
    CAFE_CROWD_PER_SIGN_LEVEL > 0 && CAFE_BASE_CAPACITY > 0 && CAFE_BASE_TICKET > 0 && CAFE_FIXED_COST > 0);
  check("招牌 1 級的基礎客流略低於預設產能(只有尖峰日會撞天花板)",
    CAFE_CROWD_PER_SIGN_LEVEL < CAFE_BASE_CAPACITY);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
