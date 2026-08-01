/**
 * 咖啡廳顧客的獨立走位層。
 *
 * 不共用租客 Agent，也不讀寫 state.runtimes。CAFE-11 接上 state.cafe 後，只要把
 * state.cafe.guests 傳進 createGuestAgents，再把完成離場的 id 從 cafe state 移除即可。
 */
import type { CafeGuest } from "../types";
import type { CharView } from "../pixel/sprites";
import { cafeGuestHash } from "../sim/cafeGuests";
import { buildGrid, CAFE_RECTS, TILE } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";

export const CAFE_GUEST_ENTRY_TILES: readonly Tile[] = [
  { c: 7, r: 51 },
  { c: 8, r: 51 },
];

/** 視覺上較像座位的主廳錨點；被家具擋住時再掃其餘 cafe_floor 空格。 */
export const CAFE_GUEST_PREFERRED_SEATS: readonly Tile[] = [
  { c: 3, r: 42 },
  { c: 6, r: 43 },
  { c: 5, r: 45 },
  { c: 11, r: 38 },
  { c: 12, r: 40 },
  { c: 4, r: 46 },
];

export type GuestAgentPhase = "entering" | "seated" | "leaving" | "departed";

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
  view: CharView;
  entryTile: Tile;
  seatTile: Tile;
}

const SPEED = 40;
const EMPTY_BLOCKED: ReadonlySet<string> = new Set();
const tileKey = (tile: Tile) => `${tile.c},${tile.r}`;
const sameTile = (a: Tile | null, b: Tile | null) => !!a && !!b && a.c === b.c && a.r === b.r;

/** 決定性座位候選：偏好格優先，其餘只收真正的 cafe_floor 可走格。 */
export function cafeGuestSeatCandidates(blocked = currentBlocked()): Tile[] {
  const grid = buildGrid();
  const candidates: Tile[] = [];
  const seen = new Set<string>();
  const add = (tile: Tile) => {
    const key = tileKey(tile);
    if (seen.has(key) || grid[tile.r]?.[tile.c] !== "cafe_floor" || blocked[tile.r]?.[tile.c] !== false) return;
    seen.add(key);
    candidates.push({ ...tile });
  };
  CAFE_GUEST_PREFERRED_SEATS.forEach(add);
  for (let r = CAFE_RECTS.cafe_floor.r0; r <= CAFE_RECTS.cafe_floor.r1; r++) {
    for (let c = CAFE_RECTS.cafe_floor.c0; c <= CAFE_RECTS.cafe_floor.c1; c++) {
      if (c === 7 || c === 8) continue; // 中央走道留給進出，不把停留座位塞在必經窄口。
      add({ c, r });
    }
  }
  return candidates;
}

function seatFor(guest: CafeGuest, claimed: Set<string>, blocked: boolean[][]): Tile {
  const candidates = cafeGuestSeatCandidates(blocked);
  if (guest.seatTile && candidates.some((tile) => sameTile(tile, guest.seatTile)) && !claimed.has(tileKey(guest.seatTile))) {
    claimed.add(tileKey(guest.seatTile));
    return { ...guest.seatTile };
  }
  const preferred = CAFE_GUEST_PREFERRED_SEATS.filter((seat) => candidates.some((candidate) => sameTile(candidate, seat)));
  for (const pool of [preferred, candidates]) {
    const start = cafeGuestHash(`${guest.id}|seat`) % Math.max(1, pool.length);
    for (let offset = 0; offset < pool.length; offset++) {
      const seat = pool[(start + offset) % pool.length];
      if (!seat || claimed.has(tileKey(seat))) continue;
      claimed.add(tileKey(seat));
      return { ...seat };
    }
  }
  // 主廳完全沒有空格時留在入口等待；不穿牆、不瞬移，也不新增隨機候補。
  return { ...CAFE_GUEST_ENTRY_TILES[cafeGuestHash(`${guest.id}|entry-fallback`) % CAFE_GUEST_ENTRY_TILES.length] };
}

/** 依 id 固定排序後分配入口與座位；不修改傳入的 CafeGuest。 */
export function createGuestAgents(guests: readonly CafeGuest[], blocked = currentBlocked()): GuestAgent[] {
  const claimedSeats = new Set<string>();
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source, index) => {
      const entryTile = { ...CAFE_GUEST_ENTRY_TILES[index % CAFE_GUEST_ENTRY_TILES.length] };
      const seatTile = seatFor(source, claimedSeats, blocked);
      return {
        guest: { ...source, seatTile: { ...seatTile } },
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
        view: "back" as const,
        entryTile,
        seatTile,
      };
    });
}

/** state.cafe.guests 改變時供畫面層判斷是否重建 agents。 */
export function guestAgentSignature(guests: readonly CafeGuest[]): string {
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((guest) => `${guest.id}:${guest.leavesMs}:${guest.seatTile?.c ?? "x"},${guest.seatTile?.r ?? "x"}`)
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

/**
 * 推進顧客畫面走位。gameMs 到 leavesMs 後改走回入口；抵達才標 departed/hidden，
 * 讓 CAFE-11 的 caller 能用 departedGuestIds() 安全清除 state.cafe.guests。
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
    const shouldLeave = gameMs >= agent.guest.leavesMs;
    const target = shouldLeave ? agent.entryTile : agent.seatTile;
    if (shouldLeave && agent.phase !== "leaving") {
      agent.phase = "leaving";
      agent.goal = null;
      agent.path = [];
      agent.moving = false;
    }
    if (shouldLeave && reached(agent, target)) {
      agent.phase = "departed";
      agent.hidden = true;
      occupied.delete(tileKey(agent));
      continue;
    }
    if (!shouldLeave && reached(agent, target)) {
      agent.phase = "seated";
      agent.view = "front";
      continue;
    }

    if (!sameTile(agent.goal, target)) {
      agent.goal = { ...target };
      const path = blocked[target.r]?.[target.c] === false
        ? findPath({ c: agent.c, r: agent.r }, target, blocked)
        : null;
      agent.path = path && path.length > 1 ? path.slice(1) : [];
      agent.moving = agent.path.length > 0;
      if (!agent.moving) agent.goal = null;
    }

    const next = agent.path[0];
    if (!agent.moving || !next) continue;
    const nextKey = tileKey(next);
    const occupant = occupied.get(nextKey);
    if ((occupant && occupant !== agent) || reservedSteps.has(nextKey) || blockedCells.has(nextKey)) continue;
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
        if (shouldLeave) {
          agent.phase = "departed";
          agent.hidden = true;
          occupied.delete(nextKey);
        } else {
          agent.phase = "seated";
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

export function departedGuestIds(agents: readonly GuestAgent[]): string[] {
  return agents.filter((agent) => agent.phase === "departed").map((agent) => agent.guest.id).sort();
}
