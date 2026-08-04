/** CAFE-11：state.cafe schema、存檔往返、顧客生成／離場接線與零漂移護欄。 */
import type { CafeGuest } from "../src/types";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, defaultCafe, sanitizeCafeState, CAFE_HISTORY_CAP, GAME_START } = await import("../src/sim/gameState");
const { SAVE_KEY, SAVE_VERSION, migrateSave, save, load } = await import("../src/sim/persistence");
const { cafeGuestPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR, CAFE_GUEST_LINGER_MS } = await import("../src/sim/tick");
const { CAFE_GUEST_CAP, generateCafeGuest } = await import("../src/sim/cafeGuests");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return originalRandom(); };
/** 只計數這段區間內的 Math.random 呼叫(載入/存檔另有既有的隨機路徑,不在本次觀察範圍) */
function countRandom(fn: () => void): number {
  const before = randomCalls;
  fn();
  return randomCalls - before;
}

// "sales" 是重設計 P1 新增的逐品項銷售紀錄(同批升 SAVE_VERSION 8 → 9)。
const CAFE_KEYS = ["open", "standingOrders", "stock", "research", "completed", "upgrades", "guests", "popularity", "history", "sales"];
const runtimeIds = () => Object.keys(state.runtimes).sort().join("|");
const cafeJson = () => JSON.stringify(state.cafe);
const setCafe = (patch: Partial<typeof state.cafe>) => Object.assign(state.cafe, defaultCafe(), patch);
const hourMs = (day: number, hour: number) => {
  const d = new Date(GAME_START.getTime() + day * 24 * 3600 * 1000);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
/** 從 startMs 起逐小時推進並跑 pass;不碰任何其他 pass。回傳期間出現過的顧客 id。 */
function runHours(startMs: number, hours: number): string[] {
  const seen: string[] = [];
  state.gameMs = startMs;
  for (let i = 0; i < hours; i++) {
    state.gameMs += MS_PER_GAME_HOUR;
    cafeGuestPass(new Date(state.gameMs).getHours());
    for (const guest of state.cafe.guests) if (!seen.includes(guest.id)) seen.push(guest.id);
  }
  return seen;
}
const seatedGuest = (index: number, leavesMs: number): CafeGuest =>
  ({ ...generateCafeGuest({ seed: "fixture", arrivedMs: 0, sequence: index }), leavesMs });

try {
  // --- 1. schema 預設值 ---
  const fresh = defaultCafe();
  check("state.cafe 欄位與設計文件 §8 完全一致", JSON.stringify(Object.keys(state.cafe).sort()) === JSON.stringify([...CAFE_KEYS].sort()), Object.keys(state.cafe).join(","));
  check("新開局的 state.cafe 就是 defaultCafe()", cafeJson() === JSON.stringify(fresh));
  check("預設未開張、無顧客、無研發", state.cafe.open === false && state.cafe.guests.length === 0 && state.cafe.research === null);
  check("預設常備訂單／庫存／完成／設備／日結皆為空", Object.keys(fresh.standingOrders).length === 0 && Object.keys(fresh.stock).length === 0 && fresh.completed.length === 0 && fresh.upgrades.length === 0 && fresh.history.length === 0 && fresh.popularity === 0);
  check("defaultCafe() 每次回傳獨立物件(不共用參考)", defaultCafe().guests !== defaultCafe().guests);
  // 2026-08-03 改寫:原斷言是 `SAVE_VERSION === 6`,用來釘 CAFE-11 的
  // 「`state.cafe` 是 additive 欄位,不該為了加它而升版」。那個意圖仍然成立,
  // 但 v7 是為了**另一件事**才升的 —— 補發咖啡廳開張贈品給「本功能上線前就已開張」
  // 的舊存檔(那些檔的一樓會永遠是空的)。資料補發本來就必須走升級表。
  // 所以這裡改成釘「升版必須伴隨對應的 migration」,而不是把版本號釘死。
  // 刻意**不**斷言 `SAVE_VERSION === <某個數字>`:那種寫法在 2026-08-03 一天內壞了兩次
  // (v6→v7 補發贈品、v7→v8 修補發守衛),每次都只是把數字往上改一格,擋不到任何真正的錯誤。
  // 有價值的是下面這條行為斷言:升版必須伴隨可用的 migration,不能只改數字。
  check("每一個舊版本都升得到 SAVE_VERSION(升版不可只改數字、要有 migration)",
    Array.from({ length: SAVE_VERSION - 2 }, (_, i) => i + 2)
      .every((v) => migrateSave({ v, cafe: { open: false }, placements: [] })?.v === SAVE_VERSION));

  // --- 2. 未開張 = 天然閘門:pass 完全不動任何狀態 ---
  const closedBase = hourMs(0, 0);
  state.gameMs = closedBase;
  const closedCafe = cafeJson();
  const closedRuntimes = runtimeIds();
  const closedMoney = state.money;
  const closedLedger = state.ledger.length;
  const closedRandom = countRandom(() => {
    for (let hour = 0; hour < 24; hour++) cafeGuestPass(hour);
  });
  check("未開張時 cafeGuestPass 不動 state.cafe", cafeJson() === closedCafe);
  check("未開張時 cafeGuestPass 不動 runtimes／money／ledger", runtimeIds() === closedRuntimes && state.money === closedMoney && state.ledger.length === closedLedger);
  check("未開張時 cafeGuestPass 零 Math.random 呼叫", closedRandom === 0, `calls=${closedRandom}`);

  // --- 3. 開張後的生成:零 RNG、決定性、營業時段 ---
  setCafe({ open: true });
  const openBase = hourMs(1, 0);
  const runtimesBeforeOpen = runtimeIds();
  const openRandom = countRandom(() => runHours(openBase, 72));
  check("開張後跑 72 小時仍零 Math.random 呼叫", openRandom === 0, `calls=${openRandom}`);
  check("state.runtimes 零污染:key 集合完全相同", runtimeIds() === runtimesBeforeOpen, runtimeIds());
  check("顧客不會被塞進 state.runtimes", !Object.keys(state.runtimes).some((id) => id.startsWith("cafe_guest_")));

  setCafe({ open: true });
  const firstSeen = runHours(openBase, 72);
  const firstRun = JSON.stringify(state.cafe.guests);
  setCafe({ open: true });
  const secondSeen = runHours(openBase, 72);
  check("同一起點跑兩次得到逐欄相同的顧客", JSON.stringify(state.cafe.guests) === firstRun && firstSeen.join("|") === secondSeen.join("|"));
  check("跑完 72 小時確實來過多位客人(顧客系統真的有接上)", firstSeen.length >= 10, `seen=${firstSeen.length}`);

  const producingHours: number[] = [];
  for (let hour = 0; hour < 24; hour++) {
    setCafe({ open: true });
    state.gameMs = hourMs(2, hour);
    cafeGuestPass(hour);
    if (state.cafe.guests.length > 0) producingHours.push(hour);
  }
  check("只有營業時段會來客", producingHours.every((hour) => hour >= CAFE_OPEN_HOUR && hour <= CAFE_CLOSE_HOUR), `hours=${producingHours.join(",")}`);
  check("營業時段內確實有來客的小時", producingHours.length > 0);

  // --- 4. 上限與離場 ---
  const farFuture = hourMs(9, 12);
  setCafe({ open: true, guests: Array.from({ length: CAFE_GUEST_CAP }, (_, i) => seatedGuest(i, farFuture)) });
  const fullIds = state.cafe.guests.map((g) => g.id).join("|");
  runHours(hourMs(3, 9), 12);
  check("滿座時不再新增顧客(cap = CAFE_GUEST_CAP)", state.cafe.guests.length === CAFE_GUEST_CAP && state.cafe.guests.map((g) => g.id).join("|") === fullIds, `len=${state.cafe.guests.length}`);

  const leaveBase = hourMs(4, 12);
  const leaving = seatedGuest(0, leaveBase + MS_PER_GAME_HOUR);
  const staying = seatedGuest(1, leaveBase + 8 * MS_PER_GAME_HOUR);
  setCafe({ open: true, guests: [leaving, staying] });
  // 寬限期內先交給 FloorMap 演「走回門口」,資料層不搶著清掉(設計文件 §6.2:不原地消失)
  state.gameMs = leaveBase + MS_PER_GAME_HOUR + CAFE_GUEST_LINGER_MS - 1;
  cafeGuestPass(new Date(state.gameMs).getHours());
  check("到點顧客在寬限期內先留著給畫面演離場", state.cafe.guests.some((g) => g.id === leaving.id), `linger=${CAFE_GUEST_LINGER_MS}`);
  // 超過寬限期(或沒人打開 1F 頁面)才由資料層的保險絲收乾淨
  state.gameMs = leaveBase + MS_PER_GAME_HOUR + CAFE_GUEST_LINGER_MS + 1;
  cafeGuestPass(new Date(state.gameMs).getHours());
  check("超過寬限期的顧客被移出 state.cafe.guests、不殘留", !state.cafe.guests.some((g) => g.id === leaving.id));
  check("未到點顧客仍留在店裡", state.cafe.guests.some((g) => g.id === staying.id) && state.cafe.guests.every((g) => g.leavesMs > state.gameMs));

  setCafe({ open: true });
  runHours(hourMs(5, 8), 48);
  check("長跑後店裡不會有超過寬限期的顧客", state.cafe.guests.every((g) => g.leavesMs > state.gameMs - CAFE_GUEST_LINGER_MS));
  check("長跑後顧客數永遠不超過 cap", state.cafe.guests.length <= CAFE_GUEST_CAP, `len=${state.cafe.guests.length}`);
  check("同時在店的顧客 id 不重複", new Set(state.cafe.guests.map((g) => g.id)).size === state.cafe.guests.length);

  // --- 5. 存檔往返 ---
  const saveBase = hourMs(6, 12);
  state.gameMs = saveBase;
  const keptGuest = seatedGuest(0, saveBase + 3 * MS_PER_GAME_HOUR);
  setCafe({
    open: true,
    guests: [keptGuest],
    popularity: 12,
    standingOrders: { beans: 4 },
    stock: { beans: 2 },
    upgrades: ["cafe_espresso"],
    completed: ["research_latte"],
    research: { id: "research_mocha", startedDay: 3, days: 5, invested: 900 },
    history: [{ day: 3, guests: 5, revenue: 1200, cost: 400, net: 800 }],
  });
  save();
  const raw = JSON.parse(mem[SAVE_KEY]);
  check("存檔含 cafe 這個 top-level key", raw.cafe !== undefined && typeof raw.cafe === "object");
  // 2026-08-03:同上,版本已因「補發咖啡廳開張贈品」的 migration 升到 7。
  // 這條的真正意圖是「存檔一定寫入當前版本」,所以改成跟著 SAVE_VERSION 走,
  // 不要再寫死數字(寫死的話每次升版都要來改一次,而且改的人未必懂原意)。
  check("存檔寫入當前 SAVE_VERSION", raw.v === SAVE_VERSION, `v=${raw.v}`);
  check("guests 有寫進存檔", Array.isArray(raw.cafe.guests) && raw.cafe.guests.length === 1);

  setCafe({});
  check("載入前先把記憶體中的 cafe 清空", state.cafe.open === false && state.cafe.guests.length === 0);
  check("載入舊檔回傳成功", load() === true);
  check("往返後非顧客欄位逐欄還原", state.cafe.open === true && state.cafe.popularity === 12 && state.cafe.standingOrders.beans === 4 && state.cafe.stock.beans === 2 && state.cafe.upgrades.join() === "cafe_espresso" && state.cafe.completed.join() === "research_latte" && state.cafe.research?.id === "research_mocha" && state.cafe.history.length === 1);
  check("未到點的顧客往返後仍在店裡", state.cafe.guests.length === 1 && state.cafe.guests[0].id === keptGuest.id);
  check("往返後 state.runtimes 沒有多出顧客", !Object.keys(state.runtimes).some((id) => id.startsWith("cafe_guest_")));

  // 離線久了 → 顧客的 leavesMs 已過期,載入當下就被 removeDepartedCafeGuests 濾光
  const stale = JSON.parse(mem[SAVE_KEY]);
  stale.gameMs = saveBase + 12 * MS_PER_GAME_HOUR;
  mem[SAVE_KEY] = JSON.stringify(stale);
  check("離線過久的存檔載入成功", load() === true);
  check("離線過久 → 顧客在載入時就被清空", state.cafe.guests.length === 0, `len=${state.cafe.guests.length}`);
  check("離線清空不影響其他 cafe 欄位", state.cafe.open === true && state.cafe.popularity === 12);
  // 載入當下沒有進行中的離場演出,所以用精確的 gameMs 過濾,不套 pass 的寬限期
  check("載入的過濾不套用畫面寬限期(精確以 gameMs 為準)", sanitizeCafeState({ guests: [seatedGuest(0, saveBase)] }, saveBase + 1).guests.length === 0);

  // --- 6. 舊存檔(完全沒有 cafe 欄位) ---
  const legacy = JSON.parse(mem[SAVE_KEY]);
  delete legacy.cafe;
  mem[SAVE_KEY] = JSON.stringify(legacy);
  setCafe({ open: true, popularity: 99, guests: [seatedGuest(2, Number.MAX_SAFE_INTEGER)] });
  let legacyLoaded = false;
  let threw = "";
  try { legacyLoaded = load(); } catch (e) { threw = String(e); }
  check("舊存檔(無 cafe 欄位)載入不報錯", legacyLoaded === true && threw === "", threw);
  check("舊存檔載入後 state.cafe 為預設值", cafeJson() === JSON.stringify(defaultCafe()), cafeJson());

  // --- 7. sanitizeCafeState 護欄 ---
  check("非物件輸入回退為預設值", JSON.stringify(sanitizeCafeState(null, 0)) === JSON.stringify(defaultCafe()) && JSON.stringify(sanitizeCafeState("x", 0)) === JSON.stringify(defaultCafe()));
  const dirty = sanitizeCafeState({
    open: "yes",
    standingOrders: { beans: "3", milk: 2 },
    stock: 5,
    research: { id: 7 },
    completed: ["ok", 3],
    upgrades: "nope",
    popularity: "high",
    history: Array.from({ length: 80 }, (_, i) => ({ day: i })),
    guests: [
      { id: "bad" },
      { ...seatedGuest(3, 10_000), appearance: { ...seatedGuest(3, 10_000).appearance, hairStyle: "mohawk" } },
      seatedGuest(4, 10_000),
      seatedGuest(4, 10_000),
    ],
  }, 0);
  check("open 只認布林 true", dirty.open === false);
  check("數值字典只留有限數字", dirty.standingOrders.milk === 2 && dirty.standingOrders.beans === undefined && Object.keys(dirty.stock).length === 0);
  check("研發缺 id 視為沒有在研發", dirty.research === null);
  check("字串陣列過濾非字串、非陣列回退為空", dirty.completed.join() === "ok" && dirty.upgrades.length === 0);
  check("popularity 非數字回退為 0", dirty.popularity === 0);
  check(`日結紀錄 cap 為 ${CAFE_HISTORY_CAP}`, dirty.history.length === CAFE_HISTORY_CAP && dirty.history[0].day === 20);
  check("壞顧客與白名單外髮型被丟掉、重複 id 去重", dirty.guests.length === 1 && dirty.guests[0].id === seatedGuest(4, 0).id, dirty.guests.map((g) => g.id).join(","));
  const overflow = sanitizeCafeState({ guests: Array.from({ length: 20 }, (_, i) => seatedGuest(i, 10_000)) }, 0);
  check("載入時顧客也套用 cap", overflow.guests.length === CAFE_GUEST_CAP, `len=${overflow.guests.length}`);
  check("載入時就濾掉已到點的顧客", sanitizeCafeState({ guests: [seatedGuest(0, 100)] }, 100).guests.length === 0);
  const sanitizeRandom = countRandom(() => { sanitizeCafeState({ guests: [seatedGuest(0, 10_000)] }, 0); });
  check("sanitizeCafeState 零 Math.random 呼叫", sanitizeRandom === 0, `calls=${sanitizeRandom}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
