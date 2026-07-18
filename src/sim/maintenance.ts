/**
 * 維修/損壞系統(設計檢討 §7-1):讓「支出」也有決策性。
 * 每遊戲日對有人住的房間擲骰,小機率壞掉一項設備(熱水器/漏水/冷氣/電路);
 * 玩家可立刻花錢修,或拖延——拖一天,住戶滿意度/心情就掉一天(接既有退租壓力線)。
 * 一間房同時最多一件故障;故障入存檔;修理走 addMoney 記帳(upkeep)。
 * 也是之後「打架 → 家具損壞」(§10-2)的落地出口。
 */
import { state, clamp, notify, pushSocialLog, roomOfTenant, type TenantRuntime } from "./gameState";
import { addMoney } from "./economy";
import { save } from "./persistence";

export interface BreakdownDef {
  id: string;
  label: string;
  icon: string;
  /** true = 只由事件觸發(打架/AI 事件),每日隨機擲骰不會抽到 */
  eventOnly?: boolean;
  /** 修理費區間(觸發時擲定、記在 ActiveBreakdown 上) */
  cost: [number, number];
  /** 拖延一天,該房住戶的懲罰 */
  perDay: { satisfaction: number; mood: number };
  /** 壞掉當下的住戶日誌 */
  breakLine: string;
  /** 拖延期間每天輪播的抱怨日誌 */
  sufferLines: string[];
}

export const BREAKDOWNS: BreakdownDef[] = [
  {
    id: "water_heater",
    label: "熱水器故障",
    icon: "🚿",
    cost: [1200, 2200],
    perDay: { satisfaction: -7, mood: -4 },
    breakLine: "洗澡洗到一半突然變冷水,熱水器壞了!",
    sufferLines: ["又是冷水澡,洗得直發抖。", "為了熱水澡特地跑去洗衣間燒水,快受不了了。"],
  },
  {
    id: "leak",
    label: "天花板漏水",
    icon: "💧",
    cost: [1800, 3200],
    perDay: { satisfaction: -8, mood: -4 },
    breakLine: "天花板開始滴水,地上擺了三個接水的盆子。",
    sufferLines: ["半夜被滴水聲吵醒,盆子又滿了。", "牆角的水漬越來越大,東西都不敢靠牆放。"],
  },
  {
    id: "aircon",
    label: "冷氣故障",
    icon: "🌀",
    cost: [1500, 2600],
    perDay: { satisfaction: -6, mood: -5 },
    breakLine: "冷氣發出怪聲後就再也吹不涼了。",
    sufferLines: ["房間悶得像蒸籠,整晚翻來覆去。", "只能開著窗戶硬撐,吵得沒法專心。"],
  },
  {
    id: "wiring",
    label: "電路跳電",
    icon: "⚡",
    cost: [900, 1800],
    perDay: { satisfaction: -6, mood: -3 },
    breakLine: "插座一插吹風機就跳電,整間房斷斷續續停電。",
    sufferLines: ["工作到一半又跳電,檔案差點沒存到。", "手機只能拿去交誼廳充電,超不方便。"],
  },
  {
    id: "damage",
    label: "家具毀損",
    icon: "🪑",
    eventOnly: true, // 只由事件觸發(打架 §10-2 / AI 事件),不進每日擲骰
    cost: [800, 1600],
    perDay: { satisfaction: -6, mood: -3 },
    breakLine: "房裡的家具在混亂中被撞壞了,缺角的缺角、散架的散架。",
    sufferLines: ["椅子少了一隻腳,只能墊書硬撐著用。", "看著壞掉的家具就想起那天的事,心情很差。"],
  },
];

export interface ActiveBreakdown {
  defId: string;
  /** 擲定的修理費 */
  cost: number;
  /** 壞掉時的 gameMs(算拖延天數用) */
  sinceMs: number;
}

/** 每間有人住的房,每遊戲日壞掉的機率 */
export const BREAK_CHANCE = 0.02;

export function getBreakdownDef(defId: string): BreakdownDef | null {
  return BREAKDOWNS.find((b) => b.id === defId) ?? null;
}

/** 這間房住的人(承租人 + 同居者) */
function occupantsOf(roomId: string): TenantRuntime[] {
  return Object.values(state.runtimes).filter((rt) => roomOfTenant(rt.tenant.id) === roomId);
}

/** 觸發一件故障(每日擲骰或之後的事件/打架都走這裡);該房已有故障則不疊加 */
export function triggerBreakdown(roomId: string, defId?: string, rng: () => number = Math.random): boolean {
  if (state.breakdowns[roomId]) return false;
  const pool = BREAKDOWNS.filter((b) => !b.eventOnly);
  const def = defId ? getBreakdownDef(defId) : pool[Math.floor(rng() * pool.length)];
  if (!def) return false;
  const [lo, hi] = def.cost;
  const cost = Math.round((lo + rng() * (hi - lo)) / 100) * 100;
  state.breakdowns[roomId] = { defId: def.id, cost, sinceMs: state.gameMs };
  for (const rt of occupantsOf(roomId)) {
    pushSocialLog(rt, `${def.icon} ${def.breakLine}`, "major");
    rt.satisfaction = clamp(rt.satisfaction - 6, 0, 100);
  }
  notify(`${def.icon} ${roomId.replace(/^r/, "")} 房${def.label}!修理費約 $${cost.toLocaleString()},拖著不修住戶會越住越不滿`);
  return true;
}

/** 每遊戲日呼叫:先算拖延懲罰(壞著的每一天都痛),再擲新故障 */
export function maintenancePass(rng: () => number = Math.random) {
  // 1) 拖延懲罰:滿意度/心情持續掉 + 抱怨日誌(住戶不滿線會自然接到退租壓力)
  for (const [roomId, bd] of Object.entries(state.breakdowns)) {
    const def = getBreakdownDef(bd.defId);
    if (!def) continue;
    for (const rt of occupantsOf(roomId)) {
      rt.satisfaction = clamp(rt.satisfaction + def.perDay.satisfaction, 0, 100);
      rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + def.perDay.mood, 0, 100);
      const line = def.sufferLines[Math.floor(rng() * def.sufferLines.length)];
      pushSocialLog(rt, `${def.icon} ${line}`, "notable");
    }
  }
  // 2) 新故障:只擲有人住的房(空房沒人用設備,也沒人回報)
  for (const roomId of Object.keys(state.occupancy)) {
    if (rng() < BREAK_CHANCE) triggerBreakdown(roomId, undefined, rng);
  }
}

/** 修理:扣錢(upkeep 記帳)→ 移除故障 → 住戶立即有感 */
export function repairBreakdown(roomId: string): { ok: boolean; reason?: string } {
  const bd = state.breakdowns[roomId];
  if (!bd) return { ok: false, reason: "這間房沒有待修的故障" };
  const def = getBreakdownDef(bd.defId);
  if (!def) {
    delete state.breakdowns[roomId];
    return { ok: false, reason: "故障資料異常,已清除" };
  }
  if (state.money < bd.cost) return { ok: false, reason: "金錢不足" };
  addMoney(-bd.cost, `維修:${roomId.replace(/^r/, "")} 房${def.label}`, "upkeep");
  delete state.breakdowns[roomId];
  for (const rt of occupantsOf(roomId)) {
    rt.satisfaction = clamp(rt.satisfaction + 8, 0, 100);
    rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 5, 0, 100);
    rt.tenant.stats.affinity = clamp(rt.tenant.stats.affinity + 5, 0, 100); // 房東及時修繕 → 好感上升
    pushSocialLog(rt, `🔧 ${def.label}修好了,房東動作真快,終於能正常生活了。`, "notable");
  }
  notify(`🔧 ${roomId.replace(/^r/, "")} 房「${def.label}」已修復(-$${bd.cost.toLocaleString()})`);
  save();
  return { ok: true };
}
