/**
 * 每小時模擬(store 拆分:tick 模組)。
 * 作息+偏離 → 定位/日誌/數值、張力事件、交誼廳社交、換日(收租+AI 日記),
 * 以及補進度(syncToNow)與快轉(同步版給測試、分批版給 UI)。
 */
import type { StatDeltas, TenantVisualState, RoomPropState } from "../types";
import { MAX_CATCHUP_HOURS, MS_PER_GAME_HOUR, currentGameMs } from "./clock";
import { routineSlot, resolveTarget, routineRoles, type Role } from "./routine";
import { rollEvent } from "./events";
import { encounter, listRelationships, pairKey } from "./social";
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
  LOG_CAP,
  type TenantRuntime,
} from "./gameState";
import { collectRent } from "./economy";
import { maintenancePass } from "./maintenance";
import { moveOut, endCohabitOnBreakup } from "./tenancy";
import { produceDailyDiaries } from "./narration";
import { spawnFx } from "../floor/fx";
import { startPairSession } from "../floor/pairSession";
import { interactionsPass } from "./interactions";
import { save } from "./persistence";

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
function decideState(rt: TenantRuntime, hour: number): { state: TenantVisualState; role: Role; isDeviation: boolean } {
  const dir = activeDirective(rt);
  // 作息位移型指令:熬夜=整段往後 3 小時、早鳥=提前 2 小時(查表時反向偏移)
  const slotHour = dir === "night_owl" ? (hour - 3 + 24) % 24 : dir === "early_bird" ? (hour + 2) % 24 : hour;
  let slot = routineSlot(rt.tenant.id, slotHour);
  // 活動插入型指令:在特定時段覆蓋原作息(不動睡眠/外出)
  if (dir === "adopt_cat" && hour === 20 && slot.state !== "away" && slot.state !== "sleeping_on_bed") {
    slot = { role: "sofa", state: "playing_with_cat" };
  } else if (dir === "binge_watch" && (hour === 22 || hour === 23) && slot.state !== "away" && slot.state !== "sleeping_on_bed") {
    slot = { role: "tv", state: "watching_tv" };
  }
  const stress = rt.tenant.stats.stress;
  // 壓力偏離:睡不著 / 崩潰
  if (stress >= 95 && slot.state !== "away") {
    return { state: "crying", role: "bed", isDeviation: true };
  }
  if (stress >= 90 && slot.state === "sleeping_on_bed") {
    return { state: "pacing", role: "bed", isDeviation: true };
  }
  return { state: slot.state, role: slot.role, isDeviation: false };
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

/** 幫一位租客套用某小時的活動(addLog=false 用於初始定位,不寫日誌) */
export function applyHour(rt: TenantRuntime, hour: number, addLog: boolean) {
  const decided = decideState(rt, hour);
  let st = decided.state;
  const isDeviation = decided.isDeviation;

  // 目標家具格(同居者用伴侶房)
  const roomId = roomOfTenant(rt.tenant.id);
  rt.inLounge = false;
  if (st === "away") {
    rt.targetTile = null;
  } else if (isDeviation) {
    rt.targetTile = homeTile(rt.tenant.id);
  } else {
    const dir = activeDirective(rt);
    let tgt = resolveTarget(decided.role, roomId);
    // 指令 social:傍晚主動泡交誼廳——把自房的休閒活動改成去交誼廳看電視
    if (dir === "social" && hour >= 19 && hour <= 21 && ["idle", "reading", "watching_tv", "gaming"].includes(st)) {
      const loungeTgt = resolveTarget("sofa", null) ?? resolveTarget("tv", null);
      if (loungeTgt && loungeTgt.placement.room === "lounge") {
        tgt = loungeTgt;
        st = "watching_tv";
      }
    }
    // 指令 hermit:迴避交誼廳——目標落在交誼廳就改回自己房間發呆
    if (dir === "hermit" && tgt && tgt.placement.room === "lounge") tgt = null;
    if (tgt) {
      rt.targetTile = tgt.tile;
      rt.inLounge = tgt.placement.room === "lounge"; // 在共用交誼廳 → 可能與鄰居相遇
    } else {
      // 房裡缺對應家具、共用區也沒有(或 hermit 拒去)→ 在自己房間發呆(不闖別人房)
      st = "idle";
      rt.targetTile = homeTile(rt.tenant.id);
    }
  }
  rt.tenant.visualState = st;
  rt.roomProps = deriveProps(rt, st, hour);

  if (!addLog) return;
  const gen = generateHourly({
    tenantId: rt.tenant.id,
    tenantName: rt.tenant.name,
    hour,
    timeLabel: fmt(state.gameMs),
    state: st,
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

  for (const rt of Object.values(state.runtimes)) {
    // 行為指令到期 → 恢復往常 + 留一筆日誌(在暫停檢查之前,免得掛著過期指令)
    if (rt.directive && day > rt.directive.untilDay) {
      const def = DIRECTIVES[rt.directive.id];
      rt.directive = null;
      pushSocialLog(rt, def.endText, "notable");
    }
    if (rt.pendingEvent) continue; // 有待決事件則暫停該租客,等房東抉擇
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

  const interacted = interactionsPass(); // 同房/交誼廳的目錄式互動(§10-1/10-2,canInteract 把關)
  socialPass(interacted); // 交誼廳相遇 → 聊天/衝突/戀愛(這小時已互動過的配對跳過,避免雙重)
  if (d.getDate() !== prevDay) {
    pruneStaleMemories(); // 記憶與現況矛盾 → 淡出(例:心情很好卻掛著[情緒低落])
    maintenancePass(); // 設備故障擲骰 + 未修的拖延懲罰(§7-1)
    collectRent();
    void produceDailyDiaries(live); // 換日 → 每位租客一篇當日 AI 日記(fire-and-forget)
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
      const res = encounter(A.tenant, B.tenant);
      pushSocialLog(A, res.textA, res.importance);
      pushSocialLog(B, res.textB, res.importance);
      applySocialEffect(A, res.effectA);
      applySocialEffect(B, res.effectB);
      // 演出層:在兩人所在的交誼廳位置掛特效(里程碑優先,其次依互動基調),並讓兩人走到一起演(§10-6)
      const at = A.targetTile ?? B.targetTile;
      if (at) {
        let dur = 8000;
        if (res.milestone === "became_couple") { spawnFx("hearts", at.c, at.r, 15000); dur = 15000; }
        else if (res.milestone === "broke_up") { spawnFx("heartbreak", at.c, at.r, 15000); dur = 15000; }
        else if (res.tone === "conflict") { spawnFx("anger", at.c, at.r, 10000); dur = 10000; }
        else if (res.tone === "romantic") { spawnFx("hearts", at.c, at.r, 10000); dur = 10000; }
        else spawnFx("chat", at.c, at.r, 8000);
        startPairSession(A.tenant.id, B.tenant.id, at, "pair", state.gameMs, dur);
      }
      if (res.milestone === "became_couple") notify(`${A.tenant.name} 和 ${B.tenant.name} 在一起了 ❤️`);
      if (res.milestone === "broke_up") {
        notify(`${A.tenant.name} 和 ${B.tenant.name} 分手了 💔`);
        endCohabitOnBreakup(A.tenant.id, B.tenant.id);
      }
      if (res.cohabit && !state.pendingCohabit) {
        state.pendingCohabit = { aId: A.tenant.id, bId: B.tenant.id, aName: A.tenant.name, bName: B.tenant.name };
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
