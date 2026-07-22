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
  notify,
  pushMemory,
  pushSocialLog,
  type TenantRuntime,
} from "./gameState";
import { grantGrowthTag, GROWTH_TAGS, type GrowthTagId } from "./growth";
import { relationships } from "./social";
import { unlock } from "./legacy";
import { addReputation, REP_SETTLE, REP_GRADUATE } from "./reputation";
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
const MILESTONES = [25, 50, 75] as const;
type Milestone = (typeof MILESTONES)[number];

/** 同棟在住者中最好的關係值(把樓住成家的量尺) */
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
    occupations: ["咖啡師", "甜點師", "調酒師", "健身教練"],
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
    occupations: ["漫畫家", "推理小說家", "自由接案設計師", "ASMR 實況主"],
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
    occupations: ["夜班護理師"],
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
    occupations: ["樂團鼓手", "電競系學生"],
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
  feel_at_home: {
    icon: "🏡",
    label: "把這棟樓住成自己的家",
    hint: "達成方式：安排公共空間相處，讓他與至少一位鄰居的關係達到 50；30 以上也會緩慢前進。",
    occupations: ["退休教師", "瑜伽老師"],
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
    headline: "🏠 留下成為模範房客長住",
    lines: [
      "實現當下心情大振、習得永久成長特質。",
      `之後自願多付 3% 月租,在住期間帶動全樓每天心情微升,房東口碑 +${REP_SETTLE}。`,
    ],
    growthLabel,
    growthHint: tag.hint,
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
export function ensureWishes() {
  for (const rt of Object.values(state.runtimes)) {
    if (rt.wish && !WISH_DEFS[rt.wish.id]) rt.wish = null;
    if (rt.wish) continue;
    rt.wish = {
      id: wishIdForOccupation(rt.tenant.occupation),
      progress: 0,
      fulfilledDay: -99,
      graduateDay: -99,
      announced: false,
    };
  }
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

/** 畢業型心願實現且租客有貓 → 立即掛規則式「貓的去留」抉擇(不經 AI;玩家未決 = 離開時帶走)。
 *  「留下成樓貓」把 pet.ownerId 改為 "landlord"(Pet.ownerId 是 string,哨兵值型別合法;
 *  pets.ts 各 pass 對它特判:錨點改交誼廳、不再找飼主 runtime),實際套用在 tenancy.decide。 */
function maybeAttachCatFarewell(rt: TenantRuntime) {
  const pet = state.pets[rt.tenant.id];
  if (!pet || pet.ownerId !== rt.tenant.id || rt.pendingEvent) return;
  const species = pet.kind === "dog" ? "狗" : "貓";
  const houseSpecies = pet.kind === "dog" ? "公寓犬" : "樓貓";
  const ev: EventDef = {
    id: "wish_pet_farewell",
    title: `「${pet.name}」的去留`,
    description: `${rt.tenant.name} 帶著「${pet.name}」來找你:「新住處還不確定能不能養${species}……牠在這棟樓有熟悉的角落,我可以帶牠走,也可以拜託你收留牠。」`,
    choices: [
      { id: "take", label: "讓他帶牠一起走", hint: `${species}跟著主人開始新生活`, effect: {} },
      { id: "stay", label: `留下當${houseSpecies}`, hint: "由公寓接手照顧,牠會繼續在樓裡遊蕩", effect: {} },
    ],
  };
  rt.pendingEvent = ev;
  notify(`🐈 ${rt.tenant.name} 準備搬家,想和你談談「${pet.name}」的去留`);
}

/** 劇情弧收束的心願加成(narration.applyArcUpdate 呼叫):
 *  一段篇章好好落幕 = 人生也往前走了一步(基調 down 的失落收場不加)。 */
export function boostWishFromArc(rt: TenantRuntime, tone?: string) {
  if (tone === "down") return;
  advanceWish(rt, 6);
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
  const graduates: { id: string; reason: string }[] = [];
  for (const rt of Object.values(state.runtimes)) {
    const w = rt.wish!;
    const def = WISH_DEFS[w.id] as WishDef;
    if (w.fulfilledDay === -99) {
      advanceWish(rt, def.gain(rt));
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
