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
const { cafeDailyPass, cafeHourlyPass, cafeRestockPass, hourlyTick, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const {
  cafeCapability, cafeCrowd, cafeDailyLine, cafeTicketPrice, menuItems, suggestedStandingOrders,
  CAFE_BASE_CAPACITY, CAFE_BASE_TICKET, CAFE_CROWD_PER_SIGN_LEVEL, CAFE_FIXED_COST,
  CAFE_LOG_PREFIX, CAFE_POPULARITY_MAX, CAFE_RESEARCH_IDS, CAFE_UPGRADE_IDS, CAFE_WEEKDAY_MULTIPLIER,
  SPOILAGE_FREE_UNITS, SPOILAGE_RATE,
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
/** 🔴 `rt.log` 有 LOG_CAP=60 的上限;不先清空,`slice(before)` 會被截斷成空陣列(假通過)。 */
const clearHostLogs = () => { for (const rt of hosts()) rt.log.splice(0, rt.log.length); };
const allLogLengths = () => hosts().map((rt) => rt.log.length).join("|");
const worldSnapshot = () => JSON.stringify({
  money: state.money,
  ledger: state.ledger,
  cafe: state.cafe,
  logs: allLogLengths(),
  notices: state.noticeLog.length,
});
/**
 * 跑完整的一個營業日:**開店前進貨** + 11 個營業小時的逐位結帳 + 換日日結。
 *
 * 🔴 P1 之後營收是 `cafeHourlyPass()` 逐位顧客收的,只呼叫 `cafeDailyPass()`
 * 量到的會是「只有支出、沒有收入」的半條路徑。
 * 🔴 P3 之後進貨是 `cafeRestockPass()` 在 09:00 扣的,少了它就變成
 * 「有固定開銷、卻永遠沒有原料」的另一條半路徑。
 */
const HOUR_MS = 3600 * 1000;
function runBusinessDay(day: number) {
  state.gameMs = GAME_START.getTime() + day * DAY_MS + (CAFE_OPEN_HOUR - 1) * HOUR_MS;
  cafeRestockPass(CAFE_OPEN_HOUR - 1);
  for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
    state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
    cafeHourlyPass(hour);
  }
  setDay(day);
  cafeDailyPass();
}

/** 跑 n 個完整營業日(day 從 from 起算) */
function runDays(from: number, n: number) {
  for (let day = from; day < from + n; day++) runBusinessDay(day);
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
  check("未開張:連跑 30 個遊戲日(含 330 個營業小時的逐位結帳),money / ledger / state.cafe / 全樓日誌逐欄不變",
    worldSnapshot() === closedBefore);
  check("未開張:銷售紀錄一筆都不會生出來(逐位結帳的閘門)", state.cafe.sales.length === 0);
  check("未開張:money 一元未動", state.money === 52000, String(state.money));
  check("未開張:ledger 一筆未增", state.ledger.length === 0, String(state.ledger.length));
  check("未開張:history 一筆未增", state.cafe.history.length === 1);
  check("未開張:popularity 未動", state.cafe.popularity === 42);
  check("未開張:庫存未被消耗也未被損耗", state.cafe.stock.milk === 15 && state.cafe.stock.coffee_bean === 20);
  check("未開張:零 Math.random", closedRandom === 0, `calls=${closedRandom}`);

  // =========================================================================
  // 二、🔴 零 RNG(開張後也一樣)
  // =========================================================================
  // 開場庫存 = 建議常備量(P1 重訂後配方是整數單位/份,舊的寫死值連半天都撐不到)
  const openStock = () => suggestedStandingOrders();
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
    runBusinessDay(day);
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
    setCafe({ open: true, standingOrders: suggestedStandingOrders(), stock: openStock(), popularity: 50 });
    runBusinessDay(day);
    return state.cafe.history[state.cafe.history.length - 1].guests;
  };
  check("端到端:同為週三,晴天的實際客流高於雨天",
    guestsOnDay(sunnyDay) > guestsOnDay(rainyDay), `sunny=${guestsOnDay(sunnyDay)} rainy=${guestsOnDay(rainyDay)}`);

  // =========================================================================
  // 五、客單價與人氣
  // =========================================================================
  check("沒有完成研發時客單價維持基礎價", cafeTicketPrice([]) === CAFE_BASE_TICKET);
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
    runBusinessDay(day);
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
  runBusinessDay(5);
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
      const before = state.money;
      runBusinessDay(day);
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
    return (s.freeUnits ?? 0) > SPOILAGE_FREE_UNITS && (s.rate ?? SPOILAGE_RATE) < SPOILAGE_RATE;
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
  check("預設常備量搭配成熟期客流不會缺貨也不會損耗(照建議值玩就順)", (() => {
    state.money = 5_000_000;
    setCafe({
      open: true, standingOrders: suggestedStandingOrders(), stock: openStock(), popularity: CAFE_POPULARITY_MAX,
      upgrades: [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.secondMachine],
    });
    clearHostLogs();
    runDays(0, 56);
    // 七日一則的「賣出」日誌是正常營運的證據,允許;缺貨/補不滿/損耗一則都不該有。
    const complaints = hostLog().map((e) => e.text)
      .filter((line) => /沒了|見底|乾乾淨淨|售完|消耗得快|過期|壞了|只叫了|只補得起|最省的量|先少進/.test(line));
    return complaints.length === 0;
  })(), hostLog().map((e) => e.text).slice(0, 3).join(" | "));

  // =========================================================================
  // 九、🔴 各旗標各自推出對應日誌
  //
  // P1 之後缺貨的第一則日誌由 `cafeHourlyPass()` **當下**推出(「有人想點⋯沒了」),
  // 日結只在「整天都在說抱歉」時才補一則收尾摘要。補不滿/損耗仍然由日結負責。
  // 取的天數一律避開 7 的倍數,以免混進七日一則的「賣出」日誌。
  // =========================================================================
  /** 一句話是不是日結的 shortage 收尾摘要(四個句型的共同關鍵字)。 */
  const isShortageSummary = (line: string) => /見底|乾乾淨淨|售完|消耗得快/.test(line);
  const runAndCollectLogs = (patch: Partial<typeof state.cafe>, day: number, money = 200000) => {
    state.money = money;
    state.ledger.splice(0, state.ledger.length);
    setCafe({ open: true, ...patch });
    clearHostLogs();
    runBusinessDay(day);
    return hostLog().map((e) => e.text);
  };

  // 缺貨:咖啡豆只夠做兩杯,其餘品項充足 → 想點咖啡的客人整天撲空
  // 🔴 P3:常備量也要一起壓低——不然 09:00 的進貨會把咖啡豆補回 130,缺不成貨。
  const shortageLogs = runAndCollectLogs(
    {
      standingOrders: { ...suggestedStandingOrders(), coffee_bean: 8 },
      stock: { ...suggestedStandingOrders(), coffee_bean: 8 },
    },
    22,
  );
  check("缺貨 → 當下就推一則「有人想點⋯沒了」的即時日誌",
    shortageLogs.some((line) => /沒了|見底,|用完了|用光/.test(line)), JSON.stringify(shortageLogs));
  check("整天都在說抱歉 → 日結再補一則收尾摘要", shortageLogs.length === 2 && isShortageSummary(shortageLogs[1]),
    JSON.stringify(shortageLogs));
  check("缺貨日誌都帶咖啡廳前綴", shortageLogs.every((line) => line.startsWith(CAFE_LOG_PREFIX)));

  // 補不滿:庫存夠今天賣(不缺貨),但常備量設得遠超過買得起的錢
  const hugeOrders = Object.fromEntries(Object.keys(suggestedStandingOrders()).map((id) => [id, 5000]));
  const plentiful = Object.fromEntries(Object.keys(suggestedStandingOrders()).map((id) => [id, 300]));
  // 🔴 P3:「補不滿」跟著進貨一起搬到 09:00,所以它是**當天的第一則**;
  // 這一局的庫存(300)遠高於免損耗額度,午夜日結會再補一則損耗句,共兩則。
  const underLogs = runAndCollectLogs({ standingOrders: hugeOrders, stock: plentiful }, 23, 3000);
  check("補不滿 → 開店前進貨時就推一則日誌", underLogs.length >= 1, JSON.stringify(underLogs));
  check("補不滿日誌是當天第一則、且是 underfunded 句(含「成」的措辭)",
    /成/.test(underLogs[0] ?? ""), JSON.stringify(underLogs));
  check("補不滿日誌帶咖啡廳前綴", underLogs[0]?.startsWith(CAFE_LOG_PREFIX) === true);

  // 損耗:生鮮囤到遠高於免損耗額度,且不缺貨、不補貨
  const spoilLogs = runAndCollectLogs({ standingOrders: {}, stock: plentiful }, 24);
  check("損耗 → 推一則日誌", spoilLogs.length === 1, JSON.stringify(spoilLogs));
  check("損耗日誌是 spoilage 句(提到過期/壞)", /過期|壞/.test(spoilLogs[0] ?? ""), spoilLogs[0]);
  check("損耗日誌帶咖啡廳前綴", spoilLogs[0]?.startsWith(CAFE_LOG_PREFIX) === true);

  // 平順的一天一則都不推
  const quietLogs = runAndCollectLogs({ standingOrders: suggestedStandingOrders(), stock: openStock() }, 25);
  check("平順的一天不推日誌(稀疏哲學:日結每天都跑,天天推會淹掉動態頁)", quietLogs.length === 0, JSON.stringify(quietLogs));

  // 三個旗標同時成立。🔴 P3 之後這一天的敘事分成兩個時刻:
  //   09:00 進貨補不滿 1 則 → 營業中即時撲空 1 則 → 午夜日結摘要 1 則。
  // 「日結端一天只推一則」這條不變式仍然成立(最後那一則),而且優先講缺貨。
  const allThreeLogs = runAndCollectLogs(
    { standingOrders: hugeOrders, stock: { coffee_bean: 1, milk: 300, flour: 1, butter: 300, cat_can: 1, pet_fresh: 300 } },
    26,
    500,
  );
  check("三個旗標同時成立時,日結端仍然一天只推一則(進貨 1 + 即時撲空 1 + 日結 1)",
    allThreeLogs.length === 3, JSON.stringify(allThreeLogs));
  check("進貨補不滿那一則排在最前面(它發生在開店前)",
    /成/.test(allThreeLogs[0] ?? ""), allThreeLogs[0]);
  check("三個旗標同時成立時日結優先講缺貨(玩家最該知道的先講)",
    isShortageSummary(allThreeLogs[2] ?? ""), allThreeLogs[2]);

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
  // 十一、CAFE-18B:面板關閉時也在日結營收前完成研發
  // =========================================================================
  setDay(10);
  state.money = 200000;
  state.ledger.splice(0, state.ledger.length);
  const noticesBeforeResearch = state.noticeLog.length;
  setCafe({
    open: true,
    standingOrders: suggestedStandingOrders(),
    stock: openStock(),
    completed: [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.pourOver],
    research: {
      id: CAFE_RESEARCH_IDS.latteArt,
      startedDay: 7,
      days: 3,
      invested: 4000,
    },
  });
  check("背景研發測試前置:只有一項第二層時客單仍為 $36", cafeTicketPrice(state.cafe.completed) === 36);
  const dueResearchRandom = countRandom(() => cafeDailyPass());
  const researchDayRecord = state.cafe.history[state.cafe.history.length - 1];
  check("到期研發在沒有 CafePanel 時也會清空 active 並去重加入 completed",
    state.cafe.research === null
      && state.cafe.completed.filter((id) => id === CAFE_RESEARCH_IDS.latteArt).length === 1);
  // P1 之後日結不再算營收,所以「立刻吃到新客單價」的驗收點改成:
  // 研發在**下一個營業小時之前**就已經清進 completed,新品當天就上得了菜單。
  check("研發完成當天新品立刻進菜單(下一個營業小時就點得到)",
    menuItems(state.cafe.completed).some((item) => item.researchId === CAFE_RESEARCH_IDS.latteArt),
    state.cafe.completed.join(","));
  check("研發完成當天的日結仍寫得出 history(營收由逐位結帳供給)",
    Number.isFinite(researchDayRecord.revenue) && researchDayRecord.net === researchDayRecord.revenue - researchDayRecord.cost,
    JSON.stringify(researchDayRecord));
  check("背景完成只新增一則可持久化通知",
    state.noticeLog.length === noticesBeforeResearch + 1
      && state.noticeLog.at(-1)?.text === "🎉 「拿鐵拉花」完成，新品已加入菜單");
  check("背景研發結算維持零 Math.random", dueResearchRandom === 0, `calls=${dueResearchRandom}`);
  const noticesAfterResearch = state.noticeLog.length;
  cafeDailyPass();
  check("同日重跑日結不會重複完成或重複通知", state.noticeLog.length === noticesAfterResearch
    && state.cafe.completed.filter((id) => id === CAFE_RESEARCH_IDS.latteArt).length === 1);

  setDay(12);
  const noticesBeforePending = state.noticeLog.length;
  setCafe({
    open: true,
    standingOrders: suggestedStandingOrders(),
    stock: openStock(),
    research: {
      id: CAFE_RESEARCH_IDS.baking,
      startedDay: 11,
      days: 3,
      invested: 2500,
    },
  });
  cafeDailyPass();
  check("尚未到期的背景研發維持 active 且不通知",
    state.cafe.research?.id === CAFE_RESEARCH_IDS.baking && state.noticeLog.length === noticesBeforePending);

  setDay(20);
  state.gameMs += 60 * 60 * 1000; // GAME_START 22:00 → 當地 23:00；下一個 hourlyTick 跨午夜
  state.money = 200000;
  state.ledger.splice(0, state.ledger.length);
  setCafe({
    open: true,
    standingOrders: suggestedStandingOrders(),
    stock: openStock(),
    completed: [CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.pourOver],
    research: {
      id: CAFE_RESEARCH_IDS.latteArt,
      startedDay: 17,
      days: 3,
      invested: 4000,
    },
  });
  const completionText = "🎉 「拿鐵拉花」完成，新品已加入菜單";
  const completionNoticesBefore = state.noticeLog.filter((entry) => entry.text === completionText).length;
  hourlyTick(false);
  const midnightRecord = state.cafe.history.at(-1);
  check("真正從 23:00 hourlyTick 跨午夜時會在面板未載入狀態完成研發",
    new Date(state.gameMs).getHours() === 0 && state.cafe.research === null
      && state.cafe.completed.filter((id) => id === CAFE_RESEARCH_IDS.latteArt).length === 1);
  check("hourlyTick 背景完成也只留一則完成通知",
    state.noticeLog.filter((entry) => entry.text === completionText).length === completionNoticesBefore + 1);
  check("hourlyTick 跨午夜也寫得出一筆自洽的 history",
    !!midnightRecord && midnightRecord.net === midnightRecord.revenue - midnightRecord.cost,
    midnightRecord ? JSON.stringify(midnightRecord) : "no record");

  // =========================================================================
  // 十二、接線錨點:掛在 collectRent() 正後方,既有 pass 順序未動
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
  const dailyPassLine = tickLines.findIndex((l) => /^export function cafeDailyPass\(\)/.test(l));
  const researchAdvanceLine = tickLines.findIndex((l, index) => index > dailyPassLine && /advanceCafeResearch\(cafe, day\)/.test(l));
  const settleLine = tickLines.findIndex((l, index) => index > dailyPassLine && /settleCafeSales\(\)/.test(l));
  check("🔴 背景研發結算位於當日成績結算／進貨之前",
    dailyPassLine >= 0 && researchAdvanceLine > dailyPassLine && settleLine > researchAdvanceLine,
    `daily=${dailyPassLine} research=${researchAdvanceLine} settle=${settleLine}`);
  // 🔴 P1 的主張:營收不再由日結算,而是逐位顧客當場收的。
  check("🔴 cafeDailyPass 不再自己算營收(營收 = Σ 顧客實際點到的商品售價)",
    !/const revenue = served \* cafeTicketPrice/.test(tickSrc));
  check("🔴 cafeHourlyPass() 掛在 cafeGuestPass() 的正後方",
    (() => {
      const guestLine = tickLines.findIndex((l) => /^\s*cafeGuestPass\(hour\);/.test(l));
      return guestLine >= 0 && /^\s*cafeHourlyPass\(hour\);/.test(tickLines[guestLine + 1] ?? "");
    })(), (tickLines[tickLines.findIndex((l) => /^\s*cafeGuestPass\(hour\);/.test(l)) + 1] ?? "").trim());
  check("🔴 逐位結帳 pass 第一行也是未開張閘門",
    /export function cafeHourlyPass\(hour: number\)\s*\{\s*\n\s*const cafe = state\.cafe;\s*\n\s*if \(!cafe\.open\) return;/.test(tickSrc));

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
