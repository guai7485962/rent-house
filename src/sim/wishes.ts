/**
 * 租客人生心願(路線圖「玩家目標與樂趣」第 1 項)。
 *
 * 每位租客入住時依職業獲得一個長期人生目標(存錢開店/完成代表作/站穩工作…)。
 * 進度完全由本地規則每日推進——租客當天過得好(條件依心願而異)進度就前進,
 * 困頓時小幅倒退;AI 只拿到一句進度描述當寫作素材,不能決定進度或宣布實現。
 *
 * 完成時:慶祝日誌 + 記憶 + 永久成長特質 + 成就;之後走兩軌(圓夢畢業批):
 *   - 畢業型(graduates:開店/論文/舞台/代表作):幾天後「圓夢離開」——由 tick 換日
 *     呼叫 wishPass() 取回名單執行 graduateFarewell(謝禮紅包+押金退還+口碑,再 moveOut;
 *     wishes 不 import tenancy/economy,避免循環依賴)。有貓的會先掛「貓的去留」抉擇。
 *   - 安居型(career_step/recover_rhythm/feel_at_home/settle_life):留下成為
 *     「🏠 模範房客」——自願 +3% 租金、在住期間全樓其他租客每日 mood +0.5(多位不疊超過 +1)。
 * 全程不消耗 Math.random,不影響其他系統的 RNG 次序。
 */
import {
  state,
  clamp,
  gameDayIndex,
  calendarGameDayIndex,
  GAME_START,
  notify,
  pushMemory,
  pushSocialLog,
  roomOfTenant,
  type TenantRuntime,
} from "./gameState";
import { roomAttributes } from "./placements";
import type { RoomAttribute } from "../types";
import { grantGrowthTag, GROWTH_TAGS, type GrowthTagId } from "./growth";
import { relationships } from "./social";
import { unlock } from "./legacy";
import { addReputation, REP_SETTLE, REP_GRADUATE, REP_SETTLE_GRADUATE } from "./reputation";
import type { EventDef } from "./events";

/** 同 economy.inHardship;不 import economy,避免 wishes→economy→tick→wishes 循環鏈 */
const inHardship = (rt: TenantRuntime) => gameDayIndex() <= (rt.hardshipUntilDay ?? -99);

export interface TenantWish {
  id: WishId;
  progress: number; // 0~100
  fulfilledDay: number; // 實現的遊戲日;-99 = 尚未實現
  graduateDay: number; // 排定圓夢離開的遊戲日;-99 = 不會/尚未排定
  announced: boolean; // 是否已預告即將搬走(只留一次日誌)
}

export interface WishDef {
  icon: string;
  label: string; // 「存一筆自己的小店基金」
  hint: string; // chip tooltip / AI 素材的補充語意
  occupations: readonly string[]; // 依職業指派(完全比對;比不到 → fallback settle_life)
  /** 每日進度增量(依租客當天狀態;可小幅為負;不得用 RNG) */
  gain: (rt: TenantRuntime) => number;
  /** 完成後是否會在幾天後圓夢離開(搬離公寓,進名冊) */
  graduates: boolean;
  /** 完成時授予的永久成長特質 */
  growthTag: GrowthTagId;
  doneText: string; // 🎉 實現時的日誌
  farewellText: string; // 📦 圓夢離開前的預告日誌(graduates 才用)
}

const GAIN_GOOD = 4; // 順利的一天
const GAIN_SLOW = 2; // 勉強有進展
const SETBACK = -2; // 困頓的一天(進度小幅倒退)
export const GRADUATE_AFTER_DAYS = 6; // 實現後幾天圓夢離開
/** 安居型模範房客的安居期(遊戲日):明顯長於畢業型的 6 天,體現忠誠與「像家」的價值;
 *  安居期滿後因人生下一步(成家/外派/買房)圓滿搬離,釋出房間讓新租客流入。
 *  設 20 天(> balance-test 的 10 天快照窗 → 快照期間不會觸發搬離,理論零漂移)。 */
export const SETTLE_TENURE_DAYS = 20;
const MILESTONES = [25, 50, 75] as const;
type Milestone = (typeof MILESTONES)[number];

/** 決定性索引(不消耗 Math.random,避免擾動其他系統的 RNG 次序與 balance 快照)。 */
function settleIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 安居圓滿搬離的離開原因(2~3 種:成家/外派/買房),進 alumni 名冊;依 id 決定性挑選。 */
const SETTLE_DEPART_REASONS = [
  "安居圓滿搬離:和另一半決定成家,搬去兩人的新居",
  "安居圓滿搬離:工作外派他鄉,帶著這裡的溫暖赴任",
  "安居圓滿搬離:存夠了頭期款,買下屬於自己的房子",
] as const;
export function settleDepartReason(id: string): string {
  return SETTLE_DEPART_REASONS[settleIndex(id) % SETTLE_DEPART_REASONS.length];
}

/** 安居圓滿搬離前 2 天的打包預告文案(比照畢業型 farewellText);依 id 決定性挑選。 */
const SETTLE_FAREWELL_TEXTS = [
  "他把這些年的日子一箱箱打包,笑著說要帶著這裡的溫暖,去人生的下一站。",
  "行李慢慢堆到門口,他一邊收拾一邊回頭望——這裡把日子過成了家,如今要帶著這份踏實往前走。",
  "他把住成家的這段時光仔細收好,準備啟程,眼裡是安穩,也有不捨。",
] as const;
function settleFarewellText(id: string): string {
  return SETTLE_FAREWELL_TEXTS[settleIndex(id) % SETTLE_FAREWELL_TEXTS.length];
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * 舊存檔沒有午夜制的安居起點時，優先從「心願成真」日誌還原真正完成日。
 * 日誌若已因容量上限被裁掉，再用舊 fulfilledDay 推估其每日結算午夜。
 */
function inferredModelCalendarDay(rt: TenantRuntime): number {
  for (let i = rt.log.length - 1; i >= 0; i--) {
    const entry = rt.log[i];
    if (entry.text.startsWith("🎉 心願成真:") && Number.isFinite(entry.gameMs)) {
      return calendarGameDayIndex(entry.gameMs);
    }
  }
  const fulfilledDay = rt.wish?.fulfilledDay;
  if (Number.isFinite(fulfilledDay) && fulfilledDay! >= 0) {
    const hoursToFirstMidnight = (24 - GAME_START.getHours()) % 24;
    return calendarGameDayIndex(GAME_START.getTime() + fulfilledDay! * DAY_MS + hoursToFirstMidnight * 3600 * 1000);
  }
  return calendarGameDayIndex();
}

/** 模範房客的安居期滿搬離日(= 成為模範的日曆日 + 安居期)。 */
export function settleDepartDay(rt: TenantRuntime): number {
  const since = Number.isFinite(rt.modelSinceCalendarDay)
    ? rt.modelSinceCalendarDay!
    : inferredModelCalendarDay(rt);
  return since + SETTLE_TENURE_DAYS;
}

/** 同棟在住者中最好的關係值(把樓住成家的量尺) */
/**
 * 這位租客房間的家具屬性總和。2026-08-09 新增的三條心願靠它把「房東買家具」
 * 變成推進條件——`wishes → placements` 不成環(placements 只依賴 map/catalog/upgrades)。
 * 查不到房間(理論上不會)時回空物件,那條心願就停在 0,不會拋錯。
 */
function roomAttributesOf(rt: TenantRuntime): Partial<Record<RoomAttribute, number>> {
  const roomId = roomOfTenant(rt.tenant.id);
  return roomId ? roomAttributes(roomId) : {};
}

function bestNeighborRel(tenantId: string): number {
  let best = 0;
  for (const [key, rel] of Object.entries(relationships)) {
    const [a, b] = key.split("|");
    if (a !== tenantId && b !== tenantId) continue;
    const other = a === tenantId ? b : a;
    if (state.runtimes[other] && rel.value > best) best = rel.value;
  }
  return best;
}

export const WISH_DEFS = {
  open_shop: {
    icon: "☕",
    label: "存一筆自己的小店基金",
    hint: "達成方式：避免欠租與財務困難，並讓他保留至少約八成月租的存款；符合時每天進度最快。",
    occupations: ["咖啡師", "甜點師", "調酒師", "健身教練", "花藝師", "夜市滷味攤主"],
    gain: (rt) => {
      if (inHardship(rt) || (rt.arrears ?? 0) > 0) return SETBACK;
      return (rt.wallet ?? 0) >= rt.tenant.finance.monthlyRent * 0.8 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: true,
    growthTag: "decisive",
    doneText: "開店基金存到了!他反覆看著存摺,像是不敢相信。",
    farewellText: "店面談好了,他開始一箱一箱打包,眼裡都是光。",
  },
  finish_masterwork: {
    icon: "✍️",
    label: "完成一部代表作",
    hint: "達成方式：把壓力維持在 65 以下、精力維持在 35 以上；壓力達 85 會讓進度倒退。",
    // 2026-08-09:`ASMR 實況主` 移到自己的 grow_channel(它的槓桿是隔音,不是壓力)。
    occupations: ["漫畫家", "推理小說家", "自由接案設計師", "獨立遊戲開發者"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (s.stress >= 85) return SETBACK;
      return s.stress <= 65 && s.energy >= 35 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: true,
    growthTag: "more_confident",
    doneText: "代表作完成了!他把成品看了一遍又一遍,笑得像個孩子。",
    farewellText: "代表作打開了新的門,他租下了自己的工作室,正一箱一箱把作品和心血搬過去。",
  },
  graduate_thesis: {
    icon: "🎓",
    label: "把論文寫完順利畢業",
    hint: "達成方式：把壓力維持在 70 以下、精力維持在 30 以上；壓力達 85 會讓進度倒退。",
    occupations: ["研究生"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (s.stress >= 85) return SETBACK;
      return s.stress <= 70 && s.energy >= 30 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: true,
    growthTag: "resilient",
    doneText: "口試通過!他把印好的論文抱在懷裡,在房間繞了三圈。",
    farewellText: "畢業了,他準備搬去新城市開始第一份正職,行李越收越多。",
  },
  career_step: {
    icon: "💼",
    label: "在工作上站穩腳步",
    hint: "達成方式：避免財務困難，並把精力維持在 40 以上、壓力維持在 70 以下。",
    occupations: ["上班族", "後端工程師", "大樓保全"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (inHardship(rt)) return SETBACK;
      return s.energy >= 40 && s.stress <= 70 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: false,
    growthTag: "grounded",
    doneText: "工作總算站穩了!他難得早早關了電腦,給自己開了一罐好的。",
    farewellText: "",
  },
  recover_rhythm: {
    icon: "🌿",
    label: "把身體養回健康的節奏",
    hint: "達成方式：把健康維持在 60 以上、壓力維持在 60 以下；健康降到 35 以下會倒退。",
    occupations: ["夜班護理師", "夜班重訓教練"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (s.wellbeing <= 35) return SETBACK;
      return s.wellbeing >= 60 && s.stress <= 60 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: false,
    growthTag: "asks_for_help",
    doneText: "體檢報告全綠!她把報告貼在冰箱上,終於把自己照顧好了。",
    farewellText: "",
  },
  stage_dream: {
    icon: "🎤",
    label: "站上一次正式的舞台",
    hint: "達成方式：把心情維持在 55 以上、精力維持在 40 以上；心情降到 30 以下會倒退。",
    occupations: ["樂團鼓手", "電競系學生", "電競戰隊教練"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (s.mood <= 30) return SETBACK;
      return s.mood >= 55 && s.energy >= 40 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: true,
    growthTag: "hopeful",
    doneText: "正式登台了!他回家時嗓子都啞了,臉上的興奮藏都藏不住。",
    farewellText: "那晚的演出被劇團看上,簽約巡演的邀請來了——他一邊打包一邊哼著歌,整個人在發光。",
  },
  // ── 2026-08-09 擴充:8 → 14 條(使用者要求更多職業目標)──────────────────────
  // 每一條刻意掛在**不同的玩家槓桿**上,不然多加的目標只是換句話說:
  //   own_studio 收納+品味家具 / grow_channel 隔音家具 / certify_pro 精力與壓力 /
  //   save_for_travel 現金與欠租 / keep_home_clean 整潔 / teach_someone 鄰居關係。
  // 既有八條的 id、順序與 gain 一格未動(wishIdForOccupation 是照物件順序第一個命中)。
  own_studio: {
    icon: "🏺",
    label: "擁有一間自己的工作室",
    hint: "達成方式：把房間的收納與品味加起來養到 24 以上（買收納櫃、有質感的家具）；14 以上會緩慢前進。",
    occupations: ["陶藝工作者", "婚禮攝影師", "二手黑膠店主"],
    gain: (rt) => {
      const attrs = roomAttributesOf(rt);
      const craft = (attrs.storage ?? 0) + (attrs.style ?? 0);
      if (inHardship(rt)) return SETBACK;
      return craft >= 24 ? GAIN_GOOD : craft >= 14 ? GAIN_SLOW : 0;
    },
    graduates: true,
    growthTag: "decisive",
    doneText: "工作室的鑰匙拿到手了!他把作品一件件排上新架子,退後三步看了很久。",
    farewellText: "工作室要開張了,他把這裡的東西仔細打包——每一箱都貼著手寫標籤。",
  },
  grow_channel: {
    icon: "🎧",
    label: "養出一群固定的聽眾",
    hint: "達成方式：把房間隔音養到 10 以上（隔音棉、厚窗簾、地毯），並把壓力壓在 70 以下；隔音 5 以上會緩慢前進。",
    occupations: ["ASMR 實況主"],
    gain: (rt) => {
      const quiet = roomAttributesOf(rt).soundproof ?? 0;
      if (rt.tenant.stats.stress >= 85) return SETBACK;
      if (quiet >= 10) return rt.tenant.stats.stress <= 70 ? GAIN_GOOD : GAIN_SLOW;
      if (quiet >= 5) return GAIN_SLOW;
      // 完全沒隔音也還是每天爬一格 —— 種子租客林就是這條,不能一開局就卡死在 0。
      return 1;
    },
    graduates: true,
    growthTag: "more_confident",
    doneText: "訂閱數過線了!她摘下耳機愣了幾秒,才敢相信那些數字是真的。",
    farewellText: "簽了經紀約,要搬去有專業錄音間的地方——她把吸音棉一片片拆下來,動作很輕。",
  },
  certify_pro: {
    icon: "📜",
    label: "考到那張執照",
    hint: "達成方式：把精力維持在 45 以上、壓力維持在 65 以下（好睡的床與安靜的房間）；精力低於 25 會倒退。",
    occupations: ["獸醫助理", "補習班英文老師", "幼兒園老師"],
    gain: (rt) => {
      const s = rt.tenant.stats;
      if (s.energy <= 25) return SETBACK;
      return s.energy >= 45 && s.stress <= 65 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: false,
    growthTag: "resilient",
    doneText: "放榜了——上了!他把成績單拍下來傳給家人,手還在抖。",
    farewellText: "",
  },
  save_for_travel: {
    icon: "✈️",
    label: "存一趟遠行的旅費",
    hint: "達成方式：不要讓他欠租或陷入財務困難，並保留至少約半個月租的存款。",
    occupations: ["外送員"],
    gain: (rt) => {
      if (inHardship(rt) || (rt.arrears ?? 0) > 0) return SETBACK;
      return (rt.wallet ?? 0) >= rt.tenant.finance.monthlyRent * 0.5 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: true,
    growthTag: "hopeful",
    doneText: "機票訂好了!他把行程表貼在牆上,每天下班都要看一眼。",
    farewellText: "出發的日子近了,他把房間收得乾乾淨淨,說回來時想換個地方重新開始。",
  },
  keep_home_clean: {
    icon: "🧹",
    label: "把生活維持在乾淨的樣子",
    hint: "達成方式：把房間整潔維持在 70 以上、滿意維持在 55 以上（及時修繕、掃地機器人）；整潔低於 35 會倒退。",
    occupations: ["獨立書店店員", "到府收納師"],
    gain: (rt) => {
      if (rt.cleanliness <= 35) return SETBACK;
      return rt.cleanliness >= 70 && rt.satisfaction >= 55 ? GAIN_GOOD : GAIN_SLOW;
    },
    graduates: false,
    growthTag: "grounded",
    doneText: "房間終於維持成他想要的樣子了。他泡了杯茶,坐下來什麼也不做,只是看著。",
    farewellText: "",
  },
  teach_someone: {
    icon: "📖",
    label: "把會的東西傳給一個人",
    hint: "達成方式：安排公共空間相處，讓他與至少一位鄰居的關係達到 45，且心情維持在 50 以上；關係 25 以上也會緩慢前進。",
    occupations: ["退休教師"],
    gain: (rt) => {
      const best = bestNeighborRel(rt.tenant.id);
      if (best >= 45 && rt.tenant.stats.mood >= 50) return GAIN_GOOD;
      return best >= 25 ? GAIN_SLOW : 0;
    },
    graduates: false,
    growthTag: "patient",
    doneText: "他看著對方獨立完成了整件事,沒有出手幫忙——只是站在旁邊,笑得很滿足。",
    farewellText: "",
  },
  feel_at_home: {
    icon: "🏡",
    label: "把這棟樓住成自己的家",
    hint: "達成方式：安排公共空間相處，讓他與至少一位鄰居的關係達到 50；30 以上也會緩慢前進。",
    // 2026-08-09:`退休教師` 移到 teach_someone(那條的槓桿相同但終點不同:教會一個人)。
    occupations: ["瑜伽老師", "社區里幹事"],
    gain: (rt) => {
      const best = bestNeighborRel(rt.tenant.id);
      return best >= 50 ? GAIN_GOOD : best >= 30 ? GAIN_SLOW : 0;
    },
    graduates: false,
    growthTag: "patient",
    doneText: "這裡真的成家了。樓裡每個人的作息、口味,他都記在心上。",
    farewellText: "",
  },
  settle_life: {
    icon: "🌤️",
    label: "把日子過成自己喜歡的樣子",
    hint: "達成方式：改善房間與日常，把滿意維持在 60 以上、心情維持在 55 以上；滿意 45 以上也會緩慢前進。",
    occupations: [], // fallback:比不到職業的都算這條
    gain: (rt) => {
      const s = rt.tenant.stats;
      return rt.satisfaction >= 60 && s.mood >= 55 ? GAIN_GOOD - 1 : rt.satisfaction >= 45 ? 1 : 0;
    },
    graduates: false,
    growthTag: "hopeful",
    doneText: "日子終於過成自己喜歡的樣子了。他環顧房間,滿足地嘆了口氣。",
    farewellText: "",
  },
} satisfies Record<string, WishDef>;

export type WishId = keyof typeof WISH_DEFS;

/** 每條心願專屬的 25/50/75 里程碑劇情句——描述該租客為「這個具體夢想」做的努力。
 *  沿用既有里程碑日誌槽(每條心願一生最多 3 筆 notable),不新增日誌條目數 → 零 balance 影響。 */
export const WISH_MILESTONES: Record<WishId, Record<Milestone, string>> = {
  open_shop: {
    25: "開始偷偷記帳,研究開一家店要備多少本",
    50: "存款有了雛形,趁休假去看了幾處空店面",
    75: "連菜單和招牌樣式都擬好了,只差臨門一腳",
  },
  finish_masterwork: {
    25: "把擱置很久的點子重新翻出來,鋪出故事的骨架",
    50: "主線寫到過半,筆下的人物慢慢活了起來",
    75: "收尾的章節攤在桌上,反覆打磨每個細節",
  },
  graduate_thesis: {
    25: "文獻讀過一輪,研究方向總算清晰起來",
    50: "實驗數據跑出過半,論文章節一格格填了上去",
    75: "口委的意見都改完了,開始練習上台答辯",
  },
  career_step: {
    25: "手邊的案子越接越順,漸漸摸清了工作節奏",
    50: "同事開始把要緊的事交過來,擔子接得穩",
    75: "主管口頭提了幾句,升遷或加薪似乎不遠了",
  },
  recover_rhythm: {
    25: "開始固定早睡、三餐吃回正常,氣色好了些",
    50: "作息穩住過半,回診時醫生也點頭說有進步",
    75: "身體越來越輕盈,每週的運動重新排了回來",
  },
  stage_dream: {
    25: "重新拾起樂器,把基本功一遍遍練了回來",
    50: "排練進度過半,和團員的默契一次次對上拍子",
    75: "演出曲目全都熟透,只等正式登台那一刻",
  },
  own_studio: {
    25: "開始把工具與半成品分門別類,房裡漸漸有了工作區的樣子",
    50: "架子與檯面都到位了,做起東西順手許多",
    75: "作品排滿一整面牆,連燈光角度都調過——只差一個真正的門牌",
  },
  grow_channel: {
    25: "把最吵的那面牆補上吸音材,重錄的次數少了一半",
    50: "固定的聽眾慢慢回流,留言區開始有人喊「晚安」",
    75: "每一集的底噪都壓得極乾淨,再來只差一次被看見",
  },
  certify_pro: {
    25: "把考古題印了一疊,晚班之後也硬撐著讀完一章",
    50: "進度過半,錯題本越寫越薄",
    75: "模擬考穩定過線了,只剩心態要調整",
  },
  save_for_travel: {
    25: "把想去的地方寫在便條紙上,開始每天存一點",
    50: "存款過半,連轉機路線都研究得很清楚",
    75: "旅費幾乎湊齊,護照拿去換了新的",
  },
  keep_home_clean: {
    25: "開始每天固定收拾一小塊,房間不再堆著沒拆的箱子",
    50: "整潔維持得住了,連書都照著自己的邏輯排好",
    75: "房間穩定在讓他安心的樣子,回家會先深吸一口氣",
  },
  teach_someone: {
    25: "有人來問他問題,他認真回答了很久",
    50: "對方開始固定來請教,他也開始準備起「教材」",
    75: "那個人已經做得有模有樣,他退到旁邊只看不出手",
  },
  feel_at_home: {
    25: "開始記得鄰居的名字,走廊上會停下來聊幾句",
    50: "公共空間漸漸有了熟悉的身影,和誰都聊得上",
    75: "樓裡的人都當成自己人,這裡越來越像家",
  },
  settle_life: {
    25: "慢慢把房間整理成順手的樣子,日子有了頭緒",
    50: "生活節奏抓穩過半,連假日都排得有滋有味",
    75: "想要的樣子已有輪廓,日子過得越來越自在",
  },
};

/** 心願「達成後」走向與成長特質(純函式;供房客頁「🎁 達成後」段與 chip tooltip 用)。
 *  文字如實對應 fulfillWish/graduateFarewell/becomeModelTenant 的實際獎勵,不落任何狀態。 */
export interface WishOutcome {
  graduates: boolean;
  headline: string; // 軌別走向標題
  lines: readonly string[]; // 1~2 句走向說明
  growthLabel: string; // 成長特質名(去括號,如「更敢做決定」)
  growthHint: string; // 成長特質說明
}
export function wishOutcomeBrief(def: WishDef): WishOutcome {
  const tag = GROWTH_TAGS[def.growthTag];
  const growthLabel = tag.label.replace(/[[\]【】]/g, "");
  if (def.graduates) {
    return {
      graduates: true,
      headline: "📦 圓夢後風光搬離,展開新生活",
      lines: [
        "實現當下心情大振、習得永久成長特質。",
        `${GRADUATE_AFTER_DAYS} 天後全樓辦一場歡送會,留下告別信與專屬紀念物家具在房間,並奉上謝禮紅包(約半個月租×好感)與退還押金,房東口碑 +${REP_GRADUATE}。`,
      ],
      growthLabel,
      growthHint: tag.hint,
    };
  }
  return {
    graduates: false,
    headline: "🏠 先安居成模範房客,之後圓滿搬離",
    lines: [
      "實現當下心情大振、習得永久成長特質。",
      `之後自願多付 3% 月租、在住期間帶動全樓每天心情微升,房東口碑 +${REP_SETTLE}。`,
      `安居約 ${SETTLE_TENURE_DAYS} 天後,會帶著這裡的溫暖圓滿搬離、展開人生下一步(成家/外派/買房),釋出房間——離開時同樣有全樓歡送會、告別信、專屬紀念物、謝禮紅包與退還押金,房東口碑 +${REP_SETTLE_GRADUATE}。`,
    ],
    growthLabel,
    growthHint: tag.hint,
  };
}

/** 心願「結果」的三種階段:
 *  preview  = 尚未達成,預告圓夢後會搬離 / 會留下;
 *  leaving  = 已達成畢業型,打包倒數中(N 天後搬離);
 *  stayed   = 已達成安居型,已成模範房客長住(不會離開)。 */
export type WishResultPhase = "preview" | "leaving" | "stayed";
export interface WishResult {
  phase: WishResultPhase;
  graduates: boolean; // 這條心願是「畢業型」(圓夢後很快搬離)還是「安居型」(先安居再圓滿搬離)
  leaves: boolean; // 一眼結論:這房客最終會不會離開這棟樓(兩軌如今都會離開,恆為 true)
  headline: string; // 段落標題(帶 emoji)
  verdictTag: string; // 最醒目的短標(🚪 即將搬離 / 🏠 安居後圓滿搬離…);顏色依 graduates 分流
  verdict: string; // 最醒目的一句「會不會離開/何時離開」結論
  lines: readonly string[]; // 走向細節
  daysLeft?: number; // leaving/stayed 才有:距離搬離還有幾天(≥0)
  growthLabel?: string; // preview 才附:將習得的成長特質名
  growthHint?: string;
}

/** 依租客當前 wish runtime 狀態回傳結構化「結果」(純函式、零副作用)。
 *  不管達成與否都給結論,重點是「這房客會不會離開」,讓玩家一眼知道怎麼處理。
 *  種類的「會/不會離開」以 def.graduates 判定;階段以 fulfilledDay/graduateDay/modelTenant 判定。 */
export function wishResult(rt: TenantRuntime): WishResult | null {
  const w = rt.wish;
  if (!w) return null;
  const def = WISH_DEFS[w.id] as WishDef | undefined;
  if (!def) return null;
  const base = wishOutcomeBrief(def);

  // 尚未達成:預告圓夢後的去留(附走向 + 將習得的成長特質)
  if (w.fulfilledDay === -99) {
    return {
      phase: "preview",
      graduates: def.graduates,
      leaves: true, // 兩軌最終都會離開
      headline: "🎁 達成後會怎樣",
      verdictTag: def.graduates ? "🚪 圓夢後搬離" : "🏠 安居後圓滿搬離",
      verdict: def.graduates
        ? "圓夢後會搬離公寓,展開新生活"
        : "先當一陣子模範房客安居,之後圓滿搬離、展開人生下一步",
      lines: base.lines,
      growthLabel: base.growthLabel,
      growthHint: base.growthHint,
    };
  }

  // 已達成 · 畢業型:打包倒數中,N 天後搬離(邊角/當天 → N=0 顯示即將搬離)
  if (def.graduates) {
    const target = w.graduateDay === -99 ? gameDayIndex() + GRADUATE_AFTER_DAYS : w.graduateDay;
    const daysLeft = Math.max(0, target - gameDayIndex());
    return {
      phase: "leaving",
      graduates: true,
      leaves: true,
      daysLeft,
      headline: "📦 即將搬離",
      verdictTag: "🚪 即將搬離",
      verdict: daysLeft > 0 ? `已圓夢,將於 ${daysLeft} 天後搬離` : "已圓夢,即將搬離",
      lines: [
        "他要離開這棟樓,展開新生活了。",
        "把握最後這幾天:全樓會辦一場歡送會,他會在房間留下專屬紀念物,你也會奉上謝禮紅包並退還押金。",
      ],
    };
  }

  // 已達成 · 安居型:成為模範房客安居中,安居期滿後圓滿搬離(顯示剩餘 N 天)
  const daysLeft = Math.max(0, settleDepartDay(rt) - calendarGameDayIndex());
  return {
    phase: "stayed",
    graduates: false,
    leaves: true,
    daysLeft,
    headline: "🏠 安居中(模範房客)",
    verdictTag: "🏠 安居後圓滿搬離",
    verdict: daysLeft > 0
      ? `安居倒數:剩 ${daysLeft} 天,之後圓滿展開人生下一步`
      : "安居倒數:剩 0 天,今日結算後展開人生下一步",
    lines: [
      "他把這裡住成了家,正享受一段安穩的安居時光,自願多付 3% 月租、帶動全樓每天心情微升。",
      "安居期滿後會帶著這裡的溫暖圓滿搬離,前往人生下一步(成家/外派/買房),釋出房間。",
      "離開時同樣有全樓歡送會、告別信、專屬紀念物、謝禮紅包與退還押金。",
    ],
  };
}

/** 依職業指派心願 id(完全比對;比不到 → settle_life) */
export function wishIdForOccupation(occupation: string): WishId {
  for (const [id, def] of Object.entries(WISH_DEFS)) {
    if ((def as WishDef).occupations.includes(occupation)) return id as WishId;
  }
  return "settle_life";
}

/** 幫還沒有心願的租客指派(新入住/舊存檔載入都會補;冪等)。
 *  壞檔防線:心願 id 不在白名單 → 丟棄重新指派。 */
export function ensureWishes(): boolean {
  let repaired = false;
  for (const rt of Object.values(state.runtimes)) {
    if (rt.wish && !WISH_DEFS[rt.wish.id]) rt.wish = null;
    if (!rt.wish) {
      rt.wish = {
        id: wishIdForOccupation(rt.tenant.occupation),
        progress: 0,
        fulfilledDay: -99,
        graduateDay: -99,
        announced: false,
      };
    }
    // 舊模範房客只有以 22:00 換日的 modelSinceDay，或上一版曾把缺值補成載入當天。
    // 從心願完成日還原午夜制起點，並在 runtime 入口自癒長時間未重載/HMR 的記憶體狀態。
    const def = WISH_DEFS[rt.wish.id] as WishDef;
    const completedSettleWish = rt.wish.fulfilledDay !== -99 && !def.graduates;
    // 最早期的安居心願版本只有 fulfilledDay，尚未把 modelTenant 寫入存檔。
    // 已完成安居型心願在合法流程中必定是模範房客；只補狀態，不重跑 becomeModelTenant，
    // 避免再次加租、加口碑、發成就或慶祝通知。
    if (completedSettleWish && rt.modelTenant !== true) {
      rt.modelTenant = true;
      repaired = true;
    }
    if (completedSettleWish) {
      const inferred = inferredModelCalendarDay(rt);
      if (!Number.isFinite(rt.modelSinceCalendarDay) || rt.modelSinceCalendarDay! > inferred) {
        rt.modelSinceCalendarDay = inferred;
        repaired = true;
      }
    }
  }
  return repaired;
}

/** 進度推進的共用入口(每日 pass 與劇情弧收束加成都走這裡):
 *  處理夾值、里程碑日誌(一次只報最高的那個)與 100% 實現。 */
function advanceWish(rt: TenantRuntime, delta: number) {
  const w = rt.wish;
  if (!w || w.fulfilledDay !== -99 || delta === 0) return;
  const def = WISH_DEFS[w.id] as WishDef;
  const prev = w.progress;
  w.progress = clamp(Math.round(prev + delta), 0, 100);
  const crossed = [...MILESTONES].reverse().find((m) => prev < m && w.progress >= m);
  if (w.progress >= 100) {
    fulfillWish(rt, def);
  } else if (crossed) {
    pushSocialLog(rt, `🎯 朝「${def.label}」邁進:${WISH_MILESTONES[w.id][crossed]}。`, "notable");
  }
}

/** 心願實現:慶祝脈衝 + 記憶 + 永久成長 + 成就;之後兩軌分流(畢業排離開/安居成模範) */
function fulfillWish(rt: TenantRuntime, def: WishDef) {
  const w = rt.wish!;
  const day = gameDayIndex();
  w.progress = 100;
  w.fulfilledDay = day;
  const s = rt.tenant.stats;
  s.mood = clamp(s.mood + 10, 0, 100);
  s.stress = clamp(s.stress - 8, 0, 100);
  pushSocialLog(rt, `🎉 心願成真:「${def.label}」!${def.doneText}`, "major");
  pushMemory(rt.tenant, "[心願成真]", `長久以來的心願「${def.label}」實現了,整個人都發著光`, "ai_event");
  const growth = grantGrowthTag(rt.tenant, def.growthTag);
  if (growth) pushSocialLog(rt, `🌱 成長:${growth.label}——${growth.hint}`, "notable");
  notify(`${def.icon} ${rt.tenant.name} 的心願「${def.label}」實現了!`);
  state.wishesFulfilled += 1;
  unlock("wish_fulfilled");
  if (state.wishesFulfilled >= 3) unlock("wish_collector");
  if (def.graduates) {
    w.graduateDay = day + GRADUATE_AFTER_DAYS;
    maybeAttachCatFarewell(rt); // 有貓的:告別週先讓玩家決定貓的去留
  } else {
    becomeModelTenant(rt); // 安居型:留下來,成為模範房客
  }
  // 💑 雙雙圓夢(隱藏成就):情侶兩人都把心願住成真了
  const id = rt.tenant.id;
  for (const [key, rel] of Object.entries(relationships)) {
    if (!rel.romantic) continue;
    const [a, b] = key.split("|");
    if (a !== id && b !== id) continue;
    const other = state.runtimes[a === id ? b : a];
    if (other?.wish && other.wish.fulfilledDay !== -99) {
      unlock("couple_wish");
      break;
    }
  }
}

/** 安居型心願實現 → 模範房客:自願 +3% 租金 + 續住宣言 + 口碑 +3(冪等) */
function becomeModelTenant(rt: TenantRuntime) {
  if (rt.modelTenant) return;
  rt.modelTenant = true;
  rt.modelSinceDay = gameDayIndex(); // 舊欄位保留相容既有存檔
  rt.modelSinceCalendarDay = calendarGameDayIndex(); // 午夜制安居期起點
  const f = rt.tenant.finance;
  // 租金自願 +3%:只有承租人才有租可加(同居者本來就不付租)
  if (Object.values(state.occupancy).includes(rt.tenant.id)) {
    const next = Math.round(f.monthlyRent * 1.03);
    pushSocialLog(rt, `💲 他主動來找你:「這裡讓我把日子過成了想要的樣子,房租我想多付一點。」月租 $${f.monthlyRent.toLocaleString()} → $${next.toLocaleString()}。`, "major");
    f.monthlyRent = next;
  }
  pushSocialLog(rt, `🏠 續住宣言:「我打算在這裡長長久久住下去。」他成了整棟樓安穩的底氣。`, "major");
  notify(`🏠 ${rt.tenant.name} 圓夢後決定長住,成為模範房客!`);
  unlock("first_model_tenant");
  addReputation(REP_SETTLE, `${rt.tenant.name} 在這裡安居圓夢`);
}

/** 畢業型心願實現且租客有寵物 → 立即掛規則式去留抉擇(不經 AI;玩家未決 = 離開時帶走)。
 *  永久樓寵物最多 2 隻；滿額時仍可由公寓暫住中途，等原主人安頓後接回。 */
function maybeAttachCatFarewell(rt: TenantRuntime) {
  const pet = state.pets[rt.tenant.id];
  if (!pet || pet.ownerId !== rt.tenant.id || rt.pendingEvent) return;
  const species = pet.kind === "dog" ? "狗" : "貓";
  const houseSpecies = pet.kind === "dog" ? "公寓犬" : "樓貓";
  const permanentCount = Object.values(state.pets).filter((candidate) =>
    candidate.ownerId === "landlord" && (candidate.housePlacement ?? "permanent") === "permanent").length;
  const canStayPermanently = permanentCount < 2;
  const ev: EventDef = {
    id: "wish_pet_farewell",
    title: `「${pet.name}」的去留`,
    description: `${rt.tenant.name} 帶著「${pet.name}」來找你:「新住處還不確定能不能養${species}……牠在這棟樓有熟悉的角落,我可以帶牠走，也可以請公寓暫時幫忙。」${canStayPermanently ? "" : "（永久樓寵物名額已滿）"}`,
    choices: [
      { id: "take", label: "讓他帶牠一起走", hint: `${species}跟著主人開始新生活`, effect: {} },
      ...(canStayPermanently
        ? [{ id: "stay", label: `永久留下當${houseSpecies}`, hint: "使用一個永久樓寵物名額", effect: {} }]
        : []),
      { id: "foster", label: "由公寓暫住中途", hint: "5～8 天後由主人安頓好接回", effect: {} },
    ],
  };
  rt.pendingEvent = ev;
  notify(`🐈 ${rt.tenant.name} 準備搬家,想和你談談「${pet.name}」的去留`);
}

/** 劇情弧收束的心願加成(narration.applyArcUpdate 呼叫):
 *  一段篇章好好落幕 = 人生也往前走了一步(基調 down 的失落收場不加)。 */
export function boostWishFromArc(rt: TenantRuntime, tone?: string | null) {
  if (tone === "down") return;
  advanceWish(rt, 6);
}

/**
 * 只收集「安居期已到期」的模範房客，不推進其他心願、也不套每日光環。
 * 啟動讀檔時用它立即補做舊存檔的到期離場，避免 daysLeft=0 還卡到下一個午夜。
 */
export function settleDeparturesDue(): { id: string; reason: string }[] {
  const due: { id: string; reason: string }[] = [];
  for (const rt of Object.values(state.runtimes)) {
    // 與 UI 共用同一個結果來源：畫面只要顯示安居「剩 0 天」，
    // 這裡就必須無條件列入到期名單，不能再有第二套資格條件造成分歧。
    const result = wishResult(rt);
    if (result?.phase === "stayed" && result.daysLeft === 0) {
      due.push({ id: rt.tenant.id, reason: settleDepartReason(rt.tenant.id) });
    }
  }
  return due;
}

/** 每日心願推進(tick 換日呼叫)。回傳今天該「圓夢離開」的名單,
 *  由呼叫端(tick)執行 graduateFarewell/moveOut——wishes 不 import tenancy,避免循環依賴。 */
export function wishPass(): { id: string; reason: string }[] {
  ensureWishes();
  // 🏠 模範房客光環:在住期間全樓「其他」租客每日 mood +0.5;多位模範同住不疊超過 +1
  const models = Object.values(state.runtimes).filter((r) => r.modelTenant).length;
  if (models > 0) {
    for (const rt of Object.values(state.runtimes)) {
      const others = models - (rt.modelTenant ? 1 : 0);
      if (others <= 0) continue;
      const s = rt.tenant.stats;
      s.mood = clamp(s.mood + Math.min(1, others * 0.5), 0, 100);
    }
  }
  const day = gameDayIndex();
  const calendarDay = calendarGameDayIndex();
  const graduates: { id: string; reason: string }[] = [];
  for (const rt of Object.values(state.runtimes)) {
    const w = rt.wish!;
    const def = WISH_DEFS[w.id] as WishDef;
    if (w.fulfilledDay === -99) {
      advanceWish(rt, def.gain(rt));
      continue;
    }
    // 🏠 安居型模範房客:安居期滿 → 圓滿搬離(複用畢業型的離開儀式,情境文案不同)。
    //    不寫進 w.graduateDay(那是畢業型專用;留 -99 讓房東主動送別鍵能判斷「尚未排定」)。
    if (rt.modelTenant && !def.graduates) {
      const departDay = settleDepartDay(rt);
      if (!w.announced && calendarDay >= departDay - 2) {
        w.announced = true; // 前 2 天打包預告(比照畢業型)+ 掛貓去留抉擇
        pushSocialLog(rt, `📦 ${settleFarewellText(rt.tenant.id)}`, "major");
        maybeAttachCatFarewell(rt);
        notify(`🏠 ${rt.tenant.name} 安居圓滿,正準備搬離公寓,展開人生下一步…`);
      }
      if (calendarDay >= departDay) graduates.push({ id: rt.tenant.id, reason: settleDepartReason(rt.tenant.id) });
      continue;
    }
    if (w.graduateDay === -99) continue;
    // 圓夢離開:前兩天先預告(打包日誌),到期日搬走
    if (!w.announced && day >= w.graduateDay - 2) {
      w.announced = true;
      pushSocialLog(rt, `📦 ${def.farewellText}`, "major");
      notify(`${def.icon} ${rt.tenant.name} 實現了心願,正準備搬離公寓…`);
    }
    if (day >= w.graduateDay) graduates.push({ id: rt.tenant.id, reason: `圓夢離開:${def.label}` });
  }
  return graduates;
}

/** 房東主動送別鍵(App.vue 模範房客頁):玩家提前請模範房客圓滿搬離,走同一套離開儀式。
 *  作法:把安居期提前到只剩 2 天 → 未來 2 個遊戲日內由 wishPass 自然走完「打包預告 → 搬離」,
 *  紅包/退押金/口碑/紀念物/貓去留全部比照自然到期。已在打包中則拒絕(避免誤觸重複觸發)。 */
export function proactiveSettleFarewell(tenantId: string): { ok: boolean; text: string } {
  const rt = state.runtimes[tenantId];
  if (!rt || !rt.modelTenant) return { ok: false, text: "只有模範房客可以這樣送別" };
  const w = rt.wish;
  if (!w || w.fulfilledDay === -99) return { ok: false, text: "他還沒圓夢安居,先別急著送別" };
  if (w.announced) return { ok: false, text: "他已經在打包準備搬離了" };
  // 安居期提前到只剩 2 天(把成為模範日往前挪),讓 wishPass 的打包預告/搬離自然接手
  rt.modelSinceDay = gameDayIndex() - SETTLE_TENURE_DAYS + 2; // 舊欄位同步
  rt.modelSinceCalendarDay = calendarGameDayIndex() - SETTLE_TENURE_DAYS + 2;
  w.announced = true;
  pushSocialLog(rt, `🎓 你主動祝福 ${rt.tenant.name} 展開新生活。${settleFarewellText(rt.tenant.id)}`, "major");
  maybeAttachCatFarewell(rt);
  notify(`🎓 你祝福 ${rt.tenant.name} 圓滿搬離,他開始打包了,兩天後啟程`);
  return { ok: true, text: `已祝福 ${rt.tenant.name} 展開新生活,兩天後圓滿搬離` };
}

/** AI 敘事 context 用的一句話心願描述(undefined = 不進 prompt):
 *  進行中給進度;剛實現的 3 天內給餘韻;要搬走的給打包中;之後不再提。 */
export function wishBrief(rt: TenantRuntime): string | undefined {
  const w = rt.wish;
  if (!w) return undefined;
  const def = WISH_DEFS[w.id] as WishDef | undefined;
  if (!def) return undefined;
  if (w.fulfilledDay === -99) {
    const p = w.progress;
    // 帶追夢階段語氣(剛起步 / 過半 / 接近實現);進度數值與判定仍由系統決定
    const stage = p < 34
      ? "還在起步,正一點一點往這個夢想靠近"
      : p < 67
        ? "已經走了一半,越來越有勁"
        : "接近實現了,為此格外投入";
    return `${def.label}(進度約 ${p}%,${stage})`;
  }
  const day = gameDayIndex();
  if (w.graduateDay !== -99 && w.announced) return `${def.label}(已實現,正在打包準備搬離)`;
  if (day - w.fulfilledDay <= 3) return `${def.label}(剛實現,還沉浸在成就感裡)`;
  return undefined;
}
