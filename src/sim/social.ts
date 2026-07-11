/**
 * 鄰居社交系統:關係值 + 個性相容 + 戀愛取向 → 交誼廳相遇時的互動。
 * 陌生 → 朋友 → 曖昧 → 情侶(→ 同居 / 分手)。
 * 純資料/邏輯,不 import store(避免循環);store 呼叫 encounter 並套用結果。
 */
import { reactive } from "vue";
import type { Gender, Tenant } from "../types";

export interface Relationship {
  value: number; // 0~100 熟悉度/好感
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
  milestone?: "became_friends" | "became_couple" | "broke_up";
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
  if (!relationships[k]) relationships[k] = { value: 0, romantic: false, cohabitOffered: false };
  return relationships[k];
}

export function getRel(a: string, b: string): Relationship | undefined {
  return relationships[pairKey(a, b)];
}

/** 兩人是否可能發展戀情(雙方皆成年 + 性別/取向相容)—— 戀愛線唯一把關點 */
export function canRomance(a: Tenant, b: Tenant): boolean {
  return (a.isAdult ?? true) && (b.isAdult ?? true) && attractedMutual(a, b);
}

/** 夾值調整兩人關係值(AI 事件用:拉近/疏遠) */
export function adjustRelationship(aId: string, bId: string, delta: number) {
  const rel = ensureRel(aId, bId);
  rel.value = clamp(rel.value + delta, 0, 100);
}

/** 設定/解除情侶關係;成為情侶仍受取向限制(需傳入雙方 Tenant 檢查) */
export function setCouple(aId: string, bId: string, value: boolean, aT?: Tenant, bT?: Tenant) {
  const rel = ensureRel(aId, bId);
  if (!value) {
    rel.romantic = false;
    return;
  }
  if (aT && bT && canRomance(aT, bT)) {
    rel.romantic = true;
    rel.value = Math.max(rel.value, 75); // 在一起至少拉到曖昧線以上
  }
}

/** 兩人是否互有戀愛意願(性別 × 取向) */
function attractedMutual(a: Tenant, b: Tenant): boolean {
  if (!a.gender || !b.gender || !a.attractedTo || !b.attractedTo) return false;
  return a.attractedTo.includes(b.gender) && b.attractedTo.includes(a.gender);
}

/** 個性相容度(-5 排斥 ~ +5 契合),由核心標籤推得 */
export function compatibility(a: Tenant, b: Tenant): number {
  const ta = a.coreTags.map((t) => t.id);
  const tb = b.coreTags.map((t) => t.id);
  const hasA = (id: string) => ta.includes(id);
  const hasB = (id: string) => tb.includes(id);
  let c = 0;

  const nightA = hasA("night_owl") || hasA("late_return");
  const nightB = hasB("night_owl") || hasB("late_return");
  const dayA = hasA("early_bird") || hasA("punctual");
  const dayB = hasB("early_bird") || hasB("punctual");
  if (nightA && nightB) c += 2; // 都是夜貓,作息合
  if (dayA && dayB) c += 1;
  if ((nightA && dayB) || (dayA && nightB)) c -= 2; // 作息相反

  const noisyA = hasA("noisy") || hasA("gamer");
  const noisyB = hasB("noisy") || hasB("gamer");
  const quietA = hasA("sound_sensitive") || hasA("perfectionist") || hasA("wfh");
  const quietB = hasB("sound_sensitive") || hasB("perfectionist") || hasB("wfh");
  if ((noisyA && quietB) || (noisyB && quietA)) c -= 3; // 吵 vs 安靜,水火不容
  if (noisyA && noisyB) c += 1;
  if (hasA("gamer") && hasB("gamer")) c += 2; // 電競同好

  // 角色庫擴充(§9-2)的新標籤
  if (hasA("fitness") && hasB("fitness")) c += 2; // 運動同好,相約晨跑
  if (hasA("caring") || hasB("caring")) c += 1; // 會照顧人的,跟誰都處得來
  if (hasA("foodie") || hasB("foodie")) c += 1; // 會分食物的,人緣好
  if ((hasA("busybody") && (quietB || nightB)) || (hasB("busybody") && (quietA || nightA))) c -= 2; // 愛管閒事 vs 想清靜/在補眠的

  return clamp(c, -5, 5);
}

const FRIEND_LINES = [
  "在交誼廳遇到{o},聊了好一會。",
  "和{o}窩在沙發上一起看電視。",
  "在廚房碰到{o},分了點宵夜給對方。",
  "和{o}邊喝飲料邊抱怨工作。",
];
const ROMANTIC_LINES = [
  "和{o}在沙發上靠在一起,氣氛很甜。",
  "替{o}留了一份宵夜,兩人吃到很晚。",
  "和{o}在交誼廳小聲說著只有彼此聽得懂的話。",
];
const CONFLICT_REASONS = [
  "為了看什麼電視槓上了。",
  "因為噪音起了口角。",
  "為了誰該洗碗鬧得不太愉快。",
  "作息不同,又互相看不順眼。",
];

function fill(line: string, other: string): string {
  return line.replace("{o}", other);
}

/** 一次交誼廳相遇的互動,回傳結果(並就地更新關係) */
export function encounter(a: Tenant, b: Tenant): EncounterResult {
  const rel = ensureRel(a.id, b.id);
  const comp = compatibility(a, b);
  const res: EncounterResult = { a: a.id, b: b.id, textA: "", textB: "", importance: "minor", tone: rel.romantic ? "romantic" : "friendly" };

  const conflictChance = comp < 0 ? 0.2 + -comp * 0.08 : 0.03;
  if (Math.random() < conflictChance) {
    rel.value = clamp(rel.value - (2 + Math.max(0, -comp)), 0, 100);
    const reason = pick(CONFLICT_REASONS);
    res.textA = `和 ${b.name} ${reason}`;
    res.textB = `和 ${a.name} ${reason}`;
    res.importance = "notable";
    res.tone = "conflict";
    res.effectA = { stress: 4 };
    res.effectB = { stress: 4 };
  } else {
    const before = rel.value;
    rel.value = clamp(rel.value + (2.5 + Math.max(0, comp) * 1.0 + Math.random() * 2.5), 0, 100);
    const line = rel.romantic ? pick(ROMANTIC_LINES) : pick(FRIEND_LINES);
    res.textA = fill(line, b.name);
    res.textB = fill(line, a.name);
    if (before < 35 && rel.value >= 35) res.milestone = "became_friends";
  }

  // 在一起(canRomance = 雙方成年 + 取向相容)
  if (!rel.romantic && rel.value >= 75 && canRomance(a, b) && comp >= 0) {
    rel.romantic = true;
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

export function tierLabel(rel: Relationship): string {
  if (rel.romantic) return "情侶";
  if (rel.value >= 75) return "曖昧";
  if (rel.value >= 50) return "好朋友";
  if (rel.value >= 35) return "朋友";
  if (rel.value >= 15) return "點頭之交";
  return "陌生";
}

/** 給 UI:列出所有已建立(value>0 或情侶)的關係 */
export function listRelationships(): { aId: string; bId: string; value: number; romantic: boolean; label: string }[] {
  const out: { aId: string; bId: string; value: number; romantic: boolean; label: string }[] = [];
  for (const [k, rel] of Object.entries(relationships)) {
    if (rel.value <= 0 && !rel.romantic) continue;
    const [aId, bId] = k.split("|");
    out.push({ aId, bId, value: Math.round(rel.value), romantic: rel.romantic, label: tierLabel(rel) });
  }
  return out.sort((x, y) => Number(y.romantic) - Number(x.romantic) || y.value - x.value);
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
export function loadRelationships(arr: { key: string; value: number; romantic: boolean; cohabitOffered: boolean }[]) {
  for (const k of Object.keys(relationships)) delete relationships[k];
  for (const r of arr ?? []) relationships[r.key] = { value: r.value, romantic: r.romantic, cohabitOffered: r.cohabitOffered };
}
