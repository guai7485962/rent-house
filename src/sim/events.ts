/**
 * 突發事件 + 抉擇系統。
 * 規則事件已資料化(設計檢討 §5):目錄在 data/events.json,「加事件 = 改資料」;
 * 載入時驗證(條件 stat/op 白名單、directive 白名單、choices 數量),壞資料略過並警告。
 * 支援事件連鎖:requiresFlag(要有伏筆旗標才觸發)+ consumesFlag(觸發即消耗)。
 */
import { sanitizeDirective, type DirectiveId } from "./directives";
import { normalizeNarrativeLanguage } from "./narrativeQuality";
import eventsJson from "../../data/events.json";

export interface EventEffect {
  affinity?: number;
  stress?: number;
  mood?: number;
  satisfaction?: number;
  wellbeing?: number;
  energy?: number;
  money?: number;
  evict?: boolean;
  /** 選項可留下一個新記憶標籤(讓抉擇有長期延續) */
  memory?: { label: string; hint: string };
  /** 行為指令(白名單):讓租客接下來 N 遊戲日的行為在畫面上看得見地改變 */
  directive?: { id: DirectiveId; days: number };
  /** 事件連鎖伏筆旗標(≤16 字):記在租客身上,之後每天餵回 AI 回收伏筆 */
  flag?: string;
  /** 對事件牽涉的第二位鄰居的數值影響 */
  other?: { mood?: number; stress?: number; affinity?: number; satisfaction?: number };
  /** AI 提議互動(§10-3):InteractionDef id,玩家拍板後由 forceInteraction 白名單+門檻把關觸發 */
  interaction?: string;
  /** 兩人關係變化:delta 正=拉近/戀情加速、負=吵架疏遠;couple/breakup 直接成/斷情侶 */
  rel?: { delta?: number; couple?: boolean; breakup?: boolean };
  /** 繳租求情事件的處置(只由程式建構的事件使用;cleanEffect 不透傳,AI 不能觸發) */
  rentAction?: "grace" | "collect" | "forgive";
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
  /** 這個事件觸發時要消耗的伏筆旗標(事件連鎖;呼叫端設 pendingEvent 後移除) */
  consumeFlag?: string;
}

export interface EventCtx {
  name: string;
  stress: number;
  satisfaction: number;
  affinity: number;
  /** 身心健康(過低會觸發生病事件) */
  wellbeing: number;
  /** 事件連鎖伏筆旗標(requiresFlag 解鎖用;省略視為無) */
  flags?: string[];
}

// ---------------------------------------------------------------------------
// 規則事件目錄(data/events.json):載入時驗證,rollEvent 依序比對條件
// ---------------------------------------------------------------------------

type RuleStat = "stress" | "satisfaction" | "affinity" | "wellbeing";
const RULE_STATS = new Set<RuleStat>(["stress", "satisfaction", "affinity", "wellbeing"]);
const OPS: Record<string, (a: number, b: number) => boolean> = {
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
};

interface RuleEventDef {
  id: string;
  when: { stat: RuleStat; op: string; value: number }[];
  requiresFlag?: string;
  consumesFlag?: boolean;
  title: string;
  description: string;
  choices: EventChoiceDef[];
}

/** 載入 + 驗證事件目錄:條件 stat/op 白名單、directive 白名單、choices 2~3;壞資料略過並警告 */
function loadRuleEvents(): RuleEventDef[] {
  const out: RuleEventDef[] = [];
  for (const raw of (eventsJson as { events: unknown[] }).events) {
    const e = raw as RuleEventDef;
    const badWhen =
      !Array.isArray(e.when) ||
      e.when.length === 0 ||
      e.when.some((c) => !RULE_STATS.has(c.stat) || !OPS[c.op] || typeof c.value !== "number");
    const badChoices = !Array.isArray(e.choices) || e.choices.length < 2 || e.choices.length > 3;
    const badDirective = (e.choices ?? []).some((c) => c.effect?.directive && !sanitizeDirective(c.effect.directive));
    if (!e.id || !e.title || badWhen || badChoices || badDirective) {
      console.warn(`[events] 目錄資料不合法,略過事件:${(e as { id?: string }).id ?? "?"}`);
      continue;
    }
    out.push(e);
  }
  return out;
}
const RULE_EVENTS = loadRuleEvents();

/** 依狀態決定要不要觸發事件:目錄順序 = 優先序,第一個條件全中(且旗標符合)的觸發。呼叫端負責冷卻 */
export function rollEvent(ctx: EventCtx): EventDef | null {
  for (const re of RULE_EVENTS) {
    if (re.requiresFlag && !(ctx.flags ?? []).includes(re.requiresFlag)) continue;
    if (!re.when.every((c) => OPS[c.op](ctx[c.stat], c.value))) continue;
    const fill = (s: string) => s.replace(/\{name\}/g, ctx.name);
    const ev: EventDef = {
      id: re.id,
      title: fill(re.title),
      description: fill(re.description),
      choices: JSON.parse(JSON.stringify(re.choices)), // 深拷貝,避免改到共用目錄
    };
    if (re.requiresFlag && re.consumesFlag) ev.consumeFlag = re.requiresFlag;
    return ev;
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI 生成事件的消毒 + 夾值(安全核心:AI 現在能影響機制,一律在此把關)
// ---------------------------------------------------------------------------

const clampNum = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, cap: number): string => (typeof v === "string" ? v : "").slice(0, cap).trim();

function cleanMemory(v: unknown, expectedNames: string[]): { label: string; hint: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const m = v as Record<string, unknown>;
  const label = normalizeNarrativeLanguage(str(m.label, 20), expectedNames).slice(0, 20).trim();
  const hint = normalizeNarrativeLanguage(str(m.hint, 80), expectedNames).slice(0, 80).trim();
  return label && hint ? { label, hint } : undefined;
}

function cleanEffect(v: unknown, hasOther: boolean, expectedNames: string[]): EventEffect {
  const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const eff: EventEffect = {
    mood: clampNum(e.mood, -25, 25),
    stress: clampNum(e.stress, -25, 25),
    affinity: clampNum(e.affinity, -25, 25),
    satisfaction: clampNum(e.satisfaction, -25, 25),
    wellbeing: clampNum(e.wellbeing, -25, 25),
    energy: clampNum(e.energy, -25, 25),
    money: clampNum(e.money, -5000, 2000),
    // evict 一律不開放給 AI(忽略)
  };
  const mem = cleanMemory(e.memory, expectedNames);
  if (mem) eff.memory = mem;
  // 行為指令:白名單驗證,不合格直接丟棄(AI 不能發明機制)
  const dir = sanitizeDirective(e.directive);
  if (dir) eff.directive = dir;
  // 伏筆旗標:純文字截斷即可(只回餵 AI 當 context,不驅動任何機制)
  const fl = str(e.flag, 16);
  if (fl) eff.flag = fl;

  // 跨租客欄位:只有事件確實牽涉第二位鄰居(hasOther)才保留
  if (hasOther) {
    // AI 提議互動:此處只截斷字串;白名單與門檻在 forceInteraction 統一把關(未知 id 靜默略過)
    const it = str(e.interaction, 24);
    if (it) eff.interaction = it;
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
const FORBIDDEN_EVENT_ACTION = /驅逐|趕走|退租/u;

/** 「收養租客」是弱模型常見的角色錯置；收養寵物本身仍是合法事件。 */
function adoptsTenant(text: string, tenantNames: string[]): boolean {
  return tenantNames.some((name) => {
    let at = text.indexOf("收養");
    while (at >= 0) {
      const nameAt = text.indexOf(name, at + 2);
      if (nameAt >= 0 && nameAt - (at + 2) <= 6) return true;
      at = text.indexOf("收養", at + 2);
    }
    return false;
  });
}

export function sanitizeAiEvent(raw: unknown, roster?: Record<string, string>, ownerName = ""): EventDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const otherNames = Object.keys(roster ?? {});
  const expectedNames = [ownerName, ...otherNames].filter(Boolean);
  const cleanText = (v: unknown, cap: number) => normalizeNarrativeLanguage(str(v, cap), expectedNames).slice(0, cap).trim();
  const title = cleanText(r.title, 40);
  if (!title || !Array.isArray(r.choices)) return null;

  // 解析第二位鄰居:名字要對得上 roster
  const withName = cleanText(r.with, 20);
  const withId = roster && withName && roster[withName] ? roster[withName] : undefined;
  const hasOther = !!withId;

  const choices: EventChoiceDef[] = r.choices
    .slice(0, 3)
    .filter((c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).label === "string")
    .map((c, i) => {
      const cc = c as Record<string, unknown>;
      return { id: `ai${i}`, label: cleanText(cc.label, 40), hint: cleanText(cc.hint, 60), effect: cleanEffect(cc.effect, hasOther, expectedNames) };
    })
    .filter((choice) => !!choice.label);
  if (choices.length < 2) return null;

  const description = cleanText(r.description, 200);
  const narrativeFields = [title, description, ...choices.flatMap((choice) => [
    choice.label, choice.hint, choice.effect.memory?.label ?? "", choice.effect.memory?.hint ?? "",
  ])];

  // AI 不能用文案假裝執行不存在／禁用的機制；寧可丟棄整個事件，也不要讓按鈕語意與效果脫節。
  if (narrativeFields.some((text) => FORBIDDEN_EVENT_ACTION.test(text) || adoptsTenant(text, expectedNames))) return null;

  // 事件提到的其他在住租客必須就是 `with` 指定的對象；避免事件掛在甲頁、內容卻突然演乙。
  const mentionedOthers = otherNames.filter((name) => narrativeFields.some((text) => text.includes(name)));
  if (mentionedOthers.some((name) => name !== withName)) return null;

  const ev: EventDef = { id: "ai_event", title, description, choices, ai: true };
  if (hasOther) {
    ev.withId = withId;
    ev.withName = withName;
  }
  return ev;
}
