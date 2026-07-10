/**
 * 遊戲生命週期(store 拆分:lifecycle 模組)。
 * 啟動(載入→補進度→掛機計時器)、分頁恢復、無頭測試用的除錯鉤子。
 */
import { state, fmt } from "./gameState";
import { load, save } from "./persistence";
import { syncToNow, applyHour, hourlyTick } from "./tick";

let timer: number | undefined;

/** 停掉掛機計時器(persistence 清檔/匯入時也會呼叫,避免 reload 前又觸發 save) */
export function stopTicker() {
  if (timer) clearInterval(timer);
}

/** App 掛載時呼叫:載入 → 補進度 → 啟動掛機計時器 */
export function initGame() {
  const loaded = load();
  if (!loaded) {
    // 全新遊戲:先幫每位租客定位到開場時刻的活動(不寫日誌)
    const hour = new Date(state.gameMs).getHours();
    for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
    save();
  }
  syncToNow();
  // 用最新的可站立點邏輯重新定位當前活動(修正舊存檔可能殘留的牆上目標)
  const hour = new Date(state.gameMs).getHours();
  for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
  stopTicker();
  // 每 5 秒檢查是否跨過遊戲小時(前景掛機)
  if (typeof window !== "undefined") timer = window.setInterval(syncToNow, 5000);
}

export function stopGame() {
  stopTicker();
}

/** 分頁重新可見時:只補進度,不重載(避免蓋掉記憶體中的最新狀態) */
export function resume() {
  syncToNow();
}

// --- 測試/自我檢測用鉤子(headless 模擬追蹤器呼叫)---
/** 定位到目前時刻的活動(不寫日誌) */
export function debugInit() {
  const hour = new Date(state.gameMs).getHours();
  for (const rt of Object.values(state.runtimes)) applyHour(rt, hour, false);
}
/** 手動推進一個遊戲小時(不重錨、不存檔) */
export function debugStepHour() {
  hourlyTick();
}
/** 目前遊戲時間標籤 */
export function debugClock() {
  return fmt(state.gameMs);
}
