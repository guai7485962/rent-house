/**
 * 寵物系統:租客養的貓或狗會在樓層遊走,並引發寵物事件。
 *
 * 模擬層(無頭可測):每遊戲小時 petsPass() 決定寵物這小時待哪個區域(hangout),
 * 並擲骰串門、搗蛋與同區域寵物互動。渲染層(floor/petAgents)負責讓貓狗走去
 * hangout 遊蕩，並同步追逐、追球、靠近、共眠或退避。
 *
 * 取得途徑:種子(陳家豪的橘貓「橘子」,他的作息本來就有逗貓時段)、
 * AI/規則事件的 adopt_cat 行為指令，以及自帶貓狗入住的應徵者。
 *
 * 樓貓(圓夢畢業批):飼主圓夢離開時可把貓「留下成樓貓」——pet.ownerId 改為
 * 哨兵值 "landlord"(Pet.ownerId 型別是 string,合法;不新增欄位、舊存檔零遷移)。
 * 樓貓沒有飼主 runtime:遊蕩錨點改為交誼廳,串門/搗蛋/貓週記照常(文案改「樓貓」)。
 * state.pets 的 key 維持原飼主 id(唯一,不會撞 key);貓的識別一律用 record key(catId)。
 */
import type { Pet, PetKind, PetPairAction } from "../types";
import { state, clamp, pushSocialLog, notify, roomOfTenant, type TenantRuntime } from "./gameState";
import { adjustRelationship } from "./social";
import { unlock } from "./legacy";
import { getPlacements } from "./placements";
import { roomRect } from "./placements";
import { spawnFx } from "../floor/fx";

/** 領養時的隨機貓名池(種子貓固定叫「橘子」) */
const CAT_NAMES = ["麻糬", "煤球", "湯圓", "布丁", "芝麻", "奶茶", "花捲", "豆花"];
const DOG_NAMES = ["旺財", "豆豆", "可樂", "阿福", "饅頭", "奶油", "小虎", "球球"];

export interface PetPreset {
  name: string;
  color: number;
  /** 舊 applicant pool 沒有此欄位時一律視為貓。 */
  kind?: PetKind;
}

export const petIcon = (petOrKind: Pet | PetKind) =>
  (typeof petOrKind === "string" ? petOrKind : petOrKind.kind) === "dog" ? "🐕" : "🐈";
export const petSpecies = (petOrKind: Pet | PetKind) =>
  (typeof petOrKind === "string" ? petOrKind : petOrKind.kind) === "dog" ? "狗" : "貓";
const housePetLabel = (pet: Pet) => pet.kind === "dog" ? "公寓犬" : "樓貓";

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
export const HOUSE_PET_OWNER = "landlord";
/** 舊測試與存檔語意相容。 */
export const HOUSE_CAT_OWNER = HOUSE_PET_OWNER;
const isHousePet = (pet: Pet) => pet.ownerId === HOUSE_PET_OWNER;

/** 孤兒貓修復:飼主已不在 runtime 的貓一律轉為樓貓(補一則通知;冪等)。
 *  正常流程 moveOut 會刪貓或事先轉樓貓,這裡是舊存檔載入與防禦性的安全網。 */
export function repairOrphanPets() {
  for (const pet of Object.values(state.pets)) {
    if (isHousePet(pet) || state.runtimes[pet.ownerId]) continue;
    pet.ownerId = HOUSE_PET_OWNER;
    pet.hangout = "lounge";
    notify(`${petIcon(pet)} 「${pet.name}」的主人已經搬走,公寓接手照顧,牠成了${housePetLabel(pet)}`);
  }
}

/** 向後相容名稱。 */
export const repairOrphanCats = repairOrphanPets;

/** 種子寵物補登:陳家豪的作息本來就有「逗貓」時段——把那隻貓變成真的。
 *  也順手做孤兒貓修復(persistence 載入時呼叫本函式)。 */
export function ensurePets() {
  // 舊存檔沒有 kind；在所有 resolver 前一次正規化，避免舊貓被配對系統漏掉。
  for (const pet of Object.values(state.pets)) pet.kind ??= "cat";
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
  repairOrphanPets();
}

/** 圓夢畢業「貓的去留」抉擇的套用(tenancy.decide 呼叫):
 *  stay → 立即轉樓貓(ownerId="landlord",錨點交誼廳);take → 只留日誌,離開日隨 moveOut 帶走。 */
export function resolvePetFarewell(rt: TenantRuntime, choiceId: string) {
  const pet = state.pets[rt.tenant.id];
  if (!pet || pet.ownerId !== rt.tenant.id) return;
  const icon = petIcon(pet);
  if (choiceId === "stay") {
    pet.ownerId = HOUSE_PET_OWNER;
    pet.hangout = "lounge";
    pushSocialLog(rt, `${icon} 他把「${pet.name}」托付給了公寓:「牠在這裡比跟著我奔波幸福。」`, "major");
    notify(`${icon} 「${pet.name}」留了下來,成為公寓的${housePetLabel(pet)}`);
  } else {
    const carrier = pet.kind === "dog" ? "牽繩和外出水壺" : "貓籠";
    pushSocialLog(rt, `${icon} 決定帶「${pet.name}」一起走,連${carrier}都提前準備好了。`, "notable");
  }
}

/** 向後相容名稱。 */
export const resolveCatFarewell = resolvePetFarewell;

/** 領養一隻貓(adopt_cat 指令生效 / 帶寵物入住時呼叫;已有貓則不重複)。
 *  preset:指定名字/花色(應徵者自帶的貓);省略則隨機。回傳新貓或 null。 */
export function adoptPet(tenantId: string, preset?: PetPreset): Pet | null {
  if (state.pets[tenantId]) return null;
  const rt = state.runtimes[tenantId];
  if (!rt) return null;
  const kind = preset?.kind ?? "cat";
  const names = kind === "dog" ? DOG_NAMES : CAT_NAMES;
  const pet: Pet = {
    name: preset?.name ?? names[Math.floor(Math.random() * names.length)],
    kind,
    color: preset?.color ?? Math.floor(Math.random() * 4),
    ownerId: tenantId,
    hangout: roomOfTenant(tenantId) ?? "lounge",
    sinceMs: state.gameMs,
  };
  state.pets[tenantId] = pet;
  notify(`${petIcon(pet)} ${rt.tenant.name} 養了一隻${petSpecies(pet)}「${pet.name}」`);
  return pet;
}

export function adoptCat(tenantId: string, preset?: Omit<PetPreset, "kind">): Pet | null {
  return adoptPet(tenantId, preset ? { ...preset, kind: "cat" } : randomCatPreset());
}

/** 隨機挑一組貓名/花色(給應徵者自帶的貓;花色 1~3,橘色是種子專屬) */
export function randomCatPreset(): PetPreset {
  return { name: CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)], color: 1 + Math.floor(Math.random() * 3), kind: "cat" };
}

export function randomDogPreset(): PetPreset {
  return { name: DOG_NAMES[Math.floor(Math.random() * DOG_NAMES.length)], color: Math.floor(Math.random() * 4), kind: "dog" };
}

export function randomPetPreset(): PetPreset {
  return Math.random() < 0.65 ? randomCatPreset() : randomDogPreset();
}

/** 飼主房間是否擺了某件貓咪家具(貓砂盆/貓跳台 → 降低對應搗蛋機率;樓貓無飼主房 → 無減免) */
function ownerRoomHas(pet: Pet, defId: string): boolean {
  const room = roomOfTenant(pet.ownerId);
  return !!room && getPlacements().some((p) => p.room === room && p.defId === defId);
}

/** 物種專屬家具對搗蛋機率的乘數；只計入飼主房內且不跨物種套用。 */
export function mischiefRelief(pet: Pet): { break: number; poop: number } {
  if (pet.kind === "dog") {
    return {
      break: ownerRoomHas(pet, "chew_toy") ? 0.25 : 1,
      poop: ownerRoomHas(pet, "pee_pad") ? 0.15 : 1,
    };
  }
  return {
    break: ownerRoomHas(pet, "cat_tower") ? 0.3 : 1,
    poop: ownerRoomHas(pet, "litter_box") ? 0.15 : 1,
  };
}

/** 對貓的態度:標籤/職業裡有貓狗動物 → 喜歡;潔癖/過敏/怕貓 → 排斥;其餘中立。
 *  接受結構子集(租客或應徵者都適用;memoryTags 可省略) */
export function petAttitude(t: {
  coreTags: { label: string }[];
  memoryTags?: { label: string }[];
  occupation: string;
  bio: string;
}, kind: PetKind): "like" | "dislike" | "neutral" {
  const text = [...t.coreTags.map((x) => x.label), ...(t.memoryTags ?? []).map((x) => x.label), t.occupation, t.bio].join(" ");
  const dislikes = kind === "dog" ? /怕狗|狗毛過敏|過敏|潔癖|討厭動物/ : /怕貓|貓毛過敏|過敏|潔癖|討厭動物/;
  const likes = kind === "dog" ? /狗|動物|寵物|療癒/ : /貓|動物|寵物|療癒/;
  if (dislikes.test(text)) return "dislike";
  if (likes.test(text)) return "like";
  return "neutral";
}

export const catAttitude = (t: Parameters<typeof petAttitude>[0]) => petAttitude(t, "cat");

/** 住在某房的租客(承租者優先,否則同居者);沒有回 null */
function residentOf(roomId: string): TenantRuntime | null {
  const tid = state.occupancy[roomId] ?? Object.entries(state.cohabits).find(([, r]) => r === roomId)?.[0];
  return tid ? state.runtimes[tid] ?? null : null;
}

/** 這小時寵物要待的區域。狗比貓更常待在交誼廳,讓兩種動物的生活感不同。 */
function pickHangout(pet: Pet): string {
  const home = roomOfTenant(pet.ownerId) ?? "lounge";
  const roll = Math.random();
  const homeCut = pet.kind === "dog" ? 0.45 : 0.55;
  const loungeCut = pet.kind === "dog" ? 0.80 : 0.75;
  if (roll < homeCut) return home;
  if (roll < loungeCut) return "lounge";
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
  repairOrphanPets();
  for (const [petId, pet] of Object.entries(state.pets)) {
    const owner = isHousePet(pet) ? null : state.runtimes[pet.ownerId] ?? null;
    pet.hangout = pickHangout(pet);
    rollVisit(petId, pet, owner);
    rollMischief(petId, pet, owner);
  }
  // 每個遊戲小時最多開一場寵物互動；同物種優先，未觸發才嘗試貓狗相遇。
  if (resolveCatPairs()) return;
  if (resolveDogPairs()) return;
  resolveCrossSpeciesPairs();
}

type CatPairAction = Extract<PetPairAction, "chase" | "groom" | "nap" | "territory" | "mischief">;
type DogPairAction = Extract<PetPairAction, "fetch" | "sniff" | "nap">;
type CrossPairAction = Extract<PetPairAction, "greet" | "avoid">;
const CAT_PAIR_ACTIONS: CatPairAction[] = ["chase", "groom", "nap", "territory", "mischief"];
const DOG_PAIR_ACTIONS: DogPairAction[] = ["fetch", "sniff", "nap"];
const CROSS_PAIR_ACTIONS: CrossPairAction[] = ["greet", "avoid"];

function clearExpiredPetPairs() {
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
  clearExpiredPetPairs();
  const entries = Object.entries(state.pets).filter(([, pet]) => pet.kind === "cat" && (isHousePet(pet) || !!state.runtimes[pet.ownerId]));
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
  const A = isHousePet(a) ? null : state.runtimes[a.ownerId] ?? null;
  const B = isHousePet(b) ? null : state.runtimes[b.ownerId] ?? null;
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

/** 同區域的兩隻狗會追球、互聞或靠著午睡；force 僅供測試與美術預覽。 */
export function resolveDogPairs(random: () => number = Math.random, force = false): DogPairAction | null {
  clearExpiredPetPairs();
  const entries = Object.entries(state.pets).filter(([, pet]) => pet.kind === "dog" && (isHousePet(pet) || !!state.runtimes[pet.ownerId]));
  let arrangedKey = "";
  const alreadyTogether = entries.some(([, a], i) => entries.some(([, b], j) => j > i && a.hangout === b.hangout));
  if (!force && !alreadyTogether && entries.length >= 2 && random() < 0.16) {
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
      const key = `dogpair|${ids[0]}|${ids[1]}`;
      if (onCooldown(key, CD.pair)) continue;
      if (!force && arrangedKey !== ids.join("|") && random() > 0.3) continue;
      const action = DOG_PAIR_ACTIONS[Math.min(DOG_PAIR_ACTIONS.length - 1, Math.floor(random() * DOG_PAIR_ACTIONS.length))];
      startPetPair(aId, a, bId, b, action, key);
      applyDogPairEvent(a, b, action);
      return action;
    }
  }
  return null;
}

/** 同區域的一貓一狗會友善打招呼或互相保持距離。 */
export function resolveCrossSpeciesPairs(random: () => number = Math.random, force = false): CrossPairAction | null {
  clearExpiredPetPairs();
  const cats = Object.entries(state.pets).filter(([, pet]) => pet.kind === "cat" && (isHousePet(pet) || !!state.runtimes[pet.ownerId]));
  const dogs = Object.entries(state.pets).filter(([, pet]) => pet.kind === "dog" && (isHousePet(pet) || !!state.runtimes[pet.ownerId]));
  let arrangedKey = "";
  const alreadyTogether = cats.some(([, cat]) => dogs.some(([, dog]) => cat.hangout === dog.hangout));
  if (!force && !alreadyTogether && cats.length > 0 && dogs.length > 0 && random() < 0.1) {
    const cat = cats[Math.floor(random() * cats.length)];
    const dog = dogs[Math.floor(random() * dogs.length)];
    dog[1].hangout = cat[1].hangout;
    arrangedKey = [cat[0], dog[0]].sort().join("|");
  }
  for (const [catId, cat] of cats) {
    for (const [dogId, dog] of dogs) {
      if (cat.hangout !== dog.hangout || cat.pairWith || dog.pairWith) continue;
      const ids = [catId, dogId].sort();
      const key = `crosspet|${ids[0]}|${ids[1]}`;
      if (onCooldown(key, CD.pair)) continue;
      if (!force && arrangedKey !== ids.join("|") && random() > 0.22) continue;
      const action = CROSS_PAIR_ACTIONS[Math.min(CROSS_PAIR_ACTIONS.length - 1, Math.floor(random() * CROSS_PAIR_ACTIONS.length))];
      startPetPair(catId, cat, dogId, dog, action, key);
      applyCrossPairEvent(cat, dog, action);
      return action;
    }
  }
  return null;
}

function startPetPair(aId: string, a: Pet, bId: string, b: Pet, action: PetPairAction, cooldownKey: string) {
  a.pairWith = bId;
  b.pairWith = aId;
  a.pairAction = b.pairAction = action;
  a.pairUntilMs = b.pairUntilMs = state.gameMs + 2 * 3600 * 1000;
  markCooldown(cooldownKey);
}

function pairOwners(a: Pet, b: Pet): TenantRuntime[] {
  const runtimes = [a, b]
    .map((pet) => isHousePet(pet) ? null : state.runtimes[pet.ownerId] ?? null)
    .filter((rt): rt is TenantRuntime => !!rt);
  return [...new Map(runtimes.map((rt) => [rt.tenant.id, rt])).values()];
}

function logPetPair(a: Pet, b: Pet, prefix: string, text: string) {
  const owners = pairOwners(a, b);
  for (const rt of owners) pushSocialLog(rt, `🐾 ${prefix}:${text}`, "notable");
  if (owners.length === 0) notify(`🐾 ${text}`);
}

function applyDogPairEvent(a: Pet, b: Pet, action: DogPairAction) {
  const owners = pairOwners(a, b);
  const place = a.hangout === "lounge" ? "交誼廳" : "房間裡";
  if (action === "fetch") {
    for (const rt of owners) rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 3, 0, 100);
    logPetPair(a, b, "雙狗互動", `${a.name} 和 ${b.name} 在${place}輪流追球,叼回來後又搶著先出發。`);
    fxAt(a.hangout, "chat");
  } else if (action === "sniff") {
    for (const rt of owners) rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 2, 0, 100);
    logPetPair(a, b, "雙狗互動", `${a.name} 和 ${b.name} 小心靠近互聞,很快就搖著尾巴一起巡樓。`);
    if (a.ownerId !== b.ownerId && !isHousePet(a) && !isHousePet(b)) adjustRelationship(a.ownerId, b.ownerId, 1);
    fxAt(a.hangout, "hearts");
  } else {
    for (const rt of owners) rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 4, 0, 100);
    logPetPair(a, b, "雙狗互動", `${a.name} 和 ${b.name} 在${place}背靠著背睡著,尾巴偶爾一起拍地板。`);
    fxAt(a.hangout, "chat");
  }
}

function applyCrossPairEvent(cat: Pet, dog: Pet, action: CrossPairAction) {
  const owners = pairOwners(cat, dog);
  if (action === "greet") {
    for (const rt of owners) {
      rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 2, 0, 100);
      rt.tenant.stats.stress = clamp(rt.tenant.stats.stress - 2, 0, 100);
    }
    logPetPair(cat, dog, "貓狗相遇", `${dog.name} 伏低身子慢慢靠近,${cat.name} 聞了聞牠的鼻尖,最後和平地並肩坐下。`);
    if (cat.ownerId !== dog.ownerId && !isHousePet(cat) && !isHousePet(dog)) adjustRelationship(cat.ownerId, dog.ownerId, 1);
    fxAt(cat.hangout, "hearts");
  } else {
    for (const rt of owners) rt.tenant.stats.stress = clamp(rt.tenant.stats.stress + 1, 0, 100);
    logPetPair(cat, dog, "貓狗相遇", `${cat.name} 豎起尾巴退到高處,${dog.name} 也停下腳步轉開視線,彼此保留安全距離。`);
    if (cat.ownerId !== dog.ownerId && !isHousePet(cat) && !isHousePet(dog)) adjustRelationship(cat.ownerId, dog.ownerId, -1);
    fxAt(cat.hangout, "chat");
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

function dogJournalLines(petName: string, ownerName: string, neighbor: string): string[] {
  return [
    `這週我記住了整層樓每一道腳步聲,只要有人回來我都第一個知道。`,
    `${neighbor} 經過門口時摸了摸我的頭,我決定下次也把球叼給他。`,
    `${ownerName} 說散步要等一下,我把牽繩叼來三次,「等一下」還是沒有結束。`,
    `交誼廳的沙發底下藏著半塊餅乾,這是本週最重要的調查成果。`,
    `今天成功忍住沒有對門外的聲音叫,應該值得兩塊零食。`,
    `午睡夢到在走廊追球,醒來時尾巴還在拍地板。`,
    `${ownerName} 心情不好時抱了我很久,我沒有亂動,因為這也是工作。`,
    `巡完每一扇門後回到自己的墊子,確認大家都平安在家。`,
  ];
}

/** 每遊戲日呼叫(自帶 7 日冷卻):輪到的貓發一篇觀察筆記進 Feed。
 *  樓貓沒有飼主 → 筆記掛在任一位在住租客的日誌上(Feed 彙整全樓日誌,玩家都看得到)。 */
export function catJournalPass() {
  for (const [petId, pet] of Object.entries(state.pets)) {
    const owner = isHousePet(pet) ? null : state.runtimes[pet.ownerId];
    const host = owner ?? Object.values(state.runtimes)[0]; // 樓貓筆記的落點
    if (!host || (!owner && !isHousePet(pet))) continue;
    const ck = `pet|${petId}|journal`;
    if (onCooldown(ck, JOURNAL_CD)) continue;
    markCooldown(ck);
    const ownerName = owner ? owner.tenant.name : "房東";
    const pool = (pet.kind === "dog" ? dogJournalLines : catJournalLines)(pet.name, ownerName, randomNeighborName(pet.ownerId));
    const i = Math.floor(Math.random() * pool.length);
    const j = (i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length; // 另一句、不重複
    pushSocialLog(host, `🐾 ${owner ? "" : housePetLabel(pet)}「${pet.name}」的觀察筆記:${pool[i]}${pool[j]}`, "notable");
  }
}

/** 串門子:貓溜進別的房客房裡(對方在家才成立;owner=null 代表樓貓,文案改口、不動關係) */
function rollVisit(petId: string, pet: Pet, owner: TenantRuntime | null) {
  const home = owner ? roomOfTenant(pet.ownerId) : "lounge";
  if (pet.hangout === home || pet.hangout === "lounge") return;
  const victim = residentOf(pet.hangout);
  if (!victim || victim.tenant.id === pet.ownerId || victim.tenant.visualState === "away") return;
  if (Math.random() > 0.5) return;
  const cdKey = `pet|${petId}|visit|${victim.tenant.id}`;
  if (onCooldown(cdKey, CD.visit)) return;
  markCooldown(cdKey);

  const icon = petIcon(pet);
  const label = owner ? `${owner.tenant.name} 的${petSpecies(pet)}「${pet.name}」` : `${housePetLabel(pet)}「${pet.name}」`;
  const s = victim.tenant.stats;
  const att = petAttitude(victim.tenant, pet.kind);
  if (att === "dislike") {
    s.stress = clamp(s.stress + 6, 0, 100);
    const action = pet.kind === "dog" ? "搖著尾巴衝進" : "突然竄進";
    pushSocialLog(victim, `${icon} ${label}${action}房裡,嚇了他一大跳——趕緊把牠請了出去。`, "notable");
    if (owner) {
      pushSocialLog(owner, `${icon} 「${pet.name}」又溜進 ${victim.tenant.name} 的房間闖禍,被送回來時對方臉色不太好看。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, -3);
    }
    fxAt(pet.hangout, "anger");
  } else if (att === "like") {
    s.mood = clamp(s.mood + 6, 0, 100);
    s.stress = clamp(s.stress - 4, 0, 100);
    const greeting = pet.kind === "dog" ? "叼著球來找他,尾巴搖得停不下來" : "溜進房裡蹭他的腳邊";
    pushSocialLog(victim, `${icon} ${label}${greeting},忍不住陪牠玩了好一陣子,整個人都被療癒了。`, "notable");
    if (owner) {
      pushSocialLog(owner, `${icon} 「${pet.name}」跑去 ${victim.tenant.name} 那裡串門子,被寵得不想回來。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, 3);
    }
    fxAt(pet.hangout, "hearts");
  } else {
    s.mood = clamp(s.mood + 2, 0, 100);
    pushSocialLog(victim, `${icon} 門沒關好,${label}晃了進來,巡視一圈又晃了出去。`, "minor");
  }
}

/** 搗蛋:打破東西 / 隨地大小便(在貓當下待的區域結算)。
 *  貓咪家具(飼主房)會壓低對應機率:貓跳台 → 有地方磨爪攀爬、少破壞;貓砂盆 → 幾乎不隨地大小便。
 *  owner=null 代表樓貓:苦主日誌照留,飼主端改成房東通知、不動關係。 */
function rollMischief(petId: string, pet: Pet, owner: TenantRuntime | null) {
  const here = pet.hangout;
  const victim = here === "lounge" ? null : residentOf(here);
  const place = here === "lounge" ? "交誼廳" : victim && victim.tenant.id !== pet.ownerId ? `${victim.tenant.name} 的房間` : "房間";
  const relief = mischiefRelief(pet);
  const breakChance = 0.03 * relief.break; // 貓跳台:破壞降到三成
  const poopChance = 0.03 * relief.poop; // 貓砂盆:隨地大小便降到 15%

  // 打破東西:碎裂聲 + 清潔度掉、在場的人壓力上升
  const icon = petIcon(pet);
  if (Math.random() < breakChance && !onCooldown(`pet|${petId}|break`, CD.break)) {
    markCooldown(`pet|${petId}|break`);
    if (pet.kind === "cat") unlock("cat_burglar");
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 8, 0, 100);
    const damage = pet.kind === "dog" ? "把靠墊咬開,棉花散了一地" : "把東西掃下桌,摔得粉碎";
    if (owner) pushSocialLog(owner, `${icon}💥 「${pet.name}」在${place}${damage}……只好默默去收拾殘局。`, "notable");
    else notify(`${icon}💥 ${housePetLabel(pet)}「${pet.name}」在${place}${damage}`);
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 5, 0, 100);
      pushSocialLog(victim, owner
        ? `💥 「${pet.name}」打破了他房裡的東西,${owner.tenant.name} 一邊道歉一邊收拾。`
        : `💥 ${housePetLabel(pet)}「${pet.name}」弄壞了他房裡的東西,只好一邊嘆氣一邊收拾。`, "notable");
      if (owner) adjustRelationship(pet.ownerId, victim.tenant.id, -2);
    }
    fxAt(here, "anger");
    return; // 一小時最多鬧一件事
  }

  // 隨地大小便:清潔度大掉,苦主壓力上升
  if (Math.random() < poopChance && !onCooldown(`pet|${petId}|poop`, CD.poop)) {
    markCooldown(`pet|${petId}|poop`);
    if (pet.kind === "cat") unlock("cat_burglar");
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 10, 0, 100);
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 4, 0, 100);
      pushSocialLog(victim, `${icon}💩 在${place}角落發現了「${pet.name}」留下的不可言說的『驚喜』……氣到說不出話。`, "notable");
      if (owner) {
        pushSocialLog(owner, `${icon}💩 「${pet.name}」在 ${victim.tenant.name} 那裡隨地大小便,只好提著清潔用品登門謝罪。`, "notable");
        adjustRelationship(pet.ownerId, victim.tenant.id, -2);
      }
    } else if (owner) {
      const missed = pet.kind === "dog" ? "沒忍到外出時間" : "沒用貓砂盆";
      pushSocialLog(owner, `${icon}💩 「${pet.name}」${missed},在${place}留下了『驚喜』,捏著鼻子清了半天。`, "minor");
    } else {
      notify(`${icon}💩 ${housePetLabel(pet)}「${pet.name}」在${place}留下了『驚喜』,只好自己捏著鼻子清乾淨`);
    }
  }
}
