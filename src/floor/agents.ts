/**
 * 租客行為體(Agent):讀 store 每位租客的「當前活動目標家具格」,走過去,停下。
 *
 * 不再隨機漫遊——目標由作息系統(store.hourlyTick)決定。
 * 大多時間靜止在活動點;只有換小時、活動改變時才走動。
 * 外出(away)時隱藏。
 */
import { TILE } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";
import { sessionFor, type PairPose } from "./pairSession";
import { state } from "../store";
import type { TenantVisualState } from "../types";
import type { FurnitureRotation } from "../furniture/rotation";
import { furnitureAt, placementFootprint } from "../sim/placements";

export interface Agent {
  tenantId: string;
  c: number;
  r: number;
  px: number;
  py: number;
  path: Tile[];
  goal: Tile | null; // 目前前往/已抵達的目標
  moving: boolean;
  hidden: boolean; // away 時隱藏
  walkPhase: number;
  /** 當前 visual_state(環境演出用:睡覺 Zzz、直播音符、洗澡蒸氣) */
  vs: TenantVisualState;
  /** 進行中互動 session 的圖式(§10-6:sit 坐/lie 躺;null = 無 session) */
  pose: PairPose | null;
  /** stand_face 的水平朝向:-1 左、1 右;其他姿勢為 0 */
  facing: -1 | 0 | 1;
  /** 單人日常姿勢的家具方向；雙人 session 維持 0。 */
  poseRotation: FurnitureRotation;
  /** 家具姿勢的繪製位移；行走仍以可尋路的整數格為準，抵達後才置中到家具。 */
  poseOffsetX: number;
  poseOffsetY: number;
  /** 桌前／電視前沒有實體座椅時，在角色後方補畫工作椅。 */
  seatBack: boolean;
}

const SPEED = 44; // px / 秒
const EMPTY_BLOCKED: ReadonlySet<string> = new Set();

function sameTile(a: Tile | null, b: Tile | null) {
  return (!a && !b) || (!!a && !!b && a.c === b.c && a.r === b.r);
}

export function createAgents(): Agent[] {
  const blocked = currentBlocked();
  const claimed = new Set<string>();
  return Object.values(state.runtimes).map((rt) => {
    const t = rt.targetTile;
    const hidden = rt.tenant.visualState === "away" || !t;
    const spawn = t && !hidden ? claimCrowdTarget(t, claimed, blocked) : t;
    const c = spawn?.c ?? 7;
    const r = spawn?.r ?? 10;
    return {
      tenantId: rt.tenant.id,
      c,
      r,
      px: c * TILE,
      py: r * TILE,
      path: [],
      goal: spawn,
      moving: false,
      hidden,
      walkPhase: 0,
      vs: rt.tenant.visualState,
      pose: null,
      facing: 0,
      poseRotation: 0,
      poseOffsetX: 0,
      poseOffsetY: 0,
      seatBack: false,
    };
  });
}

/**
 * @param blockedCells 額外「不可踏入」的格(key = "c,r")。目前用於掃地機器人:
 *   租客不會走上掃地機當下所在格(避免視覺疊格)。等掃地機離開,下一幀自然續走。
 *   純外觀避讓,不影響任何作息/模擬邏輯;預設空集合 → 對既有行為零改變。
 */
export function tickAgents(agents: Agent[], dt: number, blockedCells: ReadonlySet<string> = EMPTY_BLOCKED) {
  const blocked = currentBlocked();
  const claimedTargets = new Set<string>();
  const occupied = new Map<string, Agent>();
  const reservedSteps = new Set<string>();
  for (const a of agents) if (!a.hidden) occupied.set(tileKey(a), a);

  // 先替本幀所有角色分配不重複的演出目標。一般作息偶爾會讓多人拿到同一個
  // 共用家具錨點；第二人起改站附近空格，避免抵達後疊成一個 sprite。
  const plans = agents.map((a) => {
    const rt = state.runtimes[a.tenantId];
    // 互動 session(§10-6)覆寫走位:走到互動錨點;🔞 遮蔽式 pose 直接隱藏 sprite
    const ses = rt && rt.tenant.visualState !== "away" ? sessionFor(a.tenantId, state.gameMs) : null;
    const desired = ses?.tile ?? rt?.activityTile ?? rt?.targetTile ?? null;
    a.hidden = !rt || rt.tenant.visualState === "away" || !desired || ses?.pose === "hidden";
    a.pose = ses?.pose ?? rt?.activityPose ?? null;
    a.facing = ses?.facing ?? 0;
    a.poseRotation = ses ? 0 : rt?.activityRotation ?? 0;
    a.poseOffsetX = 0;
    a.poseOffsetY = 0;
    if (!ses && rt?.activitySurface === "furniture" && rt.activityTile && a.pose === "lie") {
      const furniture = furnitureAt(rt.activityTile.c, rt.activityTile.r);
      if (furniture) {
        const fp = placementFootprint(furniture);
        // activityTile 必須是整數格才能尋路；畫面則以完整家具中心校正，
        // 避免 2×2 床上的角色縮在最靠走道的角落。
        a.poseOffsetX = (furniture.c + fp.w / 2) * TILE - TILE / 2 - rt.activityTile.c * TILE;
        a.poseOffsetY = (furniture.r + fp.h / 2) * TILE - TILE / 2 - rt.activityTile.r * TILE;
      }
    }
    a.seatBack = !ses && rt?.activitySurface === "chair";
    a.vs = rt?.tenant.visualState ?? "idle";
    const target = !a.hidden && desired ? claimCrowdTarget(desired, claimedTargets, blocked) : null;
    return { a, rt, ses, target };
  });

  for (const { a, rt, ses, target: plannedTarget } of plans) {
    let target = plannedTarget;
    if (a.hidden) {
      a.moving = false;
      continue;
    }

    // 家具座位錨點(§10-6):session 目標若是家具佔用格(沙發/床),先走到最近可走鄰格,
    // 抵達後再「跨上去」坐/躺(不用尋路穿越家具、也絕不瞬移)。
    let snapTile: Tile | null = null;
    if ((ses || rt?.activityTile) && target && blocked[target.r]?.[target.c] && !(a.c === target.c && a.r === target.r)) {
      snapTile = target;
      target = nearestWalkableNeighbor(target, a, blocked);
      if (!target) snapTile = null; // 四鄰全被擋:留在原地照常演
    }
    if (snapTile && target && a.c === target.c && a.r === target.r && !a.moving) {
      if (!occupiedByOther(snapTile, a, occupied)) {
        moveOccupancy(a, snapTile, occupied);
        stepOnto(a, snapTile); // 已站在家具旁 → 直接跨上去
      }
      continue;
    }

    // 目標改變 → 重新尋路
    if (!sameTile(target, a.goal)) {
      a.goal = target;
      const path = target && blocked[target.r]?.[target.c] === false ? findPath({ c: a.c, r: a.r }, target, blocked) : null;
      if (path && path.length > 1) {
        a.path = path.slice(1);
        a.moving = true;
      } else {
        // 已在目標格,或走不到(目標被擋):留在原地,絕不瞬移進牆
        a.path = [];
        a.moving = false;
      }
    }

    if (a.moving) {
      const next = a.path[0];
      if (!next) {
        a.moving = false;
        continue;
      }
      // 另一人仍站在下一格時先讓一步；角色離開後下一幀自然繼續。
      // 這也封住兩條路徑在窄走道同時進入同一格的視覺穿模。
      const nextKey = tileKey(next);
      if (occupiedByOther(next, a, occupied) || reservedSteps.has(nextKey) || blockedCells.has(nextKey)) continue;
      reservedSteps.add(nextKey);
      const nx = next.c * TILE;
      const ny = next.r * TILE;
      const dx = nx - a.px;
      const dy = ny - a.py;
      const dist = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (dist <= step) {
        moveOccupancy(a, next, occupied);
        a.px = nx;
        a.py = ny;
        a.c = next.c;
        a.r = next.r;
        a.path.shift();
        if (a.path.length === 0) {
          a.moving = false;
          if (snapTile && !occupiedByOther(snapTile, a, occupied)) {
            moveOccupancy(a, snapTile, occupied);
            stepOnto(a, snapTile); // 走到家具旁的同一刻跨上去(無頭模擬也同步)
          }
        }
      } else {
        a.px += (dx / dist) * step;
        a.py += (dy / dist) * step;
      }
      a.walkPhase += dt * 7;
    }
  }
}

function tileKey(t: Tile) {
  return `${t.c},${t.r}`;
}

function occupiedByOther(t: Tile, a: Agent, occupied: Map<string, Agent>) {
  const other = occupied.get(tileKey(t));
  return !!other && other !== a && !other.hidden;
}

function moveOccupancy(a: Agent, next: Tile, occupied: Map<string, Agent>) {
  const oldKey = tileKey(a);
  if (occupied.get(oldKey) === a) occupied.delete(oldKey);
  occupied.set(tileKey(next), a);
}

/**
 * 同一目標被先到者占用時，在附近找最近的可走空格。
 * 搜尋順序固定，畫面與測試都可重現；半徑 4 足以涵蓋共用家具周邊。
 */
function claimCrowdTarget(desired: Tile, claimed: Set<string>, blocked: boolean[][]): Tile {
  const desiredKey = tileKey(desired);
  if (!claimed.has(desiredKey)) {
    claimed.add(desiredKey);
    return { ...desired };
  }
  for (let radius = 1; radius <= 4; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      const dc = radius - Math.abs(dr);
      for (const signedDc of dc === 0 ? [0] : [-dc, dc]) {
        const t = { c: desired.c + signedDc, r: desired.r + dr };
        const key = tileKey(t);
        if (claimed.has(key) || blocked[t.r]?.[t.c] !== false) continue;
        claimed.add(key);
        return t;
      }
    }
  }
  // 極端擁擠時仍保留原目標；動態格位阻擋會防止兩人同時踏入。
  claimed.add(desiredKey);
  return { ...desired };
}

/** 跨上家具格(坐上沙發/躺上床):位置直接落格,goal 設為該格避免下一幀重新尋路 */
function stepOnto(a: Agent, t: Tile) {
  a.c = t.c;
  a.r = t.r;
  a.px = t.c * TILE;
  a.py = t.r * TILE;
  a.goal = { ...t };
  a.path = [];
  a.moving = false;
}

/** 目標格四鄰中可走、且離 agent 最近的一格 */
function nearestWalkableNeighbor(t: Tile, a: Agent, blocked: boolean[][]): Tile | null {
  let best: Tile | null = null;
  let bestDist = Infinity;
  for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    const c = t.c + dc;
    const r = t.r + dr;
    if (blocked[r]?.[c] !== false) continue;
    const d = Math.abs(c - a.c) + Math.abs(r - a.r);
    if (d < bestDist) {
      bestDist = d;
      best = { c, r };
    }
  }
  return best;
}
