/**
 * 作息表 + 家具角色反查。
 *
 * 每位租客一張 24 小時作息(依性格),每小時給一個 { role, state }:
 *   - state:當下的 visual_state(前端畫圖 + 日誌用)
 *   - role :語意家具角色,反查實際擺在樓層上的家具互動格(供尋路走過去)
 *
 * 這是「固定作息」的底;偏離(壓力/事件)在 store.hourlyTick 疊加。
 * 之後可由 AI 動態產生 role/state,routine 只是保底。
 */
import type { TenantVisualState } from "../types";
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

const ROUTINES: Record<string, Slot[]> = {
  // 陳家豪:工作狂夜貓,凌晨活躍、白天補眠、傍晚進公司
  tenant_chen_engineer: [
    D("desk", "working_at_desk"), // 00
    D("desk", "working_at_desk"), // 01
    D("desk", "gaming"), // 02
    D("desk", "working_at_desk"), // 03
    D("kitchen", "eating"), // 04 泡麵
    D("bathroom", "showering"), // 05
    D("bed", "sleeping_on_bed"), // 06
    D("bed", "sleeping_on_bed"), // 07
    D("bed", "sleeping_on_bed"), // 08
    D("bed", "sleeping_on_bed"), // 09
    D("bed", "sleeping_on_bed"), // 10
    D("bed", "sleeping_on_bed"), // 11
    D("bed", "sleeping_on_bed"), // 12
    D("sofa", "playing_with_cat"), // 13 起床逗貓
    D("kitchen", "cooking"), // 14
    D("out", "away"), // 15 進公司
    D("out", "away"), // 16
    D("out", "away"), // 17
    D("out", "away"), // 18
    D("kitchen", "eating"), // 19 回家吃飯
    D("desk", "working_at_desk"), // 20 加班
    D("desk", "working_at_desk"), // 21
    D("tv", "watching_tv"), // 22 追劇喘口氣
    D("desk", "gaming"), // 23
  ],
  // 林小婕:ASMR 實況主,深夜直播、白天睡、作息儀式感強
  tenant_lin_asmr: [
    D("desk", "streaming"), // 00 開播
    D("desk", "streaming"), // 01
    D("desk", "streaming"), // 02
    D("desk", "streaming"), // 03
    D("desk", "streaming"), // 04
    D("desk", "streaming"), // 05 下播
    D("bathroom", "showering"), // 06
    D("bed", "sleeping_on_bed"), // 07
    D("bed", "sleeping_on_bed"), // 08
    D("bed", "sleeping_on_bed"), // 09
    D("bed", "sleeping_on_bed"), // 10
    D("bed", "sleeping_on_bed"), // 11
    D("bed", "sleeping_on_bed"), // 12
    D("bed", "sleeping_on_bed"), // 13
    D("sofa", "reading"), // 14 起床看書
    D("kitchen", "eating"), // 15
    D("sofa", "reading"), // 16
    D("tv", "watching_tv"), // 17
    D("kitchen", "cooking"), // 18
    D("bathroom", "showering"), // 19
    D("desk", "idle"), // 20 直播前準備
    D("desk", "idle"), // 21 熱身
    D("desk", "streaming"), // 22 開播
    D("desk", "streaming"), // 23
  ],
};

/** 招募新租客用的原型作息表(依 archetype 指派給新入住者) */
export const ARCHETYPE_ROUTINES: Record<string, Slot[]> = {
  // 上班族:日出而作、日落而息
  office: [
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bathroom", "showering"), D("kitchen", "eating"), D("out", "away"), D("out", "away"),
    D("out", "away"), D("out", "away"), D("out", "away"), D("out", "away"), D("out", "away"),
    D("out", "away"), D("out", "away"), D("out", "away"), D("kitchen", "cooking"),
    D("kitchen", "eating"), D("tv", "watching_tv"), D("sofa", "reading"), D("bathroom", "showering"),
    D("bed", "sleeping_on_bed"),
  ],
  // 學生/宅:白天賴床、晚上打電動
  student: [
    D("desk", "gaming"), D("desk", "gaming"), D("tv", "watching_tv"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bathroom", "showering"), D("kitchen", "eating"),
    D("desk", "working_at_desk"), D("desk", "working_at_desk"), D("out", "away"), D("out", "away"),
    D("kitchen", "cooking"), D("kitchen", "eating"), D("sofa", "watching_tv"), D("desk", "gaming"),
    D("desk", "gaming"), D("desk", "gaming"), D("tv", "watching_tv"),
  ],
  // 自由接案:在家工作、作息浮動
  freelancer: [
    D("desk", "working_at_desk"), D("desk", "working_at_desk"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"), D("bed", "sleeping_on_bed"),
    D("bathroom", "showering"), D("kitchen", "eating"), D("desk", "working_at_desk"),
    D("desk", "working_at_desk"), D("sofa", "reading"), D("kitchen", "cooking"), D("kitchen", "eating"),
    D("desk", "working_at_desk"), D("desk", "working_at_desk"), D("tv", "watching_tv"),
    D("sofa", "idle"), D("desk", "working_at_desk"), D("desk", "working_at_desk"),
    D("kitchen", "eating"), D("desk", "working_at_desk"),
  ],
};

/** 入住時登記該租客要用哪套作息 */
export function registerRoutine(tenantId: string, archetypeKey: string) {
  ROUTINES[tenantId] = ARCHETYPE_ROUTINES[archetypeKey] ?? ARCHETYPE_ROUTINES.office;
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
