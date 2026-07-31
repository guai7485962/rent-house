/**
 * 鄰居社交系統:關係值 + 個性相容 + 戀愛取向 → 交誼廳相遇時的互動。
 * 陌生 → 朋友 → 曖昧 → 情侶(→ 同居 / 分手)。
 * 純資料/邏輯,不 import store(避免循環);store 呼叫 encounter 並套用結果。
 */
import { reactive } from "vue";
import type { Gender, Tenant } from "../types";

export interface Relationship {
  value: number; // 0~100 熟悉度/好感
  /** 近期累積的不滿；與好感分開，兩人可以「熟但互有心結」。 */
  tension: number; // 0~100
  /** 上一次自然口角的遊戲時間；舊存檔補 0。 */
  lastConflictGameMs: number;
  romantic: boolean; // 是否為情侶
  cohabitOffered: boolean; // 是否已觸發過同居抉擇
}

export interface SocialEffect {
  mood?: number;
  stress?: number;
  satisfaction?: number;
}

export interface EncounterResult {
  a: string;
  b: string;
  textA: string;
  textB: string;
  importance: "minor" | "notable" | "major";
  effectA?: SocialEffect;
  effectB?: SocialEffect;
  milestone?: "became_friends" | "became_best_friends" | "became_couple" | "broke_up";
  cohabit?: boolean;
  /** 互動基調(演出層選特效用):聊天/戀愛氛圍/起衝突 */
  tone: "friendly" | "romantic" | "conflict";
}

/** 全部關係(pairKey → Relationship),reactive 供 UI 讀 */
export const relationships = reactive<Record<string, Relationship>>({});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function ensureRel(a: string, b: string): Relationship {
  const k = pairKey(a, b);
  if (!relationships[k]) relationships[k] = { value: 0, tension: 0, lastConflictGameMs: 0, romantic: false, cohabitOffered: false };
  const rel = relationships[k];
  // 測試 fixture 與 v6 舊存檔可能只有舊三欄；所有寫入入口先就地正規化。
  if (!Number.isFinite(rel.tension)) rel.tension = 0;
  if (!Number.isFinite(rel.lastConflictGameMs)) rel.lastConflictGameMs = 0;
  return rel;
}

export function getRel(a: string, b: string): Relationship | undefined {
  return relationships[pairKey(a, b)];
}

/** 兩人是否可能發展戀情(雙方皆成年 + 性別/取向相容)—— 戀愛線唯一把關點 */
export function canRomance(a: Tenant, b: Tenant): boolean {
  return (a.isAdult ?? true) && (b.isAdult ?? true) && attractedMutual(a, b);
}

/** 高好感但不走戀愛線的關係名稱；同性朋友不會再被顯示成「曖昧」。 */
export function bestFriendLabel(a: Tenant, b: Tenant): "閨密" | "哥們" | "摯友" {
  if (a.gender === "female" && b.gender === "female") return "閨密";
  if (a.gender === "male" && b.gender === "male") return "哥們";
  return "摯友";
}

/** 是否已達摯友等級（高好感、非情侶且彼此不具戀愛可能）。 */
export function isBestFriend(rel: Relationship | undefined, a: Tenant, b: Tenant): boolean {
  return !!rel && !rel.romantic && rel.value >= 75 && !canRomance(a, b);
}

/** 目前的正式伴侶；唯一伴侶制下最多一人。舊存檔修復前若有多位，依關係表順序回傳第一位。 */
export function romanticPartnerId(tenantId: string): string | null {
  for (const [key, rel] of Object.entries(relationships)) {
    if (!rel.romantic) continue;
    const [aId, bId] = key.split("|");
    if (aId === tenantId) return bId;
    if (bId === tenantId) return aId;
  }
  return null;
}

/** 正式交往共用守門：取向／成年合法，且雙方都沒有另一位正式伴侶。 */
export function canBecomeCouple(a: Tenant, b: Tenant): boolean {
  if (!canRomance(a, b)) return false;
  if (compatibility(a, b) < 0 || (getRel(a.id, b.id)?.tension ?? 0) >= 50) return false;
  const aPartner = romanticPartnerId(a.id);
  const bPartner = romanticPartnerId(b.id);
  return (!aPartner || aPartner === b.id) && (!bPartner || bPartner === a.id);
}

/** 夾值調整兩人關係值(AI 事件用:拉近/疏遠) */
export function adjustRelationship(aId: string, bId: string, delta: number) {
  const rel = ensureRel(aId, bId);
  rel.value = clamp(rel.value + delta, 0, 100);
}

/** 夾值調整積怨。正值累積心結、負值代表降溫或房東調解。 */
export function adjustTension(aId: string, bId: string, delta: number) {
  const rel = ensureRel(aId, bId);
  rel.tension = clamp(rel.tension + delta, 0, 100);
}

export type TensionLevel = "calm" | "friction" | "resentment" | "cold_war_risk";

export function tensionLevel(tension: number): TensionLevel {
  if (tension >= 70) return "cold_war_risk";
  if (tension >= 50) return "resentment";
  if (tension >= 25) return "friction";
  return "calm";
}

export function tensionLabel(tension: number): string {
  const level = tensionLevel(tension);
  if (level === "cold_war_risk") return "❄️ 冷戰風險";
  if (level === "resentment") return "💢 積怨已深";
  if (level === "friction") return "⚡ 容易摩擦";
  return "相處平穩";
}

/** 設定/解除情侶關係；所有自然／AI 入口都必須由此套用唯一伴侶與取向限制。 */
export function setCouple(aId: string, bId: string, value: boolean, aT?: Tenant, bT?: Tenant): boolean {
  const rel = ensureRel(aId, bId);
  if (!value) {
    rel.romantic = false;
    rel.cohabitOffered = false;
    return true;
  }
  if (aT && bT && canBecomeCouple(aT, bT)) {
    rel.romantic = true;
    rel.value = Math.max(rel.value, 75); // 在一起至少拉到曖昧線以上
    return true;
  }
  return false;
}

/** 兩人是否互有戀愛意願(性別 × 取向)。依設定,伴侶關係只在異性之間發展。 */
function attractedMutual(a: Tenant, b: Tenant): boolean {
  if (!a.gender || !b.gender || !a.attractedTo || !b.attractedTo) return false;
  if (a.gender === b.gender) return false; // 只允許異性成為伴侶
  return a.attractedTo.includes(b.gender) && b.attractedTo.includes(a.gender);
}

/** 清掉不再合法的既有情侶關係(載入舊檔時用:同性/未成年 → 解除 romantic)。
 *  getTenant:由 id 取回 Tenant(呼叫端注入,避免 social 依賴 store)。 */
export function pruneInvalidRomance(getTenant: (id: string) => Tenant | undefined) {
  for (const [key, rel] of Object.entries(relationships)) {
    if (!rel.romantic) continue;
    const [aId, bId] = key.split("|");
    const a = getTenant(aId);
    const b = getTenant(bId);
    if (a && b && !canRomance(a, b)) rel.romantic = false;
  }
}

/**
 * 舊存檔戀愛完整性修復：先排除不合法戀情，再把多重戀情縮成一對一 matching。
 * 同居配對優先保留；其餘按關係值由高到低保留。被降級的關係值不清空，會顯示為曖昧。
 */
export function pruneRomanceIntegrity(
  getTenant: (id: string) => Tenant | undefined,
  preferredPartner: (id: string) => string | null = () => null,
): string[] {
  const removed: string[] = [];
  const candidates = Object.entries(relationships)
    .filter(([, rel]) => rel.romantic)
    .map(([key, rel]) => {
      const [aId, bId] = key.split("|");
      const a = getTenant(aId);
      const b = getTenant(bId);
      const valid = !!a && !!b && canRomance(a, b);
      const preferred = preferredPartner(aId) === bId || preferredPartner(bId) === aId;
      return { key, rel, aId, bId, valid, preferred };
    })
    .sort((x, y) => Number(y.preferred) - Number(x.preferred) || y.rel.value - x.rel.value || x.key.localeCompare(y.key));

  const matched = new Set<string>();
  for (const edge of candidates) {
    if (edge.valid && !matched.has(edge.aId) && !matched.has(edge.bId)) {
      matched.add(edge.aId);
      matched.add(edge.bId);
      continue;
    }
    edge.rel.romantic = false;
    edge.rel.cohabitOffered = false;
    removed.push(edge.key);
  }
  return removed;
}

export interface CompatibilityDetail {
  score: number;
  /** 玩家看得懂的主要生活摩擦；順序固定，規則不靠 RNG。 */
  conflicts: string[];
  strengths: string[];
}

/** 個性相容細節(-5 排斥 ~ +5 契合),由核心標籤決定性推得。 */
export function compatibilityDetail(a: Pick<Tenant, "coreTags">, b: Pick<Tenant, "coreTags">): CompatibilityDetail {
  // 舊測試／外部匯入的精簡租客資料可能沒有 coreTags；視為沒有可判定的相性，
  // 避免戀愛守門在處理舊資料時直接拋錯。
  const ta = (a.coreTags ?? []).map((t) => t.id);
  const tb = (b.coreTags ?? []).map((t) => t.id);
  const hasA = (id: string) => ta.includes(id);
  const hasB = (id: string) => tb.includes(id);
  let c = 0;
  const conflicts: string[] = [];
  const strengths: string[] = [];

  const nightA = hasA("night_owl") || hasA("late_return");
  const nightB = hasB("night_owl") || hasB("late_return");
  const dayA = hasA("early_bird") || hasA("punctual");
  const dayB = hasB("early_bird") || hasB("punctual");
  if (nightA && nightB) { c += 2; strengths.push("作息相近，都是夜貓子"); }
  if (dayA && dayB) { c += 1; strengths.push("作息相近，都習慣早起"); }
  if ((nightA && dayB) || (dayA && nightB)) { c -= 2; conflicts.push("作息相反：一人晚睡、一人需要早起"); }

  const noisyA = hasA("noisy") || hasA("gamer");
  const noisyB = hasB("noisy") || hasB("gamer");
  const quietA = hasA("sound_sensitive") || hasA("perfectionist") || hasA("wfh");
  const quietB = hasB("sound_sensitive") || hasB("perfectionist") || hasB("wfh");
  if ((noisyA && quietB) || (noisyB && quietA)) { c -= 3; conflicts.push("噪音需求衝突：一人活動聲大、一人需要安靜"); }
  if (noisyA && noisyB) c += 1;
  if (hasA("gamer") && hasB("gamer")) { c += 2; strengths.push("都是遊戲同好"); }

  // 角色庫擴充(§9-2)的新標籤
  if (hasA("fitness") && hasB("fitness")) { c += 2; strengths.push("都是運動同好"); }
  if (hasA("caring") || hasB("caring")) c += 1; // 會照顧人的,跟誰都處得來
  if (hasA("foodie") || hasB("foodie")) c += 1; // 會分食物的,人緣好
  if ((hasA("busybody") && (quietB || nightB)) || (hasB("busybody") && (quietA || nightA))) {
    c -= 2;
    conflicts.push("界線感不合：一人愛關心追問、一人需要私人空間");
  }

  return { score: clamp(c, -5, 5), conflicts, strengths };
}

/** 相容分數的舊入口；戀愛與既有測試繼續使用同一套規則。 */
export function compatibility(a: Pick<Tenant, "coreTags">, b: Pick<Tenant, "coreTags">): number {
  return compatibilityDetail(a, b).score;
}

const FRIEND_LINES = [
  "在交誼廳遇到{o},聊了好一會。",
  "和{o}窩在沙發上一起看電視。",
  "在廚房碰到{o},分了點宵夜給對方。",
  "和{o}邊喝飲料邊抱怨工作。",
  "和{o}在冰箱前研究半天,最後決定合煮一鍋泡麵。",
  "碰上{o}正在找遙控器,兩人翻遍沙發才發現就在桌上。",
  "和{o}在走廊停下來聊近況,站著站著就過了半小時。",
  "被{o}拉去看一段好笑的影片,兩個人的笑聲吵醒了整間交誼廳。",
  "和{o}交換了最近踩雷的外送名單,聊得像在做正式評鑑。",
  "看到{o}一個人搬東西,順手幫了一把,兩人配合得意外順利。",
  "和{o}坐在窗邊吹風,有一句沒一句地聊著今天。",
  "被{o}塞了一包吃不完的零食,嘴上嫌棄,收下時倒挺開心。",
  "和{o}一起研究公共區的新擺設,各自提出一堆不切實際的主意。",
  "在交誼廳和{o}互相分享手機裡的貓照片,話題完全停不下來。",
];
const ROMANTIC_LINES = [
  "和{o}在沙發上靠在一起,氣氛很甜。",
  "替{o}留了一份宵夜,兩人吃到很晚。",
  "和{o}在交誼廳小聲說著只有彼此聽得懂的話。",
  "和{o}明明坐在交誼廳兩端,最後還是不知不覺靠到了一起。",
  "路過{o}身邊時被輕輕拉住手,兩個人就這樣多待了一會。",
  "和{o}分一杯飲料,誰都沒提其實還有乾淨的杯子。",
  "{o}替自己整理了一下亂掉的衣領,動作自然得像已經做過很多次。",
  "和{o}一起看窗外的雨,肩膀偶爾碰到也沒有人躲開。",
  "{o}離開交誼廳前回頭揮了揮手,一個普通道別也拖得格外久。",
  "和{o}為了晚餐吃什麼討論半天,語氣像拌嘴,表情倒全是笑。",
  "坐在{o}旁邊各做各的事,安靜得很舒服,誰也不需要找話題。",
];
const CONFLICT_REASONS = [
  "為了看什麼電視槓上了。",
  "因為噪音起了口角。",
  "為了誰該洗碗鬧得不太愉快。",
  "作息不同,又互相看不順眼。",
  "為了冰箱裡一盒沒寫名字的食物互相質問。",
  "嫌對方把公共區弄亂,講著講著語氣都硬了。",
  "為了冷氣溫度爭了半天,誰也不肯先讓一步。",
  "抱怨對方用完東西不歸位,舊帳也跟著一件件翻出來。",
  "一句玩笑踩到痛處,氣氛瞬間冷了下來。",
  "為了浴室排隊順序互不相讓,最後各自臭著臉離開。",
  "嫌對方講電話太大聲,兩個人在走廊越講越大聲。",
  "為了窗戶該開還是該關僵持不下,小事硬是吵成大事。",
  "發現公共零食又被吃光,彼此懷疑得像在辦案。",
  "因為垃圾誰都沒倒互相推責任,最後連前幾天的事都扯進來。",
];

function fill(line: string, other: string): string {
  return line.replace("{o}", other);
}

/** 一次交誼廳相遇的互動,回傳結果(並就地更新關係) */
const CONFLICT_COOLDOWN_HOURS = 12;
const GAME_HOUR_MS = 60 * 60 * 1000;

export interface EncounterOptions {
  gameMs?: number;
  /** 全樓每日節流由 tick 注入；false 時本次只會是一般相處。 */
  allowConflict?: boolean;
}

export function encounter(a: Tenant, b: Tenant, options: EncounterOptions = {}): EncounterResult {
  const rel = ensureRel(a.id, b.id);
  const detail = compatibilityDetail(a, b);
  const comp = detail.score;
  const res: EncounterResult = { a: a.id, b: b.id, textA: "", textB: "", importance: "minor", tone: rel.romantic ? "romantic" : "friendly" };

  const tension = Number.isFinite(rel.tension) ? rel.tension : 0;
  rel.tension = tension;
  rel.lastConflictGameMs = Number.isFinite(rel.lastConflictGameMs) ? rel.lastConflictGameMs : 0;
  const cooldownReady = options.gameMs === undefined
    || rel.lastConflictGameMs <= 0
    || options.gameMs - rel.lastConflictGameMs >= CONFLICT_COOLDOWN_HOURS * GAME_HOUR_MS;
  // 相合／中性配對維持舊版 3%，避免既有平衡局被重寫；負相性才吃相性與積怨加成。
  const conflictChance = comp >= 0
    ? 0.03
    : clamp(0.04 + -comp * 0.08 + tension * 0.0035, 0.03, 0.65);
  // 無論冷卻／全樓節流是否擋住，都維持舊版每次 encounter 固定先吃一次衝突 roll。
  const conflictRoll = Math.random();
  if (options.allowConflict !== false && cooldownReady && conflictRoll < conflictChance) {
    rel.value = clamp(rel.value - (2 + Math.max(0, -comp)), 0, 100);
    rel.tension = clamp(rel.tension + 10 + Math.max(0, -comp) * 2, 0, 100);
    if (options.gameMs !== undefined) rel.lastConflictGameMs = options.gameMs;
    // 保留舊版衝突文案抽樣的 RNG 骨架；有具體相性原因時只替換呈現文字。
    const fallbackReason = pick(CONFLICT_REASONS);
    const reason = detail.conflicts[0] ?? fallbackReason;
    res.textA = `和 ${b.name} ${reason}`;
    res.textB = `和 ${a.name} ${reason}`;
    res.importance = "notable";
    res.tone = "conflict";
    res.effectA = { stress: 4 };
    res.effectB = { stress: 4 };
  } else {
    const before = rel.value;
    const gain = comp < 0
      ? 0.15 + Math.random() * 0.35
      : 2.5 + comp * 1.0 + Math.random() * 2.5;
    rel.value = clamp(rel.value + gain, 0, 100);
    rel.tension = clamp(rel.tension - (comp > 0 ? 2 : 1), 0, 100);
    const line = rel.romantic ? pick(ROMANTIC_LINES) : pick(FRIEND_LINES);
    res.textA = fill(line, b.name);
    res.textB = fill(line, a.name);
    if (before < 35 && rel.value >= 35) res.milestone = "became_friends";
    if (before < 75 && isBestFriend(rel, a, b)) {
      const bond = bestFriendLabel(a, b);
      res.milestone = "became_best_friends";
      res.importance = "notable";
      res.textA = `🤝 和 ${b.name} 成了無話不談的${bond}`;
      res.textB = `🤝 和 ${a.name} 成了無話不談的${bond}`;
    }
  }

  // 在一起(canRomance = 雙方成年 + 取向相容)
  if (!rel.romantic && rel.value >= 75 && canBecomeCouple(a, b) && comp >= 0) {
    setCouple(a.id, b.id, true, a, b);
    res.milestone = "became_couple";
    res.importance = "major";
    res.textA = `❤️ 和 ${b.name} 在一起了`;
    res.textB = `❤️ 和 ${a.name} 在一起了`;
    res.effectA = { mood: 15, satisfaction: 12, stress: -10 };
    res.effectB = { mood: 15, satisfaction: 12, stress: -10 };
  }
  // 分手
  else if (rel.romantic && rel.value < 45) {
    rel.romantic = false;
    res.milestone = "broke_up";
    res.importance = "major";
    res.tone = "conflict";
    res.textA = `💔 和 ${b.name} 分手了`;
    res.textB = `💔 和 ${a.name} 分手了`;
    res.effectA = { mood: -18, satisfaction: -12, stress: 12 };
    res.effectB = { mood: -18, satisfaction: -12, stress: 12 };
  }
  // 同居抉擇(情侶關係極高,一次)
  if (rel.romantic && rel.value >= 92 && !rel.cohabitOffered) {
    rel.cohabitOffered = true;
    res.cohabit = true;
  }

  return res;
}

export function tierLabel(rel: Relationship, a?: Tenant, b?: Tenant): string {
  if (rel.romantic) return "情侶";
  if (rel.value >= 75) return a && b && !canRomance(a, b) ? bestFriendLabel(a, b) : "曖昧";
  if (rel.value >= 50) return "好朋友";
  if (rel.value >= 35) return "朋友";
  if (rel.value >= 15) return "點頭之交";
  return "陌生";
}

/** 給關係頁的下一步說明：把戀愛守門條件翻成玩家看得懂的原因。 */
export function relationshipProgressHint(
  rel: Pick<Relationship, "value" | "romantic" | "tension">,
  a: Tenant,
  b: Tenant,
): string {
  if (rel.tension >= 50) {
    const reason = compatibilityDetail(a, b).conflicts[0] ?? "近期相處累積了不少心結";
    return `${reason}；房東調解或一起完成事情，才能讓積怨降溫。`;
  }
  if (rel.romantic) {
    return rel.value >= 92
      ? "已是情侶；關係夠穩定時，可能提出同居。"
      : "已是情侶；繼續安排相處能累積到同居階段。";
  }
  if (!(a.isAdult ?? true) || !(b.isAdult ?? true)) {
    return "未成年角色不會進入戀愛線，高關係會維持在摯友。";
  }
  if (!canRomance(a, b)) {
    return `兩人的戀愛取向沒有互相符合，關係再高也會維持${bestFriendLabel(a, b)}。`;
  }
  if (!canBecomeCouple(a, b)) {
    return "其中一人已有伴侶，這段關係會停在曖昧，不會再建立第二段戀情。";
  }
  if (compatibility(a, b) < 0) {
    return "兩人的個性目前不夠合拍；即使好感很高，也不會自然進入交往。";
  }
  if (rel.value < 75) {
    return `關係達到 75 後，讓兩人在交誼廳自然相遇，就有機會進入戀情（目前 ${Math.round(rel.value)}）。`;
  }
  return "已符合戀愛條件；讓兩人在交誼廳再次自然相遇，就可能正式交往。";
}

/** 給 UI:列出所有已建立(value>0 或情侶)的關係 */
export interface RelationshipView {
  aId: string; bId: string; value: number; tension: number; romantic: boolean; label: string;
  compatibility: number; reasons: string[]; tensionLabel: string;
}

export function listRelationships(getTenant?: (id: string) => Tenant | undefined): RelationshipView[] {
  const out: RelationshipView[] = [];
  for (const [k, rel] of Object.entries(relationships)) {
    const tension = Number.isFinite(rel.tension) ? rel.tension : 0;
    rel.tension = tension;
    rel.lastConflictGameMs = Number.isFinite(rel.lastConflictGameMs) ? rel.lastConflictGameMs : 0;
    if (rel.value <= 0 && tension <= 0 && !rel.romantic) continue;
    const [aId, bId] = k.split("|");
    const a = getTenant?.(aId);
    const b = getTenant?.(bId);
    const detail = a && b ? compatibilityDetail(a, b) : { score: 0, conflicts: [], strengths: [] };
    out.push({
      aId,
      bId,
      value: Math.round(rel.value),
      tension: Math.round(tension),
      romantic: rel.romantic,
      label: tierLabel(rel, a, b),
      compatibility: detail.score,
      reasons: detail.conflicts,
      tensionLabel: tensionLabel(tension),
    });
  }
  return out.sort((x, y) => Number(y.tension >= 25) - Number(x.tension >= 25) || Number(y.romantic) - Number(x.romantic) || y.value - x.value);
}

/** 群體活動依生活相性折算；水火不容不會因同場活動無條件變好友。 */
export function adjustGroupBond(a: Tenant, b: Tenant, delta: number) {
  const comp = compatibility(a, b);
  if (delta > 0) {
    const scaled = comp <= -2 ? 0 : comp === -1 ? Math.ceil(delta / 2) : delta;
    if (scaled) adjustRelationship(a.id, b.id, scaled);
    adjustTension(a.id, b.id, comp <= -2 ? -2 : -Math.max(1, Math.ceil(delta / 2)));
  } else if (delta < 0) {
    adjustRelationship(a.id, b.id, delta);
    adjustTension(a.id, b.id, Math.abs(delta) * 2);
  }
}

/** 每日自然降溫；不抹掉好感，也不靠 RNG。 */
export function relationshipDailyPass() {
  for (const rel of Object.values(relationships)) rel.tension = clamp((rel.tension ?? 0) - 2, 0, 100);
}

/** 租客搬走:清掉所有牽涉他的關係 */
export function removeTenantRelations(id: string) {
  for (const k of Object.keys(relationships)) {
    if (k.split("|").includes(id)) delete relationships[k];
  }
}

/** 存檔/讀檔 */
export function serializeRelationships() {
  return Object.entries(relationships).map(([key, r]) => ({ key, ...r }));
}
export function loadRelationships(arr: { key: string; value: number; tension?: number; lastConflictGameMs?: number; romantic: boolean; cohabitOffered: boolean }[]) {
  for (const k of Object.keys(relationships)) delete relationships[k];
  for (const r of arr ?? []) relationships[r.key] = {
    value: clamp(r.value ?? 0, 0, 100),
    tension: clamp(r.tension ?? 0, 0, 100),
    lastConflictGameMs: Math.max(0, r.lastConflictGameMs ?? 0),
    romantic: !!r.romantic,
    cohabitOffered: !!r.cohabitOffered,
  };
}
