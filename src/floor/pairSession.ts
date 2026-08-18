/**
 * 雙人互動 session(設計檢討 §10-6 第一階段):讓互動「演出來」而不只是日誌一行字。
 * 互動觸發時登記一個 session:兩人的走位目標被錨點覆寫,各自走到相鄰兩格站在一起;
 * 🔞 互動採遮蔽式(pose = "hidden"):session 期間兩人 sprite 直接隱藏,
 * 畫面只剩霧氣/關燈等 fx——分級靠暗示,畫面上永遠沒有露骨圖像。
 * 與 fx.ts 同為純資料模組,現實毫秒計時、過期自清,不進存檔。
 */
import type { Tile } from "./pathfind";
import { currentBlocked } from "./pathfind";
import { GRID_W, GRID_H } from "./map";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "../sim/clock";

/**
 * pair = 相鄰站一起;stand_face = 面對面聊天;cook_pair = 並肩料理;
 * sit = 並肩坐;lie = 並排躺;hidden = 隱藏(🔞 遮蔽式);apart = 各自退開(冷戰摔門);
 * scuffle = 打架的卡通推擠(§10-2:面對面側身 + 交替 ±1px 拉扯,**不見血**)。
 *
 * 🚫 `scuffle` 與 `hidden` 是**兩件事**:hidden 是 🔞 成人內容的遮蔽式演出(永遠不畫);
 * scuffle 是打架**要看得見**,但只到卡通推擠為止——不畫傷口、不畫血。
 */
export type PairPose = "pair" | "stand_face" | "cook_pair" | "sit" | "lie" | "hidden" | "apart" | "scuffle";

export interface PairSession {
  aId: string;
  bId: string;
  tileA: Tile;
  tileB: Tile;
  pose: PairPose;
  until: number; // 現實毫秒(Date.now 基準)
  /** 遊戲時間到期(登記 +1 遊戲小時):快轉/無頭模擬下不能讓 session 釘住走位好幾個遊戲小時 */
  gameUntil: number;
}

const sessions: PairSession[] = [];

/** 雙重到期:現實 15 秒(正常速度看得完演出)或 1 遊戲小時(快轉時跟著作息換場) */
function prune(gameNow: number) {
  const now = Date.now();
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].until <= now || sessions[i].gameUntil <= gameNow) sessions.splice(i, 1);
  }
}

/**
 * 進行中的 `scuffle` 有沒有牽涉到這兩人之中的任一位。
 *
 * 打架的推擠只活 15 現實秒,但 `socialPass` 在 `tryFight()` 成立後**只跳過那一對**,
 * 迴圈仍繼續:同一位打架者接著和第三人相遇時,那場相遇的 `stand_face` 會把
 * 打架 session 蓋掉 ⇒ 打鬥雲留在原地、兩人卻各自走開(實測 53 場裡佔 10 場)。
 * 因此把「演出優先權」訂在這裡:**scuffle 期間不接受別的姿勢覆蓋**。
 */
function scuffleHolds(aId: string, bId: string, gameNow: number): boolean {
  prune(gameNow);
  for (const s of sessions) {
    if (s.pose !== "scuffle") continue;
    if (s.aId === aId || s.bId === aId || s.aId === bId || s.bId === bId) return true;
  }
  return false;
}

/** 登記一場雙人互動:A 站錨點,B 站錨點旁第一個可走的相鄰格(找不到就同格疊站)。
 *  tiles = 明確指定兩人的格(§10-6 家具座位錨點:沙發並肩兩格、雙人床左右兩側——可為家具佔用格,
 *  agent 層會走到旁邊再「跨上去」)。
 *
 *  ⚠️ 唯一的例外是進行中的 `scuffle`:任一方還在打架推擠時,**別的姿勢一律登記不進來**
 *  (新的一場 `scuffle` 仍可接手,打架換對手還是打架)。純演出層的先後順序,不擲骰、
 *  不改任何數值後果——被擋掉的那場相遇照樣算數,只是不另外掛走位演出。
 *  多人事件要接管參與者時走 `clearPairSessionsFor()`,那條路不受此守衛影響。 */
export function startPairSession(aId: string, bId: string, anchor: Tile, pose: PairPose, gameNow: number, durationMs = REAL_MS_PER_GAME_HOUR, tiles?: { a: Tile; b: Tile }) {
  if (pose !== "scuffle" && scuffleHolds(aId, bId, gameNow)) return;
  // 一人同時只演一場:清掉牽涉任一方的舊 session
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.aId === aId || s.bId === aId || s.aId === bId || s.bId === bId) sessions.splice(i, 1);
  }
  let tileA: Tile = { ...anchor };
  let tileB: Tile = anchor;
  if (tiles) {
    tileA = { ...tiles.a };
    tileB = { ...tiles.b };
  } else {
    const blocked = currentBlocked();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = anchor.c + dc;
      const r = anchor.r + dr;
      if (c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && !blocked[r][c]) {
        tileB = { c, r };
        break;
      }
    }
  }
  sessions.push({ aId, bId, tileA, tileB, pose, until: Date.now() + durationMs, gameUntil: gameNow + MS_PER_GAME_HOUR });
}

const NEIGHBORS = [[0, -1], [-1, 0], [1, 0], [0, 1]] as const;

/** 從 `from` 出發的 4-鄰接 BFS 步數表(key = r * GRID_W + c);起點若是家具格,改由它的可走鄰格起算。 */
function walkDistances(from: Tile, blocked: boolean[][]): Map<number, number> {
  const open = (c: number, r: number) => c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && blocked[r][c] === false;
  const dist = new Map<number, number>();
  const queue: Tile[] = [];
  const seed = (t: Tile, d: number) => {
    const k = t.r * GRID_W + t.c;
    if (dist.has(k)) return;
    dist.set(k, d);
    queue.push(t);
  };
  if (open(from.c, from.r)) seed(from, 0);
  else for (const [dc, dr] of NEIGHBORS) if (open(from.c + dc, from.r + dr)) seed({ c: from.c + dc, r: from.r + dr }, 1);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const d = dist.get(cur.r * GRID_W + cur.c)!;
    for (const [dc, dr] of NEIGHBORS) {
      const c = cur.c + dc;
      const r = cur.r + dr;
      if (open(c, r)) seed({ c, r }, d + 1);
    }
  }
  return dist;
}

/** 走位半徑上限:打架 session 只活 15 現實秒(≈41 格的腳程),超過這個距離就別挑了。 */
const SCUFFLE_RADIUS = 8;
/** 淨空半徑:離其他租客的目標格 6 格以內都算「會被擠到/堵到」,每近一格罰 `SCUFFLE_CONTESTED`。 */
const SCUFFLE_CLEAR = 6;
const SCUFFLE_CONTESTED = 6;
/** 死巷罰分:可走鄰居少於 3 個的格容易被第三人堵死(交誼廳 (2,10) 那個一格寬的凹角就是這樣)。 */
const SCUFFLE_TIGHT = 2;

/**
 * 打架「就地開打」的錨點(F-3)。
 *
 * 舊版直接拿 `A.targetTile` 當錨點、`B` 站它的第一個可走鄰格。實測 53 場裡有 13 場
 * **人沒走到**,而且失敗長得一模一樣:交誼廳的沙發互動格 (2,10) 是全樓最搶手的目標,
 * 但它藏在一格寬的凹角裡(上下都是牆,只有 (3,10) 一個可走鄰格)⇒
 *   1. 同樣要去沙發的第三人被 `claimCrowdTarget` 從 (2,10) 溢出到 (3,10),**正好把 B 的格搶走**;
 *   2. `tickAgents` 的讓步是「原地等」而不是重新繞路,被堵在 (4,10)…(7,10) 這條隊伍裡的人
 *      15 秒到期都還在等前面的人讓開。
 *
 * 所以本函式只換「錨點怎麼挑」:在兩人現有目標格附近找**一組相鄰兩格**,分數 =
 * 走的步數 + 離其他租客目標格太近的罰分 + 死巷罰分。共用的走位與擁擠邏輯
 * (`claimCrowdTarget` / `findPath` / `tickAgents`)一個字都沒動,只是不再把演出
 * 擺在人群一定會擠過去的地方。實測並肩率 39/53(73.6%)→ **48/53(90.6%)**。
 *
 * ⚠️ 權重是實跑調出來的,而且是一大片平原(CONTESTED 6～20、RADIUS 8～12、TIGHT 2～4
 * 都是同一組 48/53),不是尖點。真正關鍵的只有 `SCUFFLE_CLEAR`:改成 5 或 8 都掉回 44～46/53。
 * 步數幾乎不重要——15 現實秒走得完 41 格,失敗從來不是「走太遠」而是「被堵住」。
 *
 * **完全決定性**:輸入只有 `currentBlocked()` 與各租客的目標格,沒有任何 `Math.random()`,
 * 也不看即時的 agent 座標 ⇒ 離線補算與線上逐時算出來的錨點一致。
 *
 * @param near   兩人各自的現有目標格(`activityTile ?? targetTile`)
 * @param avoid  其他在場租客的目標格(擁擠位移與堵路的來源)
 * @param bounds 限定錨點落在這個矩形內(交誼廳),免得打架跑到走廊或別人房間去
 */
export function scuffleTiles(
  near: { a: Tile; b: Tile },
  avoid: readonly Tile[] = [],
  bounds?: { c0: number; r0: number; c1: number; r1: number },
): { a: Tile; b: Tile } | null {
  const blocked = currentBlocked();
  const open = (c: number, r: number) => c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && blocked[r][c] === false;
  const inBounds = (c: number, r: number) => !bounds || (c >= bounds.c0 && c <= bounds.c1 && r >= bounds.r0 && r <= bounds.r1);
  const distA = walkDistances(near.a, blocked);
  const distB = walkDistances(near.b, blocked);
  if (distA.size === 0 || distB.size === 0) return null;

  // 其他租客目標格的「勢力範圍」:擁擠時 `claimCrowdTarget` 會把人往外撒,
  // 而走去那裡的人也會佔住沿途的格 ⇒ 越靠近越可能被搶走或堵住。
  const crowd = new Map<number, number>();
  {
    const queue: Tile[] = [];
    const seed = (t: Tile, d: number) => {
      if (!open(t.c, t.r)) return;
      const k = t.r * GRID_W + t.c;
      if (crowd.has(k)) return;
      crowd.set(k, d);
      queue.push(t);
    };
    for (const t of avoid) {
      if (open(t.c, t.r)) seed(t, 0);
      else for (const [dc, dr] of NEIGHBORS) seed({ c: t.c + dc, r: t.r + dr }, 1);
    }
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const d = crowd.get(cur.r * GRID_W + cur.c)!;
      if (d >= SCUFFLE_CLEAR) continue;
      for (const [dc, dr] of NEIGHBORS) seed({ c: cur.c + dc, r: cur.r + dr }, d + 1);
    }
  }
  const tightness = (c: number, r: number) => {
    let free = 0;
    for (const [dc, dr] of NEIGHBORS) if (open(c + dc, r + dr)) free += 1;
    return Math.max(0, 3 - free); // 3 個以上鄰居 = 有繞道空間,不罰
  };
  const cost = (k: number, c: number, r: number) =>
    Math.max(0, SCUFFLE_CLEAR - (crowd.get(k) ?? SCUFFLE_CLEAR)) * SCUFFLE_CONTESTED + tightness(c, r) * SCUFFLE_TIGHT;

  let best: { a: Tile; b: Tile } | null = null;
  let bestScore = Infinity;
  // 固定的掃描序(左上到右下、鄰居 上→左→右→下)⇒ 同分時永遠挑到同一組格
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const k1 = r * GRID_W + c;
      const da = distA.get(k1);
      const db1 = distB.get(k1);
      if (da === undefined || da > SCUFFLE_RADIUS || !inBounds(c, r)) continue;
      const c1 = cost(k1, c, r);
      for (const [dc, dr] of NEIGHBORS) {
        const c2c = c + dc;
        const c2r = r + dr;
        if (!open(c2c, c2r) || !inBounds(c2c, c2r)) continue;
        const k2 = c2r * GRID_W + c2c;
        const da2 = distA.get(k2);
        const db2 = distB.get(k2);
        // 兩種指派(誰站哪一格)都試,取步數小的那一種
        const walk = Math.min(
          da + (db2 ?? Infinity),
          (da2 ?? Infinity) + (db1 ?? Infinity),
        );
        if (!Number.isFinite(walk)) continue;
        // 面對面的側身只在同一列成立(`facingToward`),同分時優先橫向相鄰
        const score = walk + c1 + cost(k2, c2c, c2r) + (dr === 0 ? 0 : 1);
        if (score >= bestScore) continue;
        bestScore = score;
        best = da + (db2 ?? Infinity) <= (da2 ?? Infinity) + (db1 ?? Infinity)
          ? { a: { c, r }, b: { c: c2c, r: c2r } }
          : { a: { c: c2c, r: c2r }, b: { c, r } };
      }
    }
  }
  return best;
}

/** 此人進行中的 session 走位(agent 層以此覆寫 targetTile);沒有則 null */
export function sessionFor(tenantId: string, gameNow: number): { tile: Tile; pose: PairPose; facing: -1 | 0 | 1 } | null {
  prune(gameNow);
  for (const s of sessions) {
    if (s.aId === tenantId) return { tile: s.tileA, pose: s.pose, facing: facingToward(s.pose, s.tileA, s.tileB) };
    if (s.bId === tenantId) return { tile: s.tileB, pose: s.pose, facing: facingToward(s.pose, s.tileB, s.tileA) };
  }
  return null;
}

/** 面對面的姿勢(聊天 stand_face / 打架 scuffle)只在水平相鄰時畫側向提示；
 *  垂直排列維持正面，避免假裝看向錯誤方向。 */
const FACING_POSES: ReadonlySet<PairPose> = new Set<PairPose>(["stand_face", "scuffle"]);
function facingToward(pose: PairPose, mine: Tile, other: Tile): -1 | 0 | 1 {
  if (!FACING_POSES.has(pose) || mine.r !== other.r || mine.c === other.c) return 0;
  return other.c > mine.c ? 1 : -1;
}

/** 冷戰演出反向使用 pair session：兩人不靠攏，而是各自走向指定的退場格。 */
export function startSeparationSession(aId: string, bId: string, tileA: Tile, tileB: Tile, gameNow: number, durationMs = 15000) {
  startPairSession(aId, bId, tileA, "apart", gameNow, durationMs, { a: tileA, b: tileB });
}

export function activeSessions(gameNow: number): PairSession[] {
  prune(gameNow);
  return sessions;
}

export function clearPairSessions() {
  sessions.length = 0;
}

/** 多人事件接管參與者前，清掉只涉及這些人的雙人演出，避免兩套走位互搶。 */
export function clearPairSessionsFor(tenantIds: readonly string[]) {
  const ids = new Set(tenantIds);
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (ids.has(sessions[i].aId) || ids.has(sessions[i].bId)) sessions.splice(i, 1);
  }
}
