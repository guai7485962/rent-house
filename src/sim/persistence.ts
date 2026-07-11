/**
 * 存檔/載入/遷移(store 拆分:persistence 模組)。
 *
 * 遷移層(設計檢討 §5):存檔帶版本號 v;載入時 migrateSave() 從舊版逐段升級到
 * SAVE_VERSION,壞檔/未知版本安全 fallback(當沒有存檔、開新遊戲)。
 * 之後改存檔結構的流程:SAVE_VERSION++ → 在 MIGRATIONS 加一段「舊版 → 新版」升級函式。
 */
import { reactive } from "vue";
import type { Tenant } from "../types";
import { placements } from "./placements";
import { upgradeState } from "./upgrades";
import { serializeRelationships, loadRelationships } from "./social";
import { registerRoutine } from "./routine";
import { setCustomAppearance } from "../pixel/scene";
import { state, tenants, refreshAppearances, type Txn } from "./gameState";
import { stopTicker } from "./lifecycle";

export const SAVE_KEY = "rent_house_save_v1";
export const SAVE_VERSION = 3;

/**
 * 逐版升級表:key = 來源版本,函式回傳「升一版後」的存檔(記得把 v 改成 key+1)。
 */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v2 → v3:數值模型重整(設計檢討 §4)——stats.hygiene 改名 wellbeing、新增 energy
  2: (s) => {
    for (const rt of Object.values<any>(s.runtimes ?? {})) {
      const st = rt?.tenant?.stats;
      if (st) {
        st.wellbeing = st.wellbeing ?? st.hygiene ?? 70;
        delete st.hygiene;
        st.energy = st.energy ?? 60;
      }
    }
    return { ...s, v: 3 };
  },
};

/** 把任意版本的存檔升級到 SAVE_VERSION;不認得/升不上去回傳 null(視同壞檔) */
export function migrateSave(raw: unknown): any | null {
  let s = raw as any;
  if (!s || typeof s !== "object" || typeof s.v !== "number") return null;
  while (s.v < SAVE_VERSION) {
    const step = MIGRATIONS[s.v];
    if (!step) return null; // 太舊、沒有升級路徑
    s = step(s);
  }
  if (s.v !== SAVE_VERSION) return null; // 比程式還新(未來版),不硬讀
  return s;
}

/** 玩家按下「重新開始」或匯入存檔後設為 true:直到 reload 前不再寫檔 */
let saveBlocked = false;

export function save() {
  if (saveBlocked) return;
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
        rentChangeDay: rt.rentChangeDay,
        directive: rt.directive,
        arc: rt.arc,
        flags: rt.flags,
      };
    }
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: SAVE_VERSION,
        realAnchorMs: state.realAnchorMs,
        gameAnchorMs: state.gameAnchorMs,
        gameMs: state.gameMs,
        money: state.money,
        occupancy: state.occupancy,
        cohabits: state.cohabits,
        applicantPools: state.applicantPools,
        placements: placements.list,
        upgrades: upgradeState.byRoom,
        relationships: serializeRelationships(),
        ledger: state.ledger,
        noticeLog: state.noticeLog,
        feedSeenMs: state.feedSeenMs,
        adultMode: state.adultMode,
        interactionCooldowns: state.interactionCooldowns,
        breakdowns: state.breakdowns,
        runtimes,
      }),
    );
  } catch {
    /* localStorage 不可用時忽略 */
  }
}

export function load(): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = migrateSave(JSON.parse(raw));
    if (!s) return false;
    state.realAnchorMs = s.realAnchorMs;
    state.gameAnchorMs = s.gameAnchorMs;
    state.gameMs = s.gameMs;
    state.money = s.money;

    // 家具擺放 + 房間升級
    placements.list.splice(0, placements.list.length, ...s.placements.map((p: unknown) => ({ ...(p as object) })));
    placements.version++;
    for (const k of Object.keys(upgradeState.byRoom)) delete upgradeState.byRoom[k];
    Object.assign(upgradeState.byRoom, s.upgrades ?? {});

    // 房間佔用 + 同居 + 應徵者池
    for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
    Object.assign(state.occupancy, s.occupancy);
    for (const k of Object.keys(state.cohabits)) delete state.cohabits[k];
    Object.assign(state.cohabits, s.cohabits ?? {});
    for (const k of Object.keys(state.applicantPools)) delete state.applicantPools[k];
    Object.assign(state.applicantPools, s.applicantPools ?? {});

    // 鄰居關係
    loadRelationships(s.relationships ?? []);

    // 收支帳 + 通知歷史
    state.ledger.splice(0, state.ledger.length, ...((s.ledger ?? []) as Txn[]));
    state.noticeLog.splice(0, state.noticeLog.length, ...(s.noticeLog ?? []));
    state.feedSeenMs = s.feedSeenMs ?? 0; // 舊檔沒有 → 全部視為未讀,無害
    state.adultMode = s.adultMode === true; // 預設關
    for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
    Object.assign(state.interactionCooldowns, s.interactionCooldowns ?? {});
    for (const k of Object.keys(state.breakdowns)) delete state.breakdowns[k];
    Object.assign(state.breakdowns, s.breakdowns ?? {}); // 舊檔沒有 → 沒故障,無害

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
        rentChangeDay: saved.rentChangeDay ?? -99,
        directive: saved.directive ?? null,
        arc: saved.arc ?? null,
        flags: saved.flags ?? [],
        inLounge: false,
      });
      if (saved.archetypeKey) registerRoutine(id, saved.archetypeKey);
      // 部件化外觀(§9-1):存檔帶有外觀者,重新登錄到渲染層
      const ap = (saved.tenant as Tenant).appearance;
      if (ap) setCustomAppearance(id, ap);
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
    refreshAppearances(); // 依房間指派配色,修正舊存檔可能的撞色
    if (!state.runtimes[state.activeId]) state.activeId = Object.keys(state.runtimes)[0];
    return true;
  } catch {
    return false;
  }
}

// --- 存檔管理(8-4:重新開始 / 匯出 / 匯入)---

/** 匯出目前存檔 JSON(先落盤再讀,保證是最新狀態);localStorage 不可用回傳 null */
export function exportSave(): string | null {
  save();
  try {
    return localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

/** 匯入存檔:JSON 解析 → 遷移到現行版本 → 結構檢查通過才寫入,成功回傳 true(呼叫端負責 reload) */
export function importSave(raw: string): boolean {
  try {
    const s = migrateSave(JSON.parse(raw));
    if (!s || !s.runtimes || !s.occupancy) return false;
    localStorage.setItem(SAVE_KEY, JSON.stringify(s)); // 存「遷移後」的版本
    saveBlocked = true; // 匯入後直到 reload 前,不讓現有狀態把新檔蓋回去
    stopTicker();
    return true;
  } catch {
    return false;
  }
}

/** 清除存檔(重新開始;呼叫端負責 reload)。停掉掛機計時器並封鎖 save,避免 reload 前又被寫回 */
export function clearSave() {
  saveBlocked = true;
  stopTicker();
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* localStorage 不可用時忽略 */
  }
}
