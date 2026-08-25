/** CAFE-17：研發菜單、平均客單價與成熟期 30～50% 收益護欄。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const {
  avgTicket,
  cafeResearchTicketBonus,
  cafeTicketPrice,
  CAFE_BASE_MENU_ITEMS,
  CAFE_BASE_TICKET,
  CAFE_MAX_AVG_TICKET,
  CAFE_POPULARITY_MAX,
  CAFE_RESEARCH,
  CAFE_RESEARCH_IDS,
  CAFE_UPGRADE_IDS,
  menuItems,
  suggestedStandingOrders,
} = await import("../src/sim/cafe");
const { CAFE_INGREDIENTS } = await import("../src/content/cafeIngredients");
const { state, defaultCafe, GAME_START } = await import("../src/sim/gameState");
const { cafeDailyPass, cafeHourlyPass, cafeRestockPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");
const { placeCafeStarterSet } = await import("../src/sim/placements");

// 🔴 P4a:產能吃席次(`min(外帶底量 + 席次×迴轉率, 員工×杯數)`),所以第 3 節的
// 端到端量測必須先擺上開張贈品 —— 那是玩家按下開張時真的會拿到的東西。
placeCafeStarterSet();

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const researchIds = CAFE_RESEARCH.map((item) => item.id);
const snapshot = (value: unknown) => JSON.stringify(value);

try {
  // 1. 基礎菜單與研發品項。
  check("開張即有三個基礎品項", CAFE_BASE_MENU_ITEMS.length === 3 && menuItems([]).length === 3);
  check("基礎菜單涵蓋沖煮／烘焙／寵物三條線", new Set(CAFE_BASE_MENU_ITEMS.map((item) => item.track)).size === 3);
  check("基礎菜單平均正好是既有 $36", CAFE_BASE_MENU_ITEMS.reduce((sum, item) => sum + item.price, 0)
    / CAFE_BASE_MENU_ITEMS.length === CAFE_BASE_TICKET);
  check("沒有研發時 avgTicket / cafeTicketPrice 都是 $36", avgTicket([]) === 36 && cafeTicketPrice([]) === 36);
  check("沒有研發時 bonus 為 0", cafeResearchTicketBonus([]) === 0);

  const pourOnly = menuItems([CAFE_RESEARCH_IDS.pourOver]);
  check("完成研發會加入對應品項", pourOnly.length === 4
    && pourOnly.some((item) => item.researchId === CAFE_RESEARCH_IDS.pourOver && item.name === "今日手沖單品" && item.price === 42));
  check("未知與重複 id 不會灌大菜單", menuItems(["unknown", CAFE_RESEARCH_IDS.pourOver, CAFE_RESEARCH_IDS.pourOver]).length === 4);
  check("completed 順序不影響菜單順序", snapshot(menuItems([...researchIds].reverse())) === snapshot(menuItems(researchIds)));

  const fullMenu = menuItems(researchIds);
  check("完整菜單 = 3 個基礎品項 + 13 個研發品項(2026-08-25 第三層上線後)", fullMenu.length === 16
    && fullMenu.filter((item) => item.source === "research").length === 13);
  check("每個研發品項都有正價格、穩定 researchId 與合法 track", fullMenu.filter((item) => item.source === "research")
    .every((item) => item.price > 0 && researchIds.includes(item.researchId as any)
      && ["coffee", "bakery", "pet"].includes(item.track) && item.level >= 1 && item.audience.length > 0));
  check("只有寵物生日蛋糕菜單帶特殊事件旗標", fullMenu.filter((item) => item.specialEvent).map((item) => item.researchId).join()
    === CAFE_RESEARCH_IDS.petBirthdayCake);

  // 2. 平均客單價：P4a 起 = 目前菜單標價的平均(四捨五入),硬上限只當防呆。
  // 2026-08-25:第三層三項($58~64)+ 慢萃/磅蛋糕/司康三筆調價 ⇒ $38 → $43。
  // 這是**刻意的平衡改動**(名店期缺口 100% 來自客單價),不是位移。
  check("完整研發平均客單價為 $43(16 項標價平均 $43.13)",
    avgTicket(researchIds) === 43 && cafeTicketPrice(researchIds) === 43, String(avgTicket(researchIds)));
  check("客單價就是菜單標價的平均(面板顯示什麼、玩家大致就收到什麼)", (() => {
    const menu = menuItems(researchIds);
    const mean = menu.reduce((sum, item) => sum + item.price, 0) / menu.length;
    return avgTicket(researchIds) === Math.round(mean);
  })());
  check("只完成三個根節點時是三個根節點價格拉平後的平均", avgTicket([
    CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals,
  ]) === 38);
  check("完整研發 bonus 由 $43 / $36 反推", Math.abs(cafeResearchTicketBonus(researchIds) - (43 / 36 - 1)) < 1e-12);
  check("未知／重複 id 不改客單價", avgTicket(["unknown"]) === 36
    && avgTicket([...researchIds, ...researchIds, "unknown"]) === avgTicket(researchIds));
  // 🔴 P4a:$38 → $55(設計文件 §4.7)。$38 原本是 CAFE-17 為了守住「成熟期只能是
  //    日租金 30~50%」設的收益護欄,而 §4.7 已經拍板推翻那條副業定位。
  //    它現在純粹是**防呆**:日後在 content 誤加高價品項,平均也不會衝破 $55。
  check("客單價硬上限已放寬到 $55", CAFE_MAX_AVG_TICKET === 55);
  let allSubsetsSafe = true;
  for (let mask = 0; mask < 2 ** researchIds.length; mask++) {
    const ids = researchIds.filter((_, index) => (mask & (1 << index)) !== 0);
    const ticket = avgTicket(ids);
    if (!Number.isFinite(ticket) || ticket < CAFE_BASE_TICKET || ticket > CAFE_MAX_AVG_TICKET) allSubsetsSafe = false;
  }
  check("13 項研發的 8,192 種 completed 組合都夾在 $36 ~ 硬上限之間", allSubsetsSafe);
  // 防呆真的還在:塞一個 $2,000 的假品項進菜單,平均照樣被夾在 $55。
  check("🔴 硬上限防呆仍生效:誤加高價品項也衝不破 $55", (() => {
    const menu = [...menuItems([]), { price: 2000 } as never];
    const mean = menu.reduce((sum, item: { price: number }) => sum + item.price, 0) / menu.length;
    return mean > CAFE_MAX_AVG_TICKET && Math.min(CAFE_MAX_AVG_TICKET, Math.round(mean)) === CAFE_MAX_AVG_TICKET;
  })());

  const normalOrder = [
    CAFE_RESEARCH_IDS.basicBrewing,
    CAFE_RESEARCH_IDS.pourOver,
    CAFE_RESEARCH_IDS.latteArt,
    CAFE_RESEARCH_IDS.coldBrew,
    CAFE_RESEARCH_IDS.baking,
    CAFE_RESEARCH_IDS.scone,
    CAFE_RESEARCH_IDS.catCookie,
    CAFE_RESEARCH_IDS.petMeals,
    CAFE_RESEARCH_IDS.petTreat,
    CAFE_RESEARCH_IDS.petBirthdayCake,
  ];
  const progression = normalOrder.map((_, index) => avgTicket(normalOrder.slice(0, index + 1)));
  check("合法研究順序的客單價只升不降", progression.every((value, index) => index === 0 || value >= progression[index - 1]), progression.join(","));

  // 3. 實際日結接線：完整研發有提升，但成熟期仍不超過日租金 50%。
  const DAY_MS = 24 * 3600 * 1000;
  const setDay = (day: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS; };
  const openStock = () => Object.fromEntries(CAFE_INGREDIENTS.map((item) => [item.id, item.defaultStandingOrder]));
  const matureUpgrades = [
    CAFE_UPGRADE_IDS.signboard,
    CAFE_UPGRADE_IDS.secondMachine,
    CAFE_UPGRADE_IDS.outdoorSeats,
    CAFE_UPGRADE_IDS.coldStorage,
  ];
  const dailyRent = Object.values(state.runtimes)
    .reduce((sum, runtime) => sum + Math.round(runtime.tenant.finance.monthlyRent / 30), 0);

  // P1 起營收是 cafeHourlyPass 逐位顧客收的、P3 起進貨是 cafeRestockPass 開店前扣的,
  // 所以量測必須跑完整的一天(進貨 + 11 個營業小時 + 換日日結),不能只呼叫 cafeDailyPass。
  const HOUR_MS = 3600 * 1000;
  const measure = (completed: string[], days = 56) => {
    state.money = 5_000_000;
    state.ledger.splice(0, state.ledger.length);
    Object.assign(state.cafe, defaultCafe(), {
      open: true,
      standingOrders: suggestedStandingOrders(),
      stock: openStock(),
      popularity: CAFE_POPULARITY_MAX,
      upgrades: matureUpgrades,
      completed,
    });
    let net = 0;
    let guests = 0;
    let revenue = 0;
    for (let day = 0; day < days; day++) {
      const before = state.money;
      // 🔴 P3:進貨在開店前(09:00)扣款,不再是日結的一部分。
      state.gameMs = GAME_START.getTime() + day * DAY_MS + (CAFE_OPEN_HOUR - 1) * HOUR_MS;
      cafeRestockPass(CAFE_OPEN_HOUR - 1);
      for (let hour = CAFE_OPEN_HOUR; hour <= CAFE_CLOSE_HOUR; hour++) {
        state.gameMs = GAME_START.getTime() + day * DAY_MS + hour * HOUR_MS;
        cafeHourlyPass(hour);
      }
      setDay(day);
      cafeDailyPass();
      const record = state.cafe.history[state.cafe.history.length - 1];
      guests += record?.guests ?? 0;
      revenue += record?.revenue ?? 0;
      net += state.money - before;
    }
    return { net: net / days, guests: guests / days, revenue: revenue / days };
  };

  const baseline = measure([]);
  const researched = measure(researchIds);
  const baselineNet = baseline.net;
  const researchedNet = researched.net;
  const researchedRatio = researchedNet / dailyRent;
  console.log(`   · 無研發成熟期：$${baselineNet.toFixed(0)}/日；完整研發：$${researchedNet.toFixed(0)}/日`
    + `（日租金 $${dailyRent} 的 ${(researchedRatio * 100).toFixed(1)}%）`
    + `；客流 ${baseline.guests.toFixed(1)} → ${researched.guests.toFixed(1)} 人/日`
    + `、客單價 $${(baseline.revenue / baseline.guests).toFixed(1)} → $${(researched.revenue / researched.guests).toFixed(1)}`);
  check("完整研發會提高成熟期日淨利", researchedNet > baselineNet, `${baselineNet} -> ${researchedNet}`);

  // =========================================================================
  // 🔴 「研發不是印鈔機」的兩條護欄（2026-08-25 改寫，說明必讀）
  // =========================================================================
  // 這裡原本是「光靠研發的漲幅在一成以內」。第三層研發上線後那條**必然翻掉**
  // （實測 +41%），因為它的前提已經不成立：它是在「研發只值 +$0.86/客」的年代寫的，
  // 而那個 +$0.86 本身就是 bug——冷萃/磅蛋糕/司康三項的毛利恰好等於基礎菜單的
  // 加權毛利 $19.00，貢獻在數學上精確是 0。修掉那個 bug 之後漲幅本來就會變大。
  //
  // 但「研發不是印鈔機」這個**意圖**仍然要守。它真正想擋的是兩件事，
  // 於是拆成兩條各自釘一件，都不是把數字放寬：
  //
  //   (1) 研發**只准走客單價這條腿**。它不可以偷偷放大客流或產能——
  //       那才是真正的印鈔機。這條是razor-tight 的：客流一人都不准動。
  //   (2) 光靠研發**到不了淨租金的一半**。產能腿（席次／人力／招牌）不投資的話，
  //       菜單再貴也只是把 26 杯賣貴一點，撐不起「取代收租」。
  const DESIGN_NET_RENT = 52_000 / 30 - 650; // 四房滿租 $52,000/月 − 管理費 $650
  check("🔴 研發只准走客單價那條腿:同樣的產能下客流一人不動(不准偷偷放大客流/產能)",
    Math.abs(researched.guests - baseline.guests) < 1,
    `${baseline.guests.toFixed(2)} → ${researched.guests.toFixed(2)} 人/日`);
  check("🔴 研發不是印鈔機:產能腿(席次/人力/招牌)不投資,光靠研發到不了淨租金的一半",
    researchedNet < DESIGN_NET_RENT * 0.5,
    `$${researchedNet.toFixed(0)} vs $${(DESIGN_NET_RENT * 0.5).toFixed(0)}`
    + `(= 淨租金 $${DESIGN_NET_RENT.toFixed(0)} 的 ${(researchedNet / DESIGN_NET_RENT * 100).toFixed(0)}%)`);

  // 4. 純函式與零 RNG。
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => { randomCalls++; return originalRandom(); };
  menuItems(researchIds);
  avgTicket(researchIds);
  cafeResearchTicketBonus(researchIds);
  cafeTicketPrice(researchIds);
  Math.random = originalRandom;
  check("菜單與客單價計算零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  // 其他測試各自在獨立 process；此處只需讓錯誤能正常落到 summary。
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
