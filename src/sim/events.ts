/**
 * 突發事件 + 抉擇系統。
 * 依租客當前狀態(壓力/滿意度)觸發事件,房東抉擇後套用後果。
 * 點亮既有的 DecisionModal + decide() UI(之前做好但沒東西觸發)。
 */

export interface EventEffect {
  affinity?: number;
  stress?: number;
  mood?: number;
  satisfaction?: number;
  money?: number;
  evict?: boolean;
  /** 選項可留下一個新記憶標籤(讓抉擇有長期延續) */
  memory?: { label: string; hint: string };
  /** 對事件牽涉的第二位鄰居的數值影響 */
  other?: { mood?: number; stress?: number; affinity?: number; satisfaction?: number };
  /** 兩人關係變化:delta 正=拉近/戀情加速、負=吵架疏遠;couple/breakup 直接成/斷情侶 */
  rel?: { delta?: number; couple?: boolean; breakup?: boolean };
}

export interface EventChoiceDef {
  id: string;
  label: string;
  hint: string;
  effect: EventEffect;
}

export interface EventDef {
  id: string;
  title: string;
  description: string;
  choices: EventChoiceDef[];
  /** 是否為 AI 依當前處境即時生成(給 UI 標示) */
  ai?: boolean;
  /** 事件牽涉的第二位鄰居(AI 跨租客事件) */
  withId?: string;
  withName?: string;
}

export interface EventCtx {
  name: string;
  stress: number;
  satisfaction: number;
  affinity: number;
}

/** 依狀態決定要不要觸發事件(呼叫端負責冷卻,避免連發) */
export function rollEvent(ctx: EventCtx): EventDef | null {
  if (ctx.stress >= 90) return breakdown(ctx.name);
  if (ctx.satisfaction < 30) return dissatisfied(ctx.name);
  if (ctx.affinity <= 20) return grievance(ctx.name);
  return null;
}

function breakdown(name: string): EventDef {
  return {
    id: "breakdown",
    title: `${name} 快撐不住了`,
    description: `監視器拍到 ${name} 在房間中央來回踱步、掐著手臂——壓力似乎到了臨界點。你要介入嗎?`,
    choices: [
      { id: "care", label: "主動關心", hint: "拉近距離,但可能被嫌多管閒事", effect: { affinity: 8, stress: -18, satisfaction: 5 } },
      { id: "treat", label: "送宵夜慰勞", hint: "花點小錢", effect: { money: -300, stress: -12, affinity: 5 } },
      { id: "space", label: "給他空間", hint: "不打擾,讓他自己消化", effect: { stress: -5 } },
    ],
  };
}

function dissatisfied(name: string): EventDef {
  return {
    id: "dissatisfied",
    title: `${name} 對房間不太滿意`,
    description: `${name} 私下抱怨房間少了他需要的東西,住得不太順心。再放著不管,可能會考慮搬走。`,
    choices: [
      { id: "renovate", label: "撥預算改善", hint: "花錢讓他真的滿意", effect: { money: -2000, satisfaction: 22, affinity: 6 } },
      { id: "promise", label: "口頭承諾改善", hint: "先安撫,治標", effect: { satisfaction: 9 } },
      { id: "ignore", label: "不理會", hint: "省事,但他會更不爽", effect: { satisfaction: -10, affinity: -6 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// AI 生成事件的消毒 + 夾值(安全核心:AI 現在能影響機制,一律在此把關)
// ---------------------------------------------------------------------------

const clampNum = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, cap: number): string => (typeof v === "string" ? v : "").slice(0, cap).trim();

function cleanMemory(v: unknown): { label: string; hint: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = v as Record<string, unknown>;
  const label = str(m.label, 20);
  const hint = str(m.hint, 80);
  return label && hint ? { label, hint } : undefined;
}

function cleanEffect(v: unknown, hasOther: boolean): EventEffect {
  const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const eff: EventEffect = {
    mood: clampNum(e.mood, -25, 25),
    stress: clampNum(e.stress, -25, 25),
    affinity: clampNum(e.affinity, -25, 25),
    satisfaction: clampNum(e.satisfaction, -25, 25),
    money: clampNum(e.money, -5000, 2000),
    // evict 一律不開放給 AI(忽略)
  };
  const mem = cleanMemory(e.memory);
  if (mem) eff.memory = mem;

  // 跨租客欄位:只有事件確實牽涉第二位鄰居(hasOther)才保留
  if (hasOther) {
    const o = (e.other && typeof e.other === "object" ? e.other : {}) as Record<string, unknown>;
    eff.other = {
      mood: clampNum(o.mood, -25, 25),
      stress: clampNum(o.stress, -25, 25),
      affinity: clampNum(o.affinity, -25, 25),
      satisfaction: clampNum(o.satisfaction, -25, 25),
    };
    const rl = (e.rel && typeof e.rel === "object" ? e.rel : {}) as Record<string, unknown>;
    eff.rel = {
      delta: clampNum(rl.delta, -40, 40),
      couple: rl.couple === true,
      breakup: rl.breakup === true,
    };
  }
  return eff;
}

/**
 * 把 AI 回傳的原始 event 物件消毒成安全的 EventDef;不合格回 null。
 * 強制夾值、截斷字串、丟棄 evict/未知欄位、choices 需 2~3 個。
 * roster(名字→租客 id):用來解析事件牽涉的第二位鄰居 `with`;對不上就丟棄跨租客效果。
 */
export function sanitizeAiEvent(raw: unknown, roster?: Record<string, string>): EventDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, 40);
  if (!title || !Array.isArray(r.choices)) return null;

  // 解析第二位鄰居:名字要對得上 roster
  const withName = str(r.with, 20);
  const withId = roster && withName && roster[withName] ? roster[withName] : undefined;
  const hasOther = !!withId;

  const choices: EventChoiceDef[] = r.choices
    .slice(0, 3)
    .filter((c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).label === "string")
    .map((c, i) => {
      const cc = c as Record<string, unknown>;
      return { id: `ai${i}`, label: str(cc.label, 40), hint: str(cc.hint, 60), effect: cleanEffect(cc.effect, hasOther) };
    });
  if (choices.length < 2) return null;

  const ev: EventDef = { id: "ai_event", title, description: str(r.description, 200), choices, ai: true };
  if (hasOther) {
    ev.withId = withId;
    ev.withName = withName;
  }
  return ev;
}

function grievance(name: string): EventDef {
  return {
    id: "grievance",
    title: `${name} 對你有意見`,
    description: `${name} 最近對房東的態度明顯變冷淡。要修補關係嗎?`,
    choices: [
      { id: "gift", label: "送個小禮物", hint: "破費修補", effect: { money: -500, affinity: 12, satisfaction: 4 } },
      { id: "talk", label: "找他聊聊", hint: "誠意溝通", effect: { affinity: 7 } },
      { id: "evict", label: "乾脆請他搬走", hint: "眼不見為淨,但空房會沒收入", effect: { evict: true } },
    ],
  };
}
