/**
 * 共用遊戲狀態核心(store 模組化拆分的地基)。
 *
 * 只放:reactive state 定義、跨模組共用的常數/型別/小工具。
 * 模擬邏輯在 tick.ts、金錢與家具在 economy.ts、租約人事在 tenancy.ts、
 * AI 敘事在 narration.ts、存檔在 persistence.ts、啟動在 lifecycle.ts;
 * 對外(元件/測試腳本)一律經 src/store.ts re-export,拆分不影響呼叫點。
 */
import { computed, reactive } from "vue";
import type { AlumniEntry, GroupEvent, Pet, RoomPropState, Tenant, TenantVisualState } from "../types";
import tenantsJson from "../../data/tenants.json";
import type { EventDef } from "./events";
import type { ActiveDirective } from "./directives";
import type { StoryArc } from "./arcs";
import type { TenantWish } from "./wishes";
import type { SocialEffect } from "./social";
import type { Applicant } from "./recruit";
import type { AiFallbackReason, AiProvider, NarrateCtx } from "./narrate";
import type { Tile } from "../floor/pathfind";
import { sanitizeGrowthTags } from "./growth";
import { setAppearance, hasFixedTheme, THEME_POOL_SIZE, setCustomAppearance } from "../pixel/scene";
import type { Appearance, HairStyle, AccessoryKind } from "../types";
import type { FurnitureRotation } from "../furniture/rotation";
import type { WeeklyReport } from "./weeklyReport";
import { save } from "./persistence";
import { weekdayShort } from "./week";

export const GAME_START = new Date("2026-07-05T22:00:00+08:00");
export const LOG_CAP = 60;
export const LEDGER_CAP = 60;
export const MEMORY_CAP = 8; // 記憶標籤上限,超過丟最舊(避免無限增長)

export type TxnCategory = "rent" | "furniture" | "upgrade" | "event" | "upkeep" | "other";
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
  /** 這筆是否為每日 AI 敘事(前端用來加 ✨AI 標示) */
  ai?: boolean;
  /** 這筆是否為「當日觀察」總結(AI 或模板都算,用來套 📖 卡片) */
  daily?: boolean;
  diaryId?: string;
  aiPending?: boolean;
  aiProvider?: AiProvider;
  aiFallbackReason?: AiFallbackReason;
}

export interface PendingDiary {
  diaryId: string;
  tenantId: string;
  gameMs: number;
  ctx: NarrateCtx;
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
  /** 日常家具姿勢與家具內錨點(不入存檔；每次 applyHour 由作息重新推導)。 */
  activityPose: "sit" | "lie" | null;
  activityTile: Tile | null;
  activityRotation: FurnitureRotation;
  activitySurface: "furniture" | "chair" | null;
  /** 動態入住租客的作息原型(存檔重載時重新登記作息用) */
  archetypeKey?: string;
  /** 張力系統:滿意度、不滿累積時數、上次事件的遊戲日 */
  satisfaction: number;
  unhappyHours: number;
  lastEventDay: number;
  /** 上次調租談判的遊戲日(冷卻用;-99 = 沒談過) */
  rentChangeDay: number;
  /** 進行中的行為指令(AI 事件選項/規則事件授予,或 AI 觀察的自發行為;到期自動恢復) */
  directive: ActiveDirective | null;
  /** 上次 AI 自發行為的遊戲日(冷卻 3 日;缺省視同 -99,見 observationEffects) */
  lastSelfBehaviorDay?: number;
  /** 租客錢包(繳租戲劇,見 economy.ts;缺省由 ensureWallets 依月租初始化) */
  wallet?: number;
  /** 積欠的房租($;錢包付不出的部分才算欠,意願性短繳不列入) */
  arrears?: number;
  /** 財務困難(收入中斷)持續到哪個遊戲日(含;-99/缺省 = 正常) */
  hardshipUntilDay?: number;
  /** 上次陷入財務困難的遊戲日(冷卻用) */
  lastHardshipDay?: number;
  /** 房東寬限欠租到哪個遊戲日(-99/缺省 = 無寬限;補清時轉感激記憶) */
  rentGraceUntilDay?: number;
  /** 上次繳租求情事件的遊戲日(冷卻用) */
  lastRentPleaDay?: number;
  /** 人生心願(長期目標;缺省由 ensureWishes 依職業指派) */
  wish?: TenantWish | null;
  /** 上次收到房東心意的遊戲日(每人每日一次;kindness.ts) */
  lastCareDay?: number;
  /** 進行中的劇情弧(0~1 條,AI 每日推進;純敘事骨架) */
  arc: StoryArc | null;
  /** 事件連鎖伏筆旗標(事件選項留下,之後餵回 AI 回收伏筆) */
  flags: string[];
  /** 本小時是否在交誼廳(社交相遇判定用,不需存檔) */
  inLounge: boolean;
  /** 本小時正在拜訪的朋友房間 id(朋友以上串門子;null=沒去別人房;不需存檔) */
  visiting: string | null;
  /** 串門子的主人 id；搭配 visiting 鎖定必須一起活動的正確兩人。 */
  visitHostId: string | null;
  /** 每日 AI 日記的專屬時段(遊戲小時 0~23;-1 = 未指派,由 ensureDiaryHours 補)。
   *  每位租客錯開在一天中不同時間生成,避免全擠在 0 點撞 AI 限流 */
  diaryHour: number;
  /** 上次生成日記的遊戲日(防同日重複) */
  lastDiaryDay: number;
  /** 入住的遊戲時間(算「住了幾天」用;種子租客 = 開場) */
  moveInMs: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampDelta = (d: number | undefined) => clamp(d ?? 0, -20, 20);
export const tenants = tenantsJson as unknown as Tenant[];

export function makeRuntime(t: Tenant, roomNo: string, cleanliness: number, props: RoomPropState[]): TenantRuntime {
  const tenant = JSON.parse(JSON.stringify(t)) as Tenant; // 深拷貝,避免改到 import 的原始資料
  tenant.growthTags = sanitizeGrowthTags(tenant.growthTags);
  return reactive({
    tenant,
    roomNo,
    cleanliness,
    roomProps: props,
    log: [] as LogEntry[],
    lastSeenMs: GAME_START.getTime(),
    pendingEvent: null as EventDef | null,
    decisions: [] as string[],
    targetTile: null as Tile | null,
    activityPose: null as "sit" | "lie" | null,
    activityTile: null as Tile | null,
    activityRotation: 0 as FurnitureRotation,
    activitySurface: null as "furniture" | "chair" | null,
    satisfaction: 62,
    unhappyHours: 0,
    lastEventDay: -99,
    rentChangeDay: -99,
    directive: null as ActiveDirective | null,
    arc: null as StoryArc | null,
    flags: [] as string[],
    inLounge: false,
    visiting: null as string | null,
    visitHostId: null as string | null,
    diaryHour: -1,
    lastDiaryDay: -99,
    moveInMs: GAME_START.getTime(),
  });
}

/** 記一個事件連鎖伏筆旗標(去重、cap 12;之後每天餵回 AI 用來回收伏筆) */
export function addFlag(rt: TenantRuntime, flag: string) {
  if (rt.flags.includes(flag)) return;
  rt.flags.push(flag);
  if (rt.flags.length > 12) rt.flags.splice(0, rt.flags.length - 12);
}

export const state = reactive({
  realAnchorMs: Date.now(),
  gameAnchorMs: GAME_START.getTime(),
  gameMs: GAME_START.getTime(),
  money: 52000,
  /** 開辦補助金是否已發放(每個存檔一次;現有存檔下次載入補發) */
  starterBonusGiven: false,
  activeId: "tenant_chen_engineer",
  /** 系統通知(退租等),App 監看後彈 toast */
  notice: "",
  /** 通知歷史(toast 會消失,這裡留存;cap 30、入存檔) */
  noticeLog: [] as { gameMs: number; text: string }[],
  /** 上次查看動態 Feed 的遊戲時間(未讀徽章基準;入存檔) */
  feedSeenMs: 0,
  /** 每 7 遊戲日產生的生活週報(最近 12 份;入存檔) */
  weeklyReports: [] as WeeklyReport[],
  /** 上次產生週報的遊戲日 + 當時關係快照(供下週算變化;入存檔) */
  lastWeeklyReportDay: 0,
  weeklyRelationshipSnapshot: {} as Record<string, number>,
  /** 上次「匯出備份」的現實時間(提醒玩家定期備份,避免 iOS 清 localStorage;0=從未;入存檔) */
  lastBackupMs: 0,
  /** 待決的同居抉擇(情侶關係極高時觸發) */
  pendingCohabit: null as { aId: string; bId: string; aName: string; bName: string } | null,
  /** 待決的群體事件(全樓事務,房東抉擇影響整群人;§C-7;入存檔) */
  pendingGroupEvent: null as GroupEvent | null,
  /** 尚待 AI 補寫的每日觀察；每位房客只保留最新一篇。 */
  pendingDiaries: [] as PendingDiary[],
  /** 擺放模式:玩家點了「買」後,待放置的家具 defId(點地圖選位置) */
  pendingPlace: null as string | null,
  /** 擺放／移動中的預覽方向(不入存檔；確認後寫進 Placement)。 */
  pendingRotation: 0 as FurnitureRotation,
  /** 移動模式:待搬動的既有家具(原位座標;點地圖選新位置,免費) */
  pendingMove: null as { c: number; r: number; defId: string; rotation: FurnitureRotation } | null,
  /** UI 快轉剩餘小時數(>0 = 快轉中,按鈕該 disabled;不入存檔) */
  ffRemaining: 0,
  /** 收支帳:每筆金錢進出(綠進紅出),供財務面板檢視 */
  ledger: [] as Txn[],
  /** 房間 → 租客 id(動態,招租入住會新增) */
  occupancy: {
    r301: "tenant_chen_engineer",
    r302: "tenant_lin_asmr",
  } as Record<string, string>,
  /** 同居者:租客 id → 同居的房間 id(住在伴侶房裡、不佔 occupancy、不另收租) */
  cohabits: {} as Record<string, string>,
  /** 🔞 成人內容開關(預設關;僅影響「成年情侶」的含蓄親密互動,入存檔) */
  adultMode: false,
  /** 互動冷卻:`pairKey|defId` → 上次觸發的 gameMs(入存檔,避免重載後洗冷卻) */
  interactionCooldowns: {} as Record<string, number>,
  /** 設備故障(§7-1 維修系統):房間 id → 進行中的故障(一房最多一件;入存檔) */
  breakdowns: {} as Record<string, { defId: string; cost: number; sinceMs: number }>,
  /** 冷戰(§10-2 衝突):pairKey → 期限(期間互相迴避、關係每日小扣;入存檔) */
  feuds: {} as Record<string, { untilMs: number }>,
  /** 寵物:飼主租客 id → 貓(一人一隻;會在樓層遊走並引發事件;入存檔) */
  pets: {} as Record<string, Pet>,
  /** 成就冊:已解鎖的成就 id(§G-7;入存檔) */
  achievements: [] as string[],
  /** 累計實現的人生心願數(成就「夢想孵化器」用;入存檔) */
  wishesFulfilled: 0,
  /** 累計心意互動次數(成就「暖心房東」用;入存檔) */
  careGiven: 0,
  /** 歷任房客名冊:退租者的紀錄,最新在前(§G-8;入存檔) */
  alumni: [] as AlumniEntry[],
  /** 招租應徵者池:房間 id → 當日批次(每遊戲日換一批,開關面板不重抽) */
  applicantPools: {} as Record<string, { day: number; applicants: Applicant[] }>,
  runtimes: {
    tenant_chen_engineer: makeRuntime(tenants[0], "301", 35, []),
    tenant_lin_asmr: makeRuntime(tenants[1], "302", 92, []),
  } as Record<string, TenantRuntime>,
});

export function isVacant(roomId: string): boolean {
  return !state.occupancy[roomId];
}

/** 租客實際住在哪間房:自己承租的房,或同居的伴侶房 */
export function roomOfTenant(tenantId: string): string | null {
  const entry = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId);
  return entry ? entry[0] : state.cohabits[tenantId] ?? null;
}

/** 目前實際同居的對象；同時支援「搬進別人房」與「讓別人搬進自己的房」兩種方向。 */
export function cohabitingPartnerId(tenantId: string): string | null {
  const joinedRoom = state.cohabits[tenantId];
  if (joinedRoom) {
    const hostId = state.occupancy[joinedRoom];
    if (hostId && hostId !== tenantId) return hostId;
  }
  const ownRoom = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId)?.[0];
  if (!ownRoom) return null;
  return Object.entries(state.cohabits).find(([guestId, roomId]) => guestId !== tenantId && roomId === ownRoom)?.[0] ?? null;
}

/** 同居採一對一：只有雙方目前都沒有同居對象，才可提出新的同居申請。 */
export function canStartCohabit(aId: string, bId: string): boolean {
  return aId !== bId && !cohabitingPartnerId(aId) && !cohabitingPartnerId(bId);
}

/** 依房間指派動態租客的外觀索引,確保同時在住者配色彼此不同(種子租客用專屬色不佔用) */
export const ROOM_APPEARANCE: Record<string, number> = { r301: 0, r302: 1, r303: 2, r304: 3 };

/** 種子租客的固定部件外觀(配色沿用其專屬 Theme,只加辨識度高的髮型/配件) */
const SEED_APPEARANCES: Record<string, Appearance> = {
  tenant_chen_engineer: { hairStyle: "spiky", hairColor: "#3a3346", shirt: "#5f86b0", pants: "#464b63", skin: "#f0c19a", accessory: "glasses" },
  tenant_lin_asmr: { hairStyle: "long", hairColor: "#8a5540", shirt: "#df90ae", pants: "#6f5d80", skin: "#f4c9a6", accessory: "headphones" },
};

const HAIR_STYLES: HairStyle[] = ["short", "long", "ponytail", "spiky", "bob"];
const ACCESSORIES: AccessoryKind[] = ["none", "glasses", "round_glasses", "cap", "bow", "headphones"];

export function refreshAppearances() {
  const used = new Set<number>();
  for (const [roomId, tid] of Object.entries(state.occupancy)) {
    if (state.runtimes[tid] && !hasFixedTheme(tid)) {
      const idx = ROOM_APPEARANCE[roomId] ?? 0;
      setAppearance(tid, idx);
      used.add(idx);
    }
  }
  // 同居者不佔房間,改領「還沒被用掉」的配色(池已擴到 6 色,足夠 4 房 + 同居者)
  for (const tid of Object.keys(state.cohabits)) {
    if (!state.runtimes[tid] || hasFixedTheme(tid)) continue;
    let idx = 0;
    while (used.has(idx) && idx < THEME_POOL_SIZE - 1) idx++;
    setAppearance(tid, idx);
    used.add(idx);
  }

  // 種子租客補上固定部件外觀(舊存檔沒有 → 就地補齊;髮型/配件讓兩位主角一眼可辨)
  for (const [tid, ap] of Object.entries(SEED_APPEARANCES)) {
    const rt = state.runtimes[tid];
    if (!rt) continue;
    rt.tenant.appearance ??= { ...ap };
    setCustomAppearance(tid, rt.tenant.appearance);
  }

  // 同住者「部件去重」:髮型/配件盡量彼此不同(配色已去重,輪廓也要能分)。
  // 依房號序穩定迭代:先到先得,後來的撞款才換,避免每次刷新反覆換造型。
  const residents = [...Object.entries(state.occupancy).sort(([a], [b]) => a.localeCompare(b)).map(([, tid]) => tid), ...Object.keys(state.cohabits).sort()];
  const usedHair = new Set<HairStyle>();
  const usedAcc = new Set<AccessoryKind>();
  for (const tid of residents) {
    const ap = state.runtimes[tid]?.tenant.appearance;
    if (!ap) continue;
    if (usedHair.has(ap.hairStyle)) {
      const alt = HAIR_STYLES.find((h) => !usedHair.has(h));
      if (alt) ap.hairStyle = alt;
    }
    usedHair.add(ap.hairStyle);
    if (ap.accessory !== "none" && usedAcc.has(ap.accessory)) {
      ap.accessory = ACCESSORIES.find((a) => a !== "none" && !usedAcc.has(a)) ?? "none";
    }
    if (ap.accessory !== "none") usedAcc.add(ap.accessory);
    setCustomAppearance(tid, ap);
  }
}
refreshAppearances(); // 新開局也要有部件外觀(load 會再各自刷新一次)

/** 新增記憶標籤:不重複、有上限(超過丟最舊);intensity=1 起跳,每日依語意衰減(memoryEffects) */
export function pushMemory(t: Tenant, label: string, hint: string, source: "ai_event" | "landlord_decision") {
  if (t.memoryTags.some((m) => m.label === label)) return;
  t.memoryTags.push({ id: `ai_${Date.now()}`, label, behaviorHint: hint, acquiredAt: new Date(state.gameMs).toISOString(), source, intensity: 1 });
  if (t.memoryTags.length > MEMORY_CAP) t.memoryTags.splice(0, t.memoryTags.length - MEMORY_CAP);
}

/** 系統通知單一入口:彈 toast(state.notice)+ 留存歷史(即使 toast 被同刻的下一則蓋掉,歷史都在) */
export function notify(text: string) {
  state.notice = text;
  state.noticeLog.push({ gameMs: state.gameMs, text });
  if (state.noticeLog.length > 30) state.noticeLog.splice(0, state.noticeLog.length - 30);
}

export const activeRuntime = computed(() => state.runtimes[state.activeId]);
export const hasAnyPending = computed(() =>
  Object.values(state.runtimes).some((r) => r.pendingEvent !== null),
);

export function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// header 時鐘多帶星期(日誌 timeLabel 仍用精簡的 fmt,不動既有格式)
export const clockLabel = computed(() => {
  const d = new Date(state.gameMs);
  return `${d.getMonth() + 1}/${d.getDate()}(${weekdayShort(state.gameMs)}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

/** 單調遞增的遊戲日序號 */
export const gameDayIndex = () => Math.floor((state.gameMs - GAME_START.getTime()) / (24 * 3600 * 1000));

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

export function pushSocialLog(rt: TenantRuntime, text: string, importance: "minor" | "notable" | "major") {
  rt.log.push({ gameMs: state.gameMs, timeLabel: fmt(state.gameMs), text, visualState: rt.tenant.visualState, importance });
  if (rt.log.length > LOG_CAP) rt.log.splice(0, rt.log.length - LOG_CAP);
}

export function applySocialEffect(rt: TenantRuntime, eff?: SocialEffect) {
  if (!eff) return;
  const s = rt.tenant.stats;
  if (eff.mood) s.mood = clamp(s.mood + eff.mood, 0, 100);
  if (eff.stress) s.stress = clamp(s.stress + eff.stress, 0, 100);
  if (eff.satisfaction) rt.satisfaction = clamp(rt.satisfaction + eff.satisfaction, 0, 100);
}
