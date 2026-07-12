/**
 * 傳承系統(§G-7/G-8):成就冊 + 歷任房客名冊。
 *
 * 成就:純本地判定的里程碑,解鎖時彈一次通知、記進 state.achievements(入存檔)。
 *   - 事件型(在事發處呼叫 unlock):初戀、分手、打架、修羅場、貓闖禍。
 *   - 累積型(每日 legacyPass 輪詢):客滿、撐過 30 天、資產破 15 萬、送走第 1/第 5 位房客。
 * 名冊:退租時 recordAlumnus 把名字/住多久/離開原因/代表記憶留進 state.alumni(入存檔),
 *   讓「來來去去的房客」有個懷舊的翻閱處——掛機遊戲的情感留存。
 *
 * 只寫 state.achievements / state.alumni / noticeLog,不動租客數值 → 不影響 balance 快照。
 */
import type { AlumniEntry } from "../types";
import { state, notify, gameDayIndex, GAME_START, ROOM_APPEARANCE, type TenantRuntime } from "./gameState";
import { listRelationships } from "./social";
import { netWorth } from "./finance";

export interface AchievementDef {
  id: string;
  icon: string;
  label: string;
  desc: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first_love", icon: "❤️", label: "初次心動", desc: "第一對租客在你的注視下在一起了" },
  { id: "heartbreak", icon: "💔", label: "曲終人散", desc: "見證第一次分手" },
  { id: "brawl", icon: "🥊", label: "樓要塌了", desc: "兩位租客大打出手" },
  { id: "scandal", icon: "🎭", label: "修羅場", desc: "劈腿被當場抓包" },
  { id: "cat_burglar", icon: "🐈", label: "貓生大鬧", desc: "貓咪闖了禍(打破東西或隨地大小便)" },
  { id: "full_house", icon: "🏠", label: "客滿", desc: "四間套房同時住滿" },
  { id: "endured", icon: "📅", label: "資深房東", desc: "經營滿 30 個遊戲日" },
  { id: "tycoon", icon: "💰", label: "包租公", desc: "資產淨值突破 15 萬" },
  { id: "farewell", icon: "👋", label: "後會有期", desc: "送走第一位退租的房客" },
  { id: "veteran", icon: "🏆", label: "閱人無數", desc: "累計送走 5 位房客" },
];

const ACH_MAP: Record<string, AchievementDef> = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/** 解鎖成就(已解鎖則忽略);解鎖時彈一次通知 */
export function unlock(id: string) {
  if (state.achievements.includes(id)) return;
  const def = ACH_MAP[id];
  if (!def) return;
  state.achievements.push(id);
  notify(`${def.icon} 成就解鎖:「${def.label}」`);
}

/** 退租者的一句代表記憶:滾動摘要 > 最後的重要日誌 > 核心性格 > 保底句 */
function representativeMemory(rt: TenantRuntime): string {
  if (rt.tenant.recentSummary) return rt.tenant.recentSummary;
  const majors = rt.log.filter((e) => e.importance === "major" || e.daily);
  const last = majors[majors.length - 1] ?? rt.log[rt.log.length - 1];
  if (last?.text) return last.text;
  const tag = rt.tenant.coreTags[0]?.label;
  return tag ? `是個${tag.replace(/[[\]]/g, "")}的人。` : "來去匆匆,沒留下太多痕跡。";
}

/** 退租時把房客存進名冊(moveOut 在刪除 runtime 前呼叫) */
export function recordAlumnus(rt: TenantRuntime, reason: string) {
  const moveInMs = rt.moveInMs ?? GAME_START.getTime();
  const daysLived = Math.max(0, Math.floor((state.gameMs - moveInMs) / (24 * 3600 * 1000)));
  const entry: AlumniEntry = {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    daysLived,
    reason,
    leftMs: state.gameMs,
    memory: representativeMemory(rt).slice(0, 120),
  };
  state.alumni.unshift(entry); // 最新的排前面
  if (state.alumni.length > 50) state.alumni.length = 50;
  if (state.alumni.length >= 1) unlock("farewell");
  if (state.alumni.length >= 5) unlock("veteran");
}

/** 每日輪詢累積型成就(tick 換日時呼叫) */
export function legacyPass() {
  if (Object.keys(ROOM_APPEARANCE).every((r) => state.occupancy[r])) unlock("full_house");
  if (gameDayIndex() >= 30) unlock("endured");
  if (netWorth().total >= 150000) unlock("tycoon");
  if (listRelationships().some((r) => r.romantic)) unlock("first_love");
}
