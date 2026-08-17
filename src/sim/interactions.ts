/**
 * 互動框架(設計檢討 §10-1 + §10-5):資料驅動的雙人互動目錄 + 單一資格把關 canInteract()。
 *
 * 本階段涵蓋「同房互動」——情侶/同居的兩人同處一室時的互動(交誼廳的聊天/衝突仍由 social.encounter 處理,
 * §10-2 目錄擴充時再統一)。三道硬規則(§10-0):
 *   1. adult 互動 ⇒ 🔞 成人模式開啟(預設關)
 *   2. adult 互動 ⇒ 雙方 isAdult(canRomance 已含此檢查;undefined = 內建成年角色)
 *   3. privacy 互動 ⇒ 房內無第三人
 * 所有資格檢查收斂在 canInteract(),任何入口都不得繞過。
 * 🔞 內容一律遮蔽式:文字含蓄、畫面只有霧氣(steam)/關燈(lights)演出,無露骨圖像。
 */
import type { Tenant } from "../types";
import { getRel, canRomance, pairKey, adjustRelationship } from "./social";
import { feudActive } from "./conflicts";
import { maybeWitness } from "./drama";
import { state, clamp, roomOfTenant, pushMemory, pushSocialLog, applySocialEffect, type TenantRuntime } from "./gameState";
import { roomRect, getPlacements, placementFootprint, placementInteract, placementRotation } from "./placements";
import { getDef } from "../furniture/catalog";
import { rotateGridVector } from "../furniture/rotation";
import { spawnFx, type FxKind } from "../floor/fx";
import { startPairSession, type PairPose } from "../floor/pairSession";
import { currentBlocked } from "../floor/pathfind";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "./clock";

export type InteractionTier = "close" | "crush" | "couple" | "cohabit";

/**
 * 劇情前提閘(零 RNG)。刻意**不放進 `canInteract()`**——那個函式是「安全硬規則的唯一入口」
 * (分級/成年/私密),gate 只是劇情前提;混進去會稀釋語意,也會逼簽章從 Tenant 改成 TenantRuntime。
 */
export type InteractionGate = "one_broke" | "one_unwell" | "both_adult" | "deep_couple";

export interface InteractionDef {
  id: string;
  /** 關係門檻:close=好友以上(50+)、crush=曖昧(75+ 且互有好感)、couple=情侶、cohabit=同居中的情侶 */
  tier: InteractionTier;
  /** 發生地點:room=同房(情侶/同居)、lounge=交誼廳(兩人同時在場) */
  location: "room" | "lounge";
  /** true = 需 🔞 成人模式 + 雙方成年(遮蔽式演出) */
  adult?: boolean;
  /** true = 需房內無第三人 */
  privacy?: boolean;
  /** 觸發時段(含首尾;首>尾表示跨夜,如 [23,1]) */
  timeWindow?: [number, number];
  /** 地點需有其中一件家具才解鎖(§10-6 地點條件即玩法:買雙人床才有親熱——家具投資接回互動) */
  requiresFurniture?: string[];
  weight: number;
  cooldownHours: number;
  /** 通過所有條件後,每小時實際觸發的機率 */
  chance: number;
  /** 雙方日誌文字({o}=對方名字);隨機挑一句 */
  lines: string[];
  memoryLabel?: string;
  memoryHint?: string;
  fx: FxKind;
  /** 雙人圖式(§10-6):pair=兩人走到一起站著演(預設);hidden=遮蔽式,兩人隱藏只留 fx(🔞 一律用這個) */
  pose?: PairPose;
  /** 家具座位錨點(§10-6):兩人「坐/躺到」這件家具上(反查地點的第一件;沒有就退回站位演出) */
  seatOn?: string[];
  /** 兩人並排站在家具互動面前(如流理臺),不踩進家具格。 */
  standAt?: string[];
  /** 演出改在指定共用設施發生(如一起洗澡在「bathroom」淋浴間,而不是在自己房間) */
  venue?: string;
  /**
   * 抽籤池(見 pickInteraction):省略/"core" = 既有主池,抽法逐位元照舊;
   * "extra" = 次池,只在主池落空後用「重算的條件亂數」抽,**對主池零稀釋**。
   * 次池的 def 一律 tier "close" 以上(見 pickInteraction 的擲骰次數說明)。
   */
  pool?: "core" | "extra";
  /** 劇情前提閘(零 RNG);與 canInteract() 的安全硬規則分開,見 gateOk() */
  gate?: InteractionGate;
  /** 借錢:錢多的一方轉這個金額給錢少的一方。只動 rt.wallet,不動 state.money(房東帳) */
  lend?: number;
  /** 對 wellbeing 較低的一方額外加的數值(零 RNG) */
  needyBonus?: Partial<Tenant["stats"]>;
  effects: { rel: number; mood?: number; stress?: number; energy?: number };
}

export const INTERACTIONS: InteractionDef[] = [
  {
    id: "cuddle_tv",
    tier: "couple",
    location: "room",
    pose: "sit",
    timeWindow: [19, 22],
    requiresFurniture: ["tv_console"],
    weight: 3,
    cooldownHours: 10,
    chance: 0.4,
    fx: "hearts",
    lines: [
      "和{o}窩在房裡靠著看劇,誰也沒說話,但很安心。",
      "和{o}擠在一起追劇,搶著吐槽劇情。",
      "和{o}看到一半同時伸手拿遙控器,對看一眼後都笑了。",
      "和{o}裹著同一條毯子看片,片尾播完也沒人急著起身。",
    ],
    effects: { rel: 2, mood: 5, stress: -4 },
  },
  {
    id: "loveseat_cuddle",
    tier: "couple",
    location: "room",
    pose: "sit",
    seatOn: ["loveseat"],
    requiresFurniture: ["loveseat"],
    timeWindow: [18, 23],
    weight: 3,
    cooldownHours: 12,
    chance: 0.35,
    fx: "hearts",
    lines: [
      "和{o}擠進雙人沙發,肩靠著肩交換今天發生的小事。",
      "和{o}在雙人沙發上蓋同一條毯子,誰也捨不得先起身。",
      "和{o}明明各坐一邊,聊著聊著卻靠到了一起。",
    ],
    effects: { rel: 3, mood: 5, stress: -4 },
  },
  {
    id: "private_dinner",
    tier: "couple",
    location: "room",
    pose: "sit",
    seatOn: ["romantic_table"],
    requiresFurniture: ["romantic_table"],
    timeWindow: [18, 21],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "hearts",
    lines: [
      "和{o}把普通晚餐擺成兩人約會,連白開水都像有了儀式感。",
      "和{o}坐在雙人餐桌前慢慢吃飯,手機都默契地沒有拿出來。",
      "和{o}準備了只夠兩人的餐點,吃到最後才發現蠟燭已經燒了一半。",
    ],
    effects: { rel: 3, mood: 6, stress: -3 },
  },
  {
    id: "midnight_snack",
    tier: "couple",
    location: "room",
    pose: "sit",
    timeWindow: [22, 23],
    weight: 2,
    cooldownHours: 12,
    chance: 0.3,
    fx: "chat",
    lines: [
      "和{o}分食深夜的泡麵,湯都涼了還在聊。",
      "和{o}半夜翻冰箱湊出一頓宵夜,最後連碗都猜拳決定誰洗。",
      "和{o}坐在地板上分一袋鹹酥雞,小聲交換今天的祕密。",
    ],
    effects: { rel: 2, mood: 4 },
  },
  {
    id: "lazy_morning",
    tier: "cohabit",
    location: "room",
    pose: "lie",
    seatOn: ["double_bed", "canopy_bed"],
    timeWindow: [7, 9],
    requiresFurniture: ["double_bed", "canopy_bed"],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "hearts",
    lines: [
      "和{o}賴在床上不肯起來,鬧鐘響了三次都當沒聽到。",
      "和{o}為了誰去關鬧鐘推來推去,最後一起睡回籠覺。",
      "和{o}醒了卻誰也不說破,窩在被子裡多偷了半小時清閒。",
    ],
    effects: { rel: 1, mood: 4, energy: 3, stress: -3 },
  },
  {
    id: "pillow_talk",
    tier: "couple",
    location: "room",
    pose: "lie",
    seatOn: ["canopy_bed"],
    requiresFurniture: ["canopy_bed"],
    timeWindow: [22, 1],
    weight: 3,
    cooldownHours: 18,
    chance: 0.35,
    fx: "chat",
    lines: [
      "和{o}拉上床幔說枕邊話,從明天早餐一路聊到很久以後。",
      "和{o}並肩躺著分享今天沒對別人說的心事。",
      "和{o}躲進帷幔裡講悄悄話,笑聲隔著布簾變得軟綿綿的。",
    ],
    effects: { rel: 3, mood: 5, stress: -5 },
  },
  {
    id: "cook_dinner",
    tier: "cohabit",
    location: "room",
    venue: "lounge",
    pose: "cook_pair",
    standAt: ["counter"],
    timeWindow: [18, 19],
    weight: 2,
    cooldownHours: 16,
    chance: 0.3,
    fx: "chat",
    lines: [
      "和{o}擠在小流理台前做晚餐,差點打翻鍋子,笑成一團。",
      "和{o}一個切菜一個顧鍋,配合得像早就排練過很多次。",
      "和{o}邊做飯邊互相偷吃食材,正餐還沒好就先吃飽一半。",
    ],
    effects: { rel: 2, mood: 4 },
  },
  // ——— 🔞 成人模式(遮蔽式:文字含蓄、畫面只有霧氣/關燈)———
  {
    id: "bath_together",
    tier: "couple",
    location: "room",
    venue: "bathroom", // 演出在淋浴間發生(而非自己房間)
    adult: true,
    privacy: true,
    timeWindow: [21, 23],
    weight: 2,
    cooldownHours: 40,
    chance: 0.3,
    fx: "steam",
    pose: "hidden",
    lines: [
      "和{o}一起進了浴室,水聲響了很久很久…",
      "浴室門在{o}身後輕輕關上,水聲和笑聲隔了一會才安靜。",
      "和{o}說是要節省熱水,結果浴室水聲比平常還久了一倍…",
    ],
    memoryLabel: "[臉紅的祕密]",
    memoryHint: "和戀人共浴的悄悄話,兩人都不會說出去。",
    effects: { rel: 3, mood: 8, stress: -6 },
  },
  {
    id: "night_intimacy",
    tier: "couple",
    location: "room",
    adult: true,
    privacy: true,
    timeWindow: [23, 1],
    requiresFurniture: ["double_bed", "canopy_bed"],
    weight: 3,
    cooldownHours: 36,
    chance: 0.35,
    fx: "lights",
    pose: "hidden",
    lines: [
      "房裡的燈早早就關了,門把上掛著「請勿打擾」…",
      "和{o}回房後把「請勿打擾」掛上門把,燈光很快暗了下來…",
      "{o}進門後順手反鎖,門外只看得到一張輕晃的「請勿打擾」…",
    ],
    memoryLabel: "[甜蜜的夜晚]",
    memoryHint: "昨晚之後,看對方的眼神都是軟的。",
    effects: { rel: 4, mood: 10, stress: -8, energy: -4 },
  },
  {
    id: "loveseat_after_dark",
    tier: "couple",
    location: "room",
    adult: true,
    privacy: true,
    timeWindow: [22, 1],
    requiresFurniture: ["loveseat"],
    weight: 2,
    cooldownHours: 42,
    chance: 0.25,
    fx: "lights",
    pose: "hidden",
    lines: [
      "和{o}在雙人沙發上越靠越近,最後只留下沒有關掉的暖燈…",
      "房門悄悄鎖上後,和{o}在沙發邊說話的聲音也慢慢低了下來…",
      "和{o}本來只想再坐一下,直到夜深都沒有人去碰門把…",
    ],
    memoryLabel: "[沙發邊的祕密]",
    memoryHint: "那晚的距離近得讓人想起來還會臉紅。",
    effects: { rel: 4, mood: 9, stress: -7, energy: -3 },
  },
  {
    id: "canopy_private_night",
    tier: "couple",
    location: "room",
    adult: true,
    privacy: true,
    timeWindow: [23, 1],
    requiresFurniture: ["canopy_bed"],
    weight: 3,
    cooldownHours: 48,
    chance: 0.3,
    fx: "lights",
    pose: "hidden",
    lines: [
      "和{o}拉上帷幔,房裡只剩一線暖光和很輕的笑聲…",
      "帷幔在{o}身後合上,今晚的悄悄話只留給彼此…",
      "和{o}把「請勿打擾」掛好,床幔後的燈光很快暗了下來…",
    ],
    memoryLabel: "[帷幔後的夜晚]",
    memoryHint: "拉上帷幔後,今晚只屬於彼此。",
    effects: { rel: 5, mood: 11, stress: -9, energy: -4 },
  },
  // ——— 交誼廳:朋友(close)———
  {
    id: "deep_talk",
    tier: "close",
    location: "lounge",
    pose: "sit",
    seatOn: ["shared_sofa"],
    timeWindow: [21, 1],
    weight: 2,
    cooldownHours: 24,
    chance: 0.25,
    fx: "chat",
    lines: [
      "和{o}聊到深夜,把最近的煩惱都倒了出來。",
      "被{o}一句「你最近還好嗎」戳中,聊了很久。",
      "和{o}從工作聊到家裡,幾次沉默也不覺得尷尬。",
      "本來只想和{o}抱怨兩句,回過神時連藏很久的心事都說了。",
    ],
    effects: { rel: 3, mood: 3, stress: -6 },
  },
  {
    id: "game_night",
    tier: "close",
    location: "lounge",
    pose: "game_pair", // 並肩坐 + 手把 + 螢幕閃光(G-2:純渲染,座位/擲骰一位元未動)
    seatOn: ["shared_sofa"],
    timeWindow: [19, 23],
    requiresFurniture: ["lounge_console", "lounge_tv"],
    weight: 2,
    cooldownHours: 16,
    chance: 0.25,
    fx: "chat",
    lines: [
      "和{o}擠在沙發上開黑打電動,說好輸的人去倒垃圾。",
      "和{o}組隊打到忘記時間,一個喊指揮、一個專門製造意外。",
      "和{o}輪流挑戰同一關,最後過關時兩個人一起從沙發跳起來。",
    ],
    effects: { rel: 2, mood: 5, stress: -2 },
  },
  {
    id: "share_delivery",
    tier: "close",
    location: "lounge",
    pose: "sit",
    seatOn: ["shared_sofa"],
    timeWindow: [11, 20],
    weight: 2,
    cooldownHours: 16,
    chance: 0.2,
    fx: "chat",
    lines: [
      "{o}多點了一份外送,兩人分著吃,順便交換八卦。",
      "和{o}把兩份外送攤滿茶几,邊交換菜色邊嫌棄彼此的口味。",
      "{o}問了一句要不要一起吃,兩個人就這樣聊完了一整頓飯。",
    ],
    effects: { rel: 2, mood: 3 },
  },
  // ——— 交誼廳:曖昧(crush,75+ 且互有好感)———
  {
    id: "share_earbuds",
    tier: "crush",
    location: "lounge",
    pose: "sit",
    seatOn: ["shared_sofa"],
    timeWindow: [19, 23],
    requiresFurniture: ["shared_sofa"],
    weight: 2,
    cooldownHours: 20,
    chance: 0.25,
    fx: "hearts",
    lines: [
      "和{o}共用一副耳機看劇,肩膀碰著肩膀,誰都沒有移開。",
      "和{o}為了聽清楚又靠近一點,影片演了什麼反而沒人記得。",
      "耳機線把和{o}的距離拉得很近,兩個人說話都不自覺變小聲。",
    ],
    memoryLabel: "[心動的距離]",
    memoryHint: "那晚共用耳機的距離,近得能聽見彼此的呼吸。",
    effects: { rel: 3, mood: 4 },
  },
  {
    id: "feed_snack",
    tier: "crush",
    location: "lounge",
    pose: "sit",
    seatOn: ["shared_sofa"],
    timeWindow: [21, 23],
    weight: 2,
    cooldownHours: 20,
    chance: 0.2,
    fx: "hearts",
    lines: [
      "{o}把最後一口宵夜留給了自己,心跳漏了半拍。",
      "{o}把剛拆的點心先遞了過來,那個自然的動作反而讓人更在意。",
      "和{o}搶最後一塊點心時碰到手,兩個人同時假裝什麼都沒發生。",
    ],
    effects: { rel: 3, mood: 4 },
  },
  // ——— 朋友以上:到彼此房間串門子(§10 friend-visit)———
  {
    id: "room_hangout",
    tier: "close",
    location: "room",
    pose: "stand_face",
    timeWindow: [15, 23],
    weight: 3,
    cooldownHours: 8,
    chance: 0.5,
    fx: "chat",
    lines: [
      "和{o}窩在房裡聊天鬼混,一聊就忘了時間。",
      "和{o}在房裡窩了一下午,天南地北地聊。",
      "讓{o}進房後翻出珍藏的零食,兩人坐在地上邊吃邊聊。",
      "和{o}從房間擺設聊到以前的糗事,笑聲一路傳到走廊。",
    ],
    effects: { rel: 2, mood: 3, stress: -2 },
  },
  {
    id: "room_coop_game",
    tier: "close",
    location: "room",
    requiresFurniture: ["tv_console"],
    pose: "game_pair", // 同上:房內雙人連線也看得到手把與螢幕光
    timeWindow: [18, 23],
    weight: 2,
    cooldownHours: 12,
    chance: 0.45,
    fx: "chat",
    lines: [
      "和{o}窩在房裡一起打電動,吵吵鬧鬧殺得起勁。",
      "和{o}肩並肩研究攻略,試了好幾次終於打過卡關的地方。",
      "把手把丟給{o}救場,結果兩個人輪流失誤,笑到根本沒法專心。",
    ],
    effects: { rel: 3, mood: 4, stress: -3 },
  },
  // ——————————————————————————————————————————————————————————————————————
  // 次池(pool: "extra"):日常/友誼目錄。**對主池零稀釋**——只在主池落空後,用已經花掉的
  // chanceRoll 換算出的條件亂數抽(見 pickInteraction),所以既有 18 種的觸發率一位元未動。
  //
  // 🔴 文案硬性限制:performInteraction() 對**兩人推同一句**、只把 {o} 換成對方名字,
  //    所以一律用「和{o}…」「{o}和自己…」的對稱視角。借錢/照顧這種天生不對稱的內容,
  //    改用「兩人一起面對」的語氣繞開,絕不可寫「我借給{o}」這種單向句
  //    (content-variety-test.ts 有單向措辭黑名單掃描把關)。
  // ——————————————————————————————————————————————————————————————————————
  {
    id: "lend_money",
    tier: "close",
    location: "lounge",
    pool: "extra",
    gate: "one_broke",
    pose: "stand_face",
    timeWindow: [18, 23],
    weight: 2,
    cooldownHours: 72,
    chance: 0.35,
    fx: "cash",
    lend: 2000, // 只在兩人錢包之間搬,房東帳(state.money)一毛不動
    lines: [
      "和{o}在走廊上把這個月的發薪日算了一遍,最後決定先撐過這幾天。",
      "和{o}在交誼廳算了一晚的帳,金額喬定之後兩個人都鬆了一口氣。",
      "和{o}之間多了一筆沒有寫借據的帳,誰也沒把話說得太重。",
      "和{o}把錢的事攤開來講,尷尬歸尷尬,講完反而輕鬆了。",
    ],
    effects: { rel: 3, mood: 2, stress: -4 },
  },
  {
    id: "sick_care",
    tier: "close",
    location: "room",
    pool: "extra",
    gate: "one_unwell",
    pose: "sit",
    timeWindow: [8, 22],
    weight: 3,
    cooldownHours: 36,
    chance: 0.4,
    fx: "care",
    needyBonus: { wellbeing: 3 },
    lines: [
      "熱粥擺在桌上,{o}和自己誰也沒提要不要去看醫生。",
      "和{o}窩在房裡沒說幾句話,只是把熱水一杯一杯續上。",
      "{o}和自己一整個下午都很安靜,毯子被拉好了兩次。",
      "和{o}守著同一盞小燈,等身體慢慢好起來。",
    ],
    effects: { rel: 4, mood: 4, stress: -5 },
  },
  {
    id: "catch_up_show",
    tier: "close",
    location: "room",
    pool: "extra",
    pose: "game_pair",
    timeWindow: [19, 23],
    requiresFurniture: ["tv_console"],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "chat",
    lines: [
      "和{o}補了三集進度,吐槽的時間比劇情還長。",
      "和{o}約好一起追,結果誰先看完誰就被威脅不准暴雷。",
      "和{o}為了猜結局吵了半集,片尾一出來兩個人都猜錯。",
      "和{o}說好只看一集,回過神時已經播到下一季的預告。",
    ],
    effects: { rel: 2, mood: 4, stress: -3 },
  },
  {
    id: "bathroom_rush",
    tier: "close",
    location: "lounge",
    // ⚠️ venue 的家具**不能**用 requiresFurniture 反查(furnitureSetOf 只查 p.room === roomId,
    //    而這裡的 roomId 是 "lounge")。這一條純靠時段 + 冷卻,不設 requiresFurniture。
    venue: "bathroom",
    pool: "extra",
    pose: "stand_face",
    timeWindow: [7, 9],
    weight: 2,
    cooldownHours: 30,
    chance: 0.25,
    fx: "anger",
    // 🔴 目錄裡唯一的負向互動,rel 只扣 1,而且**完全不碰 social.ts 的張力(tension)通道**——
    //    冷戰/打架的門檻剛在 F 系列調過(50/22),餵養它會直接破壞那組平衡。
    //    這條硬規則由 interaction-pool-test.ts 的原始碼掃描把關。
    lines: [
      "和{o}在浴室門口對峙了三秒,最後猜拳決定誰先進去。",
      "和{o}同時伸手去推浴室的門,兩個人都愣了一下才鬆手。",
      "早上的浴室只有一間,和{o}互相催了幾句,誰也沒真的生氣。",
      "和{o}在門口排隊排到快遲到,出門前還是互相補了一句抱歉。",
    ],
    effects: { rel: -1, mood: -2, stress: 3 },
  },
  {
    id: "laundry_wait",
    tier: "close",
    location: "lounge",
    venue: "laundry", // 同上:洗衣機 footprint 1×1,standAt 也用不了(需長度 ≥2)
    pool: "extra",
    pose: "stand_face",
    timeWindow: [10, 20],
    weight: 2,
    cooldownHours: 24,
    chance: 0.25,
    fx: "chat",
    lines: [
      "和{o}一起盯著洗衣機轉,話題從天氣扯到晚餐。",
      "和{o}在洗衣間等脫水,無聊到開始比誰的襪子比較多。",
      "洗衣機的聲音很吵,和{o}還是有一搭沒一搭地聊完了一輪。",
      "和{o}在洗衣間排隊,等待的三十分鐘意外地不難熬。",
    ],
    effects: { rel: 2, mood: 2, stress: -2 },
  },
  {
    id: "bar_cheers",
    tier: "close",
    location: "lounge",
    pool: "extra",
    gate: "both_adult", // 小酌一律成年雙檢;文案也不寫醉態
    pose: "cheers",
    standAt: ["bar_counter"],
    requiresFurniture: ["bar_counter"],
    timeWindow: [20, 23],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "chat",
    lines: [
      "和{o}在吧台各倒了一杯,碰了下杯就沒再說話。",
      "和{o}在吧台前碰杯,聊的都是一些不重要但很舒服的事。",
      "和{o}靠著吧台各喝各的,偶爾舉杯示意一下就夠了。",
      "和{o}在吧台聊到燈都調暗了,杯子裡還剩最後一口。",
    ],
    effects: { rel: 3, mood: 5, stress: -5 },
  },
  // ——————————————————————————————————————————————————————————————————————
  // 次池(pool: "extra"):戀愛線目錄(G 批第 4 批)。同樣**對主池零稀釋**。
  //
  // 🔴 安全:這四種**全年齡、看得見、不遮蔽**,一律不得標成 `adult: true`
  //    (那會被 content-variety-test.ts 強制成 hidden 遮蔽姿勢,動畫就沒了)。
  //    安全性由 `tier` 本身保證:couple/cohabit/crush 都要 `rel.romantic`(或 canRomance),
  //    而 `rel.romantic` 只可能經 `social.canBecomeCouple()` 建立 —— 那裡已含
  //    **成年 + 取向雙檢**(canRomance)。未成年與取向不合的兩人永遠走不到這裡。
  //    `first_kiss` 另掛 `gate: "both_adult"` 當**雙保險**,擋舊存檔可能殘留的非法 romantic。
  //    這四種**一律不進 AI 白名單**(worker/index.ts 維持 12 個),由 worker-test.ts 釘死。
  //
  // 文案同樣是對稱視角(兩人共用同一句,只換 {o});單向措辭黑名單掃描一體適用。
  // ——————————————————————————————————————————————————————————————————————
  {
    id: "first_kiss",
    tier: "couple",
    location: "room",
    pool: "extra",
    gate: "both_adult", // 雙保險:tier 已保證 romantic ⇒ 已過 canRomance 的成年 + 取向雙檢
    privacy: true,
    pose: "kiss",
    timeWindow: [18, 23],
    weight: 4,
    // 8760h ≈ 一遊戲年 ⇒ 實質「每對一生一次」。
    // ⚠️ 已知行為(中控已接受):舊存檔裡在一起很久的情侶沒有「已接吻過」的紀錄,
    //    載入後會補演一次初吻,當成一次性的懷舊時刻。
    cooldownHours: 8760,
    chance: 0.5,
    fx: "hearts",
    memoryLabel: "[第一次的吻]",
    memoryHint: "那個吻之後,兩個人之間就再也回不去朋友了。",
    lines: [
      "和{o}在房裡忽然安靜下來,然後就那樣有了第一個吻。",
      "燈還亮著,和{o}的第一個吻比想像中還要輕。",
      "和{o}靠得太近,誰先湊過去的,事後兩個人都想不起來。",
      "和{o}的第一個吻結束後,誰也沒說話,只是笑了很久。",
    ],
    effects: { rel: 5, mood: 12, stress: -8 },
  },
  {
    id: "morning_kiss",
    tier: "cohabit",
    location: "room",
    pool: "extra",
    pose: "kiss",
    seatOn: ["double_bed", "canopy_bed"],
    requiresFurniture: ["double_bed", "canopy_bed"],
    timeWindow: [7, 9],
    weight: 2,
    cooldownHours: 20,
    chance: 0.3,
    fx: "hearts",
    lines: [
      "鬧鐘響了兩次,和{o}在被窩裡先換了一個吻。",
      "和{o}在床邊道早安,順手補上一個很短的吻。",
      "和{o}都還沒完全醒,親了一下就又躺回去賴五分鐘。",
      "和{o}在晨光裡對看一眼,今天就從這個吻開始。",
    ],
    effects: { rel: 2, mood: 5, stress: -3 },
  },
  {
    id: "anniversary",
    tier: "couple",
    location: "room",
    pool: "extra",
    // 「老夫老妻」用既有欄位當代理,**不新增 couple_since**(零存檔成本;真要記,
    // encounter / events / AI 三處都得寫入,漏一處就失準)。
    gate: "deep_couple",
    pose: "confess",
    timeWindow: [19, 22],
    weight: 2,
    cooldownHours: 240,
    chance: 0.35,
    fx: "confetti",
    memoryLabel: "[在一起這麼久了]",
    memoryHint: "紀念日那晚翻出的舊照片,兩個人記得的細節還不一樣。",
    lines: [
      "和{o}翻起以前的照片,才發現已經在一起這麼久了。",
      "和{o}窩在房裡數日子,數到後來乾脆改成慶祝。",
      "沒有蛋糕也沒有花,和{o}就這樣把紀念日過完了,意外地滿足。",
      "和{o}把當初住進這棟樓的事又講了一遍,兩個人都記錯了不同的細節。",
    ],
    effects: { rel: 3, mood: 8, stress: -6 },
  },
  {
    id: "stargaze_window",
    tier: "crush",
    location: "room",
    pool: "extra",
    // 中控拍板改成「房內窗邊」:頂樓沒有 roomRect,只有 groupScene 的隱藏舞台,演不出來。
    pose: "stand_face",
    timeWindow: [22, 1], // 跨夜
    weight: 2,
    cooldownHours: 30,
    chance: 0.3,
    fx: "hearts",
    memoryLabel: "[那晚的夜景]",
    memoryHint: "那晚窗邊的燈火,後來想起來都還很清楚。",
    lines: [
      "和{o}把房裡的燈關掉,趴在窗邊看外面的夜景。",
      "和{o}擠在同一扇窗前找星星,城市太亮,結果一顆也沒找到。",
      "夜深了,和{o}靠著窗框沒說幾句話,只是一起看著樓下的燈。",
      "和{o}在窗邊待到很晚,話題從星座扯到小時候的事。",
    ],
    effects: { rel: 3, mood: 5, stress: -4 },
  },
];

export interface InteractCtx {
  hour: number;
  /** 房內是否有第三人 */
  thirdPresent: boolean;
  /** 🔞 成人模式是否開啟 */
  adultMode: boolean;
  /** 這對是否同居中 */
  cohabiting: boolean;
  /** 互動地點現有的家具 defId 集合(requiresFurniture 判定用) */
  furniture: Set<string>;
}

/** 某地點(房間 id 或 "lounge")現有的家具 defId 集合 */
export function furnitureSetOf(roomId: string | null): Set<string> {
  const s = new Set<string>();
  if (!roomId) return s;
  for (const p of getPlacements()) if (p.room === roomId) s.add(p.defId);
  return s;
}

/** 家具座位反查(§10-6):在地點找 seatOn 的第一件家具,回傳「並肩兩格」(取橫向中間相鄰兩格)。
 *  寬 1 的家具坐不下兩人 → null(退回站位)。 */
export function furnitureSeats(roomId: string | null, seatOn?: string[]): { a: { c: number; r: number }; b: { c: number; r: number } } | null {
  if (!seatOn || !roomId) return null;
  for (const p of getPlacements()) {
    if (p.room !== roomId || !seatOn.includes(p.defId)) continue;
    const fp = placementFootprint(p);
    if (fp.w >= 2) {
      const mid = Math.floor(fp.w / 2);
      return { a: { c: p.c + mid - 1, r: p.r }, b: { c: p.c + mid, r: p.r } };
    }
    if (fp.h >= 2) {
      const mid = Math.floor(fp.h / 2);
      return { a: { c: p.c, r: p.r + mid - 1 }, b: { c: p.c, r: p.r + mid } };
    }
  }
  return null;
}

/**
 * 家具前的雙人站位：沿著寬/高至少 2 格的家具各取一個 interact 格。
 * 例如 lounge 的 2 格流理臺位於 r9，兩人會站在 r10 並排料理，而不是踩上檯面。
 */
export function furnitureStandingPair(roomId: string | null, standAt?: string[]): { a: { c: number; r: number }; b: { c: number; r: number } } | null {
  if (!standAt || !roomId) return null;
  const blocked = currentBlocked();
  for (const p of getPlacements()) {
    if (p.room !== roomId || !standAt.includes(p.defId)) continue;
    const def = getDef(p.defId);
    const base = placementInteract(p);
    const horizontal = def.footprint.w >= 2;
    const length = horizontal ? def.footprint.w : def.footprint.h;
    if (length < 2) continue;
    const axis = rotateGridVector(horizontal ? 1 : 0, horizontal ? 0 : 1, placementRotation(p));
    const start = Math.floor(length / 2) - 1;
    const a = { c: base.c + axis.dc * start, r: base.r + axis.dr * start };
    const b = { c: a.c + axis.dc, r: a.r + axis.dr };
    if (blocked[a.r]?.[a.c] === false && blocked[b.r]?.[b.c] === false) return { a, b };
  }
  return null;
}

/** standAt 是硬性演出條件：指定家具不在或前方兩格不可達時，本次互動不成立。 */
function hasStandingStage(def: InteractionDef, roomId: string | null): boolean {
  if (!def.standAt) return true;
  const loc = def.venue ?? (def.location === "lounge" ? "lounge" : roomId);
  return furnitureStandingPair(loc, def.standAt) !== null;
}

const inWindow = (hour: number, w?: [number, number]): boolean => {
  if (!w) return true;
  const [s, e] = w;
  return s <= e ? hour >= s && hour <= e : hour >= s || hour <= e; // 跨夜
};

/** 唯一的互動資格把關:關係門檻 → 成人(開關+雙方成年+可戀愛)→ 私密 → 時段 */
export function canInteract(def: InteractionDef, a: Tenant, b: Tenant, ctx: InteractCtx): boolean {
  if (feudActive(a.id, b.id)) return false; // 冷戰中互相當作看不見(§10-2)
  const rel = getRel(a.id, b.id);
  if (def.tier === "close" && !(rel && (rel.value >= 50 || rel.romantic))) return false;
  if (def.tier === "crush" && !(rel && (rel.romantic || (rel.value >= 75 && canRomance(a, b))))) return false;
  if (def.tier === "couple" && !rel?.romantic) return false;
  if (def.tier === "cohabit" && !(rel?.romantic && ctx.cohabiting)) return false;
  if (def.adult) {
    if (!ctx.adultMode) return false;
    if (!(a.isAdult ?? true) || !(b.isAdult ?? true)) return false;
    if (!canRomance(a, b)) return false; // 成年 + 取向雙重把關
  }
  if (def.privacy && ctx.thirdPresent) return false;
  if (!inWindow(ctx.hour, def.timeWindow)) return false;
  // 地點條件即玩法(§10-6):要有對應家具才解鎖(如親熱要雙人床)——家具投資接回互動
  if (def.requiresFurniture && !def.requiresFurniture.some((id) => ctx.furniture.has(id))) return false;
  return true;
}

/**
 * 劇情前提閘(純函式、零 RNG、不看時間)。與 `canInteract()` 分開:那裡是安全硬規則的唯一入口,
 * 這裡只回答「這段劇情此刻說得通嗎」。gate 只會讓 def **更難**觸發,不會放寬任何安全條件。
 */
export function gateOk(gate: InteractionGate | undefined, A: TenantRuntime, B: TenantRuntime): boolean {
  if (!gate) return true;
  switch (gate) {
    case "one_broke": {
      const wa = A.wallet ?? 0;
      const wb = B.wallet ?? 0;
      return Math.min(wa, wb) < 3000 && Math.max(wa, wb) >= 8000;
    }
    case "one_unwell":
      return Math.min(A.tenant.stats.wellbeing, B.tenant.stats.wellbeing) < 40;
    case "both_adult":
      return (A.tenant.isAdult ?? true) && (B.tenant.isAdult ?? true);
    case "deep_couple": {
      const rel = getRel(A.tenant.id, B.tenant.id);
      return !!rel?.romantic && (rel.value >= 95 || rel.cohabitOffered);
    }
  }
}

/** 依 `pool` 欄位把候選拆成主池/次池;filter 保序 ⇒ 無 extra 時 core 與原 eligible 逐位元相同。 */
export function splitPools(eligible: InteractionDef[]): { core: InteractionDef[]; extra: InteractionDef[] } {
  const core: InteractionDef[] = [];
  const extra: InteractionDef[] = [];
  for (const d of eligible) ((d.pool ?? "core") === "core" ? core : extra).push(d);
  return { core, extra };
}

/**
 * 兩階段抽籤:**主池零稀釋**地擴充互動目錄。
 *
 * 直接把新 def 丟進同一個 weight 抽籤會稀釋既有內容(實測 game_night 12.5% → 3.1%)。
 * 這裡改成:
 *   1. 主池(core)非空 ⇒ 與擴充前**逐位元相同**:同一顆 weight 骰、同一個分母、同一個累減順序,
 *      再擲同一顆 chanceRoll,命中語意仍是 `<=`。
 *   2. 主池落空(chanceRoll > def.chance)時**不再擲骰**,而是把已經花掉的 chanceRoll 換算成
 *      `u = (chanceRoll − c) / (1 − c)` 去抽次池。合法性:在「chanceRoll > c」的條件下
 *      chanceRoll 在 [c,1) 均勻,故 u 在 [0,1) 均勻。**零新 Math.random()**。
 *   3. 次池以「預算」累加 `(w_i/W)·c_i`,故 extra 的絕對觸發率 = `(1−P_core)·(w_i/W)·c_i`,
 *      調高任一 extra 只會吃掉次池自己的預算,**永不反噬主池**。
 *
 * 唯一的擲骰次數變動:`core 空 + extra 非空` 會多擲 1 顆(現行 0 顆)。因此所有 extra def
 * 一律 tier "close" 以上——**絕不可為此新增更低的 tier**,否則全樓每組低關係配對都會多擲一顆。
 *
 * 串門配對(visitPair)兩池都維持「必定成局」:次池改用純權重(把 c_i 視為 1)。
 */
export function pickInteraction(eligible: InteractionDef[], visitPair: boolean): InteractionDef | null {
  const { core, extra } = splitPools(eligible);
  let u: number;
  if (core.length > 0) {
    // 權重挑一個,再擲觸發機率(不是每小時都黏在一起)
    const total = core.reduce((s, d) => s + d.weight, 0);
    let roll = Math.random() * total;
    let def = core[0];
    for (const d of core) {
      roll -= d.weight;
      if (roll <= 0) {
        def = d;
        break;
      }
    }
    // 保留原本的擲骰次數以穩定其他系統的亂數序列;串門配對不受失敗結果影響。
    const chanceRoll = Math.random();
    if (visitPair || chanceRoll <= def.chance) return def;
    if (extra.length === 0) return null; // 與擴充前完全相同:主池落空就收工
    u = def.chance >= 1 ? 0 : (chanceRoll - def.chance) / (1 - def.chance);
  } else {
    if (extra.length === 0) return null; // 與擴充前完全相同:0 顆骰
    u = Math.random();
  }
  const wSum = extra.reduce((s, d) => s + d.weight, 0);
  if (wSum <= 0) return null;
  let acc = 0;
  for (const d of extra) {
    acc += (d.weight / wSum) * (visitPair ? 1 : d.chance);
    if (u < acc) return d;
  }
  return null;
}

/**
 * 借錢(零 RNG):錢多的一方轉 `min(amount, 錢多者錢包)` 給錢少的一方。
 * **只動 rt.wallet,不動 state.money**——房東帳與租客錢包是兩本帳(見 economy.ts)。回傳實際轉出金額。
 */
export function applyLend(A: TenantRuntime, B: TenantRuntime, amount: number): number {
  if (!(amount > 0)) return 0;
  const rich = (A.wallet ?? 0) >= (B.wallet ?? 0) ? A : B;
  const poor = rich === A ? B : A;
  const moved = Math.min(amount, Math.max(0, rich.wallet ?? 0));
  if (moved <= 0) return 0;
  rich.wallet = (rich.wallet ?? 0) - moved;
  poor.wallet = (poor.wallet ?? 0) + moved;
  return moved;
}

/** needyBonus(零 RNG):對兩人中 wellbeing 較低的一方額外加值,一律夾在 0~100。 */
export function applyNeedyBonus(A: TenantRuntime, B: TenantRuntime, bonus: Partial<Tenant["stats"]>) {
  const needy = A.tenant.stats.wellbeing <= B.tenant.stats.wellbeing ? A : B;
  const s = needy.tenant.stats;
  for (const k of ["mood", "stress", "wellbeing", "energy", "affinity"] as const) {
    const d = bonus[k];
    if (d) s[k] = clamp(s[k] + d, 0, 100);
  }
}

const cdKey = (aId: string, bId: string, defId: string) => `${pairKey(aId, bId)}|${defId}`;

function offCooldown(aId: string, bId: string, def: InteractionDef): boolean {
  const last = state.interactionCooldowns[cdKey(aId, bId, def.id)];
  return last == null || state.gameMs - last >= def.cooldownHours * MS_PER_GAME_HOUR;
}

/** 串門前先確認至少有一項「好友房內活動」此刻能演，避免進屋後各做各的。 */
export function canStartRoomVisit(visitor: TenantRuntime, host: TenantRuntime, roomId: string, hour: number): boolean {
  const ctx: InteractCtx = {
    hour,
    thirdPresent: false,
    adultMode: state.adultMode,
    cohabiting: false,
    furniture: furnitureSetOf(roomId),
  };
  return INTERACTIONS.some(
    (def) => def.location === "room" && def.tier === "close"
      && canInteract(def, visitor.tenant, host.tenant, ctx)
      && gateOk(def.gate, visitor, host)
      && offCooldown(visitor.tenant.id, host.tenant.id, def),
  );
}

function applyPairEffect(rt: TenantRuntime, eff: InteractionDef["effects"]) {
  applySocialEffect(rt, { mood: eff.mood, stress: eff.stress });
  if (eff.energy) rt.tenant.stats.energy = clamp(rt.tenant.stats.energy + eff.energy, 0, 100);
}

/** 對一組同地點的租客跑兩兩互動;把觸發的 pairKey 收進 triggered(給 socialPass 去重) */
function runGroup(present: TenantRuntime[], location: "room" | "lounge", roomId: string | null, hour: number, triggered: Set<string>) {
  if (present.length < 2) return;
  const furniture = furnitureSetOf(location === "lounge" ? "lounge" : roomId);
  const pairs: { A: TenantRuntime; B: TenantRuntime; visitPair: boolean }[] = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const A = present[i];
      const B = present[j];
      pairs.push({ A, B, visitPair: A.visitHostId === B.tenant.id || B.visitHostId === A.tenant.id });
    }
  }
  // 串門配對先演，避免主人先被同房第三人占用 session；每人每小時只演一場。
  pairs.sort((a, b) => Number(b.visitPair) - Number(a.visitPair));
  const busy = new Set<string>();
  for (const { A, B, visitPair } of pairs) {
      if (busy.has(A.tenant.id) || busy.has(B.tenant.id)) continue;
      const ctx: InteractCtx = {
        hour,
        thirdPresent: present.length > 2,
        adultMode: state.adultMode,
        cohabiting: roomId != null && (state.cohabits[A.tenant.id] === roomId || state.cohabits[B.tenant.id] === roomId),
        furniture,
      };
      const eligible = INTERACTIONS.filter(
        (def) => def.location === location
          && (!visitPair || def.tier === "close")
          && canInteract(def, A.tenant, B.tenant, ctx)
          && gateOk(def.gate, A, B)
          && hasStandingStage(def, roomId)
          && offCooldown(A.tenant.id, B.tenant.id, def),
      );
      // 主池/次池兩階段抽籤(見 pickInteraction):主池的擲骰次數與順序與擴充前逐位元相同
      const def = pickInteraction(eligible, visitPair);
      if (!def) continue;

      performInteraction(A, B, def, roomId);
      triggered.add(pairKey(A.tenant.id, B.tenant.id));
      busy.add(A.tenant.id);
      busy.add(B.tenant.id);
  }
}

/** 實際執行一次互動:雙方日誌 + 數值 + 關係 + 記憶 + 現場演出 + 冷卻 + 撞見判定 */
function performInteraction(A: TenantRuntime, B: TenantRuntime, def: InteractionDef, roomId: string | null) {
  const line = def.lines[Math.floor(Math.random() * def.lines.length)];
  // 成人向日誌一律由執行層加圖式標記,新增文案時不必靠人工記得逐句補。
  const marker = def.adult ? "🔞 " : "";
  pushSocialLog(A, marker + line.replace(/\{o\}/g, B.tenant.name), "notable");
  pushSocialLog(B, marker + line.replace(/\{o\}/g, A.tenant.name), "notable");
  applyPairEffect(A, def.effects);
  applyPairEffect(B, def.effects);
  // 零 RNG 的附加效果:借錢只在兩人錢包之間搬(房東帳不動)、needyBonus 補給狀況較差的一方
  if (def.lend) applyLend(A, B, def.lend);
  if (def.needyBonus) applyNeedyBonus(A, B, def.needyBonus);
  if (def.effects.rel) adjustRelationship(A.tenant.id, B.tenant.id, def.effects.rel);
  if (def.memoryLabel) {
    pushMemory(A.tenant, def.memoryLabel, def.memoryHint ?? "", "ai_event");
    pushMemory(B.tenant, def.memoryLabel, def.memoryHint ?? "", "ai_event");
  }
  // 演出錨點:def.venue(指定共用設施,如一起洗澡在淋浴間)> 家具座位 > 兩人所在格 > 房間中心
  const venueRect = def.venue ? roomRect(def.venue) : null;
  const loc = def.venue ?? (def.location === "lounge" ? "lounge" : roomId);
  const seats = furnitureSeats(loc, def.seatOn);
  const standingPair = furnitureStandingPair(loc, def.standAt);
  const pairTiles = seats ?? standingPair;
  const rect = venueRect ?? (roomId ? roomRect(roomId) : null);
  const venueAnchor = venueRect ? { c: Math.floor((venueRect.c0 + venueRect.c1) / 2), r: Math.floor((venueRect.r0 + venueRect.r1) / 2) } : null;
  const anchor = pairTiles?.a ?? venueAnchor ?? A.targetTile ?? B.targetTile ?? (rect ? { c: Math.floor((rect.c0 + rect.c1) / 2), r: Math.floor((rect.r0 + rect.r1) / 2) } : null);
  if (anchor) {
    // 進行中的互動演出(泡泡/霧氣…)+ 姿勢:持續到下一個動作(1 遊戲小時);快轉時 gameUntil 收掉
    spawnFx(def.fx, anchor.c, anchor.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
    // §10-6:登記雙人 session——有座位就坐/躺上去,否則走到錨點旁站一起;🔞 遮蔽式則整段隱藏
    startPairSession(A.tenant.id, B.tenant.id, anchor, def.pose ?? "pair", state.gameMs, REAL_MS_PER_GAME_HOUR, pairTiles ?? undefined);
  }
  state.interactionCooldowns[cdKey(A.tenant.id, B.tenant.id, def.id)] = state.gameMs;
  // 被撞見(§10-2 戲劇批):私密互動有低機率被第三位租客撞見,三方尷尬
  if (def.privacy) maybeWitness(A, B);
}

/**
 * AI 提議互動(§10-3):玩家在 AI 事件裡拍板後觸發。
 * 白名單 + 門檻把關:未知 id / 外出 / 冷戰一律擋;🔞 互動走完整 canInteract(三條硬規則
 * + 情侶門檻 + 時段,AI 不可越權);一般互動放寬關係階層/時段/冷卻(劇情已由 AI 鋪陳、玩家已同意)。
 */
export function forceInteraction(aId: string, bId: string, defId: string): boolean {
  const def = INTERACTIONS.find((d) => d.id === defId);
  const A = state.runtimes[aId];
  const B = state.runtimes[bId];
  if (!def || !A || !B) return false;
  if (A.tenant.visualState === "away" || B.tenant.visualState === "away") return false;
  if (feudActive(aId, bId)) return false;

  const roomId = roomOfTenant(aId) ?? roomOfTenant(bId);
  if (!hasStandingStage(def, roomId)) return false;
  if (!gateOk(def.gate, A, B)) return false; // 劇情前提 AI 也不可越權(如 both_adult)
  const thirdPresent = Object.values(state.runtimes).some(
    (rt) => rt !== A && rt !== B && rt.tenant.visualState !== "away" && !rt.inLounge && roomOfTenant(rt.tenant.id) === roomId,
  );
  const furniture = furnitureSetOf(def.location === "lounge" ? "lounge" : roomId);
  if (def.adult) {
    const ctx: InteractCtx = {
      hour: new Date(state.gameMs).getHours(),
      thirdPresent,
      adultMode: state.adultMode,
      cohabiting: roomId != null && (state.cohabits[aId] === roomId || state.cohabits[bId] === roomId),
      furniture,
    };
    if (!canInteract(def, A.tenant, B.tenant, ctx)) return false;
  } else if (def.privacy && thirdPresent) {
    return false;
  } else if (def.requiresFurniture && !def.requiresFurniture.some((id) => furniture.has(id))) {
    return false; // AI 提議也一樣:場地沒有對應家具就演不了(如沒電視怎麼窩著看劇)
  }
  performInteraction(A, B, def, roomId);
  return true;
}

/** 每小時互動 pass(由 tick 呼叫):同房(情侶/同居)+ 交誼廳(朋友/曖昧)。
 *  回傳本小時觸發過互動的 pairKey,socialPass 據此跳過同一對(避免同小時雙重互動)。 */
export function interactionsPass(): Set<string> {
  const triggered = new Set<string>();
  const hour = new Date(state.gameMs).getHours();

  // 同房組(在這間房、沒外出、沒待決事件)
  const byRoom = new Map<string, TenantRuntime[]>();
  const loungeGroup: TenantRuntime[] = [];
  for (const rt of Object.values(state.runtimes)) {
    if (rt.tenant.visualState === "away" || rt.pendingEvent) continue;
    if (rt.inLounge) {
      loungeGroup.push(rt);
      continue;
    }
    // 串門子:拜訪中的租客併入「朋友房」那一組(朋友以上可到彼此房間互動)
    const roomId = rt.visiting ?? roomOfTenant(rt.tenant.id);
    if (!roomId) continue;
    if (!byRoom.has(roomId)) byRoom.set(roomId, []);
    byRoom.get(roomId)!.push(rt);
  }

  for (const [roomId, present] of byRoom) runGroup(present, "room", roomId, hour, triggered);
  runGroup(loungeGroup, "lounge", null, hour, triggered);
  return triggered;
}
