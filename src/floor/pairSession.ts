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

/** pair = 兩人相鄰站在一起 + fx;hidden = 兩人隱藏(🔞 遮蔽式) */
export type PairPose = "pair" | "hidden";

export interface PairSession {
  aId: string;
  bId: string;
  tileA: Tile;
  tileB: Tile;
  pose: PairPose;
  until: number; // 現實毫秒(Date.now 基準)
}

const sessions: PairSession[] = [];

function prune() {
  const now = Date.now();
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i].until <= now) sessions.splice(i, 1);
  }
}

/** 登記一場雙人互動:A 站錨點,B 站錨點旁第一個可走的相鄰格(找不到就同格疊站) */
export function startPairSession(aId: string, bId: string, anchor: Tile, pose: PairPose, durationMs = 15000) {
  // 一人同時只演一場:清掉牽涉任一方的舊 session
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.aId === aId || s.bId === aId || s.aId === bId || s.bId === bId) sessions.splice(i, 1);
  }
  const blocked = currentBlocked();
  let tileB: Tile = anchor;
  for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const c = anchor.c + dc;
    const r = anchor.r + dr;
    if (c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && !blocked[r][c]) {
      tileB = { c, r };
      break;
    }
  }
  sessions.push({ aId, bId, tileA: { ...anchor }, tileB, pose, until: Date.now() + durationMs });
}

/** 此人進行中的 session 走位(agent 層以此覆寫 targetTile);沒有則 null */
export function sessionFor(tenantId: string): { tile: Tile; pose: PairPose } | null {
  prune();
  for (const s of sessions) {
    if (s.aId === tenantId) return { tile: s.tileA, pose: s.pose };
    if (s.bId === tenantId) return { tile: s.tileB, pose: s.pose };
  }
  return null;
}

export function activeSessions(): PairSession[] {
  prune();
  return sessions;
}

export function clearPairSessions() {
  sessions.length = 0;
}
