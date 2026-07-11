/**
 * 招租系統:依房間屬性產生「應徵租客」,並算出契合度。
 * 房東裝潢空房 → 屬性上升 → 吸引偏好相符的租客 → 選一位入住(store.moveIn)。
 */
import type { Appearance, CoreTag, Gender, RoomAttribute } from "../types";
import { roomAttributes } from "./placements";
import { upgradeRentBonus } from "./upgrades";
import { randomAppearance } from "../pixel/parts";

interface Archetype {
  key: string; // 對應 ARCHETYPE_ROUTINES 的作息
  occupation: string;
  bio: string;
  coreTags: CoreTag[];
  preferences: Partial<Record<RoomAttribute, number>>;
  monthlyRent: number;
}

const ARCHETYPES: Archetype[] = [
  {
    key: "office",
    occupation: "上班族",
    bio: "朝九晚五的上班族,重視居家的療癒與收納,週末喜歡待在家追劇。",
    coreTags: [
      { id: "punctual", label: "[準時交租]", behaviorHint: "帳單從不拖欠,作息規律。" },
      { id: "early_bird", label: "[早睡早起]", behaviorHint: "晚上十一點前就寢,清晨起床。" },
    ],
    preferences: { cozy: 7, storage: 5, style: 3 },
    monthlyRent: 15000,
  },
  {
    key: "student",
    occupation: "電競系學生",
    bio: "日夜顛倒的電競系學生,房間就是他的戰場,對電腦設備很講究。",
    coreTags: [
      { id: "night_owl", label: "[夜貓子]", behaviorHint: "凌晨活躍,白天補眠。" },
      { id: "gamer", label: "[電競魂]", behaviorHint: "醒著多半在打電動,情緒隨勝負起伏。" },
    ],
    preferences: { tech: 8, cozy: 3, noise: 2 },
    monthlyRent: 11000,
  },
  {
    key: "freelancer",
    occupation: "自由接案設計師",
    bio: "在家工作的設計師,需要安靜與有品味的環境,對細節龜毛。",
    coreTags: [
      { id: "wfh", label: "[在家工作]", behaviorHint: "整天待在房間工作,很少外出。" },
      { id: "perfectionist", label: "[完美主義]", behaviorHint: "對環境挑剔,房間維持得很整齊。" },
    ],
    preferences: { tech: 5, soundproof: 4, style: 6 },
    monthlyRent: 16000,
  },
  {
    key: "student",
    occupation: "樂團鼓手",
    bio: "地下樂團的鼓手,越吵越自在,常常半夜才回家。",
    coreTags: [
      { id: "noisy", label: "[製造噪音]", behaviorHint: "喜歡熱鬧,常放音樂、敲敲打打。" },
      { id: "late_return", label: "[夜歸]", behaviorHint: "深夜才回家,作息與人相反。" },
    ],
    preferences: { noise: 8, style: 4 },
    monthlyRent: 13000,
  },
];

const NAMES = ["王大明", "李佳蓉", "張偉", "陳思妤", "林俊傑", "黃美玲", "吳承恩", "周曉涵"];

export interface Applicant {
  id: string;
  name: string;
  archetypeKey: string;
  occupation: string;
  bio: string;
  coreTags: CoreTag[];
  preferences: Partial<Record<RoomAttribute, number>>;
  monthlyRent: number;
  /** 原型基礎租金(行情加成前;monthlyRent = baseRent × (1+升級加成)) */
  baseRent?: number;
  stars: number; // 1~5 契合度
  gender: Gender;
  attractedTo: Gender[];
  /** 部件化外觀(§9-1);舊池子裡的應徵者可能沒有 → 入住時再補抽 */
  appearance?: Appearance;
}

/** 應徵者實際開的月租:基礎租金 × 房間升級行情加成,取整到百位 */
function offeredRent(base: number, roomId: string): number {
  return Math.round((base * (1 + upgradeRentBonus(roomId))) / 100) * 100;
}

/** 隨機生成性別與戀愛取向 */
function randomIdentity(): { gender: Gender; attractedTo: Gender[] } {
  const gender: Gender = Math.random() < 0.1 ? "nonbinary" : Math.random() < 0.5 ? "male" : "female";
  const opp: Gender = gender === "male" ? "female" : "male";
  const roll = Math.random();
  let attractedTo: Gender[];
  if (gender === "nonbinary") attractedTo = ["male", "female", "nonbinary"];
  else if (roll < 0.6) attractedTo = [opp]; // 異性
  else if (roll < 0.85) attractedTo = ["male", "female"]; // 雙性
  else attractedTo = [gender]; // 同性
  return { gender, attractedTo };
}

/** 契合度:房間屬性 × 偏好權重 */
function matchStars(prefs: Partial<Record<RoomAttribute, number>>, attrs: Partial<Record<RoomAttribute, number>>): number {
  let raw = 0;
  for (const [k, p] of Object.entries(prefs)) {
    raw += (attrs[k as RoomAttribute] ?? 0) * (p ?? 0);
  }
  if (raw <= 0) return 1;
  if (raw < 25) return 2;
  if (raw < 55) return 3;
  if (raw < 95) return 4;
  return 5;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** 依「當前」房間屬性重算一批應徵者的契合星等與租金行情(裝潢/升級改變後即時反映,不必重抽人) */
export function rescoreApplicants(list: Applicant[], roomId: string): Applicant[] {
  const attrs = roomAttributes(roomId);
  for (const a of list) {
    a.stars = matchStars(a.preferences, attrs);
    a.baseRent = a.baseRent ?? a.monthlyRent; // 舊存檔的池沒有 baseRent → 以現值為底
    a.monthlyRent = offeredRent(a.baseRent, roomId);
  }
  return list;
}

/** 為某空房產生 3 位應徵者(契合度依房間目前屬性);excludeNames = 已在住租客,避免同名 */
export function generateApplicants(roomId: string, excludeNames: string[] = []): Applicant[] {
  const attrs = roomAttributes(roomId);
  const names = shuffle(NAMES.filter((n) => !excludeNames.includes(n)));
  return shuffle(ARCHETYPES)
    .slice(0, Math.min(3, names.length))
    .map((a, i) => ({
      id: `tenant_${roomId}_${Date.now()}_${i}`,
      name: names[i],
      archetypeKey: a.key,
      occupation: a.occupation,
      bio: a.bio,
      coreTags: a.coreTags,
      preferences: a.preferences,
      monthlyRent: offeredRent(a.monthlyRent, roomId),
      baseRent: a.monthlyRent,
      stars: matchStars(a.preferences, attrs),
      ...randomIdentity(),
      appearance: randomAppearance(),
    }));
}
