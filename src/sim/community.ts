/**
 * 社群事件(群體事件的省成本版,§C-7 low-cost):
 * 不動 AI schema、不需抉擇 UI——用一組「寫死的多人事件模板」讓一件事同時牽動 3+ 位租客,
 * 結果落在每個人的日誌與全樓動態 Feed,製造「整層樓在發生事情」的觀察感。
 *
 * 也順便讓「洗衣晾衣間」活起來:原本社交只在交誼廳觸發(inLounge),洗衣房是死空間;
 * 這裡新增洗衣房場景的相遇/口角,實現洗衣機本來就寫著卻從未發生的「搶最後一台空機」。
 *
 * 每遊戲日 communityPass 最多觸發一件(有機率、各事件有冷卻),節奏刻意稀疏不洗版。
 */
import type { GroupChoice, GroupEvent, GroupDelta } from "../types";
import { state, addFlag, clamp, notify, pushSocialLog, type TenantRuntime } from "./gameState";
import { adjustGroupBond, adjustRelationship as adjustRelationshipBase, adjustTension, getRel } from "./social";
import { clearNoiseMemories } from "./memoryEffects";
import { addMoney } from "./economy";
import { getPlacements, placementInteract, roomRect } from "./placements";
import { spawnFx } from "../floor/fx";
import { save } from "./persistence";
import { currentBlocked, type Tile } from "../floor/pathfind";
import { startPairSession } from "../floor/pairSession";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "./clock";
import { grantEventSoundproofing, noiseComplaintEligible } from "./acoustics";
import { todayWeather } from "./weather";
import { isWeekend } from "./week";
import { unlock } from "./legacy";
import { startGroupScene, type GroupSceneLayout, type GroupSceneVenue } from "../floor/groupScene";

type Rng = () => number;

/** 雙人社群事件同步維護好感與積怨；正向合作會降溫，口角會留下心結。 */
function adjustRelationship(aId: string, bId: string, delta: number) {
  adjustRelationshipBase(aId, bId, delta);
  adjustTension(aId, bId, delta < 0 ? Math.abs(delta) * 3 : -Math.max(1, delta));
}

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 依遊戲日、參與者與事件 id 選文案；不用 Math.random，避免純文字擴充改變平衡 RNG。 */
function sceneIndex(parts: TenantRuntime[], salt: string, size: number): number {
  const day = Math.floor(state.gameMs / (24 * 3600 * 1000));
  const key = `${salt}|${day}|${parts.map((p) => p.tenant.id).join("|")}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % size;
}

const COMMUNITY_LINES = {
  fridgeMissingA: [
    "🍮 放在冰箱裡的布丁不見了,第一個想到的是剛站在冰箱前的 {o}。",
    "🥡 昨晚特地留下的外送被吃掉一半,冰箱盒上只剩一張沒有署名的紙條。",
    "🧃 貼了名字的飲料突然見底,忍不住問 {o} 是不是拿錯了。",
    "🍰 冰箱裡留著明天吃的蛋糕消失了,和 {o} 對著空盒越講越尷尬。",
  ],
  fridgeMissingB: [
    "🍮 被 {o} 問是不是偷吃了冰箱裡的東西,覺得自己被冤枉。",
    "🥡 面對 {o} 的質問一時說不清楚,兩人站在冰箱前僵了好一會。",
    "🧃 被 {o} 指著空瓶追問,明明只是剛好經過冰箱卻越解釋越可疑。",
    "🍰 和 {o} 一起看到空盒,卻因為一句『不是你嗎』讓氣氛瞬間冷掉。",
  ],
  fridgeTruthA: [
    "🔎 終於在冰箱最裡層找到失蹤的食物,趕緊向 {o} 道歉,還分了一半賠罪。",
    "🧾 才發現是自己記錯了保存盒,{o} 沒有偷吃;兩人把誤會說開後反而笑了。",
    "🍮 {o} 坦白是不小心拿錯,當天就買了兩份新的放回冰箱,這場風波總算落幕。",
    "📝 從冰箱旁掉出的紙條證明只是拿錯格,{o} 主動補買,兩人決定以後都寫清楚名字。",
  ],
  fridgeTruthB: [
    "🔎 被 {o} 正式道歉,那口被冤枉的氣總算消了一大半。",
    "🧾 和 {o} 把冰箱翻了一遍才解開誤會,最後一起把快過期的食物分著吃。",
    "🍮 向 {o} 承認自己拿錯了,補買兩份後還被虧了整晚。",
    "📝 和 {o} 一起重新整理冰箱格位,決定各自貼上名字,免得下次再吵一次。",
  ],
  fridgeShare: [
    "🍱 發現 {o} 忙到沒吃飯,把冰箱裡留著的那份餐點熱給了對方。",
    "🍉 和 {o} 一起清冰箱,把快過期的食材拼成一頓意外好吃的宵夜。",
    "🧁 買甜點時順手替 {o} 多帶一份,打開冰箱看到紙條時兩個人都笑了。",
    "🥣 和 {o} 約好冰箱最上層是共享區,誰晚回家都至少有一份飯可吃。",
  ],
  cookFriendly: [
    "🍳 和 {o} 一個切菜、一個顧鍋,第一次合作竟然很有默契。",
    "🥘 和 {o} 把冰箱剩料全搬上流理臺,邊試味道邊完成了一桌晚餐。",
    "🥟 和 {o} 在流理臺前包了一排歪歪扭扭的餃子,成品不好看卻很好吃。",
    "🍛 和 {o} 說好輪流掌廚,今天負責的人做飯、另一個人自動收拾。",
  ],
  cookConflictA: [
    "🔥 和 {o} 同時搶著用流理臺,一個嫌動作慢、一個嫌對方礙手礙腳。",
    "🧂 覺得 {o} 偷改了鍋裡的調味,兩個人為了該不該加鹽爭了起來。",
    "🍽️ 做完飯後發現 {o} 把髒鍋全留著,忍不住在廚房直接質問。",
    "🥬 和 {o} 為了誰用了最後一份食材起口角,晚餐還沒好氣氛就先焦了。",
  ],
  cookConflictB: [
    "🔥 被 {o} 嫌在廚房擋路,索性放下鍋鏟不做了。",
    "🧂 和 {o} 對著同一鍋菜各有堅持,最後誰也不肯先試吃。",
    "🍽️ 被 {o} 追著問為什麼不洗鍋,兩人在流理臺前越講越大聲。",
    "🥬 覺得 {o} 把公共食材算得太清楚,這頓飯吃得一點都不痛快。",
  ],
  coffeeKindness: [
    "☕ 看見 {o} 一臉沒睡醒,順手多沖了一杯咖啡放在桌上。",
    "☕ 和 {o} 在咖啡機前碰見,一邊等機器一邊交換今天的行程。",
    "☕ 記得 {o} 不加糖的習慣,什麼都沒問就把第二杯遞了過去。",
    "☕ 和 {o} 在安靜的早晨分著一壺咖啡,昨天的小尷尬也淡了一點。",
  ],
  laundryConflictA: [
    "🧺 在洗衣房為了搶最後一台空機和 {o} 起了口角。",
    "🧺 抱著一籃衣服趕到洗衣房時,發現 {o} 正要搶最後一台空機,兩人誰也不讓。",
    "🧺 在洗衣房為了誰先使用最後一台空機和 {o} 爭了半天,洗衣服洗出一肚子氣。",
  ],
  laundryConflictB: [
    "🧺 洗到一半發現機子被 {o} 佔走,兩人在洗衣房僵了一下。",
    "🧺 覺得空洗衣機被 {o} 搶走,兩個人對著倒數時間越講越不高興。",
    "🧺 和 {o} 各自抱著衣服堵在機器前,最後用猜拳也沒能好好收場。",
  ],
  laundryFriendlyA: [
    "🧺 在洗衣房邊等烘乾邊和 {o} 聊了起來,意外地投機。",
    "🧺 和 {o} 一起研究洗衣標籤,邊聊邊發現彼此都曾洗壞過衣服。",
    "🧺 等洗衣機時和 {o} 分享最近的生活,機器停了還多聊了一會。",
  ],
  laundryFriendlyB: [
    "🧺 洗衣服時碰上 {o},一來一往聊得挺開心。",
    "🧺 和 {o} 閒聊誰又把衛生紙洗成滿桶雪花,笑到差點忘了收衣服。",
    "🧺 被 {o} 幫忙撿起掉落的襪子,兩人順勢聊起各自的洗衣災難。",
  ],
  bathroomConflictA: [
    "🚿 早上趕時間,為了搶浴室在門外猛催 {o},兩人臉都臭了。",
    "🚿 為了搶浴室和 {o} 堵在門口互不相讓,差點連上班都一起遲到。",
    "🚿 眼看時間來不及,和 {o} 為了搶浴室順序吵得整條走廊都聽見。",
    "🚽 急著用廁所卻被 {o} 佔了太久,忍不住在門外催了好幾次。",
    "🪥 和 {o} 同時擠到洗手台前刷牙,為了誰先用鏡子互不相讓。",
    "🚿 熱水被 {o} 用到見底,站在浴室門口越想越氣。",
  ],
  bathroomConflictB: [
    "🚿 洗到一半被 {o} 在門外一直敲門催,心情有點差。",
    "🚿 被 {o} 敲門催了好幾次,一開門兩個人立刻互瞪。",
    "🚿 才剛打開熱水就聽見 {o} 敲門催,這場澡洗得全是火氣。",
    "🚽 在廁所裡一直被 {o} 敲門催,出來時兩個人都沒好臉色。",
    "🪥 才剛擠好牙膏就被 {o} 嫌擋住洗手台,早晨火氣一起上來了。",
    "🚿 被 {o} 質問為什麼把熱水用完,兩人在門口吵得誰也不讓。",
  ],
  bathroomFriendlyA: [
    "🚿 在浴室門口排隊等 {o},順口聊了幾句,意外地自在。",
    "🚿 和 {o} 排隊等浴室時交換了今天的行程,順便互相提醒別遲到。",
    "🚿 排隊時借了 {o} 一條乾毛巾,兩人站在門邊聊得很自然。",
    "🚽 等廁所時和 {o} 交換今天的行程,輪到自己前已經聊完一輪。",
    "🪥 和 {o} 並排整理儀容,還順手提醒對方衣領沒翻好。",
    "🚿 {o} 洗完後特地提醒熱水還很足,一句小事讓早晨順心不少。",
  ],
  bathroomFriendlyB: [
    "🚿 排隊等浴室時和 {o} 閒聊,關係近了一點。",
    "🚿 和 {o} 在浴室門口閒聊昨晚的事,輪到自己時還有點意猶未盡。",
    "🚿 等浴室時被 {o} 問了句早餐吃什麼,最後連晚餐都聊到了。",
    "🚽 在門口排隊時被 {o} 逗笑,原本的焦躁也消了一點。",
    "🪥 和 {o} 分享了快用完的牙膏,站在鏡子前聊起今天的安排。",
    "🚿 被 {o} 留了一條乾毛巾和足夠熱水,心裡默默記下了這份體貼。",
  ],
  morningRush: [
    "🚽 早上尖峰,{names} 一起卡在浴室/廁所門口排隊乾瞪眼,邊等邊吐槽。",
    "🚽 {names} 同時趕著出門,浴室門口像臨時開了一場焦急的住戶會議。",
    "🚽 {names} 一早全堵在浴室外,互相報時、借東西,忙亂中反而有了默契。",
  ],
  groupOrder: [
    "🧋 和 {names} 揪團訂了手搖飲,樓裡難得這麼熱鬧。",
    "🍕 和 {names} 揪團湊外送免運,最後點得比原本預計多了一倍。",
    "🍗 和 {names} 揪團買宵夜,餐點送到後公共桌面瞬間擺滿。",
    "🧁 和 {names} 揪團試附近新開的甜點店,大家邊吃邊認真評分。",
  ],
  noiseComplain: [
    "😤 幾個鄰居一起去找 {o} 反映噪音問題。",
    "😤 忍了好幾晚後,幾個鄰居結伴去向 {o} 抱怨噪音。",
    "😤 幾個鄰居拿著各自記下的時間,一起找 {o} 抱怨深夜聲響。",
  ],
  noiseTarget: [
    "😰 被 {names} 一起上門抱怨噪音,壓力山大。",
    "😰 一開門就看到 {names} 排成一列抱怨噪音,當場不知道該先向誰解釋。",
    "😰 被 {names} 拿著噪音紀錄一起抱怨,只好尷尬地連聲道歉。",
  ],
  rainyLounge: [
    "🌧️ 外頭雨下個不停,和 {names} 窩在交誼廳沙發上有一搭沒一搭地聊,反而聊出了交情。",
    "☔ 被雨困在樓裡的下午,{names} 不知不覺都聚到了交誼廳,分著同一包餅乾看雨。",
    "🌧️ 雨聲太大誰也不想出門,和 {names} 在交誼廳泡了壺熱茶,把最近的事都聊了一輪。",
    "☔ 停電似的安靜雨天,{names} 擠在交誼廳看老電影,片尾曲響起時雨剛好停了。",
  ],
  rooftop: [
    "🌇 傍晚和 {names} 相約頂樓乘涼吹風,一整天的疲憊都散了。",
    "🌆 和 {names} 帶著飲料上頂樓看晚霞,難得誰也沒有急著滑手機。",
    "🌙 和 {names} 在頂樓吹晚風聊近況,城市的聲音反而成了舒服的背景。",
    "✨ 和 {names} 在頂樓認星星,最後沒認出幾顆,倒是聊了很多心事。",
  ],
  weekendMovie: [
    "🎬 週末夜和 {names} 窩在交誼廳看電影,燈一關整層樓就成了小影廳。",
    "🍿 和 {names} 為了週末電影夜各自帶了零食來,選片吵了十分鐘,看片倒是安靜得很。",
    "🎬 週末晚上和 {names} 在交誼廳連看兩部片,片尾曲放完誰也捨不得先回房。",
  ],
  cafeAfterHours: [
    "☕ 打烊後的一樓只剩自己人,和 {names} 佔著吧台前那幾張椅子把今天的事說完。",
    "🌙 店門一拉下來,{names} 就把椅子搬到吧台前,說是喝一杯,結果聊到快十一點。",
    "🍮 和 {names} 分掉今天沒賣完的那份甜點,坐在自家店裡吃反而有種偷來的快樂。",
    "🧹 幫忙把桌子擦完之後,和 {names} 索性就地坐下,聽樓下的冰箱嗡嗡響。",
  ],
  cafeWeekendNight: [
    "🎉 週末打烊後,{names} 把一樓包了場,燈開一半、音樂放小聲,像在自己家開派對。",
    "🕯️ 週末夜的咖啡廳沒有客人,和 {names} 圍在座位區中間,誰也不急著上樓。",
    "🥂 和 {names} 在打烊的店裡碰杯,說這間店有一半是他們幫忙撐起來的。",
  ],
};

const LAUNDRY_UNAVAILABLE = new Set([
  "away", "sleeping_on_bed", "sleeping_on_couch", "showering", "using_toilet",
  "washing_at_sink", "taking_bath", "waiting_for_bathroom", "crying", "pacing",
]);
const BATHROOM_UNAVAILABLE = new Set(["away", "sleeping_on_bed", "sleeping_on_couch", "crying", "pacing"]);
const KITCHEN_UNAVAILABLE = new Set([
  "away", "sleeping_on_bed", "sleeping_on_couch", "showering", "using_toilet",
  "taking_bath", "waiting_for_bathroom", "crying", "pacing",
]);
const FRIDGE_MISSING_PREFIX = "冰箱食物失蹤:";
const FRIDGE_SUSPECT_PREFIX = "被懷疑偷吃:";

const fillCommunity = (line: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), value), line);

/** 在某設施中心掛一個特效(讓事發地點看得到) */
function fxAt(roomId: string, kind: Parameters<typeof spawnFx>[0]) {
  const rect = roomRect(roomId);
  if (rect) spawnFx(kind, Math.floor((rect.c0 + rect.c1) / 2), Math.floor((rect.r0 + rect.r1) / 2), 10000);
}

/** 洗衣事件的兩個實際站位：優先使用兩台洗衣機的互動格，缺機台時才掃設施內空格。 */
export function laundryStageTiles(): { a: Tile; b: Tile } | null {
  const blocked = currentBlocked();
  const usable = (tile: Tile) => blocked[tile.r]?.[tile.c] === false;
  const washerTiles = getPlacements()
    .filter((p) => p.room === "laundry" && p.defId === "laundry_washer")
    .map(placementInteract)
    .filter(usable)
    .filter((tile, i, all) => all.findIndex((t) => t.c === tile.c && t.r === tile.r) === i);
  if (washerTiles.length >= 2) return { a: washerTiles[0], b: washerTiles[1] };

  const rect = roomRect("laundry");
  if (!rect) return null;
  const open: Tile[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) if (usable({ c, r })) open.push({ c, r });
  }
  for (const a of open) {
    const b = open.find((t) => Math.abs(t.c - a.c) + Math.abs(t.r - a.r) === 1);
    if (b) return { a, b };
  }
  return null;
}

/** 把文字上的洗衣事件接到樓層演出：兩人中止原活動，走到洗衣機前互動一小時。 */
function stageLaundry(parts: TenantRuntime[], kind: "chat" | "anger") {
  const [a, b] = parts;
  for (const rt of [a, b]) {
    rt.tenant.visualState = "using_appliance";
    rt.activityPose = null;
    rt.activityTile = null;
    rt.activitySurface = null;
    rt.inLounge = false;
    rt.visiting = null;
    rt.visitHostId = null;
  }
  const tiles = laundryStageTiles();
  if (!tiles) {
    fxAt("laundry", kind);
    return;
  }
  const anchor = tiles.a;
  spawnFx(kind, anchor.c, anchor.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
  startPairSession(a.tenant.id, b.tenant.id, anchor, "stand_face", state.gameMs, REAL_MS_PER_GAME_HOUR, tiles);
}

/** 浴室事件站位：一人在浴室門口、一人在走廊，避免只有中央特效卻看不到當事人。 */
export function bathroomStageTiles(): { a: Tile; b: Tile } | null {
  const blocked = currentBlocked();
  const candidates = [
    { a: { c: 6, r: 25 }, b: { c: 7, r: 25 } },
    { a: { c: 6, r: 29 }, b: { c: 7, r: 29 } },
  ];
  return candidates.find(({ a, b }) => blocked[a.r]?.[a.c] === false && blocked[b.r]?.[b.c] === false) ?? null;
}

function stageBathroom(parts: TenantRuntime[], kind: "chat" | "anger") {
  const [a, b] = parts;
  for (const rt of [a, b]) {
    rt.tenant.visualState = "waiting_for_bathroom";
    rt.activityPose = null;
    rt.activityTile = null;
    rt.activitySurface = null;
    rt.inLounge = false;
    rt.visiting = null;
    rt.visitHostId = null;
  }
  const tiles = bathroomStageTiles();
  if (!tiles) {
    fxAt("bathroom", kind);
    return;
  }
  spawnFx(kind, tiles.a.c, tiles.a.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
  startPairSession(a.tenant.id, b.tenant.id, tiles.a, "stand_face", state.gameMs, REAL_MS_PER_GAME_HOUR, tiles);
}

function loungeFurniture(defId: string) {
  return getPlacements().find((p) => p.room === "lounge" && p.defId === defId) ?? null;
}

function hasLoungeFurniture(...defIds: string[]): boolean {
  return defIds.every((id) => loungeFurniture(id) != null);
}

/** 以指定家具的互動格為第一站位，再找相鄰空格給第二人。 */
export function kitchenStageTiles(defId: string): { a: Tile; b: Tile } | null {
  const placement = loungeFurniture(defId);
  if (!placement) return null;
  const blocked = currentBlocked();
  const a = placementInteract(placement);
  if (blocked[a.r]?.[a.c] !== false) return null;
  const neighbors = [
    { c: a.c + 1, r: a.r }, { c: a.c - 1, r: a.r },
    { c: a.c, r: a.r + 1 }, { c: a.c, r: a.r - 1 },
  ];
  const b = neighbors.find((tile) => blocked[tile.r]?.[tile.c] === false);
  return b ? { a, b } : null;
}

/** 把廚房文字事件接到實際家具前，讓兩人中止原活動並走去演出。 */
function stageKitchen(
  parts: TenantRuntime[],
  defId: string,
  pose: "stand_face" | "cook_pair",
  visualState: "cooking" | "eating" | "using_appliance",
  fx: "chat" | "anger" | "hearts",
) {
  const [a, b] = parts;
  for (const rt of [a, b]) {
    rt.tenant.visualState = visualState;
    rt.activityPose = null;
    rt.activityTile = null;
    rt.activitySurface = null;
    rt.inLounge = true;
    rt.visiting = null;
    rt.visitHostId = null;
  }
  const tiles = kitchenStageTiles(defId);
  if (!tiles) return;
  spawnFx(fx, tiles.a.c, tiles.a.r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
  startPairSession(a.tenant.id, b.tenant.id, tiles.a, pose, state.gameMs, REAL_MS_PER_GAME_HOUR, tiles);
}

function removeFlag(rt: TenantRuntime, flag: string) {
  const index = rt.flags.indexOf(flag);
  if (index >= 0) rt.flags.splice(index, 1);
}

/** 找出尚未收尾的「冰箱食物失蹤」配對；回傳順序固定為失主、被懷疑者。 */
function pendingFridgePair(present: TenantRuntime[]): [TenantRuntime, TenantRuntime] | null {
  for (const victim of present) {
    const flag = victim.flags.find((f) => f.startsWith(FRIDGE_MISSING_PREFIX));
    if (!flag) continue;
    const suspectId = flag.slice(FRIDGE_MISSING_PREFIX.length);
    const suspect = present.find((rt) => rt.tenant.id === suspectId);
    if (suspect?.flags.includes(`${FRIDGE_SUSPECT_PREFIX}${victim.tenant.id}`)) return [victim, suspect];
  }
  return null;
}

/** 對一組人兩兩調整關係 */
function bondAll(parts: TenantRuntime[], delta: number) {
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) adjustGroupBond(parts[i].tenant, parts[j].tenant, delta);
}

function bumpMood(rt: TenantRuntime, mood: number, stress: number) {
  const s = rt.tenant.stats;
  if (mood) s.mood = clamp(s.mood + mood, 0, 100);
  if (stress) s.stress = clamp(s.stress + stress, 0, 100);
}

interface CommunityEvent {
  id: string;
  /** 最少參與人數 */
  need: number;
  /** 冷卻(遊戲日) */
  cooldownDays: number;
  /** 額外環境條件(例:天氣);缺省 = 隨時可觸發 */
  when?: () => boolean;
  /** 從在場的人裡挑出參與者;回傳 null = 這次條件不成立 */
  select: (present: TenantRuntime[], rng: Rng) => TenantRuntime[] | null;
  /** 觸發:套用效果 + 寫日誌 */
  fire: (parts: TenantRuntime[], rng: Rng) => void;
  /** 有明確時段的群體事件先排程，屆時才結算並啟動多人畫面。 */
  scene?: {
    hour: number;
    title: string;
    venue: GroupSceneVenue;
    layout: GroupSceneLayout;
    fx?: Parameters<typeof startGroupScene>[0]["fx"];
  };
}

export const COMMUNITY_EVENTS: CommunityEvent[] = [
  {
    // 冰箱連鎖:先發生食物失蹤與猜疑，下一次事件優先讓同一對把真相說開。
    id: "kitchen_fridge",
    need: 2,
    cooldownDays: 2,
    select: (present, rng) => {
      if (!hasLoungeFurniture("fridge")) return null;
      const available = shuffle(present, rng).filter((rt) => !KITCHEN_UNAVAILABLE.has(rt.tenant.visualState));
      const pending = pendingFridgePair(available);
      if (pending) return pending;
      const free = available.filter((rt) => !rt.flags.some((f) => f.startsWith(FRIDGE_MISSING_PREFIX) || f.startsWith(FRIDGE_SUSPECT_PREFIX)));
      return free.length >= 2 ? free.slice(0, 2) : null;
    },
    fire: (parts, rng) => {
      const [a, b] = parts;
      const missingFlag = `${FRIDGE_MISSING_PREFIX}${b.tenant.id}`;
      const suspectFlag = `${FRIDGE_SUSPECT_PREFIX}${a.tenant.id}`;
      const variant = sceneIndex(parts, "kitchen_fridge", COMMUNITY_LINES.fridgeMissingA.length);

      if (a.flags.includes(missingFlag) && b.flags.includes(suspectFlag)) {
        removeFlag(a, missingFlag);
        removeFlag(b, suspectFlag);
        adjustRelationship(a.tenant.id, b.tenant.id, 4);
        bumpMood(a, 3, -3);
        bumpMood(b, 3, -2);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.fridgeTruthA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.fridgeTruthB[variant], { o: a.tenant.name }), "notable");
        stageKitchen(parts, "fridge", "stand_face", "eating", "chat");
        notify(`🔎 ${a.tenant.name} 和 ${b.tenant.name} 終於把冰箱食物失蹤的誤會說開了`);
        return;
      }

      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      if (rel < 50 || rng() < 0.4) {
        addFlag(a, missingFlag);
        addFlag(b, suspectFlag);
        adjustRelationship(a.tenant.id, b.tenant.id, -3);
        bumpMood(a, -2, 4);
        bumpMood(b, -2, 3);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.fridgeMissingA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.fridgeMissingB[variant], { o: a.tenant.name }), "notable");
        stageKitchen(parts, "fridge", "stand_face", "eating", "anger");
        notify(`🍮 ${a.tenant.name} 的冰箱食物不見了，第一個懷疑 ${b.tenant.name}`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 2);
        bumpMood(a, 3, -2);
        bumpMood(b, 3, -2);
        const line = fillCommunity(COMMUNITY_LINES.fridgeShare[variant], { o: b.tenant.name });
        pushSocialLog(a, line, "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.fridgeShare[variant], { o: a.tenant.name }), "notable");
        stageKitchen(parts, "fridge", "stand_face", "eating", "chat");
      }
    },
  },
  {
    // 瓦斯爐 + 流理臺 + 餐桌:關係好會合作料理，關係差則為用料與收拾起口角。
    id: "kitchen_cook",
    need: 2,
    cooldownDays: 2,
    select: (present, rng) => {
      if (!hasLoungeFurniture("stove", "counter", "dining_table")) return null;
      const available = shuffle(present, rng).filter((rt) => !KITCHEN_UNAVAILABLE.has(rt.tenant.visualState));
      return available.length >= 2 ? available.slice(0, 2) : null;
    },
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      const variant = sceneIndex(parts, "kitchen_cook", COMMUNITY_LINES.cookFriendly.length);
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -3);
        bumpMood(a, -2, 4);
        bumpMood(b, -2, 4);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.cookConflictA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.cookConflictB[variant], { o: a.tenant.name }), "notable");
        stageKitchen(parts, "counter", "cook_pair", "cooking", "anger");
        notify(`🍳 ${a.tenant.name} 和 ${b.tenant.name} 在廚房越幫越忙，最後吵了起來`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 3);
        bumpMood(a, 4, -3);
        bumpMood(b, 4, -3);
        const line = COMMUNITY_LINES.cookFriendly[variant];
        pushSocialLog(a, fillCommunity(line, { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(line, { o: a.tenant.name }), "notable");
        stageKitchen(parts, "counter", "cook_pair", "cooking", "chat");
        notify(`🍳 ${a.tenant.name} 和 ${b.tenant.name} 一起完成了一頓飯`);
      }
    },
  },
  {
    // 咖啡機:低強度的日常善意，也能讓原本不熟或尷尬的兩人慢慢回溫。
    id: "morning_coffee",
    need: 2,
    cooldownDays: 2,
    select: (present, rng) => {
      if (!hasLoungeFurniture("coffee_machine")) return null;
      const available = shuffle(present, rng).filter((rt) => !KITCHEN_UNAVAILABLE.has(rt.tenant.visualState));
      return available.length >= 2 ? available.slice(0, 2) : null;
    },
    fire: (parts) => {
      const [a, b] = parts;
      const variant = sceneIndex(parts, "morning_coffee", COMMUNITY_LINES.coffeeKindness.length);
      adjustRelationship(a.tenant.id, b.tenant.id, 1);
      bumpMood(a, 2, -2);
      bumpMood(b, 2, -2);
      pushSocialLog(a, fillCommunity(COMMUNITY_LINES.coffeeKindness[variant], { o: b.tenant.name }), "notable");
      pushSocialLog(b, fillCommunity(COMMUNITY_LINES.coffeeKindness[variant], { o: a.tenant.name }), "notable");
      stageKitchen(parts, "coffee_machine", "stand_face", "using_appliance", "chat");
    },
  },
  {
    // 洗衣房:關係好 → 邊等邊聊變更近;關係差 → 搶洗衣機起口角(讓死空間活起來)
    id: "laundry",
    need: 2,
    cooldownDays: 3,
    select: (present, rng) => {
      const available = shuffle(present, rng).filter((rt) => !LAUNDRY_UNAVAILABLE.has(rt.tenant.visualState));
      return available.length >= 2 ? available.slice(0, 2) : null;
    },
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      const variant = sceneIndex(parts, "laundry", COMMUNITY_LINES.laundryConflictA.length);
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -4);
        bumpMood(a, -2, 5);
        bumpMood(b, -2, 5);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.laundryConflictA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.laundryConflictB[variant], { o: a.tenant.name }), "notable");
        stageLaundry(parts, "anger");
        notify(`🧺 ${a.tenant.name} 和 ${b.tenant.name} 在洗衣房搶洗衣機起了口角`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 3);
        bumpMood(a, 3, -2);
        bumpMood(b, 3, -2);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.laundryFriendlyA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.laundryFriendlyB[variant], { o: a.tenant.name }), "notable");
        stageLaundry(parts, "chat");
      }
    },
  },
  {
    // 浴室:關係差 → 趕時間搶浴室互相催促(rel↓);關係好 → 排隊等浴室時聊起來(rel↑)
    id: "bathroom",
    need: 2,
    cooldownDays: 3,
    select: (present, rng) => {
      const available = shuffle(present, rng).filter((rt) => !BATHROOM_UNAVAILABLE.has(rt.tenant.visualState));
      return available.length >= 2 ? available.slice(0, 2) : null;
    },
    fire: (parts) => {
      const [a, b] = parts;
      const rel = getRel(a.tenant.id, b.tenant.id)?.value ?? 40;
      const variant = sceneIndex(parts, "bathroom", COMMUNITY_LINES.bathroomConflictA.length);
      if (rel < 35) {
        adjustRelationship(a.tenant.id, b.tenant.id, -3);
        bumpMood(a, -1, 4);
        bumpMood(b, -1, 4);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.bathroomConflictA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.bathroomConflictB[variant], { o: a.tenant.name }), "notable");
        stageBathroom(parts, "anger");
        notify(`🚿 ${a.tenant.name} 和 ${b.tenant.name} 為了搶浴室鬧得不太愉快`);
      } else {
        adjustRelationship(a.tenant.id, b.tenant.id, 2);
        bumpMood(a, 2, -1);
        bumpMood(b, 2, -1);
        pushSocialLog(a, fillCommunity(COMMUNITY_LINES.bathroomFriendlyA[variant], { o: b.tenant.name }), "notable");
        pushSocialLog(b, fillCommunity(COMMUNITY_LINES.bathroomFriendlyB[variant], { o: a.tenant.name }), "notable");
        stageBathroom(parts, "chat");
      }
    },
  },
  {
    // 洗衣間 · 早晨尖峰:幾個人一起卡在廁所/浴室門口,同仇敵愾反而拉近(週末沒有上班尖峰)
    id: "morning_rush",
    need: 3,
    cooldownDays: 4,
    when: () => !isWeekend(state.gameMs),
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      for (const rt of parts) bumpMood(rt, -1, 3);
      bondAll(parts, 1); // 一起排隊乾瞪眼、互吐苦水,反而熟了一點
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.morningRush[sceneIndex(parts, "morning_rush", COMMUNITY_LINES.morningRush.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🚽 早晨尖峰:${names} 在廁所浴室門口排起隊`);
      fxAt("bathroom", "chat");
    },
  },
  {
    // 樓層揪團:三人以上一起訂手搖/團購,難得的熱鬧
    id: "group_order",
    need: 3,
    cooldownDays: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 4, -3);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.groupOrder[sceneIndex(parts, "group_order", COMMUNITY_LINES.groupOrder.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🧋 ${names} 揪團訂飲料,整層樓熱鬧了起來`);
    },
  },
  {
    // 噪音公審:一位吵鬧/夜貓的住戶被幾位鄰居集體抱怨(多對一)
    id: "noise_tribunal",
    need: 3,
    cooldownDays: 3,
    select: (present, rng) => {
      const shuffled = shuffle(present, rng);
      const target = shuffled.find(noiseComplaintEligible);
      if (!target) return null;
      const complainers = shuffled.filter((rt) => rt.tenant.id !== target.tenant.id).slice(0, 2);
      if (complainers.length < 2) return null;
      return [target, ...complainers];
    },
    fire: (parts) => {
      const [target, ...complainers] = parts;
      const variant = sceneIndex(parts, "noise_tribunal", COMMUNITY_LINES.noiseComplain.length);
      bumpMood(target, -3, 6);
      for (const c of complainers) {
        bumpMood(c, -1, 3);
        adjustRelationship(c.tenant.id, target.tenant.id, -4);
        pushSocialLog(c, fillCommunity(COMMUNITY_LINES.noiseComplain[variant], { o: target.tenant.name }), "notable");
      }
      pushSocialLog(target, fillCommunity(COMMUNITY_LINES.noiseTarget[variant], { names: complainers.map((c) => c.tenant.name).join("、") }), "notable");
      notify(`😤 幾位住戶一起向 ${target.tenant.name} 反映噪音`);
    },
  },
  {
    // 頂樓乘涼:傍晚幾個人相約頂樓吹風,壓力都消了(雨天不上頂樓)
    id: "rooftop",
    need: 3,
    cooldownDays: 3,
    when: () => todayWeather() !== "rainy",
    scene: { hour: 18, title: "傍晚頂樓乘涼", venue: "rooftop", layout: "cluster" },
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 5, -6);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.rooftop[sceneIndex(parts, "rooftop", COMMUNITY_LINES.rooftop.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🌇 ${names} 相約頂樓乘涼`);
    },
  },
  {
    // 雨天窩交誼廳:下雨哪兒也去不了,反而把大家聚在一起(雨天限定)
    id: "rainy_lounge",
    need: 3,
    cooldownDays: 2,
    when: () => todayWeather() === "rainy",
    scene: { hour: 15, title: "雨天窩在交誼廳", venue: "lounge", layout: "cluster", fx: "chat" },
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 4, -4);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.rainyLounge[sceneIndex(parts, "rainy_lounge", COMMUNITY_LINES.rainyLounge.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🌧️ 雨天午後,${names} 窩在交誼廳`);
      unlock("rainy_day"); // 隱藏成就:雨天的交誼廳
    },
  },
  {
    // 週末電影夜:週末晚上幾個人把交誼廳變成小影廳(週末限定)
    id: "weekend_movie",
    need: 3,
    cooldownDays: 3,
    when: () => isWeekend(state.gameMs),
    scene: { hour: 20, title: "週末電影夜", venue: "lounge", layout: "watch", fx: "chat" },
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 5, -5);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.weekendMovie[sceneIndex(parts, "weekend_movie", COMMUNITY_LINES.weekendMovie.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🎬 週末電影夜:${names} 窩在交誼廳看片`);
    },
  },
];

// ---------------------------------------------------------------------------
// 咖啡廳打烊後的聚會(CAFE-21 的內容端;設計文件 §4.12)
// ---------------------------------------------------------------------------

/**
 * 為什麼是「打烊後」而不是營業時間內。
 *
 * 1. **畫面不打架**:`groupScene.cafeTiles()` 只看 grid 與 `currentBlocked()`,
 *    完全不知道 `guestAgents` 的座位／吧台／人龍格與 `staffAgents` 的站位在哪
 *    ⇒ 營業時間內開場,3～4 位租客極可能站進排隊隊伍或客人座位上。
 *    `cafeBusinessOpen()` 為 false 的時段,顧客與店員 agent 都已清空,整層地板是空的。
 * 2. **內容不重複**:白天的一樓已經有租客了 —— CAFE-20(`routine.ts` 的 `at_cafe`)
 *    讓租客各自下樓坐咖啡廳。缺的是**群體**的畫面,而「打烊後自己人包場」正好和
 *    白天的散客感區隔開,是一個新畫面而不是同一個畫面加人。
 * 3. 21:00 是 `CAFE_CLOSE_HOUR`(20,含尾)之後的第一個整點;此時七種作息原型有五種
 *    仍在樓裡,`scheduledCommunityPass()` 本來就會把答應參加的人拉回來入鏡。
 *
 * 唯一閘門是 `state.cafe.open`(見 `rollCafeGathering()`):沒開張就完全不抽,
 * 連一次 `rng()` 都不消耗 ⇒ 無頭的 balance 快照局位元級零漂移。
 */
/**
 * 打烊後聚會的時段。刻意**複製** `tick.ts` 的 `CAFE_CLOSE_HOUR`(20,含尾)+1 而不 import
 * ——與 `routine.ts` 同一個理由:`tick.ts` 已經 import 本檔,反向 import 會讓兩個模組
 * 在求值期互等。`cafe-gathering-test.ts` 有一條斷言把兩邊釘在一起。
 */
export const CAFE_GATHER_HOUR = 21;

/** 「當天沒別的社群事件」時,補抽咖啡廳場的機率。 */
export const CAFE_GATHER_CHANCE = 0.3;

export const CAFE_COMMUNITY_EVENTS: CommunityEvent[] = [
  {
    // 平日打烊後:自己人留在店裡收尾兼閒聊(吧台前)
    id: "cafe_afterhours",
    // need 從 3 降到 2:種子局只有兩位租客,need=3 讓這兩件事件**在種子局永遠不可能觸發**
    // (`rollCafeGathering()` 的 `present.length >= e.need` 直接濾掉)⇒ 玩家從沒看過。
    // 週末場也一起降,否則週末會兩邊都失格(平日場被 `when` 擋、週末場被 `need` 擋),
    // 白白少掉一週 2/7 的機會。`community.ts` 的 `parts.length < ev.need` 讀的是 `ev.need`,
    // 會自動跟著走,不必另外改。
    // ✅ 2026-08-28 已修:排程型事件的冷卻改成「演出成功才蓋章」(見 `stampCommunityCooldown()`)。
    //    need=2 時兩人中任一人在演出當下被掛上待決事件,整場仍然取消,但**冷卻不再白燒**
    //    ⇒ 隔天的 `communityPass()` 就能重抽同一件,玩家不會因為一次錯過而被靜音三天。
    need: 2,
    cooldownDays: 3,
    when: () => !isWeekend(state.gameMs),
    scene: { hour: CAFE_GATHER_HOUR, title: "打烊後的咖啡廳", venue: "cafe", layout: "table", fx: "chat" },
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(3, present.length)),
    fire: (parts) => {
      bondAll(parts, 2);
      for (const rt of parts) bumpMood(rt, 4, -5);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.cafeAfterHours[sceneIndex(parts, "cafe_afterhours", COMMUNITY_LINES.cafeAfterHours.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`☕ 打烊後的一樓:${names} 留在店裡聊天`);
    },
  },
  {
    // 週末打烊後:整層樓下樓包場(座位區中央)
    // need 2:理由與「湊不到人就取消、但冷卻不白燒」的處理同上面的 `cafe_afterhours`。
    id: "cafe_weekend_night",
    need: 2,
    cooldownDays: 3,
    when: () => isWeekend(state.gameMs),
    scene: { hour: CAFE_GATHER_HOUR, title: "週末包場的自家咖啡廳", venue: "cafe", layout: "cluster", fx: "hearts" },
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    fire: (parts) => {
      bondAll(parts, 3);
      for (const rt of parts) bumpMood(rt, 5, -6);
      const names = parts.map((p) => p.tenant.name).join("、");
      const line = COMMUNITY_LINES.cafeWeekendNight[sceneIndex(parts, "cafe_weekend_night", COMMUNITY_LINES.cafeWeekendNight.length)];
      for (const rt of parts) pushSocialLog(rt, fillCommunity(line, { names }), "notable");
      notify(`🌙 週末打烊後,${names} 把一樓咖啡廳包了場`);
    },
  },
];

function onCooldown(id: string, days: number): boolean {
  const last = state.interactionCooldowns[`community|${id}`];
  return last != null && state.gameMs - last < days * 24 * 3600 * 1000;
}

/**
 * 排程型(有 `scene`)事件演出成功後才蓋的冷卻章。
 *
 * 🔴 **為什麼要正規化到當天 00:00**,而不是直接寫 `state.gameMs`:
 * 抽籤端 `communityPass()` 只在 `tick.ts` 的換日區塊(`d.getDate() !== prevDay`)呼叫,
 * 也就是**每遊戲日的 00:00 整**;而 `GAME_START` 是整點,`gameMs` 每次只前進整整一小時
 * ⇒ 舊寫法蓋下去的那個章,值必定**正好是當天的 00:00**。
 * 演出時刻是 15/18/20/21 點,若改蓋 `state.gameMs` 就等於把章往後挪 15~21 小時,
 * `state.gameMs - last < days*24h` 的比較會讓下一次可觸發日**整整晚一天**
 * (例:cooldownDays=3 實質變成 4 日)—— 那是平衡改動,不是穩健性修復。
 * 正規化成當天 00:00 後,蓋章的**值與舊寫法逐位元相同**,冷卻節奏零漂移。
 * `cooldownDays` 本來就是「日」為單位,day-granular 也才是它真正的語意。
 */
function stampCommunityCooldown(id: string) {
  const day = new Date(state.gameMs);
  day.setHours(0, 0, 0, 0);
  state.interactionCooldowns[`community|${id}`] = day.getTime();
}

/**
 * 這件事是否已經排在待演隊列裡。
 *
 * 冷卻改成「演出才蓋章」之後,`onCooldown()` 在**排程 → 演出**的窗口內是 false
 * ⇒ 少了這道閘,同一件事可能被排第二次(兩份演出、兩次效果)。
 *
 * 🔍 這個窗口實際有多長:`communityPass()` 只在換日區塊被呼叫(每遊戲日 00:00 一次),
 * 而 `dueAtHour()` 把演出排在**同一天**的 15/18/20/21 點(都晚於 00:00 ⇒ 不會被推到隔天),
 * `scheduledCommunityPass()` 又是**每遊戲小時**呼叫、且排在換日區塊**之前**
 * ⇒ 正常時序下,抽籤當下待演隊列必定是空的,這道閘一次都不會真的擋到東西
 * (`eligible` 集合不變 ⇒ `Math.floor(rng() * eligible.length)` 的結果不變 ⇒ balance 快照零漂移)。
 * 它是給「呼叫時序被改動 / 腳本直接連呼 `communityPass()` / 存檔裡帶著待演項目載入」
 * 這幾種情況的安全網,不是日常會走到的路徑。
 */
function isCommunityEventScheduled(id: string): boolean {
  return state.scheduledCommunityEvents.some((entry) => entry.eventId === id);
}

function dueAtHour(hour: number): number {
  const due = new Date(state.gameMs);
  due.setHours(hour, 0, 0, 0);
  if (due.getTime() <= state.gameMs) due.setDate(due.getDate() + 1);
  return due.getTime();
}

function scheduleCommunityEvent(ev: CommunityEvent, parts: TenantRuntime[]) {
  if (!ev.scene) return;
  state.scheduledCommunityEvents.push({
    eventId: ev.id,
    participantIds: parts.map((rt) => rt.tenant.id),
    dueGameMs: dueAtHour(ev.scene.hour),
  });
  state.scheduledCommunityEvents.sort((a, b) => a.dueGameMs - b.dueGameMs || a.eventId.localeCompare(b.eventId));
  save();
}

/** 已排程的事件可能來自任一個池;存檔裡只有 id,兩個池都要查得到(舊檔亦然)。 */
function findScheduledEvent(eventId: string): CommunityEvent | undefined {
  return COMMUNITY_EVENTS.find((candidate) => candidate.id === eventId)
    ?? CAFE_COMMUNITY_EVENTS.find((candidate) => candidate.id === eventId);
}

/** 每遊戲小時呼叫：到正確時段才真正寫日誌、套效果並啟動多人舞台。 */
export function scheduledCommunityPass(rng: Rng = Math.random): number {
  const due = state.scheduledCommunityEvents.filter((entry) => entry.dueGameMs <= state.gameMs);
  if (due.length === 0) return 0;
  let fired = 0;
  for (const entry of due) {
    const index = state.scheduledCommunityEvents.indexOf(entry);
    if (index >= 0) state.scheduledCommunityEvents.splice(index, 1);
    const ev = findScheduledEvent(entry.eventId);
    if (!ev?.scene) continue;
    const parts = entry.participantIds
      .map((id) => state.runtimes[id])
      // 演出本身就是這個時段的行程：即使一般作息原本是外出，也讓已答應參加的人回來入鏡。
      .filter((rt): rt is TenantRuntime => !!rt && !rt.pendingEvent);
    // 湊不到人(例:need=2 的咖啡廳場,兩人中有一人被掛上待決事件)⇒ 這場取消。
    // 🔴 取消時**不蓋冷卻章**:章在下一行、通過人數門檻之後才蓋 ⇒ 這件事隔天可以重抽,
    //    玩家不會因為一次「什麼都沒發生」而被靜音整個冷卻期(docs/待辦.md 的靜默取消 + 白燒冷卻)。
    if (parts.length < ev.need) continue;
    stampCommunityCooldown(ev.id);
    ev.fire(parts, rng);
    startGroupScene({
      id: `community:${ev.id}:${entry.dueGameMs}`,
      title: ev.scene.title,
      venue: ev.scene.venue,
      layout: ev.scene.layout,
      participantIds: parts.map((rt) => rt.tenant.id),
      fx: ev.scene.fx,
      gameNow: state.gameMs,
      priority: 1,
    });
    fired++;
  }
  save();
  return fired;
}

/** 每遊戲日呼叫:有機率觸發一件社群事件(牽動 3+ 人,進 Feed)。稀疏、不洗版。
 *  也可能升級成「有房東抉擇」的群體事件(較低機率、需 3+ 人、無待決的且離上次夠久)。 */
export function communityPass(rng: Rng = Math.random): boolean {
  const present = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent);
  if (present.length < 2) return false;
  // 房東抉擇的群體事件(你的決定一次影響整群人):較稀有,一次只掛一件
  if (present.length >= 3 && !state.pendingGroupEvent && rng() < 0.18) {
    if (rollGroupEvent(present, rng)) return true;
  }
  if (rollCommunityEvent(present, rng)) return true;
  // 當天沒有別的社群事件才補抽咖啡廳場 ⇒ 不佔既有事件的名額,lounge／rooftop 的
  // 絕對與相對觸發率都完全不變(把咖啡廳事件併進 COMMUNITY_EVENTS 會把每件從
  // 1/N 稀釋成 1/(N+2),那就動到平衡了)。
  return rollCafeGathering(present, rng);
}

/** 既有的樓層社群事件抽籤(行為與抽出的 RNG 次序都與併入本函式前一致)。 */
function rollCommunityEvent(present: TenantRuntime[], rng: Rng): boolean {
  if (rng() > 0.4) return false; // 不是每天都有事發生(稀疏、不洗版)
  const eligible = COMMUNITY_EVENTS.filter((e) => present.length >= e.need && !onCooldown(e.id, e.cooldownDays)
    && !isCommunityEventScheduled(e.id) && (!e.when || e.when()));
  if (eligible.length === 0) return false;
  const ev = eligible[Math.floor(rng() * eligible.length)];
  const parts = ev.select(present, rng);
  if (!parts || parts.length < ev.need) return false;
  if (ev.scene) {
    // 排程型:現在只是**約好**,還沒演出 ⇒ 不蓋冷卻章。章由 `scheduledCommunityPass()`
    // 在真的湊到人、真的開演時才蓋(重複排程改由 `isCommunityEventScheduled()` 擋)。
    scheduleCommunityEvent(ev, parts);
  } else {
    // 非排程型:當場 fire ⇒「排程時蓋章」本來就等於「成功才蓋章」,語意不變、時間戳也不變。
    ev.fire(parts, rng);
    state.interactionCooldowns[`community|${ev.id}`] = state.gameMs;
  }
  return true;
}

/**
 * 咖啡廳打烊後的聚會抽籤。
 *
 * 第一行的 `state.cafe.open` 是**天然閘門**:未開張就直接 return,一次 `rng()` 都不抽
 * ⇒ 呼叫端後續的亂數序列與未開張前位元級相同(balance 快照零漂移)。
 */
function rollCafeGathering(present: TenantRuntime[], rng: Rng): boolean {
  if (!state.cafe.open) return false; // 天然閘門:沒開張的店不可能有人在裡面聚會
  const eligible = CAFE_COMMUNITY_EVENTS.filter((e) => present.length >= e.need && !onCooldown(e.id, e.cooldownDays)
    && !isCommunityEventScheduled(e.id) && (!e.when || e.when()));
  if (eligible.length === 0) return false;
  if (rng() > CAFE_GATHER_CHANCE) return false;
  const ev = eligible[Math.floor(rng() * eligible.length)];
  const parts = ev.select(present, rng);
  if (!parts || parts.length < ev.need) return false;
  // 咖啡廳事件全部帶 `scene` ⇒ 一律走排程,冷卻章同樣留給 `scheduledCommunityPass()` 蓋。
  scheduleCommunityEvent(ev, parts);
  return true;
}

// ---------------------------------------------------------------------------
// 群體事件(有房東抉擇版,§C-7):你的選擇一次影響整群人
// ---------------------------------------------------------------------------

interface GroupTemplate {
  id: string;
  need: number;
  /** 額外環境條件(例:週末);缺省 = 隨時可觸發 */
  when?: () => boolean;
  select: (present: TenantRuntime[], rng: Rng) => TenantRuntime[] | null;
  make: (parts: TenantRuntime[]) => { title: string; description: string; choices: GroupChoice[] };
}

const GROUP_TEMPLATES: GroupTemplate[] = [
  {
    // 公共區設備老舊:房東出錢翻新 / 請住戶分攤 / 先擱著
    id: "public_repair",
    need: 3,
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    make: (parts) => ({
      title: "公共區的設備老舊了",
      description: `${parts.map((p) => p.tenant.name).join("、")} 都反映交誼廳的公共設備開始故障、用起來卡卡的。要怎麼處理?`,
      choices: [
        { id: "fix", label: "房東出錢翻新($2,500)", hint: "大家住得更舒服,對你更有好感", money: -2500, all: { satisfaction: 8, affinity: 6, mood: 4 } },
        { id: "split", label: "請住戶一起分攤", hint: "設備會修好,但住戶有點不情願", all: { satisfaction: 2, affinity: -2, stress: 4 } },
        { id: "defer", label: "先擱著不處理", hint: "省了錢,但滿意度和好感下滑", all: { satisfaction: -5, affinity: -3 } },
      ],
    }),
  },
  {
    // 噪音糾紛裁決:需要一位吵鬧/夜貓當事人 + 至少 2 位鄰居
    id: "noise_verdict",
    need: 3,
    select: (present, rng) => {
      const s = shuffle(present, rng);
      const target = s.find(noiseComplaintEligible);
      if (!target) return null;
      const others = s.filter((rt) => rt.tenant.id !== target.tenant.id).slice(0, 2);
      return others.length >= 2 ? [target, ...others] : null;
    },
    make: (parts) => {
      const [target, ...others] = parts;
      return {
        title: "噪音糾紛要你裁決",
        description: `${others.map((p) => p.tenant.name).join("、")} 一起來反映 ${target.tenant.name} 的作息太吵。你怎麼處理?`,
        choices: [
          { id: "warn", label: `警告 ${target.tenant.name}`, hint: "站在鄰居這邊(當事人會不爽)", first: { stress: 8, affinity: -6 }, rest: { satisfaction: 4, affinity: 4 } },
          { id: "soundproof", label: "花錢做隔音($3,000)", hint: "永久改善這間房的噪音外洩", money: -3000, all: { satisfaction: 6, affinity: 5 }, clearsNoise: true, installsSoundproofing: true },
          { id: "tolerate", label: "請大家互相包容", hint: "不花錢,但抱怨方會不滿", first: { mood: 3 }, rest: { stress: 4, affinity: -3 } },
        ],
      };
    },
  },
  {
    // 樓層聚餐提議:房東請客 / 大家 AA / 婉拒(聚餐約在週末,平日大家要上班)
    id: "floor_party",
    need: 3,
    when: () => isWeekend(state.gameMs),
    select: (present, rng) => shuffle(present, rng).slice(0, Math.min(4, present.length)),
    make: (parts) => ({
      title: "住戶想辦一場樓層聚餐",
      description: `${parts.map((p) => p.tenant.name).join("、")} 提議辦一場樓層聚餐熱鬧一下。你的態度?`,
      choices: [
        { id: "host", label: "房東請客($1,500)", hint: "全樓感情大加溫", money: -1500, all: { mood: 8, affinity: 8 }, bond: 4 },
        { id: "aa", label: "讓大家 AA 均分", hint: "還是很開心,只是你不出錢", all: { mood: 4 }, bond: 3 },
        { id: "decline", label: "婉拒這次提議", hint: "省事,但住戶有點掃興", all: { mood: -2, affinity: -2 } },
      ],
    }),
  },
];

/** 嘗試觸發一件群體抉擇事件(掛到 state.pendingGroupEvent 等房東決定);成功回 true */
export function rollGroupEvent(present: TenantRuntime[], rng: Rng = Math.random): boolean {
  if (state.pendingGroupEvent) return false;
  if (onCooldown("group_any", 3)) return false; // 群體抉擇之間至少隔 3 遊戲日
  const eligible = GROUP_TEMPLATES.filter((t) => present.length >= t.need && (!t.when || t.when()));
  if (eligible.length === 0) return false; // 過濾後可能為空(例:平日沒有週末限定模板)
  const tmpl = eligible[Math.floor(rng() * eligible.length)];
  const parts = tmpl.select(present, rng);
  if (!parts || parts.length < tmpl.need) return false;
  const built = tmpl.make(parts);
  state.pendingGroupEvent = { id: tmpl.id, participantIds: parts.map((p) => p.tenant.id), ...built };
  notify(`🏢 有一件全樓事務要你決定:${built.title}`);
  return true;
}

function applyDelta(rt: TenantRuntime, d?: GroupDelta) {
  if (!d) return;
  const s = rt.tenant.stats;
  if (d.mood) s.mood = clamp(s.mood + d.mood, 0, 100);
  if (d.stress) s.stress = clamp(s.stress + d.stress, 0, 100);
  if (d.affinity) s.affinity = clamp(s.affinity + d.affinity, 0, 100);
  if (d.satisfaction) rt.satisfaction = clamp(rt.satisfaction + d.satisfaction, 0, 100);
}

/** 房東拍板:套用選項效果到全體參與者 + 兩兩關係 + 房東花費,寫結果日誌,清掉待決 */
export function resolveGroupEvent(choiceId: string): boolean {
  const ev = state.pendingGroupEvent;
  if (!ev) return false;
  const choice = ev.choices.find((c) => c.id === choiceId);
  if (!choice) return false;
  if (choice.money) addMoney(choice.money, `全樓事務:${ev.title}`, "event");
  const parts = ev.participantIds.map((id) => state.runtimes[id]).filter(Boolean) as TenantRuntime[];
  parts.forEach((rt, i) => {
    applyDelta(rt, choice.all);
    applyDelta(rt, i === 0 ? choice.first : choice.rest);
    rt.unhappyHours = 0;
  });
  if (choice.bond) bondAll(parts, choice.bond);
  if (ev.id === "noise_verdict" && parts.length >= 2) {
    const tensionDelta = choice.id === "soundproof" ? -15 : choice.id === "warn" ? 5 : 8;
    for (let i = 1; i < parts.length; i++) adjustTension(parts[0].tenant.id, parts[i].tenant.id, tensionDelta);
  }
  if (choice.clearsNoise) for (const rt of parts) clearNoiseMemories(rt.tenant); // 隔音選項:清掉噪音困擾記憶
  if ((choice.installsSoundproofing || (ev.id === "noise_verdict" && choice.id === "soundproof")) && parts[0]) {
    grantEventSoundproofing(parts[0].tenant.id); // 永久入 upgrades 存檔，不再只是清掉當下抱怨
  }
  if (ev.id === "floor_party" && choice.id !== "decline") {
    startGroupScene({
      id: `group:floor_party:${state.gameMs}`,
      title: choice.id === "host" ? "房東請客的樓層聚餐" : "住戶 AA 樓層聚餐",
      venue: "lounge",
      layout: "table",
      participantIds: parts.map((rt) => rt.tenant.id),
      fx: "hearts",
      gameNow: state.gameMs,
      priority: 1,
    });
  }
  for (const rt of parts) pushSocialLog(rt, `🏢 「${ev.title}」——房東選擇了「${choice.label}」。`, "notable");
  state.interactionCooldowns["community|group_any"] = state.gameMs; // 與 onCooldown("group_any") 同鍵
  state.pendingGroupEvent = null;
  save();
  return true;
}
