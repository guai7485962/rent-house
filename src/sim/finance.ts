/**
 * 月報表 + 資產淨值(設計檢討 §7-1):給投資線一條「成長曲線」。
 * 純唯讀彙整:現金 + 家具轉售值(半價,和賣出一致)+ 改建投資(成本計,不可退但墊高租金行情)
 * = 資產淨值;月租金流 = 在住承租人月租合計 - 月管理費。全部由現有 state 推導,不入存檔。
 */
import { state } from "./gameState";
import { getPlacements } from "./placements";
import { getDef } from "../furniture/catalog";
import { upgradeState, getUpgradeDef } from "./upgrades";
import { BASE_UPKEEP, PER_ROOM_UPKEEP } from "./economy";

export interface NetWorth {
  cash: number;
  /** 家具轉售值(半價;與賣出退款一致,誠實估值) */
  furniture: number;
  /** 改建投資(成本計;不可退,但永久墊高租金行情) */
  upgrades: number;
  total: number;
}

export function netWorth(): NetWorth {
  const cash = state.money;
  let furniture = 0;
  for (const p of getPlacements()) furniture += Math.round(getDef(p.defId).price * 0.5);
  let upgrades = 0;
  for (const ids of Object.values(upgradeState.byRoom)) {
    for (const id of ids) upgrades += getUpgradeDef(id)?.price ?? 0;
  }
  return { cash, furniture, upgrades, total: cash + furniture + upgrades };
}

export interface MonthlyFlow {
  /** 在住承租人月租合計(名目;同居者不另收租) */
  rentIn: number;
  /** 月管理費(每日基本 300 + 每有人房 150,×30) */
  upkeepOut: number;
  net: number;
}

export function monthlyFlow(): MonthlyFlow {
  let rentIn = 0;
  for (const [, tid] of Object.entries(state.occupancy)) {
    const rt = state.runtimes[tid];
    if (rt) rentIn += rt.tenant.finance.monthlyRent;
  }
  const upkeepOut = (BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP) * 30;
  return { rentIn, upkeepOut, net: rentIn - upkeepOut };
}

export interface MonthReport {
  /** 遊戲時間的當月(1~12) */
  month: number;
  income: number;
  expense: number;
  net: number;
}

/** 本月損益:從 ledger 彙整遊戲時間「這個月」的實際收支 */
export function monthReport(): MonthReport {
  const now = new Date(state.gameMs);
  const first = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let income = 0;
  let expense = 0;
  for (const t of state.ledger) {
    if (t.gameMs < first) continue;
    if (t.amount > 0) income += t.amount;
    else expense -= t.amount;
  }
  return { month: now.getMonth() + 1, income, expense, net: income - expense };
}
