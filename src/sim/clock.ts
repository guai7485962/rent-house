/**
 * 掛機時鐘:遊戲時間跟現實時間掛鉤。
 * 速率:現實 1 天 = 遊戲 7 天 → 1 遊戲小時 ≈ 514 現實秒(約 8.6 分鐘)。
 *
 * 用「錨點」換算,不需要每秒累加:
 *   遊戲時間 = gameAnchorMs + (now - realAnchorMs) × SCALE
 * 這樣關掉再開,靠現實時間差就能算出經過幾個遊戲小時並補進度。
 */

export const SCALE = 7; // 遊戲時間流速 = 現實 × 7(現實 1 天 = 遊戲 7 天)
export const REAL_SECONDS_PER_GAME_HOUR = (24 * 3600) / (SCALE * 24); // ≈ 514.3
export const MS_PER_GAME_HOUR = 3600 * 1000; // 遊戲時間裡的一小時(毫秒)

/** 補進度上限:離開再久,最多補這麼多遊戲小時(避免爆量) */
export const MAX_CATCHUP_HOURS = 48;

/** 由錨點算出目前遊戲時間(毫秒 epoch,遊戲時間軸) */
export function currentGameMs(realAnchorMs: number, gameAnchorMs: number, now = Date.now()): number {
  return gameAnchorMs + (now - realAnchorMs) * SCALE;
}

/** 現實過多久,遊戲會前進 1 小時(毫秒) */
export const REAL_MS_PER_GAME_HOUR = REAL_SECONDS_PER_GAME_HOUR * 1000;
