/**
 * 作息表 + 家具角色反查。
 *
 * 每位租客一張 24 小時作息(依性格),每小時給一個 { role, state }:
 *   - state:當下的 visual_state(前端畫圖 + 日誌用)
 *   - role :語意家具角色,反查實際擺在樓層上的家具互動格(供尋路走過去)
 *
 * 這是「固定作息」的底;偏離(壓力/事件)在 store.hourlyTick 疊加。
 * 之後可由 AI 動態產生 role/state,routine 只是保底。
 *
 * 作息已資料化(設計檢討 §5):目錄在 data/routines.json(hours 區段式),
 * 「加作息/改作息 = 改資料」;載入時驗證 role/state 白名單 + 24 小時覆蓋,
 * 壞資料略過並警告、缺漏小時以 bed/idle 補(fail-soft,遊戲照跑)。
 */
import { TENANT_VISUAL_STATES, type TenantVisualState } from "../types";
import routinesJson from "../../data/routines.json";
import { GRID_W, GRID_H, type Placement } from "../floor/map";
import { getDef } from "../furniture/catalog";
import { getPlacements } from "./placements";
import { currentBlocked, type Tile } from "../floor/pathfind";

export type Role = "bed" | "desk" | "kitchen" | "bathroom" | "sofa" | "tv" | "out";

export interface Slot {
  role: Role;
  state: TenantVisualState;
}

/** 角色 → 對應的家具外觀 kind(反查 placement 用) */
const ROLE_KINDS: Record<Exclude<Role, "out">, string[]> = {
  bed: ["bed"],
  desk: ["desk", "mic_desk"],
  kitchen: ["stove", "counter", "dining_table"],
  bathroom: ["shower", "toilet", "bathtub"],
  sofa: ["sofa"],
  tv: ["tv"],
};

const D = (role: Role, state: TenantVisualState): Slot => ({ role, state });

// ---------------------------------------------------------------------------
// 作息目錄載入(data/routines.json,hours 區段式)+ 驗證
// ---------------------------------------------------------------------------

interface RoutineSpan {
  hours: string; // "0-5" 或 "13"
  role: string;
  state: string;
}

const VALID_ROLES = new Set<string>(["bed", "desk", "kitchen", "bathroom", "sofa", "tv", "out"]);
const VALID_STATES = new Set<string>(TENANT_VISUAL_STATES);

/** 區段展開成 24 小時 Slot 表;非法 role/state 或格式略過並警告,缺漏小時以 bed/idle 補 */
function expandSpans(spans: RoutineSpan[], label: string): Slot[] {
  const out: (Slot | null)[] = Array(24).fill(null);
  for (const s of spans) {
    const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(s.hours).trim());
    if (!m || !VALID_ROLES.has(s.role) || !VALID_STATES.has(s.state)) {
      console.warn(`[routine] ${label} 的作息資料不合法,略過:${JSON.stringify(s)}`);
      continue;
    }
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    for (let h = from; h <= to && h < 24; h++) out[h] = { role: s.role as Role, state: s.state as TenantVisualState };
  }
  return out.map((slot, h) => {
    if (slot) return slot;
    console.warn(`[routine] ${label} 缺 ${h} 點的作息,以 bed/idle 補`);
    return D("bed", "idle");
  });
}

const ROUTINES: Record<string, Slot[]> = {};
for (const [id, spans] of Object.entries(routinesJson.tenants as Record<string, RoutineSpan[]>)) {
  ROUTINES[id] = expandSpans(spans, id);
}

/** 招募新租客用的原型作息表(依 archetype 指派給新入住者) */
export const ARCHETYPE_ROUTINES: Record<string, Slot[]> = {};
for (const [key, spans] of Object.entries(routinesJson.archetypes as Record<string, RoutineSpan[]>)) {
  ARCHETYPE_ROUTINES[key] = expandSpans(spans, `archetype:${key}`);
}

/** 入住時登記該租客要用哪套作息 */
export function registerRoutine(tenantId: string, archetypeKey: string) {
  ROUTINES[tenantId] = ARCHETYPE_ROUTINES[archetypeKey] ?? ARCHETYPE_ROUTINES.office;
}

/** 該租客作息中用到的家具角色(去重、排除 out)——用來算房間是否滿足他 */
export function routineRoles(tenantId: string): Role[] {
  const table = ROUTINES[tenantId];
  if (!table) return [];
  const set = new Set<Role>();
  for (const s of table) if (s.role !== "out") set.add(s.role);
  return [...set];
}

/** 該租客該小時的作息 slot */
export function routineSlot(tenantId: string, hour: number): Slot {
  const table = ROUTINES[tenantId];
  if (!table) return D("bed", "idle");
  return table[((hour % 24) + 24) % 24];
}

/**
 * 角色 → 實際家具的互動站立格(優先自己房間,其次共用區)。
 * roomId 由呼叫端(store)依動態佔用表提供;out 或找不到時回傳 null。
 */
export function resolveTarget(role: Role, roomId: string | null): { tile: Tile; placement: Placement } | null {
  if (role === "out") return null;
  const kinds = ROLE_KINDS[role];

  const COMMUNAL = new Set(["lounge", "bathroom", "laundry"]);
  const match = (p: Placement) => {
    const def = getDef(p.defId);
    if (!("kind" in def.sprite) || !kinds.includes(def.sprite.kind)) return false;
    // 只能用自己房間或共用區的家具,絕不闖別人套房
    return p.room === roomId || COMMUNAL.has(p.room);
  };
  const candidates = getPlacements().filter(match);
  const own = candidates.find((p) => p.room === roomId);
  const communal = candidates.find((p) => COMMUNAL.has(p.room));
  const chosen = own ?? communal;
  if (!chosen) return null;
  const tile = standingTile(chosen);
  return tile ? { tile, placement: chosen } : null;
}

/** 家具的可站立點:先試目錄指定的互動格,若是牆/被擋則掃家具周邊找可走格 */
function standingTile(p: Placement): Tile | null {
  const def = getDef(p.defId);
  const blocked = currentBlocked();
  const ok = (c: number, r: number) => c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && !blocked[r][c];

  const pc = p.c + def.interact.dc;
  const pr = p.r + def.interact.dr;
  if (ok(pc, pr)) return { c: pc, r: pr };

  // 掃家具外圈一圈,回傳第一個可走格
  const { w, h } = def.footprint;
  for (let dr = -1; dr <= h; dr++) {
    for (let dc = -1; dc <= w; dc++) {
      const inside = dc >= 0 && dc < w && dr >= 0 && dr < h;
      if (inside) continue;
      const c = p.c + dc;
      const r = p.r + dr;
      if (ok(c, r)) return { c, r };
    }
  }
  return null;
}
