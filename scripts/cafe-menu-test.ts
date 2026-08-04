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
  check("完整前兩層 = 3 個基礎品項 + 10 個研發品項", fullMenu.length === 13
    && fullMenu.filter((item) => item.source === "research").length === 10);
  check("每個研發品項都有正價格、穩定 researchId 與合法 track", fullMenu.filter((item) => item.source === "research")
    .every((item) => item.price > 0 && researchIds.includes(item.researchId as any)
      && ["coffee", "bakery", "pet"].includes(item.track) && item.level >= 1 && item.audience.length > 0));
  check("只有寵物生日蛋糕菜單帶特殊事件旗標", fullMenu.filter((item) => item.specialEvent).map((item) => item.researchId).join()
    === CAFE_RESEARCH_IDS.petBirthdayCake);

  // 2. 平均客單價：P4a 起 = 目前菜單標價的平均(四捨五入),硬上限只當防呆。
  check("完整研發平均客單價為 $38(13 項標價平均 $38.15)",
    avgTicket(researchIds) === 38 && cafeTicketPrice(researchIds) === 38, String(avgTicket(researchIds)));
  check("客單價就是菜單標價的平均(面板顯示什麼、玩家大致就收到什麼)", (() => {
    const menu = menuItems(researchIds);
    const mean = menu.reduce((sum, item) => sum + item.price, 0) / menu.length;
    return avgTicket(researchIds) === Math.round(mean);
  })());
  check("只完成三個根節點時是三個根節點價格拉平後的平均", avgTicket([
    CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals,
  ]) === 37);
  check("完整研發 bonus 由 $38 / $36 反推", Math.abs(cafeResearchTicketBonus(researchIds) - (38 / 36 - 1)) < 1e-12);
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
  check("10 項研發的 1,024 種 completed 組合都夾在 $36 ~ 硬上限之間", allSubsetsSafe);
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
      net += state.money - before;
    }
    return net / days;
  };

  const baselineNet = measure([]);
  const researchedNet = measure(researchIds);
  const researchedRatio = researchedNet / dailyRent;
  console.log(`   · 無研發成熟期：$${baselineNet.toFixed(0)}/日；完整研發：$${researchedNet.toFixed(0)}/日`
    + `（日租金 $${dailyRent} 的 ${(researchedRatio * 100).toFixed(1)}%）`);
  check("完整研發會提高成熟期日淨利", researchedNet > baselineNet, `${baselineNet} -> ${researchedNet}`);
  // 🔴 P4a:設計文件 §4.7 拍板「咖啡廳可以慢慢成長取代收租」,原本那兩條
  //    「不得超過日租金 50%」「不會比收租賺錢」的護欄已被推翻,刻意刪除。
  //    取而代之的是「研發本身不是印鈔機」:光靠研發(不加席次/人力/招牌)
  //    仍然拉不出成長曲線,收益的主軸在 §4.7 的三個天花板上。
  check("研發不是印鈔機:光靠研發的漲幅在一成以內",
    researchedNet - baselineNet < baselineNet * 0.1,
    `${baselineNet.toFixed(0)} -> ${researchedNet.toFixed(0)}`);

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
