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

function sameTile(a: Tile | null, b: Tile | null) {
  return (!a && !b) || (!!a && !!b && a.c === b.c && a.r === b.r);
}

export function createAgents(): Agent[] {
  return Object.values(state.runtimes).map((rt) => {
    const t = rt.targetTile;
    const c = t?.c ?? 7;
    const r = t?.r ?? 10;
    return {
      tenantId: rt.tenant.id,
      c,
      r,
      px: c * TILE,
      py: r * TILE,
      path: [],
      goal: t ?? null,
      moving: false,
      hidden: rt.tenant.visualState === "away" || !t,
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

export function tickAgents(agents: Agent[], dt: number) {
  for (const a of agents) {
    const rt = state.runtimes[a.tenantId];
    // 互動 session(§10-6)覆寫走位:走到互動錨點;🔞 遮蔽式 pose 直接隱藏 sprite
    const ses = rt && rt.tenant.visualState !== "away" ? sessionFor(a.tenantId, state.gameMs) : null;
    let target = ses?.tile ?? rt?.activityTile ?? rt?.targetTile ?? null;
    a.hidden = !rt || rt.tenant.visualState === "away" || !target || ses?.pose === "hidden";
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
    if (a.hidden) {
      a.moving = false;
      continue;
    }

    // 家具座位錨點(§10-6):session 目標若是家具佔用格(沙發/床),先走到最近可走鄰格,
    // 抵達後再「跨上去」坐/躺(不用尋路穿越家具、也絕不瞬移)。
    const blocked = currentBlocked();
    let snapTile: Tile | null = null;
    if ((ses || rt?.activityTile) && target && blocked[target.r]?.[target.c] && !(a.c === target.c && a.r === target.r)) {
      snapTile = target;
      target = nearestWalkableNeighbor(target, a, blocked);
      if (!target) snapTile = null; // 四鄰全被擋:留在原地照常演
    }
    if (snapTile && target && a.c === target.c && a.r === target.r && !a.moving) {
      stepOnto(a, snapTile); // 已站在家具旁 → 直接跨上去
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
      const nx = next.c * TILE;
      const ny = next.r * TILE;
      const dx = nx - a.px;
      const dy = ny - a.py;
      const dist = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (dist <= step) {
        a.px = nx;
        a.py = ny;
        a.c = next.c;
        a.r = next.r;
        a.path.shift();
        if (a.path.length === 0) {
          a.moving = false;
          if (snapTile) stepOnto(a, snapTile); // 走到家具旁的同一刻跨上去(無頭模擬也同步)
        }
      } else {
        a.px += (dx / dist) * step;
        a.py += (dy / dist) * step;
      }
      a.walkPhase += dt * 7;
    }
  }
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
