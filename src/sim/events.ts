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
