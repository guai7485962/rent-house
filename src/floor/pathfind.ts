/**
 * 網格尋路(BFS)+ 障礙格
 * 障礙 = 牆 或 被家具佔用的格(地毯/地墊除外)。
 * 之後 AI 驅動走路、或玩家指令都共用這裡。
 */
import { GRID_W, GRID_H, buildGrid, isWalkable } from "./map";
import { getDef } from "../furniture/catalog";
import { getPlacements, placements } from "../sim/placements";

export interface Tile {
  c: number;
  r: number;
}

/** true = 不可通行 */
export function buildBlocked(): boolean[][] {
  const grid = buildGrid();
  const blocked = grid.map((row) => row.map((cell) => !isWalkable(cell)));
  for (const p of getPlacements()) {
    const def = getDef(p.defId);
    // 地毯/地墊平貼地面,不擋路
    if ("kind" in def.sprite && (def.sprite.kind === "rug" || def.sprite.kind === "mat")) {
      continue;
    }
    for (let dr = 0; dr < def.footprint.h; dr++) {
      for (let dc = 0; dc < def.footprint.w; dc++) {
        const c = p.c + dc;
        const r = p.r + dr;
        if (r >= 0 && r < GRID_H && c >= 0 && c < GRID_W) blocked[r][c] = true;
      }
    }
  }
  return blocked;
}

// 障礙格快取:家具版本改變才重算
let _cache: boolean[][] | null = null;
let _cacheV = -1;
export function currentBlocked(): boolean[][] {
  if (_cache === null || _cacheV !== placements.version) {
    _cache = buildBlocked();
    _cacheV = placements.version;
  }
  return _cache;
}

/** BFS 最短路徑(含起點與終點的格序列);走不到回傳 null */
export function findPath(start: Tile, goal: Tile, blocked: boolean[][]): Tile[] | null {
  if (blocked[goal.r]?.[goal.c]) return null;
  if (start.c === goal.c && start.r === goal.r) return [start];

  const key = (c: number, r: number) => r * GRID_W + c;
  const came = new Map<number, number>();
  came.set(key(start.c, start.r), -1);
  const queue: Tile[] = [start];
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.c === goal.c && cur.r === goal.r) {
      const path: Tile[] = [];
      let k: number = key(cur.c, cur.r);
      while (k !== -1) {
        const c = k % GRID_W;
        const r = (k - c) / GRID_W;
        path.push({ c, r });
        k = came.get(k)!;
      }
      return path.reverse();
    }
    for (const [dc, dr] of dirs) {
      const nc = cur.c + dc;
      const nr = cur.r + dr;
      if (nc < 0 || nc >= GRID_W || nr < 0 || nr >= GRID_H) continue;
      if (blocked[nr][nc]) continue;
      const nk = key(nc, nr);
      if (came.has(nk)) continue;
      came.set(nk, key(cur.c, cur.r));
      queue.push({ c: nc, r: nr });
    }
  }
  return null;
}
