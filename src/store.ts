/**
 * 遊戲狀態對外入口(façade)。
 *
 * 實作已模組化拆到 src/sim/*(設計檢討 §5「store 拆分」),這裡只做 re-export:
 * 元件與 scripts 一律從本檔 import,內部搬家不影響呼叫點。
 *
 * 模組地圖:
 * - sim/gameState.ts   reactive state 定義 + 共用常數/型別/小工具(notify、pushMemory…)
 * - sim/tick.ts        每小時模擬(作息+偏離、事件、社交、換日)、補進度、快轉
 * - sim/economy.ts     金錢唯一入口 addMoney、收租/管理費、家具買/擺/移/賣
 * - sim/tenancy.ts     招租/入住/退租/同居、房東抉擇(decide)
 * - sim/narration.ts   每日 AI 日記(live 打 API、否則模板)
 * - sim/feed.ts        全棟動態 Feed 彙整(重要日誌+通知的時間軸,唯讀)
 * - sim/persistence.ts 存檔/載入 + 版本遷移層(SAVE_VERSION/MIGRATIONS)+ 匯出入
 * - sim/lifecycle.ts   啟動/掛機計時器/除錯鉤子
 */
export {
  state,
  activeRuntime,
  hasAnyPending,
  clockLabel,
  unreadCount,
  markSeen,
  isVacant,
  roomOfTenant,
  cohabitingPartnerId,
  canStartCohabit,
  gameDayIndex,
} from "./sim/gameState";
export type { Txn, TxnCategory, LogEntry, TenantRuntime } from "./sim/gameState";

export { fastForward, startFastForward } from "./sim/tick";

export {
  addMoney,
  buyFurniture,
  buyUpgrade,
  startPlacing,
  cancelPlacing,
  placeAt,
  startMoving,
  cancelMoving,
  moveFurnitureTo,
  rotatePendingFurniture,
  canDropAt,
  sellFurnitureAt,
} from "./sim/economy";

export {
  getApplicants,
  moveIn,
  moveOut,
  resolveCohabit,
  decide,
  previewRent,
  proposeRent,
  previewEviction,
  evictTenant,
  type RentPreview,
  type EvictionMode,
  type EvictionPreview,
} from "./sim/tenancy";

export { buildFeed, feedUnreadCount, markFeedSeen, FEED_CAP, type FeedEntry } from "./sim/feed";

export { adoptCat, catAttitude, petsPass, ensurePets, mischiefRelief, randomCatPreset, catJournalPass } from "./sim/pets";
export { diaryPass, ensureDiaryHours, produceDailyDiaries, resumeDeferredDiaries } from "./sim/narration";
export { ACHIEVEMENTS, unlock, recordAlumnus, legacyPass, type AchievementDef } from "./sim/legacy";
export { communityPass, rollGroupEvent, resolveGroupEvent } from "./sim/community";
export { weeklyReportPass, currentRelationshipSnapshot, WEEKLY_REPORT_CAP, type WeeklyReport } from "./sim/weeklyReport";

export type { StoryArc } from "./sim/arcs";

export { SAVE_KEY, SAVE_VERSION, exportSave, importSave, clearSave } from "./sim/persistence";

export { initGame, stopGame, resume, debugInit, debugStepHour, debugClock } from "./sim/lifecycle";

// 新開局的種子補登(貓、日記時段)。放在 façade 底部:此時所有 sim 模組都初始化完,
// 不會踩到 gameState ↔ persistence ↔ pets 的循環載入順序;load() 之後會再各自補一次。
import { ensurePets as _ensurePets } from "./sim/pets";
import { ensureDiaryHours as _ensureDiaryHours } from "./sim/narration";
_ensurePets();
_ensureDiaryHours();
