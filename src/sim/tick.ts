/**
 * 每小時模擬(store 拆分:tick 模組)。
 * 作息+偏離 → 定位/日誌/數值、張力事件、交誼廳社交、換日(收租+AI 日記),
 * 以及補進度(syncToNow)與快轉(同步版給測試、分批版給 UI)。
 */
import type { StatDeltas, TenantVisualState, RoomPropState } from "../types";
import { MAX_CATCHUP_HOURS, MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR, currentGameMs } from "./clock";
import { bathroomActivityForDay, laundryHourForDay, routineSlot, resolveTarget, routineRoles, type Role } from "./routine";
import { rollEvent } from "./events";
import { encounter, listRelationships, pairKey, getRel } from "./social";
import { memoryDrift, pruneContradictedMemories, decayMemories } from "./memoryEffects";
import { DIRECTIVES } from "./directives";
import { generateHourly } from "./generate";
import { TENANT_SPOTS } from "../floor/map";
import { roomRect } from "./placements";
import type { Tile } from "../floor/pathfind";
import {
  state,
  clamp,
  clampDelta,
  fmt,
  gameDayIndex,
  notify,
  pushSocialLog,
  applySocialEffect,
  roomOfTenant,
  canStartCohabit,
  LOG_CAP,
  type TenantRuntime,
} from "./gameState";
import { collectRent } from "./economy";
import { maintenancePass } from "./maintenance";
import { tryFight, feudActive, feudPass, maybeFeudAfterConflict, avoidLounge } from "./conflicts";
import { dramaPass } from "./drama";
import { moveOut, endCohabitOnBreakup } from "./tenancy";
import { diaryPass, resetDiaryQuota } from "./narration";
import { petsPass, catJournalPass } from "./pets";
import { legacyPass, unlock } from "./legacy";
import { communityPass } from "./community";
import { weeklyReportPass } from "./weeklyReport";
import { spawnFx, pruneFxByGame } from "../floor/fx";
import { startPairSession } from "../floor/pairSession";
import { canStartRoomVisit, interactionsPass } from "./interactions";
import { save } from "./persistence";
import { getDef } from "../furniture/catalog";
import { placementFootprint, placementRotation } from "./placements";
import type { Placement } from "../floor/map";
import { nextRotation } from "../furniture/rotation";

/** 共用浴室設備的本小時佔用者；不同設備可同時使用，同一設備必須排隊。 */
let bathroomClaimMs = -1;
const bathroomClaims = new Map<string, string>();

export function resetBathroomClaims(hourMs = -1) {
  bathroomClaimMs = hourMs;
  bathroomClaims.clear();
}

export function claimBathroomFixture(fixtureId: string, tenantId: string, hourMs = state.gameMs): boolean {
  if (bathroomClaimMs !== hourMs) resetBathroomClaims(hourMs);
  for (const [fixture, owner] of bathroomClaims) if (owner === tenantId) bathroomClaims.delete(fixture);
  const owner = bathroomClaims.get(fixtureId);
  if (owner && owner !== tenantId) return false;
  bathroomClaims.set(fixtureId, tenantId);
  return true;
}

/** 家具目錄 id 可能重複擺放，座標也要納入才能分辨兩座同型設備。 */
function bathroomFixtureId(p: Placement): string {
  return `${p.room}:${p.defId}:${p.c},${p.r}`;
}

/** 適合串門子的休閒狀態 */
const LEISURE_STATES = new Set<TenantVisualState>(["idle", "reading", "watching_tv", "gaming", "eating"]);
/** 可以暫停手邊事情接待朋友；睡覺、外出、洗澡或崩潰時不接受拜訪。 */
const VISIT_UNAVAILABLE_STATES = new Set<TenantVisualState>([
  "away", "sleeping_on_bed", "sleeping_on_couch", "showering", "using_toilet",
  "washing_at_sink", "taking_bath", "waiting_for_bathroom", "crying",
]);
const ACTIVE_BATHROOM_STATES = new Set<TenantVisualState>(["showering", "using_toilet", "washing_at_sink", "taking_bath"]);
/** 在 applyHour 原時序先擲骰，等全員作息確定後才實際配對。 */
const visitIntents = new Set<string>();

/** 所有人作息確定後才安排串門：雙方都休閒、好友以上，且本小時確實有共同活動可演。 */
function roomVisitPass(hour: number) {
  if (hour < 15 || hour > 23) return;
  const engaged = new Set<string>();
  for (const visitor of Object.values(state.runtimes)) {
    if (engaged.has(visitor.tenant.id) || visitor.pendingEvent || visitor.inLounge || visitor.visiting) continue;
    if (!LEISURE_STATES.has(visitor.tenant.visualState) || !visitIntents.has(visitor.tenant.id)) continue;
    const myRoom = roomOfTenant(visitor.tenant.id);
    let best: TenantRuntime | null = null;
    let bestVal = 49; // 好友門檻與 InteractionTier.close 一致:關係值 ≥ 50
    for (const host of Object.values(state.runtimes)) {
      if (host === visitor || engaged.has(host.tenant.id) || host.pendingEvent || host.inLounge || host.visiting) continue;
      if (VISIT_UNAVAILABLE_STATES.has(host.tenant.visualState)) continue;
      const hostRoom = roomOfTenant(host.tenant.id);
      if (!hostRoom || hostRoom === myRoom) continue;
      const rel = getRel(visitor.tenant.id, host.tenant.id);
      const value = rel?.value ?? 0;
      if (!(rel?.romantic || value >= 50) || value <= bestVal) continue;
      if (!canStartRoomVisit(visitor, host, hostRoom, hour)) continue;
      best = host;
      bestVal = value;
    }
    if (!best) continue;
    const hostRoom = roomOfTenant(best.tenant.id)!;
    visitor.visiting = hostRoom;
    visitor.visitHostId = best.tenant.id;
    visitor.targetTile = homeTile(best.tenant.id);
    // 拜訪成立後雙方暫停原本的單人活動；下一個 interactionsPass 會立刻建立共同 session。
    visitor.tenant.visualState = "idle";
    best.tenant.visualState = "idle";
    visitor.roomProps = deriveProps(visitor, "idle", hour);
    best.roomProps = deriveProps(best, "idle", hour);
    engaged.add(visitor.tenant.id);
    engaged.add(best.tenant.id);
  }
  visitIntents.clear();
}

export const homeTile = (tenantId: string): Tile => {
  // 同居者優先回伴侶的房(即使是有固定床位的種子租客)
  const cohabitRoom = state.cohabits[tenantId];
  if (cohabitRoom) {
    const rr = roomRect(cohabitRoom);
    if (rr) return { c: Math.floor((rr.c0 + rr.c1) / 2), r: Math.floor((rr.r0 + rr.r1) / 2) };
  }
  const s = TENANT_SPOTS.find((x) => x.tenantId === tenantId);
  if (s) return { c: s.c, r: s.r };
  const roomId = roomOfTenant(tenantId);
  const rect = roomId ? roomRect(roomId) : null;
  if (rect) return { c: Math.floor((rect.c0 + rect.c1) / 2), r: Math.floor((rect.r0 + rect.r1) / 2) };
  return { c: 7, r: 10 };
};

/** 目前生效中的行為指令 id(過期回 null;過期清理與日誌在 hourlyTick 做) */
function activeDirective(rt: TenantRuntime): string | null {
  return rt.directive && gameDayIndex() <= rt.directive.untilDay ? rt.directive.id : null;
}

/** 作息 + 行為指令 + 偏離 → 最終 { state, role, isDeviation } */
function decideState(rt: TenantRuntime, hour: number): { state: TenantVisualState; role: Role; isDeviation: boolean; effectState?: TenantVisualState } {
  const dir = activeDirective(rt);
  // 作息位移型指令:熬夜=整段往後 3 小時、早鳥=提前 2 小時(查表時反向偏移)
  const slotHour = dir === "night_owl" ? (hour - 3 + 24) % 24 : dir === "early_bird" ? (hour + 2) % 24 : hour;
  let slot = routineSlot(rt.tenant.id, slotHour);
  // 活動插入型指令:在特定時段覆蓋原作息(不動睡眠/外出)
  if (dir === "adopt_cat" && hour === 20 && slot.state !== "away" && slot.state !== "sleeping_on_bed") {
    slot = { role: "sofa", state: "playing_with_cat" };
  } else if (dir === "binge_watch" && (hour === 22 || hour === 23) && slot.state !== "away" && slot.state !== "sleeping_on_bed") {
    slot = { role: "tv", state: "watching_tv" };
  } else if (dir === "overtime" && (hour === 19 || hour === 20) && slot.state !== "away" && slot.state !== "sleeping_on_bed") {
    // 自發行為 overtime:晚上還釘在書桌前趕工(working_at_desk 的既有數值效果 = 壓力↑精力↓)
    slot = { role: "desk", state: "working_at_desk" };
  } else if (dir === "self_care" && (hour === 22 || hour === 23) && slot.state !== "away") {
    // 自發行為 self_care:提早上床休息(sleeping 的既有效果 = 精力回充)
    slot = { role: "bed", state: "sleeping_on_bed" };
  }
  let effectState: TenantVisualState | undefined;
  // 原本籠統的 bathroom/showering 依日期穩定輪替成淋浴、如廁、盥洗或泡澡。
  // 沒有浴缸時泡澡日退回淋浴；數值仍沿用原 showering，純粹增加可見生活內容。
  if (!dir && slot.role === "bathroom" && slot.state === "showering") {
    const candidate = bathroomActivityForDay(rt.tenant.id, gameDayIndex(), hour);
    const chosen = candidate === "taking_bath" && !resolveTarget("bathroom", roomOfTenant(rt.tenant.id), candidate)
      ? "showering"
      : candidate;
    if (chosen !== slot.state) {
      effectState = slot.state;
      slot = { role: "bathroom", state: chosen };
    }
  }
  // 約每四天一次的日常洗衣：只覆寫原本清醒且在家的時段，AI 指令期間仍以指令劇情優先。
  if (!dir && laundryHourForDay(rt.tenant.id, gameDayIndex()) === hour) {
    effectState = slot.state;
    slot = { role: "laundry", state: "using_appliance" };
  }
  const stress = rt.tenant.stats.stress;
  // 壓力偏離:睡不著 / 崩潰
  if (stress >= 95 && slot.state !== "away") {
    return { state: "crying", role: "bed", isDeviation: true };
  }
  if (stress >= 90 && slot.state === "sleeping_on_bed") {
    return { state: "pacing", role: "bed", isDeviation: true };
  }
  return { state: slot.state, role: slot.role, isDeviation: false, effectState };
}

/** 依狀態衍生房間小物件(給房間細看畫面氛圍) */
function deriveProps(rt: TenantRuntime, st: TenantVisualState, hour: number): RoomPropState[] {
  const tenantId = rt.tenant.id;
  const props: RoomPropState[] = [];
  if (["working_at_desk", "gaming", "streaming"].includes(st)) props.push("screen_glow");
  if (st === "streaming") props.push("mic_setup_active");
  if (st === "sleeping_on_bed" && (hour < 6 || hour >= 22)) props.push("lights_off");
  if (tenantId === "tenant_lin_asmr") props.push("curtains_closed");
  if (tenantId === "tenant_chen_engineer" && st === "playing_with_cat") props.push("cat_on_table");
  // 行為指令 adopt_cat:房裡常駐一隻貓(逗貓時在桌上,其他時候睡沙發)
  if (activeDirective(rt) === "adopt_cat" && !props.includes("cat_on_table")) {
    props.push(st === "playing_with_cat" ? "cat_on_table" : "cat_sleeping_on_couch");
  }
  return props;
}

// ---------------------------------------------------------------------------
// 數值模型(設計檢討 §4):homeostasis 抗飽和 + wellbeing/energy 後果迴路
// ---------------------------------------------------------------------------

/** 每小時朝基準回歸的比例(6%:極端值一天內明顯回落,但擋不住持續的事件/作息推力) */
const HOMEOSTASIS_K = 0.06;

/**
 * 性格決定的心情/壓力基準值(homeostasis 的「回到哪」),再疊三個回饋:
 * - 社交(socialFulfillment 簡版):有戀人/朋友 → 心情基準↑;完全孤立 → ↓
 * - 身心健康後果:wellbeing 低 → 心情基準大幅下修(病懨懨開心不起來)
 * - 精力後果:energy 低 → 壓力基準上修(累到什麼都煩)
 */
function baselines(rt: TenantRuntime): { mood: number; stress: number } {
  let mood = 62;
  let stress = 38;
  for (const tag of rt.tenant.coreTags) {
    const l = tag.label;
    if (/樂觀|開朗|熱情|陽光|樂天/.test(l)) mood += 8;
    if (/悲觀|憂鬱|厭世|陰沉/.test(l)) mood -= 8;
    if (/工作狂|拼命|截稿|捲/.test(l)) stress += 12;
    if (/焦慮|社恐|膽小|完美主義|敏感/.test(l)) stress += 8;
    if (/佛系|慵懶|隨性|悠哉/.test(l)) stress -= 10;
    if (/自律|規律/.test(l)) stress -= 4;
  }
  const id = rt.tenant.id;
  const bonds = listRelationships().filter(
    (r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId],
  );
  if (bonds.some((b) => b.romantic)) mood += 6;
  else if (bonds.some((b) => b.value >= 50)) mood += 3;
  else if (bonds.length > 0 && bonds.every((b) => b.value < 35)) mood -= 4;
  const s = rt.tenant.stats;
  if (s.wellbeing < 30) mood -= 10;
  else if (s.wellbeing >= 80) mood += 3;
  if (s.energy < 25) stress += 10;
  return { mood: clamp(mood, 10, 90), stress: clamp(stress, 10, 90) };
}

function applyStat(rt: TenantRuntime, d: StatDeltas) {
  const s = rt.tenant.stats;
  const base = baselines(rt);
  // homeostasis:mood/stress 先朝性格基準回歸,再吃這小時的活動增量 → 不再黏死 0/100
  s.mood = clamp(s.mood + (base.mood - s.mood) * HOMEOSTASIS_K + clampDelta(d.mood), 0, 100);
  s.stress = clamp(s.stress + (base.stress - s.stress) * HOMEOSTASIS_K + clampDelta(d.stress), 0, 100);
  // affinity 是「關係的累積」不是情緒,不回歸;energy 是資源(睡覺充、活動耗);wellbeing 慢變
  s.affinity = clamp(s.affinity + clampDelta(d.affinity), 0, 100);
  s.energy = clamp(s.energy + clampDelta(d.energy), 0, 100);
  // wellbeing 也給極弱回歸(1%/h 朝 65),避免黏死 100;事件/高壓的推力仍遠大於它
  s.wellbeing = clamp(s.wellbeing + (65 - s.wellbeing) * 0.01 + clampDelta(d.wellbeing), 0, 100);
  rt.cleanliness = clamp(rt.cleanliness + clampDelta(d.cleanliness), 0, 100);
  // 後果迴路:長期高壓/精力透支會慢慢蛀掉身心健康(每小時小量,累積才會生病)
  if (s.stress >= 80) s.wellbeing = clamp(s.wellbeing - 0.4, 0, 100);
  if (s.energy < 20) s.wellbeing = clamp(s.wellbeing - 0.3, 0, 100);
}

/** 記憶標籤造成的每小時微幅數值漂移(已在 memoryEffects 夾上限) */
function applyMemoryDrift(rt: TenantRuntime) {
  const d = memoryDrift(rt.tenant);
  const s = rt.tenant.stats;
  if (d.mood) s.mood = clamp(s.mood + d.mood, 0, 100);
  if (d.stress) s.stress = clamp(s.stress + d.stress, 0, 100);
  if (d.wellbeing) s.wellbeing = clamp(s.wellbeing + d.wellbeing, 0, 100);
  if (d.energy) s.energy = clamp(s.energy + d.energy, 0, 100);
  if (d.affinity) s.affinity = clamp(s.affinity + d.affinity, 0, 100);
}

/** 房間滿足租客需求的比例(作息要用的家具角色有幾成能在自房/共用區找到)*/
function needsMet(tenantId: string, roomId: string | null): number {
  const roles = routineRoles(tenantId);
  if (roles.length === 0) return 1;
  let served = 0;
  for (const role of roles) if (resolveTarget(role, roomId)) served++;
  return served / roles.length;
}

/** 更新滿意度:由心情/好感/壓力/身心健康/精力 + 房間是否滿足需求,緩慢趨近目標 */
function updateSatisfaction(rt: TenantRuntime, roomId: string | null) {
  const s = rt.tenant.stats;
  const nm = needsMet(rt.tenant.id, roomId);
  const base = clamp(
    0.25 * s.mood + 0.3 * s.affinity + 0.25 * (100 - s.stress) + 0.1 * s.wellbeing + 0.1 * s.energy,
    0,
    100,
  );
  const target = base * (0.55 + 0.45 * nm);
  rt.satisfaction = clamp(rt.satisfaction + (target - rt.satisfaction) * 0.2, 0, 100);
}

const SEATED_STATES = new Set<TenantVisualState>(["idle", "reading", "watching_tv", "gaming", "streaming", "working_at_desk", "playing_with_cat"]);

/** 將日常活動轉成可見家具姿勢；床/沙發會跨上家具，桌前則補畫一張工作椅。 */
function setFurniturePose(rt: TenantRuntime, st: TenantVisualState, p: Placement, fallbackTile: Tile) {
  const def = getDef(p.defId);
  if (!("kind" in def.sprite)) return;
  const kind = def.sprite.kind;
  let pose: "sit" | "lie" | null = null;
  let surface: "furniture" | "chair" | null = null;
  if (st === "sleeping_on_bed" && kind === "bed") {
    pose = "lie";
    surface = "furniture";
  } else if (st === "sleeping_on_couch" && ["sofa", "beanbag", "chair"].includes(kind)) {
    pose = "lie";
    surface = "furniture";
  } else if (st === "taking_bath" && kind === "bathtub") {
    pose = "lie";
    surface = "furniture";
  } else if (st === "using_toilet" && kind === "toilet") {
    pose = "sit";
    surface = "furniture";
  } else if (SEATED_STATES.has(st)) {
    if (["sofa", "beanbag", "chair"].includes(kind)) {
      pose = "sit";
      surface = "furniture";
    } else if (["desk", "mic_desk", "tv"].includes(kind)) {
      pose = "sit";
      surface = "chair";
    }
  }
  if (!pose || !surface) return;
  const fp = placementFootprint(p);
  rt.activityPose = pose;
  rt.activitySurface = surface;
  // 床的原始圖面是床頭朝上，但角色躺姿的原始圖面是頭朝左，
  // 因此睡床時要多轉 90° 才會與床頭方向一致。沙發原始方向則已一致。
  rt.activityRotation = pose === "lie" && kind === "bed"
    ? nextRotation(placementRotation(p))
    : placementRotation(p);
  if (surface === "furniture") {
    // 選最靠近原互動點的家具格，確保角色能先走到旁邊再跨上床／椅子。
    let best = { c: p.c, r: p.r };
    let bestDist = Infinity;
    for (let dr = 0; dr < fp.h; dr++) {
      for (let dc = 0; dc < fp.w; dc++) {
        const tile = { c: p.c + dc, r: p.r + dr };
        const dist = Math.abs(tile.c - fallbackTile.c) + Math.abs(tile.r - fallbackTile.r);
        if (dist < bestDist) {
          best = tile;
          bestDist = dist;
        }
      }
    }
    rt.activityTile = best;
  } else {
    rt.activityTile = { ...fallbackTile };
  }
}

/** 幫一位租客套用某小時的活動(addLog=false 用於初始定位,不寫日誌) */
export function applyHour(rt: TenantRuntime, hour: number, addLog: boolean) {
  const decided = decideState(rt, hour);
  let st = decided.state;
  let effectState = decided.effectState;
  const isDeviation = decided.isDeviation;
  rt.activityPose = null;
  rt.activityTile = null;
  rt.activityRotation = 0;
  rt.activitySurface = null;

  // 目標家具格(同居者用伴侶房)
  const roomId = roomOfTenant(rt.tenant.id);
  rt.inLounge = false;
  rt.visiting = null;
  rt.visitHostId = null;
  if (st === "away") {
    rt.targetTile = null;
  } else if (isDeviation) {
    rt.targetTile = homeTile(rt.tenant.id);
  } else {
    const dir = activeDirective(rt);
    let tgt = resolveTarget(decided.role, roomId, st);
    // 指令 social:傍晚主動泡交誼廳——把自房的休閒活動改成去交誼廳看電視
    if (dir === "social" && hour >= 19 && hour <= 21 && ["idle", "reading", "watching_tv", "gaming"].includes(st)) {
      const loungeTgt = resolveTarget("sofa", null) ?? resolveTarget("tv", null);
      if (loungeTgt && loungeTgt.placement.room === "lounge") {
        tgt = loungeTgt;
        st = "watching_tv";
      }
    }
    // 指令 hermit / 自發行為 sulk:迴避交誼廳——目標落在交誼廳就改回自己房間發呆
    // (sulk 與 hermit 的差別在下面的串門判定:sulk 只擋「主動」社交,被動接待照舊)
    if ((dir === "hermit" || dir === "sulk") && tgt && tgt.placement.room === "lounge") tgt = null;
    // 冷戰(§10-2):交誼廳裡有冷戰對象 → 迴避不去,「看得見的不和」
    if (tgt && tgt.placement.room === "lounge" && avoidLounge(rt.tenant.id)) tgt = null;
    if (tgt) {
      rt.targetTile = tgt.tile;
      rt.inLounge = tgt.placement.room === "lounge"; // 在共用交誼廳 → 可能與鄰居相遇
      // 不同浴室設備可同時使用；同一設備有人時，下一位會在對應門外排隊。
      if (ACTIVE_BATHROOM_STATES.has(st) && tgt.placement.room === "bathroom") {
        if (!claimBathroomFixture(bathroomFixtureId(tgt.placement), rt.tenant.id)) {
          st = "waiting_for_bathroom";
          effectState = "waiting_for_bathroom";
          const lowerRoom = ["toilet", "bath_sink"].includes(tgt.placement.defId);
          const lane = Math.abs(rt.tenant.id.split("").reduce((n, ch) => n + ch.charCodeAt(0), 0)) % 2;
          rt.targetTile = { c: 7 + lane, r: lowerRoom ? 29 : 25 };
          rt.inLounge = false;
        }
      }
      if (rt.targetTile?.c === tgt.tile.c && rt.targetTile?.r === tgt.tile.r) setFurniturePose(rt, st, tgt.placement, tgt.tile);
    } else {
      // 房裡缺對應家具、共用區也沒有(或 hermit 拒去)→ 在自己房間發呆(不闖別人房)
      st = "idle";
      rt.targetTile = homeTile(rt.tenant.id);
    }
  }
  rt.tenant.visualState = st;
  rt.roomProps = deriveProps(rt, st, hour);

  // 維持既有逐人亂數時序；是否真的拜訪要等所有人的本小時狀態確定後再配對。
  // comfort_seek:想找人談心 → 串門意願大增;sulk:不主動社交(擲骰照擲,保持 RNG 次序)。
  const visitDir = activeDirective(rt);
  if (
    LEISURE_STATES.has(st) && !isDeviation && !rt.inLounge &&
    Math.random() <= (visitDir === "comfort_seek" ? 0.6 : 0.15) && visitDir !== "sulk"
  ) {
    visitIntents.add(rt.tenant.id);
  }

  if (!addLog) return;
  const gen = generateHourly({
    tenantId: rt.tenant.id,
    tenantName: rt.tenant.name,
    hour,
    timeLabel: fmt(state.gameMs),
    state: st,
    effectState,
    isDeviation,
    recentSummary: rt.tenant.recentSummary,
  });
  applyStat(rt, gen.statDeltas);
  applyMemoryDrift(rt); // 記憶標籤造成的長期數值漂移
  updateSatisfaction(rt, roomId);
  rt.log.push({
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    text: gen.logText,
    visualState: st,
    importance: gen.importance,
  });
  if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
}

/** 推進一個遊戲小時(live=true 才在換日時打 AI;補進度/快轉用模板避免大量 API 呼叫) */
export function hourlyTick(live = false) {
  const prevDay = new Date(state.gameMs).getDate();
  state.gameMs += MS_PER_GAME_HOUR;
  const d = new Date(state.gameMs);
  const hour = d.getHours();
  const day = gameDayIndex();
  const moveOuts: string[] = [];
  visitIntents.clear();

  for (const rt of Object.values(state.runtimes)) {
    // 行為指令到期 → 恢復往常 + 留一筆日誌(在暫停檢查之前,免得掛著過期指令)
    if (rt.directive && day > rt.directive.untilDay) {
      const def = DIRECTIVES[rt.directive.id];
      rt.directive = null;
      pushSocialLog(rt, def.endText, "notable");
    }
    if (rt.pendingEvent) {
      rt.inLounge = false;
      rt.visiting = null;
      rt.visitHostId = null;
      continue; // 有待決事件則暫停該租客,等房東抉擇
    }
    applyHour(rt, hour, true);

    // 張力:不滿累積(滿意度過低會逐時累加,回升則消退)
    if (rt.satisfaction < 25) rt.unhappyHours += 1;
    else rt.unhappyHours = Math.max(0, rt.unhappyHours - 2);

    // 觸發突發事件(每位租客冷卻 2 遊戲日,避免連發)
    if (day - rt.lastEventDay >= 2) {
      const ev = rollEvent({
        name: rt.tenant.name,
        stress: rt.tenant.stats.stress,
        satisfaction: rt.satisfaction,
        affinity: rt.tenant.stats.affinity,
        wellbeing: rt.tenant.stats.wellbeing,
        flags: rt.flags,
      });
      if (ev) {
        rt.pendingEvent = ev;
        rt.lastEventDay = day;
        if (ev.consumeFlag) {
          // 事件連鎖:旗標觸發即消耗,不重複觸發
          const i = rt.flags.indexOf(ev.consumeFlag);
          if (i >= 0) rt.flags.splice(i, 1);
        }
      }
    }

    // 長期不滿(約 2.5 遊戲日)→ 退租
    if (rt.unhappyHours >= 60 && !rt.pendingEvent) moveOuts.push(rt.tenant.id);
  }

  for (const id of moveOuts) moveOut(id, "對居住品質長期不滿");

  roomVisitPass(hour); // 作息都確定後再配對；拜訪成立就由 interactionsPass 保證共同活動
  pruneFxByGame(state.gameMs); // 依遊戲時間清掉長效演出(快轉時不殘留)
  const interacted = interactionsPass(); // 同房/交誼廳的目錄式互動(§10-1/10-2,canInteract 把關)
  socialPass(interacted); // 交誼廳相遇 → 聊天/衝突/戀愛(這小時已互動過的配對跳過,避免雙重)
  dramaPass(); // 戲劇事件:劈腿抓包/偷吃冰箱(§10-2 戲劇批)
  petsPass(); // 寵物貓:換去處 + 闖房/搗蛋/大小便事件
  diaryPass(hour, live); // 輪到日記時段的租客生成日記(每人錯開在一天不同時間,分散 AI 額度)
  if (d.getDate() !== prevDay) {
    pruneStaleMemories(); // 記憶與現況矛盾 → 淡出(例:心情很好卻掛著[情緒低落])
    maintenancePass(); // 設備故障擲骰 + 未修的拖延懲罰(§7-1)
    feudPass(); // 冷戰:關係每日小扣、期滿氣消(§10-2)
    collectRent();
    resetDiaryQuota(); // AI 額度每日重置 → 新的一天重新嘗試
    legacyPass(); // 累積型成就輪詢:客滿/滿 30 天/資產破 15 萬/初戀(§G-7)
    communityPass(); // 群體事件:洗衣房口角/揪團/噪音公審/頂樓乘涼(牽動 3+ 人,§C-7)
    catJournalPass(); // 貓咪觀察筆記:每 7 遊戲日一篇,以貓口吻進 Feed(彩蛋)
    weeklyReportPass(); // 每 7 遊戲日彙整收支、大事與關係變化,進動態頁週報卡
  }
}

/** 每日:記憶生命週期(衰減淡忘)+ 移除與現況矛盾的記憶標籤,各留一筆日誌 */
function pruneStaleMemories() {
  for (const rt of Object.values(state.runtimes)) {
    // 1) 自然衰減:情緒記憶隨時間變淡,歸零淡忘(失戀會慢慢好起來)
    for (const label of decayMemories(rt.tenant)) {
      pushSocialLog(rt, `🍂 「${label.replace(/[[\]]/g, "")}」的記憶漸漸淡了,不再影響心情。`, "notable");
    }
    // 2) 矛盾淡出:數值已明顯走出該記憶的方向 → 直接移除
    const removed = pruneContradictedMemories(rt.tenant);
    for (const label of removed) {
      pushSocialLog(rt, `🕊️ 看起來已經走出「${label.replace(/[[\]]/g, "")}」了。`, "notable");
    }
  }
}

/** 鄰居社交:找出同在交誼廳的租客,兩兩相遇互動(skip = 這小時已由互動目錄處理過的配對) */
function socialPass(skip: Set<string> = new Set()) {
  const inLounge = Object.values(state.runtimes).filter((rt) => rt.inLounge && !rt.pendingEvent);
  for (let i = 0; i < inLounge.length; i++) {
    for (let j = i + 1; j < inLounge.length; j++) {
      if (Math.random() > 0.55) continue; // 不是每小時都會互動
      const A = inLounge[i];
      const B = inLounge[j];
      if (skip.has(pairKey(A.tenant.id, B.tenant.id))) continue;
      // 冷戰中 → 互相當作看不見,不相遇(§10-2)
      if (feudActive(A.tenant.id, B.tenant.id)) continue;
      // 積怨已深 + 雙方都緊繃 → 可能直接打起來(打鬥雲 + 家具損壞 + 房東抉擇)
      if (tryFight(A, B)) continue;
      const res = encounter(A.tenant, B.tenant);
      pushSocialLog(A, res.textA, res.importance);
      pushSocialLog(B, res.textB, res.importance);
      applySocialEffect(A, res.effectA);
      applySocialEffect(B, res.effectB);
      // 演出層:在兩人所在的交誼廳位置掛特效(里程碑優先,其次依互動基調),並讓兩人走到一起演(§10-6)
      const at = A.targetTile ?? B.targetTile;
      if (at) {
        // 里程碑/衝突是「一瞬間」的演出 → 短;聊天泡泡是「進行中」→ 持續到下一個動作
        if (res.milestone === "became_couple") spawnFx("hearts", at.c, at.r, 15000);
        else if (res.milestone === "broke_up") spawnFx("heartbreak", at.c, at.r, 15000);
        else if (res.tone === "conflict") spawnFx("anger", at.c, at.r, 10000);
        else if (res.tone === "romantic") spawnFx("hearts", at.c, at.r, 10000);
        else spawnFx("chat", at.c, at.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
        // 姿勢(兩人在一起)預設持續到下一個動作(1 遊戲小時);快轉時 gameUntil 會收掉
        startPairSession(A.tenant.id, B.tenant.id, at, "stand_face", state.gameMs);
      }
      if (res.tone === "conflict") maybeFeudAfterConflict(A, B); // 大吵可能升級成冷戰
      if (res.milestone === "became_couple") {
        notify(`${A.tenant.name} 和 ${B.tenant.name} 在一起了 ❤️`);
        unlock("first_love");
      }
      if (res.milestone === "became_best_friends") {
        const label = listRelationships((id) => state.runtimes[id]?.tenant)
          .find((r) => pairKey(r.aId, r.bId) === pairKey(A.tenant.id, B.tenant.id))?.label ?? "摯友";
        notify(`${A.tenant.name} 和 ${B.tenant.name} 成為${label}了 🌟`);
      }
      if (res.milestone === "broke_up") {
        notify(`${A.tenant.name} 和 ${B.tenant.name} 分手了 💔`);
        unlock("heartbreak");
        endCohabitOnBreakup(A.tenant.id, B.tenant.id);
      }
      if (res.cohabit) {
        if (!state.pendingCohabit && canStartCohabit(A.tenant.id, B.tenant.id)) {
          state.pendingCohabit = { aId: A.tenant.id, bId: B.tenant.id, aName: A.tenant.name, bName: B.tenant.name };
        } else {
          // 申請被既有同居或另一個待決申請擋住時，保留未來狀態改變後再次提出的機會。
          const rel = getRel(A.tenant.id, B.tenant.id);
          if (rel) rel.cohabitOffered = false;
        }
      }
    }
  }
}

/** 對齊到現在(補進度)。回傳實際補了幾小時 */
export function syncToNow(): number {
  const target = currentGameMs(state.realAnchorMs, state.gameAnchorMs);
  let need = Math.floor((target - state.gameMs) / MS_PER_GAME_HOUR);
  if (need <= 0) return 0;
  const capped = need > MAX_CATCHUP_HOURS;
  need = Math.min(need, MAX_CATCHUP_HOURS);
  // 前景即時只推進 1~2 小時 → live(換日打 AI);大量補進度用模板,避免 API 轟炸
  const live = need <= 2;
  for (let i = 0; i < need; i++) hourlyTick(live);
  if (capped) {
    // 離開太久,跳過的時間直接重錨,避免無限追趕
    state.realAnchorMs = Date.now();
    state.gameAnchorMs = state.gameMs;
  }
  save();
  return need;
}

/** 除錯:一鍵快轉 N 遊戲小時(手動快轉視為 live,跨過午夜會觸發 AI 日記)。
 *  同步版,無頭測試腳本用;UI 請走 startFastForward(分批不卡畫面)。 */
export function fastForward(hours = 6) {
  for (let i = 0; i < hours; i++) hourlyTick(true);
  // 重錨,讓掛機時鐘從現在繼續
  state.realAnchorMs = Date.now();
  state.gameAnchorMs = state.gameMs;
  save();
}

/** UI 快轉:分批跑 tick(每批 5 小時、批間讓出主執行緒),期間 state.ffRemaining > 0 */
export function startFastForward(hours: number) {
  if (state.ffRemaining > 0) return; // 已在快轉中
  state.ffRemaining = hours;
  ffBatch();
}

function ffBatch() {
  const n = Math.min(5, state.ffRemaining);
  for (let i = 0; i < n; i++) hourlyTick(true);
  state.ffRemaining -= n;
  if (state.ffRemaining > 0) {
    setTimeout(ffBatch, 16); // 讓瀏覽器喘口氣重繪,UI 不凍結
  } else {
    state.realAnchorMs = Date.now();
    state.gameAnchorMs = state.gameMs;
    save();
  }
}
