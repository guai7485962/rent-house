/**
 * 寵物貓系統:租客養的貓會在樓層遊走,並引發貓咪事件。
 *
 * 模擬層(無頭可測):每遊戲小時 petsPass() 決定貓這小時待哪個區域(hangout),
 * 並擲骰事件——溜進別的房客房裡(親貓的人被療癒、怕貓/潔癖的人被嚇到)、
 * 打破東西、隨地大小便。渲染層(floor/petAgents)只負責讓貓「走去 hangout 遊蕩」。
 *
 * 取得途徑:種子(陳家豪的橘貓「橘子」,他的作息本來就有逗貓時段)、
 * AI/規則事件的 adopt_cat 行為指令(指令到期後貓留下,成為永久寵物)。
 *
 * 樓貓(圓夢畢業批):飼主圓夢離開時可把貓「留下成樓貓」——pet.ownerId 改為
 * 哨兵值 "landlord"(Pet.ownerId 型別是 string,合法;不新增欄位、舊存檔零遷移)。
 * 樓貓沒有飼主 runtime:遊蕩錨點改為交誼廳,串門/搗蛋/貓週記照常(文案改「樓貓」)。
 * state.pets 的 key 維持原飼主 id(唯一,不會撞 key);貓的識別一律用 record key(catId)。
 */
import type { Pet } from "../types";
import { state, clamp, pushSocialLog, notify, roomOfTenant, type TenantRuntime } from "./gameState";
import { adjustRelationship } from "./social";
import { unlock } from "./legacy";
import { getPlacements } from "./placements";
import { roomRect } from "./placements";
import { spawnFx } from "../floor/fx";

/** 領養時的隨機貓名池(種子貓固定叫「橘子」) */
const CAT_NAMES = ["麻糬", "煤球", "湯圓", "布丁", "芝麻", "奶茶", "花捲", "豆花"];

/** 事件冷卻(遊戲毫秒);借用 interactionCooldowns 儲存(入存檔) */
const CD = {
  visit: 12 * 3600 * 1000, // 同一位鄰居半天內不重複串門子事件
  break: 36 * 3600 * 1000,
  poop: 30 * 3600 * 1000,
  pair: 10 * 3600 * 1000,
};

function onCooldown(key: string, cdMs: number): boolean {
  const last = state.interactionCooldowns[key];
  return last != null && state.gameMs - last < cdMs;
}
function markCooldown(key: string) {
  state.interactionCooldowns[key] = state.gameMs;
}

/** 樓貓的哨兵飼主 id(型別上 ownerId 是 string;不對應任何 runtime) */
export const HOUSE_CAT_OWNER = "landlord";
const isHouseCat = (pet: Pet) => pet.ownerId === HOUSE_CAT_OWNER;

/** 孤兒貓修復:飼主已不在 runtime 的貓一律轉為樓貓(補一則通知;冪等)。
 *  正常流程 moveOut 會刪貓或事先轉樓貓,這裡是舊存檔載入與防禦性的安全網。 */
export function repairOrphanCats() {
  for (const pet of Object.values(state.pets)) {
    if (isHouseCat(pet) || state.runtimes[pet.ownerId]) continue;
    pet.ownerId = HOUSE_CAT_OWNER;
    pet.hangout = "lounge";
    notify(`🐈 「${pet.name}」的主人已經搬走,公寓接手照顧,牠成了樓貓`);
  }
}

/** 種子寵物補登:陳家豪的作息本來就有「逗貓」時段——把那隻貓變成真的。
 *  也順手做孤兒貓修復(persistence 載入時呼叫本函式)。 */
export function ensurePets() {
  const chen = state.runtimes["tenant_chen_engineer"];
  if (chen && !state.pets[chen.tenant.id]) {
    state.pets[chen.tenant.id] = {
      name: "橘子",
      kind: "cat",
      color: 0, // 橘貓
      ownerId: chen.tenant.id,
      hangout: roomOfTenant(chen.tenant.id) ?? "lounge",
      sinceMs: state.gameMs,
    };
  }
  repairOrphanCats();
}

/** 圓夢畢業「貓的去留」抉擇的套用(tenancy.decide 呼叫):
 *  stay → 立即轉樓貓(ownerId="landlord",錨點交誼廳);take → 只留日誌,離開日隨 moveOut 帶走。 */
export function resolveCatFarewell(rt: TenantRuntime, choiceId: string) {
  const pet = state.pets[rt.tenant.id];
  if (!pet || pet.ownerId !== rt.tenant.id) return;
  if (choiceId === "stay") {
    pet.ownerId = HOUSE_CAT_OWNER;
    pet.hangout = "lounge";
    pushSocialLog(rt, `🐈 他把「${pet.name}」托付給了公寓:「牠在這裡比跟著我奔波幸福。」`, "major");
    notify(`🐈 「${pet.name}」留了下來,成為公寓的樓貓`);
  } else {
    pushSocialLog(rt, `🐈 決定帶「${pet.name}」一起走,連貓籠都提前買好了。`, "notable");
  }
}

/** 領養一隻貓(adopt_cat 指令生效 / 帶寵物入住時呼叫;已有貓則不重複)。
 *  preset:指定名字/花色(應徵者自帶的貓);省略則隨機。回傳新貓或 null。 */
export function adoptCat(tenantId: string, preset?: { name: string; color: number }): Pet | null {
  if (state.pets[tenantId]) return null;
  const rt = state.runtimes[tenantId];
  if (!rt) return null;
  const pet: Pet = {
    name: preset?.name ?? CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)],
    kind: "cat",
    color: preset?.color ?? 1 + Math.floor(Math.random() * 3), // 黑/白/三花(橘子是種子專屬)
    ownerId: tenantId,
    hangout: roomOfTenant(tenantId) ?? "lounge",
    sinceMs: state.gameMs,
  };
  state.pets[tenantId] = pet;
  notify(`🐈 ${rt.tenant.name} 養了一隻貓「${pet.name}」`);
  return pet;
}

/** 隨機挑一組貓名/花色(給應徵者自帶的貓;花色 1~3,橘色是種子專屬) */
export function randomCatPreset(): { name: string; color: number } {
  return { name: CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)], color: 1 + Math.floor(Math.random() * 3) };
}

/** 飼主房間是否擺了某件貓咪家具(貓砂盆/貓跳台 → 降低對應搗蛋機率;樓貓無飼主房 → 無減免) */
function ownerRoomHas(pet: Pet, defId: string): boolean {
  const room = roomOfTenant(pet.ownerId);
  return !!room && getPlacements().some((p) => p.room === room && p.defId === defId);
}

/** 貓咪家具對搗蛋機率的乘數:貓跳台壓低破壞、貓砂盆壓低隨地大小便(§A-2) */
export function mischiefRelief(pet: Pet): { break: number; poop: number } {
  return {
    break: ownerRoomHas(pet, "cat_tower") ? 0.3 : 1,
    poop: ownerRoomHas(pet, "litter_box") ? 0.15 : 1,
  };
}

/** 對貓的態度:標籤/職業裡有貓狗動物 → 喜歡;潔癖/過敏/怕貓 → 排斥;其餘中立。
 *  接受結構子集(租客或應徵者都適用;memoryTags 可省略) */
export function catAttitude(t: {
  coreTags: { label: string }[];
  memoryTags?: { label: string }[];
  occupation: string;
  bio: string;
}): "like" | "dislike" | "neutral" {
  const text = [...t.coreTags.map((x) => x.label), ...(t.memoryTags ?? []).map((x) => x.label), t.occupation, t.bio].join(" ");
  if (/怕貓|過敏|潔癖|討厭動物/.test(text)) return "dislike";
  if (/貓|狗|動物|寵物|療癒/.test(text)) return "like";
  return "neutral";
}

/** 住在某房的租客(承租者優先,否則同居者);沒有回 null */
function residentOf(roomId: string): TenantRuntime | null {
  const tid = state.occupancy[roomId] ?? Object.entries(state.cohabits).find(([, r]) => r === roomId)?.[0];
  return tid ? state.runtimes[tid] ?? null : null;
}

/** 這小時貓要待的區域:飼主房 55%、交誼廳 20%、別人的房 25%。
 *  樓貓沒有飼主房 → roomOfTenant 回 null,錨點自然落在交誼廳(75% 交誼廳、25% 串門)。 */
function pickHangout(pet: Pet): string {
  const home = roomOfTenant(pet.ownerId) ?? "lounge";
  const roll = Math.random();
  if (roll < 0.55) return home;
  if (roll < 0.75) return "lounge";
  const others = Object.keys(state.occupancy).filter((r) => r !== home && state.runtimes[state.occupancy[r]]);
  return others.length > 0 ? others[Math.floor(Math.random() * others.length)] : home;
}

/** 在區域中心掛一個特效(渲染層看得到「事發地點」) */
function fxAt(roomId: string, kind: Parameters<typeof spawnFx>[0], dur = 10000) {
  const rect = roomRect(roomId);
  if (rect) spawnFx(kind, Math.floor((rect.c0 + rect.c1) / 2), Math.floor((rect.r0 + rect.r1) / 2), dur);
}

/** 每遊戲小時:每隻貓換去處 + 擲骰貓咪事件(owner=null 代表樓貓) */
export function petsPass() {
  repairOrphanCats(); // 防禦:意外殘留的無主貓轉樓貓,不再無聲消失
  for (const [catId, pet] of Object.entries(state.pets)) {
    const owner = isHouseCat(pet) ? null : state.runtimes[pet.ownerId] ?? null;
    pet.hangout = pickHangout(pet);
    rollVisit(catId, pet, owner);
    rollMischief(catId, pet, owner);
  }
  resolveCatPairs();
}

type CatPairAction = NonNullable<Pet["pairAction"]>;
const CAT_PAIR_ACTIONS: CatPairAction[] = ["chase", "groom", "nap", "territory", "mischief"];

function clearExpiredCatPairs() {
  for (const pet of Object.values(state.pets)) {
    if (pet.pairUntilMs != null && pet.pairUntilMs <= state.gameMs) {
      delete pet.pairWith;
      delete pet.pairAction;
      delete pet.pairUntilMs;
    }
  }
}

/** 同區域的兩隻貓有機會互動。每小時最多一對且同一對有冷卻；force 僅供測試。
 *  貓一律以 state.pets 的 record key(catId)識別——樓貓的 ownerId 都是 "landlord",
 *  不能拿來配對;一般貓的 catId === ownerId,舊存檔的 pairWith/冷卻 key 完全相容。 */
export function resolveCatPairs(random: () => number = Math.random, force = false): CatPairAction | null {
  clearExpiredCatPairs();
  const entries = Object.entries(state.pets).filter(([, pet]) => isHouseCat(pet) || !!state.runtimes[pet.ownerId]);
  let arrangedKey = "";
  const alreadyTogether = entries.some(([, a], i) => entries.some(([, b], j) => j > i && a.hangout === b.hangout));
  // 兩隻貓原本沒碰面時,偶爾主動去找貓伴；避免「雙貓互動」只能靠兩次獨立亂數巧遇。
  if (!force && !alreadyTogether && entries.length >= 2 && random() < 0.12) {
    const i = Math.floor(random() * entries.length);
    let j = Math.floor(random() * (entries.length - 1));
    if (j >= i) j++;
    entries[j][1].hangout = entries[i][1].hangout;
    arrangedKey = [entries[i][0], entries[j][0]].sort().join("|");
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [aId, a] = entries[i];
      const [bId, b] = entries[j];
      if (a.hangout !== b.hangout || a.pairWith || b.pairWith) continue;
      const ids = [aId, bId].sort();
      const key = `petpair|${ids[0]}|${ids[1]}`;
      if (onCooldown(key, CD.pair)) continue;
      if (!force && arrangedKey !== ids.join("|") && random() > 0.28) continue;

      const action = CAT_PAIR_ACTIONS[Math.min(CAT_PAIR_ACTIONS.length - 1, Math.floor(random() * CAT_PAIR_ACTIONS.length))];
      a.pairWith = bId;
      b.pairWith = aId;
      a.pairAction = b.pairAction = action;
      a.pairUntilMs = b.pairUntilMs = state.gameMs + 2 * 3600 * 1000;
      markCooldown(key);
      applyCatPairEvent(a, b, action);
      return action;
    }
  }
  return null;
}

function applyCatPairEvent(a: Pet, b: Pet, action: CatPairAction) {
  const A = isHouseCat(a) ? null : state.runtimes[a.ownerId] ?? null;
  const B = isHouseCat(b) ? null : state.runtimes[b.ownerId] ?? null;
  const owners = [A, B].filter((rt): rt is TenantRuntime => !!rt);
  const place = a.hangout === "lounge" ? "交誼廳" : "房間裡";
  const logBoth = (text: string) => {
    for (const rt of owners) pushSocialLog(rt, `🐾 雙貓互動:${text}`, "notable");
    if (owners.length === 0) notify(`🐾 ${text}`); // 兩隻都是樓貓 → 至少讓房東看見
  };

  if (action === "chase") {
    for (const rt of owners) rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 3, 0, 100);
    logBoth(`${a.name} 和 ${b.name} 在${place}你追我跑,繞過家具後又一起折返。`);
    fxAt(a.hangout, "chat");
  } else if (action === "groom") {
    for (const rt of owners) {
      rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 4, 0, 100);
      rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 3, 0, 100);
    }
    logBoth(`${a.name} 和 ${b.name} 靠在一起互相理毛,理到一半還交換了位置。`);
    if (A && B) adjustRelationship(a.ownerId, b.ownerId, 1);
    fxAt(a.hangout, "hearts");
  } else if (action === "nap") {
    for (const rt of owners) rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 4, 0, 100);
    logBoth(`${a.name} 和 ${b.name} 在${place}圈成兩團,最後頭靠著頭睡著了。`);
    fxAt(a.hangout, "chat");
  } else if (action === "territory") {
    for (const rt of owners) rt.tenant.stats.stress = clamp(rt.tenant.stats.stress + 2, 0, 100);
    logBoth(`${a.name} 和 ${b.name} 為了同一塊地盤互瞪,各自炸毛後才假裝沒事走開。`);
    if (A && B) adjustRelationship(a.ownerId, b.ownerId, -1);
    fxAt(a.hangout, "anger");
  } else {
    const victim = a.hangout === "lounge" ? null : residentOf(a.hangout);
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 5, 0, 100);
    logBoth(`${a.name} 和 ${b.name} 聯手把小東西推下來,聽見聲音後還一起裝無辜。`);
    fxAt(a.hangout, "anger");
  }
}

/** 貓咪觀察筆記(彩蛋):每 7 遊戲日,以貓的口吻寫一篇這週的日常，落進全樓 Feed。
 *  純模板、零 AI 成本;素材來自現有狀態(貓名、飼主、隨機鄰居)。 */
const JOURNAL_CD = 7 * 24 * 3600 * 1000;

function randomNeighborName(ownerId: string): string {
  const others = Object.values(state.runtimes).filter((rt) => rt.tenant.id !== ownerId);
  return others.length ? others[Math.floor(Math.random() * others.length)].tenant.name : "隔壁";
}

function catJournalLines(petName: string, ownerName: string, neighbor: string): string[] {
  return [
    `這週我巡視了整層樓,確認每個角落都還歸我管。`,
    `${neighbor} 家的沙發比 ${ownerName} 的好睡,我決定改天再去躺一次。`,
    `${ownerName} 又對著會發光的板子敲敲打打,無聊,於是我躺上鍵盤主持正義。`,
    `午後三點陽光會移到窗邊,那是我的專屬時段,誰都不准打擾。`,
    `今天沒抓到任何東西,但我盡力了,人類應該以我為榮。`,
    `半夜開了一場只有我知道的運動會,把 ${ownerName} 吵醒是意外的收穫。`,
    `盯著牆角看了整整一小時,那裡確實有東西,只是你們看不見。`,
    `把一個小東西推下桌,觀察它墜落,這是嚴謹的科學研究。`,
  ];
}

/** 每遊戲日呼叫(自帶 7 日冷卻):輪到的貓發一篇觀察筆記進 Feed。
 *  樓貓沒有飼主 → 筆記掛在任一位在住租客的日誌上(Feed 彙整全樓日誌,玩家都看得到)。 */
export function catJournalPass() {
  for (const [catId, pet] of Object.entries(state.pets)) {
    const owner = isHouseCat(pet) ? null : state.runtimes[pet.ownerId];
    const host = owner ?? Object.values(state.runtimes)[0]; // 樓貓筆記的落點
    if (!host || (!owner && !isHouseCat(pet))) continue;
    const ck = `pet|${catId}|journal`;
    if (onCooldown(ck, JOURNAL_CD)) continue;
    markCooldown(ck);
    const ownerName = owner ? owner.tenant.name : "房東";
    const pool = catJournalLines(pet.name, ownerName, randomNeighborName(pet.ownerId));
    const i = Math.floor(Math.random() * pool.length);
    const j = (i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length; // 另一句、不重複
    pushSocialLog(host, `🐾 ${owner ? "" : "樓貓"}「${pet.name}」的觀察筆記:${pool[i]}${pool[j]}`, "notable");
  }
}

/** 串門子:貓溜進別的房客房裡(對方在家才成立;owner=null 代表樓貓,文案改口、不動關係) */
function rollVisit(catId: string, pet: Pet, owner: TenantRuntime | null) {
  const home = owner ? roomOfTenant(pet.ownerId) : "lounge";
  if (pet.hangout === home || pet.hangout === "lounge") return;
  const victim = residentOf(pet.hangout);
  if (!victim || victim.tenant.id === pet.ownerId || victim.tenant.visualState === "away") return;
  if (Math.random() > 0.5) return;
  const cdKey = `pet|${catId}|visit|${victim.tenant.id}`;
  if (onCooldown(cdKey, CD.visit)) return;
  markCooldown(cdKey);

  const catLabel = owner ? `${owner.tenant.name} 的貓「${pet.name}」` : `樓貓「${pet.name}」`;
  const s = victim.tenant.stats;
  const att = catAttitude(victim.tenant);
  if (att === "dislike") {
    s.stress = clamp(s.stress + 6, 0, 100);
    pushSocialLog(victim, `🐈 ${catLabel}突然竄進房裡,嚇了他一大跳——趕緊把牠請了出去。`, "notable");
    if (owner) {
      pushSocialLog(owner, `🐈 「${pet.name}」又溜進 ${victim.tenant.name} 的房間闖禍,被抱著送回來,對方臉色不太好看。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, -3);
    }
    fxAt(pet.hangout, "anger");
  } else if (att === "like") {
    s.mood = clamp(s.mood + 6, 0, 100);
    s.stress = clamp(s.stress - 4, 0, 100);
    pushSocialLog(victim, `🐈 ${catLabel}溜進房裡蹭他的腳邊,忍不住揉了牠好一陣子,整個人都被療癒了。`, "notable");
    if (owner) {
      pushSocialLog(owner, `🐈 「${pet.name}」跑去 ${victim.tenant.name} 那裡串門子,被寵得不想回來。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, 3);
    }
    fxAt(pet.hangout, "hearts");
  } else {
    s.mood = clamp(s.mood + 2, 0, 100);
    pushSocialLog(victim, `🐈 門沒關好,${catLabel}晃了進來,巡視一圈又晃了出去。`, "minor");
  }
}

/** 搗蛋:打破東西 / 隨地大小便(在貓當下待的區域結算)。
 *  貓咪家具(飼主房)會壓低對應機率:貓跳台 → 有地方磨爪攀爬、少破壞;貓砂盆 → 幾乎不隨地大小便。
 *  owner=null 代表樓貓:苦主日誌照留,飼主端改成房東通知、不動關係。 */
function rollMischief(catId: string, pet: Pet, owner: TenantRuntime | null) {
  const here = pet.hangout;
  const victim = here === "lounge" ? null : residentOf(here);
  const place = here === "lounge" ? "交誼廳" : victim && victim.tenant.id !== pet.ownerId ? `${victim.tenant.name} 的房間` : "房間";
  const relief = mischiefRelief(pet);
  const breakChance = 0.03 * relief.break; // 貓跳台:破壞降到三成
  const poopChance = 0.03 * relief.poop; // 貓砂盆:隨地大小便降到 15%

  // 打破東西:碎裂聲 + 清潔度掉、在場的人壓力上升
  if (Math.random() < breakChance && !onCooldown(`pet|${catId}|break`, CD.break)) {
    markCooldown(`pet|${catId}|break`);
    unlock("cat_burglar"); // 成就:貓生大鬧(§G-7)
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 8, 0, 100);
    if (owner) pushSocialLog(owner, `🐈💥 「${pet.name}」在${place}把東西掃下桌,摔得粉碎……只好默默去收拾殘局。`, "notable");
    else notify(`🐈💥 樓貓「${pet.name}」在${place}把東西掃下桌,摔得粉碎`);
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 5, 0, 100);
      pushSocialLog(victim, owner
        ? `💥 「${pet.name}」打破了他房裡的東西,${owner.tenant.name} 一邊道歉一邊收拾。`
        : `💥 樓貓「${pet.name}」打破了他房裡的東西,只好一邊嘆氣一邊收拾。`, "notable");
      if (owner) adjustRelationship(pet.ownerId, victim.tenant.id, -2);
    }
    fxAt(here, "anger");
    return; // 一小時最多鬧一件事
  }

  // 隨地大小便:清潔度大掉,苦主壓力上升
  if (Math.random() < poopChance && !onCooldown(`pet|${catId}|poop`, CD.poop)) {
    markCooldown(`pet|${catId}|poop`);
    unlock("cat_burglar"); // 成就:貓生大鬧(§G-7)
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 10, 0, 100);
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 4, 0, 100);
      pushSocialLog(victim, `🐈💩 在${place}角落發現了「${pet.name}」留下的不可言說的『驚喜』……氣到說不出話。`, "notable");
      if (owner) {
        pushSocialLog(owner, `🐈💩 「${pet.name}」在 ${victim.tenant.name} 那裡隨地大小便,只好提著清潔用品登門謝罪。`, "notable");
        adjustRelationship(pet.ownerId, victim.tenant.id, -2);
      }
    } else if (owner) {
      pushSocialLog(owner, `🐈💩 「${pet.name}」沒用貓砂盆,在${place}留下了『驚喜』,捏著鼻子清了半天。`, "minor");
    } else {
      notify(`🐈💩 樓貓「${pet.name}」在${place}留下了『驚喜』,只好自己捏著鼻子清乾淨`);
    }
  }
}
