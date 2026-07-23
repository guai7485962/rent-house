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
import { WISH_DEFS, type WishId, type WishDef } from "./wishes";
import { toTraditional } from "./narrativeQuality";

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
  // --- 圓夢畢業第二批:送別會/告別信/紀念物 ---
  { id: "hall_of_fame", icon: "🏛️", label: "名人堂", desc: "五位租客從這裡圓夢畢業,走向各自的人生" },
  { id: "first_letter", icon: "✉️", label: "見字如面", desc: "第一次展開畢業生留下的告別信" },
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

/** 心願軌別語氣的告別信句庫:住了幾天 × 最好鄰居。
 *  畢業型(登台/開店/論文/代表作)各一種口吻;安居型(站穩/養身/住成家/過成喜歡的樣子)
 *  另一種口吻——感謝這段像家的時光、帶著這裡的溫暖前往人生的下一步。 */
const FAREWELL_BODY: Partial<Record<WishId, (days: number, neighbor: string) => string>> = {
  stage_dream: (days, neighbor) =>
    `在這棟樓住的這 ${days} 天,是我從後台一路走向聚光燈的日子。謝謝你願意收留一個追著舞台跑的人,也謝謝${neighbor}在我排練到深夜時,總幫我留著一盞燈。下次布幕拉開,我會記得這裡是我的第一排觀眾。`,
  open_shop: (days, neighbor) =>
    `謝謝你陪我把開店的基金一塊一塊存起來,這 ${days} 天的每個清晨都算數。等店開張那天,一定要拉著${neighbor}一起來,第一杯我請。這棟樓教會我的,是怎麼把日子過得踏實。`,
  graduate_thesis: (days, neighbor) =>
    `在這裡熬過論文的這 ${days} 天,是我最狼狽也最踏實的一段路。謝謝你沒在我焦頭爛額時催促,也謝謝${neighbor}在我快撐不住時遞來的那杯咖啡。我要去新的城市報到了,但這裡永遠是我畢業的起點。`,
  finish_masterwork: (days, neighbor) =>
    `這 ${days} 天,我把心裡的東西在這個房間裡一筆一筆畫了出來。謝謝這棟樓給了我一個能安靜創作的角落,也謝謝${neighbor}——你成了我作品裡偷偷藏著的靈感。代表作完成了,我也該翻往下一頁了。`,
  career_step: (days, neighbor) =>
    `在這裡安穩住下的這 ${days} 天,我把工作和生活都站成了踏實的樣子。謝謝你把這裡守成一個能安心回來的地方,也謝謝${neighbor}陪我聊過那些高低起伏的日子。要往人生的下一步走了,我會帶著這份踏實出發。`,
  recover_rhythm: (days, neighbor) =>
    `這 ${days} 天,我在這裡把身體和作息一點一點養了回來。謝謝你讓這棟樓成了我喘口氣的地方,也謝謝${neighbor}總記得提醒我早點休息。現在的我已經好好的了,帶著這份被照顧過的暖,去迎接下一段人生。`,
  feel_at_home: (days, neighbor) =>
    `住在這裡的這 ${days} 天,我是真的把這棟樓住成了家。謝謝你,也謝謝${neighbor}——是你們讓我記得每個人的作息與口味,把日子過成了彼此的牽掛。要往下一步去了,但這裡永遠是我心裡的家。`,
  settle_life: (days, neighbor) =>
    `這 ${days} 天,我終於把日子過成了自己喜歡的樣子。謝謝這棟樓給了我一段這麼安穩的時光,也謝謝${neighbor}讓平凡的每一天都有了滋味。帶著這份安穩,我要去展開人生的下一步了。`,
};

/** 同棟在住者中與離開者關係最好的一位的名字(告別信裡的「最好鄰居」);沒有則回退。 */
function bestNeighborName(leaverId: string): string {
  let bestName = "這棟樓的每一個人";
  let bestVal = -1;
  for (const rel of listRelationships()) {
    if (rel.aId !== leaverId && rel.bId !== leaverId) continue;
    const otherId = rel.aId === leaverId ? rel.bId : rel.aId;
    const other = state.runtimes[otherId];
    if (other && otherId !== leaverId && rel.value > bestVal) { bestVal = rel.value; bestName = other.tenant.name; }
  }
  return bestName;
}

/** 畢業生的告別信(模板生成、零 AI):依畢業軌別語氣 + 住了幾天 + 最好鄰居 + 代表記憶。
 *  必過 toTraditional 防簡體;非畢業型或無句庫回 undefined(交給被迫離開句庫兜底)。 */
function buildFarewellLetter(rt: TenantRuntime, daysLived: number, repMemory: string): string | undefined {
  const w = rt.wish;
  if (!w || w.fulfilledDay === -99) return undefined;
  const def = WISH_DEFS[w.id] as WishDef | undefined;
  const body = FAREWELL_BODY[w.id];
  if (!def || !body) return undefined; // 有句庫的軌別(畢業型 + 安居型)才生成告別信
  const neighbor = bestNeighborName(rt.tenant.id);
  const memoryLine = repMemory && !repMemory.includes("沒留下太多痕跡") ? `我會一直記得——${repMemory}` : "";
  return toTraditional([body(daysLived, neighbor), memoryLine, `——${rt.tenant.name} 敬上`].filter(Boolean).join(""));
}

// ---------------------------------------------------------------------------
// 被迫/非圓滿離開的告別信(使用者硬底線:每個離開的租客都要留一段話)
// ---------------------------------------------------------------------------

/** 離開語氣類別:強制請離/AI 事件請走=forced、協議解約=agreement、分手搬走=breakup、
 *  長期不滿主動退租=unhappy、其餘未預期原因=generic 兜底。 */
export type DepartureTone = "forced" | "agreement" | "breakup" | "unhappy" | "generic";

/** 依 moveOut 傳入的 reason 字串把離開路徑歸到最貼近的語氣類(涵蓋所有 moveOut 呼叫來源)。 */
export function classifyDeparture(reason: string): DepartureTone {
  if (reason.includes("強制") || reason.includes("請他搬走") || reason.includes("請你搬走") || reason.includes("請走")) return "forced";
  if (reason.includes("協議")) return "agreement";
  if (reason.includes("分手")) return "breakup";
  if (reason.includes("不滿") || reason.includes("品質")) return "unhappy";
  return "generic"; // 未預期 reason 也有一句通用道別,保證告別信必為非空
}

/** 各語氣類別的句庫(每類 2~3 句變化);每句摻入住了幾天 d、最好鄰居 nb、性格 persona、
 *  代表記憶 mem——同原因每人不同。措辭維持遊戲分級:被迫離開是失望與委屈,不辱罵、不含不當內容。 */
const DEPARTURE_BODIES: Record<DepartureTone, Array<(d: number, nb: string, persona: string, mem: string) => string>> = {
  forced: [
    (d, nb, persona, mem) => `住了 ${d} 天,最後換來一句「請你搬走」。我不會賴著不走,只是心裡實在不甘——${persona ? `我${persona}又怎樣,` : ""}也不至於落得被這樣請出門。${mem}${nb},這棟樓還是有讓我捨不得的人,就這樣吧。`,
    (d, nb, persona, mem) => `收到要我搬走的通知那一刻,我愣了很久。這 ${d} 天我把這裡當成家,${persona ? `一個${persona}的人也總算把心放了進來,` : ""}原來在你這兒,我只是個隨時能請走的房客。委屈是有的,怨也是有的,${mem}替我跟${nb}道聲別。`,
    (d, nb, persona, mem) => `我承認我${persona ? `${persona},` : ""}不是最好相處的房客,可能真讓你為難了。可住了 ${d} 天說走就走,這口氣我一時嚥不下去。${mem}算了,${nb}待我不薄,就當我是為了他們才好好離開的。`,
  ],
  agreement: [
    (d, nb, _persona, mem) => `謝謝你願意好好跟我談,讓我體面地離開。住在這裡的 ${d} 天,說真的我過得不差,是我自己的路要往別處去了。${mem}${nb},謝謝你陪我走過這段,有緣再會。`,
    (d, nb, _persona, mem) => `雖然要搬走,但你把話說開、把補償算清,這份體面我記著。這 ${d} 天有過不少好時光,離開多少有些失落,卻不留遺憾。${mem}也代我謝謝${nb}。`,
    (d, nb, persona, mem) => `能好聚好散,已經是最好的結局了。這 ${d} 天謝謝你的照顧,${persona ? `${persona}如我,` : ""}也在這裡被好好對待過。${mem}往後各自安好,${nb}我會想念的。`,
  ],
  breakup: [
    (d, nb, _persona, mem) => `感情走到了頭,我也沒臉再住下去。這 ${d} 天有過最甜的日子,也在這裡碎了心。${mem}謝謝你這段時間的收留,${nb},替我好好活著,我先走了。`,
    (d, nb, _persona, mem) => `分手了,房子也住不下去了。走的時候整個人是空的,但還是想跟你道一聲別——這 ${d} 天,謝謝你讓我有個能躲起來哭的地方。${mem}${nb},別為我擔心。`,
    (d, nb, _persona, mem) => `帶著一段散了的感情離開,這 ${d} 天像做了一場長長的夢。謝謝你沒有多問,只是讓我安靜地把行李收好。${mem}${nb},這棟樓我不會忘。`,
  ],
  unhappy: [
    (d, nb, _persona, mem) => `這 ${d} 天,我等過、忍過,也試著說服自己再住住看,可是心裡那點失望還是壓過了不捨,我還是走吧。${mem}${nb},謝謝你,是你讓我還願意笑著離開。`,
    (d, nb, persona, mem) => `要走了。這 ${d} 天越住越覺得,這裡少了點當初讓我安心的東西。${persona ? `我這種${persona}的人,對住得順不順心本來就格外在意,` : ""}日子總得往舒坦的地方過。${mem}替我謝謝${nb}。`,
    (d, nb, _persona, mem) => `謝謝你這 ${d} 天的收留。只是有些不滿積著積著,終究讓我決定另尋住處。我不想帶著怨走,就記住好的那些吧。${mem}${nb},保重。`,
  ],
  generic: [
    (d, nb, _persona, mem) => `住在這裡的 ${d} 天,說長不長,說短不短。要離開了,還是想好好跟你道個別。${mem}${nb},謝謝這段日子,後會有期。`,
    (d, nb, persona, mem) => `緣分就到這裡了。這 ${d} 天謝謝你的照顧,${persona ? `${persona}如我,` : ""}也在這棟樓留下了一點痕跡。${mem}${nb},保重,願你我都好。`,
  ],
};

/** 各語氣的署名口吻。 */
const DEPARTURE_SIGN: Record<DepartureTone, string> = {
  forced: "留",
  agreement: "敬上",
  breakup: "字",
  unhappy: "留",
  generic: "敬上",
};

/** 決定性選句(不消耗 Math.random,避免擾動其他系統的 RNG 次序與平衡快照;以租客 id + 離開時間為種)。 */
function departureIndex(rt: TenantRuntime): number {
  const key = `farewell|${rt.tenant.id}|${state.gameMs}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** 被迫/非圓滿離開的告別信:依 reason 歸類挑語氣句庫,摻入性格/代表記憶/住了幾天/最好鄰居,
 *  必過 toTraditional 防簡體。保底保證回傳非空字串(即使 reason 未預期也走 generic)。 */
function buildDepartureLetter(rt: TenantRuntime, daysLived: number, repMemory: string, reason: string): string {
  const tone = classifyDeparture(reason);
  const neighbor = bestNeighborName(rt.tenant.id);
  const persona = (rt.tenant.coreTags?.[0]?.label ?? "").replace(/[[\]]/g, "");
  const memoryLine = repMemory && !repMemory.includes("沒留下太多痕跡") ? `我會記得——${repMemory}` : "";
  const bodies = DEPARTURE_BODIES[tone];
  const body = bodies[departureIndex(rt) % bodies.length];
  const letter = body(daysLived, neighbor, persona, memoryLine) + `——${rt.tenant.name} ${DEPARTURE_SIGN[tone]}`;
  return toTraditional(letter);
}

/** 退租時把房客存進名冊(moveOut 在刪除 runtime 前呼叫);自己養的貓一起走時在記憶裡提一筆。
 *  每位離開者都附一封模板告別信(farewell):圓夢畢業/安居用專屬句庫,被迫/非圓滿離開依
 *  reason 歸類挑語氣句庫兜底——使用者硬底線「每個離開的都要有」,farewell 必為非空字串。 */
export function recordAlumnus(rt: TenantRuntime, reason: string) {
  const moveInMs = rt.moveInMs ?? GAME_START.getTime();
  const daysLived = Math.max(0, Math.floor((state.gameMs - moveInMs) / (24 * 3600 * 1000)));
  const pet = state.pets[rt.tenant.id];
  const petNote = pet && pet.ownerId === rt.tenant.id ? `帶著愛${pet.kind === "dog" ? "狗" : "貓"}「${pet.name}」一起離開。` : "";
  const repMemory = representativeMemory(rt);
  // 圓夢畢業/安居軌先用專屬句庫(既有機制不動);非圓夢離開一律以被迫離開句庫兜底,保證非空。
  const farewell = buildFarewellLetter(rt, daysLived, repMemory) ?? buildDepartureLetter(rt, daysLived, repMemory, reason);
  const entry: AlumniEntry = {
    name: rt.tenant.name,
    occupation: rt.tenant.occupation,
    daysLived,
    reason,
    leftMs: state.gameMs,
    memory: (petNote + repMemory).slice(0, 120),
    farewell,
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
