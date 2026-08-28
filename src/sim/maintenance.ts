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

// ---------------------------------------------------------------------------
// 虧待度(neglect):唯一一條「房東虧待房客」會**持續**推動數值的管道
// ---------------------------------------------------------------------------

/**
 * 虧待度的設計上限。
 *
 * 🔴 **僅靠「故障拖延天數」就必須能到達上限**——旗標只是**加速器**,不得是到頂的
 * 必要條件。原設計把上限訂在「拖延 4 分 + 旗標 2 分」,但那個旗標(`答應改善房間`)
 * 的唯一來源是玩家在 `dissatisfied` 事件選 `promise`,而 `dissatisfied` 又要靠
 * 虧待度到頂才觸發 ⇒ **循環相依**,三則事件的可達性證明會全部落空。
 * `scripts/neglect-test.ts` 有一項專門釘住這條回歸鎖。
 */
export const NEGLECT_CAP = 6;

/** 每小時的毫秒數 × 24(故障拖延天數用;`sinceMs` 記的是 `state.gameMs`) */
const NEGLECT_DAY_MS = 24 * 3600 * 1000;

/** 「答應改善房間」旗標:玩家親手按過的空頭支票,+2 只是讓他更快到頂 */
const NEGLECT_PROMISE_FLAG = "答應改善房間";

/**
 * 這位租客目前累積的「虧待度」0~`NEGLECT_CAP`。
 *
 * 設計約束(逐條刻意,不得放寬):
 * 1. **不含任何「什麼都沒做也會發生」的來源**——特別排除「多久沒送宵夜」「多久沒互動」。
 *    每一分都來自玩家**收到過明確通知**(`notify`,見 `triggerBreakdown`)或**親手按過按鈕**。
 * 2. **不新增任何存檔欄位**:`state.breakdowns[].sinceMs` 與 `rt.flags` 都已入檔,
 *    `SAVE_VERSION` 不動。
 * 3. **無虧待時恆等於 0**(所有掛載點都是 `f(neglect)` 且 `f(0)=0`)。
 * 4. **可逆**:`repairBreakdown()` 之後立刻回 0。
 */
export function neglectPoints(rt: TenantRuntime): number {
  const roomId = roomOfTenant(rt.tenant.id);
  if (!roomId) return 0;
  let n = 0;
  const bd = state.breakdowns[roomId];
  if (bd) {
    const days = Math.floor(Math.max(0, state.gameMs - bd.sinceMs) / NEGLECT_DAY_MS);
    n += Math.min(NEGLECT_CAP, days);
  }
  if (rt.flags.includes(NEGLECT_PROMISE_FLAG)) n += 2;
  return Math.min(NEGLECT_CAP, n);
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

/**
 * 虧待每日侵蝕的好感(每點虧待度、每遊戲日)。
 *
 * 🔴 `affinity` 是四條數值裡**唯一沒有回歸**的,所以它必須**每日小量**扣。
 * 掛每小時等於 ×24,兩天就把好感歸零;而掛每日才對得上「及時修繕 +5(永久)」的
 * 對稱面 —— 原本虧待免費、照顧單向加分,這一行就是把那個不對稱補平的地方。
 */
export const NEGLECT_AFFINITY_PER_DAY = 0.25;

/** 每遊戲日呼叫:先算拖延懲罰(壞著的每一天都痛),再擲新故障 */
export function maintenancePass(rng: () => number = Math.random) {
  // 0) 虧待侵蝕好感:無虧待時 neglectPoints 恆為 0 ⇒ 這一段對舊局逐位元無影響
  for (const rt of Object.values(state.runtimes)) {
    const n = neglectPoints(rt);
    if (n > 0) rt.tenant.stats.affinity = clamp(rt.tenant.stats.affinity - NEGLECT_AFFINITY_PER_DAY * n, 0, 100);
  }
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
