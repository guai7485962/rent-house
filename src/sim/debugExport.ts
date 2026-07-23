/**
 * 玩家主動提供給開發者的完整除錯快照。
 *
 * 這不是可匯入的存檔：格式以容易閱讀、定位問題為優先，並刻意把現役／歷任房客分開。
 * 不會呼叫 save()、不會改遊戲狀態，也不包含 localStorage 以外的瀏覽器或裝置資料。
 */
import { state } from "./gameState";
import { placements } from "./placements";
import { upgradeState } from "./upgrades";
import { serializeRelationships } from "./social";
import { SAVE_VERSION } from "./persistence";

export const DEBUG_LOG_VERSION = 1;

export function buildDebugLog(generatedAtMs = Date.now()) {
  const globalState = Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== "runtimes" && key !== "alumni"),
  );

  return {
    debugLogVersion: DEBUG_LOG_VERSION,
    saveVersion: SAVE_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    gameTime: new Date(state.gameMs).toISOString(),
    summary: {
      currentTenantCount: Object.keys(state.runtimes).length,
      formerTenantCount: state.alumni.length,
      money: state.money,
      reputation: state.reputation,
      activeTenantId: state.activeId,
    },
    globalState,
    world: {
      placements: placements.list,
      upgrades: upgradeState.byRoom,
      relationships: serializeRelationships(),
    },
    currentTenants: Object.entries(state.runtimes).map(([tenantId, runtime]) => ({
      tenantId,
      ...runtime,
    })),
    formerTenants: state.alumni.map((alumnus) => ({
      ...alumnus,
      debugSnapshotAvailable: !!alumnus.debugSnapshot,
      ...(alumnus.debugSnapshot
        ? {}
        : { debugSnapshotNote: "這筆歷任房客紀錄建立於 Log 快照功能推出前，當時未保存完整 tags / logs。" }),
    })),
  };
}

export function exportDebugLog(generatedAtMs = Date.now()): string {
  return JSON.stringify(buildDebugLog(generatedAtMs), null, 2);
}
