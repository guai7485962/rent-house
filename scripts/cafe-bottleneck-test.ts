/**
 * 🔴 可見性批次(2026-08-25):**讓玩家看得見「想上門 vs 做得出來」的落差**。
 *
 * ## 這一批要證明什麼
 *
 * 使用者實玩回報「投資與研發都沒有效果、家具可有可無」。唯讀調查用公式算出他的店
 * 被**服務位 = 1** 卡死(產能 36 單/日),而想上門的人有 66~100 位 ⇒
 * 三級招牌 + 戶外座位($225,000)的邊際效益在數學上是**精確的 0**、
 * 氛圍超出 60 點上限的 31 點也是 0,而每天約 64 位客人在資料層無聲蒸發
 * (放棄門檻是每小時 8 人,他只溢出 5.8 ⇒ 畫面上一位「排到放棄」都不會演)。
 *
 * **本批是純可見性,預期零平衡漂移。** 七段把關:
 * 1. `cafeTypicalBase()` 的表與氛圍上限
 * 2. `cafeBottleneck()` 五個 kind 全覆蓋 + 恆等式
 * 3. `cafeInvestOutlook()` 的核心不變式(那個「精確 0」要被釘死)
 * 4. 界線與決定性(零 RNG、`cafe.ts` 純函式界線未破)
 * 5. `turnedAway` 的累加正確性(接真的 tick:Σ 11 小時、⊇ abandoned、線上 = 離線)
 * 6. 兩個 SFC 的合約掃描(文案來自函式、氛圍判定只有一份)
 * 7. 🔴 **兩式一致性**:`cafeTypicalBase()` vs `cafeCrowd()`,以及寵物停留時刻的鏡像
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");

const { state, defaultCafe, GAME_START, sanitizeCafeState } = await import("../src/sim/gameState");
const { cafeHourlyPass, hourlyTick, syncToNow, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const {
  applySpoilage, cafeAmbianceFull, cafeAmbianceMultiplier, cafeBottleneck, cafeBottleneckAdvice,
  cafeCapability, cafeCrowd, cafeDailyLine, cafeHourlyGuestCount, cafeInvestOutlook, cafePetStayEndHour,
  cafeStaffCount, cafeTypicalBase,
  CAFE_AMBIANCE_FULL_POINTS, CAFE_AMBIANCE_SWING, CAFE_BUSINESS_HOURS, CAFE_CROWD_PER_SIGN_LEVEL,
  CAFE_MACHINE_CUPS_BONUS, CAFE_OUTDOOR_SUNNY_BONUS, CAFE_POPULARITY_MAX, CAFE_POPULARITY_SWING,
  CAFE_SEAT_TURNOVER, CAFE_STAFF_CUPS_PER_DAY, CAFE_STAFF_WAGE, CAFE_TAKEAWAY_CAPACITY, CAFE_TYPICAL_WEATHER,
  CAFE_UPGRADE_IDS, CAFE_WEATHER_MULTIPLIER, CAFE_WEEKDAY_MULTIPLIER, SPOILAGE_FREE_UNITS,
} = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");
const { placeCafeStarterSet, cafeAmbiancePoints, cafeSeatSpots, cafeServiceStations } = await import("../src/sim/placements");
const { cafePetVisitEndHour } = await import("../src/floor/petAgents");
const { weatherForDay } = await import("../src/sim/weather");
const { weekdayOf } = await import("../src/sim/week");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return originalRandom(); };

try {
  // =========================================================================
  // 一、cafeTypicalBase():一般日想上門的人數
  // =========================================================================
  /** 設計文件 §5.1 的算式,**在本測試裡獨立寫一次**(不呼叫任何 src 的函式)。 */
  const expectedTypical = (signLevel: number, popularity: number, points: number) => {
    const pop = Math.min(CAFE_POPULARITY_MAX, Math.max(0, popularity));
    const popMult = 1 + (pop / CAFE_POPULARITY_MAX) * CAFE_POPULARITY_SWING;
    const ambMult = 1 + Math.min(1, Math.max(0, points) / CAFE_AMBIANCE_FULL_POINTS) * CAFE_AMBIANCE_SWING;
    const raw = signLevel * CAFE_CROWD_PER_SIGN_LEVEL * popMult * ambMult;
    return Math.max(0, Math.round(Number(raw.toFixed(6))));
  };

  const signLevels = [1, 2, 3, 4];
  const popularities = [0, 100];
  const ambiances = [0, 30, 60, 91];
  let tableOk = true;
  const tableMiss: string[] = [];
  for (const s of signLevels) {
    for (const p of popularities) {
      for (const a of ambiances) {
        const got = cafeTypicalBase({ signLevel: s, popularity: p, ambiancePoints: a });
        const want = expectedTypical(s, p, a);
        if (got !== want) { tableOk = false; tableMiss.push(`sign=${s} pop=${p} amb=${a} got=${got} want=${want}`); }
      }
    }
  }
  check("招牌 1~4 × 人氣 0/100 × 氛圍 0/30/60/91 的整張表都對得上設計文件的算式",
    tableOk, tableMiss.slice(0, 4).join(" | "));

  check("🔴 氛圍 60 與 91 給同一個數(上限證明:多買的家具對客流是精確的 0)",
    signLevels.every((s) => popularities.every((p) =>
      cafeTypicalBase({ signLevel: s, popularity: p, ambiancePoints: 60 })
      === cafeTypicalBase({ signLevel: s, popularity: p, ambiancePoints: 91 }))));
  check("氛圍 999 也不會超過上限(乘數本身就夾在 1.0~1.2)",
    cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 999 })
    === cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 60 })
    && cafeAmbianceMultiplier(999) === 1 + CAFE_AMBIANCE_SWING);
  check("氛圍點數愈多客流愈多(上限之前嚴格單調)",
    cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 0 })
    < cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 30 })
    && cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 30 })
    < cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 60 }));
  check("省略 ambiancePoints = 0 點(既有呼叫端語意)",
    cafeTypicalBase({ signLevel: 3, popularity: 40 })
    === cafeTypicalBase({ signLevel: 3, popularity: 40, ambiancePoints: 0 }));
  check("壞資料不生 NaN、不生負數",
    [
      cafeTypicalBase({ signLevel: Number.NaN, popularity: Number.NaN, ambiancePoints: Number.NaN }),
      cafeTypicalBase({ signLevel: -5, popularity: -20, ambiancePoints: -9 }),
      cafeTypicalBase({ signLevel: Infinity, popularity: 1e9, ambiancePoints: 1e9 }),
    ].every((n) => Number.isInteger(n) && n >= 0));

  check("氛圍吃滿的判定:59 未滿、60 剛好滿、91 已滿、壞資料當 0",
    !cafeAmbianceFull(59) && cafeAmbianceFull(60) && cafeAmbianceFull(91)
    && !cafeAmbianceFull(Number.NaN) && !cafeAmbianceFull(-9)
    && CAFE_AMBIANCE_FULL_POINTS === 60);

  // =========================================================================
  // 二、cafeBottleneck():五個 kind 全覆蓋 + 恆等式
  // =========================================================================
  /** staff 的第 N 位 = `extraStaff = N − 1`(首位店員含在開張費裡)。 */
  const capOf = (seats: number, staff: number, stations: number, upgrades: string[] = []) =>
    cafeCapability(upgrades, { seats, extraStaff: staff - 1, stations });

  const capSeats = capOf(2, 5, 9);
  const capStations = capOf(999, 5, 1);
  const capStaff = capOf(999, 2, 9);
  const bigBase = 9999;
  check("kind=seats:席次腿(2 席)比人力腿(5 人)短",
    cafeBottleneck({ base: bigBase, capability: capSeats }).kind === "seats",
    `seat=${capSeats.seatCapacity} staff=${capSeats.staffCapacity}`);
  check("kind=stations:人力腿短,而且吧台已經站滿(5 人 / 服務位 1,已經有人白領薪水)",
    cafeBottleneck({ base: bigBase, capability: capStations }).kind === "stations",
    `idle=${capStations.idleStaff}`);
  check("kind=staff:人力腿短而且吧台還有空位(2 人 / 服務位 9 ⇒ 新人真的站得上)",
    cafeBottleneck({ base: bigBase, capability: capStaff }).kind === "staff",
    `idle=${capStaff.idleStaff}`);
  check("kind=both:兩條腿一樣長", (() => {
    // 人力腿 = 2 × 26 = 52;席次腿 = 10 + seats × 5 = 52 ⇒ seats = 8.4 不是整數,
    // 所以改用 3 人(78)配 seats = (78 − 10) / 5 = 13.6 …⇒ 直接解出可行的組合。
    for (let seats = 0; seats <= 60; seats++) {
      for (let staff = 1; staff <= 5; staff++) {
        const cap = capOf(seats, staff, 99);
        if (cap.seatCapacity === cap.staffCapacity) {
          return cafeBottleneck({ base: bigBase, capability: cap }).kind === "both";
        }
      }
    }
    return false;
  })());
  check("kind=demand:產能大於想上門的人",
    cafeBottleneck({ base: 20, capability: capOf(999, 5, 9) }).kind === "demand");

  const identityCases: { base: number; cap: ReturnType<typeof capOf> }[] = [];
  for (const base of [0, 1, 25, 26, 27, 52, 130, 5005, 9999]) {
    for (const cap of [capSeats, capStations, capStaff, capOf(999, 5, 9), capOf(0, 1, 1)]) {
      identityCases.push({ base, cap });
    }
  }
  check("恆等式:turnedAway === max(0, base − capacity)",
    identityCases.every(({ base, cap }) =>
      cafeBottleneck({ base, capability: cap }).turnedAway === Math.max(0, base - cap.capacity)));
  check("恆等式:headroom === max(0, capacity − base)",
    identityCases.every(({ base, cap }) =>
      cafeBottleneck({ base, capability: cap }).headroom === Math.max(0, cap.capacity - base)));
  check("恆等式:crowdBlocked === (base >= capacity)",
    identityCases.every(({ base, cap }) =>
      cafeBottleneck({ base, capability: cap }).crowdBlocked === (base >= cap.capacity)));
  check("turnedAway 與 headroom 至少有一個是 0(它們是同一條落差的兩側)",
    identityCases.every(({ base, cap }) => {
      const b = cafeBottleneck({ base, capability: cap });
      return b.turnedAway === 0 || b.headroom === 0;
    }));
  check("demand ⇔ 沒有人被擋掉(kind 與數字不會互相矛盾)",
    identityCases.every(({ base, cap }) => {
      const b = cafeBottleneck({ base, capability: cap });
      return (b.kind === "demand") === (b.turnedAway === 0 && !b.crowdBlocked);
    }));
  check("caller 沒餵席次(seatCapacity === null)時席次不可能是瓶頸", (() => {
    const cap = cafeCapability([], { extraStaff: 4, stations: 1 });
    const kind = cafeBottleneck({ base: bigBase, capability: cap }).kind;
    return cap.seatCapacity === null && kind === "stations";
  })());
  check("caller 沒餵吧台幾何(stations === null)時吧台不可能是瓶頸,退回 staff", (() => {
    const cap = cafeCapability([], { seats: 999, extraStaff: 4 });
    const kind = cafeBottleneck({ base: bigBase, capability: cap }).kind;
    return cap.stations === null && cap.idleStaff === 0 && kind === "staff";
  })());

  // --- 🔴 回歸鎖:「剛好站滿」不是人手問題(2026-08-28) ---
  // 舊判定寫 `idleStaff > 0 ? "stations" : "staff"`,而 idleStaff = staffCount − min(staffCount, stations)
  // ⇒ staffCount === stations 時 idleStaff 恆為 0 ⇒ 掉進 staff,叫玩家「雇一位就多 26 單」。
  // 但新人站不上吧台,產能一單不動,實測 Δ = −$260/日。只有在玩家已經浪費過錢
  // (idleStaff 變 1)之後,遊戲才肯講真話。條件必須是「吧台站滿」,不是「已經浪費了」。
  const capFull = capOf(999, 3, 3); // 成熟期典型佈置:3 店員 / 3 服務位
  check("🔴 回歸:staffCount === stations(3/3)⇒ kind 必須是 stations,不是 staff",
    capFull.idleStaff === 0 && capFull.activeStaff === capFull.staffCount
    && cafeBottleneck({ base: bigBase, capability: capFull }).kind === "stations",
    `kind=${cafeBottleneck({ base: bigBase, capability: capFull }).kind} idle=${capFull.idleStaff}`);
  check("🔴 回歸:staffCount === stations 的每一種形狀(1/1 ~ 6/6)都是 stations",
    [1, 2, 3, 4, 5, 6].every((n) =>
      cafeBottleneck({ base: bigBase, capability: capOf(999, n, n) }).kind === "stations"),
    [1, 2, 3, 4, 5, 6].map((n) =>
      `${n}/${n}=${cafeBottleneck({ base: bigBase, capability: capOf(999, n, n) }).kind}`).join(" "));
  check("🔴 回歸:kind === staff ⇔ 吧台真的還有空位(staffCount < stations);掃 1~6 人 × 1~9 服務位",
    (() => {
      const bad: string[] = [];
      for (let staff = 1; staff <= 6; staff++) {
        for (let stations = 1; stations <= 9; stations++) {
          const cap = capOf(999, staff, stations);
          const kind = cafeBottleneck({ base: bigBase, capability: cap }).kind;
          const wantStaff = cap.staffCount < stations;
          if ((kind === "staff") !== wantStaff) bad.push(`${staff}人/${stations}位=${kind}`);
        }
      }
      return bad.length === 0;
    })());
  check("壞資料的 base 不生 NaN", (() => {
    const b = cafeBottleneck({ base: Number.NaN, capability: capSeats });
    return Number.isInteger(b.turnedAway) && Number.isInteger(b.headroom) && b.turnedAway === 0;
  })());

  // --- binding 那一句話:五段互斥、都提到解法 ---
  const adviceOf = (base: number, cap: ReturnType<typeof capOf>) =>
    cafeBottleneckAdvice(cafeBottleneck({ base, capability: cap }), cap, base);
  check("demand 那句叫玩家去「把人叫來」", adviceOf(20, capOf(999, 5, 9)).includes("升招牌"));
  check("seats 那句指向椅子與圓桌", adviceOf(bigBase, capSeats).includes("席次") && adviceOf(bigBase, capSeats).includes("圓桌"));
  check("stations 那句指向吧台區,不是叫玩家多雇人",
    adviceOf(bigBase, capStations).includes("吧台區") && adviceOf(bigBase, capStations).includes("薪水照付"));
  check("🔴 §9-5 特例:stations === 1 時必須點名「吧台區沒有點餐吧台」",
    adviceOf(bigBase, capStations).includes("沒有點餐吧台"),
    adviceOf(bigBase, capStations).slice(-60));
  check("stations >= 2 時不出現那句特例(它只針對收銀口那一個服務位)",
    !adviceOf(bigBase, capOf(999, 5, 2)).includes("沒有點餐吧台"));
  check("staff 那句指向「人力」區塊,並交代席次還撐得住",
    adviceOf(bigBase, capStaff).includes("人力") && adviceOf(bigBase, capStaff).includes("席次還撐得住"));
  check("both 那句講明只補一邊不會變多", (() => {
    for (let seats = 0; seats <= 60; seats++) {
      for (let staff = 1; staff <= 5; staff++) {
        const cap = capOf(seats, staff, 99);
        if (cap.seatCapacity === cap.staffCapacity) return adviceOf(bigBase, cap).includes("只補一邊不會變多");
      }
    }
    return false;
  })());
  check("五段文案都是純文字(不含 markdown 的 ** —— 它會原樣顯示在畫面上)",
    [adviceOf(20, capOf(999, 5, 9)), adviceOf(bigBase, capSeats), adviceOf(bigBase, capStations),
      adviceOf(bigBase, capStaff), adviceOf(bigBase, capFull)].every((line) => !line.includes("**")));

  // --- 🔴 回歸鎖(文案側):剛好站滿時絕不可以叫玩家去雇人 ---
  /** `staff` 那段「去雇一位」的指紋。出現在剛好站滿的店上,就是在叫玩家白付薪水。 */
  const HIRE_DIRECTIVE = "到下面的「人力」雇一位";
  check("🔴 回歸:staffCount === stations 的文案不得叫玩家雇人(連「雇」字都不該出現)", (() => {
    const line = adviceOf(bigBase, capFull);
    return !line.includes(HIRE_DIRECTIVE) && !line.includes("雇")
      && !line.includes("卡在「人手」");
  })(), adviceOf(bigBase, capFull));
  check("🔴 回歸:剛好站滿的文案要講明「先加寬吧台,否則新人上不了工」", (() => {
    const line = adviceOf(bigBase, capFull);
    return line.includes("卡在「吧台寬度」") && line.includes("剛好把它站滿")
      && line.includes("沒有位子站") && line.includes("點餐吧台")
      && line.includes(`白付 $${CAFE_STAFF_WAGE}`);
  })(), adviceOf(bigBase, capFull));
  check("🔴 回歸:idleStaff === 0 時不出現「另外 0 位薪水照付」這種空話",
    !adviceOf(bigBase, capFull).includes("另外 0 位")
    && !adviceOf(bigBase, capFull).includes("薪水照付"));
  check("🔴 回歸:任何 kind === stations 的形狀都不含雇人指令(掃 1~6 人 × 1~9 服務位)", (() => {
    const bad: string[] = [];
    for (let staff = 1; staff <= 6; staff++) {
      for (let stations = 1; stations <= 9; stations++) {
        const cap = capOf(999, staff, stations);
        if (cafeBottleneck({ base: bigBase, capability: cap }).kind !== "stations") continue;
        if (adviceOf(bigBase, cap).includes(HIRE_DIRECTIVE)) bad.push(`${staff}人/${stations}位`);
      }
    }
    return bad.length === 0;
  })());
  check("idleStaff > 0 的舊變體一個字都沒變(還是點名有人白領薪水)",
    adviceOf(bigBase, capStations).includes("另外 4 位薪水照付卻做不了事")
    && adviceOf(bigBase, capStations).includes("他們就能上工"),
    adviceOf(bigBase, capStations));

  // =========================================================================
  // 三、cafeInvestOutlook():核心不變式
  // =========================================================================
  const perishableIds = CAFE_INGREDIENTS.filter((item) => item.perishable).map((item) => item.id);
  const ordersAt = (units: number) => Object.fromEntries(CAFE_INGREDIENTS.map((item) => [item.id, units]));

  /** 使用者那間店:招牌 Lv4、服務位 1、椅子夠、人氣高、氛圍超出上限。 */
  const blockedCtx = {
    upgrades: [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3, CAFE_UPGRADE_IDS.signboardLv4],
    seats: 12, extraStaff: 3, stations: 1,
    popularity: 90, ambiancePoints: 91,
    standingOrders: ordersAt(24),
    petComfortPoints: 5,
  };
  const blockedCap = cafeCapability(blockedCtx.upgrades, {
    seats: blockedCtx.seats, extraStaff: blockedCtx.extraStaff, stations: blockedCtx.stations,
  });
  const blockedBase = cafeTypicalBase({
    signLevel: blockedCap.signLevel, popularity: blockedCtx.popularity, ambiancePoints: blockedCtx.ambiancePoints,
  });
  check("重現使用者的形狀:base > capacity 且卡在吧台寬度",
    blockedBase > blockedCap.capacity
    && cafeBottleneck({ base: blockedBase, capability: blockedCap }).kind === "stations",
    `base=${blockedBase} cap=${blockedCap.capacity}`);

  // 招牌已全買 ⇒ 換一個只買了 Lv1 的版本才看得到三塊招牌的 chip。
  const blockedSignCtx = { ...blockedCtx, upgrades: [] as string[] };
  const blockedSignCap = cafeCapability([], {
    seats: blockedCtx.seats, extraStaff: blockedCtx.extraStaff, stations: blockedCtx.stations,
  });
  const blockedSignBase = cafeTypicalBase({
    signLevel: blockedSignCap.signLevel, popularity: blockedCtx.popularity, ambiancePoints: blockedCtx.ambiancePoints,
  });
  check("Lv1 招牌的店在這個形狀下也已經 base >= capacity",
    blockedSignBase >= blockedSignCap.capacity, `base=${blockedSignBase} cap=${blockedSignCap.capacity}`);

  const crowdItems = [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3,
    CAFE_UPGRADE_IDS.signboardLv4, CAFE_UPGRADE_IDS.outdoorSeats];
  check("🔴 base >= capacity ⇒ 三塊招牌與戶外座位的 extraOrders 精確等於 0,tone 一律 blocked", (() => {
    // 逐級解鎖 ⇒ 每一塊招牌都要用「已買到前一級」的清單問一次,才問得到它自己。
    const chain = [[] as string[], [CAFE_UPGRADE_IDS.signboard],
      [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3]];
    const results = crowdItems.map((id, i) => cafeInvestOutlook(id, {
      ...blockedSignCtx,
      upgrades: id === CAFE_UPGRADE_IDS.outdoorSeats ? [] : chain[i],
    }));
    return results.every((o) => o.extraOrders === 0 && o.tone === "blocked");
  })(), "這就是使用者抱怨的那個 0");
  check("招牌 blocked 的文案把兩個數字都攤出來(想上門 N／做得出 M)", (() => {
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.signboard, blockedSignCtx);
    return o.text.includes(`${blockedSignBase} 人想上門`) && o.text.includes(`${blockedSignCap.capacity} 單`);
  })());
  check("戶外座位 blocked 的文案講明「只在晴天」而且點出金額",
    cafeInvestOutlook(CAFE_UPGRADE_IDS.outdoorSeats, blockedSignCtx).text.includes("晴天")
    && cafeInvestOutlook(CAFE_UPGRADE_IDS.outdoorSeats, blockedSignCtx).text.includes("25,000"));

  /** 產能吃得下的店:招牌買了會有數字。 */
  const roomyCtx = {
    upgrades: [] as string[], seats: 40, extraStaff: 5, stations: 8,
    popularity: 60, ambiancePoints: 30, standingOrders: ordersAt(24), petComfortPoints: 0,
  };
  const roomyCap = cafeCapability(roomyCtx.upgrades, {
    seats: roomyCtx.seats, extraStaff: roomyCtx.extraStaff, stations: roomyCtx.stations,
  });
  const roomyBase = cafeTypicalBase({
    signLevel: roomyCap.signLevel, popularity: roomyCtx.popularity, ambiancePoints: roomyCtx.ambiancePoints,
  });
  check("產能吃得下的店:base < capacity(demand)", roomyBase < roomyCap.capacity,
    `base=${roomyBase} cap=${roomyCap.capacity}`);
  check("🔴 base < capacity ⇒ 招牌 extraOrders === min(baseNext, capacity) − base(差分,不是查表)", (() => {
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.signboard, roomyCtx);
    const nextCap = cafeCapability([CAFE_UPGRADE_IDS.signboard], {
      seats: roomyCtx.seats, extraStaff: roomyCtx.extraStaff, stations: roomyCtx.stations,
    });
    const baseNext = cafeTypicalBase({
      signLevel: nextCap.signLevel, popularity: roomyCtx.popularity, ambiancePoints: roomyCtx.ambiancePoints,
    });
    return o.tone === "good"
      && o.extraOrders === Math.min(baseNext, roomyCap.capacity) - roomyBase
      && o.extraOrders > 0;
  })());
  check("戶外座位 good 的 extraOrders 反映的是「晴天 +15%」那一段",
    (() => {
      const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.outdoorSeats, roomyCtx);
      const sunny = cafeTypicalBase({
        signLevel: roomyCap.signLevel * (1 + CAFE_OUTDOOR_SUNNY_BONUS),
        popularity: roomyCtx.popularity,
        ambiancePoints: roomyCtx.ambiancePoints,
      });
      return o.tone === "good" && o.extraOrders === Math.min(sunny, roomyCap.capacity) - roomyBase;
    })());

  /** 吧台不夠寬的店:第二台咖啡機只加乘「站得上吧台」的人。 */
  const idleCtx = {
    upgrades: [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3, CAFE_UPGRADE_IDS.signboardLv4],
    seats: 999, extraStaff: 4, stations: 2,
    popularity: 100, ambiancePoints: 60, standingOrders: ordersAt(24), petComfortPoints: 0,
  };
  const idleCap = cafeCapability(idleCtx.upgrades, {
    seats: idleCtx.seats, extraStaff: idleCtx.extraStaff, stations: idleCtx.stations,
  });
  check("🔴 idleStaff > 0 ⇒ 咖啡機文案含「加寬吧台」,且 extraOrders 只反映 activeStaff", (() => {
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.secondMachine, idleCtx);
    return idleCap.idleStaff > 0
      && o.tone === "blocked"
      && o.text.includes("加寬吧台")
      && o.extraOrders === idleCap.activeStaff * CAFE_MACHINE_CUPS_BONUS;
  })(), `idle=${idleCap.idleStaff} active=${idleCap.activeStaff}`);
  check("咖啡機文案不會叫「席次卡住」的店去買機器", (() => {
    const seatBoundCtx = { ...idleCtx, seats: 2, stations: 8, extraStaff: 4 };
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.secondMachine, seatBoundCtx);
    return o.tone === "blocked" && o.extraOrders === 0 && o.text.includes("先加椅子");
  })());
  check("咖啡機在人手就是瓶頸、吧台夠寬的店上是 good,extraOrders = 全體店員 × 加成", (() => {
    // extraStaff = 2 ⇒ 3 人 × 26 = 78 單,而想上門的有 132 人 ⇒ 加出來的 30 單全部賣得掉
    // (若產能已經逼近 base,差分會被 base 夾住,那是正確行為但測不到「× 全體店員」)。
    const ctx = { ...idleCtx, seats: 999, stations: 9, extraStaff: 2 };
    const cap = cafeCapability(ctx.upgrades, { seats: ctx.seats, extraStaff: ctx.extraStaff, stations: ctx.stations });
    const base = cafeTypicalBase({ signLevel: cap.signLevel, popularity: ctx.popularity, ambiancePoints: ctx.ambiancePoints });
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.secondMachine, ctx);
    return cap.idleStaff === 0 && o.tone === "good"
      && base >= cap.capacity + cap.staffCount * CAFE_MACHINE_CUPS_BONUS
      && o.extraOrders === cap.staffCount * CAFE_MACHINE_CUPS_BONUS;
  })());

  check("🔴 全生鮮常備量 ≤ 24 ⇒ 大型冷藏 blocked(用真的 applySpoilage() 對帳,不手算)", (() => {
    const stock = ordersAt(24);
    const spoiled = applySpoilage(stock).totalSpoiled; // 真的跑一次損耗
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.coldStorage, { ...roomyCtx, standingOrders: stock });
    return spoiled === 0 && o.tone === "blocked" && o.extraOrders === 0
      && o.text.includes(String(SPOILAGE_FREE_UNITS));
  })());
  check("常備量真的拉高(生鮮 60)⇒ 大型冷藏 good,而且兩個數字與 applySpoilage() 完全一致", (() => {
    const stock = ordersAt(60);
    const before = applySpoilage(stock).totalSpoiled;
    const coldCap = cafeCapability([CAFE_UPGRADE_IDS.coldStorage], {});
    const after = applySpoilage(stock, coldCap.spoilage).totalSpoiled;
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.coldStorage, { ...roomyCtx, standingOrders: stock });
    return before > 0 && after < before
      && o.tone === "good" && o.text.includes(`${before} 單位`) && o.text.includes(`${after} 單位`)
      // §9-4 已知取捨:用常備量估是上界 ⇒ 文案必須寫「最多」。
      && o.text.includes("最多");
  })(), `before=${applySpoilage(ordersAt(60)).totalSpoiled}`);
  check("生鮮清單非空(否則上面兩條是假通過)", perishableIds.length >= 3);

  check("🔴 貓跳台 extraOrders === 0 且 tone === note(不是 blocked —— 它是真實內容,只是不賺錢)", (() => {
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.petTower, blockedCtx);
    return o.tone === "note" && o.extraOrders === 0
      && o.text.includes("不影響營收") && o.text.includes("認養詢問")
      && o.text.includes("唯一的加速器");
  })());
  check("貓跳台的兩個百分比與停留時刻真的會往上走(不是寫死的字)", (() => {
    const a = cafeInvestOutlook(CAFE_UPGRADE_IDS.petTower, { ...blockedCtx, petComfortPoints: 0 });
    const b = cafeInvestOutlook(CAFE_UPGRADE_IDS.petTower, { ...blockedCtx, petComfortPoints: 12 });
    return a.text !== b.text;
  })());

  check("已買過的 id 呼叫不炸,而且不會給出誤導的數字",
    CAFE_UPGRADES_OWNED_SAFE());
  function CAFE_UPGRADES_OWNED_SAFE() {
    const all = Object.values(CAFE_UPGRADE_IDS) as string[];
    return all.every((id) => {
      const o = cafeInvestOutlook(id, { ...blockedCtx, upgrades: all });
      return o.tone === "note" && o.extraOrders === 0;
    });
  }
  check("不存在的 id 回空字串(面板據此不渲染 chip),不丟例外",
    cafeInvestOutlook("no_such_upgrade", blockedCtx).text === ""
    && cafeInvestOutlook("", blockedCtx).extraOrders === 0);
  check("前置未完成的招牌給鎖頭提示,不給誤導的數字", (() => {
    const o = cafeInvestOutlook(CAFE_UPGRADE_IDS.signboardLv4, { ...roomyCtx, upgrades: [] });
    return o.tone === "note" && o.extraOrders === 0 && o.text.includes("需先完成");
  })());
  check("extraOrders 永遠是非負整數(任何 id × 任何形狀)", (() => {
    const all = Object.values(CAFE_UPGRADE_IDS) as string[];
    const shapes = [blockedCtx, blockedSignCtx, roomyCtx, idleCtx,
      { ...roomyCtx, seats: 0, stations: 1, extraStaff: 0, popularity: 0, ambiancePoints: 0 }];
    return shapes.every((ctx) => all.every((id) => {
      const o = cafeInvestOutlook(id, ctx);
      return Number.isInteger(o.extraOrders) && o.extraOrders >= 0;
    }));
  })());
  check("投資文案一律純文字(沒有 markdown 的 **)", (() => {
    const all = Object.values(CAFE_UPGRADE_IDS) as string[];
    return [blockedCtx, blockedSignCtx, roomyCtx, idleCtx]
      .every((ctx) => all.every((id) => !cafeInvestOutlook(id, ctx).text.includes("**")));
  })());

  // =========================================================================
  // 四、界線與決定性
  // =========================================================================
  const snapshotOutlooks = () => JSON.stringify([blockedCtx, roomyCtx, idleCtx].map((ctx) =>
    (Object.values(CAFE_UPGRADE_IDS) as string[]).map((id) => cafeInvestOutlook(id, ctx))));
  check("同輸入連跑兩次逐欄完全相同", snapshotOutlooks() === snapshotOutlooks());
  check("同輸入的 bottleneck / advice / typicalBase 也逐欄相同",
    JSON.stringify(cafeBottleneck({ base: blockedBase, capability: blockedCap }))
    === JSON.stringify(cafeBottleneck({ base: blockedBase, capability: blockedCap }))
    && adviceOf(blockedBase, blockedCap) === adviceOf(blockedBase, blockedCap));
  check("🔴 本節五支純函式期間零 Math.random", randomCalls === 0, `calls=${randomCalls}`);

  const cafeSrc = readSrc("src", "sim", "cafe.ts");
  const cafeCode = cafeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("🔴 cafe.ts 仍然不 import ./placements(幾何數字一律由 caller 餵參數)",
    !/from\s+"\.\/placements"/.test(cafeSrc));
  check("🔴 cafe.ts 全檔(含註解)不出現 getPlacements", !cafeSrc.includes("getPlacements"));
  check("🔴 cafe.ts 不讀 .venue(商店分類不得偷渡成規則)", !/\.venue\b/.test(cafeSrc));
  check("cafe.ts 程式碼本體零 Math.random", !cafeCode.includes("Math.random"));
  check("cafe.ts 仍不 import state / tick / economy",
    !/from\s+"\.\/gameState"/.test(cafeCode) && !/from\s+"\.\/tick"/.test(cafeCode)
    && !/from\s+"\.\/economy"/.test(cafeCode));
  check("🔴 cafe.ts 也不 import 渲染層(petAgents 會讀 store,拉進來就破界線)",
    !/from\s+"\.\.\/floor\//.test(cafeCode));
  check("五支新函式都在 cafe.ts 裡(不是散在 UI 元件)",
    ["export function cafeTypicalBase", "export function cafeAmbianceFull", "export function cafeBottleneck",
      "export function cafeBottleneckAdvice", "export function cafeInvestOutlook"]
      .every((sig) => cafeSrc.includes(sig)));

  // =========================================================================
  // 五、turnedAway 的累加正確性(接真的 tick)
  // =========================================================================
  const setUpCafe = (extraStaff: number, opts: { popularity?: number; signLevel?: number } = {}) => {
    const signs = [CAFE_UPGRADE_IDS.signboard, CAFE_UPGRADE_IDS.signboardLv3, CAFE_UPGRADE_IDS.signboardLv4]
      .slice(0, Math.max(0, (opts.signLevel ?? 2) - 1));
    Object.assign(state.cafe, defaultCafe(), {
      open: true,
      extraStaff,
      popularity: opts.popularity ?? CAFE_POPULARITY_MAX,
      upgrades: signs,
      stock: Object.fromEntries(CAFE_INGREDIENTS.map((item) => [item.id, 9999])),
    });
    state.money = 200_000;
  };
  /** 與 `cafeHourlyPass()` 完全相同的三個幾何輸入。 */
  const liveCrowd = () => {
    const cap = cafeCapability(state.cafe.upgrades, {
      seats: cafeSeatSpots().length, extraStaff: state.cafe.extraStaff, stations: cafeServiceStations(),
    });
    return cafeCrowd({
      weather: weatherForDay(Math.floor((state.gameMs - GAME_START.getTime()) / DAY_MS)),
      weekday: weekdayOf(state.gameMs),
      signLevel: cap.signLevel,
      capacity: cap.capacity,
      popularity: state.cafe.popularity,
      outdoorSeats: cap.outdoorSeats,
      ambiancePoints: cafeAmbiancePoints(),
    });
  };

  placeCafeStarterSet();
  const seats = cafeSeatSpots().length;
  const stations = cafeServiceStations();
  check("開張贈品擺得起來(有席次與服務位)", seats >= 6 && stations >= 3, `seats=${seats} stations=${stations}`);

  /** 跑一整個營業日,逐小時把「應該累加多少」自己算一次。 */
  const runDay = (dayShift: number) => {
    let expected = 0;
    for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
      state.gameMs = GAME_START.getTime() + dayShift * DAY_MS + hour * HOUR_MS;
      // 客流每小時重算(人氣會在日內變動),所以期望值也必須逐小時算。
      const crowd = liveCrowd();
      const h = hour - CAFE_OPEN_HOUR;
      expected += cafeHourlyGuestCount(crowd.base, h) - cafeHourlyGuestCount(crowd.guests, h);
      cafeHourlyPass(hour);
    }
    return { expected, record: state.cafe.sales[state.cafe.sales.length - 1] };
  };

  setUpCafe(0, { popularity: CAFE_POPULARITY_MAX, signLevel: 4 });
  const day1 = runDay(3);
  check("有真的把人擋在門外(否則下面幾條是假通過)", (day1.record.turnedAway ?? 0) > 0,
    `turnedAway=${day1.record.turnedAway}`);
  check("🔴 逐小時累加正確:record.turnedAway === Σ 11 小時的 (base − guests) 差分",
    (day1.record.turnedAway ?? 0) === day1.expected,
    `got=${day1.record.turnedAway} want=${day1.expected}`);
  check("🔴 turnedAway ⊇ abandoned(排到放棄的是沒接到的一小撮)",
    (day1.record.turnedAway ?? 0) >= (day1.record.abandoned ?? 0),
    `turnedAway=${day1.record.turnedAway} abandoned=${day1.record.abandoned}`);

  // 人氣滿 + 沒有缺貨 + 每小時溢出未達耐心線 ⇒ 人氣整天不動 ⇒ base 全天恆定,
  // 這時 Σ 11 小時必須**精確等於 base − guests**(不是逐小時期望值的加總)。
  let cleanDay = -1;
  for (let shift = 20; shift < 90; shift++) {
    setUpCafe(0, { popularity: CAFE_POPULARITY_MAX, signLevel: 3 });
    state.gameMs = GAME_START.getTime() + shift * DAY_MS + CAFE_OPEN_HOUR * HOUR_MS;
    const crowd = liveCrowd();
    const run = runDay(shift);
    const rec = run.record;
    if (rec.refused === 0 && (rec.abandoned ?? 0) === 0 && (rec.turnedAway ?? 0) > 0
      && state.cafe.popularity === CAFE_POPULARITY_MAX
      && (rec.turnedAway ?? 0) === crowd.base - crowd.guests) {
      cleanDay = shift;
      break;
    }
  }
  check("🔴 一個「人氣整天不動」的日子:Σ 11 小時的 turnedAway === base − guests(精確相等)",
    cleanDay >= 0, `找不到符合條件的日子(shift 20~89)`);

  setUpCafe(0, { popularity: CAFE_POPULARITY_MAX, signLevel: 4 });
  state.gameMs = GAME_START.getTime() + 5 * DAY_MS + CAFE_OPEN_HOUR * HOUR_MS;
  state.cafe.open = false;
  cafeHourlyPass(CAFE_OPEN_HOUR + 1);
  check("未開張時不生任何當日紀錄(咖啡廳的天然閘門未破)", state.cafe.sales.length === 0);

  // --- 線上逐時 vs 離線一次補 ---
  Math.random = () => 0.5;
  const NINE_AM = new Date(2026, 6, 20, 9, 0, 0).getTime();
  const snapshot = () => JSON.stringify({
    money: state.money,
    pop: state.cafe.popularity,
    sales: state.cafe.sales,
    ledger: state.ledger.filter((txn) => txn.category === "cafe").map((txn) => ({ label: txn.label, amount: txn.amount })),
  });
  let offlineShift = 0;
  const prepare = (shift: number) => {
    state.ledger.splice(0, state.ledger.length);
    setUpCafe(0, { popularity: CAFE_POPULARITY_MAX, signLevel: 4 });
    state.gameMs = NINE_AM + shift * DAY_MS;
  };
  for (let shift = 0; shift < 14; shift++) {
    prepare(shift);
    for (let i = 0; i < 11; i++) hourlyTick(false);
    if ((state.cafe.sales[state.cafe.sales.length - 1]?.turnedAway ?? 0) > 0) { offlineShift = shift; break; }
  }
  prepare(offlineShift);
  for (let i = 0; i < 11; i++) hourlyTick(false);
  const online = snapshot();
  const onlineGameMs = state.gameMs;

  prepare(offlineShift);
  state.gameAnchorMs = state.gameMs;
  state.realAnchorMs = Date.now() - Math.round((11.5 * 3600 * 1000) / 7);
  const caught = syncToNow();
  check("離線補進度確實補了 11 個遊戲小時", caught === 11, `need=${caught}`);
  check("兩條路徑走到同一個遊戲時刻", state.gameMs === onlineGameMs);
  check("🔴 線上逐時 11 小時 === 離線 syncToNow() 一次補(turnedAway 逐欄相同)",
    online === snapshot(), `\n 線上 ${online.slice(0, 300)}\n 離線 ${snapshot().slice(0, 300)}`);
  check("這 11 小時真的有人沒接到(否則上一條是假通過)",
    (JSON.parse(online).sales[0]?.turnedAway ?? 0) > 0, online.slice(0, 200));
  Math.random = () => { randomCalls++; return originalRandom(); };

  // --- 存檔:additive 選填欄位,舊檔補 0、SAVE_VERSION 不動 ---
  const legacy = sanitizeCafeState({
    ...defaultCafe(),
    sales: [{ day: 1, sold: {}, missed: {}, revenue: 0, ingredientCost: 0, served: 3, refused: 0, settled: true, restocked: true, restockCost: 0 }],
  } as any);
  check("舊存檔(沒有 turnedAway)載入後補 0,不是 undefined",
    legacy.sales[0].turnedAway === 0);
  check("消毒是冪等且決定性的(再跑一次同一個值)",
    sanitizeCafeState(legacy as any).sales[0].turnedAway === 0
    && JSON.stringify(sanitizeCafeState(legacy as any)) === JSON.stringify(sanitizeCafeState(legacy as any)));
  check("壞資料(負數/NaN/字串)一律夾成非負整數", (() => {
    const dirty = sanitizeCafeState({
      ...defaultCafe(),
      sales: [
        { day: 1, sold: {}, missed: {}, revenue: 0, ingredientCost: 0, served: 0, refused: 0, settled: true, restocked: true, restockCost: 0, turnedAway: -9 },
        { day: 2, sold: {}, missed: {}, revenue: 0, ingredientCost: 0, served: 0, refused: 0, settled: true, restocked: true, restockCost: 0, turnedAway: Number.NaN },
        { day: 3, sold: {}, missed: {}, revenue: 0, ingredientCost: 0, served: 0, refused: 0, settled: true, restocked: true, restockCost: 0, turnedAway: "99" },
      ],
    } as any);
    return dirty.sales.every((row) => Number.isInteger(row.turnedAway) && (row.turnedAway ?? -1) >= 0);
  })());

  // --- 流失日誌 ---
  check("turnaway 日誌句帶人數、帶咖啡廳前綴、決定性",
    cafeDailyLine({ kind: "turnaway", day: 5, subject: "", count: 64 }).includes("64")
    && cafeDailyLine({ kind: "turnaway", day: 5, subject: "", count: 64 }).startsWith("🥐")
    && cafeDailyLine({ kind: "turnaway", day: 5, subject: "", count: 64 })
    === cafeDailyLine({ kind: "turnaway", day: 5, subject: "", count: 64 }));
  check("turnaway 四句都抽得到(不同日子會換句)",
    new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
      .map((d) => cafeDailyLine({ kind: "turnaway", day: d, subject: "", count: 7 }))).size >= 3);
  check("「0 個人沒排到」不成句(下界夾 1)",
    cafeDailyLine({ kind: "turnaway", day: 1, subject: "", count: 0 }).includes("1"));
  check("既有四種 kind 的句子一個字都沒變(節流掛在 else 鏈最後 ⇒ 舊行為不動)",
    cafeDailyLine({ kind: "shortage", day: 3, subject: "牛奶" }).startsWith("🥐")
    && cafeDailyLine({ kind: "spoilage", day: 3, subject: "牛奶" }).startsWith("🥐")
    && cafeDailyLine({ kind: "storage", day: 3, subject: "牛奶" }).startsWith("🥐")
    && cafeDailyLine({ kind: "underfunded", day: 3, subject: "牛奶", fulfillment: 0.5 }).includes("5成"));
  check("日誌節流常數與既有兩則錯開(賣出 %7===0、老樣子 %7===3、流失 %7===5)", (() => {
    const tick = readSrc("src", "sim", "tick.ts");
    return /CAFE_TURNAWAY_LOG_DAY = 5/.test(tick)
      && /day % 7 === CAFE_TURNAWAY_LOG_DAY/.test(tick)
      // 掛在既有 if/else 鏈的最後一格:缺貨與損耗有話講的日子行為逐字不變。
      && /rot\.totalSpoiled > 0\) \{[\s\S]{0,400}?\} else if \(/.test(tick);
  })());
  check("🔴 tick.ts 的 early-out 一行未動,而且推導寫成了註解", (() => {
    const tick = readSrc("src", "sim", "tick.ts");
    return tick.includes("if (count <= 0 && abandonCount <= 0) return;")
      && tick.includes("為什麼它不會漏記 `turnedAway`")
      && tick.includes("guests === capacity");
  })());
  check("累加點用兩個 cafeHourlyGuestCount 相減(不是先減再攤)", (() => {
    const tick = readSrc("src", "sim", "tick.ts");
    return /const turnedAway = cafeHourlyGuestCount\(crowd\.base, hourIndex\)\s*\r?\n?\s*- cafeHourlyGuestCount\(crowd\.guests, hourIndex\);/.test(tick);
  })());
  check("SAVE_VERSION 維持 10(turnedAway 是 additive 選填欄位)",
    /SAVE_VERSION\s*=\s*10\b/.test(readSrc("src", "sim", "persistence.ts")));

  // =========================================================================
  // 六、SFC 合約掃描(比照 ops-panel-test.ts)
  // =========================================================================
  const panel = readSrc("src", "components", "CafePanel.vue");
  const shop = readSrc("src", "components", "FurnitureShop.vue");
  check("CafePanel 呼叫了四支新純函式",
    ["cafeBottleneck(", "cafeInvestOutlook(", "cafeTypicalBase(", "cafeAmbianceFull("]
      .every((sig) => panel.includes(sig)));
  check("🔴 面板與商店都呼叫 cafeAmbianceFull()(氛圍判定只有一份)",
    panel.includes("cafeAmbianceFull(") && shop.includes("cafeAmbianceFull("));
  check("🔴 兩個 SFC 都沒有手寫的氛圍上限比較(>= 60 / 直接比常數)",
    [panel, shop].every((src) =>
      !/[<>]=?\s*60\b/.test(src)
      && !/[<>=]=?\s*CAFE_AMBIANCE_FULL_POINTS/.test(src)
      && !/CAFE_AMBIANCE_FULL_POINTS\s*[<>]=?/.test(src)));
  check("商店的 chip / banner 條件含 venue 判定與 cafe.open(不污染租屋分頁)",
    shop.includes('venue.value === "cafe"') && shop.includes("state.cafe.open"));
  check("商店把「有機能」與「純氛圍」分開講(絕不能讓玩家以為家具完全沒用)",
    shop.includes("機能照常") && shop.includes("只影響外觀")
    && shop.includes("CAFE_FURNITURE_ZONE") && shop.includes("d.seat"));
  /** 這五句是 `cafeInvestOutlook()` 產的文案的指紋:出現在 cafe.ts,絕不能出現在 template。 */
  const outlookFingerprints = ["以現在的店算:每天大約多做", "再多叫人來也吃不下",
    "同一筆錢的效益大得多", "唯一的加速器", "只在晴天生效"];
  check("🔴 投資 chip 的文字不寫死在 template(必須來自 cafeInvestOutlook)",
    outlookFingerprints.every((s) => !panel.includes(s) && cafeSrc.includes(s))
    && panel.includes("investOutlook(item.id).text"),
    outlookFingerprints.filter((s) => panel.includes(s)).join(" | "));
  /** 五段 binding 文案的指紋,同理。 */
  const adviceFingerprints = ["卡在「吧台寬度」", "卡在「席次」", "卡在「人手」",
    "沒有點餐吧台", "席次與人力剛好一樣緊"];
  check("🔴 binding 那一句也來自函式(template 不寫死五段文案)",
    panel.includes("bottleneckAdvice")
    && adviceFingerprints.every((s) => !panel.includes(s) && cafeSrc.includes(s)),
    adviceFingerprints.filter((s) => panel.includes(s)).join(" | "));
  check("落差三格在 status-grid 上方,而且三格都在",
    panel.indexOf('class="gap-grid"') > 0
    && panel.indexOf('class="gap-grid"') < panel.indexOf('class="status-grid"')
    && panel.includes("想上門") && panel.includes("做得出來") && panel.includes("沒接到"));
  check("三格第一格永遠標「一般日」,當日值只放小字(§9-1)",
    /一般日・今天 \{\{ todayCrowd\.base \}\}/.test(panel));
  check("標題列摘要保留 class=\"capacity\"(cafe-panel-collapse-test 釘住它)",
    /<span class="capacity">想上門 \{\{ typicalBase \}\} · 產能 \{\{ capability\.capacity \}\}<\/span>/.test(panel));
  check("7 日流失摘要交代了 turnedAway ⊇ abandoned",
    panel.includes("排進隊伍才轉身離開"));
  check("🔴 投資 chip 沒有 CSS transition(§9-2:翻面是真的狀態改變,不是抖動)",
    /\.outlook\s*\{[^}]*\}/.test(panel) && !/\.outlook[^{]*\{[^}]*transition/.test(panel));
  check("三種 tone 都有對應的 CSS",
    panel.includes(".outlook.good") && panel.includes(".outlook.blocked") && panel.includes(".outlook.note"));
  check("cafeUpgrades.ts 的 effect 字串一個字都沒改(那是資料)", (() => {
    const data = readSrc("src", "content", "cafeUpgrades.ts");
    return data.includes('effect: "基礎客流提高，租屋詢問更容易出現"')
      && data.includes('effect: "晴天客流提高，雨天不生效"')
      && data.includes('effect: "生鮮免損耗量提高，損耗率減半"')
      && data.includes('effect: "寵物停留更久，認養詢問更容易出現"');
  })());

  // =========================================================================
  // 七、🔴 兩式一致性(中控追加)
  // =========================================================================
  check("陰天的天氣係數恰好是 1.0(cafeTypicalBase 的「一般日」就踩在它上面)",
    CAFE_WEATHER_MULTIPLIER[CAFE_TYPICAL_WEATHER] === 1);
  check("星期表七格都沒有 1.0 —— 所以一致性必須靠 signLevel 折算(見 cafeTypicalBase 註解)",
    CAFE_WEEKDAY_MULTIPLIER.every((m) => m !== 1));

  const consistencyGrid: [number, number, number][] = [];
  for (const s of [1, 2, 3, 4]) {
    for (const p of [0, 1, 40, 50, 77, 99, 100]) {
      for (const a of [0, 7, 28, 30, 59, 60, 91]) consistencyGrid.push([s, p, a]);
    }
  }
  const mismatches: string[] = [];
  for (let k = 0; k < 7; k++) {
    for (const [s, p, a] of consistencyGrid) {
      const typical = cafeTypicalBase({ signLevel: s, popularity: p, ambiancePoints: a });
      // 同一支 `cafeCrowd()`,天氣係數 = 1、星期係數用 signLevel 折算回 1。
      const viaCrowd = cafeCrowd({
        weather: CAFE_TYPICAL_WEATHER,
        weekday: k,
        signLevel: s / CAFE_WEEKDAY_MULTIPLIER[k],
        capacity: Number.MAX_SAFE_INTEGER,
        popularity: p,
        outdoorSeats: false,
        ambiancePoints: a,
      }).base;
      if (typical !== viaCrowd) mismatches.push(`k=${k} s=${s} p=${p} a=${a} typical=${typical} crowd=${viaCrowd}`);
    }
  }
  check(`🔴 兩式一致:cafeTypicalBase() === cafeCrowd() 的 base(weather=1、weekday=1、outdoor=false;7 × ${consistencyGrid.length} 組全比)`,
    mismatches.length === 0, mismatches.slice(0, 3).join(" | "));
  check("含 .5 取整邊界的那一組也對得上(signLevel=1、人氣滿 ⇒ raw = 27.5)",
    cafeTypicalBase({ signLevel: 1, popularity: 100, ambiancePoints: 0 })
    === Math.round(CAFE_CROWD_PER_SIGN_LEVEL * (1 + CAFE_POPULARITY_SWING)),
    `got=${cafeTypicalBase({ signLevel: 1, popularity: 100, ambiancePoints: 0 })}`);
  check("cafeTypicalBase 直接呼叫 cafeCrowd(結構上不可能出現第二份算式)",
    /function typicalCrowdBase[\s\S]{0,600}?return cafeCrowd\(\{/.test(cafeSrc));
  check("cafeTypicalBase 不受戶外座位影響(它只在晴天生效,一般日不計)", (() => {
    const withOutdoor = cafeCrowd({
      weather: CAFE_TYPICAL_WEATHER, weekday: 0, signLevel: 4 / CAFE_WEEKDAY_MULTIPLIER[0],
      capacity: Number.MAX_SAFE_INTEGER, popularity: 100, outdoorSeats: true, ambiancePoints: 60,
    }).base;
    // 陰天 ⇒ 戶外加成不生效 ⇒ 與 typicalBase 相同。
    return withOutdoor === cafeTypicalBase({ signLevel: 4, popularity: 100, ambiancePoints: 60 });
  })());

  // 寵物停留時刻的鏡像:cafe.ts 一份、petAgents.ts 一份,必須逐點相同。
  const hourMismatch: string[] = [];
  for (let comfort = 0; comfort <= 40; comfort++) {
    if (cafePetStayEndHour(comfort) !== cafePetVisitEndHour(comfort)) {
      hourMismatch.push(`comfort=${comfort} cafe=${cafePetStayEndHour(comfort)} agents=${cafePetVisitEndHour(comfort)}`);
    }
  }
  check("🔴 寵物停留時刻的鏡像與 petAgents.cafePetVisitEndHour() 逐點相同(comfort 0~40)",
    hourMismatch.length === 0, hourMismatch.slice(0, 3).join(" | "));
  check("鏡像的壞資料處理也一致", cafePetStayEndHour(Number.NaN) === cafePetVisitEndHour(Number.NaN)
    && cafePetStayEndHour(-9) === cafePetVisitEndHour(-9)
    && cafePetStayEndHour(9999) === cafePetVisitEndHour(9999));

  // 產能常數沒被順手改動(平衡零漂移的前提)
  check("產能相關常數一顆都沒動(平衡零漂移的前提)",
    CAFE_STAFF_CUPS_PER_DAY === 26 && CAFE_SEAT_TURNOVER === 5 && CAFE_TAKEAWAY_CAPACITY === 10
    && CAFE_CROWD_PER_SIGN_LEVEL === 22 && CAFE_MACHINE_CUPS_BONUS === 10
    && CAFE_AMBIANCE_SWING === 0.2 && CAFE_BUSINESS_HOURS === 11
    && CAFE_STAFF_WAGE === 260
    && cafeStaffCount(0) === 1);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
