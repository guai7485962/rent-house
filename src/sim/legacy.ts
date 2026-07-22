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
  /** 隱藏成就:解鎖前連描述都不給(UI 顯示 ???),留探索樂趣 */
  hidden?: boolean;
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
  { id: "wish_fulfilled", icon: "🎯", label: "圓夢推手", desc: "見證第一位租客實現人生心願" },
  { id: "wish_collector", icon: "🌠", label: "夢想孵化器", desc: "三位租客在這裡實現了心願" },
  { id: "farewell", icon: "👋", label: "後會有期", desc: "送走第一位退租的房客" },
  { id: "veteran", icon: "🏆", label: "閱人無數", desc: "累計送走 5 位房客" },
  // --- 玩家目標批:繳租戲劇/成長/心意/雙人弧/天氣 ---
  { id: "grace_giver", icon: "🤝", label: "寬限之恩", desc: "第一次答應寬限房客的欠租" },
  { id: "debt_forgiver", icon: "🕊️", label: "佛心房東", desc: "把一筆欠租一筆勾銷" },
  { id: "hard_collector", icon: "🧾", label: "鐵面房東", desc: "對正處於財務困難的房客催繳欠租", hidden: true },
  { id: "care_10", icon: "💝", label: "暖心房東", desc: "累計對房客表達 10 次心意" },
  { id: "first_growth", icon: "🌱", label: "見證成長", desc: "有房客獲得第一個永久成長特質" },
  { id: "growth_full", icon: "🎓", label: "桃李滿樓", desc: "同一位房客集滿 4 個成長特質", hidden: true },
  { id: "pair_arc", icon: "👥", label: "共同篇章", desc: "見證第一條雙人劇情弧圓滿落幕" },
  { id: "rainy_day", icon: "☔", label: "雨天的交誼廳", desc: "雨天午後,房客們擠在交誼廳取暖", hidden: true },
  // --- 圓夢畢業批:兩軌制心願 + 房東口碑 ---
  { id: "first_graduate", icon: "🎓", label: "首位畢業生", desc: "第一位租客圓夢畢業,從這裡走向新的人生" },
  { id: "graduate_3", icon: "🎓", label: "桃李天下", desc: "三位租客從這裡圓夢畢業" },
  { id: "first_model_tenant", icon: "🏠", label: "第一位模範房客", desc: "有租客圓夢後宣告長住,成為模範房客" },
  { id: "couple_wish", icon: "💑", label: "雙雙圓夢", desc: "一對情侶先後實現了各自的人生心願", hidden: true },
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

/** 退租時把房客存進名冊(moveOut 在刪除 runtime 前呼叫);自己養的貓一起走時在記憶裡提一筆 */
export function recordAlumnus(rt: TenantRuntime, reason: string) {
  const moveInMs = rt.moveInMs ?? GAME_START.getTime();
  const daysLived = Math.max(0, Math.floor((state.gameMs - moveInMs) / (24 * 3600 * 1000)));
  const pet = state.pets[rt.tenant.id];
  const petNote = pet && pet.ownerId === rt.tenant.id ? `帶著愛${pet.kind === "dog" ? "狗" : "貓"}「${pet.name}」一起離開。` : "";
  const entry: AlumniEntry = {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    daysLived,
    reason,
    leftMs: state.gameMs,
    memory: (petNote + representativeMemory(rt)).slice(0, 120),
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
  const rts = Object.values(state.runtimes);
  if (rts.some((rt) => (rt.tenant.growthTags?.length ?? 0) >= 1)) unlock("first_growth");
  if (rts.some((rt) => (rt.tenant.growthTags?.length ?? 0) >= 4)) unlock("growth_full");
}
