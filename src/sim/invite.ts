/**
 * 特邀租客(§9-3):名字 + 個性描述 → AI 生成角色 → 白名單/夾值消毒 → 應徵者。
 *
 * 三道關卡:
 * 1. 前端關鍵字快篩:描述明顯是未成年 → 直接拒絕,不打 API(省額度)。
 * 2. AI 依描述如實判定 isAdult;isAdult !== true → 拒絕入住(不會被「轉成成人」)。
 * 3. 全欄位白名單/夾值:作息原型、外觀部件、數值、租金、偏好——AI 只能在既有枚舉裡挑。
 */
import type { Appearance, Gender, HairStyle, AccessoryKind, CoreTag, RoomAttribute } from "../types";
import type { Applicant } from "./recruit";
import { ARCHETYPE_ROUTINES } from "./routine";
import { ALL_HAIR_STYLES, ALL_ACCESSORIES, HAIR_COLORS, SHIRT_COLORS, PANTS_COLORS, SKIN_TONES } from "../pixel/parts";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 描述若明顯指向未成年(含知名兒童角色名),前端直接擋(不打 API);後端 AI 依「原作年齡」再判一次 */
const MINOR_WORDS = ["小學", "國小", "國中", "初中", "高中", "中學生", "兒童", "小孩", "孩童", "未成年", "幼稚園", "幼兒", "少年偵探", "大雄", "野比", "柯南", "哆啦"];
export function looksMinor(text: string): boolean {
  return MINOR_WORDS.some((w) => text.includes(w));
}

export interface InviteRequestResult {
  ok: boolean;
  raw?: unknown;
  /** 失敗原因(顯示給玩家):quota=額度用盡、offline=連不上、bad=AI 回傳無法解析 */
  reason?: "quota" | "offline" | "bad";
}

/** 打 /api/invite 取得 AI 生成的原始角色資料 */
export async function requestInvite(name: string, description: string, gender: Gender): Promise<InviteRequestResult> {
  try {
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, gender }),
    });
    if (res.ok) return { ok: true, raw: await res.json() };
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === "quota") return { ok: false, reason: "quota" };
    } catch {
      /* body 非 JSON */
    }
    return { ok: false, reason: "bad" };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

export interface SanitizeResult {
  ok: boolean;
  applicant?: Applicant;
  reason?: string;
}

const GENDERS: Gender[] = ["male", "female", "nonbinary"];
const ATTRS: RoomAttribute[] = ["tech", "cozy", "noise", "soundproof", "storage", "style"];
const HEX = /^#[0-9a-fA-F]{6}$/;

const pickColor = (v: unknown, pool: string[]): string =>
  typeof v === "string" && HEX.test(v) ? v : pool[Math.floor(Math.random() * pool.length)];

/** 消毒 AI 回傳的角色資料 → 應徵者;isAdult !== true 一律拒絕 */
export function sanitizeInvited(name: string, raw: unknown, selectedGender?: Gender): SanitizeResult {
  const r = raw as Record<string, any>;
  if (!r || typeof r !== "object") return { ok: false, reason: "AI 回傳的資料無法解析" };

  // 硬規則:僅接受成年角色。AI 依描述如實判定,描述為未成年 → 拒收(不會被轉成成人)。
  if (r.isAdult !== true) return { ok: false, reason: "此角色描述為未成年,不接受入住(僅限成年角色)" };

  const archetypeKey = typeof r.archetypeKey === "string" && ARCHETYPE_ROUTINES[r.archetypeKey] ? r.archetypeKey : "office";

  // 玩家在建立畫面指定時，以玩家選擇為準；不讓 AI 依名字自行猜錯。
  const gender: Gender = selectedGender && GENDERS.includes(selectedGender)
    ? selectedGender
    : GENDERS.includes(r.gender) ? r.gender : "nonbinary";
  const attractedTo: Gender[] = Array.isArray(r.attractedTo) ? r.attractedTo.filter((g: unknown): g is Gender => GENDERS.includes(g as Gender)) : [];

  const coreTags: CoreTag[] = (Array.isArray(r.coreTags) ? r.coreTags : [])
    .slice(0, 3)
    .filter((t: any) => t && typeof t.label === "string")
    .map((t: any, i: number) => ({
      id: typeof t.id === "string" ? t.id.slice(0, 24) : `invite_tag_${i}`,
      label: String(t.label).slice(0, 14),
      behaviorHint: typeof t.behaviorHint === "string" ? t.behaviorHint.slice(0, 40) : "",
    }));
  if (coreTags.length === 0) coreTags.push({ id: "invite_default", label: "[特邀租客]", behaviorHint: "房東親自邀請入住的房客。" });

  const st = r.stats ?? {};
  const num = (v: unknown, dflt: number, lo = 0, hi = 100) => clamp(typeof v === "number" && Number.isFinite(v) ? v : dflt, lo, hi);

  const preferences: Partial<Record<RoomAttribute, number>> = {};
  if (r.preferences && typeof r.preferences === "object") {
    for (const [k, v] of Object.entries(r.preferences as Record<string, unknown>).slice(0, 3)) {
      if (ATTRS.includes(k as RoomAttribute) && typeof v === "number") preferences[k as RoomAttribute] = clamp(v, 1, 8);
    }
  }
  if (Object.keys(preferences).length === 0) preferences.cozy = 4;

  const apRaw = r.appearance ?? {};
  const appearance: Appearance = {
    hairStyle: ALL_HAIR_STYLES.includes(apRaw.hairStyle) ? (apRaw.hairStyle as HairStyle) : "short",
    hairColor: pickColor(apRaw.hairColor, HAIR_COLORS),
    shirt: pickColor(apRaw.shirt, SHIRT_COLORS),
    pants: pickColor(apRaw.pants, PANTS_COLORS),
    skin: pickColor(apRaw.skin, SKIN_TONES),
    accessory: ALL_ACCESSORIES.includes(apRaw.accessory) ? (apRaw.accessory as AccessoryKind) : "none",
  };

  const applicant: Applicant = {
    id: `tenant_invite_${Date.now()}`,
    name: name.slice(0, 12),
    archetypeKey,
    occupation: typeof r.occupation === "string" ? r.occupation.slice(0, 12) : "特邀租客",
    bio: typeof r.bio === "string" ? r.bio.slice(0, 60) : "房東親自邀請的神秘房客。",
    coreTags,
    preferences,
    monthlyRent: Math.round(num(r.monthlyRent, 14000, 8000, 20000) / 100) * 100,
    stars: 3, // 由面板依房間屬性重算
    gender,
    attractedTo,
    appearance,
    isAdult: true,
  };
  return { ok: true, applicant };
}
