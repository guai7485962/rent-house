/**
 * 社群事件(群體事件的省成本版,§C-7 low-cost):
 * 不動 AI schema、不需抉擇 UI——用一組「寫死的多人事件模板」讓一件事同時牽動 3+ 位租客,
 * 結果落在每個人的日誌與全樓動態 Feed,製造「整層樓在發生事情」的觀察感。
 *
 * 也順便讓「洗衣晾衣間」活起來:原本社交只在交誼廳觸發(inLounge),洗衣房是死空間;
 * 這裡新增洗衣房場景的相遇/口角,實現洗衣機本來就寫著卻從未發生的「搶最後一台空機」。
 *
 * 每遊戲日 communityPass 最多觸發一件(有機率、各事件有冷卻),節奏刻意稀疏不洗版。
 */
import { state, clamp, notify, pushSocialLog, type TenantRuntime } from "./gameState";
import { adjustRelationship, getRel } from "./social";
import { roomRect } from "./placements";
import { spawnFx } from "../floor/fx";

type Rng = () => number;

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const hasTag = (rt: TenantRuntime, ids: string[]) => rt.tenant.coreTags.some((t) => ids.includes(t.id));

/** 在某設施中心掛一個特效(讓事發地點看得到) */
function fxAt(roomId: string, kind: Parameters<typeof spawnFx>[0]) {
  const rect = roomRect(roomId);
  if (rect) spawnFx(kind, Math.floor((rect.c0 + rect.c1) / 2), Math.floor((rect.r0 + rect.r1) / 2), 10000);
}

/** 對一組人兩兩調整關係 */
function bondAll(parts: TenantRuntime[], delta: number) {
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) adjustRelationship(parts[i].tenant.id, parts[j].tenant.id, delta);
}

function bumpMood(rt: TenantRuntime, mood: number, stress: number) {
  const s = rt.tenant.stats;
  if (mood) s.mood = clamp(s.mood + mood, 0, 100);
  if (stress) s.stress = clamp(s.stress + stress, 0, 100);
}

interface CommunityEvent {
  id: string;
  /** 最少參與人數 */
  need: number;
  /** 冷卻(遊戲日) */
  cooldownDays: number;
  /** 從在場的人裡挑出參與者;回傳 null = 這次條件不成立 */
  select: (present: TenantRuntime[], rng: Rng) => TenantRuntime[] | null;
  /** 觸發:套用效果 + 寫日誌 */
  fire: (parts: TenantRuntime[], rng: Rng) => void;
}

export const COMMUNITY_EVENTS: CommunityEvent[] = [
  {
    // 洗衣房:關係好 → 邊等邊聊變更近;關係差 → 搶洗衣機起口角(讓死空間活起來)
    id: "laundry",
    need: 2,
    cooldownDays: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, 2),
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -4);
        bumpMood(a, -2, 5);
        bumpMood(b, -2, 5);
        pushSocialLog(a, `🧺 在洗衣房為了搶最後一台空機和 ${b.tenant.name} 起了口角。`, "notable");
        pushSocialLog(b, `🧺 洗到一半發現機子被 ${a.tenant.name} 佔走,兩人在洗衣房僵了一下。`, "notable");
        fxAt("laundry", "anger");
        notify(`🧺 ${a.tenant.name} 和 ${b.tenant.name} 在洗衣房搶洗衣機起了口角`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 3);
        bumpMood(a, 3, -2);
        bumpMood(b, 3, -2);
        pushSocialLog(a, `🧺 在洗衣房邊等烘乾邊和 ${b.tenant.name} 聊了起來,意外地投機。`, "notable");
        pushSocialLog(b, `🧺 洗衣服時碰上 ${a.tenant.name},一來一往聊得挺開心。`, "notable");
        fxAt("laundry", "chat");
      }
    },
  },
  {
    // 樓層揪團:三人以上一起訂手搖/團購,難得的熱鬧
    id: "group_order",
    need: 3,
    cooldownDays: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 4, -3);
      const names = parts.map((p) => p.tenant.name).join("、");
      for (const rt of parts) pushSocialLog(rt, `🧋 和 ${names} 揪團訂了手搖飲,樓裡難得這麼熱鬧。`, "notable");
      notify(`🧋 ${names} 揪團訂飲料,整層樓熱鬧了起來`);
    },
  },
  {
    // 噪音公審:一位吵鬧/夜貓的住戶被幾位鄰居集體抱怨(多對一)
    id: "noise_tribunal",
    need: 3,
    cooldownDays: 3,
    select: (present, rng) => {
      const shuffled = shuffle(present, rng);
      const target = shuffled.find((rt) => hasTag(rt, ["noisy", "night_owl", "gamer", "late_return"]));
      if (!target) return null;
      const complainers = shuffled.filter((rt) => rt.tenant.id !== target.tenant.id).slice(0, 2);
      if (complainers.length < 2) return null;
      return [target, ...complainers];
    },
    fire: (parts) => {
      const [target, ...complainers] = parts;
      bumpMood(target, -3, 6);
      for (const c of complainers) {
        bumpMood(c, -1, 3);
        adjustRelationship(c.tenant.id, target.tenant.id, -4);
        pushSocialLog(c, `😤 幾個鄰居一起去找 ${target.tenant.name} 反映噪音問題。`, "notable");
      }
      pushSocialLog(target, `😰 被 ${complainers.map((c) => c.tenant.name).join("、")} 一起上門抱怨噪音,壓力山大。`, "notable");
      notify(`😤 幾位住戶一起向 ${target.tenant.name} 反映噪音`);
    },
  },
  {
    // 頂樓乘涼:傍晚幾個人相約頂樓吹風,壓力都消了
    id: "rooftop",
    need: 3,
    cooldownDays: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 5, -6);
      const names = parts.map((p) => p.tenant.name).join("、");
      for (const rt of parts) pushSocialLog(rt, `🌇 傍晚和 ${names} 相約頂樓乘涼吹風,一整天的疲憊都散了。`, "notable");
      notify(`🌇 ${names} 相約頂樓乘涼`);
    },
  },
];

function onCooldown(id: string, days: number): boolean {
  const last = state.interactionCooldowns[`community|${id}`];
  return last != null && state.gameMs - last < days * 24 * 3600 * 1000;
}

/** 每遊戲日呼叫:有機率觸發一件社群事件(牽動 3+ 人,進 Feed)。稀疏、不洗版。 */
export function communityPass(rng: Rng = Math.random): boolean {
  const present = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent);
  if (present.length < 2) return false;
  if (rng() > 0.4) return false; // 不是每天都有事發生(稀疏、不洗版)
  const eligible = COMMUNITY_EVENTS.filter((e) => present.length >= e.need && !onCooldown(e.id, e.cooldownDays));
  if (eligible.length === 0) return false;
  const ev = eligible[Math.floor(rng() * eligible.length)];
  const parts = ev.select(present, rng);
  if (!parts || parts.length < ev.need) return false;
  ev.fire(parts, rng);
  state.interactionCooldowns[`community|${ev.id}`] = state.gameMs;
  return true;
}
