/**
 * 娃娃屋演出層(設計檢討 §10-4):輕量特效佇列。
 * 互動/事件在某格上方掛一個小演出(愛心/怒氣/心碎/對話…),數秒後自動消失;
 * 睡覺 Zzz、直播音符、洗澡蒸氣等「隨狀態」的環境演出則由 floorScene 逐幀衍生,不進佇列。
 * 純資料模組,繪製在 floorScene.drawFx。
 */

export type FxKind = "hearts" | "heartbreak" | "anger" | "chat" | "steam" | "lights" | "fight";

export interface Fx {
  kind: FxKind;
  c: number;
  r: number;
  until: number; // 現實毫秒(Date.now 基準)
}

const list: Fx[] = [];
const FX_CAP = 40;

/** 在 (c,r) 格上方掛一個演出,durationMs 後消失 */
export function spawnFx(kind: FxKind, c: number, r: number, durationMs = 8000) {
  list.push({ kind, c, r, until: Date.now() + durationMs });
  if (list.length > FX_CAP) list.splice(0, list.length - FX_CAP);
}

/** 目前存活的演出(順便清掉過期的) */
export function activeFx(): Fx[] {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].until <= now) list.splice(i, 1);
  }
  return list;
}

export function clearFx() {
  list.length = 0;
}
