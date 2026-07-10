/**
 * 共用遊戲狀態核心(store 模組化拆分的地基)。
 *
 * 只放:reactive state 定義、跨模組共用的常數/型別/小工具。
 * 模擬邏輯在 tick.ts、金錢與家具在 economy.ts、租約人事在 tenancy.ts、
 * AI 敘事在 narration.ts、存檔在 persistence.ts、啟動在 lifecycle.ts;
 * 對外(元件/測試腳本)一律經 src/store.ts re-export,拆分不影響呼叫點。
 */
import { computed, reactive } from "vue";
import type { RoomPropState, Tenant, TenantVisualState } from "../types";
import tenantsJson from "../../data/tenants.json";
import type { EventDef } from "./events";
import type { ActiveDirective } from "./directives";
import type { SocialEffect } from "./social";
import type { Applicant } from "./recruit";
import type { Tile } from "../floor/pathfind";
import { setAppearance, hasFixedTheme, THEME_POOL_SIZE } from "../pixel/scene";
import { save } from "./persistence";

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
  /** 上次調租談判的遊戲日(冷卻用;-99 = 沒談過) */
  rentChangeDay: number;
  /** 進行中的行為指令(AI 事件選項/規則事件授予;到期自動恢復) */
  directive: ActiveDirective | null;
  /** 本小時是否在交誼廳(社交相遇判定用,不需存檔) */
  inLounge: boolean;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampDelta = (d: number | undefined) => clamp(d ?? 0, -20, 20);
export const tenants = tenantsJson as unknown as Tenant[];

export function makeRuntime(t: Tenant, roomNo: string, cleanliness: number, props: RoomPropState[]): TenantRuntime {
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
    rentChangeDay: -99,
    directive: null as ActiveDirective | null,
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
  /** 通知歷史(toast 會消失,這裡留存;cap 30、入存檔) */
  noticeLog: [] as { gameMs: number; text: string }[],
  /** 上次查看動態 Feed 的遊戲時間(未讀徽章基準;入存檔) */
  feedSeenMs: 0,
  /** 待決的同居抉擇(情侶關係極高時觸發) */
  pendingCohabit: null as { aId: string; bId: string; aName: string; bName: string } | null,
  /** 擺放模式:玩家點了「買」後,待放置的家具 defId(點地圖選位置) */
  pendingPlace: null as string | null,
  /** 移動模式:待搬動的既有家具(原位座標;點地圖選新位置,免費) */
  pendingMove: null as { c: number; r: number; defId: string } | null,
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

/** 依房間指派動態租客的外觀索引,確保同時在住者配色彼此不同(種子租客用專屬色不佔用) */
export const ROOM_APPEARANCE: Record<string, number> = { r301: 0, r302: 1, r303: 2, r304: 3 };
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
}

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
export const clockLabel = computed(() => fmt(state.gameMs));

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
