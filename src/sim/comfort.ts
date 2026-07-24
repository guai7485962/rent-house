/**
 * 房間舒適度系統(第一波:舒適度核心 + 整潔翻身)。
 *
 * 數值哲學:**慢變環境品質**——佈置好家具→租客「慢慢」變舒適→墊高心情/健康基準,
 * 佈置一次長期受益,不是 The Sims 式快速衰減需要一直照顧。
 *
 * 純函式模組(不改任何狀態):
 *   - roomComfort(roomId, cleanliness)  → 0~100 舒適度分數
 *   - comfortBaselineDelta(comfort)     → 溫和改 homeostasis 基準的增量(mood/stress/wellbeing)
 *   - cleanlinessBaseline(roomId)       → 整潔的自然回歸目標(收納家具墊高「常保整潔」)
 *   - comfortHints(roomId, cleanliness) → 房間細看的改善提示
 *
 * 舒適度 = ( 家具屬性(飽和加權) + 家具種類齊全度 ) × 整潔乘子。
 * 依 catalog 家具 attributes 的實際值域設計係數(見下方註解),不臆測。
 */
import { getDef, type FurnCategory } from "../furniture/catalog";
import { getPlacements, roomAttributes } from "./placements";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 五大舒適類別 → 家具分類對應。房內每具備一類 +6(滿 30)。
 * 齊全度鼓勵「生活機能完整」的房間,而不是狂堆單一屬性。
 */
const COMFORT_BUCKETS: { label: string; cats: FurnCategory[]; hint: string }[] = [
  { label: "睡眠", cats: ["sleep"], hint: "缺床鋪,睡不安穩" },
  { label: "娛樂", cats: ["av", "work"], hint: "缺娛樂設備(電視/桌)" },
  { label: "收納", cats: ["storage"], hint: "加收納更整齊" },
  { label: "裝飾", cats: ["ambiance"], hint: "加點綠植/香氛更療癒" },
  { label: "生活", cats: ["seating", "kitchen"], hint: "缺放鬆的座椅" },
];
const CATEGORY_POINTS = 6; // 每類 +6 → 五類滿 30

/**
 * 屬性加權:cozy(療癒感)是舒適主力;style(品味)/soundproof(隔音)其次;
 * tech(科技/便利)微加分;noise(噪音)扣分。權重依 catalog 值域抓:
 *   單房 cozy 常見 10~20(懶骨頭4、沙發8、帷幔床9…),style 3~13,tech 5~14,
 *   soundproof 只有隔音窗簾 6,noise 電競桌/體感機 2。
 * 加權後過飽和函式(x/(x+K))收斂,避免狂堆家具就爆表。
 */
const ATTR_WEIGHTS = { cozy: 1.0, style: 0.6, soundproof: 0.8, tech: 0.35, noise: 0.7 };
const ATTR_HALF = 18; // 飽和半值:加權和 = 18 時屬性分達上限的一半
const ATTR_MAX = 60; // 屬性部分上限

/** 房內具備哪些家具分類(用來算種類齊全度) */
function roomCategories(roomId: string): Set<FurnCategory> {
  const set = new Set<FurnCategory>();
  for (const p of getPlacements()) {
    if (p.room !== roomId) continue;
    set.add(getDef(p.defId).category);
  }
  return set;
}

/** 房內自動清潔家具(掃地機器人等)的清潔力總和(墊高整潔基準用) */
function roomCleanPower(roomId: string): number {
  let power = 0;
  for (const p of getPlacements()) {
    if (p.room !== roomId) continue;
    power += getDef(p.defId).cleanPower ?? 0;
  }
  return power;
}

/** 整潔乘子:髒→打折。clean 100→×1、50→×0.75、0→×0.5(下限保護,不歸零) */
export function cleanlinessMultiplier(cleanliness: number): number {
  return clamp(0.5 + 0.5 * (cleanliness / 100), 0.5, 1);
}

/** 舒適度拆解(給 UI/測試看細項);roomId 空 → 中性(comfort 50) */
export function roomComfortBreakdown(roomId: string | null, cleanliness: number) {
  if (!roomId) return { comfort: 50, attrPart: 30, categoryPart: 20, cleanMult: 1, missing: [] as string[] };
  const attrs = roomAttributes(roomId);
  const cozy = attrs.cozy ?? 0;
  const style = attrs.style ?? 0;
  const soundproof = attrs.soundproof ?? 0;
  const tech = attrs.tech ?? 0;
  const noise = Math.max(0, attrs.noise ?? 0);
  const weighted = Math.max(
    0,
    cozy * ATTR_WEIGHTS.cozy +
      style * ATTR_WEIGHTS.style +
      soundproof * ATTR_WEIGHTS.soundproof +
      tech * ATTR_WEIGHTS.tech -
      noise * ATTR_WEIGHTS.noise,
  );
  const attrPart = ATTR_MAX * (weighted / (weighted + ATTR_HALF));

  const cats = roomCategories(roomId);
  const missing: string[] = [];
  let present = 0;
  for (const b of COMFORT_BUCKETS) {
    if (b.cats.some((c) => cats.has(c))) present++;
    else missing.push(b.label);
  }
  const categoryPart = present * CATEGORY_POINTS;

  const cleanMult = cleanlinessMultiplier(cleanliness);
  const comfort = clamp((attrPart + categoryPart) * cleanMult, 0, 100);
  return { comfort, attrPart, categoryPart, cleanMult, missing };
}

/** 房間舒適度 0~100(佈置越齊全/越療癒/越乾淨越高) */
export function roomComfort(roomId: string | null, cleanliness: number): number {
  return roomComfortBreakdown(roomId, cleanliness).comfort;
}

/**
 * 舒適度 → homeostasis 基準的溫和增量(慢變:改的是「回到哪」,不直接灌當下值)。
 * 係數刻意小:comfort 每偏離 50 一點,基準才動一點點,租客靠既有 K=0.06 慢慢趨近。
 *   comfort 80(佈置精緻乾淨):mood 基準 +4.8、stress −3、wellbeing 錨 +2.4
 *   comfort 30(簡陋或髒亂)  :mood 基準 −3.2、stress +2、wellbeing 錨 −1.6
 */
export function comfortBaselineDelta(comfort: number): { mood: number; stress: number; wellbeing: number } {
  const cd = comfort - 50;
  return { mood: cd * 0.16, stress: -cd * 0.1, wellbeing: cd * 0.08 };
}

/**
 * 整潔的自然回歸目標(homeostasis 錨點):生活會慢慢變髒回到這個水位,
 * 收納家具(storage)墊高「常保整潔」的基準 = 減緩實際衰減;
 * 自動清潔家具(掃地機器人的 cleanPower)再往上墊,體現「買了會自動維持乾淨」。
 *   無收納:錨 50(略髒,dirt 會微微顯現,提示玩家買收納)
 *   收納充足:最高錨 80;加掃地機器人可再上探,總上限夾到 90。
 */
export function cleanlinessBaseline(roomId: string | null): number {
  if (!roomId) return 50;
  const storage = roomAttributes(roomId).storage ?? 0;
  const cleanPower = roomCleanPower(roomId);
  return clamp(50 + storage * 2 + cleanPower, 50, 90);
}

/** 房間細看的改善提示(依太髒/缺哪類家具/不夠療癒,最多 3 條;手機直式勿擠) */
export function comfortHints(roomId: string | null, cleanliness: number): string[] {
  if (!roomId) return [];
  const bd = roomComfortBreakdown(roomId, cleanliness);
  const hints: string[] = [];
  if (cleanliness < 40) hints.push("太髒亂了,該打掃了");
  else if (cleanliness < 60 && (roomAttributes(roomId).storage ?? 0) < 4) hints.push("有點亂,加收納能常保整潔");
  // 缺哪類家具(依 bucket 定義的提示語)
  for (const b of COMFORT_BUCKETS) {
    if (bd.missing.includes(b.label)) hints.push(b.hint);
    if (hints.length >= 3) return hints.slice(0, 3);
  }
  // 都齊了但屬性偏低 → 建議加療癒佈置
  if (hints.length < 3 && bd.attrPart < 28) hints.push("多點溫馨佈置會更舒適");
  return hints.slice(0, 3);
}
