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
 * sit = 並肩坐;lie = 並排躺;hidden = 隱藏(🔞 遮蔽式);apart = 各自退開(冷戰摔門)。
 */
export type PairPose = "pair" | "stand_face" | "cook_pair" | "sit" | "lie" | "hidden" | "apart";

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

/** 登記一場雙人互動:A 站錨點,B 站錨點旁第一個可走的相鄰格(找不到就同格疊站)。
 *  tiles = 明確指定兩人的格(§10-6 家具座位錨點:沙發並肩兩格、雙人床左右兩側——可為家具佔用格,
 *  agent 層會走到旁邊再「跨上去」)。 */
export function startPairSession(aId: string, bId: string, anchor: Tile, pose: PairPose, gameNow: number, durationMs = REAL_MS_PER_GAME_HOUR, tiles?: { a: Tile; b: Tile }) {
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

/** 此人進行中的 session 走位(agent 層以此覆寫 targetTile);沒有則 null */
export function sessionFor(tenantId: string, gameNow: number): { tile: Tile; pose: PairPose; facing: -1 | 0 | 1 } | null {
  prune(gameNow);
  for (const s of sessions) {
    if (s.aId === tenantId) return { tile: s.tileA, pose: s.pose, facing: facingToward(s.pose, s.tileA, s.tileB) };
    if (s.bId === tenantId) return { tile: s.tileB, pose: s.pose, facing: facingToward(s.pose, s.tileB, s.tileA) };
  }
  return null;
}

/** 面對面姿勢只在水平相鄰時畫側向提示；垂直排列維持正面，避免假裝看向錯誤方向。 */
function facingToward(pose: PairPose, mine: Tile, other: Tile): -1 | 0 | 1 {
  if (pose !== "stand_face" || mine.r !== other.r || mine.c === other.c) return 0;
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
