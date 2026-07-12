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
import type { GroupChoice, GroupEvent, GroupDelta } from "../types";
import { state, clamp, notify, pushSocialLog, type TenantRuntime } from "./gameState";
import { adjustRelationship, getRel } from "./social";
import { addMoney } from "./economy";
import { roomRect } from "./placements";
import { spawnFx } from "../floor/fx";
import { save } from "./persistence";

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
    // 浴室:關係差 → 趕時間搶浴室互相催促(rel↓);關係好 → 排隊等浴室時聊起來(rel↑)
    id: "bathroom",
    need: 2,
    cooldownDays: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, 2),
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -3);
        bumpMood(a, -1, 4);
        bumpMood(b, -1, 4);
        pushSocialLog(a, `🚿 早上趕時間,為了搶浴室在門外猛催 ${b.tenant.name},兩人臉都臭了。`, "notable");
        pushSocialLog(b, `🚿 洗到一半被 ${a.tenant.name} 在門外一直敲門催,心情有點差。`, "notable");
        fxAt("bathroom", "anger");
        notify(`🚿 ${a.tenant.name} 和 ${b.tenant.name} 為了搶浴室鬧得不太愉快`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 2);
        bumpMood(a, 2, -1);
        bumpMood(b, 2, -1);
        pushSocialLog(a, `🚿 在浴室門口排隊等 ${b.tenant.name},順口聊了幾句,意外地自在。`, "notable");
        pushSocialLog(b, `🚿 排隊等浴室時和 ${a.tenant.name} 閒聊,關係近了一點。`, "notable");
        fxAt("bathroom", "chat");
      }
    },
  },
  {
    // 洗衣間 · 早晨尖峰:幾個人一起卡在廁所/浴室門口,同仇敵愾反而拉近
    id: "morning_rush",
    need: 3,
    cooldownDays: 4,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      for (const rt of parts) bumpMood(rt, -1, 3);
      bondAll(parts, 1); // 一起排隊乾瞪眼、互吐苦水,反而熟了一點
      const names = parts.map((p) => p.tenant.name).join("、");
      for (const rt of parts) pushSocialLog(rt, `🚽 早上尖峰,${names} 一起卡在浴室/廁所門口排隊乾瞪眼,邊等邊吐槽。`, "notable");
      notify(`🚽 早晨尖峰:${names} 在廁所浴室門口排起隊`);
      fxAt("bathroom", "chat");
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

/** 每遊戲日呼叫:有機率觸發一件社群事件(牽動 3+ 人,進 Feed)。稀疏、不洗版。
 *  也可能升級成「有房東抉擇」的群體事件(較低機率、需 3+ 人、無待決的且離上次夠久)。 */
export function communityPass(rng: Rng = Math.random): boolean {
  const present = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent);
  if (present.length < 2) return false;
  // 房東抉擇的群體事件(你的決定一次影響整群人):較稀有,一次只掛一件
  if (present.length >= 3 && !state.pendingGroupEvent && rng() < 0.18) {
    if (rollGroupEvent(present, rng)) return true;
  }
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

// ---------------------------------------------------------------------------
// 群體事件(有房東抉擇版,§C-7):你的選擇一次影響整群人
// ---------------------------------------------------------------------------

interface GroupTemplate {
  id: string;
  need: number;
  select: (present: TenantRuntime[], rng: Rng) => TenantRuntime[] | null;
  make: (parts: TenantRuntime[]) => { title: string; description: string; choices: GroupChoice[] };
}

const GROUP_TEMPLATES: GroupTemplate[] = [
  {
    // 公共區設備老舊:房東出錢翻新 / 請住戶分攤 / 先擱著
    id: "public_repair",
    need: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    make: (parts) => ({
      title: "公共區的設備老舊了",
      description: `${parts.map((p) => p.tenant.name).join("、")} 都反映交誼廳的公共設備開始故障、用起來卡卡的。要怎麼處理?`,
      choices: [
        { id: "fix", label: "房東出錢翻新($2,500)", hint: "大家住得更舒服,對你更有好感", money: -2500, all: { satisfaction: 8, affinity: 6, mood: 4 } },
        { id: "split", label: "請住戶一起分攤", hint: "設備會修好,但住戶有點不情願", all: { satisfaction: 2, affinity: -2, stress: 4 } },
        { id: "defer", label: "先擱著不處理", hint: "省了錢,但滿意度和好感下滑", all: { satisfaction: -5, affinity: -3 } },
      ],
    }),
  },
  {
    // 噪音糾紛裁決:需要一位吵鬧/夜貓當事人 + 至少 2 位鄰居
    id: "noise_verdict",
    need: 3,
    select: (present, rng) => {
      const s = shuffle(present, rng);
      const target = s.find((rt) => hasTag(rt, ["noisy", "night_owl", "gamer", "late_return"]));
      if (!target) return null;
      const others = s.filter((rt) => rt.tenant.id !== target.tenant.id).slice(0, 2);
      return others.length >= 2 ? [target, ...others] : null;
    },
    make: (parts) => {
      const [target, ...others] = parts;
      return {
        title: "噪音糾紛要你裁決",
        description: `${others.map((p) => p.tenant.name).join("、")} 一起來反映 ${target.tenant.name} 的作息太吵。你怎麼處理?`,
        choices: [
          { id: "warn", label: `警告 ${target.tenant.name}`, hint: "站在鄰居這邊(當事人會不爽)", first: { stress: 8, affinity: -6 }, rest: { satisfaction: 4, affinity: 4 } },
          { id: "soundproof", label: "花錢做隔音($3,000)", hint: "一勞永逸,大家都滿意", money: -3000, all: { satisfaction: 6, affinity: 5 } },
          { id: "tolerate", label: "請大家互相包容", hint: "不花錢,但抱怨方會不滿", first: { mood: 3 }, rest: { stress: 4, affinity: -3 } },
        ],
      };
    },
  },
  {
    // 樓層聚餐提議:房東請客 / 大家 AA / 婉拒
    id: "floor_party",
    need: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    make: (parts) => ({
      title: "住戶想辦一場樓層聚餐",
      description: `${parts.map((p) => p.tenant.name).join("、")} 提議辦一場樓層聚餐熱鬧一下。你的態度?`,
      choices: [
        { id: "host", label: "房東請客($1,500)", hint: "全樓感情大加溫", money: -1500, all: { mood: 8, affinity: 8 }, bond: 4 },
        { id: "aa", label: "讓大家 AA 均分", hint: "還是很開心,只是你不出錢", all: { mood: 4 }, bond: 3 },
        { id: "decline", label: "婉拒這次提議", hint: "省事,但住戶有點掃興", all: { mood: -2, affinity: -2 } },
      ],
    }),
  },
];

/** 嘗試觸發一件群體抉擇事件(掛到 state.pendingGroupEvent 等房東決定);成功回 true */
export function rollGroupEvent(present: TenantRuntime[], rng: Rng = Math.random): boolean {
  if (state.pendingGroupEvent) return false;
  if (onCooldown("group_any", 3)) return false; // 群體抉擇之間至少隔 3 遊戲日
  const eligible = GROUP_TEMPLATES.filter((t) => present.length >= t.need);
  if (eligible.length === 0) return false;
  const tmpl = eligible[Math.floor(rng() * eligible.length)];
  const parts = tmpl.select(present, rng);
  if (!parts || parts.length < tmpl.need) return false;
  const built = tmpl.make(parts);
  state.pendingGroupEvent = { id: tmpl.id, participantIds: parts.map((p) => p.tenant.id), ...built };
  notify(`🏢 有一件全樓事務要你決定:${built.title}`);
  return true;
}

function applyDelta(rt: TenantRuntime, d?: GroupDelta) {
  if (!d) return;
  const s = rt.tenant.stats;
  if (d.mood) s.mood = clamp(s.mood + d.mood, 0, 100);
  if (d.stress) s.stress = clamp(s.stress + d.stress, 0, 100);
  if (d.affinity) s.affinity = clamp(s.affinity + d.affinity, 0, 100);
  if (d.satisfaction) rt.satisfaction = clamp(rt.satisfaction + d.satisfaction, 0, 100);
}

/** 房東拍板:套用選項效果到全體參與者 + 兩兩關係 + 房東花費,寫結果日誌,清掉待決 */
export function resolveGroupEvent(choiceId: string): boolean {
  const ev = state.pendingGroupEvent;
  if (!ev) return false;
  const choice = ev.choices.find((c) => c.id === choiceId);
  if (!choice) return false;
  if (choice.money) addMoney(choice.money, `全樓事務:${ev.title}`, "event");
  const parts = ev.participantIds.map((id) => state.runtimes[id]).filter(Boolean) as TenantRuntime[];
  parts.forEach((rt, i) => {
    applyDelta(rt, choice.all);
    applyDelta(rt, i === 0 ? choice.first : choice.rest);
    rt.unhappyHours = 0;
  });
  if (choice.bond) bondAll(parts, choice.bond);
  for (const rt of parts) pushSocialLog(rt, `🏢 「${ev.title}」——房東選擇了「${choice.label}」。`, "notable");
  state.interactionCooldowns["community|group_any"] = state.gameMs; // 與 onCooldown("group_any") 同鍵
  state.pendingGroupEvent = null;
  save();
  return true;
}
