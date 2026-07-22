/**
 * 寵物貓行為體(渲染層):讀 sim 層 state.pets 的 hangout(這小時貓待的區域),
 * 在該區域內隨機遊蕩——走幾步、停下來、偶爾睡一覺。
 * 與 agents.ts 同款移動邏輯(尋路 + 逐格插值),但更慢、更隨性。
 */
import { TILE, GRID_W, GRID_H, buildGrid, type Region } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";
import { state } from "../store";
import type { Pet } from "../types";

export interface PetAgent {
  /** state.pets 的 record key(一般貓 = 飼主 id;樓貓 ownerId 是 "landlord" 哨兵,不能當 key) */
  catId: string;
  name: string;
  color: number;
  c: number;
  r: number;
  px: number;
  py: number;
  path: Tile[];
  moving: boolean;
  walkPhase: number;
  /** 現實 ms:停留(或睡覺)到什麼時候才找下一個點 */
  restUntil: number;
  sleeping: boolean;
  facing: 1 | -1;
  pairAction?: Pet["pairAction"];
  pairWith?: string;
  pairLeader: boolean;
}

const GRID = buildGrid();
const SPEED = 26; // px / 秒(比人慢,踱步感)

/** 區域內隨機一個可走格 */
function tileInRegion(region: string, blocked: boolean[][]): Tile | null {
  const cands: Tile[] = [];
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++)
      if (GRID[r][c] === (region as Region) && !blocked[r][c]) cands.push({ c, r });
  return cands.length > 0 ? cands[Math.floor(Math.random() * cands.length)] : null;
}

export function createPetAgents(): PetAgent[] {
  const blocked = currentBlocked();
  return Object.entries(state.pets).map(([catId, pet]) => {
    const t = tileInRegion(pet.hangout, blocked) ?? { c: 7, r: 10 };
    return {
      catId,
      name: pet.name,
      color: pet.color,
      c: t.c,
      r: t.r,
      px: t.c * TILE,
      py: t.r * TILE,
      path: [],
      moving: false,
      walkPhase: 0,
      restUntil: 0,
      sleeping: false,
      facing: 1,
      pairLeader: false,
    };
  });
}

/** 找一格緊鄰另一隻貓、且仍在同區域的可走格。 */
function tileBeside(partner: PetAgent, region: string, blocked: boolean[][]): Tile | null {
  const candidates = [
    { c: partner.c - 1, r: partner.r }, { c: partner.c + 1, r: partner.r },
    { c: partner.c, r: partner.r - 1 }, { c: partner.c, r: partner.r + 1 },
  ];
  return candidates.find((t) => blocked[t.r]?.[t.c] === false && GRID[t.r]?.[t.c] === (region as Region)) ?? null;
}

export function tickPetAgents(agents: PetAgent[], dt: number) {
  const now = Date.now();
  for (const a of agents) {
    const pet = state.pets[a.catId];
    if (!pet) continue; // 貓已離開(呼叫端靠數量變化重建)
    const pairActive = !!pet.pairWith && !!pet.pairAction && (pet.pairUntilMs ?? 0) > state.gameMs;
    const partner = pairActive ? agents.find((x) => x.catId === pet.pairWith) : undefined;
    a.pairAction = partner ? pet.pairAction : undefined;
    a.pairWith = partner?.catId;
    a.pairLeader = !!partner && a.catId.localeCompare(partner.catId) < 0;
    if (!a.moving) {
      if (now < a.restUntil) continue;
      const blocked = currentBlocked();
      let tgt: Tile | null = null;
      if (partner) {
        const follower = !a.pairLeader;
        if (follower) tgt = tileBeside(partner, pet.hangout, blocked);
        if (!follower && pet.pairAction !== "chase") {
          a.sleeping = pet.pairAction === "nap";
          a.restUntil = now + 1200;
          continue;
        }
        if (follower && tgt && Math.abs(tgt.c - a.c) + Math.abs(tgt.r - a.r) <= 1) {
          a.sleeping = pet.pairAction === "nap";
          partner.sleeping = pet.pairAction === "nap";
          a.restUntil = partner.restUntil = now + 3500;
          continue;
        }
      }
      // 一般遊蕩；追逐時領頭貓繼續跑,另一隻追向牠身邊。
      tgt ??= tileInRegion(pet.hangout, blocked);
      const path = tgt && !(tgt.c === a.c && tgt.r === a.r) ? findPath({ c: a.c, r: a.r }, tgt, blocked) : null;
      if (path && path.length > 1) {
        a.path = path.slice(1);
        a.moving = true;
        a.sleeping = false;
      } else {
        a.restUntil = now + 2500 + Math.random() * 3000; // 原地再賴一下
      }
      continue;
    }
    const next = a.path[0];
    if (!next) {
      a.moving = false;
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
        a.sleeping = Math.random() < 0.35; // 到點後偶爾捲成一團睡
        a.restUntil = now + (a.sleeping ? 12000 + Math.random() * 10000 : 3000 + Math.random() * 5000);
      }
    } else {
      a.px += (dx / dist) * step;
      a.py += (dy / dist) * step;
    }
    a.walkPhase += dt * 6;
  }
}
