/**
 * 行為指令白名單(設計檢討 7-2:讓 AI 事件「看得見」)。
 *
 * AI 事件選項(或規則事件)可以附一個 directive:租客接下來 N 遊戲日的
 * 「行為改變」——全部是既有 visualState/作息/props 的組合,AI 只能從
 * 這個固定白名單裡選,不能發明機制;經玩家抉擇拍板後才生效。
 * 實際套用在 tick.applyHour(作息位移/改目標/加 props)。
 */

export type DirectiveId =
  | "night_owl" | "early_bird" | "hermit" | "social" | "adopt_cat" | "binge_watch"
  | "comfort_seek" | "overtime" | "self_care" | "sulk";

export interface DirectiveDef {
  id: DirectiveId;
  /** UI chip 顯示(房間細看) */
  label: string;
  /** 生效當下寫進日誌 */
  startText: string;
  /** 到期恢復時寫進日誌 */
  endText: string;
  defaultDays: number;
}

export const DIRECTIVES: Record<DirectiveId, DirectiveDef> = {
  night_owl: {
    id: "night_owl",
    label: "🌙 作息大亂(熬夜中)",
    startText: "🌙 開始熬夜——整個作息往後推了三個小時。",
    endText: "🌅 熬夜的日子結束了,作息慢慢調回來。",
    defaultDays: 3,
  },
  early_bird: {
    id: "early_bird",
    label: "🌅 早睡早起中",
    startText: "🌅 決定早睡早起,整個作息提前了兩個小時。",
    endText: "作息回到了原本的節奏。",
    defaultDays: 3,
  },
  hermit: {
    id: "hermit",
    label: "🚪 閉門不出",
    startText: "🚪 開始迴避大家——刻意不去交誼廳了。",
    endText: "終於願意再踏進交誼廳了。",
    defaultDays: 3,
  },
  social: {
    id: "social",
    label: "🎉 熱衷社交",
    startText: "🎉 最近特別想找人說話,傍晚都泡在交誼廳。",
    endText: "社交熱潮退了,回到自己的步調。",
    defaultDays: 3,
  },
  adopt_cat: {
    id: "adopt_cat",
    label: "🐱 房裡有貓",
    startText: "🐱 房間裡多了一隻貓,每晚都要陪牠玩一陣子。",
    endText: "貓咪的新鮮感過了,回歸日常(貓還在)。",
    defaultDays: 5,
  },
  binge_watch: {
    id: "binge_watch",
    label: "📺 追劇成癮",
    startText: "📺 掉進一部新劇的坑,每天深夜都黏在螢幕前。",
    endText: "劇追完了,深夜終於捨得睡了。",
    defaultDays: 3,
  },
  comfort_seek: {
    id: "comfort_seek",
    label: "🫂 想找人談心",
    startText: "🫂 心裡悶著事,一有空就想往朋友房裡跑。",
    endText: "心裡的結解開了些,不再急著找人說話。",
    defaultDays: 2,
  },
  overtime: {
    id: "overtime",
    label: "💼 加班晚歸",
    startText: "💼 工作堆起來了,晚上還釘在書桌前趕進度。",
    endText: "趕完這一波,晚上終於能喘口氣了。",
    defaultDays: 2,
  },
  self_care: {
    id: "self_care",
    label: "🌿 好好照顧自己",
    startText: "🌿 決定好好照顧自己,這幾天都提早上床休息。",
    endText: "把自己養回來了,作息回到原本的樣子。",
    defaultDays: 2,
  },
  sulk: {
    id: "sulk",
    label: "🌧️ 悶悶不樂",
    startText: "🌧️ 悶悶不樂地縮回自己的世界,不主動找任何人。",
    endText: "情緒過去了,願意再跟大家往來。",
    defaultDays: 2,
  },
};

/** 進行中的行為指令(存進 TenantRuntime、入存檔) */
export interface ActiveDirective {
  id: DirectiveId;
  /** 持續到哪個遊戲日(含) */
  untilDay: number;
  /** 來源:choice=玩家事件拍板(預設;舊存檔缺省)、ai=AI 觀察的自發行為 */
  source?: "choice" | "ai";
}

/** 消毒:id 必須在白名單、days 夾 1~7;不合格回 null(直接丟棄,AI 不能發明指令) */
export function sanitizeDirective(raw: unknown): { id: DirectiveId; days: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id in DIRECTIVES ? (r.id as DirectiveId) : null;
  if (!id) return null;
  const d = typeof r.days === "number" && isFinite(r.days) ? Math.round(r.days) : DIRECTIVES[id].defaultDays;
  return { id, days: Math.min(7, Math.max(1, d)) };
}

/** 自發行為(AI 觀察回饋第二期)可用的子集:adopt_cat 是真的領養寵物、
 *  影響經濟與存檔狀態,屬「房東層級」的決定,一律走玩家拍板的 event,不開放自發。 */
const SELF_BEHAVIOR_IDS = new Set<DirectiveId>([
  "night_owl", "early_bird", "hermit", "social", "binge_watch",
  "comfort_seek", "overtime", "self_care", "sulk",
]);

/** 消毒自發行為:id 限自發子集、days 夾 1~2(比玩家拍板的 1~7 更短);不合格回 null */
export function sanitizeSelfBehavior(raw: unknown): { id: DirectiveId; days: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && SELF_BEHAVIOR_IDS.has(r.id as DirectiveId) ? (r.id as DirectiveId) : null;
  if (!id) return null;
  const d = typeof r.days === "number" && isFinite(r.days) ? Math.round(r.days) : 1;
  return { id, days: Math.min(2, Math.max(1, d)) };
}
