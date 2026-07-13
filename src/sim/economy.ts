/**
 * 經濟(store 拆分:economy 模組)。
 * 金錢進出唯一入口 addMoney()(分類記帳)、每日收租與管理費、
 * 家具的買/擺/移/賣(含 8-2 預覽判定 canDropAt)。
 */
import { getDef } from "../furniture/catalog";
import { addPlacement, removePlacementAt, findFreeSlot, canPlaceFree, furnitureAt, getPlacements } from "./placements";
import { getUpgradeDef, roomUpgradeIds, upgradeState } from "./upgrades";
import { state, clamp, fmt, notify, pushMemory, pushSocialLog, LOG_CAP, LEDGER_CAP, type TxnCategory } from "./gameState";
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

/** 唯一的金錢異動入口:改餘額(下限 0)+ 記一筆帳(記錄實際變動) */
export function addMoney(amount: number, label: string, category: TxnCategory) {
  const before = state.money;
  state.money = Math.max(0, state.money + amount);
  const actual = state.money - before;
  if (actual === 0) return;
  state.ledger.push({ gameMs: state.gameMs, label, amount: actual, category });
  if (state.ledger.length > LEDGER_CAP) state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
}

/** 每日收租(遊戲日換日時觸發):日租 = 月租/30,依付租能力與好感調整 */
export function collectRent() {
  for (const rt of Object.values(state.runtimes)) {
    if (state.cohabits[rt.tenant.id]) continue; // 同居者不另收租(同意同居時已說好少一份租)
    const f = rt.tenant.finance;
    const daily = Math.round(f.monthlyRent / 30);
    const factor =
      clamp(f.paymentReliability + (rt.tenant.stats.affinity - 50) * 0.3 + (rt.satisfaction - 50) * 0.2, 0, 100) / 100;
    const paid = Math.round(daily * factor);
    addMoney(paid, `${rt.tenant.name} 房租`, "rent");
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
      text: full ? `準時繳清今日房租 $${paid}。` : `今日只繳了部分房租 $${paid},其餘拖欠。`,
      visualState: rt.tenant.visualState,
      importance: paid < daily * 0.6 ? "notable" : "minor",
    });
    if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
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
  addPlacement({ defId, room: roomId, c: slot.c, r: slot.r });
  addMoney(-def.price, `購買 ${def.name}`, "furniture");
  save();
  return { ok: true };
}

/** 進入擺放模式:選好家具、待點地圖決定位置(此時尚未扣款) */
export function startPlacing(defId: string): { ok: boolean; reason?: string } {
  if (state.money < getDef(defId).price) return { ok: false, reason: "金錢不足" };
  state.pendingPlace = defId;
  return { ok: true };
}

export function cancelPlacing() {
  state.pendingPlace = null;
}

/** 在指定格擺放待放置的家具(扣款) */
export function placeAt(c: number, r: number): { ok: boolean; reason?: string } {
  const defId = state.pendingPlace;
  if (!defId) return { ok: false, reason: "沒有待擺放的家具" };
  const def = getDef(defId);
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  const room = canPlaceFree(c, r, def.footprint.w, def.footprint.h);
  if (!room) return { ok: false, reason: "這裡放不下(壓到牆/家具或跨房間)" };
  addPlacement({ defId, room, c, r });
  addMoney(-def.price, `擺放 ${def.name}`, "furniture");
  state.pendingPlace = null;
  save();
  return { ok: true };
}

/** 進入家具移動模式:記下這件家具的原位,等玩家點地圖選新位置(免費,家具已是玩家資產) */
export function startMoving(c: number, r: number): { ok: boolean } {
  const p = furnitureAt(c, r);
  if (!p) return { ok: false };
  state.pendingMove = { c: p.c, r: p.r, defId: p.defId };
  state.pendingPlace = null; // 移動與擺放互斥
  return { ok: true };
}

export function cancelMoving() {
  state.pendingMove = null;
}

/** 把待移動的家具搬到 (c,r):判定新位置(排除自己的舊佔位)→ 成功才真的搬 */
export function moveFurnitureTo(c: number, r: number): { ok: boolean; reason?: string } {
  const mv = state.pendingMove;
  if (!mv) return { ok: false, reason: "沒有待移動的家具" };
  const def = getDef(mv.defId);
  // 判定時排除自己,否則會被自己的舊佔位擋住
  const room = canPlaceFree(c, r, def.footprint.w, def.footprint.h, { c: mv.c, r: mv.r });
  if (!room) return { ok: false, reason: "這裡放不下(壓到牆/家具或跨房間)" };
  const original = removePlacementAt(mv.c, mv.r);
  if (!original) {
    state.pendingMove = null;
    return { ok: false, reason: "找不到這件家具" };
  }
  addPlacement({ defId: mv.defId, room, c, r });
  state.pendingMove = null;
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
    return canPlaceFree(c, r, def.footprint.w, def.footprint.h, { c: state.pendingMove.c, r: state.pendingMove.r }) !== null;
  }
  if (state.pendingPlace) {
    const def = getDef(state.pendingPlace);
    return canPlaceFree(c, r, def.footprint.w, def.footprint.h) !== null;
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
