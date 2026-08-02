/**
 * 招租系統:依房間屬性產生「應徵租客」,並算出契合度。
 * 房東裝潢空房 → 屬性上升 → 吸引偏好相符的租客 → 選一位入住(store.moveIn)。
 */
import type { Appearance, CafeGuest, CoreTag, Gender, PetKind, RoomAttribute } from "../types";
import { roomAttributes } from "./placements";
import { upgradeRentBonus } from "./upgrades";
import { reputationStarBonus, reputationRentBonus } from "./reputation";
import { randomAppearance } from "../pixel/parts";
import { randomPetPreset } from "./pets";
import { cafeGuestGender, cafeGuestHash } from "./cafeGuests";
import { state, gameDayIndex, isVacant, ROOM_APPEARANCE } from "./gameState";
import { save } from "./persistence";

interface Archetype {
  key: string; // 對應 ARCHETYPE_ROUTINES 的作息
  occupation: string;
  bio: string;
  coreTags: CoreTag[];
  preferences: Partial<Record<RoomAttribute, number>>;
  monthlyRent: number;
}

export const ARCHETYPES: Archetype[] = [
  {
    key: "office",
    occupation: "上班族",
    bio: "朝九晚五的上班族,重視居家的療癒與收納,週末喜歡待在家追劇。",
    coreTags: [
      { id: "punctual", label: "[準時交租]", behaviorHint: "帳單從不拖欠,作息規律。" },
      { id: "early_bird", label: "[早睡早起]", behaviorHint: "晚上十一點前就寢,清晨起床。" },
    ],
    preferences: { cozy: 7, storage: 5, style: 3 },
    monthlyRent: 15000,
  },
  {
    key: "student",
    occupation: "電競系學生",
    bio: "日夜顛倒的電競系學生,房間就是他的戰場,對電腦設備很講究。",
    coreTags: [
      { id: "night_owl", label: "[夜貓子]", behaviorHint: "凌晨活躍,白天補眠。" },
      { id: "gamer", label: "[電競魂]", behaviorHint: "醒著多半在打電動,情緒隨勝負起伏。" },
    ],
    preferences: { tech: 8, cozy: 3, noise: 2 },
    monthlyRent: 11000,
  },
  {
    key: "freelancer",
    occupation: "自由接案設計師",
    bio: "在家工作的設計師,需要安靜與有品味的環境,對細節龜毛。",
    coreTags: [
      { id: "wfh", label: "[在家工作]", behaviorHint: "整天待在房間工作,很少外出。" },
      { id: "perfectionist", label: "[完美主義]", behaviorHint: "對環境挑剔,房間維持得很整齊。" },
    ],
    preferences: { tech: 5, soundproof: 4, style: 6 },
    monthlyRent: 16000,
  },
  {
    key: "student",
    occupation: "樂團鼓手",
    bio: "地下樂團的鼓手,越吵越自在,常常半夜才回家。",
    coreTags: [
      { id: "noisy", label: "[製造噪音]", behaviorHint: "喜歡熱鬧,常放音樂、敲敲打打。" },
      { id: "late_return", label: "[夜歸]", behaviorHint: "深夜才回家,作息與人相反。" },
    ],
    preferences: { noise: 8, style: 4 },
    monthlyRent: 13000,
  },
  {
    key: "night_shift",
    occupation: "夜班護理師",
    bio: "醫院夜班的護理師,日夜輪替,最需要一個白天安靜好睡的房間。",
    coreTags: [
      { id: "late_return", label: "[日夜輪班]", behaviorHint: "晚上出門上班,清晨回家補眠。" },
      { id: "caring", label: "[溫柔照護]", behaviorHint: "習慣照顧別人,鄰居生病第一個發現。" },
    ],
    preferences: { soundproof: 7, cozy: 5 },
    monthlyRent: 14000,
  },
  {
    key: "night_shift",
    occupation: "大樓保全",
    bio: "夜班保全,話不多但可靠,整棟樓最早發現異狀的人。",
    coreTags: [
      { id: "late_return", label: "[夜班駐守]", behaviorHint: "夜裡上班,白天沉睡。" },
      { id: "punctual", label: "[一絲不苟]", behaviorHint: "交租、巡邏、作息都分秒不差。" },
    ],
    preferences: { soundproof: 6, storage: 3 },
    monthlyRent: 10000,
  },
  {
    key: "night_shift",
    occupation: "調酒師",
    bio: "酒吧的調酒師,聽過上千個客人的心事,深夜才回家。",
    coreTags: [
      { id: "late_return", label: "[深夜歸人]", behaviorHint: "凌晨帶著酒氣與故事回家。" },
      { id: "caring", label: "[善於傾聽]", behaviorHint: "誰有煩惱都想找他聊。" },
    ],
    preferences: { style: 6, cozy: 4 },
    monthlyRent: 13000,
  },
  {
    key: "early_riser",
    occupation: "甜點師",
    bio: "凌晨四點就出門備料的甜點師,回家時常帶著沒賣完的蛋糕。",
    coreTags: [
      { id: "early_bird", label: "[凌晨備料]", behaviorHint: "天沒亮就出門,晚上九點前睡死。" },
      { id: "foodie", label: "[烘焙香氣]", behaviorHint: "房間總是飄著奶油香,偶爾分鄰居甜點。" },
    ],
    preferences: { storage: 6, cozy: 5 },
    monthlyRent: 12000,
  },
  {
    key: "early_riser",
    occupation: "咖啡師",
    bio: "自家烘豆的咖啡師,對睡眠品質和豆子一樣講究。",
    coreTags: [
      { id: "early_bird", label: "[清晨開店]", behaviorHint: "五點半出門開店,作息如鐘錶。" },
      { id: "punctual", label: "[守時成癮]", behaviorHint: "遲到會焦慮,交租永遠提前。" },
    ],
    preferences: { style: 5, cozy: 4 },
    monthlyRent: 11000,
  },
  {
    key: "early_riser",
    occupation: "健身教練",
    bio: "清晨帶課的健身教練,把自律當信仰,冰箱塞滿雞胸肉。",
    coreTags: [
      { id: "early_bird", label: "[晨型人]", behaviorHint: "五點起床,晨跑後才出門帶課。" },
      { id: "fitness", label: "[健身狂]", behaviorHint: "在家也要拉彈力帶,體態極好。" },
    ],
    preferences: { cozy: 3, storage: 5, noise: 3 },
    monthlyRent: 13000,
  },
  {
    key: "homebody",
    occupation: "退休教師",
    bio: "剛退休的國文老師,白天在家泡茶讀書,對整棟樓的動靜瞭若指掌。",
    coreTags: [
      { id: "early_bird", label: "[早睡早起]", behaviorHint: "晚上十點就寢,清晨聽廣播。" },
      { id: "busybody", label: "[愛管閒事]", behaviorHint: "鄰居的大小事都想關心一下。" },
    ],
    preferences: { cozy: 7, storage: 4 },
    monthlyRent: 12000,
  },
  {
    key: "homebody",
    occupation: "瑜伽老師",
    bio: "在家開線上課的瑜伽老師,生活極簡,講究安靜與氣味。",
    coreTags: [
      { id: "sound_sensitive", label: "[靜謐主義]", behaviorHint: "對噪音極敏感,house 要靜。" },
      { id: "fitness", label: "[身心平衡]", behaviorHint: "清晨冥想、傍晚拉筋,情緒穩定。" },
    ],
    preferences: { cozy: 6, soundproof: 5 },
    monthlyRent: 12000,
  },
  {
    key: "night_creator",
    occupation: "漫畫家",
    bio: "連載中的漫畫家,截稿前一週會人間蒸發,只剩房裡的燈還亮著。",
    coreTags: [
      { id: "night_owl", label: "[截稿地獄]", behaviorHint: "深夜趕稿,月底特別憔悴。" },
      { id: "wfh", label: "[足不出戶]", behaviorHint: "可以一週不出門,外送是生命線。" },
    ],
    preferences: { tech: 5, soundproof: 5 },
    monthlyRent: 12000,
  },
  {
    key: "night_creator",
    occupation: "研究生",
    bio: "寫論文寫到懷疑人生的研究生,咖啡因是血液的一部分。",
    coreTags: [
      { id: "night_owl", label: "[爆肝論文]", behaviorHint: "凌晨三點還在改第七版。" },
      { id: "wfh", label: "[宅居寫作]", behaviorHint: "除了進實驗室,其他時間都窩在房裡。" },
    ],
    preferences: { tech: 4, storage: 4, soundproof: 4 },
    monthlyRent: 9000,
  },
  {
    key: "night_creator",
    occupation: "推理小說家",
    bio: "小有名氣的推理小說家,靈感只在深夜出現,對細節吹毛求疵。",
    coreTags: [
      { id: "night_owl", label: "[靈感夜行]", behaviorHint: "夜深人靜才動筆,白天像貓一樣睡。" },
      { id: "perfectionist", label: "[吹毛求疵]", behaviorHint: "書桌上的東西有固定的角度。" },
    ],
    preferences: { style: 5, soundproof: 6 },
    monthlyRent: 15000,
  },
];

/**
 * 隨機應徵者姓名與性別綁定。舊版將姓名、性別分開亂抽，會出現「邱柏翰」
 * 被存成女性、關係因此顯示成閨密的情況。這份表也供舊存檔載入時校正。
 */
const NAME_IDENTITIES: Array<{ name: string; gender: Gender }> = [
  { name: "王大明", gender: "male" }, { name: "李佳蓉", gender: "female" },
  { name: "張偉", gender: "male" }, { name: "陳思妤", gender: "female" },
  { name: "林俊傑", gender: "male" }, { name: "黃美玲", gender: "female" },
  { name: "吳承恩", gender: "male" }, { name: "周曉涵", gender: "female" },
  { name: "蔡明軒", gender: "male" }, { name: "許雅婷", gender: "female" },
  { name: "鄭浩宇", gender: "male" }, { name: "謝欣妤", gender: "female" },
  { name: "洪偉哲", gender: "male" }, { name: "郭品妍", gender: "female" },
  { name: "曾冠廷", gender: "male" }, { name: "賴思穎", gender: "female" },
  { name: "潘建宏", gender: "male" }, { name: "簡莉雯", gender: "female" },
  { name: "邱柏翰", gender: "male" }, { name: "溫若晴", gender: "female" },
];

export function genderForKnownName(name: string): Gender | undefined {
  return NAME_IDENTITIES.find((entry) => entry.name === name)?.gender;
}

export interface Applicant {
  id: string;
  name: string;
  archetypeKey: string;
  occupation: string;
  bio: string;
  coreTags: CoreTag[];
  preferences: Partial<Record<RoomAttribute, number>>;
  monthlyRent: number;
  /** 原型基礎租金(行情加成前;monthlyRent = baseRent × (1+升級加成)) */
  baseRent?: number;
  stars: number; // 1~5 契合度
  gender: Gender;
  attractedTo: Gender[];
  /** 部件化外觀(§9-1);舊池子裡的應徵者可能沒有 → 入住時再補抽 */
  appearance?: Appearance;
  /** 是否成年(undefined = 是;特邀租客一律經 isAdult 檢查才會生成) */
  isAdult?: boolean;
  /** 自帶寵物(約兩成應徵者有;舊存檔缺 kind 時視為貓) */
  pet?: { name: string; color: number; kind?: PetKind };
  /** CAFE-19:來源咖啡廳顧客 id(同一位顧客只轉一次;一般應徵者沒有這欄) */
  fromCafeGuestId?: string;
  /** CAFE-19:初次好感 = 偏好權重已乘上的倍率(1 或缺值代表沒有加成) */
  cafeFavorMultiplier?: number;
}

/** 應徵者實際開的月租:基礎租金 ×(房間升級行情 + 房東口碑)加成,取整到百位。
 *  口碑加成 = reputation×0.05%(滿口碑 +5%):好房東名聲在外,租客願意多出一點。 */
function offeredRent(base: number, roomId: string): number {
  return Math.round((base * (1 + upgradeRentBonus(roomId) + reputationRentBonus())) / 100) * 100;
}

/** 依已決定的性別隨機生成戀愛取向；性別不再與姓名分開亂抽。 */
function randomIdentity(gender: Gender): { gender: Gender; attractedTo: Gender[] } {
  const opp: Gender = gender === "male" ? "female" : "male";
  const roll = Math.random();
  let attractedTo: Gender[];
  if (gender === "nonbinary") attractedTo = ["male", "female", "nonbinary"];
  else if (roll < 0.6) attractedTo = [opp]; // 異性
  else if (roll < 0.85) attractedTo = ["male", "female"]; // 雙性
  else attractedTo = [gender]; // 同性
  return { gender, attractedTo };
}

/** 契合度:房間屬性 × 偏好權重 + 房東口碑(reputation×0.3,滿口碑約提升一個星等區間) */
function matchStars(prefs: Partial<Record<RoomAttribute, number>>, attrs: Partial<Record<RoomAttribute, number>>): number {
  let raw = reputationStarBonus();
  for (const [k, p] of Object.entries(prefs)) {
    raw += (attrs[k as RoomAttribute] ?? 0) * (p ?? 0);
  }
  if (raw <= 0) return 1;
  if (raw < 25) return 2;
  if (raw < 55) return 3;
  if (raw < 95) return 4;
  return 5;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** 依「當前」房間屬性重算一批應徵者的契合星等與租金行情(裝潢/升級改變後即時反映,不必重抽人) */
export function rescoreApplicants(list: Applicant[], roomId: string): Applicant[] {
  const attrs = roomAttributes(roomId);
  for (const a of list) {
    a.stars = matchStars(a.preferences, attrs);
    a.baseRent = a.baseRent ?? a.monthlyRent; // 舊存檔的池沒有 baseRent → 以現值為底
    a.monthlyRent = offeredRent(a.baseRent, roomId);
  }
  return list;
}

/** 為某空房產生 3 位應徵者(契合度依房間目前屬性);excludeNames = 已在住租客,避免同名 */
export function generateApplicants(roomId: string, excludeNames: string[] = []): Applicant[] {
  const attrs = roomAttributes(roomId);
  const identities = shuffle(NAME_IDENTITIES.filter((entry) => !excludeNames.includes(entry.name)));
  return shuffle(ARCHETYPES)
    .slice(0, Math.min(3, identities.length))
    .map((a, i) => ({
      id: `tenant_${roomId}_${Date.now()}_${i}`,
      name: identities[i].name,
      archetypeKey: a.key,
      occupation: a.occupation,
      bio: a.bio,
      coreTags: a.coreTags,
      preferences: a.preferences,
      monthlyRent: offeredRent(a.monthlyRent, roomId),
      baseRent: a.monthlyRent,
      stars: matchStars(a.preferences, attrs),
      ...randomIdentity(identities[i].gender),
      appearance: randomAppearance(),
      // 總寵物率維持約兩成,只把其中一部分分流成狗,避免無意提高事件密度。
      ...(Math.random() < 0.22 ? { pet: randomPetPreset() } : {}),
    }));
}

/**
 * CAFE-19 初次好感的幅度:偏好權重 ×1.25。
 *
 * 為什麼寫在 preferences 而不是 stars:rescoreApplicants() 每次開面板都會用
 * matchStars(a.preferences, attrs) **覆寫** a.stars,加成若寫在 stars 上,玩家一改
 * 裝潢就被抹掉。寫進偏好權重,加成才會在每次重算後自然重現(而且不必動 matchStars)。
 *
 * 為什麼是 +25%:matchStars 的 raw = Σ(房間屬性 × 偏好權重),+25% 大約等於推進
 * 一個星等區間(例如 raw 44 → 55,3★ → 4★),看過咖啡廳的人比路人多半級到一級好感,
 * 但仍要靠實際裝潢才拿得到 —— 毫無裝潢的空房 raw 仍是 0,不會憑空變高星。
 */
const CAFE_FAVOR_PREF_MULTIPLIER = 1.25;
/** 加成後單項偏好權重的硬上限:原型現有最大權重 8 × 1.25 = 10,不讓好感無限疊高。
 *  星等本身另有 matchStars 的 1~5 夾值把關,絕不會溢出既有合法範圍。 */
const CAFE_FAVOR_PREF_CAP = 10;
/** 一間房應徵者池的總量上限(常規批次 3 位 + 咖啡廳帶看,避免面板被灌爆) */
const CAFE_APPLICANT_POOL_CAP = 6;

/** 初次好感:放大偏好權重(不改動原型本體,回傳新物件) */
function cafeFavorPreferences(prefs: Partial<Record<RoomAttribute, number>>): Partial<Record<RoomAttribute, number>> {
  const boosted: Partial<Record<RoomAttribute, number>> = {};
  for (const [k, v] of Object.entries(prefs)) {
    boosted[k as RoomAttribute] = Math.min(CAFE_FAVOR_PREF_CAP, Math.round((v ?? 0) * CAFE_FAVOR_PREF_MULTIPLIER));
  }
  return boosted;
}

/** randomIdentity 的決定性版本:同一位顧客永遠得到同一組取向(不呼叫 Math.random) */
function cafeGuestAttraction(guestId: string, gender: Gender): Gender[] {
  if (gender === "nonbinary") return ["male", "female", "nonbinary"];
  const opp: Gender = gender === "male" ? "female" : "male";
  const roll = cafeGuestHash(`${guestId}|orientation`) % 100;
  if (roll < 60) return [opp]; // 異性
  if (roll < 85) return ["male", "female"]; // 雙性
  return [gender]; // 同性
}

/** 把一位租屋意圖顧客組成應徵者:原型、性別、取向全部由顧客 id/姓名決定,同輸入同輸出。 */
function buildCafeApplicant(guest: Pick<CafeGuest, "id" | "name" | "appearance">, roomId: string): Applicant {
  const archetype = ARCHETYPES[cafeGuestHash(`${guest.id}|archetype`) % ARCHETYPES.length];
  const preferences = cafeFavorPreferences(archetype.preferences);
  const gender = cafeGuestGender(guest.name);
  return {
    id: `tenant_cafe_${cafeGuestHash(`${guest.id}|${roomId}`).toString(36)}`,
    name: guest.name,
    archetypeKey: archetype.key,
    occupation: archetype.occupation,
    bio: archetype.bio,
    coreTags: archetype.coreTags.map((tag) => ({ ...tag })),
    preferences,
    monthlyRent: offeredRent(archetype.monthlyRent, roomId),
    baseRent: archetype.monthlyRent, // 好感只加星等,不改開價:避免動到既有經濟平衡
    stars: matchStars(preferences, roomAttributes(roomId)),
    gender,
    attractedTo: cafeGuestAttraction(guest.id, gender),
    appearance: { ...guest.appearance }, // 沿用咖啡廳看到的那張臉,不重抽
    isAdult: true,
    fromCafeGuestId: guest.id,
    cafeFavorMultiplier: CAFE_FAVOR_PREF_MULTIPLIER,
  };
}

/**
 * CAFE-19:玩家接受 intent === "rent" 顧客的看房,把他放進該空房的應徵者池。
 *
 * 沿用既有招租流程,不另開一套:池就是 state.applicantPools[roomId],星等與開價照
 * matchStars()/offeredRent() 算,之後由 getApplicants()→rescoreApplicants() 隨裝潢重算,
 * 入住走既有 moveIn()。顧客本身不進 state.runtimes,也不在這裡從咖啡廳移除(留給 UI)。
 *
 * 這條入口只在玩家實際觸發時才寫 state,種子局與 balance 快照完全不受影響。
 */
export function acceptCafeGuestApplicant(
  guest: Pick<CafeGuest, "id" | "name" | "intent" | "appearance">,
  roomId: string,
): { ok: boolean; text: string } {
  if (guest.intent !== "rent") return { ok: false, text: "這位顧客目前沒有租屋意願" };
  if (!guest.id.trim() || !guest.name.trim() || !guest.appearance) return { ok: false, text: "顧客資料不完整" };
  if (!(roomId in ROOM_APPEARANCE)) return { ok: false, text: "這個房號不是可出租的套房" };
  if (!isVacant(roomId)) return { ok: false, text: "這間房目前有人住,沒辦法帶看" };
  if (Object.values(state.runtimes).some((rt) => rt.tenant.name === guest.name)) {
    return { ok: false, text: `樓裡已經住著一位「${guest.name}」` };
  }
  for (const pool of Object.values(state.applicantPools)) {
    if (pool.applicants.some((a) => a.fromCafeGuestId === guest.id)) {
      return { ok: false, text: "這位顧客的看房已經處理完成" };
    }
    if (pool.applicants.some((a) => a.name === guest.name)) {
      return { ok: false, text: `已經有一位「${guest.name}」在等房東回覆` };
    }
  }

  const day = gameDayIndex();
  const existing = state.applicantPools[roomId];
  const sameDayPool = existing && existing.day === day && existing.applicants.length > 0 ? existing.applicants : null;
  if (sameDayPool && sameDayPool.length >= CAFE_APPLICANT_POOL_CAP) {
    return { ok: false, text: "這間房的應徵者已經排滿,先處理現有名單" };
  }
  // 當日還沒有批次時先補常規批次(與 getApplicants 同一套規則),再把顧客加進去,
  // 免得玩家看到「只有一位應徵者」。常規批次照舊是隨機的;顧客本人仍完全決定性。
  const applicants = sameDayPool ?? generateApplicants(roomId, Object.values(state.runtimes).map((rt) => rt.tenant.name));
  const applicant = buildCafeApplicant(guest, roomId);
  state.applicantPools[roomId] = { day, applicants: [...applicants, applicant] };
  save();
  return {
    ok: true,
    text: `☕ ${guest.name} 看過咖啡廳後想租 ${roomId.replace(/^r/, "")} 房,已列入應徵者(契合 ${applicant.stars}★)`,
  };
}
