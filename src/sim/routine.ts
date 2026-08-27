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
import { GRID_W, GRID_H, CAFE_RECTS, buildGrid, type Placement } from "../floor/map";
import { getDef } from "../furniture/catalog";
import { getPlacements, placementFootprint, placementInteract } from "./placements";
import { currentBlocked, type Tile } from "../floor/pathfind";
// CAFE-20:兩道閘門要讀 `state.cafe.open` 與遊戲日序號。
// 迴圈 import(routine → gameState → persistence → routine)與 pets.ts 同形,
// 兩邊都只在**函式內**用到對方的值,模組求值期不互相依賴 ⇒ 安全。
// 別名成 `game`:`resolveTarget()` 的第三個參數就叫 `state`(visualState),不要撞名。
import { state as game, gameDayIndex } from "./gameState";

/**
 * 語意家具角色。
 * `out` = 不在樓裡(外出);`cafe` = 下樓坐一樓咖啡廳(CAFE-20,不查 ROLE_KINDS,
 * 走 `cafeSeatTarget()` 直接錨定一樓大廳)。兩者都不是「房間裡的家具需求」,
 * 故都不列入 `ROLE_KINDS`,也都不該出現在 `data/routines.json` 的每日表。
 */
export type Role = "bed" | "desk" | "kitchen" | "bathroom" | "laundry" | "sofa" | "tv" | "out" | "cafe";

export interface Slot {
  role: Role;
  state: TenantVisualState;
}

/** 角色 → 對應的家具外觀 kind(反查 placement 用) */
const ROLE_KINDS: Record<Exclude<Role, "out" | "cafe">, string[]> = {
  bed: ["bed"],
  desk: ["desk", "mic_desk"],
  kitchen: ["stove", "counter", "dining_table"],
  bathroom: ["shower", "toilet", "bathtub"],
  laundry: ["washer", "drying_rack"],
  sofa: ["sofa", "chair"],
  tv: ["tv"],
};

/** 同一語意角色內再依實際活動精確選家具，避免 bathroom 永遠只拿第一間淋浴間。 */
const STATE_KINDS: Partial<Record<TenantVisualState, string[]>> = {
  showering: ["shower"],
  using_toilet: ["toilet"],
  washing_at_sink: ["sink"],
  taking_bath: ["bathtub"],
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

// ⚠️ 刻意**不含** `cafe`:咖啡廳時段是由 `cafeSitHourForDay()` 決定性插入的,
//    一旦資料表寫得出 role: "cafe" / state: "at_cafe",第 1 天起就會天天觸發,
//    兩道閘門形同虛設、balance 快照必漂移(見 CAFE_FIRST_DAY 的說明)。
const VALID_ROLES = new Set<string>(["bed", "desk", "kitchen", "bathroom", "laundry", "sofa", "tv", "out"]);
const VALID_STATES = new Set<string>(TENANT_VISUAL_STATES);

/** 區段展開成 24 小時 Slot 表;非法 role/state 或格式略過並警告,缺漏小時以 bed/idle 補 */
function expandSpans(spans: RoutineSpan[], label: string): Slot[] {
  const out: (Slot | null)[] = Array(24).fill(null);
  for (const s of spans) {
    const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(s.hours).trim());
    // `at_cafe` 在白名單裡(它是合法的 visualState),但**不准出現在每日表**——
    // 那會繞過 CAFE-20 的兩道閘門。這一刀讓資料檔寫錯時 fail-soft 而不是靜默漂移。
    if (!m || !VALID_ROLES.has(s.role) || !VALID_STATES.has(s.state) || s.state === "at_cafe") {
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

/** 作息所需家具角色有幾成能在自房或共用區找到；滿意度公式與 UI 共用。 */
export function routineNeedsMet(tenantId: string, roomId: string | null): number {
  const roles = routineRoles(tenantId);
  if (roles.length === 0) return 1;
  let served = 0;
  for (const role of roles) if (resolveTarget(role, roomId)) served++;
  return served / roles.length;
}

/**
 * 該租客該小時的作息 slot。
 *
 * CAFE-20 的插入點就在這裡:`tick.decideState()` 只透過本函式讀作息,
 * 咖啡廳時段成立時直接回傳 `CAFE_SIT_SLOT`,不需要動 `tick.ts` 一行。
 */
export function routineSlot(tenantId: string, hour: number): Slot {
  const h = ((hour % 24) + 24) % 24;
  if (cafeSitActive(tenantId, h)) return CAFE_SIT_SLOT;
  const table = ROUTINES[tenantId];
  if (!table) return D("bed", "idle");
  return table[h];
}

const LAUNDRY_CANDIDATE_HOURS = [20, 21, 22, 23, 18, 19, 17, 16, 15, 14, 13, 12, 11, 10];

/** 穩定雜湊：偶爾洗衣不消耗模擬 RNG，也不會每次重載就換日子。 */
function stableTenantHash(tenantId: string): number {
  let hash = 0;
  for (let i = 0; i < tenantId.length; i++) hash = ((hash << 5) - hash + tenantId.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** 每個浴室作息時段依住戶／日期穩定輪替，增加生活變化但不消耗模擬 RNG。 */
export function bathroomActivityForDay(tenantId: string, day: number, hour: number): TenantVisualState {
  const variants: TenantVisualState[] = ["showering", "using_toilet", "washing_at_sink", "taking_bath"];
  return variants[(stableTenantHash(tenantId) + day + hour) % variants.length];
}

/**
 * 每位住戶約每四個遊戲日安排一次洗衣；從原作息中挑晚上／午後仍在家且清醒的一小時，
 * 避免固定每天洗衣，也不會把人從外出、睡眠或淋浴中硬拉走。
 */
export function laundryHourForDay(tenantId: string, day: number): number | null {
  const table = ROUTINES[tenantId];
  if (!table || day < 0) return null;
  const hash = stableTenantHash(tenantId);
  if ((day + hash) % 4 !== 0) return null;
  const candidates = LAUNDRY_CANDIDATE_HOURS.filter((hour) => {
    const state = table[hour]?.state;
    return state && !["away", "sleeping_on_bed", "sleeping_on_couch", "showering"].includes(state);
  });
  // 優先取原本在自己房內的桌前時段，避免單純增加洗衣畫面卻改掉交誼廳社交擲骰與平衡序列。
  const privateCandidates = candidates.filter((hour) => table[hour]?.role === "desk");
  const pool = privateCandidates.length ? privateCandidates : candidates;
  return pool.length ? pool[hash % pool.length] : null;
}

// ---------------------------------------------------------------------------
// CAFE-20:租客下樓坐一樓寵物咖啡廳
// ---------------------------------------------------------------------------

/**
 * 設計約束與 `sim/outing.ts` 檔頭同源(那是本專案同類系統的規範),逐條對應:
 *
 * - **零 RNG**:挑日子、挑時段全部走 `stableTenantHash()`(同 laundryHourForDay)。
 *   多一次 `Math.random()` 就位移整個模擬序列、讓 balance 快照全盤漂移。
 * - **固定迭代次序**:本系統**完全不迭代 `state.runtimes`** —— 每位租客各自查自己的
 *   雜湊,誰在不在、鍵的插入順序如何都不影響結果。`outing.ts` 需要排序是因為它要配對,
 *   這裡沒有配對,所以次序問題從根上不存在(`cafe-at-cafe-test.ts` 有回歸釘子)。
 * - **排除 `pendingEvent`**:被事件凍結的租客 visualState 停在舊值,不該被拉下樓。
 *   `hourlyTick` 本來就會 `continue` 掉他們,這裡再擋一次,讓直接呼叫 `applyHour()`
 *   的路徑(測試、初始定位)也一致。
 * - **冷卻以「遊戲日序號」計**:`(day + hash) % CAFE_SIT_GAP_DAYS`,天然冪等 ——
 *   `syncToNow()` 補進度一次會跑最多 48 個 hourlyTick,用 gameMs 差值會刷出一整排。
 *   同時也不需要新增存檔欄位(不動 persistence)。
 * - **相位偏移**:上式的 `+ hash` 就是相位 —— 不同租客的下樓日錯開,
 *   不會在 `CAFE_FIRST_DAY` 當天全樓一起下樓。
 *
 * ## 為什麼兩道閘門都留
 *
 * 1. `state.cafe.open` 是**語意上必要**的:咖啡廳沒開張,租客不可能坐在裡面。
 *    它同時也是 CAFE-22(`tick.cafeDailyPass()`)採用的零漂移論證 —— 開張要玩家花錢,
 *    無頭的 balance 快照局永遠不會開張。
 * 2. `CAFE_FIRST_DAY` 是 CAFE-20 規格明令的閘門,擋的是**另一件事**:
 *    快照窗只有 10 個遊戲日,第 11 天起才可能觸發 ⇒ 就算哪天有人讓快照局開張咖啡廳
 *    (例如日後給 balance-test 加場景、或存檔升級路徑預設 open),日數閘門仍然頂得住。
 *    本項是全案漂移風險最高的一項(唯一新增 visualState、會改 `rt.log` 的 visualState 欄位
 *    與每小時 statDeltas),值得雙保險。單獨任一道都足以零漂移,兩道是 AND。
 */
/**
 * 🔴 **不得小於 11**。快照窗是第 0～9 遊戲日,11 是「仍嚴格大於快照窗」的最小值,
 * 三個測試檔(`cafe-at-cafe-test.ts`／`cafe-seat-pose-test.ts`／`cafe-venue-effect-test.ts`)
 * 都硬性斷言 `CAFE_FIRST_DAY > 10`。從 14 降到 11 是為了讓新局早三個遊戲日看得到人下樓。
 */
export const CAFE_FIRST_DAY = 11;

/** 每位租客約每幾個遊戲日下樓坐一次(相位由 stableTenantHash 錯開) */
export const CAFE_SIT_GAP_DAYS = 4;

/**
 * 每個週期內連續下樓幾天(`(day + hash) % GAP < WINDOW`)。
 *
 * 🔴 **`WINDOW >= 2` 是「兩位租客同框」的必要條件,不要調回 1。**
 * `WINDOW === 1` 時本式與舊式 `(day + hash) % GAP === 0` **逐位元等價**:兩人同一天
 * 下樓 ⟺ `GAP | (hash(A) − hash(B))`,而種子局兩人的雜湊差是
 * `394,033,487 = 73 × 5,397,719`(兩者皆質數)⇒ 任何合理的 GAP 都整除不了
 * ⇒ 同框率**恆為 0%,永遠**。把週期拉成「連續 WINDOW 天」才讓不同相位的人產生交集。
 * (`cafe-at-cafe-test.ts` 有直接釘子:WINDOW >= 2 且種子局 30 日內至少同框一次。)
 */
export const CAFE_SIT_WINDOW_DAYS = 2;

/**
 * 候選時段,**依偏好排序,實際就取首項**(見 `cafeSitHourForDay()` 的 `candidates[0]`)。
 *
 * 🔴 這裡曾經是註解寫「依偏好排序」、程式卻做 `candidates[hash % len]` 的均勻挑,
 * 結果是**每位租客被釘死在互不相同的固定小時**(種子局:陳 13:00、林 17:00)
 * ⇒ 就算同一天下樓也永遠不同小時。改成取首項後,`CAFE_SIT_HOURS[0] = 14` 成為
 * 大多數作息原型的共同可用時段,同框才可能發生。**不要改回 `hash % len`。**
 * 變化度改由三個來源提供:各作息原型的可用時段不同(夜班型的首選會落在 18:00)、
 * 洗衣時段排除、以及 `CAFE_SIT_WINDOW_DAYS` 造成的「連兩天」節奏。
 *
 * 上下界對齊 `tick.ts` 的 `CAFE_OPEN_HOUR`(10)/`CAFE_CLOSE_HOUR`(20)
 * ——刻意**複製常數而不 import**:`tick.ts` 已經 import 本檔,
 * 反向 import 會讓兩個模組互相在求值期等待。真正的營業時段判斷仍在 tick.ts,
 * 這裡只是「不要挑到打烊時段」的保守子集。
 */
const CAFE_SIT_HOURS = [14, 15, 16, 13, 17, 11, 12, 18, 19, 10];

/** 這些原作息不該被咖啡廳蓋掉:人不在樓裡、在睡、或正在浴室 */
const CAFE_SIT_SKIP_STATES = new Set<TenantVisualState>([
  "away", "sleeping_on_bed", "sleeping_on_couch",
  "showering", "using_toilet", "washing_at_sink", "taking_bath", "waiting_for_bathroom",
]);

/** 咖啡廳時段的 slot(唯一產生 `at_cafe` 的地方) */
export const CAFE_SIT_SLOT: Slot = { role: "cafe", state: "at_cafe" };

/**
 * 這位租客這個遊戲日幾點會下樓坐咖啡廳(不下樓回 null)。
 * 純函式:只吃 tenantId/day,**不看閘門**——閘門在 `cafeSitActive()`,
 * 這樣測試可以分別驗「挑人邏輯」與「閘門」。
 */
export function cafeSitHourForDay(tenantId: string, day: number): number | null {
  const table = ROUTINES[tenantId];
  if (!table || day < 0) return null;
  const hash = stableTenantHash(tenantId);
  // 週期內的**連續 WINDOW 天**都下樓(不是只有相位 0 那一天)。
  // 🔴 WINDOW 調回 1 會退化成舊式 `% GAP === 0`,同框率立刻歸零 —— 見 CAFE_SIT_WINDOW_DAYS。
  if ((day + hash) % CAFE_SIT_GAP_DAYS >= CAFE_SIT_WINDOW_DAYS) return null;
  // 洗衣時段優先(既有行為):同一小時撞上時讓開,否則 decideState 的洗衣覆寫會把
  // at_cafe 擠成 effectState,而 `EFFECT` 表沒有 at_cafe ⇒ 那一小時的數值效果會被抹掉。
  // ⚠️ 洗衣是 4 日週期、本閘門也是 4 日週期 ⇒ 兩者相位一旦對齊就會**每次都**排除同一小時。
  //    種子局實測無影響(陳的洗衣在 21:00,不在 10～19 內),`cafe-at-cafe-test.ts` 有釘子。
  const laundry = laundryHourForDay(tenantId, day);
  const candidates = CAFE_SIT_HOURS.filter((hour) => {
    if (hour === laundry) return false;
    const st = table[hour]?.state;
    return !!st && !CAFE_SIT_SKIP_STATES.has(st);
  });
  // 🔴 真的取首項(見 CAFE_SIT_HOURS 的註解)。不要改回 `candidates[hash % candidates.length]`。
  return candidates.length ? candidates[0] : null;
}

/** 兩道閘門 + pendingEvent + 時段命中,全部成立才回 true */
function cafeSitActive(tenantId: string, hour: number): boolean {
  if (!game.cafe?.open) return false;                   // 閘門一:咖啡廳沒開張
  const day = gameDayIndex();
  if (day < CAFE_FIRST_DAY) return false;               // 閘門二:新局前 11 個遊戲日
  if (game.runtimes[tenantId]?.pendingEvent) return false;
  return cafeSitHourForDay(tenantId, day) === hour;
}

/** 一樓可當座位的家具(CAFE-06 的 sprite 是 recipe 而非 kind,查不到 ROLE_KINDS,只能列 id) */
const CAFE_SEAT_DEF_IDS = ["cafe_chair_front", "cafe_chair_side", "cafe_table"];
const CAFE_ROOMS = new Set(["cafe_floor", "cafe_counter", "cafe_pet", "cafe_back"]);

/**
 * 咖啡廳座位錨點。
 *
 * 玩家若真的在一樓擺了椅子/圓桌,就坐那裡(`getPlacements()` 是穩定陣列 ⇒ 決定性);
 * 沒擺任何座位時退回大廳裡 row-major 第一格可走地板,並附一個**虛擬 placement**
 * 當回傳型別的佔位 —— `resolveTarget` 的簽名要求 `placement` 非 null,而
 * `tick.applyHour` 只用到 `.room`(判斷是不是 lounge)與 `.defId`(睡眠家具乘數,
 * `at_cafe` 不是睡眠狀態 ⇒ 乘數恆為 1)。虛擬 placement 不進 `placements` 清單,
 * 不擋路、不算舒適度、不進存檔。
 */
function cafeSeatTarget(roomId: string | null): { tile: Tile; placement: Placement } | null {
  const seats = getPlacements().filter((p) => CAFE_ROOMS.has(p.room) && CAFE_SEAT_DEF_IDS.includes(p.defId));
  if (seats.length) {
    // 避開顧客已佔的席位。原本兩邊都取「第一張」(這裡 `.find()`、顧客的 `tick.claimSeat()`
    // 也從前往後掃)⇒ 撞格是**決定性的、每次都同一格**,玩家會當成 bug 回報。
    // 顧客席位在模擬層就配好了(`state.cafe.guests[].seatTile`,tick.ts 的 `spawnGuest`),
    // 讀它就能避開,不必跨層 import floor/guestAgents。零 RNG、決定性。
    // ⚠️ 已知不完備(本批不修,見 docs/待辦.md):`applyHour` 迴圈先於 `cafeHourlyPass`,
    //    所以「**新到的顧客**被分到租客已坐的那格」這個反方向仍可能發生。完整雙向修法要讓
    //    `claimSeat()` 也跳過租客席位,但那會改變**內用席次容量語意**(席次少一張 ⇒ 更多外帶
    //    ⇒ 動到營收平衡)。單向修法已消掉「固定同一格」這個最刺眼的情況。
    const taken = new Set(
      (game.cafe?.guests ?? [])
        .filter((g) => g.seatTile)
        .map((g) => `${g.seatTile!.c},${g.seatTile!.r}`),
    );
    const free = seats.filter((p) => !taken.has(`${p.c},${p.r}`));
    const pool = free.length ? free : seats;           // 全客滿就退回原行為(疊著坐總比站著好)
    const seat = pool[stableTenantHash(roomId ?? "cafe") % pool.length]; // 不同租客散開坐
    const tile = standingTile(seat);
    if (tile) return { tile, placement: seat };
  }
  const grid = buildGrid();
  const blocked = currentBlocked();
  const box = CAFE_RECTS.cafe_floor;
  for (let r = box.r0; r <= box.r1; r++) {
    for (let c = box.c0; c <= box.c1; c++) {
      if (grid[r]?.[c] !== "cafe_floor" || blocked[r]?.[c] !== false) continue;
      return { tile: { c, r }, placement: { defId: "cafe_chair_front", room: "cafe_floor", c, r } };
    }
  }
  return null;
}

/**
 * 角色 → 實際家具的互動站立格(優先自己房間,其次共用區)。
 * roomId 由呼叫端(store)依動態佔用表提供;out 或找不到時回傳 null。
 */
export function resolveTarget(role: Role, roomId: string | null, state?: TenantVisualState): { tile: Tile; placement: Placement } | null {
  if (role === "out") return null;
  if (role === "cafe") return cafeSeatTarget(roomId); // CAFE-20:錨在一樓,不查自房家具(roomId 只用來把不同租客散到不同席位)
  const kinds = STATE_KINDS[state ?? "idle"] ?? ROLE_KINDS[role];

  // 咖啡廳室內可作為活動目的地，但不代表住宅舒適度的共用設施。
  const COMMUNAL = new Set([
    "lounge", "bathroom", "laundry", "cafe_floor", "cafe_counter", "cafe_pet", "cafe_back",
  ]);
  const match = (p: Placement) => {
    const def = getDef(p.defId);
    if (!("kind" in def.sprite) || !kinds.includes(def.sprite.kind)) return false;
    if (role === "laundry") return p.room === "laundry"; // 交誼廳也有 washer，日常洗衣必須進真正的洗衣間
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
  const blocked = currentBlocked();
  const ok = (c: number, r: number) => c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && !blocked[r][c];

  const interact = placementInteract(p);
  const pc = interact.c;
  const pr = interact.r;
  if (ok(pc, pr)) return { c: pc, r: pr };

  // 掃家具外圈一圈,回傳第一個可走格
  const { w, h } = placementFootprint(p);
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
