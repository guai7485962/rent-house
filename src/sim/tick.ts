/**
 * 每小時模擬(store 拆分:tick 模組)。
 * 作息+偏離 → 定位/日誌/數值、張力事件、交誼廳社交、換日(收租+AI 日記),
 * 以及補進度(syncToNow)與快轉(同步版給測試、分批版給 UI)。
 */
import type { CafeGuest, CafeGuestOrder, CafeSalesDay, StatDeltas, TenantVisualState, RoomPropState } from "../types";
import { MAX_CATCHUP_HOURS, MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR, currentGameMs } from "./clock";
import { bathroomActivityForDay, laundryHourForDay, routineNeedsMet, routineSlot, resolveTarget, type Role } from "./routine";
import { rollEvent } from "./events";
import { encounter, listRelationships, pairKey, getRel, relationshipDailyPass } from "./social";
import { memoryDrift, pruneContradictedMemories, decayMemories } from "./memoryEffects";
import { directiveDef } from "./directives";
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
  pushMemory,
  applySocialEffect,
  roomOfTenant,
  canStartCohabit,
  sanitizeCafeRegularName,
  LOG_CAP,
  CAFE_HISTORY_CAP,
  CAFE_SALES_CAP,
  type TenantRuntime,
} from "./gameState";
import { addMoney, collectRent } from "./economy";
import { weatherForDay } from "./weather";
import { weekdayOf } from "./week";
import {
  advanceCafeResearch,
  applySpoilage,
  cafeCapability,
  cafeCrowd,
  cafeDailyLine,
  cafeHourlyGuestCount,
  cafeAbandonCount,
  cafeIntentWeights,
  cafeOrderLine,
  cafePetComfort,
  cafeRegularBringsFriend,
  cafeRegularForHour,
  cafeRegularFriendLine,
  cafeRegularLine,
  cafeRegularUsualItem,
  cafeServicePopularity,
  cafeStaffWage,
  cafeStorageCapacity,
  checkoutCafeOrder,
  chooseCafeMenuItem,
  clampCafePopularity,
  decayCafeRegularCandidates,
  decayCafeRegulars,
  refuseCafeRegular,
  touchCafeRegular,
  CAFE_BUSINESS_HOURS,
  CAFE_FIXED_COST,
  CAFE_POPULARITY_SOFT_LOSS,
  CAFE_REGULAR_CANDIDATE_DECAY_DAYS,
  CAFE_REGULAR_TIP,
  CAFE_REGULAR_TIP_AFFECTION,
  getCafeIngredient,
  menuItems,
  restockPlan,
} from "./cafe";
import { maintenancePass, neglectPoints } from "./maintenance";
import { tryFight, feudActive, feudPass, maybeFeudAfterConflict, avoidLounge } from "./conflicts";
import { dramaPass } from "./drama";
import { moveOut, graduateFarewell, endCohabitOnBreakup } from "./tenancy";
import { diaryPass, resetDiaryQuota } from "./narration";
import { petsPass, catJournalPass } from "./pets";
import { legacyPass, unlock } from "./legacy";
import { ensureWishes, settleDeparturesDue, wishPass } from "./wishes";
import { communityPass, scheduledCommunityPass } from "./community";
import { floorChainPass } from "./floorChain";
import { localArcPass } from "./localArc";
import { dreamPass } from "./dreams";
import { outingEncounterPass, outingSpot } from "./outing";
import {
  CAFE_DINE_IN_CAP, CAFE_GUEST_CAP, generateCafeGuest, removeDepartedCafeGuests,
  type CafeIntentWeights,
} from "./cafeGuests";
import { weeklyReportPass } from "./weeklyReport";
import { growthBaselineDelta } from "./growth";
import { spawnFx, pruneFxByGame } from "../floor/fx";
import { startPairSession, type PairPose } from "../floor/pairSession";
import { canStartRoomVisit, interactionsPass } from "./interactions";
import { save } from "./persistence";
import { getDef } from "../furniture/catalog";
import {
  cafeAmbiancePoints,
  cafeBackStoragePoints,
  cafePetComfortPoints,
  cafeSeatSpots,
  cafeServiceStations,
  placementFootprint,
  placementRotation,
} from "./placements";
import { roomComfort, comfortBaselineDelta, cleanlinessBaseline, communalQuality, communalBaselineDelta } from "./comfort";
import { satisfactionTarget } from "./satisfaction";
import type { Placement } from "../floor/map";
import { nextRotation } from "../furniture/rotation";
import { noiseConflictMitigation } from "./acoustics";

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
  // 🔴 `at_cafe`:人在**一樓**,不在自己房裡,不能被選成串門子的主人。
  //    少了這條,`roomVisitPass()` 下面會把他的 `visualState` 改回 idle、`targetTile`
  //    設回房間 ⇒ sprite 從咖啡廳**憑空瞬移到樓上**,而那一小時的日誌還寫著「在一樓咖啡廳」。
  //    這是同一個傳送 bug 的三條路徑之一,另外兩條在 `interactions.ts`
  //    (`interactionsPass()` 的分組、`forceInteraction()` 的 thirdPresent)——只補一條仍會傳送。
  "at_cafe",
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

/** 整潔朝自然水位回歸的比例(1.5%/h:非常慢,約一週才收斂;體現「慢變環境品質」) */
const CLEANLINESS_K = 0.015;

// ---------------------------------------------------------------------------
// 虧待度(neglect)的三個槓桿倍率
//
// 🔴 **三條數值的槓桿倍率完全不同,絕不可用同一組常數。** 每條數值的回歸速度決定了
//    「同樣一點虧待度」最後能造成多少位移:
//      stress        回歸 6%/h   掛 `baselines()` ⇒ ×1
//      wellbeing     回歸 1%/h   掛每小時增量     ⇒ ×100(掛 wbAnchor 只有 ×1,幅度不夠)
//      satisfaction  回歸 20%/h  掛 `target`      ⇒ ×1(掛脈衝只有 ×0.21)
//      affinity      **無回歸**   掛每日一次       ⇒ 永久累積(見 maintenance.ts)
//    數值全部由 `scripts/event-freq-sim.ts` 的實測分布回填,不是設計文件裡的估算值。
// ---------------------------------------------------------------------------

/** 虧待度每一點推高多少壓力**基準**(n=6 ⇒ +12,把 normal 的 38 推到 50、stressed 的 58 推到 70) */
const NEGLECT_STRESS_PER_POINT = 2;

/** 虧待度每一點每小時侵蝕多少身心健康(回歸 1%/h ⇒ n=6 的均衡值位移約 −18) */
const NEGLECT_WELLBEING_PER_POINT = 0.03;

/**
 * 長期高壓每小時蛀掉多少身心健康。
 *
 * 舊碼是 `stress >= 80 → −0.4` 的**階梯**。但實測壓力平衡點落在 `baselines()` 基準
 * **下方約 20 點**(四人滿房 60 日 × 5 種子的 stress max 只有 79),這道階梯幾乎踩不到
 * ⇒ `sick` 的 `wellbeing <= 28` 永遠走不到。改成從 60 起的線性斜坡:
 *
 *   - `stress = 80` 恰好仍是 **−0.4** ⇒ **向後相容錨點**(舊行為在那一點逐位元相同)
 *   - `stress = 96` 是 −0.72(比舊的 −0.4 更兇,高壓真的會蛀出病來)
 *   - `stress <= 60` 是 0(一般作息不受影響)
 *
 * 抽成具名純函式是為了讓 `stats-model-test.ts` 能直接把上面三個錨點釘死;
 * 藏在 `applyStat` 裡的話,任何人改了斜率都不會有測試紅燈。
 */
export const stressWellbeingDrain = (stress: number): number => (stress > 60 ? 0.02 * (stress - 60) : 0);

/**
 * 性格決定的心情/壓力基準值(homeostasis 的「回到哪」),再疊三個回饋:
 * - 社交(socialFulfillment 簡版):有戀人/朋友 → 心情基準↑;完全孤立 → ↓
 * - 身心健康後果:wellbeing 低 → 心情基準大幅下修(病懨懨開心不起來)
 * - 精力後果:energy 低 → 壓力基準上修(累到什麼都煩)
 *
 * `comfort` / `communalQ` 都是**可選的預算快取**:未帶入時就地計算(外部呼叫如 arc-test、
 * stats-model-test 用),`applyStat` 會兩個都傳進來避免重算。`communalQ` 對同一小時的
 * **所有租客是同一個值**(它描述整棟樓的公共空間),但 `communalBreakdown()` 一次要掃
 * 3 區 × 5 趟 placements 全表;不快取的話 4 租客 × 2 個呼叫點 = 每小時 120 趟全表掃描。
 */
export function baselines(
  rt: TenantRuntime,
  comfort?: number,
  communalQ?: number,
): { mood: number; stress: number } {
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
  const growth = growthBaselineDelta(rt.tenant.growthTags);
  mood += growth.mood;
  stress += growth.stress;
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
  // 房間舒適度慢變環境品質:溫和改心情/壓力基準(舒適房加成、簡陋/髒房懲罰)。
  // comfort 未帶入時就地計算(外部呼叫如 arc-test 用);applyStat 會傳入避免重算。
  const cft = comfort ?? roomComfort(roomOfTenant(rt.tenant.id), rt.cleanliness);
  const cdelta = comfortBaselineDelta(cft);
  mood += cdelta.mood;
  stress += cdelta.stress;
  // 公共空間(交誼廳/浴室/洗衣間)品質:走 comfort.ts 的**獨立管道**再疊一層,
  // 刻意不混進上面的 roomComfort——那個值同時是 cozyHomePass 的門檻,動它會位移慶祝日誌。
  // 種子樓層 q 恰好等於 COMMUNAL_NEUTRAL → 三個 delta 皆 0,舊局/舊存檔數值完全不變。
  const gdelta = communalBaselineDelta(communalQ ?? communalQuality());
  mood += gdelta.mood;
  stress += gdelta.stress;
  // 虧待度(壞著沒修 / 空頭支票)推高**壓力基準**。
  // 🔴 一定要掛基準,不能掛每小時增量:homeostasis 是 6%/h,掛增量等於位移 ×16.7 直接爆表;
  //    而 `applyStat` 的不動點是 `base + d̄/K` ⇒ 唯一能把 stress 真正推上去的就是 `base` 本身。
  //    無虧待時 `neglectPoints` 恆為 0 ⇒ 舊局/舊存檔的基準逐位元不變。
  stress += NEGLECT_STRESS_PER_POINT * neglectPoints(rt);
  return { mood: clamp(mood, 10, 90), stress: clamp(stress, 10, 90) };
}

function applyStat(rt: TenantRuntime, d: StatDeltas) {
  const s = rt.tenant.stats;
  const roomId = roomOfTenant(rt.tenant.id);
  const comfort = roomComfort(roomId, rt.cleanliness);
  // 公共空間分數對整棟樓是同一個值,但一次要掃 3 區 × 5 趟 placements。
  // 這裡算一次,同時餵給 baselines() 與下面的 wbAnchor(原本同一個 applyStat 內算兩遍)。
  const communalQ = communalQuality();
  const base = baselines(rt, comfort, communalQ);
  // homeostasis:mood/stress 先朝性格基準回歸,再吃這小時的活動增量 → 不再黏死 0/100
  s.mood = clamp(s.mood + (base.mood - s.mood) * HOMEOSTASIS_K + clampDelta(d.mood), 0, 100);
  s.stress = clamp(s.stress + (base.stress - s.stress) * HOMEOSTASIS_K + clampDelta(d.stress), 0, 100);
  // affinity 是「關係的累積」不是情緒,不回歸;energy 是資源(睡覺充、活動耗);wellbeing 慢變
  s.affinity = clamp(s.affinity + clampDelta(d.affinity), 0, 100);
  s.energy = clamp(s.energy + clampDelta(d.energy), 0, 100);
  // wellbeing 也給極弱回歸(1%/h),避免黏死 100;舒適房把回歸錨點微微墊高、髒/簡陋房下修
  const wbAnchor = 65 + comfortBaselineDelta(comfort).wellbeing + communalBaselineDelta(communalQ).wellbeing;
  // 虧待度掛在**每小時增量**而不是 wbAnchor:anchor 的既有幅度只有 ±4,而回歸只有 1%/h ⇒
  // 掛增量的位移是 ×100,掛 anchor 只有 ×1。無虧待時 neglect=0 ⇒ 這一項恆為 0。
  const neglect = neglectPoints(rt);
  s.wellbeing = clamp(
    s.wellbeing + (wbAnchor - s.wellbeing) * 0.01 + clampDelta(d.wellbeing) - NEGLECT_WELLBEING_PER_POINT * neglect,
    0,
    100,
  );
  // 整潔慢變環境品質:朝「收納決定的自然水位」極慢回歸(生活會變髒/收納常保整潔),
  // 再吃本小時活動增量(煮飯/洗澡等)。收納家具墊高基準 = 減緩衰減,不逼玩家一直打掃。
  const cleanBase = cleanlinessBaseline(roomId);
  rt.cleanliness = clamp(rt.cleanliness + (cleanBase - rt.cleanliness) * CLEANLINESS_K + clampDelta(d.cleanliness), 0, 100);
  // 後果迴路:長期高壓/精力透支會慢慢蛀掉身心健康(每小時小量,累積才會生病)
  const drain = stressWellbeingDrain(s.stress);
  if (drain > 0) s.wellbeing = clamp(s.wellbeing - drain, 0, 100);
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

/** 更新滿意度:由心情/好感/壓力/身心健康/精力 + 房間是否滿足需求,緩慢趨近目標 */
function updateSatisfaction(rt: TenantRuntime, roomId: string | null) {
  const s = rt.tenant.stats;
  const nm = routineNeedsMet(rt.tenant.id, roomId);
  const target = satisfactionTarget(s, nm, neglectPoints(rt));
  rt.satisfaction = clamp(rt.satisfaction + (target - rt.satisfaction) * 0.2, 0, 100);
}

const SEATED_STATES = new Set<TenantVisualState>(["idle", "reading", "watching_tv", "gaming", "streaming", "working_at_desk", "playing_with_cat", "at_cafe"]);

/**
 * 將日常活動轉成可見家具姿勢；床/沙發會跨上家具，桌前則補畫一張工作椅。
 *
 * 座位的判定有**兩條來源**,順序不可對調:
 * 1. `sprite: { kind }` 的家具照原本的 kind 白名單走(sofa/beanbag/chair 跨上去、
 *    desk/mic_desk/tv 補椅子)——既有行為一位元不變。
 * 2. `sprite: { recipe }` 的家具沒有 kind,改看目錄的 `def.seat`(`"on"` / `"at"`)。
 *    CAFE-06 的咖啡廳桌椅就是靠這條才坐得下去;沒標 `seat` 的 recipe 家具仍在
 *    第一行直接 return,和改動前完全一樣。
 *
 * 🔴 這是所有家具姿勢的共用路徑,`scripts/cafe-seat-pose-test.ts` 用
 * 「全目錄 × 全 visualState」的矩陣比對舊邏輯,任何波及既有姿勢的改動都會被抓到。
 */
export function setFurniturePose(rt: TenantRuntime, st: TenantVisualState, p: Placement, fallbackTile: Tile) {
  const def = getDef(p.defId);
  // recipe 家具沒有 kind,只有目錄明講可坐的才繼續(未標 seat ⇒ 維持原本的 early return)
  const kind = "kind" in def.sprite ? def.sprite.kind : null;
  if (kind === null && !def.seat) return;
  let pose: "sit" | "lie" | null = null;
  let surface: "furniture" | "chair" | null = null;
  if (st === "sleeping_on_bed" && kind === "bed") {
    pose = "lie";
    surface = "furniture";
  } else if (st === "sleeping_on_couch" && kind !== null && ["sofa", "beanbag", "chair"].includes(kind)) {
    pose = "lie";
    surface = "furniture";
  } else if (st === "taking_bath" && kind === "bathtub") {
    pose = "lie";
    surface = "furniture";
  } else if (st === "using_toilet" && kind === "toilet") {
    pose = "sit";
    surface = "furniture";
  } else if (SEATED_STATES.has(st)) {
    if (kind !== null && ["sofa", "beanbag", "chair"].includes(kind)) {
      pose = "sit";
      surface = "furniture";
    } else if (kind !== null && ["desk", "mic_desk", "tv"].includes(kind)) {
      pose = "sit";
      surface = "chair";
    } else if (def.seat) {
      // 資料驅動的座位(咖啡廳桌椅):on = 跨上家具、at = 坐在家具前補畫椅子
      pose = "sit";
      surface = def.seat === "on" ? "furniture" : "chair";
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
  // 這一小時實際用到的家具(睡眠靠它拿床的 tier 乘數);`tgt` 宣告在下面的 else 區塊內,
  // 所以在這裡 hoist 一個變數,而不是把 placement 一路穿透傳進 generateHourly。
  let usedDefId: string | undefined;
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
      // ⚠️ 這個賦值必須留在「目標格 = 家具互動格」的判斷**內**:被上面的浴室排隊分支
      // 擠成 `waiting_for_bathroom` 的人並沒有真的用到那件設備,若在分支外賦值,
      // 第三階段接浴缸時**排隊中的人會吃到 premium 浴缸的乘數**。
      // 睡眠不排隊(床的 slot 從不進 ACTIVE_BATHROOM_STATES),故本批行為零變更。
      if (rt.targetTile?.c === tgt.tile.c && rt.targetTile?.r === tgt.tile.r) {
        usedDefId = tgt.placement.defId;
        setFurniturePose(rt, st, tgt.placement, tgt.tile);
      }
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
    // 外出 → 帶上決定性算出的目的地,讓觀察句從「空房間」變成「他大概在哪」(零 RNG)
    outingSpot: st === "away" ? outingSpot(rt, gameDayIndex(), hour) : undefined,
    // 這一小時用到的家具 → 睡眠吃床的 tier 乘數(純查表,零 RNG)
    furnitureDefId: usedDefId,
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

/** 咖啡廳營業時段(含頭含尾);非營業時段只做離場,不生客。 */
export const CAFE_OPEN_HOUR = 10;
export const CAFE_CLOSE_HOUR = 20;
/**
 * 現在是不是營業中(設計文件 §4.4)。
 *
 * 畫面的明暗、招牌、店門與資料層的清場全部讀同一個判斷 ⇒ 不可能出現
 * 「店是暗的但還有人在點餐」。未開張(`open === false`)永遠是打烊。
 */
export function cafeBusinessOpen(open: boolean, hour: number): boolean {
  return open === true && hour >= CAFE_OPEN_HOUR && hour <= CAFE_CLOSE_HOUR;
}
/**
 * 到點顧客的「走出去」寬限:過了 leavesMs 之後,資料層再留這麼久才強制清掉。
 *
 * 設計文件 §6.2 要求顧客走回 cafe_entrance 才消失(不原地消失)。那段演出由
 * FloorMap 的 departedGuestIds() 負責,但玩家可能整場都沒打開 1F 頁面,
 * 演出永遠不會發生 → 過期顧客會塞滿 cap。所以資料層留一個保險絲:
 * 寬限期內交給畫面演,超過寬限期(或離線補進度一次跑掉很多小時)才自己收乾淨。
 */
export const CAFE_GUEST_LINGER_MS = 2 * MS_PER_GAME_HOUR;

/**
 * 咖啡廳顧客的**離場與清場**(CAFE-11 建立,重設計 P2 縮編職責)。
 *
 * 🔴 **P2 起這個 pass 不再生客**。以前它用 `cafeGuestHash % 100 < 55` 另外生一批
 * 「畫面上的顧客」,和 `cafeHourlyPass()` 裡結帳的那批虛擬顧客毫無關係——那正是
 * 設計文件 §3 要修掉的分裂。現在**顧客只從結帳那條路生出來**(見 `cafeHourlyPass`),
 * 這裡只負責兩件掃地的事:
 *
 * 1. **打烊清場**(§4.4):非營業時段一樓是空的,玩家一眼分得出營業中與打烊。
 * 2. **寬限期保險絲**:過了 `leavesMs + CAFE_GUEST_LINGER_MS` 還在的顧客直接收掉。
 *    寬限期內的離場交給 FloorMap 走回門口的演出;沒開 1F 頁面/離線補進度時
 *    才由這裡收乾淨,不會殘留。
 *
 * 零漂移仍然靠第一行的 `if (!cafe.open) return;`,且全程零 `Math.random()`。
 */
export function cafeGuestPass(hour: number) {
  const cafe = state.cafe;
  if (!cafe.open) return; // 天然閘門:未開張 = 完全沒有這個子系統
  if (!cafeBusinessOpen(cafe.open, hour)) {
    // 打烊:顧客清場。門關、燈暗、店裡沒有人——三件事在同一個判斷上。
    if (cafe.guests.length > 0) cafe.guests.splice(0, cafe.guests.length);
    return;
  }
  const stayed = removeDepartedCafeGuests(cafe.guests, state.gameMs - CAFE_GUEST_LINGER_MS);
  if (stayed.length !== cafe.guests.length) cafe.guests.splice(0, cafe.guests.length, ...stayed);
}

/**
 * 咖啡廳日結日誌的落點。
 *
 * 日結沒有「當事租客」,但這則日誌**必須進得了 `rt.log`**——`narration.buildNarrateCtx()`
 * 只讀 `rt.log`,只有進得去才有機會成為 AI 素材(這正是選一個不在
 * `/^[🔮🌀🌱💤]/u` 裡的前綴的用意)。作法直接抄 `pets.catJournalPass()` 的樓貓筆記:
 * 掛在任一位在住租客身上,Feed 會彙整全樓日誌,玩家照樣看得到。
 *
 * **依 id 排序取第一位**(而不是 `Object.values()[0]`):鍵的插入序會被搬入/搬出改變,
 * 那會讓同一存檔在不同 session 把日誌掛到不同人身上(同 `outing.ts` 的固定迭代次序規則)。
 * 全樓沒人時退回 `notify()`,兩條路都到得了動態頁。
 */
function pushCafeLog(text: string) {
  const host = Object.values(state.runtimes).sort((a, b) => a.tenant.id.localeCompare(b.tenant.id))[0];
  if (host) pushSocialLog(host, text, "notable");
  else notify(text);
}

/** 咖啡廳營收的帳本標籤;`addCafeRevenue()` 用它辨識可合併的同日紀錄。 */
const CAFE_REVENUE_LABEL = "咖啡廳營收";

/**
 * 咖啡廳營收進帳(重設計 P1)。
 *
 * 逐位結帳讓同一個遊戲日最多有 11 次進帳,而 `LEDGER_CAP` 只有 60 筆——
 * 照實逐筆記帳,收支頁會只剩下兩三天的歷史,等於用一個看不見的實作細節
 * 砸掉一個玩家天天在看的畫面。
 *
 * 所以錢**照樣每個營業小時真的入帳**(`state.money` 每小時會跳,P2 的浮字才有東西可演),
 * 但帳本上把同一個遊戲日的咖啡廳營收**合併成一筆**。合併只動「就是上一筆、
 * 同標籤、同分類、同一個日曆日」的紀錄,金額總和與 `state.money` 的變動完全一致
 * (`cafe-per-guest-test.ts` 有對帳斷言)。
 */
function addCafeRevenue(amount: number) {
  if (!(amount > 0)) return;
  const previous = state.ledger[state.ledger.length - 1];
  const mergeable = previous
    && previous.label === CAFE_REVENUE_LABEL
    && previous.category === "cafe"
    && new Date(previous.gameMs).toDateString() === new Date(state.gameMs).toDateString();
  addMoney(amount, CAFE_REVENUE_LABEL, "cafe");
  if (!mergeable) return;
  const added = state.ledger[state.ledger.length - 1];
  if (!added || added === previous) return; // addMoney 沒有真的記帳(理論上不會發生)
  previous.amount += added.amount;
  previous.gameMs = added.gameMs;
  state.ledger.pop();
}

/** 取得(必要時建立)今天的銷售紀錄。最新在後,cap `CAFE_SALES_CAP`。 */
function todaysCafeSales(day: number): CafeSalesDay {
  const cafe = state.cafe;
  if (!Array.isArray(cafe.sales)) cafe.sales = [];
  const last = cafe.sales[cafe.sales.length - 1];
  if (last && last.day === day) return last;
  cafe.sales.push({
    // `missedBy` 一律寫齊(而不是靠 undefined):消毒後是 `{}`,
    // 少寫這一欄會讓「銷售紀錄通過存檔往返後逐欄相同」的斷言破功。
    day, sold: {}, missed: {}, missedBy: {}, revenue: 0, ingredientCost: 0, served: 0, refused: 0,
    settled: false, restocked: false, restockCost: 0,
  });
  if (cafe.sales.length > CAFE_SALES_CAP) cafe.sales.splice(0, cafe.sales.length - CAFE_SALES_CAP);
  return cafe.sales[cafe.sales.length - 1];
}

/**
 * 賣出日誌的節流:每 7 個遊戲日才推一則「有人點了⋯」。
 *
 * `pushCafeLog()` 是掛在某位租客的 `rt.log`(cap 60,而且是 AI 敘事的素材來源)。
 * 天天推一則賣出紀錄會在兩個月內把那位租客自己的人生全部擠出日誌。
 * 七日一則的節奏與既有的貓咪觀察筆記/週報一致,而且用 `day % 7` 判定 ⇒
 * 決定性、離線補進度也不會多推或少推。
 */
const CAFE_SALE_LOG_EVERY_DAYS = 7;

/**
 * 一整天撲空到這個人次以上,日結才再補一則「今天賣完了」的收尾摘要。
 * 一兩位客人沒買到已經由當下那則即時日誌講過了,不需要再講第二次。
 */
const CAFE_SHORTAGE_SUMMARY_MIN = 4;

/**
 * 🔴 可見性批次:「做不出來所以沒接到」日誌的節流 —— `day % 7 === 5`。
 *
 * 5 是挑剩下來的:賣出那則佔 `day % 7 === 0`、「老樣子」佔 `day % 7 === 3`,
 * 取 5 讓三則在一週裡互相錯開,玩家不會在同一天連吃三則咖啡廳日誌。
 *
 * ⚠️ 已知代價:它會佔掉 `rt.log`(cap 60)的一格,等於 AI 敘事素材少一格。
 * 這是**敘事內容的變化,不是平衡的變化**(快照局永遠不開張咖啡廳)。
 * 實玩後若覺得吵,**這是本批第一個該砍的**——面板那四個落點完全不依賴它。
 */
const CAFE_TURNAWAY_LOG_DAY = 5;

/**
 * 🔴 B 批:「老樣子」日誌的節流 —— `day % 7 === 3`。
 *
 * 刻意與賣出日誌的 `day % 7 === 0`(`CAFE_SALE_LOG_EVERY_DAYS`)**錯開**:
 * 兩者都掛在同一位租客的 `rt.log`(cap 60,也是 AI 敘事的素材來源),
 * 撞在同一天等於一天吃掉兩格。錯開之後咖啡廳每週固定佔兩格、分散在兩天。
 */
const CAFE_REGULAR_USUAL_LOG_DAY_MOD = 7;
const CAFE_REGULAR_USUAL_LOG_DAY = 3;

/**
 * 🔴 B 批:常客撲空的日誌只在好感**由上往下跨過**這條線時推一次。
 *
 * 每次撲空都推會變成天天在罵玩家(缺貨那條路已經在扣聲譽了);
 * 只在「這段關係真的開始壞掉」的那一刻講一次,才是玩家需要的信號。
 */
const CAFE_REGULAR_REFUSED_LOG_AFFECTION = 40;

/**
 * 把一筆結帳變成一位站得上畫面的顧客(重設計 P2)。
 *
 * seed / sequence 沿用 P1 之前 `cafeGuestPass()` 的 `cafe|日|時` + 逐位 index,
 * 所以顧客的姓名、外觀、意圖、停留時數全部照舊是決定性雜湊,零 `Math.random()`。
 *
 * `CAFE_GUEST_CAP` 只是防爆保險絲,正常流量下不會綁到(理由見 `cafeGuests.ts`
 * 的常數註解);真的滿了寧可少一位可見顧客也不讓陣列無限成長,
 * `scripts/cafe-p2-flow-test.ts` 直接驗這條餘裕。
 */
function spawnCafeGuestForOrder(
  day: number,
  hour: number,
  index: number,
  order: CafeGuestOrder,
  seatTile: { c: number; r: number } | null,
  intentWeights?: CafeIntentWeights,
  forceName?: string,
): CafeGuest | null {
  const cafe = state.cafe;
  if (cafe.guests.length >= CAFE_GUEST_CAP) return null;
  const guest = generateCafeGuest({
    seed: `cafe|${day}|${hour}`,
    arrivedMs: state.gameMs,
    sequence: index,
    excludeNames: cafe.guests.map((entry) => entry.name), // 同時在店的客人不撞名
    seatTile,
    takeaway: seatTile === null, // 外帶與撲空都只停留 0.25 遊戲小時
    order,
    intentWeights,
    // 🔴 B 批:今天輪到哪位常客回訪就指定誰(省略 = 今日行為)。
    forceName,
  });
  if (cafe.guests.some((entry) => entry.id === guest.id)) return null;
  cafe.guests.push(guest);
  return guest;
}

/**
 * 🔴 咖啡廳逐位結帳(重設計 P1,設計文件 §3 §4.2 §4.3 §4.8)。
 *
 * 掛在 `hourlyTick()` 的 `cafeGuestPass()` 正後方,營業時段每小時跑一次:
 *
 * ```
 * 當日客流(= min(想上門的人, 產能)) → 攤到 11 個營業小時 → 每位顧客各選一項商品
 *                                 ├─ 料齊 → 扣料、收錢、聲譽 +0.15
 *                                 └─ 缺料 → $0、聲譽 −2.0、轉頭就走
 * 被產能夾掉的人(想上門 − 產能)  → 走進店裡排隊 → 排到放棄、$0、聲譽 −1.0(A 批)
 * 當日營收 = Σ 每位顧客實際點到的商品售價
 * ```
 *
 * ## 🔴 A 批:排太久放棄離開(使用者 2026-08-05 拍板;設計文件 §4.9 初稿)
 *
 * 放棄的人選在**這裡**產生而不是在渲染層,理由有三:
 *
 * 1. **$0 必須是「從沒收過」而不是「收了再退」**。錢在本 pass 當場入帳,若讓畫面層
 *    事後判定放棄,就得倒扣一筆退款——收支頁會出現玩家沒做過的交易。
 *    走 `cafeAbandonCount()` 這條路完全沒有這個問題:那批人本來就不在 `crowd.guests` 裡。
 * 2. **離線一致性**。畫面層走現實秒數,玩家沒開 1F 頁面就不會演;若懲罰掛在那裡,
 *    「有沒有在看」會改變帳本,P1/P3 建立的「線上逐時 = 離線補進度」立刻破功。
 * 3. **零 RNG**。人數是純算術(累積差分),選品仍走 `chooseCafeMenuItem()` 的 FNV-1a。
 *
 * 渲染層(`guestAgents`)拿到的是已經標好 `order.abandoned` 的顧客,只負責把他演出來:
 * 走進門 → 站進人龍(永遠拿不到點餐位)→ 等超過 `GUEST_ABANDON_SECONDS` → 走出大門。
 * 他排最久、最後放棄——畫面說的故事與帳本說的完全一致。
 *
 * ## 零漂移
 *
 * 第一行就是 `if (!cafe.open) return;`。開張要玩家花錢,無頭的 balance 快照局
 * 永遠不會開張 ⇒ `money` / `ledger` / `logs` / `cafe` 一個欄位都碰不到。
 *
 * ## 零 RNG
 *
 * 客流走 `cafeCrowd()`(天氣 splitmix32 + 日曆星期)、攤分走 `cafeHourlyGuestCount()`
 * (純算術)、選品走 `chooseCafeMenuItem()` 的 FNV-1a、選句走 `cafeOrderLine()`。
 * 全程沒有一次 `Math.random()`。
 *
 * ## 🔴 離線一致性
 *
 * 本 pass 讀到的每一項輸入都是「當下這個小時的狀態」:`gameDayIndex()`、
 * `hour`、`cafe.popularity`、`cafe.stock`。**沒有任何跨小時的暫存或批次補算**,
 * 所以「線上逐時跑 11 次」與「離線回來一次補 11 次」逐欄位相同——
 * `syncToNow()` 本來就是逐小時呼叫 `hourlyTick()`,兩條路徑跑的是同一段程式碼。
 * `cafe-per-guest-test.ts` 有一條直接對打的斷言。
 *
 * ## 🔴 P2:合流(設計文件 §3 的唯一主張)
 *
 * P1 留下一個分裂:結帳走這裡的虛擬 index、畫面上的人由 `cafeGuestPass()` 另外
 * 用 55% 門檻生。**P2 把兩批人變成同一批**——迴圈裡每完成一次結帳,就地生出
 * 一位帶著這份訂單的可見顧客 `CafeGuest`,他頭上泡泡顯示的就是 `order.itemName`、
 * 浮字顯示的就是 `order.price`,而那筆錢同一輪就進了 `addCafeRevenue()`。
 *
 * 席次來自 `cafeSeatSpots()`(玩家實際擺的椅子);沒有空席的顧客改成**外帶**
 * (`takeaway`),點完直接走、停留時間只有 0.25 遊戲小時 ⇒ 不佔 `CAFE_GUEST_CAP`
 * 的名額,合流不變式在高流量下仍然成立(§4.6)。
 */
export function cafeHourlyPass(hour: number) {
  const cafe = state.cafe;
  if (!cafe.open) return; // 天然閘門:未開張 = 完全沒有這個子系統
  if (hour < CAFE_OPEN_HOUR || hour > CAFE_CLOSE_HOUR) return; // 打烊時間不做生意

  const day = gameDayIndex();
  const weather = weatherForDay(day);
  // 🔴 P4a:席次與員工同時進產能公式。兩者都是 state(placements / cafe.extraStaff),
  // 所以在這裡取,`cafe.ts` 仍然只吃參數。
  const seats = cafeSeatSpots();
  // 🔴 A 批:吧台寬度 = 同時服務得了幾個人。沒有吧台位置的店員薪水照付但做不出杯子,
  // 面板會用 `idleStaff` 提示玩家「加寬吧台」。同樣是 placements 的狀態,所以在這裡取。
  const cap = cafeCapability(cafe.upgrades, {
    seats: seats.length,
    extraStaff: cafe.extraStaff,
    stations: cafeServiceStations(),
  });
  // 🔴 A 批:寵物區舒適與招牌等級推高認養／租屋詢問的出現率。
  // 每小時只算一次(不進逐位顧客的迴圈),`intent` 不參與結帳 ⇒ 營收零影響。
  const intentWeights = cafeIntentWeights(
    cafePetComfort(cafePetComfortPoints(), cafe.upgrades),
    cap.signLevel,
  );
  const crowd = cafeCrowd({
    weather,
    weekday: weekdayOf(state.gameMs),
    signLevel: cap.signLevel,
    capacity: cap.capacity,
    popularity: cafe.popularity,
    outdoorSeats: cap.outdoorSeats,
    // 氛圍加成:一樓四個 cafe 區域內玩家實際擺著的家具(cozy + style)。
    // 讀 placements 是 state,所以留在這裡而不是 cafe.ts。
    ambiancePoints: cafeAmbiancePoints(),
  });
  const hourIndex = hour - CAFE_OPEN_HOUR;
  const count = cafeHourlyGuestCount(crowd.guests, hourIndex);
  /**
   * 🔴 可見性批次:這小時「想上門卻做不出來、因此沒接到」的人數。
   *
   * 用**兩個 `cafeHourlyGuestCount()` 相減**而不是 `cafeHourlyGuestCount(base − guests, h)`:
   * 前者的累積差分保證 `Σ 11 小時 = base − guests`(兩邊各自的取整誤差在小時之間互相抵銷),
   * 後者會因為先減再攤而多出/少掉幾位。線上逐時與離線一次補也因此完全等價
   * (每小時只依賴 `(base, guests, hourIndex)`,不依賴前幾個小時跑過沒有)。
   *
   * ⚠️ `bringsFriend`(下面幾行)只把一位「排到放棄」救回來,**不減 `turnedAway`**:
   * 那位客人本來就在「沒接到」的那批裡,常客帶朋友改變的是他的演出方式,不是產能。
   */
  const turnedAway = cafeHourlyGuestCount(crowd.base, hourIndex) - cafeHourlyGuestCount(crowd.guests, hourIndex);
  // 🔴 A 批:被產能夾掉的那些人(`base − guests`)這小時有幾位會排到放棄。
  let abandonCount = cafeAbandonCount(crowd.base, crowd.guests, hourIndex);

  // 🔴 B 批:這小時輪到哪位常客回訪(純函式,只依賴 day / hourIndex / 排序後的名冊
  // ⇒ 線上逐時 = 離線一次補)。他會佔掉本小時的**第 0 位**顧客。
  const regularName = cafeRegularForHour(cafe.regulars, day, hourIndex);
  const arriving = regularName ? cafe.regulars.find((entry) => entry.name === regularName) ?? null : null;
  // 🔴 B 批「帶朋友」:**把本來會排到放棄的一位救回來**,而不是多生一位顧客
  // (後者會突破 `crowd.guests = min(base, capacity)`,打掉 P4a 的產能上限語意)。
  const bringsFriend = abandonCount > 0 && cafeRegularBringsFriend(arriving, day, hourIndex);
  if (bringsFriend) abandonCount -= 1;

  /**
   * 🔴 **這行 early-out 一個字都沒動**(可見性批次刻意不碰控制流 ⇒ 平衡零漂移)。
   *
   * ## 為什麼它不會漏記 `turnedAway`
   *
   * 想像中的漏洞是:「某小時 `count === 0 && abandonCount === 0` 但 `turnedAway > 0`,
   * 於是提早 return、那幾位沒被記到帳上」。這個情況**不可能發生**,推導如下,
   * 寫在這裡是為了讓下一個讀的人不必再推一次:
   *
   * 1. `turnedAway > 0`
   *      ⇒ `cafeHourlyGuestCount(base, h) > cafeHourlyGuestCount(guests, h)`
   *      ⇒ `base > guests`(累積差分對總量單調)。
   * 2. `cafeCrowd()` 的 `guests = min(base, capacity)`,而 `base > guests`
   *      ⇒ `guests === capacity`。
   * 3. `capacity` 有硬性下界:`cafeCapability()` 的 `staffCapacity = activeStaff × cupsPerStaff`,
   *    其中 `cafeServiceStaff()` 的下界是 1(收銀口一定存在),`CAFE_STAFF_CUPS_PER_DAY = 26`;
   *    席次腿的下界是 `CAFE_TAKEAWAY_CAPACITY = 10`。兩腿取 min ⇒ `capacity >= 10`。
   * 4. `cafeHourlyGuestCount()` 把 10 位攤到 `CAFE_BUSINESS_HOURS = 11` 小時,
   *    用的是累積差分 `round(total×(h+1)/11) − round(total×h/11)`。
   *    total = 10 時每小時是 0 或 1,**至少有 10 個小時拿到 1**;
   *    而真正會出現 `turnedAway > 0` 的形狀(名氣長過店面)`capacity` 遠大於 11,
   *    每小時必得 `count >= 1`。
   * 5. 唯一的邊界:total = 10、11 小時裡恰好有一個小時分到 0。那個小時
   *    `cafeHourlyGuestCount(base, h)` 也是 0 嗎?不一定 —— 所以嚴格說,
   *    **只有在 `capacity < CAFE_BUSINESS_HOURS` 時才可能漏一位**。
   *    而 `capacity >= 10` 且要 `capacity < 11` ⇒ `capacity === 10`,
   *    也就是「席次全被拆光、只剩外帶」的極端店。那種店的 `turnedAway` 每天至多漏 1 位,
   *    而且它本來就是玩家自己把椅子全賣掉的結果 —— 面板上照樣會顯示「卡在席次」。
   *
   * ⇒ 在任何正常經營的店(`capacity >= 11`)累加是**精確的**,
   *   `Σ 11 小時 turnedAway === base − guests` 有測試釘住(`cafe-bottleneck-test.ts`)。
   *   控制流一行未動 ⇒ 平衡快照零漂移。
   */
  if (count <= 0 && abandonCount <= 0) return;

  const menu = menuItems(cafe.completed);
  const record = todaysCafeSales(day);
  const servedBefore = record.served;
  const refusedBefore = record.refused;
  const abandonedBefore = record.abandoned ?? 0;
  const turnedAwayBefore = record.turnedAway ?? 0;
  let revenue = 0;
  let served = 0;
  let refused = 0;
  let abandoned = 0;
  let saleLine = "";
  let refusedLine = "";
  // B 批的敘事一樣走稀疏路線,四則全部一天最多一則(節流條件見各自的判斷式)。
  let regularUsualLine = "";
  let regularRefusedLine = "";
  const regularPromoteLines: string[] = [];
  /**
   * 「老樣子」那一則的**一天一則**閘門:只在「今天第一個會有常客上門的小時」推。
   * `cafeRegularForHour()` 是純函式 ⇒ 這個小時序在線上與離線兩條路徑上完全相同。
   */
  const firstRegularHour = (() => {
    for (let h = 0; h < CAFE_BUSINESS_HOURS; h++) if (cafeRegularForHour(cafe.regulars, day, h)) return h;
    return -1;
  })();

  // 🔴 合流的席次來源:玩家實際擺的椅子(上面算產能時已經取過同一份 `seats`)。
  // 拆光 ⇒ seats 為空 ⇒ 全部外帶,且產能掉到 `CAFE_TAKEAWAY_CAPACITY`。
  const takenSeats = new Set(
    cafe.guests
      .filter((guest) => guest.seatTile)
      .map((guest) => `${guest.seatTile!.c},${guest.seatTile!.r}`),
  );
  /** 取一個沒人坐的席位;客滿(或超過內用上限)回 null ⇒ 這位改成外帶。 */
  const claimSeat = () => {
    if (takenSeats.size >= CAFE_DINE_IN_CAP) return null;
    for (const spot of seats) {
      const key = `${spot.seat.c},${spot.seat.r}`;
      if (takenSeats.has(key)) continue;
      takenSeats.add(key);
      return spot;
    }
    return null;
  };

  for (let index = 0; index < count; index++) {
    // 🔴 B 批:常客佔本小時的第 0 位。他點的是「老樣子」(`itemCounts` 最高那項),
    // 沒有紀錄時退回加權抽選、但客群修正改吃他自己的 `taste`(綁姓名不綁日期)。
    const forcedName = index === 0 && regularName ? regularName : undefined;
    const usualItemId = forcedName ? cafeRegularUsualItem(arriving) ?? undefined : undefined;
    const item = chooseCafeMenuItem({
      menu, day, hour, index, weather,
      preferTrack: forcedName ? arriving?.taste : undefined,
      forceItemId: usualItemId,
    });
    if (!item) break; // 菜單掛了(不該發生);不收錢也不罰聲譽
    const till = checkoutCafeOrder(cafe.stock, item);
    // 撲空的顧客不佔席(他轉頭就走);服務到的才去搶一張真的椅子。
    const spot = till.ok ? claimSeat() : null;
    const order: CafeGuestOrder = {
      itemId: item.id,
      itemName: item.name,
      price: item.price,
      track: item.track,
      served: till.ok,
      missing: till.ok ? "" : getCafeIngredient(till.missing[0])?.name ?? "備料",
      takeaway: till.ok && !spot,
      // 欄位一律寫齊(而不是靠 undefined):存檔消毒會補成 false,
      // 少寫這一欄會讓「訂單通過存檔往返後逐欄相同」的斷言破功。
      abandoned: false,
    };
    if (till.ok) {
      cafe.stock = till.stock;
      revenue += till.revenue;
      // 🔴 B 批②:好感夠高的常客留下的小費。2 位/日 × $3 = +$6/日,
      // 不開新的金流管道(仍是同一筆咖啡廳營收),也不動任何一項的售價。
      if (forcedName && arriving && arriving.affection >= CAFE_REGULAR_TIP_AFFECTION) revenue += CAFE_REGULAR_TIP;
      record.ingredientCost += till.cost;
      record.sold[item.id] = (record.sold[item.id] ?? 0) + 1;
      served += 1;
      if (!saleLine && servedBefore === 0 && served === 1 && day % CAFE_SALE_LOG_EVERY_DAYS === 0) {
        saleLine = cafeOrderLine({ kind: "sale", day, hour, itemName: item.name, price: item.price });
      }
    } else {
      record.missed[item.id] = (record.missed[item.id] ?? 0) + 1;
      // 🔴 缺貨歸因:記下**當下真的不夠的那些原料**,而不是事後拿配方回推。
      // 同一個品項在不同日子可能缺不同的料(拉花拿鐵可能缺咖啡豆、也可能缺牛奶),
      // 只有這裡的 `till.missing` 講得出來。面板的「缺貨 → 要補哪個原料」讀的就是它。
      const missedBy = record.missedBy ?? (record.missedBy = {});
      const blame = missedBy[item.id] ?? (missedBy[item.id] = {});
      for (const ingredientId of till.missing) blame[ingredientId] = (blame[ingredientId] ?? 0) + 1;
      refused += 1;
      if (!refusedLine && refusedBefore === 0 && refused === 1) {
        refusedLine = cafeOrderLine({
          kind: "refused", day, hour, itemName: item.name,
          missingName: order.missing,
        });
      }
    }
    // 🔴 這一行就是合流:每一筆結帳都生出一位帶著這份訂單、走得進畫面的顧客。
    const guest = spawnCafeGuestForOrder(day, hour, index, order, spot?.seat ?? null, intentWeights, forcedName);
    if (!guest) continue; // 顧客上限的保險絲踩到了 ⇒ 這位沒有站上畫面,也就不算一次來訪

    // 🔴 B 批:常客記帳。身分鍵是**姓名**,所以一定要在顧客生成之後才知道是誰。
    //
    // 🔴 E 批:姓名在**進入常客系統之前**先消毒。載入時的消毒只跑一次,執行期升格是另一條路
    //(候選人鍵 → `CafeRegular.name` → 咖啡廳日誌 → prompt)。消毒放在 caller 而不是 `cafe.ts`:
    // `cafe.ts` 是純函式檔且 `gameState.ts` 已經 import 它,反向 import 會成環又會把
    // reactive state 拉進純函式層(`cafe-supply-test.ts` / `cafe-regular-test.ts` 有界線掃描)。
    // 清乾淨後為空 ⇒ `touchCafeRegular()` 本來就回 idle,壞名字連候選人都當不成。
    const guestRegularName = sanitizeCafeRegularName(guest.name);
    if (till.ok) {
      const touched = touchCafeRegular(cafe.regulars, cafe.regularCandidates, cafe.regularCandidateDays, {
        name: guestRegularName, day, itemId: item.id, appearance: guest.appearance,
      });
      cafe.regulars = touched.regulars;
      cafe.regularCandidates = touched.candidates;
      cafe.regularCandidateDays = touched.candidateDays;
      if (touched.promoted) {
        regularPromoteLines.push(cafeRegularLine({ kind: "promote", day, name: touched.promoted.name }));
      }
      // 「老樣子」:與賣出日誌的 `day % 7 === 0` 錯開,並且一天最多一則。
      if (!regularUsualLine && forcedName && usualItemId && hourIndex === firstRegularHour
        && day % CAFE_REGULAR_USUAL_LOG_DAY_MOD === CAFE_REGULAR_USUAL_LOG_DAY) {
        regularUsualLine = cafeRegularLine({ kind: "usual", day, name: guestRegularName, itemName: item.name });
      }
    } else {
      // 讓熟客白跑一趟:好感 −6。只在好感由上往下跨過 40 時才推一則(不然天天在罵玩家)。
      const hurt = refuseCafeRegular(cafe.regulars, guestRegularName);
      if (hurt.before !== null) {
        cafe.regulars = hurt.regulars;
        if (!regularRefusedLine && hurt.before >= CAFE_REGULAR_REFUSED_LOG_AFFECTION
          && (hurt.after ?? 0) < CAFE_REGULAR_REFUSED_LOG_AFFECTION) {
          regularRefusedLine = cafeRegularLine({ kind: "refused", day, name: guestRegularName });
        }
      }
    }
  }

  // 🔴 A 批:被產能夾掉的那幾位——他們真的走進店裡、站進人龍,然後放棄離開。
  // 不扣原料、不收錢、不佔席:`crowd.guests` 從第一天起就沒把他們算進營收,
  // 所以這裡沒有任何金流改動,新增的只有聲譽 −1/人與一則日誌。
  for (let i = 0; i < abandonCount; i++) {
    const index = count + i; // 續號,不與結帳那批的 seed/sequence 撞在一起
    const item = chooseCafeMenuItem({ menu, day, hour, index, weather });
    if (!item) break;
    abandoned += 1;
    spawnCafeGuestForOrder(day, hour, index, {
      itemId: item.id,
      itemName: item.name,
      price: item.price,
      track: item.track,
      served: false,
      missing: "",
      takeaway: true, // 不佔席、停留 0.25 遊戲小時(足夠演完「排到放棄」再走出門)
      abandoned: true,
    }, null, intentWeights);
  }

  record.revenue += revenue;
  record.served += served;
  record.refused += refused;
  if (abandoned > 0) record.abandoned = abandonedBefore + abandoned;
  // 🔴 可見性批次:純寫入的新欄位。**沒有任何算式讀它**(唯一的讀取端是日結流失日誌的
  // 節流門檻與面板),所以它對金流、聲譽、客流一律零影響 ⇒ 平衡快照零漂移。
  if (turnedAway > 0) record.turnedAway = turnedAwayBefore + turnedAway;
  if (revenue > 0) addCafeRevenue(revenue);
  if (served > 0 || refused > 0 || abandoned > 0) {
    cafe.popularity = cafeServicePopularity(cafe.popularity, served, refused, abandoned);
  }
  // 敘事一樣走稀疏路線:一天最多一則賣出(且七日一次)、一則撲空、一則排到放棄。
  if (saleLine) pushCafeLog(saleLine);
  if (refusedLine) pushCafeLog(refusedLine);
  if (abandoned > 0 && abandonedBefore === 0) {
    pushCafeLog(cafeOrderLine({ kind: "abandoned", day, hour, itemName: "", abandoned }));
  }
  // 🔴 B 批的四則。升格是一生一次的里程碑,不節流;其餘三則各自一天最多一則。
  for (const line of regularPromoteLines) pushCafeLog(line);
  if (regularUsualLine) pushCafeLog(regularUsualLine);
  if (regularRefusedLine) pushCafeLog(regularRefusedLine);
  // 帶朋友:綁在「今天第一個有人放棄的小時」⇒ 一天最多一則,而且必定伴隨看得見的人龍。
  if (bringsFriend && regularName && abandonedBefore === 0) {
    pushCafeLog(cafeRegularFriendLine(day, regularName));
  }
}

/**
 * 開店前一小時(09:00)進貨。**設計文件 §4.3 §4.4 的 P3 核心改動。**
 *
 * ## 為什麼要把進貨從日結搬到開店前
 *
 * P1 的實測(`scripts/cafe-opening-sim.ts`)顯示「缺貨」一點都不痛:當時進貨在
 * **日結時**發生,而且是「補到常備量」——少備料的同時也少付錢,當天大致損益兩平。
 * 搬到開店前之後玩家**先付整批錢、再開門賺錢**,於是
 *
 * - 「備了料卻沒客人」= 真的付出去的現金,
 * - 「沒備料所以賣不出去」= 付了固定開銷卻沒有營收,
 *
 * 兩個方向都變成真的損失。這正是「經營」與「領被動收入」的分野。
 *
 * ## 🔴 一天只扣一次:旗標記在存檔裡的當日銷售紀錄上
 *
 * 冪等性完全比照 P1 的 `settled`:`todaysCafeSales(day).restocked`。
 * 因此
 *
 * - **同一小時被呼叫兩次**(手動快轉 + 前景同步撞在一起)→ 第二次直接 return;
 * - **離線補進度**:`syncToNow()` 逐小時呼叫 `hourlyTick()`,09:00 那一刻照樣
 *   會經過本 pass,與線上逐時完全走同一段程式碼、同一個旗標;
 * - **旗標進存檔**(`sanitizeCafeState` 有補),重讀存檔也不會再扣一次。
 *
 * 觸發條件寫成 `09:00 ~ 20:00 之間、今天還沒進過貨`,而不是「剛好等於 09:00」:
 * 玩家離線超過 `MAX_CATCHUP_HOURS` 被重錨、或存檔剛好停在中午,09:00 那一刻可能
 * 根本沒被跑到;那時「進門第一件事先補貨」才是玩家預期的行為。打烊後(> 20:00)
 * 就不補了——那只會買一批東西進來等著半夜壞掉。
 *
 * 未開張 ⇒ 第一行 return,`money` / `ledger` / `cafe` 一個欄位都不碰 ⇒ 平衡快照零漂移。
 */
export function cafeRestockPass(hour: number) {
  const cafe = state.cafe;
  if (!cafe.open) return; // 天然閘門:未開張 = 完全沒有這個子系統
  const h = Math.trunc(Number.isFinite(hour) ? hour : -1);
  if (h < CAFE_OPEN_HOUR - 1 || h > CAFE_CLOSE_HOUR) return;

  const day = gameDayIndex();
  const record = todaysCafeSales(day);
  if (record.restocked) return; // 🔴 今天已經進過貨了
  record.restocked = true;

  const moneyBefore = state.money;
  // 🔴 A 批:後場(`cafe_back`)擺的貨架/木箱/冷藏決定放得下多少。讀 placements 是 state,
  // 所以在這裡取,`cafe.ts` 仍然只吃參數。
  const plan = restockPlan(cafe.standingOrders, cafe.stock, state.money, {
    capacity: cafeStorageCapacity(cafeBackStoragePoints()),
  });
  if (plan.totalCost > 0) addMoney(-plan.totalCost, "咖啡廳進貨", "cafe");
  cafe.stock = plan.stock;
  // 記「實際扣掉的錢」而非帳面應付:日結寫 history 時要與 money/ledger 三方對得起來。
  record.restockCost = Math.max(0, moneyBefore - state.money);

  // 錢不夠、進貨補不滿是**跨日的軟性扣分**(逐位結帳的 ±0.15/−2 管不到這件事)。
  // 它在 P1 掛在日結,現在跟著進貨一起搬到這裡——事件發生在哪裡,後果就記在哪裡。
  if (plan.underfunded) {
    cafe.popularity = clampCafePopularity(cafe.popularity - CAFE_POPULARITY_SOFT_LOSS);
    const missingLine = plan.lines.find((line) => line.bought < line.want);
    if (missingLine) {
      pushCafeLog(cafeDailyLine({ kind: "underfunded", day, subject: missingLine.name, fulfillment: plan.fulfillment }));
    }
  } else if (plan.capped) {
    // 放不下是**空間問題不是錢的問題**:一天最多一則、與「錢不夠」二選一(錢不夠優先講),
    // 而且**不扣聲譽** —— 真的因此缺貨的話,缺貨那條路已經在罰了。
    const cappedLine = plan.lines.find((line) => line.bought < line.want) ?? plan.lines[0];
    if (cappedLine) pushCafeLog(cafeDailyLine({ kind: "storage", day, subject: cappedLine.name }));
  }
}

/**
 * 咖啡廳日結(CAFE-13 起,重設計 P1/P3 兩度縮編職責)。
 *
 * 掛在換日區塊 `collectRent()` 的**正後方**,讓咖啡廳損益與租金/管理費落在同一個帳日。
 * 既有 pass 的順序一行未動。
 *
 * ## 🔴 P1 之後不再計算營收,P3 之後不再進貨
 *
 * 營收是 `cafeHourlyPass()` 逐位顧客當場收的,進貨是 `cafeRestockPass()` 開店前扣的。
 * 本 pass 只剩三件跨日的事:
 *
 * 1. 到期研發結清(要早於下一個營業日的菜單)
 * 2. **固定開銷**與**生鮮損耗**——損耗的對象因此變成「打烊後真正剩下的庫存」,
 *    而不是 P1 時代「剛補滿的常備量」(見 `cafe.ts` 的 `SPOILAGE_FREE_UNITS` 推導)
 * 3. 收走剛結束那個營業日的成績寫進 `history`(含當日開店前的進貨支出)
 *
 * ## 零漂移 / 零 RNG
 *
 * 第一行仍是 `if (!cafe.open) return;`。選句走 `cafeDailyLine()` 內的 FNV-1a,
 * 天氣/星期不再需要(客流已經在小時 pass 算完),整個 pass 沒有一次 `Math.random()`。
 */
export function cafeDailyPass() {
  const cafe = state.cafe;
  if (!cafe.open) return; // 天然閘門:未開張 = 完全沒有這個子系統

  const day = gameDayIndex();
  // CAFE-18B:先結清到期研發，讓面板關閉／離線補進度也不會卡住；
  // 必須早於下一個營業日的第一位顧客,新品才會當天就上菜單。
  const research = advanceCafeResearch(cafe, day);
  if (research.changed) {
    Object.assign(cafe, research.cafe);
    notify(`🎉 「${research.completed?.name ?? "咖啡廳研發"}」完成，新品已加入菜單`);
  }
  const cap = cafeCapability(cafe.upgrades);

  // 1) 收走剛結束的那個營業日的成績(逐位結帳已經把錢收進來了,這裡只是對帳;
  //    當日開店前的進貨支出也記在同一筆銷售紀錄上,一起收回來)
  const trading = settleCafeSales();

  // 2) 固定成本(addMoney 下限 0,錢不夠也不會變負)
  const moneyBefore = state.money;
  addMoney(-CAFE_FIXED_COST, "咖啡廳固定開銷", "cafe");

  // 2b) 🔴 P4a:額外員工的薪資(設計文件 §4.7 的第五條虧損管道「過度擴張」)。
  //     **時點刻意與固定開銷同一行**——理由是三件事必須同時成立:
  //     - 一天只扣一次:本 pass 由換日區塊呼叫,每個遊戲日恰好跑一次(同 CAFE_FIXED_COST);
  //     - 離線一致:離線補進度走 `syncToNow()` 的逐日換日,經過的是同一段程式碼;
  //     - 淡季照付:扣款不看今天有沒有客人、開沒開店,雇了就是雇了。
  //     首位店員不在這裡——他的薪水已經算在 `CAFE_FIXED_COST` 裡(設計文件 §4.9)。
  const wage = cafeStaffWage(cafe.extraStaff);
  if (wage > 0) addMoney(-wage, "咖啡廳員工薪資", "cafe");

  // 3) 生鮮損耗(每個遊戲日恰好一次,見 applySpoilage 的冪等性說明)。
  //    🔴 P3:進貨已經在 09:00 做完,所以這裡吃到的是**打烊後剩下的庫存**——
  //    訂得剛好的人幾乎沒東西可壞,囤積的人才會天天丟。
  const rot = applySpoilage(cafe.stock, cap.spoilage);
  cafe.stock = rot.stock;

  // 4) 日結紀錄。cost = 今天的固定開銷 + 今天開店前的進貨,
  //    兩筆都取「實際扣掉的錢」而非帳面應付,才會與 money/ledger 三方對得起來
  //    (帳上不夠時 addMoney 會夾在 0,這遊戲不讓玩家欠債)。
  const cost = (moneyBefore - state.money) + trading.restockCost;
  cafe.history.push({ day, guests: trading.served, revenue: trading.revenue, cost, net: trading.revenue - cost });
  if (cafe.history.length > CAFE_HISTORY_CAP) cafe.history.splice(0, cafe.history.length - CAFE_HISTORY_CAP);

  // 5) 敘事:**一天最多推一則**(稀疏哲學同 floorChain 的「每次 pass 最多推一話」)。
  //    缺貨的第一則已經在當下由 cafeHourlyPass 推過了,所以這裡只在「整天都在說抱歉」
  //    (撲空 >= CAFE_SHORTAGE_SUMMARY_MIN 人)時才補一則收尾摘要。
  //    「補不滿」那一則跟著進貨一起搬去 cafeRestockPass 了,這裡只剩損耗。
  if (trading.refused >= CAFE_SHORTAGE_SUMMARY_MIN) {
    pushCafeLog(cafeDailyLine({ kind: "shortage", day, subject: cafeTopShortageName(trading.day) }));
  } else if (rot.totalSpoiled > 0) {
    pushCafeLog(cafeDailyLine({ kind: "spoilage", day, subject: rot.lines[0].name }));
  } else if (
    // 🔴 可見性批次:「做不出來所以沒接到」。掛在既有 if/else 鏈的**最後一格**
    // ⇒ 缺貨或損耗有話講的日子,行為逐字不變(既有測試一條都不受影響)。
    //
    // 三重節流:
    // ① 只在缺貨與損耗都沒話講的日子(else 分支本身)
    // ② 只在「沒接到 >= 接到」的日子 —— 生意好本來就會有人排不到,
    //    要嚴重到「錯過的比做成的還多」才值得佔掉玩家一格日誌
    // ③ `day % 7 === CAFE_TURNAWAY_LOG_DAY` ⇒ **每遊戲週最多一則**,
    //    且與賣出(0)、老樣子(3)兩則錯開
    //
    // ⚠️ 門檻用 `trading.served` 而不是本 pass 上面那個 `cap` —— 後者是
    // **不帶幾何**的退化產能(沒餵 seats/stations),拿來當門檻會系統性算錯。
    trading.turnedAway >= Math.max(1, trading.served)
    && day % 7 === CAFE_TURNAWAY_LOG_DAY
  ) {
    pushCafeLog(cafeDailyLine({ kind: "turnaway", day, subject: "", count: trading.turnedAway }));
  }

  // 6) 🔴 B 批:常客的好感衰退與流失。
  //    衰退只在超過 `CAFE_REGULAR_GRACE_DAYS` 之後才動,而正常回訪節奏(約 3 天一次)
  //    剛好落在寬限內 ⇒ **好好開店的人不會掉好感**,怠慢(關店、天天缺貨)才會。
  //    流失要「好感歸零 **且** 14 天沒來」兩個條件同時成立,一次缺貨不會走人。
  const fade = decayCafeRegulars(cafe.regulars, day);
  cafe.regulars = fade.regulars;
  for (const gone of fade.lapsed) pushCafeLog(cafeRegularLine({ kind: "lapse", day, name: gone.name }));
  // 候選人名冊每 7 個遊戲日全體 −1:3 次必須在滾動窗內累積,不留殭屍候選人。
  if (day % CAFE_REGULAR_CANDIDATE_DECAY_DAYS === 0) {
    const trimmed = decayCafeRegularCandidates(cafe.regularCandidates, cafe.regularCandidateDays);
    cafe.regularCandidates = trimmed.candidates;
    cafe.regularCandidateDays = trimmed.candidateDays;
  }
}

/** 收走最後一筆尚未結算的營業日成績;沒有就回零(例如剛開張、當天還沒營業過)。 */
function settleCafeSales(): {
  day: number; revenue: number; served: number; refused: number; restockCost: number; turnedAway: number;
} {
  const sales = state.cafe.sales;
  const last = Array.isArray(sales) && sales.length > 0 ? sales[sales.length - 1] : null;
  if (!last || last.settled) return { day: -1, revenue: 0, served: 0, refused: 0, restockCost: 0, turnedAway: 0 };
  last.settled = true;
  return {
    day: last.day,
    revenue: last.revenue,
    served: last.served,
    refused: last.refused,
    restockCost: Math.max(0, last.restockCost ?? 0),
    // 🔴 可見性批次:只給日誌節流用,不進 `history`、不進金流。
    turnedAway: Math.max(0, last.turnedAway ?? 0),
  };
}

/** 該日撲空最多的品項名(給日結摘要用);查無資料回「備料」。 */
function cafeTopShortageName(day: number): string {
  const entry = state.cafe.sales.find((row) => row.day === day);
  if (!entry) return "備料";
  let bestId = "";
  let bestCount = 0;
  // 依 id 排序後再挑,避免鍵的插入序讓同一存檔在不同 session 選到不同品項。
  for (const id of Object.keys(entry.missed).sort()) {
    if (entry.missed[id] > bestCount) { bestId = id; bestCount = entry.missed[id]; }
  }
  return menuItems(state.cafe.completed).find((item) => item.id === bestId)?.name ?? "備料";
}

/** 推進一個遊戲小時(live=true 才在換日時打 AI;補進度/快轉用模板避免大量 API 呼叫) */
export function hourlyTick(live = false) {
  const prevDay = new Date(state.gameMs).getDate();
  state.gameMs += MS_PER_GAME_HOUR;
  // 到期搬離是逐時不變條件，不再只依賴午夜的每日 pass。
  // 長時間開頁、分頁恢復或舊檔若已顯示 0 天，下一個遊戲小時必定完成離場。
  reconcileDueSettleDepartures();
  const d = new Date(state.gameMs);
  const hour = d.getHours();
  const day = gameDayIndex();
  const moveOuts: string[] = [];
  visitIntents.clear();

  for (const rt of Object.values(state.runtimes)) {
    // 行為指令到期 → 恢復往常 + 留一筆日誌(在暫停檢查之前,免得掛著過期指令)
    if (rt.directive && day > rt.directive.untilDay) {
      const def = directiveDef(rt.directive.id); // 已下架的舊 id → null,靜靜丟掉就好
      rt.directive = null;
      if (def) pushSocialLog(rt, def.endText, "notable");
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

    // 觸發突發事件(每位租客冷卻 4 遊戲日,避免連發)。
    // 🔴 **刻意長於 AI 事件的 3 日**(`narration.ts:305`),而且兩者共用同一個 `lastEventDay`:
    // 規則事件一活過來就會每 N 日燒掉一次事件槽,相等或更短會讓規則事件**餓死 AI 事件**。
    // 副效果是 `breakdown` 的重播間隔也拉到 4 日 —— 那時壓力早已回到平衡點
    // (0.94^96 = 0.0026),要不要重播純由「虧待度是否還在」決定 ⇒ 玩家修好就停,因果正確。
    if (day - rt.lastEventDay >= 4) {
      const ev = rollEvent({
        name: rt.tenant.name,
        stress: rt.tenant.stats.stress,
        satisfaction: rt.satisfaction,
        affinity: rt.tenant.stats.affinity,
        wellbeing: rt.tenant.stats.wellbeing,
        neglect: neglectPoints(rt),
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

  dreamPass(hour); // 夢境彩蛋:全員本小時 visualState 已定,睡著者每 3~4 遊戲日留一則夢(零 RNG、零數值)
  outingEncounterPass(hour); // 樓外巧遇:同理由要等全員 visualState 定案,同時外出的兩人每 4~5 日低頻碰面(零 RNG)
  cafeRestockPass(hour); // 一樓咖啡廳開店前進貨(09:00,一天只扣一次):必須早於同一小時的結帳(未開張直接 return)
  cafeGuestPass(hour); // 一樓咖啡廳來客/離場:未開張直接 return(零 RNG、不碰 runtimes,故快照零漂移)
  cafeHourlyPass(hour); // 一樓咖啡廳逐位結帳:當日營收 = Σ 顧客實際點到的商品售價(未開張直接 return)
  roomVisitPass(hour); // 作息都確定後再配對；拜訪成立就由 interactionsPass 保證共同活動
  pruneFxByGame(state.gameMs); // 依遊戲時間清掉長效演出(快轉時不殘留)
  const interacted = interactionsPass(); // 同房/交誼廳的目錄式互動(§10-1/10-2,canInteract 把關)
  socialPass(interacted); // 交誼廳相遇 → 聊天/衝突/戀愛(這小時已互動過的配對跳過,避免雙重)
  dramaPass(); // 戲劇事件:劈腿抓包/偷吃冰箱(§10-2 戲劇批)
  petsPass(); // 寵物貓:換去處 + 闖房/搗蛋/大小便事件
  scheduledCommunityPass(); // 有時段的群體事件:到早晨／傍晚／夜間才結算並把參與者帶到場景
  // 🔴 H 批:日記是唯一會碰外部服務與大量存檔欄位的 pass,而它就排在換日區塊
  // (收租/AI 額度重置/心願/樓層事件鏈/save)的**正前方** —— 例外逃出去會讓整個遊戲靜止。
  // produceDiaryFor() 內部已自保,這裡再包一層,連 ensureDiaryHours() 之類都兜住。
  try {
    diaryPass(hour, live); // 輪到日記時段的租客生成日記(每人錯開在一天不同時間,分散 AI 額度)
  } catch (err) {
    console.error("[tick] diaryPass 失敗,本小時略過日記,其餘結算照常", err);
  }
  if (d.getDate() !== prevDay) {
    pruneStaleMemories(); // 記憶與現況矛盾 → 淡出(例:心情很好卻掛著[情緒低落])
    dirtyComplaintPass(day); // 整潔太低 → 抱怨髒亂(每 2 日一次,壓力小升)
    cozyHomePass(day); // 整潔舒適房 → 偶爾正向慶祝(每 3 日一次,心情/滿意小升;dirtyComplaint 的對稱正向鉤子)
    maintenancePass(); // 設備故障擲骰 + 未修的拖延懲罰(§7-1)
    feudPass(); // 冷戰:關係每日小扣、期滿氣消(§10-2)
    relationshipDailyPass(); // 積怨每天自然降溫；好感與戀愛狀態不受影響
    collectRent();
    cafeDailyPass(); // 一樓咖啡廳日結:與租金/管理費同一帳日;未開張直接 return(零 RNG、快照零漂移)
    resetDiaryQuota(); // AI 額度每日重置 → 新的一天重新嘗試
    legacyPass(); // 累積型成就輪詢:客滿/滿 30 天/資產破 15 萬/初戀(§G-7)
    for (const g of wishPass()) graduateFarewell(g.id, g.reason); // 人生心願每日推進;到期者圓夢離開(紅包+退押金+口碑)
    communityPass(); // 群體事件:洗衣房口角/揪團/噪音公審/頂樓乘涼(牽動 3+ 人,§C-7)
    floorChainPass(); // 月度全樓事件鏈:都更傳聞/颱風夜停電/頂樓漏水,4 話跨日連鎖(零 RNG)
    localArcPass(); // 劇情弧每日維護:本地支線推進 + AI 主線 stall 收束(零 RNG,主支線互不覆寫)
    catJournalPass(); // 貓咪觀察筆記:每 7 遊戲日一篇,以貓口吻進 Feed(彩蛋)
    weeklyReportPass(); // 每 7 遊戲日彙整收支、大事與關係變化,進動態頁週報卡
  }
}

/** 整潔太低的抱怨冷卻(tenantId → 上次抱怨的遊戲日;模組層,不入存檔,純敘事) */
const dirtyComplaintDay = new Map<string, number>();

/**
 * 整潔翻身的「太低後果」:房間 < 40 → 每 2 遊戲日抱怨一次髒亂(壓力小升 + 社交日誌)。
 * 舒適度已在基準線拉低心情/健康,這裡再補一筆可見的抱怨,讓玩家知道該打掃/加收納。
 * 用日數冷卻(不擲 RNG,避免打亂模擬亂數序列與 balance)。
 */
function dirtyComplaintPass(day: number) {
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent || rt.cleanliness >= 40) continue;
    if (!roomOfTenant(rt.tenant.id)) continue;
    const last = dirtyComplaintDay.get(rt.tenant.id) ?? -99;
    if (day - last < 2) continue;
    dirtyComplaintDay.set(rt.tenant.id, day);
    rt.tenant.stats.stress = clamp(rt.tenant.stats.stress + 2, 0, 100);
    pushSocialLog(rt, "🧹 房間亂得讓人靜不下心,忍不住嫌了句「該打掃了」。", "notable");
  }
}

/** 舒適乾淨房的正向冷卻(tenantId → 上次慶祝的遊戲日;模組層,不入存檔,純敘事) */
const cozyHomeDay = new Map<string, number>();
/** 房間既舒適(≥52)又乾淨(≥80)才慶祝——與 dirtyComplaintPass(髒亂<40)對稱的正向鉤子 */
const COZY_COMFORT = 52;
const COZY_CLEAN = 80;
/** 慶祝文案(正向、慢變環境品質語氣);索引用日期+租客雜湊決定,不擲 RNG。 */
const COZY_HOME_LINES = [
  "🏡 房間收拾得舒服又乾淨,窩在裡頭莫名地安心。",
  "🏡 陽光灑進整潔的房間,連呼吸都覺得順暢了些。",
  "🏡 一切都擺得剛剛好,待在這個空間讓人打從心底放鬆。",
  "🏡 房間乾淨得發亮,今天的心情也跟著明亮了起來。",
];

/** 依遊戲日 + 租客 id 穩定選文案(不用 Math.random,避免純文字擴充改變 balance RNG)。 */
function cozyHomeIndex(day: number, tenantId: string, size: number): number {
  const key = `cozy|${day}|${tenantId}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % size;
}

/** 測試用:清掉慶祝冷卻(模組層 Map,跨測試會殘留)。 */
export function resetCozyHomeCooldown() {
  cozyHomeDay.clear();
}

/**
 * 整潔翻身的「夠好後果」:房間既舒適又乾淨 → 每 3 遊戲日偶爾一句正向日誌 + 極小加成
 * (心情 +2、滿意 +1)。與 dirtyComplaintPass 對稱:一個懲罰髒亂、一個獎勵用心佈置維持,
 * 都用日數冷卻(不擲 RNG),稀疏不洗版,符合「慢變環境品質、不需 Sims 式照顧」的定位。
 */
export function cozyHomePass(day: number) {
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent) continue;
    const roomId = roomOfTenant(rt.tenant.id);
    if (!roomId) continue;
    if (rt.cleanliness < COZY_CLEAN) continue;
    if (roomComfort(roomId, rt.cleanliness) < COZY_COMFORT) continue;
    const last = cozyHomeDay.get(rt.tenant.id) ?? -99;
    if (day - last < 3) continue;
    cozyHomeDay.set(rt.tenant.id, day);
    rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 2, 0, 100);
    rt.satisfaction = clamp(rt.satisfaction + 1, 0, 100);
    pushSocialLog(rt, COZY_HOME_LINES[cozyHomeIndex(day, rt.tenant.id, COZY_HOME_LINES.length)], "notable");
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
export function socialPass(skip: Set<string> = new Set()) {
  const inLounge = Object.values(state.runtimes).filter((rt) => rt.inLounge && !rt.pendingEvent);
  const conflictDayKey = "social_conflicts_day_index";
  const conflictCountKey = "social_conflicts_day_count";
  const day = gameDayIndex();
  if (state.interactionCooldowns[conflictDayKey] !== day) {
    state.interactionCooldowns[conflictDayKey] = day;
    state.interactionCooldowns[conflictCountKey] = 0;
  }
  let conflictsToday = state.interactionCooldowns[conflictCountKey] ?? 0;
  for (let i = 0; i < inLounge.length; i++) {
    for (let j = i + 1; j < inLounge.length; j++) {
      if (Math.random() > 0.55) continue; // 不是每小時都會互動
      const A = inLounge[i];
      const B = inLounge[j];
      if (skip.has(pairKey(A.tenant.id, B.tenant.id))) continue;
      // 冷戰中 → 互相當作看不見,不相遇(§10-2)
      if (feudActive(A.tenant.id, B.tenant.id)) continue;
      // 積怨已深 + 雙方都緊繃 → 可能直接打起來(打鬥雲 + 家具損壞 + 房東抉擇)
      if (conflictsToday < 2 && tryFight(A, B)) {
        conflictsToday += 1;
        state.interactionCooldowns[conflictCountKey] = conflictsToday;
        continue;
      }
      const res = encounter(A.tenant, B.tenant, {
        gameMs: state.gameMs,
        allowConflict: conflictsToday < 2,
        noiseMitigation: noiseConflictMitigation(A.tenant, B.tenant),
        getTenant: (id) => state.runtimes[id]?.tenant,
      });
      if (res.naturalConflict) {
        conflictsToday += 1;
        state.interactionCooldowns[conflictCountKey] = conflictsToday;
      }
      pushSocialLog(A, res.textA, res.importance);
      pushSocialLog(B, res.textB, res.importance);
      applySocialEffect(A, res.effectA);
      applySocialEffect(B, res.effectB);
      // 演出層:在兩人所在的交誼廳位置掛特效(里程碑優先,其次依互動基調),並讓兩人走到一起演(§10-6)
      const at = A.targetTile ?? B.targetTile;
      if (at) {
        // 里程碑/衝突是「一瞬間」的演出 → 短;聊天泡泡是「進行中」→ 持續到下一個動作
        // G-2:「在一起了」不再只是一行通知 —— 掛 confess 姿勢 + 彩紙,玩家真的看到告白那一幕。
        // 「在一起」本身仍由 `encounter()` 判定(social.ts),這裡只換演出:零 RNG、零關係邏輯改動。
        if (res.milestone === "became_couple") spawnFx("confetti", at.c, at.r, 15000);
        else if (res.milestone === "broke_up") spawnFx("heartbreak", at.c, at.r, 15000);
        else if (res.tone === "conflict") spawnFx("anger", at.c, at.r, 10000);
        else if (res.tone === "romantic") spawnFx("hearts", at.c, at.r, 10000);
        else spawnFx("chat", at.c, at.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
        // 姿勢(兩人在一起)預設持續到下一個動作(1 遊戲小時);快轉時 gameUntil 會收掉。
        // 本小時稍早打過架的人此時仍在 scuffle 演出中 ⇒ `startPairSession` 會擋掉這次覆蓋
        // (守衛在 pairSession.ts;相遇的數值後果照舊,只是不另外掛走位)。
        const milestonePose: PairPose =
          res.milestone === "became_couple" ? "confess"
            : res.milestone === "broke_up" ? "apart"
              : "stand_face";
        startPairSession(A.tenant.id, B.tenant.id, at, milestonePose, state.gameMs);
      }
      // 每日上限只管自然口角／打架；分手、群體事件等劇情衝突不占額度，也不由此升級冷戰。
      if (res.naturalConflict) maybeFeudAfterConflict(A, B);
      if (res.milestone === "became_couple") {
        notify(`${A.tenant.name} 和 ${B.tenant.name} 在一起了 ❤️`);
        unlock("first_love");
        // 三角關係:曾同時對 A 或 B 抱有曖昧的落選者,在這一刻反應一次(§吃醋批,不做持續性掃描)。
        for (const rivalId of res.rivals ?? []) {
          const rival = state.runtimes[rivalId];
          if (!rival || rival.pendingEvent || rival.tenant.visualState === "away") continue;
          const rs = rival.tenant.stats;
          rs.stress = clamp(rs.stress + 4, 0, 100);
          rs.mood = clamp(rs.mood - 3, 0, 100);
          pushMemory(rival.tenant, "[暗戀落空]", `眼睜睜看著${B.tenant.name}和${A.tenant.name}在一起了,只能把這份心意收起來。`, "ai_event");
          pushSocialLog(rival, `💔 眼睜睜看著 ${B.tenant.name}和${A.tenant.name}在一起了，只能把這份心意收起來`, "notable");
          if (rival.targetTile) spawnFx("heartbreak", rival.targetTile.c, rival.targetTile.r, 15000);
        }
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
  // 即使沒有任何整小時需要補，也要修正已經卡在 0 天的房客。
  // initGame、每 5 秒前景同步與分頁 resume 都會經過這裡。
  reconcileDueSettleDepartures();
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

/**
 * 讀檔後立即補做已到期的安居離場；刻意不呼叫完整 wishPass，
 * 避免重載頁面時額外推進其他心願或重複套用每日模範光環。
 */
export function reconcileDueSettleDepartures(): number {
  const repaired = ensureWishes();
  const due = settleDeparturesDue();
  for (const departure of due) graduateFarewell(departure.id, departure.reason);
  // 到期者的 moveOut 會自行存檔；只有修復了尚未到期的歷史狀態時需在此立即回存。
  if (repaired && due.length === 0) save();
  return due.length;
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
