/**
 * 互動框架(設計檢討 §10-1 + §10-5):資料驅動的雙人互動目錄 + 單一資格把關 canInteract()。
 *
 * 本階段涵蓋「同房互動」——情侶/同居的兩人同處一室時的互動(交誼廳的聊天/衝突仍由 social.encounter 處理,
 * §10-2 目錄擴充時再統一)。三道硬規則(§10-0):
 *   1. adult 互動 ⇒ 🔞 成人模式開啟(預設關)
 *   2. adult 互動 ⇒ 雙方 isAdult(canRomance 已含此檢查;undefined = 內建成年角色)
 *   3. privacy 互動 ⇒ 房內無第三人
 * 所有資格檢查收斂在 canInteract(),任何入口都不得繞過。
 * 🔞 內容一律遮蔽式:文字含蓄、畫面只有霧氣(steam)/關燈(lights)演出,無露骨圖像。
 */
import type { Tenant } from "../types";
import { getRel, canRomance, pairKey, adjustRelationship } from "./social";
import { feudActive } from "./conflicts";
import { maybeWitness } from "./drama";
import { state, clamp, roomOfTenant, pushMemory, pushSocialLog, applySocialEffect, type TenantRuntime } from "./gameState";
import { roomRect } from "./placements";
import { spawnFx, type FxKind } from "../floor/fx";
import { startPairSession, type PairPose } from "../floor/pairSession";
import { MS_PER_GAME_HOUR } from "./clock";

export type InteractionTier = "close" | "crush" | "couple" | "cohabit";

export interface InteractionDef {
  id: string;
  /** 關係門檻:close=好友以上(50+)、crush=曖昧(75+ 且互有好感)、couple=情侶、cohabit=同居中的情侶 */
  tier: InteractionTier;
  /** 發生地點:room=同房(情侶/同居)、lounge=交誼廳(兩人同時在場) */
  location: "room" | "lounge";
  /** true = 需 🔞 成人模式 + 雙方成年(遮蔽式演出) */
  adult?: boolean;
  /** true = 需房內無第三人 */
  privacy?: boolean;
  /** 觸發時段(含首尾;首>尾表示跨夜,如 [23,1]) */
  timeWindow?: [number, number];
  weight: number;
  cooldownHours: number;
  /** 通過所有條件後,每小時實際觸發的機率 */
  chance: number;
  /** 雙方日誌文字({o}=對方名字);隨機挑一句 */
  lines: string[];
  memoryLabel?: string;
  memoryHint?: string;
  fx: FxKind;
  /** 雙人圖式(§10-6):pair=兩人走到一起站著演(預設);hidden=遮蔽式,兩人隱藏只留 fx(🔞 一律用這個) */
  pose?: PairPose;
  effects: { rel: number; mood?: number; stress?: number; energy?: number };
}

export const INTERACTIONS: InteractionDef[] = [
  {
    id: "cuddle_tv",
    tier: "couple",
    location: "room",
    timeWindow: [19, 22],
    weight: 3,
    cooldownHours: 10,
    chance: 0.4,
    fx: "hearts",
    lines: ["和{o}窩在房裡靠著看劇,誰也沒說話,但很安心。", "和{o}擠在一起追劇,搶著吐槽劇情。"],
    effects: { rel: 2, mood: 5, stress: -4 },
  },
  {
    id: "midnight_snack",
    tier: "couple",
    location: "room",
    timeWindow: [22, 23],
    weight: 2,
    cooldownHours: 12,
    chance: 0.3,
    fx: "chat",
    lines: ["和{o}分食深夜的泡麵,湯都涼了還在聊。"],
    effects: { rel: 2, mood: 4 },
  },
  {
    id: "lazy_morning",
    tier: "cohabit",
    location: "room",
    timeWindow: [7, 9],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "hearts",
    lines: ["和{o}賴在床上不肯起來,鬧鐘響了三次都當沒聽到。"],
    effects: { rel: 1, mood: 4, energy: 3, stress: -3 },
  },
  {
    id: "cook_dinner",
    tier: "cohabit",
    location: "room",
    timeWindow: [18, 19],
    weight: 2,
    cooldownHours: 16,
    chance: 0.3,
    fx: "chat",
    lines: ["和{o}擠在小流理台前做晚餐,差點打翻鍋子,笑成一團。"],
    effects: { rel: 2, mood: 4 },
  },
  // ——— 🔞 成人模式(遮蔽式:文字含蓄、畫面只有霧氣/關燈)———
  {
    id: "bath_together",
    tier: "couple",
    location: "room",
    adult: true,
    privacy: true,
    timeWindow: [21, 23],
    weight: 2,
    cooldownHours: 40,
    chance: 0.3,
    fx: "steam",
    pose: "hidden",
    lines: ["和{o}一起進了浴室,水聲響了很久很久…"],
    memoryLabel: "[臉紅的祕密]",
    memoryHint: "和戀人共浴的悄悄話,兩人都不會說出去。",
    effects: { rel: 3, mood: 8, stress: -6 },
  },
  {
    id: "night_intimacy",
    tier: "couple",
    location: "room",
    adult: true,
    privacy: true,
    timeWindow: [23, 1],
    weight: 3,
    cooldownHours: 36,
    chance: 0.35,
    fx: "lights",
    pose: "hidden",
    lines: ["房裡的燈早早就關了,門把上掛著「請勿打擾」…"],
    memoryLabel: "[甜蜜的夜晚]",
    memoryHint: "昨晚之後,看對方的眼神都是軟的。",
    effects: { rel: 4, mood: 10, stress: -8, energy: -4 },
  },
  // ——— 交誼廳:朋友(close)———
  {
    id: "deep_talk",
    tier: "close",
    location: "lounge",
    timeWindow: [21, 1],
    weight: 2,
    cooldownHours: 24,
    chance: 0.25,
    fx: "chat",
    lines: ["和{o}聊到深夜,把最近的煩惱都倒了出來。", "被{o}一句「你最近還好嗎」戳中,聊了很久。"],
    effects: { rel: 3, mood: 3, stress: -6 },
  },
  {
    id: "game_night",
    tier: "close",
    location: "lounge",
    timeWindow: [19, 23],
    weight: 2,
    cooldownHours: 16,
    chance: 0.25,
    fx: "chat",
    lines: ["和{o}擠在沙發上開黑打電動,說好輸的人去倒垃圾。"],
    effects: { rel: 2, mood: 5, stress: -2 },
  },
  {
    id: "share_delivery",
    tier: "close",
    location: "lounge",
    timeWindow: [11, 20],
    weight: 2,
    cooldownHours: 16,
    chance: 0.2,
    fx: "chat",
    lines: ["{o}多點了一份外送,兩人分著吃,順便交換八卦。"],
    effects: { rel: 2, mood: 3 },
  },
  // ——— 交誼廳:曖昧(crush,75+ 且互有好感)———
  {
    id: "share_earbuds",
    tier: "crush",
    location: "lounge",
    timeWindow: [19, 23],
    weight: 2,
    cooldownHours: 20,
    chance: 0.25,
    fx: "hearts",
    lines: ["和{o}共用一副耳機看劇,肩膀碰著肩膀,誰都沒有移開。"],
    memoryLabel: "[心動的距離]",
    memoryHint: "那晚共用耳機的距離,近得能聽見彼此的呼吸。",
    effects: { rel: 3, mood: 4 },
  },
  {
    id: "feed_snack",
    tier: "crush",
    location: "lounge",
    timeWindow: [21, 23],
    weight: 2,
    cooldownHours: 20,
    chance: 0.2,
    fx: "hearts",
    lines: ["{o}把最後一口宵夜留給了自己,心跳漏了半拍。"],
    effects: { rel: 3, mood: 4 },
  },
];

export interface InteractCtx {
  hour: number;
  /** 房內是否有第三人 */
  thirdPresent: boolean;
  /** 🔞 成人模式是否開啟 */
  adultMode: boolean;
  /** 這對是否同居中 */
  cohabiting: boolean;
}

const inWindow = (hour: number, w?: [number, number]): boolean => {
  if (!w) return true;
  const [s, e] = w;
  return s <= e ? hour >= s && hour <= e : hour >= s || hour <= e; // 跨夜
};

/** 唯一的互動資格把關:關係門檻 → 成人(開關+雙方成年+可戀愛)→ 私密 → 時段 */
export function canInteract(def: InteractionDef, a: Tenant, b: Tenant, ctx: InteractCtx): boolean {
  if (feudActive(a.id, b.id)) return false; // 冷戰中互相當作看不見(§10-2)
  const rel = getRel(a.id, b.id);
  if (def.tier === "close" && !(rel && (rel.value >= 50 || rel.romantic))) return false;
  if (def.tier === "crush" && !(rel && (rel.romantic || (rel.value >= 75 && canRomance(a, b))))) return false;
  if (def.tier === "couple" && !rel?.romantic) return false;
  if (def.tier === "cohabit" && !(rel?.romantic && ctx.cohabiting)) return false;
  if (def.adult) {
    if (!ctx.adultMode) return false;
    if (!(a.isAdult ?? true) || !(b.isAdult ?? true)) return false;
    if (!canRomance(a, b)) return false; // 成年 + 取向雙重把關
  }
  if (def.privacy && ctx.thirdPresent) return false;
  if (!inWindow(ctx.hour, def.timeWindow)) return false;
  return true;
}

const cdKey = (aId: string, bId: string, defId: string) => `${pairKey(aId, bId)}|${defId}`;

function offCooldown(aId: string, bId: string, def: InteractionDef): boolean {
  const last = state.interactionCooldowns[cdKey(aId, bId, def.id)];
  return last == null || state.gameMs - last >= def.cooldownHours * MS_PER_GAME_HOUR;
}

function applyPairEffect(rt: TenantRuntime, eff: InteractionDef["effects"]) {
  applySocialEffect(rt, { mood: eff.mood, stress: eff.stress });
  if (eff.energy) rt.tenant.stats.energy = clamp(rt.tenant.stats.energy + eff.energy, 0, 100);
}

/** 對一組同地點的租客跑兩兩互動;把觸發的 pairKey 收進 triggered(給 socialPass 去重) */
function runGroup(present: TenantRuntime[], location: "room" | "lounge", roomId: string | null, hour: number, triggered: Set<string>) {
  if (present.length < 2) return;
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const A = present[i];
      const B = present[j];
      const ctx: InteractCtx = {
        hour,
        thirdPresent: present.length > 2,
        adultMode: state.adultMode,
        cohabiting: roomId != null && (state.cohabits[A.tenant.id] === roomId || state.cohabits[B.tenant.id] === roomId),
      };
      const eligible = INTERACTIONS.filter(
        (def) => def.location === location && canInteract(def, A.tenant, B.tenant, ctx) && offCooldown(A.tenant.id, B.tenant.id, def),
      );
      if (eligible.length === 0) continue;
      // 權重挑一個,再擲觸發機率(不是每小時都黏在一起)
      const total = eligible.reduce((s, d) => s + d.weight, 0);
      let roll = Math.random() * total;
      let def = eligible[0];
      for (const d of eligible) {
        roll -= d.weight;
        if (roll <= 0) {
          def = d;
          break;
        }
      }
      if (Math.random() > def.chance) continue;

      performInteraction(A, B, def, roomId);
      triggered.add(pairKey(A.tenant.id, B.tenant.id));
    }
  }
}

/** 實際執行一次互動:雙方日誌 + 數值 + 關係 + 記憶 + 現場演出 + 冷卻 + 撞見判定 */
function performInteraction(A: TenantRuntime, B: TenantRuntime, def: InteractionDef, roomId: string | null) {
  const line = def.lines[Math.floor(Math.random() * def.lines.length)];
  pushSocialLog(A, line.replace(/\{o\}/g, B.tenant.name), "notable");
  pushSocialLog(B, line.replace(/\{o\}/g, A.tenant.name), "notable");
  applyPairEffect(A, def.effects);
  applyPairEffect(B, def.effects);
  if (def.effects.rel) adjustRelationship(A.tenant.id, B.tenant.id, def.effects.rel);
  if (def.memoryLabel) {
    pushMemory(A.tenant, def.memoryLabel, def.memoryHint ?? "", "ai_event");
    pushMemory(B.tenant, def.memoryLabel, def.memoryHint ?? "", "ai_event");
  }
  // 演出錨點:優先兩人所在的家具格,其次房間中心
  const rect = roomId ? roomRect(roomId) : null;
  const anchor = A.targetTile ?? B.targetTile ?? (rect ? { c: Math.floor((rect.c0 + rect.c1) / 2), r: Math.floor((rect.r0 + rect.r1) / 2) } : null);
  if (anchor) {
    spawnFx(def.fx, anchor.c, anchor.r, 15000);
    // §10-6:登記雙人 session——兩人走到錨點旁站在一起;🔞 遮蔽式則整段隱藏
    startPairSession(A.tenant.id, B.tenant.id, anchor, def.pose ?? "pair", state.gameMs, 15000);
  }
  state.interactionCooldowns[cdKey(A.tenant.id, B.tenant.id, def.id)] = state.gameMs;
  // 被撞見(§10-2 戲劇批):私密互動有低機率被第三位租客撞見,三方尷尬
  if (def.privacy) maybeWitness(A, B);
}

/**
 * AI 提議互動(§10-3):玩家在 AI 事件裡拍板後觸發。
 * 白名單 + 門檻把關:未知 id / 外出 / 冷戰一律擋;🔞 互動走完整 canInteract(三條硬規則
 * + 情侶門檻 + 時段,AI 不可越權);一般互動放寬關係階層/時段/冷卻(劇情已由 AI 鋪陳、玩家已同意)。
 */
export function forceInteraction(aId: string, bId: string, defId: string): boolean {
  const def = INTERACTIONS.find((d) => d.id === defId);
  const A = state.runtimes[aId];
  const B = state.runtimes[bId];
  if (!def || !A || !B) return false;
  if (A.tenant.visualState === "away" || B.tenant.visualState === "away") return false;
  if (feudActive(aId, bId)) return false;

  const roomId = roomOfTenant(aId) ?? roomOfTenant(bId);
  const thirdPresent = Object.values(state.runtimes).some(
    (rt) => rt !== A && rt !== B && rt.tenant.visualState !== "away" && !rt.inLounge && roomOfTenant(rt.tenant.id) === roomId,
  );
  if (def.adult) {
    const ctx: InteractCtx = {
      hour: new Date(state.gameMs).getHours(),
      thirdPresent,
      adultMode: state.adultMode,
      cohabiting: roomId != null && (state.cohabits[aId] === roomId || state.cohabits[bId] === roomId),
    };
    if (!canInteract(def, A.tenant, B.tenant, ctx)) return false;
  } else if (def.privacy && thirdPresent) {
    return false;
  }
  performInteraction(A, B, def, roomId);
  return true;
}

/** 每小時互動 pass(由 tick 呼叫):同房(情侶/同居)+ 交誼廳(朋友/曖昧)。
 *  回傳本小時觸發過互動的 pairKey,socialPass 據此跳過同一對(避免同小時雙重互動)。 */
export function interactionsPass(): Set<string> {
  const triggered = new Set<string>();
  const hour = new Date(state.gameMs).getHours();

  // 同房組(在這間房、沒外出、沒待決事件)
  const byRoom = new Map<string, TenantRuntime[]>();
  const loungeGroup: TenantRuntime[] = [];
  for (const rt of Object.values(state.runtimes)) {
    if (rt.tenant.visualState === "away" || rt.pendingEvent) continue;
    if (rt.inLounge) {
      loungeGroup.push(rt);
      continue;
    }
    const roomId = roomOfTenant(rt.tenant.id);
    if (!roomId) continue;
    if (!byRoom.has(roomId)) byRoom.set(roomId, []);
    byRoom.get(roomId)!.push(rt);
  }

  for (const [roomId, present] of byRoom) runGroup(present, "room", roomId, hour, triggered);
  runGroup(loungeGroup, "lounge", null, hour, triggered);
  return triggered;
}
