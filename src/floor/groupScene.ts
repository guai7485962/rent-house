/**
 * 群體場景導演：讓 3～4 位房客在劇情提到的地點真正同框。
 *
 * 與 pairSession 一樣只保存短暫走位；數值與長期敘事仍由 sim 模組負責。
 * 場景同時用現實時間與遊戲時間過期，避免快轉後人物還卡在演出中。
 * 演員會留下姓名與配色快照，所以歡送會在 moveOut 後仍能畫出離開者。
 */
import type { Tile } from "./pathfind";
import { currentBlocked } from "./pathfind";
import { LOUNGE_HALL_RECT } from "./map";
import { clearPairSessionsFor, type PairPose } from "./pairSession";
import { spawnFx, type FxKind } from "./fx";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "../sim/clock";
import { state } from "../sim/gameState";
import { getTheme } from "../pixel/scene";

export type GroupSceneVenue = "lounge" | "rooftop";
export type GroupSceneLayout = "cluster" | "table" | "watch" | "storm" | "farewell";

export interface GroupSceneActor {
  tenantId: string;
  name: string;
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
  tile: Tile | null;
  pose: PairPose;
}

export interface GroupScene {
  id: string;
  title: string;
  venue: GroupSceneVenue;
  layout: GroupSceneLayout;
  actors: GroupSceneActor[];
  until: number;
  gameUntil: number;
  priority: number;
}

export interface StartGroupScene {
  id: string;
  title: string;
  venue: GroupSceneVenue;
  layout: GroupSceneLayout;
  participantIds: string[];
  gameNow?: number;
  durationMs?: number;
  durationHours?: number;
  fx?: FxKind;
  /** 日常社群=1、月度章節=2、歡送會=3；較低層級不能蓋掉較重要的場景。 */
  priority?: number;
}

let active: GroupScene | null = null;

function prune(gameNow: number) {
  if (active && (active.until <= Date.now() || active.gameUntil <= gameNow)) active = null;
}

function anchorFor(layout: GroupSceneLayout): Tile {
  if (layout === "table") return { c: 3, r: 12 };
  if (layout === "watch") return { c: 11, r: 12 };
  return { c: 8, r: 11 };
}

/** 依固定距離排序挑走位，不使用 RNG，確保測試與平衡亂數序列不被畫面影響。 */
function loungeTiles(count: number, layout: GroupSceneLayout): Tile[] {
  const blocked = currentBlocked();
  const anchor = anchorFor(layout);
  const open: Tile[] = [];
  for (let r = LOUNGE_HALL_RECT.r0; r <= LOUNGE_HALL_RECT.r1; r++) {
    for (let c = LOUNGE_HALL_RECT.c0; c <= LOUNGE_HALL_RECT.c1; c++) {
      if (blocked[r]?.[c] === false) open.push({ c, r });
    }
  }
  open.sort((a, b) => {
    const da = Math.abs(a.c - anchor.c) + Math.abs(a.r - anchor.r);
    const db = Math.abs(b.c - anchor.c) + Math.abs(b.r - anchor.r);
    return da - db || a.r - b.r || a.c - b.c;
  });
  return open.slice(0, count);
}

function poseFor(layout: GroupSceneLayout): PairPose {
  if (layout === "farewell") return "stand_face";
  return "pair";
}

export function startGroupScene(input: StartGroupScene): boolean {
  const gameNow = input.gameNow ?? state.gameMs;
  prune(gameNow);
  const priority = input.priority ?? 1;
  if (active && active.priority > priority) return false;

  const ids = [...new Set(input.participantIds)].filter((id) => !!state.runtimes[id]);
  if (ids.length === 0) return false;
  const tiles = input.venue === "lounge" ? loungeTiles(ids.length, input.layout) : [];
  if (input.venue === "lounge" && tiles.length < ids.length) return false;

  clearPairSessionsFor(ids);
  const pose = poseFor(input.layout);
  const actors = ids.map((tenantId, index): GroupSceneActor => {
    const rt = state.runtimes[tenantId]!;
    const theme = getTheme(tenantId);
    return {
      tenantId,
      name: rt.tenant.name,
      hair: theme.hair,
      shirt: theme.shirt,
      pants: theme.pants,
      skin: theme.skin,
      tile: input.venue === "lounge" ? tiles[index] : null,
      pose,
    };
  });
  const durationHours = input.durationHours ?? 1;
  const durationMs = input.durationMs ?? REAL_MS_PER_GAME_HOUR;
  active = {
    id: input.id,
    title: input.title,
    venue: input.venue,
    layout: input.layout,
    actors,
    until: Date.now() + durationMs,
    gameUntil: gameNow + durationHours * MS_PER_GAME_HOUR,
    priority,
  };
  if (input.fx && tiles[0]) {
    spawnFx(input.fx, tiles[0].c, tiles[0].r, durationMs, active.gameUntil);
  }
  return true;
}

/** FloorMap 直接讀這份 actor snapshot；即使 moveOut 已刪 runtime，歡送畫面仍完整。 */
export function groupSceneView(gameNow = state.gameMs): GroupScene | null {
  prune(gameNow);
  return active;
}

/** agents 的最高層走位覆寫；天台與歡送小舞台會隱藏主平面的重複 sprite。 */
export function groupSceneFor(
  tenantId: string,
  gameNow: number,
): { tile: Tile | null; pose: PairPose; hidden: boolean } | null {
  prune(gameNow);
  const actor = active?.actors.find((entry) => entry.tenantId === tenantId);
  if (!actor || !active) return null;
  return {
    tile: actor.tile,
    pose: actor.pose,
    hidden: active.venue === "rooftop" || active.layout === "farewell",
  };
}

export function clearGroupScene() {
  active = null;
}
