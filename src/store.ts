/**
 * 遊戲狀態管理 —— 異步掛機觀察模式。
 *
 * - 遊戲時間跟現實掛鉤(8×:現實 1 天 = 遊戲 8 天),關掉再開自動補進度。
 * - 每遊戲小時:每租客依「作息 + 偏離」上狀態,由 generateHourly 產生日誌。
 * - 未讀模型:每租客記 lastSeenMs;進房 markSeen。
 * - localStorage 存檔。
 */
import { computed, reactive } from "vue";
import type { RoomPropState, StatDeltas, Tenant, TenantVisualState } from "./types";
import tenantsJson from "../data/tenants.json";
import {
  MAX_CATCHUP_HOURS,
  MS_PER_GAME_HOUR,
  currentGameMs,
} from "./sim/clock";
import { routineSlot, resolveTarget, registerRoutine, routineRoles, type Role } from "./sim/routine";
import { rollEvent, sanitizeAiEvent, type EventDef, type EventEffect } from "./sim/events";
import {
  encounter,
  removeTenantRelations,
  getRel,
  listRelationships,
  serializeRelationships,
  loadRelationships,
  adjustRelationship,
  setCouple,
  canRomance,
  type SocialEffect,
} from "./sim/social";
import { narrateDay, templateDiary, type NarrateCtx } from "./sim/narrate";
import { generateHourly } from "./sim/generate";
import { TENANT_SPOTS } from "./floor/map";
import { addPlacement, removePlacementAt, findFreeSlot, canPlaceFree, roomRect, placements } from "./sim/placements";
import { getDef } from "./furniture/catalog";
import type { Applicant } from "./sim/recruit";
import type { Tile } from "./floor/pathfind";

const SAVE_KEY = "rent_house_save_v1";
const GAME_START = new Date("2026-07-05T22:00:00+08:00");
const LOG_CAP = 60;
const LEDGER_CAP = 60;

// 每日管理費(讓「支出」有意義;小額、可調)
const BASE_UPKEEP = 300;
const PER_ROOM_UPKEEP = 150;

export type TxnCategory = "rent" | "furniture" | "event" | "upkeep" | "other";
export interface Txn {
  gameMs: number;
  label: string;
  amount: number; // 正=收入、負=支出(記錄實際變動)
  category: TxnCategory;
}

export interface LogEntry {
  gameMs: number;
  timeLabel: string; // "7/5 02:00"
  text: string;
  visualState: TenantVisualState;
  importance: "minor" | "notable" | "major";
  decisionNote?: string;
  /** 這筆是否為每日 AI 敘事(前端用來加特殊樣式) */
  ai?: boolean;
}

export interface TenantRuntime {
  tenant: Tenant;
  roomNo: string;
  cleanliness: number;
  roomProps: RoomPropState[];
  log: LogEntry[];
  lastSeenMs: number;
  pendingEvent: EventDef | null;
  decisions: string[];
  /** 當前活動的目標家具互動格(給 agent 走過去);null=外出/原地 */
  targetTile: Tile | null;
  /** 動態入住租客的作息原型(存檔重載時重新登記作息用) */
  archetypeKey?: string;
  /** 張力系統:滿意度、不滿累積時數、上次事件的遊戲日 */
  satisfaction: number;
  unhappyHours: number;
  lastEventDay: number;
  /** 本小時是否在交誼廳(社交相遇判定用,不需存檔) */
  inLounge: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampDelta = (d: number | undefined) => clamp(d ?? 0, -20, 20);
const tenants = tenantsJson as unknown as Tenant[];

function makeRuntime(t: Tenant, roomNo: string, cleanliness: number, props: RoomPropState[]): TenantRuntime {
  return reactive({
    tenant: JSON.parse(JSON.stringify(t)) as Tenant, // 深拷貝,避免改到 import 的原始資料
    roomNo,
    cleanliness,
    roomProps: props,
    log: [] as LogEntry[],
    lastSeenMs: GAME_START.getTime(),
    pendingEvent: null as EventDef | null,
    decisions: [] as string[],
    targetTile: null as Tile | null,
    satisfaction: 62,
    unhappyHours: 0,
    lastEventDay: -99,
    inLounge: false,
  });
}

export const state = reactive({
  realAnchorMs: Date.now(),
  gameAnchorMs: GAME_START.getTime(),
  gameMs: GAME_START.getTime(),
  money: 52000,
  activeId: "tenant_chen_engineer",
  /** 系統通知(退租等),App 監看後彈 toast */
  notice: "",
  /** 待決的同居抉擇(情侶關係極高時觸發) */
  pendingCohabit: null as { aId: string; bId: string; aName: string; bName: string } | null,
  /** 擺放模式:玩家點了「買」後,待放置的家具 defId(點地圖選位置) */
  pendingPlace: null as string | null,
  /** 收支帳:每筆金錢進出(綠進紅出),供財務面板檢視 */
  ledger: [] as Txn[],
  /** 房間 → 租客 id(動態,招租入住會新增) */
  occupancy: {
    r301: "tenant_chen_engineer",
    r302: "tenant_lin_asmr",
  } as Record<string, string>,
  runtimes: {
    tenant_chen_engineer: makeRuntime(tenants[0], "301", 35, []),
    tenant_lin_asmr: makeRuntime(tenants[1], "302", 92, []),
  } as Record<string, TenantRuntime>,
});

export function isVacant(roomId: string): boolean {
  return !state.occupancy[roomId];
}

/** 唯一的金錢異動入口:改餘額(下限 0)+ 記一筆帳(記錄實際變動) */
function addMoney(amount: number, label: string, category: TxnCategory) {
  const before = state.money;
  state.money = Math.max(0, state.money + amount);
  const actual = state.money - before;
  if (actual === 0) return;
  state.ledger.push({ gameMs: state.gameMs, label, amount: actual, category });
  if (state.ledger.length > LEDGER_CAP) state.ledger.splice(0, state.ledger.length - LEDGER_CAP);
}

export const activeRuntime = computed(() => state.runtimes[state.activeId]);
export const hasAnyPending = computed(() =>
  Object.values(state.runtimes).some((r) => r.pendingEvent !== null),
);

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export const clockLabel = computed(() => fmt(state.gameMs));

/** 某租客未讀日誌數(晚於 lastSeenMs) */
export function unreadCount(tenantId: string): number {
  const rt = state.runtimes[tenantId];
  if (!rt) return 0;
  return rt.log.filter((e) => e.gameMs > rt.lastSeenMs).length;
}

/** 進房查看:標記已讀 */
export function markSeen(tenantId: string) {
  const rt = state.runtimes[tenantId];
  if (rt) {
    rt.lastSeenMs = state.gameMs;
    save();
  }
}

// ---------------------------------------------------------------------------
// 每小時模擬
// ---------------------------------------------------------------------------

const homeTile = (tenantId: string): Tile => {
  const s = TENANT_SPOTS.find((x) => x.tenantId === tenantId);
  if (s) return { c: s.c, r: s.r };
  const roomId = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId)?.[0];
  const rect = roomId ? roomRect(roomId) : null;
  if (rect) return { c: Math.floor((rect.c0 + rect.c1) / 2), r: Math.floor((rect.r0 + rect.r1) / 2) };
  return { c: 7, r: 10 };
};

/** 作息 + 偏離 → 最終 { state, role, isDeviation } */
function decideState(rt: TenantRuntime, hour: number): { state: TenantVisualState; role: Role; isDeviation: boolean } {
  const slot = routineSlot(rt.tenant.id, hour);
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
function deriveProps(tenantId: string, st: TenantVisualState, hour: number): RoomPropState[] {
  const props: RoomPropState[] = [];
  if (["working_at_desk", "gaming", "streaming"].includes(st)) props.push("screen_glow");
  if (st === "streaming") props.push("mic_setup_active");
  if (st === "sleeping_on_bed" && (hour < 6 || hour >= 22)) props.push("lights_off");
  if (tenantId === "tenant_lin_asmr") props.push("curtains_closed");
  if (tenantId === "tenant_chen_engineer" && st === "playing_with_cat") props.push("cat_on_table");
  return props;
}

function applyStat(rt: TenantRuntime, d: StatDeltas) {
  const s = rt.tenant.stats;
  s.mood = clamp(s.mood + clampDelta(d.mood), 0, 100);
  s.stress = clamp(s.stress + clampDelta(d.stress), 0, 100);
  s.affinity = clamp(s.affinity + clampDelta(d.affinity), 0, 100);
  rt.cleanliness = clamp(rt.cleanliness + clampDelta(d.cleanliness), 0, 100);
}

/** 單調遞增的遊戲日序號 */
const gameDayIndex = () => Math.floor((state.gameMs - GAME_START.getTime()) / (24 * 3600 * 1000));

/** 房間滿足租客需求的比例(作息要用的家具角色有幾成能在自房/共用區找到)*/
function needsMet(tenantId: string, roomId: string | null): number {
  const roles = routineRoles(tenantId);
  if (roles.length === 0) return 1;
  let served = 0;
  for (const role of roles) if (resolveTarget(role, roomId)) served++;
  return served / roles.length;
}

/** 更新滿意度:由心情/好感/壓力 + 房間是否滿足需求,緩慢趨近目標 */
function updateSatisfaction(rt: TenantRuntime, roomId: string | null) {
  const s = rt.tenant.stats;
  const nm = needsMet(rt.tenant.id, roomId);
  const base = clamp(0.3 * s.mood + 0.4 * s.affinity + 0.3 * (100 - s.stress), 0, 100);
  const target = base * (0.55 + 0.45 * nm);
  rt.satisfaction = clamp(rt.satisfaction + (target - rt.satisfaction) * 0.2, 0, 100);
}

/** 幫一位租客套用某小時的活動(addLog=false 用於初始定位,不寫日誌) */
function applyHour(rt: TenantRuntime, hour: number, addLog: boolean) {
  const decided = decideState(rt, hour);
  let st = decided.state;
  const isDeviation = decided.isDeviation;

  // 目標家具格
  const roomId = Object.entries(state.occupancy).find(([, tid]) => tid === rt.tenant.id)?.[0] ?? null;
  rt.inLounge = false;
  if (st === "away") {
    rt.targetTile = null;
  } else if (isDeviation) {
    rt.targetTile = homeTile(rt.tenant.id);
  } else {
    const tgt = resolveTarget(decided.role, roomId);
    if (tgt) {
      rt.targetTile = tgt.tile;
      rt.inLounge = tgt.placement.room === "lounge"; // 在共用交誼廳 → 可能與鄰居相遇
    } else {
      // 房裡缺對應家具、共用區也沒有 → 在自己房間發呆(不闖別人房)
      st = "idle";
      rt.targetTile = homeTile(rt.tenant.id);
    }
  }
  rt.tenant.visualState = st;
  rt.roomProps = deriveProps(rt.tenant.id, st, hour);

  if (!addLog) return;
  const roomId2 = Object.entries(state.occupancy).find(([, tid]) => tid === rt.tenant.id)?.[0] ?? null;
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
  updateSatisfaction(rt, roomId2);
  rt.log.push({
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    text: gen.logText,
    visualState: st,
    importance: gen.importance,
  });
  if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
}

/** 每日收租(遊戲日換日時觸發):日租 = 月租/30,依付租能力與好感調整 */
function collectRent() {
  for (const rt of Object.values(state.runtimes)) {
    const f = rt.tenant.finance;
    const daily = Math.round(f.monthlyRent / 30);
    const factor =
      clamp(f.paymentReliability + (rt.tenant.stats.affinity - 50) * 0.3 + (rt.satisfaction - 50) * 0.2, 0, 100) / 100;
    const paid = Math.round(daily * factor);
    addMoney(paid, `${rt.tenant.name} 房租`, "rent");
    const full = paid >= daily * 0.95;
    rt.log.push({
      gameMs: state.gameMs,
      timeLabel: fmt(state.gameMs),
      text: full ? `準時繳清今日房租 $${paid}。` : `今日只繳了部分房租 $${paid},其餘拖欠。`,
      visualState: rt.tenant.visualState,
      importance: paid < daily * 0.6 ? "notable" : "minor",
    });
    if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
  }
  // 每日管理費(水電/清潔/公共維護)
  const upkeep = BASE_UPKEEP + Object.keys(state.occupancy).length * PER_ROOM_UPKEEP;
  addMoney(-upkeep, "管理費 / 水電", "upkeep");
}

/** 推進一個遊戲小時(live=true 才在換日時打 AI;補進度/快轉用模板避免大量 API 呼叫) */
function hourlyTick(live = false) {
  const prevDay = new Date(state.gameMs).getDate();
  state.gameMs += MS_PER_GAME_HOUR;
  const d = new Date(state.gameMs);
  const hour = d.getHours();
  const day = gameDayIndex();
  const moveOuts: string[] = [];

  for (const rt of Object.values(state.runtimes)) {
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
      });
      if (ev) {
        rt.pendingEvent = ev;
        rt.lastEventDay = day;
      }
    }

    // 長期不滿(約 2.5 遊戲日)→ 退租
    if (rt.unhappyHours >= 60 && !rt.pendingEvent) moveOuts.push(rt.tenant.id);
  }

  for (const id of moveOuts) moveOut(id, "對居住品質長期不滿");

  socialPass(); // 鄰居在交誼廳相遇 → 聊天/衝突/戀愛
  if (d.getDate() !== prevDay) {
    collectRent();
    void produceDailyDiaries(live); // 換日 → 每位租客一篇當日 AI 日記(fire-and-forget)
  }
}

/** 換日時,為每位租客產生一篇「當日日記」(live 才呼叫 AI,否則模板) */
async function produceDailyDiaries(live: boolean) {
  const dayLabel = `第 ${gameDayIndex() + 1} 天`;
  const ids = Object.keys(state.runtimes);
  for (const id of ids) {
    const rt = state.runtimes[id];
    if (!rt) continue;
    const ctx = buildNarrateCtx(rt, dayLabel);
    const result = live ? await narrateDay(ctx) : { diary: templateDiary(ctx), newMemory: null, ai: false };
    const cur = state.runtimes[id];
    if (!cur) continue; // 期間可能已退租
    cur.log.push({
      gameMs: state.gameMs,
      timeLabel: fmt(state.gameMs),
      text: result.diary,
      visualState: cur.tenant.visualState,
      importance: "major",
      ai: result.ai,
    });
    if (cur.log.length > LOG_CAP) cur.log.splice(0, cur.log.length - LOG_CAP);
    if (result.newMemory) {
      cur.tenant.memoryTags.push({
        id: `ai_${Date.now()}`,
        label: result.newMemory.label,
        behaviorHint: result.newMemory.hint,
        acquiredAt: new Date(state.gameMs).toISOString(),
        source: "ai_event",
      });
    }
    // AI 依當前處境提議的抉擇事件 → 消毒夾值後設為待決(與規則式事件共用冷卻,不覆蓋既有)
    if (result.event && !cur.pendingEvent && gameDayIndex() - cur.lastEventDay >= 2) {
      const roster: Record<string, string> = {};
      for (const o of Object.values(state.runtimes)) if (o.tenant.id !== cur.tenant.id) roster[o.tenant.name] = o.tenant.id;
      const ev = sanitizeAiEvent(result.event, roster);
      if (ev) {
        cur.pendingEvent = ev;
        cur.lastEventDay = gameDayIndex();
      }
    }
    save();
  }
}

/** 從 runtime 組出當天的敘事 context */
function buildNarrateCtx(rt: TenantRuntime, dayLabel: string): NarrateCtx {
  const dayAgo = state.gameMs - 24 * 3600 * 1000;
  const today = rt.log.filter((e) => e.gameMs >= dayAgo);
  const todayLog = today.map((e) => e.text).filter((t) => t && t.length > 0).slice(-12);
  const events = today.map((e) => e.decisionNote).filter((t): t is string => !!t);
  const id = rt.tenant.id;
  const relationships = listRelationships()
    .filter((r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId])
    .map((r) => {
      const otherId = r.aId === id ? r.bId : r.aId;
      return `與 ${state.runtimes[otherId].tenant.name} ${r.label}`;
    });
  const neighbors = Object.values(state.runtimes)
    .filter((o) => o.tenant.id !== id)
    .map((o) => o.tenant.name);
  return {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    bio: rt.tenant.bio,
    dayLabel,
    coreTags: rt.tenant.coreTags.map((t) => t.label),
    memoryTags: rt.tenant.memoryTags.map((t) => t.label),
    stats: { mood: rt.tenant.stats.mood, stress: rt.tenant.stats.stress, affinity: rt.tenant.stats.affinity, satisfaction: Math.round(rt.satisfaction) },
    todayLog,
    relationships,
    events,
    neighbors,
  };
}

function applySocialEffect(rt: TenantRuntime, eff?: SocialEffect) {
  if (!eff) return;
  const s = rt.tenant.stats;
  if (eff.mood) s.mood = clamp(s.mood + eff.mood, 0, 100);
  if (eff.stress) s.stress = clamp(s.stress + eff.stress, 0, 100);
  if (eff.satisfaction) rt.satisfaction = clamp(rt.satisfaction + eff.satisfaction, 0, 100);
}

/** 鄰居社交:找出同在交誼廳的租客,兩兩相遇互動 */
function socialPass() {
  const inLounge = Object.values(state.runtimes).filter((rt) => rt.inLounge && !rt.pendingEvent);
  for (let i = 0; i < inLounge.length; i++) {
    for (let j = i + 1; j < inLounge.length; j++) {
      if (Math.random() > 0.55) continue; // 不是每小時都會互動
      const A = inLounge[i];
      const B = inLounge[j];
      const res = encounter(A.tenant, B.tenant);
      pushSocialLog(A, res.textA, res.importance);
      pushSocialLog(B, res.textB, res.importance);
      applySocialEffect(A, res.effectA);
      applySocialEffect(B, res.effectB);
      if (res.milestone === "became_couple") state.notice = `${A.tenant.name} 和 ${B.tenant.name} 在一起了 ❤️`;
      if (res.milestone === "broke_up") state.notice = `${A.tenant.name} 和 ${B.tenant.name} 分手了 💔`;
      if (res.cohabit && !state.pendingCohabit) {
        state.pendingCohabit = { aId: A.tenant.id, bId: B.tenant.id, aName: A.tenant.name, bName: B.tenant.name };
      }
    }
  }
}

function pushSocialLog(rt: TenantRuntime, text: string, importance: "minor" | "notable" | "major") {
  rt.log.push({ gameMs: state.gameMs, timeLabel: fmt(state.gameMs), text, visualState: rt.tenant.visualState, importance });
  if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
}

/** 租客退租搬走:清空房間佔用、移除 runtime */
function moveOut(tenantId: string, reason: string) {
  const rt = state.runtimes[tenantId];
  if (!rt) return;
  const name = rt.tenant.name;
  const entry = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId);
  if (entry) delete state.occupancy[entry[0]];
  delete state.runtimes[tenantId];
  removeTenantRelations(tenantId);
  if (state.pendingCohabit && (state.pendingCohabit.aId === tenantId || state.pendingCohabit.bId === tenantId)) {
    state.pendingCohabit = null;
  }
  if (state.activeId === tenantId) state.activeId = Object.keys(state.runtimes)[0] ?? "";
  state.notice = `${name} 退租搬走了(${reason})`;
  save();
}

/** 同居抉擇:同意 → 一人搬去和對方擠(空出一間房、少一份租、兩人大加成) */
export function resolveCohabit(accept: boolean) {
  const pc = state.pendingCohabit;
  if (!pc) return;
  state.pendingCohabit = null;
  const a = state.runtimes[pc.aId];
  const b = state.runtimes[pc.bId];
  if (!a || !b) return;
  if (accept) {
    // b 搬進 a 的房間(b 的房空出可再招租),a 得到同居加成
    a.satisfaction = clamp(a.satisfaction + 15, 0, 100);
    a.tenant.stats.mood = clamp(a.tenant.stats.mood + 15, 0, 100);
    a.unhappyHours = 0;
    pushSocialLog(a, `❤️ ${pc.bName} 搬進來一起住了`, "major");
    moveOut(pc.bId, `搬去和 ${pc.aName} 同居`);
    state.notice = `${pc.bName} 搬去和 ${pc.aName} 同居了 ❤️(${pc.bName} 原本的房間空出來了)`;
  } else {
    // 不同意 → 兩人失望,關係回落
    const rel = getRel(pc.aId, pc.bId);
    if (rel) rel.value = clamp(rel.value - 15, 0, 100);
    applySocialEffect(a, { satisfaction: -8, mood: -6 });
    applySocialEffect(b, { satisfaction: -8, mood: -6 });
    state.notice = `你婉拒了 ${pc.aName} 和 ${pc.bName} 的同居請求。`;
  }
  save();
}

/** 對齊到現在(補進度)。回傳實際補了幾小時 */
function syncToNow(): number {
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

/** 除錯:一鍵快轉 N 遊戲小時(手動快轉視為 live,跨過午夜會觸發 AI 日記) */
export function fastForward(hours = 6) {
  for (let i = 0; i < hours; i++) hourlyTick(true);
  // 重錨,讓掛機時鐘從現在繼續
  state.realAnchorMs = Date.now();
  state.gameAnchorMs = state.gameMs;
  save();
}

/** 招租入住:把一位應徵者變成正式租客 */
export function moveIn(roomId: string, ap: Applicant) {
  if (!isVacant(roomId)) return;
  const roomNo = roomId.replace(/^r/, "");
  const tenant: Tenant = {
    id: ap.id,
    name: ap.name,
    occupation: ap.occupation,
    bio: ap.bio,
    gender: ap.gender,
    attractedTo: ap.attractedTo,
    coreTags: ap.coreTags,
    memoryTags: [],
    finance: { monthlyRent: ap.monthlyRent, paymentReliability: 80, monthsOverdue: 0 },
    stats: { mood: 72, stress: 28, hygiene: 70, affinity: 55 },
    preferences: ap.preferences,
    visualState: "idle",
    recentSummary: `${ap.name} 剛搬進 ${roomNo} 房。${ap.bio}`,
  };
  const rt = makeRuntime(tenant, roomNo, 70, []);
  rt.archetypeKey = ap.archetypeKey;
  state.runtimes[ap.id] = rt;
  state.occupancy[roomId] = ap.id;
  registerRoutine(ap.id, ap.archetypeKey);
  applyHour(rt, new Date(state.gameMs).getHours(), false); // 定位到當前活動
  save();
}

/** 購買並擺放一件家具到指定房間 */
export function buyFurniture(defId: string, roomId: string): { ok: boolean; reason?: string } {
  const def = getDef(defId);
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  const slot = findFreeSlot(roomId, def.footprint.w, def.footprint.h);
  if (!slot) return { ok: false, reason: "房間沒有空位" };
  addPlacement({ defId, room: roomId, c: slot.c, r: slot.r });
  addMoney(-def.price, `購買 ${def.name}`, "furniture");
  save();
  return { ok: true };
}

/** 進入擺放模式:選好家具、待點地圖決定位置(此時尚未扣款) */
export function startPlacing(defId: string): { ok: boolean; reason?: string } {
  if (state.money < getDef(defId).price) return { ok: false, reason: "金錢不足" };
  state.pendingPlace = defId;
  return { ok: true };
}

export function cancelPlacing() {
  state.pendingPlace = null;
}

/** 在指定格擺放待放置的家具(扣款) */
export function placeAt(c: number, r: number): { ok: boolean; reason?: string } {
  const defId = state.pendingPlace;
  if (!defId) return { ok: false, reason: "沒有待擺放的家具" };
  const def = getDef(defId);
  if (state.money < def.price) return { ok: false, reason: "金錢不足" };
  const room = canPlaceFree(c, r, def.footprint.w, def.footprint.h);
  if (!room) return { ok: false, reason: "這裡放不下(壓到牆/家具或跨房間)" };
  addPlacement({ defId, room, c, r });
  addMoney(-def.price, `擺放 ${def.name}`, "furniture");
  state.pendingPlace = null;
  save();
  return { ok: true };
}

/** 賣掉某格上的家具(退回半價) */
export function sellFurnitureAt(c: number, r: number): { ok: boolean; refund?: number } {
  const removed = removePlacementAt(c, r);
  if (!removed) return { ok: false };
  const def = getDef(removed.defId);
  const refund = Math.round(def.price * 0.5);
  addMoney(refund, `賣出 ${def.name}`, "furniture");
  save();
  return { ok: true, refund };
}

function applyEffect(rt: TenantRuntime, eff: EventEffect) {
  if (eff.money) addMoney(eff.money, `事件:${rt.tenant.name}`, "event");
  const s = rt.tenant.stats;
  if (eff.mood) s.mood = clamp(s.mood + eff.mood, 0, 100);
  if (eff.stress) s.stress = clamp(s.stress + eff.stress, 0, 100);
  if (eff.affinity) s.affinity = clamp(s.affinity + eff.affinity, 0, 100);
  if (eff.satisfaction) rt.satisfaction = clamp(rt.satisfaction + eff.satisfaction, 0, 100);
  if (eff.satisfaction && eff.satisfaction > 0) rt.unhappyHours = 0; // 有改善就重置退租倒數
  if (eff.memory) {
    rt.tenant.memoryTags.push({
      id: `ai_${Date.now()}`,
      label: eff.memory.label,
      behaviorHint: eff.memory.hint,
      acquiredAt: new Date(state.gameMs).toISOString(),
      source: "landlord_decision",
    });
  }
}

/** 套用 AI 跨租客事件對「第二位鄰居」與兩人關係的影響(夾值 + 取向把關) */
function applyCrossTenant(aId: string, bId: string, eff: EventEffect) {
  const b = state.runtimes[bId];
  if (!b) return;
  if (eff.other) {
    const bs = b.tenant.stats;
    if (eff.other.mood) bs.mood = clamp(bs.mood + eff.other.mood, 0, 100);
    if (eff.other.stress) bs.stress = clamp(bs.stress + eff.other.stress, 0, 100);
    if (eff.other.affinity) bs.affinity = clamp(bs.affinity + eff.other.affinity, 0, 100);
    if (eff.other.satisfaction) b.satisfaction = clamp(b.satisfaction + eff.other.satisfaction, 0, 100);
  }
  if (eff.rel) {
    if (typeof eff.rel.delta === "number" && eff.rel.delta) adjustRelationship(aId, bId, eff.rel.delta);
    const a = state.runtimes[aId];
    if (eff.rel.breakup) setCouple(aId, bId, false);
    else if (eff.rel.couple && a && canRomance(a.tenant, b.tenant)) setCouple(aId, bId, true, a.tenant, b.tenant);
  }
}

/** 玩家做出房東抉擇 → 套用該選項的後果 */
export function decide(tenantId: string, choiceId: string, choiceLabel: string) {
  const rt = state.runtimes[tenantId];
  if (!rt?.pendingEvent) return;
  const title = rt.pendingEvent.title;
  const withId = rt.pendingEvent.withId;
  const choice = rt.pendingEvent.choices.find((c) => c.id === choiceId);
  rt.decisions.push(choiceId);
  rt.pendingEvent = null;
  rt.log.push({
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    text: "",
    visualState: rt.tenant.visualState,
    importance: "major",
    decisionNote: `【${title}】你的決定:${choiceLabel}`,
  });
  if (choice) {
    applyEffect(rt, choice.effect);
    if (withId) applyCrossTenant(tenantId, withId, choice.effect);
    if (choice.effect.evict) moveOut(tenantId, "你請他搬走了");
  }
  save();
}

// ---------------------------------------------------------------------------
// 存檔 / 載入 / 啟動
// ---------------------------------------------------------------------------

function save() {
  try {
    const runtimes: Record<string, unknown> = {};
    for (const [id, rt] of Object.entries(state.runtimes)) {
      runtimes[id] = {
        tenant: rt.tenant, // 存完整租客(動態入住者沒有原始種子可依)
        roomNo: rt.roomNo,
        cleanliness: rt.cleanliness,
        roomProps: rt.roomProps,
        log: rt.log,
        lastSeenMs: rt.lastSeenMs,
        pendingEvent: rt.pendingEvent,
        decisions: rt.decisions,
        targetTile: rt.targetTile,
        archetypeKey: rt.archetypeKey,
        satisfaction: rt.satisfaction,
        unhappyHours: rt.unhappyHours,
        lastEventDay: rt.lastEventDay,
      };
    }
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: 2,
        realAnchorMs: state.realAnchorMs,
        gameAnchorMs: state.gameAnchorMs,
        gameMs: state.gameMs,
        money: state.money,
        occupancy: state.occupancy,
        placements: placements.list,
        relationships: serializeRelationships(),
        ledger: state.ledger,
        runtimes,
      }),
    );
  } catch {
    /* localStorage 不可用時忽略 */
  }
}

function load(): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (s.v !== 2) return false;
    state.realAnchorMs = s.realAnchorMs;
    state.gameAnchorMs = s.gameAnchorMs;
    state.gameMs = s.gameMs;
    state.money = s.money;

    // 家具擺放
    placements.list.splice(0, placements.list.length, ...s.placements.map((p: unknown) => ({ ...(p as object) })));
    placements.version++;

    // 房間佔用
    for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
    Object.assign(state.occupancy, s.occupancy);

    // 鄰居關係
    loadRelationships(s.relationships ?? []);

    // 收支帳
    state.ledger.splice(0, state.ledger.length, ...((s.ledger ?? []) as Txn[]));

    // 重建所有租客 runtime(含動態入住者)
    for (const k of Object.keys(state.runtimes)) delete state.runtimes[k];
    for (const [id, saved] of Object.entries<any>(s.runtimes)) {
      state.runtimes[id] = reactive({
        tenant: saved.tenant as Tenant,
        roomNo: saved.roomNo,
        cleanliness: saved.cleanliness,
        roomProps: saved.roomProps,
        log: saved.log,
        lastSeenMs: saved.lastSeenMs,
        pendingEvent: saved.pendingEvent,
        decisions: saved.decisions,
        targetTile: saved.targetTile,
        archetypeKey: saved.archetypeKey,
        satisfaction: saved.satisfaction ?? 62,
        unhappyHours: saved.unhappyHours ?? 0,
        lastEventDay: saved.lastEventDay ?? -99,
        inLounge: false,
      });
      if (saved.archetypeKey) registerRoutine(id, saved.archetypeKey);
    }
    // 舊存檔的種子租客沒有性別/取向 → 從種子資料補回
    for (const rt of Object.values(state.runtimes)) {
      if (!rt.tenant.gender) {
        const seed = tenants.find((t) => t.id === rt.tenant.id);
        if (seed?.gender) {
          rt.tenant.gender = seed.gender;
          rt.tenant.attractedTo = seed.attractedTo;
        }
      }
    }
    if (!state.runtimes[state.activeId]) state.activeId = Object.keys(state.runtimes)[0];
    return true;
  } catch {
    return false;
  }
}

let timer: number | undefined;

/** App 掛載時呼叫:載入 → 補進度 → 啟動掛機計時器 */
export function initGame() {
  const loaded = load();
  if (!loaded) {
    // 全新遊戲:先幫每位租客定位到開場時刻的活動(不寫日誌)
    const hour = new Date(state.gameMs).getHours();
    for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
    save();
  }
  syncToNow();
  // 用最新的可站立點邏輯重新定位當前活動(修正舊存檔可能殘留的牆上目標)
  const hour = new Date(state.gameMs).getHours();
  for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
  if (timer) clearInterval(timer);
  // 每 5 秒檢查是否跨過遊戲小時(前景掛機)
  if (typeof window !== "undefined") timer = window.setInterval(syncToNow, 5000);
}

// --- 測試/自我檢測用鉤子(headless 模擬追蹤器呼叫)---
/** 定位到目前時刻的活動(不寫日誌) */
export function debugInit() {
  const hour = new Date(state.gameMs).getHours();
  for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
}
/** 手動推進一個遊戲小時(不重錨、不存檔) */
export function debugStepHour() {
  hourlyTick();
}
/** 目前遊戲時間標籤 */
export function debugClock() {
  return fmt(state.gameMs);
}

export function stopGame() {
  if (timer) clearInterval(timer);
}

/** 分頁重新可見時:只補進度,不重載(避免蓋掉記憶體中的最新狀態) */
export function resume() {
  syncToNow();
}
