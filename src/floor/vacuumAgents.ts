/**
 * 掃地機器人行為體(純渲染層):讓 robot_vacuum 家具看起來是一台會在地板上
 * 遊走的活機器 —— 每個遊戲小時輪到一個「區域」走過去,抵達後在附近小幅遊蕩、
 * 眨感應燈、輕微晃動,並且會避讓租客(不與角色疊格)。
 *
 * 這一層「純粹是外觀」:完全不碰整潔/舒適/經濟/tick 模擬。robot_vacuum 的機械效果
 * (cleanPower → cleanlinessBaseline,見 comfort.ts)照舊只作用在它被擺放的那間房,
 * 位移不會額外結算任何整潔。位置是暫態的(每次掛載重生,和 pets/agents 一樣,不持久化)。
 *
 * 移動邏輯沿用 agents.ts / petAgents.ts 同款:findPath 逐格插值。
 * 每小時的「區域」選擇是「確定性」的(遊戲時鐘的函式,無 Math.random),方便測試重現。
 */
import { TILE, GRID_W, GRID_H, buildGrid, type Region, type Placement } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";
import { getDef } from "../furniture/catalog";
import { getPlacements, placementInteract } from "../sim/placements";
import { MS_PER_GAME_HOUR } from "../sim/clock";
import { state } from "../store";

export interface VacuumAgent {
  /** 對應的家具擺放(座標即「基地/充電座」),用來重建與去重 */
  key: string;
  defId: string;
  c: number;
  r: number;
  px: number;
  py: number;
  path: Tile[];
  moving: boolean;
  facing: 1 | -1;
  /** 上一次據以選定「本小時區域」的遊戲小時序號;變了才換區域 */
  lastHourIdx: number;
  /** 現實 ms:閒置時到這個時間才會就近再走一小段(看起來一直在動) */
  wanderAt: number;
  /** 閒置小遊蕩的序號(確定性挑格用,非隨機) */
  wanderSeq: number;
}

const GRID: Region[][] = buildGrid();
const SPEED = 22; // px / 秒(比租客 44 慢,像慢慢巡邏)

/**
 * 每小時輪替的「區域」清單:四間套房 + 浴室 + 洗衣間 + 交誼廳。
 * 順序固定 → 輪替結果可重現(測試靠這份順序斷言)。
 */
export const VACUUM_AREAS: readonly Region[] = [
  "r301",
  "lounge",
  "r302",
  "bathroom",
  "r303",
  "laundry",
  "r304",
] as const;

/** robot_vacuum(或任何有 cleanPower 的自動清潔家具)判定 */
export function isVacuumDef(defId: string): boolean {
  const def = getDef(defId);
  return (def.cleanPower ?? 0) > 0 || ("kind" in def.sprite && def.sprite.kind === "robot_vacuum");
}

function vacuumPlacements(): Placement[] {
  return getPlacements().filter((p) => isVacuumDef(p.defId));
}

/** 遊戲時鐘 → 單調遞增的「遊戲小時序號」(確定性區域輪替的輸入) */
export function gameHourIndex(gameMs: number): number {
  return Math.floor(gameMs / MS_PER_GAME_HOUR);
}

/** 給定遊戲小時序號 → 這一小時該去的區域(確定性,同輸入同輸出,逐時輪替) */
export function vacuumTargetArea(hourIdx: number): Region {
  const n = VACUUM_AREAS.length;
  // 取正餘數,避免負序號(理論上不會發生)造成 NaN 索引
  const i = ((hourIdx % n) + n) % n;
  return VACUUM_AREAS[i];
}

/** 區域內、依 seed 確定性挑一個可走格(無 Math.random);全被擋回傳 null */
export function pickAreaCell(area: Region, seed: number, blocked: boolean[][]): Tile | null {
  const cands: Tile[] = [];
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++)
      if (GRID[r][c] === area && !blocked[r]?.[c]) cands.push({ c, r });
  if (cands.length === 0) return null;
  const i = ((seed % cands.length) + cands.length) % cands.length;
  return cands[i];
}

/** 掃地機下一步若踩到租客所在格 → 該讓(等一拍)。純函式,供避讓邏輯與測試共用。 */
export function vacuumWillYield(next: Tile, tenantCells: ReadonlySet<string>): boolean {
  return tenantCells.has(`${next.c},${next.r}`);
}

/** 家具基地格四周(含自身)找一個可走格當出發點 */
function spawnCell(dock: Placement, blocked: boolean[][]): Tile {
  const interact = placementInteract(dock);
  if (blocked[interact.r]?.[interact.c] === false) return interact;
  for (let radius = 1; radius <= 6; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const c = dock.c + dc;
        const r = dock.r + dr;
        if (blocked[r]?.[c] === false) return { c, r };
      }
    }
  }
  return { c: dock.c, r: dock.r };
}

export function createVacuumAgents(): VacuumAgent[] {
  const blocked = currentBlocked();
  const hourIdx = gameHourIndex(state.gameMs);
  return vacuumPlacements().map((p) => {
    const t = spawnCell(p, blocked);
    return {
      key: `${p.room}:${p.c}:${p.r}`,
      defId: p.defId,
      c: t.c,
      r: t.r,
      px: t.c * TILE,
      py: t.r * TILE,
      path: [],
      moving: false,
      facing: 1,
      lastHourIdx: hourIdx,
      wanderAt: 0, // 立刻就會就近走一段 → 一掛載就有動態
      wanderSeq: 0,
    };
  });
}

/** 家具版本改變(買/賣/移動掃地機)時重建渲染 agent。 */
export function vacuumAgentSignature(): string {
  return vacuumPlacements()
    .map((p) => `${p.room}:${p.c}:${p.r}:${p.defId}`)
    .sort()
    .join("|");
}

/** 本幀所有掃地機當前所在格(給租客避讓用:租客不踏進這些格) */
export function vacuumCellKeys(agents: VacuumAgent[]): Set<string> {
  return new Set(agents.map((a) => `${a.c},${a.r}`));
}

/** 挑一個目標並鋪路;成功回傳 true */
function routeTo(a: VacuumAgent, goal: Tile | null, blocked: boolean[][]): boolean {
  if (!goal || (goal.c === a.c && goal.r === a.r)) return false;
  const path = findPath({ c: a.c, r: a.r }, goal, blocked);
  if (path && path.length > 1) {
    a.path = path.slice(1);
    a.moving = true;
    return true;
  }
  return false;
}

export function tickVacuumAgents(agents: VacuumAgent[], dt: number, tenants?: { c: number; r: number; hidden?: boolean }[]) {
  if (agents.length === 0) return;
  const now = Date.now();
  const hourIdx = gameHourIndex(state.gameMs);
  const tenantCells = new Set<string>();
  for (const t of tenants ?? []) if (!t.hidden) tenantCells.add(`${t.c},${t.r}`);

  for (const a of agents) {
    // 換小時 → 換一個區域,走過去(確定性挑目標格)
    if (hourIdx !== a.lastHourIdx) {
      a.lastHourIdx = hourIdx;
      a.wanderSeq = 0;
      const blocked = currentBlocked();
      const area = vacuumTargetArea(hourIdx);
      routeTo(a, pickAreaCell(area, hourIdx, blocked), blocked);
    }

    if (a.moving) {
      const next = a.path[0];
      if (!next) {
        a.moving = false;
        continue;
      }
      // 避讓租客:下一格有人 → 這一拍先停,對方走開後自然續走(不疊格、不穿人)
      if (vacuumWillYield(next, tenantCells)) continue;
      const nx = next.c * TILE;
      const ny = next.r * TILE;
      const dx = nx - a.px;
      const dy = ny - a.py;
      if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1;
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
          a.wanderAt = now + 2200; // 抵達後歇一下再就近巡
        }
      } else {
        a.px += (dx / dist) * step;
        a.py += (dy / dist) * step;
      }
      continue;
    }

    // 閒置:待在本小時區域內,每隔一段就就近再走一小段(確定性挑格,看起來一直在巡)。
    if (now >= a.wanderAt) {
      a.wanderSeq++;
      const blocked = currentBlocked();
      const area = vacuumTargetArea(a.lastHourIdx);
      // 用 (小時序號, 遊蕩序號) 組合當 seed → 無隨機、但每次挑到不同格
      const goal = pickAreaCell(area, a.lastHourIdx * 31 + a.wanderSeq * 7, blocked);
      const moved = routeTo(a, goal, blocked);
      a.wanderAt = now + (moved ? 2600 : 1500) + (a.wanderSeq % 4) * 500;
    }
  }
}
