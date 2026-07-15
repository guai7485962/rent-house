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
import { clearNoiseMemories } from "./memoryEffects";
import { addMoney } from "./economy";
import { getPlacements, placementInteract, roomRect } from "./placements";
import { spawnFx } from "../floor/fx";
import { save } from "./persistence";
import { currentBlocked, type Tile } from "../floor/pathfind";
import { startPairSession } from "../floor/pairSession";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "./clock";
import { grantEventSoundproofing, noiseComplaintEligible } from "./acoustics";

type Rng = () => number;

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 依遊戲日、參與者與事件 id 選文案；不用 Math.random，避免純文字擴充改變平衡 RNG。 */
function sceneIndex(parts: TenantRuntime[], salt: string, size: number): number {
  const day = Math.floor(state.gameMs / (24 * 3600 * 1000));
  const key = `${salt}|${day}|${parts.map((p) => p.tenant.id).join("|")}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % size;
}

const COMMUNITY_LINES = {
  laundryConflictA: [
    "🧺 在洗衣房為了搶最後一台空機和 {o} 起了口角。",
    "🧺 抱著一籃衣服趕到洗衣房時,發現 {o} 正要搶最後一台空機,兩人誰也不讓。",
    "🧺 在洗衣房為了誰先使用最後一台空機和 {o} 爭了半天,洗衣服洗出一肚子氣。",
  ],
  laundryConflictB: [
    "🧺 洗到一半發現機子被 {o} 佔走,兩人在洗衣房僵了一下。",
    "🧺 覺得空洗衣機被 {o} 搶走,兩個人對著倒數時間越講越不高興。",
    "🧺 和 {o} 各自抱著衣服堵在機器前,最後用猜拳也沒能好好收場。",
  ],
  laundryFriendlyA: [
    "🧺 在洗衣房邊等烘乾邊和 {o} 聊了起來,意外地投機。",
    "🧺 和 {o} 一起研究洗衣標籤,邊聊邊發現彼此都曾洗壞過衣服。",
    "🧺 等洗衣機時和 {o} 分享最近的生活,機器停了還多聊了一會。",
  ],
  laundryFriendlyB: [
    "🧺 洗衣服時碰上 {o},一來一往聊得挺開心。",
    "🧺 和 {o} 閒聊誰又把衛生紙洗成滿桶雪花,笑到差點忘了收衣服。",
    "🧺 被 {o} 幫忙撿起掉落的襪子,兩人順勢聊起各自的洗衣災難。",
  ],
  bathroomConflictA: [
    "🚿 早上趕時間,為了搶浴室在門外猛催 {o},兩人臉都臭了。",
    "🚿 為了搶浴室和 {o} 堵在門口互不相讓,差點連上班都一起遲到。",
    "🚿 眼看時間來不及,和 {o} 為了搶浴室順序吵得整條走廊都聽見。",
  ],
  bathroomConflictB: [
    "🚿 洗到一半被 {o} 在門外一直敲門催,心情有點差。",
    "🚿 被 {o} 敲門催了好幾次,一開門兩個人立刻互瞪。",
    "🚿 才剛打開熱水就聽見 {o} 敲門催,這場澡洗得全是火氣。",
  ],
  bathroomFriendlyA: [
    "🚿 在浴室門口排隊等 {o},順口聊了幾句,意外地自在。",
    "🚿 和 {o} 排隊等浴室時交換了今天的行程,順便互相提醒別遲到。",
    "🚿 排隊時借了 {o} 一條乾毛巾,兩人站在門邊聊得很自然。",
  ],
  bathroomFriendlyB: [
    "🚿 排隊等浴室時和 {o} 閒聊,關係近了一點。",
    "🚿 和 {o} 在浴室門口閒聊昨晚的事,輪到自己時還有點意猶未盡。",
    "🚿 等浴室時被 {o} 問了句早餐吃什麼,最後連晚餐都聊到了。",
  ],
  morningRush: [
    "🚽 早上尖峰,{names} 一起卡在浴室/廁所門口排隊乾瞪眼,邊等邊吐槽。",
    "🚽 {names} 同時趕著出門,浴室門口像臨時開了一場焦急的住戶會議。",
    "🚽 {names} 一早全堵在浴室外,互相報時、借東西,忙亂中反而有了默契。",
  ],
  groupOrder: [
    "🧋 和 {names} 揪團訂了手搖飲,樓裡難得這麼熱鬧。",
    "🍕 和 {names} 揪團湊外送免運,最後點得比原本預計多了一倍。",
    "🍗 和 {names} 揪團買宵夜,餐點送到後公共桌面瞬間擺滿。",
    "🧁 和 {names} 揪團試附近新開的甜點店,大家邊吃邊認真評分。",
  ],
  noiseComplain: [
    "😤 幾個鄰居一起去找 {o} 反映噪音問題。",
    "😤 忍了好幾晚後,幾個鄰居結伴去向 {o} 抱怨噪音。",
    "😤 幾個鄰居拿著各自記下的時間,一起找 {o} 抱怨深夜聲響。",
  ],
  noiseTarget: [
    "😰 被 {names} 一起上門抱怨噪音,壓力山大。",
    "😰 一開門就看到 {names} 排成一列抱怨噪音,當場不知道該先向誰解釋。",
    "😰 被 {names} 拿著噪音紀錄一起抱怨,只好尷尬地連聲道歉。",
  ],
  rooftop: [
    "🌇 傍晚和 {names} 相約頂樓乘涼吹風,一整天的疲憊都散了。",
    "🌆 和 {names} 帶著飲料上頂樓看晚霞,難得誰也沒有急著滑手機。",
    "🌙 和 {names} 在頂樓吹晚風聊近況,城市的聲音反而成了舒服的背景。",
    "✨ 和 {names} 在頂樓認星星,最後沒認出幾顆,倒是聊了很多心事。",
  ],
};

const LAUNDRY_UNAVAILABLE = new Set(["away", "sleeping_on_bed", "sleeping_on_couch", "showering", "crying", "pacing"]);

const fillCommunity = (line: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), value), line);

/** 在某設施中心掛一個特效(讓事發地點看得到) */
function fxAt(roomId: string, kind: Parameters<typeof spawnFx>[0]) {
  const rect = roomRect(roomId);
  if (rect) spawnFx(kind, Math.floor((rect.c0 + rect.c1) / 2), Math.floor((rect.r0 + rect.r1) / 2), 10000);
}

/** 洗衣事件的兩個實際站位：優先使用兩台洗衣機的互動格，缺機台時才掃設施內空格。 */
export function laundryStageTiles(): { a: Tile; b: Tile } | null {
  const blocked = currentBlocked();
  const usable = (tile: Tile) => blocked[tile.r]?.[tile.c] === false;
  const washerTiles = getPlacements()
    .filter((p) => p.room === "laundry" && p.defId === "laundry_washer")
    .map(placementInteract)
    .filter(usable)
    .filter((tile, i, all) => all.findIndex((t) => t.c === tile.c && t.r === tile.r) === i);
  if (washerTiles.length >= 2) return { a: washerTiles[0], b: washerTiles[1] };

  const rect = roomRect("laundry");
  if (!rect) return null;
  const open: Tile[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) if (usable({ c, r })) open.push({ c, r });
  }
  for (const a of open) {
    const b = open.find((t) => Math.abs(t.c - a.c) + Math.abs(t.r - a.r) === 1);
    if (b) return { a, b };
  }
  return null;
}

/** 把文字上的洗衣事件接到樓層演出：兩人中止原活動，走到洗衣機前互動一小時。 */
function stageLaundry(parts: TenantRuntime[], kind: "chat" | "anger") {
  const [a, b] = parts;
  for (const rt of [a, b]) {
    rt.tenant.visualState = "using_appliance";
    rt.activityPose = null;
    rt.activityTile = null;
    rt.activitySurface = null;
    rt.inLounge = false;
    rt.visiting = null;
    rt.visitHostId = null;
  }
  const tiles = laundryStageTiles();
  if (!tiles) {
    fxAt("laundry", kind);
    return;
  }
  const anchor = tiles.a;
  spawnFx(kind, anchor.c, anchor.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
  startPairSession(a.tenant.id, b.tenant.id, anchor, "stand_face", state.gameMs, REAL_MS_PER_GAME_HOUR, tiles);
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
    select: (present, rng) => {
      const available = shuffle(present, rng).filter((rt) => !LAUNDRY_UNAVAILABLE.has(rt.tenant.visualState));
      return available.length >= 2 ? available.slice(0, 2) : null;
    },
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      const variant = sceneIndex(parts, "laundry", COMMUNITY_LINES.laundryConflictA.length);
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -4);
        bumpMood(a, -2, 5);
        bumpMood(b, -2, 5);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.laundryConflictA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.laundryConflictB[variant], { o: a.tenant.name }), "notable");
        stageLaundry(parts, "anger");
        notify(`🧺 ${a.tenant.name} 和 ${b.tenant.name} 在洗衣房搶洗衣機起了口角`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 3);
        bumpMood(a, 3, -2);
        bumpMood(b, 3, -2);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.laundryFriendlyA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.laundryFriendlyB[variant], { o: a.tenant.name }), "notable");
        stageLaundry(parts, "chat");
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
      const variant = sceneIndex(parts, "bathroom", COMMUNITY_LINES.bathroomConflictA.length);
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -3);
        bumpMood(a, -1, 4);
        bumpMood(b, -1, 4);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.bathroomConflictA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.bathroomConflictB[variant], { o: a.tenant.name }), "notable");
        fxAt("bathroom", "anger");
        notify(`🚿 ${a.tenant.name} 和 ${b.tenant.name} 為了搶浴室鬧得不太愉快`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 2);
        bumpMood(a, 2, -1);
        bumpMood(b, 2, -1);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.bathroomFriendlyA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.bathroomFriendlyB[variant], { o: a.tenant.name }), "notable");
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
      const line = COMMUNITY_LINES.morningRush[sceneIndex(parts, "morning_rush", COMMUNITY_LINES.morningRush.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
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
      const line = COMMUNITY_LINES.groupOrder[sceneIndex(parts, "group_order", COMMUNITY_LINES.groupOrder.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
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
      const target = shuffled.find(noiseComplaintEligible);
      if (!target) return null;
      const complainers = shuffled.filter((rt) => rt.tenant.id !== target.tenant.id).slice(0, 2);
      if (complainers.length < 2) return null;
      return [target, ...complainers];
    },
    fire: (parts) => {
      const [target, ...complainers] = parts;
      const variant = sceneIndex(parts, "noise_tribunal", COMMUNITY_LINES.noiseComplain.length);
      bumpMood(target, -3, 6);
      for (const c of complainers) {
        bumpMood(c, -1, 3);
        adjustRelationship(c.tenant.id, target.tenant.id, -4);
        pushSocialLog(c, fillCommunity(COMMUNITY_LINES.noiseComplain[variant], { o: target.tenant.name }), "notable");
      }
      pushSocialLog(target, fillCommunity(COMMUNITY_LINES.noiseTarget[variant], { names: complainers.map((c) => c.tenant.name).join("、") }), "notable");
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
      const line = COMMUNITY_LINES.rooftop[sceneIndex(parts, "rooftop", COMMUNITY_LINES.rooftop.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
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
      const target = s.find(noiseComplaintEligible);
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
          { id: "soundproof", label: "花錢做隔音($3,000)", hint: "永久改善這間房的噪音外洩", money: -3000, all: { satisfaction: 6, affinity: 5 }, clearsNoise: true, installsSoundproofing: true },
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
  if (choice.clearsNoise) for (const rt of parts) clearNoiseMemories(rt.tenant); // 隔音選項:清掉噪音困擾記憶
  if ((choice.installsSoundproofing || (ev.id === "noise_verdict" && choice.id === "soundproof")) && parts[0]) {
    grantEventSoundproofing(parts[0].tenant.id); // 永久入 upgrades 存檔，不再只是清掉當下抱怨
  }
  for (const rt of parts) pushSocialLog(rt, `🏢 「${ev.title}」——房東選擇了「${choice.label}」。`, "notable");
  state.interactionCooldowns["community|group_any"] = state.gameMs; // 與 onCooldown("group_any") 同鍵
  state.pendingGroupEvent = null;
  save();
  return true;
}
