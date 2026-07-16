/**
 * 經濟(store 拆分:economy 模組)。
 * 金錢進出唯一入口 addMoney()(分類記帳)、每日收租與管理費、
 * 家具的買/擺/移/賣(含 8-2 預覽判定 canDropAt)。
 */
import { getDef } from "../furniture/catalog";
import { addPlacement, removePlacementAt, findFreeSlot, canPlaceFree, furnitureAt, getPlacements, placementRotation } from "./placements";
import { nextRotation, rotatedFootprint } from "../furniture/rotation";
import { getUpgradeDef, roomUpgradeIds, upgradeState } from "./upgrades";
import { state, clamp, fmt, gameDayIndex, notify, pushMemory, pushSocialLog, LOG_CAP, LEDGER_CAP, type TenantRuntime, type TxnCategory } from "./gameState";
import type { EventDef } from "./events";
import { clearNoiseMemories } from "./memoryEffects";
import { applyHour } from "./tick";
import { save } from "./persistence";

// 每日管理費(讓「支出」有意義;小額、可調;finance.ts 月租金流也引用)
export const BASE_UPKEEP = 250;
export const PER_ROOM_UPKEEP = 100;

// 收入強化(可調):入住押金月數、每台投幣洗衣機的每日每房收入、一次性開辦補助
export const DEPOSIT_MONTHS = 1; // 入住押金 = 幾個月租金(招租一次性收入)
export const WASHER_DAILY_PER_ROOM = 50; // 每台投幣洗衣機、每有一間住人房的每日被動收入
export const STARTER_BONUS = 30000; // 開辦補助金(每個存檔只發一次)

/** 投幣洗衣機的每日被動收入:台數 × 每房收入 × 住人房數(租客越多、機台越多,賺越多) */
export function coinLaundryIncome(): number {
  const washers = getPlacements().filter((p) => p.defId === "laundry_washer").length;
  const rooms = Object.keys(state.occupancy).length;
  return washers * WASHER_DAILY_PER_ROOM * rooms;
}

/** 開辦補助金:每個存檔只發一次(現有存檔下次載入也會補到);冪等 */
export function grantStarterBonus() {
  if (state.starterBonusGiven) return;
  state.starterBonusGiven = true;
  addMoney(STARTER_BONUS, "開辦補助金", "other");
  save();
}

// ---------------------------------------------------------------------------
// 租客錢包與繳租戲劇(路線圖中型深化第 3 項):
// 租客有自己的財務——薪水入帳、生活開銷、從錢包繳租;偶發「財務困難」讓收入中斷,
// 錢包見底就欠租,欠滿門檻上門求情(寬限/催繳/一筆勾銷),回穩後自動補繳,
// 曾被寬限的補清時會留下感激記憶。收租從按鈕變成劇情來源。
// 量尺全以「日租」為基準(房租約占收入 1/3),旋鈕都在下面常數。
// ---------------------------------------------------------------------------

export const WALLET_INCOME_FACTOR = 3; // 日收入 = 日租 × 3
export const WALLET_LIVING_FACTOR = 1.6; // 日常開銷 = 日租 × 1.6(正常);拮据時縮衣節食 × 1.1
export const WALLET_CAP_MONTHS = 3; // 錢包上限 = 3 個月租金(避免無限累積)
export const WALLET_INIT_MONTHS = 1.5; // 初始/舊存檔補登的錢包 = 1.5 個月租金
export const HARDSHIP_CHANCE = 0.04; // 每日陷入財務困難的機率(冷卻後才會再擲)
export const HARDSHIP_COOLDOWN_DAYS = 12;
export const PLEA_ARREARS_DAILY = 3; // 欠滿 3 天日租 → 上門求情
export const PLEA_COOLDOWN_DAYS = 6;
export const GRACE_DAYS = 7; // 寬限期長度
const REPAY_BUFFER_DAILY = 5; // 補繳時錢包至少留 5 天日租當生活費

const dailyRentOf = (rt: TenantRuntime) => Math.round(rt.tenant.finance.monthlyRent / 30);

/** 幫還沒有錢包的租客初始化(存檔載入/新入住都會補;冪等) */
export function ensureWallets() {
  for (const rt of Object.values(state.runtimes)) {
    if (typeof rt.wallet !== "number") rt.wallet = Math.round(rt.tenant.finance.monthlyRent * WALLET_INIT_MONTHS);
    rt.arrears ??= 0;
    rt.hardshipUntilDay ??= -99;
    rt.lastHardshipDay ??= -99;
    rt.rentGraceUntilDay ??= -99;
    rt.lastRentPleaDay ??= -99;
  }
}

export const inHardship = (rt: TenantRuntime) => gameDayIndex() <= (rt.hardshipUntilDay ?? -99);

/** 讓租客陷入財務困難 N 天(收入中斷);測試與擲骰共用 */
export function triggerHardship(rt: TenantRuntime, days: number) {
  const day = gameDayIndex();
  rt.hardshipUntilDay = day + days;
  rt.lastHardshipDay = day;
  rt.tenant.stats.stress = clamp(rt.tenant.stats.stress + 8, 0, 100);
  pushMemory(rt.tenant, "[手頭拮据]", "工作出了狀況,收入斷了,連吃飯都要省著來", "ai_event");
  pushSocialLog(rt, "💼 工作出了狀況,這陣子收入斷了——看他連外送都不敢叫了。", "major");
}

/** AI 敘事 context 用的一句話財務狀況(null = 一切正常,不進 prompt) */
export function tenantFinanceBrief(rt: TenantRuntime): string | null {
  const arrears = rt.arrears ?? 0;
  if (arrears > 0) {
    const grace = gameDayIndex() <= (rt.rentGraceUntilDay ?? -99);
    return `欠租 $${arrears}${grace ? "(房東已答應寬限)" : ""}`;
  }
  if (inHardship(rt)) return "手頭拮据(收入暫時中斷,省吃儉用中)";
  return null;
}

/** 繳租求情事件(玩家拍板;rentAction 由 tenancy.applyEffect 呼叫 applyRentAction) */
function buildRentPleaEvent(rt: TenantRuntime): EventDef {
  const arrears = rt.arrears ?? 0;
  return {
    id: "rent_plea",
    title: "繳不出房租",
    description: `${rt.tenant.name} 紅著臉來找你:「這陣子手頭真的太緊,欠的 $${arrears} 我一定會補上……能不能寬限幾天?」`,
    choices: [
      { id: "grace", label: "寬限幾天", hint: "等他手頭回穩再補(他會記得這份情)", effect: { stress: -8, affinity: 6, rentAction: "grace" } },
      {
        id: "collect", label: "現在就催繳", hint: "把他錢包裡剩的錢先拿來抵欠款",
        effect: { stress: 12, affinity: -10, satisfaction: -8, memory: { label: "[被催繳的難堪]", hint: "房東把話說得很難聽,那種難堪一直記著" }, rentAction: "collect" },
      },
      {
        id: "forgive", label: "這筆就算了", hint: "欠款一筆勾銷(這筆錢收不回來)",
        effect: { mood: 8, affinity: 14, memory: { label: "[房東免了欠租]", hint: "房東大方免了欠款,打從心裡感激" }, rentAction: "forgive" },
      },
    ],
  };
}

/** 套用繳租求情的處置(tenancy.decide → applyEffect 呼叫) */
export function applyRentAction(rt: TenantRuntime, action: "grace" | "collect" | "forgive") {
  const day = gameDayIndex();
  if (action === "grace") {
    rt.rentGraceUntilDay = day + GRACE_DAYS;
    pushSocialLog(rt, `🤝 房東答應寬限幾天,他鬆了一口氣,連聲道謝。`, "notable");
  } else if (action === "collect") {
    const pay = Math.min(rt.wallet ?? 0, rt.arrears ?? 0);
    if (pay > 0) {
      rt.wallet = (rt.wallet ?? 0) - pay;
      rt.arrears = (rt.arrears ?? 0) - pay;
      addMoney(pay, `${rt.tenant.name} 被催繳欠租`, "rent");
    }
    pushSocialLog(rt, `😞 被房東催繳,把錢包翻出來湊了 $${pay},剩下的欠款還壓在心上。`, "major");
  } else {
    const waived = rt.arrears ?? 0;
    rt.arrears = 0;
    rt.rentGraceUntilDay = -99;
    pushSocialLog(rt, `🕊️ 房東把 $${waived} 的欠款一筆勾銷,他愣了幾秒才反應過來,眼眶有點紅。`, "major");
  }
}

/** 每日錢包流程(collectRent 內逐人呼叫):薪水/開銷 → 困難擲骰與回穩 → 回傳今天可動用的錢包 */
function walletDailyPass(rt: TenantRuntime): void {
  const day = gameDayIndex();
  const daily = dailyRentOf(rt);
  // 困難回穩:期限已過 → 收入恢復,留一筆日誌(只觸發一次)
  if ((rt.hardshipUntilDay ?? -99) !== -99 && day > rt.hardshipUntilDay!) {
    rt.hardshipUntilDay = -99;
    pushSocialLog(rt, "💼 工作總算回穩了,收入恢復,整個人踏實不少。", "notable");
  }
  const broke = inHardship(rt);
  // 薪水與生活開銷(拮据時收入 0、縮衣節食)
  const income = broke ? 0 : daily * WALLET_INCOME_FACTOR;
  const living = Math.round(daily * (broke ? 1.1 : WALLET_LIVING_FACTOR));
  const cap = rt.tenant.finance.monthlyRent * WALLET_CAP_MONTHS;
  rt.wallet = clamp((rt.wallet ?? 0) + income - living, 0, cap);
  // 財務困難擲骰(不在困難中、冷卻已過、入住滿 5 遊戲日)
  const settled = Math.floor((state.gameMs - rt.moveInMs) / (24 * 3600 * 1000)) >= 5;
  if (!broke && settled && day - (rt.lastHardshipDay ?? -99) >= HARDSHIP_COOLDOWN_DAYS && Math.random() < HARDSHIP_CHANCE) {
    triggerHardship(rt, 4 + Math.floor(Math.random() * 4)); // 4~7 天
  }
}

/** 補繳與求情(繳租後呼叫):錢包回穩自動補欠款;欠滿門檻且無寬限 → 掛求情事件 */
function arrearsPass(rt: TenantRuntime): void {
  const day = gameDayIndex();
  const daily = dailyRentOf(rt);
  const arrears = rt.arrears ?? 0;
  if (arrears <= 0) return;
  // 自動補繳:錢包超過安全水位(留 5 天日租當生活費)就先還欠款
  const spare = (rt.wallet ?? 0) - daily * REPAY_BUFFER_DAILY;
  if (spare > 0) {
    const repay = Math.min(arrears, spare);
    rt.wallet = (rt.wallet ?? 0) - repay;
    rt.arrears = arrears - repay;
    addMoney(repay, `${rt.tenant.name} 補繳欠租`, "rent");
    if ((rt.arrears ?? 0) === 0) {
      pushSocialLog(rt, `💸 把之前欠的房租全數補上了,心裡的石頭總算放下。`, "major");
      if ((rt.rentGraceUntilDay ?? -99) !== -99) {
        // 曾被寬限 → 補清時轉成感激(記憶 + 好感;這就是「把租客照顧好」的回報)
        rt.rentGraceUntilDay = -99;
        rt.tenant.stats.affinity = clamp(rt.tenant.stats.affinity + 10, 0, 100);
        pushMemory(rt.tenant, "[房東寬限的恩情]", "最難的時候房東願意等,這份情記在心裡,很感激", "landlord_decision");
        notify(`💸 ${rt.tenant.name} 補清了欠租,對你的寬限心存感激`);
      }
      return;
    }
  }
  // 求情事件:欠滿門檻、無待決事件、寬限期外、冷卻已過
  const graceActive = day <= (rt.rentGraceUntilDay ?? -99);
  if ((rt.arrears ?? 0) >= daily * PLEA_ARREARS_DAILY && !rt.pendingEvent && !graceActive && day - (rt.lastRentPleaDay ?? -99) >= PLEA_COOLDOWN_DAYS) {
    rt.pendingEvent = buildRentPleaEvent(rt);
    rt.lastRentPleaDay = day;
    notify(`💸 ${rt.tenant.name} 繳不出房租,上門求情了`);
  }
}

/** 唯一的金錢異動入口:改餘額(下限 0)+ 記一筆帳(記錄實際變動) */
export function addMoney(amount: number, label: string, category: TxnCategory) {
  const before = state.money;
  state.money = Math.max(0, state.money + amount);
  const actual = state.money - before;
  if (actual === 0) return;
  state.ledger.push({ gameMs: state.gameMs, label, amount: actual, category });
  if (state.ledger.length > LEDGER_CAP) state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
}

/** 每日收租(遊戲日換日時觸發):日租 = 月租/30,依付租能力與好感調整;
 *  租客從自己的錢包付租——錢包見底才是真正的欠租(進 arrears、可能上門求情)。 */
export function collectRent() {
  ensureWallets();
  for (const rt of Object.values(state.runtimes)) {
    if (state.cohabits[rt.tenant.id]) continue; // 同居者不另收租(同意同居時已說好少一份租)
    walletDailyPass(rt); // 薪水入帳/生活開銷/財務困難擲骰與回穩
    const f = rt.tenant.finance;
    const daily = Math.round(f.monthlyRent / 30);
    const factor =
      clamp(f.paymentReliability + (rt.tenant.stats.affinity - 50) * 0.3 + (rt.satisfaction - 50) * 0.2, 0, 100) / 100;
    const willing = Math.round(daily * factor); // 「願意」繳多少(既有意願公式)
    const paid = Math.min(willing, rt.wallet ?? 0); // 「付得出」多少(錢包上限)
    rt.wallet = (rt.wallet ?? 0) - paid;
    const shortByMoney = willing - paid; // 錢包不夠造成的短繳 → 記成欠租(意願性短繳維持既有邏輯,不列欠)
    if (shortByMoney > 0) rt.arrears = (rt.arrears ?? 0) + shortByMoney;
    if (paid > 0) addMoney(paid, `${rt.tenant.name} 房租`, "rent");
    const full = paid >= daily * 0.95;
    // 被動好感涓流:住得滿意又準時繳清 → 對房東的好感慢慢累積。
    // 這是正向循環的起點——好感↑ 會讓收租公式的租金跟著回升(把租客照顧好,錢自然變快)。
    if (full && rt.satisfaction >= 55) {
      const gain = rt.satisfaction >= 75 ? 1 : 0.6;
      rt.tenant.stats.affinity = clamp(rt.tenant.stats.affinity + gain, 0, 100);
    }
    rt.log.push({
      gameMs: state.gameMs,
      timeLabel: fmt(state.gameMs),
      text: full
        ? `準時繳清今日房租 $${paid}。`
        : shortByMoney > 0
          ? `💸 錢包見底,只繳得出 $${paid},又欠下 $${shortByMoney}(累計 $${rt.arrears})。`
          : `今日只繳了部分房租 $${paid},其餘拖欠。`,
      visualState: rt.tenant.visualState,
      importance: shortByMoney > 0 ? "notable" : paid < daily * 0.6 ? "notable" : "minor",
    });
    if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
    arrearsPass(rt); // 回穩自動補繳(曾寬限 → 感激);欠滿門檻 → 上門求情
  }
  // 投幣洗衣機被動收入(有租客投幣使用;買越多台賺越多)
  const coin = coinLaundryIncome();
  if (coin > 0) addMoney(coin, "投幣洗衣機收入", "other");
  // 每日管理費(水電/清潔/公共維護)
  const upkeep = BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP;
  addMoney(-upkeep, "管理費 / 水電", "upkeep");
}

/** 購買並擺放一件家具到指定房間 */
export function buyFurniture(defId: string, roomId: string): { ok: boolean; reason?: string } {
  const def = getDef(defId);
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  const slot = findFreeSlot(roomId, def.footprint.w, def.footprint.h);
  if (!slot) return { ok: false, reason: "房間沒有空位" };
  addPlacement({ defId, room: roomId, c: slot.c, r: slot.r, rotation: 0 });
  addMoney(-def.price, `購買 ${def.name}`, "furniture");
  save();
  return { ok: true };
}

/** 進入擺放模式:選好家具、待點地圖決定位置(此時尚未扣款) */
export function startPlacing(defId: string): { ok: boolean; reason?: string } {
  if (state.money < getDef(defId).price) return { ok: false, reason: "金錢不足" };
  state.pendingPlace = defId;
  state.pendingRotation = 0;
  return { ok: true };
}

export function cancelPlacing() {
  state.pendingPlace = null;
  state.pendingRotation = 0;
}

/** 擺放／移動中的家具順時針旋轉 90°。 */
export function rotatePendingFurniture(): boolean {
  if (!state.pendingPlace && !state.pendingMove) return false;
  state.pendingRotation = nextRotation(state.pendingRotation);
  return true;
}

/** 在指定格擺放待放置的家具(扣款) */
export function placeAt(c: number, r: number): { ok: boolean; reason?: string } {
  const defId = state.pendingPlace;
  if (!defId) return { ok: false, reason: "沒有待擺放的家具" };
  const def = getDef(defId);
  const fp = rotatedFootprint(def, state.pendingRotation);
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  const room = canPlaceFree(c, r, fp.w, fp.h);
  if (!room) return { ok: false, reason: "這裡放不下(壓到牆/家具或跨房間)" };
  addPlacement({ defId, room, c, r, rotation: state.pendingRotation });
  addMoney(-def.price, `擺放 ${def.name}`, "furniture");
  state.pendingPlace = null;
  state.pendingRotation = 0;
  save();
  return { ok: true };
}

/** 進入家具移動模式:記下這件家具的原位,等玩家點地圖選新位置(免費,家具已是玩家資產) */
export function startMoving(c: number, r: number): { ok: boolean } {
  const p = furnitureAt(c, r);
  if (!p) return { ok: false };
  const rotation = placementRotation(p);
  state.pendingMove = { c: p.c, r: p.r, defId: p.defId, rotation };
  state.pendingRotation = rotation;
  state.pendingPlace = null; // 移動與擺放互斥
  return { ok: true };
}

export function cancelMoving() {
  state.pendingMove = null;
  state.pendingRotation = 0;
}

/** 把待移動的家具搬到 (c,r):判定新位置(排除自己的舊佔位)→ 成功才真的搬 */
export function moveFurnitureTo(c: number, r: number): { ok: boolean; reason?: string } {
  const mv = state.pendingMove;
  if (!mv) return { ok: false, reason: "沒有待移動的家具" };
  const def = getDef(mv.defId);
  const fp = rotatedFootprint(def, state.pendingRotation);
  // 判定時排除自己,否則會被自己的舊佔位擋住
  const room = canPlaceFree(c, r, fp.w, fp.h, { c: mv.c, r: mv.r });
  if (!room) return { ok: false, reason: "這裡放不下(壓到牆/家具或跨房間)" };
  const original = removePlacementAt(mv.c, mv.r);
  if (!original) {
    state.pendingMove = null;
    state.pendingRotation = 0;
    return { ok: false, reason: "找不到這件家具" };
  }
  addPlacement({ defId: mv.defId, room, c, r, rotation: state.pendingRotation });
  state.pendingMove = null;
  state.pendingRotation = 0;
  // 全員重新定位:有租客正走向這件家具時,下一步改走新位置
  const hour = new Date(state.gameMs).getHours();
  for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
  save();
  return { ok: true };
}

/** 擺放/移動預覽判定:目前待處理的家具能否落在 (c,r)(只判定、不成交) */
export function canDropAt(c: number, r: number): boolean {
  if (state.pendingMove) {
    const def = getDef(state.pendingMove.defId);
    const fp = rotatedFootprint(def, state.pendingRotation);
    return canPlaceFree(c, r, fp.w, fp.h, { c: state.pendingMove.c, r: state.pendingMove.r }) !== null;
  }
  if (state.pendingPlace) {
    const def = getDef(state.pendingPlace);
    const fp = rotatedFootprint(def, state.pendingRotation);
    return canPlaceFree(c, r, fp.w, fp.h) !== null;
  }
  return false;
}

/** 購買一次性房間升級改建(7-1 升級階梯:大額投資、不可退、永久生效) */
export function buyUpgrade(roomId: string, upgradeId: string): { ok: boolean; reason?: string } {
  const def = getUpgradeDef(upgradeId);
  if (!def) return { ok: false, reason: "沒有這種改建" };
  if (roomUpgradeIds(roomId).includes(upgradeId)) return { ok: false, reason: "這間房已經做過這項改建" };
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  addMoney(-def.price, `改建:${roomId.replace(/^r/, "")} 房${def.name}`, "upgrade");
  (upgradeState.byRoom[roomId] ??= []).push(upgradeId);
  // 在住租客:住的房變好了,立即有感(滿意/心情↑ + 記憶,AI 也能拿去寫)
  const tid = state.occupancy[roomId];
  const rt = tid ? state.runtimes[tid] : null;
  if (rt) {
    rt.satisfaction = clamp(rt.satisfaction + 10, 0, 100);
    rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 8, 0, 100);
    rt.tenant.stats.affinity = clamp(rt.tenant.stats.affinity + 8, 0, 100); // 花錢改善居住 → 對房東好感直接上升
    rt.unhappyHours = 0;
    pushMemory(rt.tenant, `[房間${def.name}了]`, `房東花大錢幫房間做了${def.name},住起來明顯升級,心存感激。`, "landlord_decision");
    pushSocialLog(rt, `${def.icon} 房東幫房間做了「${def.name}」,整個空間質感都不一樣了!`, "major");
    // 隔音類改建:清掉「被噪音困擾」的記憶,否則裝了隔音還一直顯示困擾
    if ((def.attributes.soundproof ?? 0) > 0 && clearNoiseMemories(rt.tenant).length > 0) {
      rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 8, 0, 100);
      pushSocialLog(rt, `🔇 隔音做好之後,終於不再被噪音吵到,睡得安穩多了。`, "notable");
    }
  }
  notify(`${def.icon} ${roomId.replace(/^r/, "")} 房完成「${def.name}」改建`);
  save();
  return { ok: true };
}

/** 賣掉某格上的家具(退回半價) */
export function sellFurnitureAt(c: number, r: number): { ok: boolean; refund?: number } {
  const removed = removePlacementAt(c, r);
  if (!removed) return { ok: false };
  const def = getDef(removed.defId);
  const refund = Math.round(def.price * 0.5);
  addMoney(refund, `賣出 ${def.name}`, "furniture");
  save();
  return { ok: true, refund };
}
