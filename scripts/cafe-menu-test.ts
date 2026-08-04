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
const { cafeDailyPass, cafeHourlyPass, CAFE_OPEN_HOUR, CAFE_CLOSE_HOUR } = await import("../src/sim/tick");

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

  // 2. 平均客單價：未知／重複安全、硬上限與所有組合有限。
  check("完整研發平均客單價為 $38", avgTicket(researchIds) === 38 && cafeTicketPrice(researchIds) === 38);
  const levelTwoIds = CAFE_RESEARCH.filter((item) => item.level === 2).map((item) => item.id);
  check("第二層未滿 2 項維持 $36，2 項升 $37，5 項升 $38", avgTicket(levelTwoIds.slice(0, 1)) === 36
    && avgTicket(levelTwoIds.slice(0, 2)) === 37 && avgTicket(levelTwoIds.slice(0, 5)) === 38);
  check("只完成三個根節點不直接加價", avgTicket([
    CAFE_RESEARCH_IDS.basicBrewing, CAFE_RESEARCH_IDS.baking, CAFE_RESEARCH_IDS.petMeals,
  ]) === 36);
  check("完整研發 bonus 由 $38 / $36 反推", Math.abs(cafeResearchTicketBonus(researchIds) - (38 / 36 - 1)) < 1e-12);
  check("未知／重複 id 不改客單價", avgTicket(["unknown"]) === 36
    && avgTicket([...researchIds, ...researchIds, "unknown"]) === avgTicket(researchIds));
  check("客單價硬上限固定 $38", CAFE_MAX_AVG_TICKET === 38);
  let allSubsetsSafe = true;
  for (let mask = 0; mask < 2 ** researchIds.length; mask++) {
    const ids = researchIds.filter((_, index) => (mask & (1 << index)) !== 0);
    const ticket = avgTicket(ids);
    if (!Number.isFinite(ticket) || ticket < CAFE_BASE_TICKET || ticket > CAFE_MAX_AVG_TICKET) allSubsetsSafe = false;
  }
  check("10 項研發的 1,024 種 completed 組合都夾在 $36～$38", allSubsetsSafe);

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

  // P1 起營收是 cafeHourlyPass 逐位顧客收的,所以量測必須跑完整的一天
  // (11 個營業小時 + 換日日結),不能只呼叫 cafeDailyPass。
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
  check("完整研發成熟期仍在日租金 30～50%", researchedRatio >= 0.3 && researchedRatio <= 0.5,
    `${(researchedRatio * 100).toFixed(1)}%`);
  check("完整研發仍不會讓咖啡廳比收租賺錢", researchedNet < dailyRent);

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
