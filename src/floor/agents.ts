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
    };
  });
}

export function tickAgents(agents: Agent[], dt: number) {
  for (const a of agents) {
    const rt = state.runtimes[a.tenantId];
    // 互動 session(§10-6)覆寫走位:走到互動錨點;🔞 遮蔽式 pose 直接隱藏 sprite
    const ses = rt && rt.tenant.visualState !== "away" ? sessionFor(a.tenantId, state.gameMs) : null;
    const target = ses?.tile ?? rt?.targetTile ?? null;
    a.hidden = !rt || rt.tenant.visualState === "away" || !target || ses?.pose === "hidden";
    a.pose = ses?.pose ?? null;
    a.vs = rt?.tenant.visualState ?? "idle";
    if (a.hidden) {
      a.moving = false;
      continue;
    }

    // 目標改變 → 重新尋路
    if (!sameTile(target, a.goal)) {
      a.goal = target;
      const path = findPath({ c: a.c, r: a.r }, target!, currentBlocked());
      if (path && path.length > 1) {
        a.path = path.slice(1);
        a.moving = true;
      } else if (path && path.length === 1) {
        // 已在目標格
        a.path = [];
        a.moving = false;
      } else {
        // 走不到(目標被擋):留在原地,絕不瞬移進牆
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
        if (a.path.length === 0) a.moving = false;
      } else {
        a.px += (dx / dist) * step;
        a.py += (dy / dist) * step;
      }
      a.walkPhase += dt * 7;
    }
  }
}
