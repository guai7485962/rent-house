/**
 * 🔴 咖啡廳員工的畫面層(重設計 P4b,設計文件 §4.9)。
 *
 * 使用者的四個追問:「員工要真的有面板嗎?畫面上看得到他在做什麼嗎?會看到他幫顧客
 * 結帳嗎?結帳在櫃檯嗎?」——四題答案都是「要」。P4a 把員工做成了數字(產能、薪資、
 * 雇用/資遣純函式),本檔負責讓那個數字**站到吧台後面**。
 *
 * ## 三個狀態(設計文件 §4.9 的表)
 *
 * | 狀態 | 畫面 |
 * |---|---|
 * | `idle` 待機 | 站在吧台後方,偶爾擦杯子/整理 |
 * | `serving` 結帳中 | 面向吧台前的顧客,頭上出現製作中圖示 |
 * | `busy` 忙碌 | 同上,但外面還有人在排隊 ⇒ 連續動作不停 |
 *
 * ## 邊界
 *
 * - **人數只讀 `cafeStaffCount(state.cafe.extraStaff)`**(開張費已含首位店員 ⇒ 開張後
 *   永遠至少一人)。本檔不算薪資、不算產能、不碰 `state`。
 * - **站位只讀 `cafeStaffSpots()`**(吧台後方那一排)。玩家把吧台搬到哪、轉成什麼方向,
 *   員工就站到那裡的後面,沒有一個硬編座標。
 * - **打烊/未開張不產生任何 agent**(`open === false` ⇒ 回空陣列)。
 * - **零 `Math.random()`**:外觀、配對、待機動作全部由 index 與累計秒數決定。
 * - 位置是暫態的(每次掛載重生,同 `petAgents` / `vacuumAgents`),不進存檔。
 */
import type { CharView } from "../pixel/sprites";
import type { Appearance } from "../types";
import { HAIR_COLORS, PANTS_COLORS, SKIN_TONES, ALL_HAIR_STYLES } from "../pixel/parts";
import { cafeStaffSpots } from "../sim/placements";
import { TILE } from "./map";
import type { Tile } from "./pathfind";

export type StaffAgentPhase = "idle" | "serving" | "busy";

/** 員工配對用的顧客視圖(唯讀,由 `guestAgents.orderingGuestViews()` 提供)。 */
export interface StaffCounterGuest {
  id: string;
  c: number;
  r: number;
}

export interface StaffAgent {
  /** `staff-0` 起算;0 號是開張費已包含的那位店員。 */
  id: string;
  index: number;
  c: number;
  r: number;
  px: number;
  py: number;
  /** 沒人要結帳時回去站的那一格(吧台後方)。 */
  homeTile: Tile;
  view: CharView;
  appearance: Appearance;
  phase: StaffAgentPhase;
  /** 目前狀態已經過的現實秒數。 */
  phaseT: number;
  /** 動作相位(擦杯子 / 連續作業),由 dt 累加 ⇒ 快轉不會吃掉演出。 */
  workPhase: number;
  /** 正在幫誰結帳;`null` = 待機。 */
  servingGuestId: string | null;
}

/**
 * 員工制服色。刻意**不從 `SHIRT_COLORS` 抽**——那是顧客與租客的池子,
 * 抽到同色就分不出誰是店員。深咖啡圍裙 + 米色綁帶是咖啡廳的通用語言。
 */
export const STAFF_APRON = "#4b3524";
export const STAFF_APRON_TIE = "#e8ddc4";
export const STAFF_SHIRT = "#7d6a52";

/** 員工走到顧客正對面的速度(px/秒)。比顧客(40)慢一點,像在吧台後挪半步。 */
const SLIDE_SPEED = 30;
/** 擦杯子的節奏(秒):一個週期裡前 `WIPE_ACTIVE` 秒在動,其餘站著。 */
const WIPE_CYCLE = 4.2;
const WIPE_ACTIVE = 1.6;

/**
 * 員工外觀。同一個 index 永遠得到同一個人(零 RNG),而且**全部穿同一件圍裙**,
 * 只有髮型/髮色/膚色分得出誰是誰 —— 制服感比「每個人都不一樣」重要。
 */
export function staffAppearance(index: number): Appearance {
  const i = Math.max(0, Math.trunc(index));
  return {
    hairStyle: ALL_HAIR_STYLES[i % ALL_HAIR_STYLES.length],
    hairColor: HAIR_COLORS[(i * 3) % HAIR_COLORS.length],
    shirt: STAFF_SHIRT,
    pants: PANTS_COLORS[(i * 2) % PANTS_COLORS.length],
    skin: SKIN_TONES[(i * 5) % SKIN_TONES.length],
    accessory: "none",
  };
}

/** state 變了才重建 agent(人數或營業狀態);與 `petAgentSignature()` 同一套作法。 */
export function staffAgentSignature(staffCount: number, open: boolean): string {
  const spots = open ? cafeStaffSpots() : [];
  return `${open ? 1 : 0}|${Math.max(0, Math.trunc(staffCount))}|${spots.map((t) => `${t.c},${t.r}`).join(";")}`;
}

/**
 * 把「員工人數」同步成畫面 agent。
 *
 * - `open === false`(未開張或打烊)⇒ 空陣列,吧台後一個人都沒有。
 * - 既有 agent 依 index 保留(雇用第 3 位時,前兩位不會被瞬移回原位)。
 * - 站位不足時多出來的人疊回最後一格 —— 吧台太小是玩家的擺放問題,不該讓人消失。
 */
export function syncStaffAgents(
  previous: readonly StaffAgent[],
  staffCount: number,
  open: boolean,
): StaffAgent[] {
  if (!open) return [];
  const count = Math.max(0, Math.trunc(Number.isFinite(staffCount) ? staffCount : 0));
  if (count === 0) return [];
  const spots = cafeStaffSpots();
  if (spots.length === 0) return [];
  const byIndex = new Map(previous.map((agent) => [agent.index, agent]));
  const agents: StaffAgent[] = [];
  for (let index = 0; index < count; index++) {
    const home = spots[Math.min(index, spots.length - 1)];
    const kept = byIndex.get(index);
    if (kept) {
      kept.homeTile = { c: home.c, r: home.r };
      agents.push(kept);
      continue;
    }
    agents.push({
      id: `staff-${index}`,
      index,
      c: home.c,
      r: home.r,
      px: home.c * TILE,
      py: home.r * TILE,
      homeTile: { c: home.c, r: home.r },
      view: "front",
      appearance: staffAppearance(index),
      phase: "idle",
      phaseT: 0,
      workPhase: 0,
      servingGuestId: null,
    });
  }
  return agents;
}

export function createStaffAgents(staffCount: number, open: boolean): StaffAgent[] {
  return syncStaffAgents([], staffCount, open);
}

/** 面向某一格(可以隔好幾格);主軸取位移較大的那一軸。 */
function faceToward(agent: StaffAgent, tile: Tile): CharView {
  const dc = tile.c - agent.c;
  const dr = tile.r - agent.r;
  if (Math.abs(dr) >= Math.abs(dc)) {
    if (dr !== 0) return dr > 0 ? "front" : "back";
    return agent.view;
  }
  return dc > 0 ? "side_r" : "side_l";
}

/** 這一格在不在員工的站位排上(員工只在吧台後方那一排移動,不會跑進場中央)。 */
function stationAt(spots: readonly Tile[], c: number, r: number): Tile | null {
  return spots.find((tile) => tile.c === c && tile.r === r) ?? null;
}

/**
 * 推進員工的配對、走位與演出。
 *
 * 配對規則:員工依 index 順序,各自挑**還沒被挑走、且離自己最近**的一位結帳中顧客
 * (距離相同時取序在前者)⇒ 決定性,同一批輸入永遠同一組配對。
 *
 * `queueLength > 0`(外面還有人在排)時,有在結帳的員工進入 `busy`:動作不停、
 * 節奏加快。那正是「產能吃緊」在員工身上的表現,和顧客那條人龍是同一件事的兩面。
 */
export function tickStaffAgents(
  agents: StaffAgent[],
  dt: number,
  counterGuests: readonly StaffCounterGuest[] = [],
  queueLength = 0,
) {
  if (agents.length === 0) return;
  const step = Math.max(0, dt);
  const spots = cafeStaffSpots();
  const claimed = new Set<string>();
  const reservedTiles = new Set<string>();
  for (const agent of agents) {
    agent.phaseT += step;
    agent.workPhase += step;
    // 1) 挑一位顧客(最近優先;序固定)
    let target: StaffCounterGuest | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const guest of counterGuests) {
      if (claimed.has(guest.id)) continue;
      const distance = Math.abs(guest.c - agent.homeTile.c) + Math.abs(guest.r - agent.homeTile.r);
      if (distance < bestDistance) { bestDistance = distance; target = guest; }
    }
    if (target) claimed.add(target.id);

    // 2) 狀態轉移(換狀態才把演出計時歸零)
    const nextPhase: StaffAgentPhase = target ? (queueLength > 0 ? "busy" : "serving") : "idle";
    if (nextPhase !== agent.phase) { agent.phase = nextPhase; agent.phaseT = 0; }
    agent.servingGuestId = target?.id ?? null;

    // 3) 走位:結帳時挪到顧客**正對面**的那一格(仍在吧台後方那一排),否則回原位
    let destination = agent.homeTile;
    if (target) {
      const across = stationAt(spots, target.c, agent.homeTile.r) ?? stationAt(spots, agent.homeTile.c, target.r);
      if (across && !reservedTiles.has(`${across.c},${across.r}`)) destination = across;
    }
    reservedTiles.add(`${destination.c},${destination.r}`);
    slideTo(agent, destination, step);

    // 4) 視角:有客人就面向他,沒客人就面向店裡(正面)
    agent.view = target ? faceToward(agent, target) : "front";
  }
}

/**
 * 沿吧台後方那一排平移。**不尋路**:目的地與現在位置永遠在同一排(由 `stationAt`
 * 保證),直線插值就夠了,也不可能穿牆——那一排每一格都過了 `cafeStaffSpots()`
 * 的可走檢查。差太遠(玩家把吧台整個搬走)就直接歸位,不要演一段穿越全場的長征。
 */
function slideTo(agent: StaffAgent, tile: Tile, dt: number) {
  const nx = tile.c * TILE;
  const ny = tile.r * TILE;
  const dx = nx - agent.px;
  const dy = ny - agent.py;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) { agent.c = tile.c; agent.r = tile.r; return; }
  if (distance > TILE * 4) { // 吧台被搬走 ⇒ 直接就位
    agent.px = nx; agent.py = ny; agent.c = tile.c; agent.r = tile.r;
    return;
  }
  const move = SLIDE_SPEED * dt;
  if (distance <= move) {
    agent.px = nx; agent.py = ny; agent.c = tile.c; agent.r = tile.r;
    return;
  }
  agent.px += (dx / distance) * move;
  agent.py += (dy / distance) * move;
}

/** true = 這一幀正在移動(走路貼圖用)。 */
export function staffMoving(agent: StaffAgent): boolean {
  return Math.abs(agent.px - agent.c * TILE) > 0.5 || Math.abs(agent.py - agent.r * TILE) > 0.5;
}

/**
 * 待機時的「擦杯子」動作相位:`0` = 站著,`1`/`2` = 手上的杯子上下兩幀。
 *
 * 用累計秒數取模 ⇒ 決定性、和遊戲時鐘無關,快轉不會讓他變成殘影。
 */
export function staffWipeFrame(agent: StaffAgent): 0 | 1 | 2 {
  if (agent.phase !== "idle") return 0;
  const t = agent.workPhase % WIPE_CYCLE;
  if (t >= WIPE_ACTIVE) return 0;
  return Math.floor(t * 4) % 2 === 0 ? 1 : 2;
}

/** 忙碌/結帳中的作業動作幀(busy 的節奏比 serving 快一倍 ⇒ 一眼看得出他在趕)。 */
export function staffWorkFrame(agent: StaffAgent): 0 | 1 {
  if (agent.phase === "idle") return 0;
  const speed = agent.phase === "busy" ? 7 : 3.5;
  return Math.floor(agent.workPhase * speed) % 2 === 0 ? 0 : 1;
}
