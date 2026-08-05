/**
 * 寵物行為體(渲染層):讀 sim 層 state.pets 的 hangout,
 * 在該區域內隨機遊蕩——走幾步、停下來、偶爾睡一覺。咖啡廳開張後，
 * 永久樓寵物白天會依穩定時段判定走到 cafe_pet，不改 sim 層 hangout。
 * 與 agents.ts 同款移動邏輯(尋路 + 逐格插值),但更慢、更隨性。
 */
import { TILE, GRID_W, GRID_H, buildGrid, type Region } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";
import { state } from "../store";
import { cafeGuestHash } from "../sim/cafeGuests";
import { isShopCat } from "../sim/pets";
import type { Pet, PetKind } from "../types";

export interface PetAgent {
  /** state.pets 的 record key(一般寵物 = 飼主 id;公寓寵物 ownerId 是 landlord) */
  petId: string;
  name: string;
  kind: PetKind;
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
export const CAFE_PET_VISIT_START_HOUR = 10;
export const CAFE_PET_VISIT_END_HOUR = 16;
export const CAFE_PET_VISIT_PERCENT = 35;

/**
 * 店貓「辣椒」的一樓時段：她是店裡的員工，白天大半時間都該在店裡，
 * 所以窗口比訪客型樓寵物寬（08–21）、比例也高（55%）。
 * 剩下的時間她在三樓 `pet.hangout`（套房／交誼廳／浴室／洗衣間）——
 * 兩邊合起來就是使用者要的「整棟樓各地溜達」。
 */
export const SHOP_CAT_CAFE_START_HOUR = 8;
export const SHOP_CAT_CAFE_END_HOUR = 21;
export const SHOP_CAT_CAFE_PERCENT = 55;

/**
 * CAFE-22：只改渲染目的地，不改 Pet.hangout 或任何 sim 狀態。
 * 同一寵物、同一遊戲小時永遠得到相同結果，避免多呼叫 Math.random 擾動既有演出。
 *
 * 店貓沿用同一條路（同一個雜湊、同一個 `cafe_pet` 目的地），只是換窗口與比例；
 * 沒有第二套跨樓層尋路。
 */
export function petAgentRegion(
  petId: string,
  pet: Pet,
  gameMs = state.gameMs,
  cafeOpen = state.cafe.open,
): string {
  const permanentHousePet = pet.ownerId === "landlord"
    && (pet.housePlacement ?? "permanent") === "permanent";
  const pairActive = !!pet.pairWith && !!pet.pairAction && (pet.pairUntilMs ?? 0) > gameMs;
  const time = new Date(gameMs);
  const hour = time.getHours();
  if (!cafeOpen || pairActive) return pet.hangout;
  const hourKey = `${time.getFullYear()}-${time.getMonth() + 1}-${time.getDate()}-${hour}`;
  if (isShopCat(pet)) {
    if (hour < SHOP_CAT_CAFE_START_HOUR || hour >= SHOP_CAT_CAFE_END_HOUR) return pet.hangout;
    return cafeGuestHash(`${petId}|${hourKey}|shop_cat`) % 100 < SHOP_CAT_CAFE_PERCENT
      ? "cafe_pet"
      : pet.hangout;
  }
  if (!permanentHousePet
    || hour < CAFE_PET_VISIT_START_HOUR || hour >= CAFE_PET_VISIT_END_HOUR) {
    return pet.hangout;
  }
  return cafeGuestHash(`${petId}|${hourKey}|cafe_pet`) % 100 < CAFE_PET_VISIT_PERCENT
    ? "cafe_pet"
    : pet.hangout;
}

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
  return Object.entries(state.pets).filter(([, pet]) => pet.housePlacement !== "partner_foster").map(([petId, pet]) => {
    const t = tileInRegion(petAgentRegion(petId, pet), blocked) ?? { c: 7, r: 10 };
    return {
      petId,
      name: pet.name,
      kind: pet.kind ?? "cat",
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

/** 寵物名單換人／換物種時重建渲染 agent；只看數量會漏掉「一進一出、總數不變」。 */
export function petAgentSignature(): string {
  return Object.entries(state.pets)
    .filter(([, pet]) => pet.housePlacement !== "partner_foster")
    .map(([petId, pet]) => `${petId}:${pet.kind ?? "cat"}:${pet.color}:${pet.name}`)
    .sort()
    .join("|");
}

/** 找一格緊鄰另一隻寵物、且仍在同區域的可走格。 */
function tileBeside(partner: PetAgent, region: string, blocked: boolean[][]): Tile | null {
  const candidates = [
    { c: partner.c - 1, r: partner.r }, { c: partner.c + 1, r: partner.r },
    { c: partner.c, r: partner.r - 1 }, { c: partner.c, r: partner.r + 1 },
  ];
  return candidates.find((t) => blocked[t.r]?.[t.c] === false && GRID[t.r]?.[t.c] === (region as Region)) ?? null;
}

/** 貓狗互相退避時，挑同區域內距離對方最遠的安全格。 */
function tileAwayFrom(partner: PetAgent, region: string, blocked: boolean[][]): Tile | null {
  let best: Tile | null = null;
  let bestDistance = -1;
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (blocked[r]?.[c] || GRID[r]?.[c] !== (region as Region)) continue;
      const distance = Math.abs(c - partner.c) + Math.abs(r - partner.r);
      if (distance > bestDistance) {
        best = { c, r };
        bestDistance = distance;
      }
    }
  }
  return best;
}

const isMovingPairAction = (action: Pet["pairAction"]) => action === "chase" || action === "fetch";

export function tickPetAgents(agents: PetAgent[], dt: number) {
  const now = Date.now();
  for (const a of agents) {
    const pet = state.pets[a.petId];
    if (!pet) continue;
    const pairActive = !!pet.pairWith && !!pet.pairAction && (pet.pairUntilMs ?? 0) > state.gameMs;
    const partner = pairActive ? agents.find((x) => x.petId === pet.pairWith) : undefined;
    a.pairAction = partner ? pet.pairAction : undefined;
    a.pairWith = partner?.petId;
    a.pairLeader = !!partner && a.petId.localeCompare(partner.petId) < 0;
    if (!a.moving) {
      if (now < a.restUntil) continue;
      const blocked = currentBlocked();
      const region = petAgentRegion(a.petId, pet);
      let tgt: Tile | null = null;
      if (partner) {
        const follower = !a.pairLeader;
        if (pet.pairAction === "avoid") {
          if (follower) tgt = tileAwayFrom(partner, region, blocked);
          if (!follower) {
            a.facing = a.px <= partner.px ? -1 : 1;
            a.sleeping = false;
            a.restUntil = now + 1200;
            continue;
          }
        } else if (follower) {
          tgt = tileBeside(partner, region, blocked);
        }
        if (!follower && pet.pairAction !== "avoid" && !isMovingPairAction(pet.pairAction)) {
          a.sleeping = pet.pairAction === "nap";
          a.facing = a.px <= partner.px ? 1 : -1;
          a.restUntil = now + 1200;
          continue;
        }
        if (follower && pet.pairAction !== "avoid" && tgt && Math.abs(tgt.c - a.c) + Math.abs(tgt.r - a.r) <= 1) {
          a.sleeping = pet.pairAction === "nap";
          partner.sleeping = pet.pairAction === "nap";
          a.facing = a.px <= partner.px ? 1 : -1;
          partner.facing = a.facing === 1 ? -1 : 1;
          a.restUntil = partner.restUntil = now + 3500;
          continue;
        }
      }
      // 一般遊蕩；追逐／追球時領頭寵物繼續跑,另一隻追向牠身邊。
      tgt ??= tileInRegion(region, blocked);
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
        a.sleeping = pet.pairAction === "nap" || (!pet.pairAction && Math.random() < 0.35);
        a.restUntil = now + (a.sleeping ? 12000 + Math.random() * 10000 : 3000 + Math.random() * 5000);
      }
    } else {
      a.px += (dx / dist) * step;
      a.py += (dy / dist) * step;
    }
    a.walkPhase += dt * 6;
  }
}
