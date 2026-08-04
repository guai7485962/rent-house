/**
 * 咖啡廳顧客的獨立走位層。
 *
 * 不共用租客 Agent,也不讀寫 state.runtimes。資料來源只有 `state.cafe.guests`,
 * 而那批人從 P2 起**就是結帳的那批人**(`tick.ts` 的 `cafeHourlyPass()` 逐筆生成),
 * 所以這裡演的每一位都對應帳本上真的收過的一筆錢。
 *
 * ## 動線(設計文件 §4.5 §4.6)
 *
 * ```
 * 店門 → 吧台 → ordering →(料齊)served →(有空席)seated → leaving → departed
 *                                        └(無空席)外帶 ─────→ leaving → departed
 *                        →(缺料)refused ──────────────────→ leaving → departed
 * ```
 *
 * 席次一律查 `placements`(`cafeSeatSpots()`),**沒有硬編座位表**——
 * P1 之前的 `CAFE_GUEST_PREFERRED_SEATS` 正是「顧客站在空地板上」的根因。
 */
import type { CafeGuest } from "../types";
import type { CharView } from "../pixel/sprites";
import { cafeCounterSpots, cafeSeatSpots, type CafeSeatSpot } from "../sim/placements";
import { TILE } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";

export const CAFE_GUEST_ENTRY_TILES: readonly Tile[] = [
  { c: 7, r: 51 },
  { c: 8, r: 51 },
];

/**
 * 顧客的七個階段。`served` / `refused` 是**站在吧台前的短暫演出幀**
 * (浮字 / ❌ 泡泡),不是停留狀態;演完就往座位或門口走。
 */
export type GuestAgentPhase =
  | "entering"
  | "ordering"
  | "served"
  | "refused"
  | "seated"
  | "leaving"
  | "departed";

/** 各階段的演出秒數(現實秒,由 dt 累加;與遊戲時鐘無關 ⇒ 快轉不會吃掉演出)。 */
export const GUEST_ORDER_SECONDS = 2.2;
export const GUEST_SERVED_SECONDS = 2.6;
export const GUEST_REFUSED_SECONDS = 2.4;
/**
 * 走不到目的地時的放棄秒數。
 *
 * 吧台前被別的顧客站滿、或玩家把家具擺成死路時,顧客不能就這樣卡在門口一輩子——
 * 逾時就地進入下一階段,演出照樣看得到,不會出現「有人結帳但畫面上沒動作」。
 */
export const GUEST_WALK_TIMEOUT_SECONDS = 14;

export interface GuestAgent {
  guest: CafeGuest;
  c: number;
  r: number;
  px: number;
  py: number;
  path: Tile[];
  goal: Tile | null;
  moving: boolean;
  hidden: boolean;
  walkPhase: number;
  phase: GuestAgentPhase;
  /** 目前階段已經過的現實秒數(演出計時用)。 */
  phaseT: number;
  view: CharView;
  entryTile: Tile;
  /** 點餐位(吧台前)。 */
  counterTile: Tile;
  /** 他的席位;`null` = 外帶或撲空,不入座。 */
  seatSpot: CafeSeatSpot | null;
  /** 下一格被別人擋住而原地等了多久(現實秒);超過門檻就繞路。 */
  stuckT: number;
}

/**
 * 被擋住多久就重新規劃一條「繞開站著不動的人」的路。
 *
 * 沒有這條會死鎖:P2 起同一小時會有一整批顧客進場,先坐下的人就站在別人的必經格上,
 * 而 `findPath` 不認得 agent ⇒ 後到的人會抱著一條永遠走不通的舊路徑等到天荒地老
 * (實測:六人同時進場時有兩位永遠卡在吧台前)。
 */
const REPATH_AFTER_BLOCKED_SECONDS = 0.8;

const SPEED = 40;
const EMPTY_BLOCKED: ReadonlySet<string> = new Set();
const tileKey = (tile: Tile) => `${tile.c},${tile.r}`;
const sameTile = (a: Tile | null, b: Tile | null) => !!a && !!b && a.c === b.c && a.r === b.r;

/** 顧客是否處在「站著演出、不移動」的階段。 */
function isPerforming(phase: GuestAgentPhase) {
  return phase === "ordering" || phase === "served" || phase === "refused";
}

/**
 * 這位顧客該坐哪張椅子。
 *
 * `guest.seatTile` 是**模擬層在結帳當下配好的**(來自 `cafeSeatSpots()`),
 * 這裡只是把它對回目前的席位清單 —— 玩家中途把那張椅子拆了就找不到,
 * 他自動退化成外帶(站著點完就走),不會卡住也不會坐在空地板上。
 */
function seatSpotFor(guest: CafeGuest, spots: readonly CafeSeatSpot[]): CafeSeatSpot | null {
  if (!guest.seatTile) return null;
  return spots.find((spot) => spot.seat.c === guest.seatTile!.c && spot.seat.r === guest.seatTile!.r) ?? null;
}

/**
 * 把 `state.cafe.guests` 同步成畫面 agent。
 *
 * **既有 agent 依 id 原地保留**:新顧客每個營業小時都會進來一批,若像舊版那樣整批
 * 重建,已經坐下的人會被瞬移回店門口——那正好毀掉 P2 要演的「走進來、坐下」。
 */
export function syncGuestAgents(
  previous: readonly GuestAgent[],
  guests: readonly CafeGuest[],
  blocked = currentBlocked(),
): GuestAgent[] {
  // 席位與點餐位都必須是**當下真的走得到**的格(家具擋住/掃地機停在那裡都算)。
  const seats = cafeSeatSpots().filter((spot) => blocked[spot.stand.r]?.[spot.stand.c] === false);
  const counters = cafeCounterSpots().filter((tile) => blocked[tile.r]?.[tile.c] === false);
  const byId = new Map(previous.map((agent) => [agent.guest.id, agent]));
  const claimedSeats = new Set<string>();
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source, index) => {
      const seatSpot = seatSpotFor(source, seats);
      if (seatSpot) claimedSeats.add(tileKey(seatSpot.seat));
      const kept = byId.get(source.id);
      if (kept) {
        kept.guest = { ...source, seatTile: source.seatTile ? { ...source.seatTile } : null };
        kept.seatSpot = seatSpot;
        return kept;
      }
      const entryTile = { ...CAFE_GUEST_ENTRY_TILES[index % CAFE_GUEST_ENTRY_TILES.length] };
      const counter = counters[index % Math.max(1, counters.length)] ?? entryTile;
      return {
        guest: { ...source, seatTile: source.seatTile ? { ...source.seatTile } : null },
        c: entryTile.c,
        r: entryTile.r,
        px: entryTile.c * TILE,
        py: entryTile.r * TILE,
        path: [],
        goal: null,
        moving: false,
        hidden: false,
        walkPhase: 0,
        phase: "entering" as const,
        phaseT: 0,
        view: "back" as const,
        entryTile,
        counterTile: { c: counter.c, r: counter.r },
        seatSpot,
        stuckT: 0,
      } satisfies GuestAgent;
    });
}

/** 依 id 固定排序後分配入口、點餐位與席位;不修改傳入的 CafeGuest。 */
export function createGuestAgents(guests: readonly CafeGuest[], blocked = currentBlocked()): GuestAgent[] {
  return syncGuestAgents([], guests, blocked);
}

/** state.cafe.guests 改變時供畫面層判斷是否需要同步 agents。 */
export function guestAgentSignature(guests: readonly CafeGuest[]): string {
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((guest) => `${guest.id}:${guest.leavesMs}:${guest.seatTile?.c ?? "x"},${guest.seatTile?.r ?? "x"}:${guest.order?.itemId ?? "-"}`)
    .join("|");
}

function viewToward(agent: GuestAgent, next: Tile): CharView {
  const dc = next.c - agent.c;
  const dr = next.r - agent.r;
  if (dc !== 0) return dc > 0 ? "side_r" : "side_l";
  if (dr !== 0) return dr > 0 ? "front" : "back";
  return agent.view;
}

function reached(agent: GuestAgent, target: Tile) {
  return agent.c === target.c && agent.r === target.r && agent.path.length === 0 && !agent.moving;
}

function enterPhase(agent: GuestAgent, phase: GuestAgentPhase) {
  agent.phase = phase;
  agent.phaseT = 0;
  agent.goal = null;
  agent.path = [];
  agent.moving = false;
  agent.stuckT = 0;
}

/** 目前階段的走位目標;`null` = 站著不動(演出中)。 */
function targetFor(agent: GuestAgent): Tile | null {
  if (agent.phase === "entering") return agent.counterTile;
  if (agent.phase === "seated") return agent.seatSpot?.stand ?? null;
  if (agent.phase === "leaving") return agent.entryTile;
  return null;
}

/** 顧客實際被畫出來的位置(坐在椅子上時是椅子格,其餘是他站的格)。 */
export function guestDrawX(agent: GuestAgent): number {
  return guestSeated(agent) ? agent.seatSpot!.seat.c * TILE : agent.px;
}

export function guestDrawY(agent: GuestAgent): number {
  return guestSeated(agent) ? agent.seatSpot!.seat.r * TILE : agent.py;
}

/** true = 真的坐在椅子上(走到了席位、而且沒在移動)。 */
export function guestSeated(agent: GuestAgent): boolean {
  const spot = agent.seatSpot;
  if (!spot || agent.phase !== "seated" || agent.moving) return false;
  return agent.c === spot.stand.c && agent.r === spot.stand.r;
}

/**
 * 推進顧客走位與點餐演出。
 *
 * `leavesMs` 永遠是離場的權威:時間到就切 `leaving`,不論演出走到哪一格
 * ——資料層的保險絲(`cafeGuestPass`)才不會清掉還站在畫面上的人。
 */
export function tickGuestAgents(
  agents: GuestAgent[],
  dt: number,
  gameMs: number,
  blockedCells: ReadonlySet<string> = EMPTY_BLOCKED,
  blocked = currentBlocked(),
) {
  const occupied = new Map<string, GuestAgent>();
  const reservedSteps = new Set<string>();
  for (const agent of agents) if (!agent.hidden) occupied.set(tileKey(agent), agent);

  for (const agent of [...agents].sort((a, b) => a.guest.id.localeCompare(b.guest.id))) {
    if (agent.phase === "departed" || agent.hidden) continue;
    agent.phaseT += Math.max(0, dt);

    // 1) 時間到 → 一律離場(座位上的人起身、演到一半的人也走)
    if (gameMs >= agent.guest.leavesMs && agent.phase !== "leaving") enterPhase(agent, "leaving");

    // 2) 階段轉移
    switch (agent.phase) {
      case "entering":
        if (reached(agent, agent.counterTile) || agent.phaseT >= GUEST_WALK_TIMEOUT_SECONDS) {
          enterPhase(agent, "ordering");
          agent.view = "back"; // 面向吧台
        }
        break;
      case "ordering":
        if (agent.phaseT >= GUEST_ORDER_SECONDS) {
          // 訂單缺料 ⇒ 紅色 ❌;沒有訂單資料(舊存檔)一律當作服務成功。
          enterPhase(agent, agent.guest.order && !agent.guest.order.served ? "refused" : "served");
        }
        break;
      case "served":
        if (agent.phaseT >= GUEST_SERVED_SECONDS) enterPhase(agent, agent.seatSpot ? "seated" : "leaving");
        break;
      case "refused":
        if (agent.phaseT >= GUEST_REFUSED_SECONDS) enterPhase(agent, "leaving");
        break;
      default:
        break;
    }

    if (isPerforming(agent.phase)) continue; // 站著演出,不走路

    const target = targetFor(agent);
    if (!target) {
      // 座位被拆了之類的意外:原地待著,時間到再走(不穿牆、不瞬移)
      agent.moving = false;
      continue;
    }
    if (reached(agent, target)) {
      if (agent.phase === "leaving") {
        agent.phase = "departed";
        agent.hidden = true;
        occupied.delete(tileKey(agent));
      } else if (agent.phase === "seated") {
        agent.view = "front";
      }
      continue;
    }

    if (!sameTile(agent.goal, target)) {
      agent.goal = { ...target };
      // 卡太久 ⇒ 這次改用「把站著不動的人也當障礙」的地圖重算,真的繞過去。
      const grid = agent.stuckT > 0 ? detourGrid(blocked, agents, agent, target) : blocked;
      const path = grid[target.r]?.[target.c] === false
        ? findPath({ c: agent.c, r: agent.r }, target, grid)
        : null;
      agent.path = path && path.length > 1 ? path.slice(1) : [];
      agent.moving = agent.path.length > 0;
      agent.stuckT = 0;
      if (!agent.moving) agent.goal = null;
    }

    const next = agent.path[0];
    if (!agent.moving || !next) continue;
    const nextKey = tileKey(next);
    const occupant = occupied.get(nextKey);
    if ((occupant && occupant !== agent) || reservedSteps.has(nextKey) || blockedCells.has(nextKey)) {
      agent.stuckT += Math.max(0, dt);
      if (agent.stuckT >= REPATH_AFTER_BLOCKED_SECONDS) {
        agent.goal = null; // 下一幀重算(帶繞路),不要抱著走不通的舊路徑等下去
        agent.path = [];
        agent.moving = false;
      }
      continue;
    }
    agent.stuckT = 0;
    reservedSteps.add(nextKey);
    agent.view = viewToward(agent, next);
    const nx = next.c * TILE;
    const ny = next.r * TILE;
    const dx = nx - agent.px;
    const dy = ny - agent.py;
    const distance = Math.hypot(dx, dy);
    const step = SPEED * Math.max(0, dt);
    if (distance <= step) {
      if (occupied.get(tileKey(agent)) === agent) occupied.delete(tileKey(agent));
      agent.c = next.c;
      agent.r = next.r;
      agent.px = nx;
      agent.py = ny;
      agent.path.shift();
      occupied.set(nextKey, agent);
      agent.moving = agent.path.length > 0;
      if (!agent.moving) {
        if (agent.phase === "leaving") {
          agent.phase = "departed";
          agent.hidden = true;
          occupied.delete(nextKey);
        } else if (agent.phase === "entering") {
          enterPhase(agent, "ordering");
          agent.view = "back";
        } else if (agent.phase === "seated") {
          agent.view = "front";
        }
      }
    } else if (distance > 0) {
      agent.px += (dx / distance) * step;
      agent.py += (dy / distance) * step;
    }
    agent.walkPhase += dt * 7;
  }
}

/** 把「站著不動的其他顧客」也標成障礙的暫時地圖(目標格本身永遠保持可走)。 */
function detourGrid(
  blocked: boolean[][],
  agents: readonly GuestAgent[],
  self: GuestAgent,
  target: Tile,
): boolean[][] {
  const grid = blocked.map((row) => [...row]);
  for (const other of agents) {
    if (other === self || other.hidden || other.phase === "departed" || other.moving) continue;
    if (other.c === target.c && other.r === target.r) continue;
    if (grid[other.r]) grid[other.r][other.c] = true;
  }
  return grid;
}

export function departedGuestIds(agents: readonly GuestAgent[]): string[] {
  return agents.filter((agent) => agent.phase === "departed").map((agent) => agent.guest.id).sort();
}
