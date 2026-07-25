/**
 * 掃地機器人行為體(純渲染層):讓 robot_vacuum 家具看起來是一台會在地板上
 * 遊走的活機器 —— 每個遊戲小時輪到一個「區域」走過去,抵達後在附近小幅遊蕩、
 * 眨感應燈、輕微晃動,並且會避讓租客(不與角色疊格)。
 *
 * 避讓分兩層:
 *   1) 被動:下一步的格子有租客站著 → 停一拍等對方走開(vacuumWillYield)。
 *   2) 主動:自己這格擋在某位租客的剩餘路徑上 → 挪去附近不擋路的格(vacuumBlocksTenant
 *      + pickYieldCell)。租客尋路不會繞過掃地機、只會停在原地等,所以少了這一層,
 *      閒置在門口/單一走廊格的掃地機會把租客永久卡住。
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
  /** 正在「主動讓路」的途中;讓路期間不重新判定,避免每幀改主意造成抖動 */
  yielding: boolean;
  /**
   * 累計 tick 秒數(dt 之和)。讓路節流刻意用這個而不是 Date.now():
   * 同一串 (dt, 租客狀態) 輸入必定得到同一串讓路行為 → 無頭測試可重現。
   */
  elapsed: number;
  /** elapsed 到這個值之後才重新判定讓路(防抖 + 沒退路時不必每幀重算 BFS) */
  yieldReadyAt: number;
}

/** 租客在讓路判定裡用到的最小視圖(實務上直接傳 floor/agents 的 Agent) */
export interface VacuumTenantView {
  c: number;
  r: number;
  hidden?: boolean;
  moving?: boolean;
  /** 尚未走完的剩餘路徑(agents.ts 不會繞過掃地機,只會停下來等) */
  path?: readonly Tile[];
}

const GRID: Region[][] = buildGrid();
const SPEED = 22; // px / 秒(比租客 44 慢,像慢慢巡邏)

/** 主動讓路的節流/防抖(單位:tick 累計秒數;純視覺,不影響任何模擬數值) */
const YIELD_RECHECK_S = 0.4; // 觸發判定後的最短重算間隔(含「找不到退路」的情形)
const YIELD_COOLDOWN_S = 0.9; // 讓完路之後的防抖冷卻
const YIELD_RESUME_MS = 700; // 現實 ms:讓完路多久後回頭走向本小時區域目標(沿用既有 wander 時鐘)
/** 退讓格的搜尋半徑(BFS 步數):走廊寬 2 格,4 步足以繞出任何門口/走道 */
const YIELD_RADIUS = 4;

/** 固定的四鄰探索順序 → 所有挑格結果都是確定性的(無 Math.random) */
const DIRS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
] as const;

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

/**
 * 掃地機「現在這格」是否擋住了某位租客。
 *
 * 關鍵前提:租客尋路(agents.ts / pathfind.ts)不把掃地機算進 blocked 網格,
 * 只在真的要踏進去的那一幀停下來等(blockedCells)。所以「我在某位在場租客的
 * 剩餘路徑上」就等於「這位租客遲早會被我卡住」——不必再另外判斷有無替代路徑。
 * 純判定、無副作用、無亂數。
 */
export function vacuumBlocksTenant(cell: Tile, tenants: readonly VacuumTenantView[]): boolean {
  for (const t of tenants) {
    if (t.hidden || !t.moving || !t.path) continue;
    for (const step of t.path) if (step.c === cell.c && step.r === cell.r) return true;
  }
  return false;
}

/**
 * 挑一個「退讓格」:離現在這格最近、可走、沒有租客站著、也不在任何租客路徑上的格。
 *
 * 確定性:BFS 逐層擴散 + 固定的四鄰順序(DIRS)→ 同輸入必定同輸出,無 Math.random。
 * 找不到完全乾淨的格時退而求其次(fallback):至少挑一個能站的空格離開現在這格;
 * 連一格都沒有(四周全是牆/家具/租客)就回傳 null,呼叫端維持原狀、不卡死也不崩潰。
 */
export function pickYieldCell(
  from: Tile,
  blocked: boolean[][],
  tenantCells: ReadonlySet<string>,
  tenantPathCells: ReadonlySet<string>,
  maxRadius = YIELD_RADIUS,
): Tile | null {
  const seen = new Set<string>([`${from.c},${from.r}`]);
  let frontier: Tile[] = [from];
  let fallback: Tile | null = null;
  for (let depth = 1; depth <= maxRadius; depth++) {
    const next: Tile[] = [];
    for (const cur of frontier) {
      for (const [dc, dr] of DIRS) {
        const c = cur.c + dc;
        const r = cur.r + dr;
        const key = `${c},${r}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (blocked[r]?.[c] !== false) continue; // 牆 / 家具 / 界外
        if (tenantCells.has(key)) continue; // 有人站著
        next.push({ c, r });
        if (!tenantPathCells.has(key)) return { c, r }; // 最近的乾淨退讓格
        if (!fallback) fallback = { c, r };
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return fallback;
}

/** blocked 網格 + 租客當下所在格的副本:讓「退讓路徑」本身不會規劃穿過租客 */
function blockedPlusTenants(blocked: boolean[][], tenantCells: ReadonlySet<string>): boolean[][] {
  if (tenantCells.size === 0) return blocked;
  const out = blocked.map((row) => row.slice());
  for (const key of tenantCells) {
    const comma = key.indexOf(",");
    const c = Number(key.slice(0, comma));
    const r = Number(key.slice(comma + 1));
    if (out[r]?.[c] !== undefined) out[r][c] = true;
  }
  return out;
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
      yielding: false,
      elapsed: 0,
      yieldReadyAt: 0, // 一掛載就能主動讓路
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

export function tickVacuumAgents(agents: VacuumAgent[], dt: number, tenants?: readonly VacuumTenantView[]) {
  if (agents.length === 0) return;
  const now = Date.now();
  const hourIdx = gameHourIndex(state.gameMs);
  const list = tenants ?? [];
  const tenantCells = new Set<string>();
  const tenantPathCells = new Set<string>();
  for (const t of list) {
    if (t.hidden) continue;
    tenantCells.add(`${t.c},${t.r}`);
    if (t.moving && t.path) for (const s of t.path) tenantPathCells.add(`${s.c},${s.r}`);
  }

  for (const a of agents) {
    a.elapsed += dt;

    // 換小時 → 換一個區域,走過去(確定性挑目標格)
    if (hourIdx !== a.lastHourIdx) {
      a.lastHourIdx = hourIdx;
      a.wanderSeq = 0;
      a.yielding = false;
      const blocked = currentBlocked();
      const area = vacuumTargetArea(hourIdx);
      routeTo(a, pickAreaCell(area, hourIdx, blocked), blocked);
    }

    // 主動讓路:自己這格擋在某位租客的路徑上 → 立刻挪去附近不擋路的格。
    // 沒在讓路中才判定(讓路途中不改主意 → 不抖動);冷卻避免每幀重算 BFS。
    if (!a.yielding && a.elapsed >= a.yieldReadyAt && vacuumBlocksTenant({ c: a.c, r: a.r }, list)) {
      a.yieldReadyAt = a.elapsed + YIELD_RECHECK_S;
      const blocked = currentBlocked();
      const goal = pickYieldCell({ c: a.c, r: a.r }, blocked, tenantCells, tenantPathCells);
      // 退讓路徑本身也不穿過租客;沒有退讓格(或走不到)就維持原狀,照舊跑既有邏輯
      if (goal && routeTo(a, goal, blockedPlusTenants(blocked, tenantCells))) a.yielding = true;
    }

    if (a.moving) {
      const next = a.path[0];
      if (!next) {
        a.moving = false;
        a.yielding = false; // 路徑莫名空了也要把讓路狀態收乾淨,否則之後永遠不再判定讓路
        continue;
      }
      // 避讓租客:下一格有人 → 這一拍先停,對方走開後自然續走(不疊格、不穿人)
      if (vacuumWillYield(next, tenantCells)) {
        // 但「讓路途中被租客站上退路」會變成雙方互等 → 永久卡住。
        // 這時丟掉這條退路,下一幀依最新位置重算新的退讓格,主動打破死鎖。
        if (a.yielding) {
          a.yielding = false;
          a.path = [];
          a.moving = false;
          a.yieldReadyAt = 0; // 立刻允許重算(不必等節流)
        }
        continue;
      }
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
          if (a.yielding) {
            // 讓完路:短暫冷卻防抖,然後很快就回頭走向本小時的區域目標(不會卡在退路上)
            a.yielding = false;
            a.yieldReadyAt = a.elapsed + YIELD_COOLDOWN_S;
            a.wanderAt = now + YIELD_RESUME_MS;
          } else {
            a.wanderAt = now + 2200; // 抵達後歇一下再就近巡
          }
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
