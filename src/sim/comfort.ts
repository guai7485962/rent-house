/**
 * 房間舒適度系統(第一波:舒適度核心 + 整潔翻身)。
 *
 * 數值哲學:**慢變環境品質**——佈置好家具→租客「慢慢」變舒適→墊高心情/健康基準,
 * 佈置一次長期受益,不是 The Sims 式快速衰減需要一直照顧。
 *
 * 純函式模組(不改任何狀態):
 *   - roomComfort(roomId, cleanliness)  → 0~100 舒適度分數
 *   - comfortBaselineDelta(comfort)     → 溫和改 homeostasis 基準的增量(mood/stress/wellbeing)
 *   - cleanlinessBaseline(roomId)       → 整潔的自然回歸目標(收納家具墊高「常保整潔」)
 *   - comfortHints(roomId, cleanliness) → 房間細看的改善提示
 *
 * 舒適度 = ( 家具屬性(飽和加權) + 家具種類齊全度 + 家具品質層級 ) × 整潔乘子。
 * 依 catalog 家具 attributes 的實際值域設計係數(見下方註解),不臆測。
 */
import { getDef, type FurnCategory, type FurnKind } from "../furniture/catalog";
import { tierPoints } from "../furniture/tier";
import { getPlacements, roomAttributes } from "./placements";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 五大舒適類別 → 家具分類對應。房內每具備一類 +6(滿 30)。
 * 齊全度鼓勵「生活機能完整」的房間,而不是狂堆單一屬性。
 */
const COMFORT_BUCKETS: { label: string; cats: FurnCategory[]; hint: string }[] = [
  { label: "睡眠", cats: ["sleep"], hint: "缺床鋪,睡不安穩" },
  { label: "娛樂", cats: ["av", "work"], hint: "缺娛樂設備(電視/桌)" },
  { label: "收納", cats: ["storage"], hint: "加收納更整齊" },
  { label: "裝飾", cats: ["ambiance"], hint: "加點綠植/香氛更療癒" },
  { label: "生活", cats: ["seating", "kitchen"], hint: "缺放鬆的座椅" },
];
const CATEGORY_POINTS = 6; // 每類 +6 → 五類滿 30

/**
 * 屬性加權:cozy(療癒感)是舒適主力;style(品味)/soundproof(隔音)其次;
 * tech(科技/便利)微加分;noise(噪音)扣分。權重依 catalog 值域抓:
 *   單房 cozy 常見 10~20(懶骨頭4、沙發8、帷幔床9…),style 3~13,tech 5~14,
 *   soundproof 只有隔音窗簾 6,noise 電競桌/體感機 2。
 * 加權後過飽和函式(x/(x+K))收斂,避免狂堆家具就爆表。
 */
const ATTR_WEIGHTS = { cozy: 1.0, style: 0.6, soundproof: 0.8, tech: 0.35, noise: 0.7 };
const ATTR_HALF = 18; // 飽和半值:加權和 = 18 時屬性分達上限的一半
const ATTR_MAX = 60; // 屬性部分上限

/**
 * 品質層級部分上限:房內逐件加總 `TIER_POINTS` 後夾到 0~10。
 *
 * 夾值有兩個目的:
 * 1. 防「狂塞 premium 小物刷分」——沒有上限的話,買 20 個精品盆栽就能無限加分,
 *    與「佈置得體」的設計意圖相反。10 = 約 6~7 件精品家具滿檔,一般房間拿 2~5 分。
 * 2. **讓三個加項的總上限剛好 = 100**(60 + 30 + 10),使 `roomComfortBreakdown` 的
 *    `clamp(…, 0, 100)` 永遠不生效。這不是巧合而是硬性約束:UI 拆解面板把四列數字
 *    攤開給玩家看,一旦 clamp 真的夾到,面板就會出現「小計 × 倍率 = 102」但總分顯示 100
 *    的加法對不起來。改動任何一個上限都必須維持 attrMax + categoryMax + tierMax ≤ 100
 *    (comfort-test 有斷言把關)。
 */
const TIER_MAX = 10;

/**
 * 給 UI 拆解面板/測試讀的上限常數(**純讀取的鏡射,不參與任何計算**)。
 * 面板要讓玩家看到「離上限還有多遠」,又不能自己另訂一套數字,所以從本檔常數推導。
 */
export const COMFORT_LIMITS = {
  /** 屬性部分上限(= ATTR_MAX) */
  attrMax: ATTR_MAX,
  /** 種類齊全度上限(= 類別數 × 每類點數) */
  categoryMax: COMFORT_BUCKETS.length * CATEGORY_POINTS,
  /** 每具備一類的點數 */
  categoryPoints: CATEGORY_POINTS,
  /** 品質層級部分上限(= TIER_MAX) */
  tierMax: TIER_MAX,
} as const;

/**
 * 五大舒適類別的顯示名稱,順序同 roomComfortBreakdown 判定 missing 的順序。
 * 純讀取:UI 用來畫「哪幾類有、哪幾類缺」,缺的判定仍以 breakdown 的 missing 為準。
 */
export const COMFORT_BUCKET_LABELS: readonly string[] = COMFORT_BUCKETS.map((b) => b.label);

/**
 * 屬性部分:加權和過飽和收斂到 `max`。私人房與共用區共用同一條曲線(權重/半值都一樣),
 * 只有上限不同——這樣「多買一件療癒家具」在哪一區都是同一個手感。
 */
function attrPartOf(roomId: string, max: number): number {
  const attrs = roomAttributes(roomId);
  const cozy = attrs.cozy ?? 0;
  const style = attrs.style ?? 0;
  const soundproof = attrs.soundproof ?? 0;
  const tech = attrs.tech ?? 0;
  const noise = Math.max(0, attrs.noise ?? 0);
  const weighted = Math.max(
    0,
    cozy * ATTR_WEIGHTS.cozy +
      style * ATTR_WEIGHTS.style +
      soundproof * ATTR_WEIGHTS.soundproof +
      tech * ATTR_WEIGHTS.tech -
      noise * ATTR_WEIGHTS.noise,
  );
  return max * (weighted / (weighted + ATTR_HALF));
}

/** 房內具備哪些家具分類(用來算種類齊全度) */
function roomCategories(roomId: string): Set<FurnCategory> {
  const set = new Set<FurnCategory>();
  for (const p of getPlacements()) {
    if (p.room !== roomId) continue;
    set.add(getDef(p.defId).category);
  }
  return set;
}

/**
 * 房內家具的品質層級點數總和(夾 0~TIER_MAX)。
 *
 * 刻意在本檔自己遍歷 placements,**不動 `placements.roomAttributes()`**:
 * 那支同時餵 comfort / acoustics.noiseComplaintEligible / recruit.matchStars(→ 租金),
 * 動一行會連鎖三個系統。tier 只想影響舒適度,所以形狀比照上面的 roomCategories()。
 *
 * ⚠️ **兩個加項的來源集合刻意不同**:`roomAttributes()` 會把 `upgradeAttributes(roomId)`
 * (一次性改建升級的永久加成)疊進屬性部分,但 tierPart **只算家具擺放**——房間升級沒有
 * tier 的概念,硬給它一個等級只會是憑空捏造的數字。所以「屬性部分」= 家具 + 改建、
 * 「品質部分」= 純家具。日後若替改建升級補上品質語意,要記得同步這裡。
 *
 * `max` 由呼叫端傳入:私人房用 `TIER_MAX`(10)、共用區用較寬的 `COMMUNAL_TIER_MAX`
 * (種子交誼廳的 tierPart 已經 7.0,沿用 10 幾乎沒有升級空間)。夾值邏輯只有這一份,
 * 兩套公式不會各自長出一個上限。
 */
function tierPointsIn(roomId: string, max: number): number {
  let points = 0;
  for (const p of getPlacements()) {
    if (p.room !== roomId) continue;
    points += tierPoints(getDef(p.defId));
  }
  return clamp(points, 0, max);
}

/** 房內自動清潔家具(掃地機器人等)的清潔力總和(墊高整潔基準用) */
function roomCleanPower(roomId: string): number {
  let power = 0;
  for (const p of getPlacements()) {
    if (p.room !== roomId) continue;
    power += getDef(p.defId).cleanPower ?? 0;
  }
  return power;
}

/** 整潔乘子:髒→打折。clean 100→×1、50→×0.75、0→×0.5(下限保護,不歸零) */
export function cleanlinessMultiplier(cleanliness: number): number {
  return clamp(0.5 + 0.5 * (cleanliness / 100), 0.5, 1);
}

/**
 * 舒適度拆解(給 UI/測試看細項);roomId 空 → 中性(comfort 50)。
 *
 * tierPart 是**獨立加分項**,在 cleanMult **之前**與另外兩項相加:
 * 線性、可手算、面板列表交代得清楚;若改成乘子會放大 cleanMult 的變異,
 * 而且對 attributes 全空的家具(單人床/爐具/馬桶…)是 0×n=0 的空砲。
 */
export function roomComfortBreakdown(roomId: string | null, cleanliness: number) {
  if (!roomId) {
    return { comfort: 50, attrPart: 30, categoryPart: 20, tierPart: 0, cleanMult: 1, missing: [] as string[] };
  }
  const attrPart = attrPartOf(roomId, ATTR_MAX);

  const cats = roomCategories(roomId);
  const missing: string[] = [];
  let present = 0;
  for (const b of COMFORT_BUCKETS) {
    if (b.cats.some((c) => cats.has(c))) present++;
    else missing.push(b.label);
  }
  const categoryPart = present * CATEGORY_POINTS;

  const tierPart = tierPointsIn(roomId, TIER_MAX);

  const cleanMult = cleanlinessMultiplier(cleanliness);
  const comfort = clamp((attrPart + categoryPart + tierPart) * cleanMult, 0, 100);
  return { comfort, attrPart, categoryPart, tierPart, cleanMult, missing };
}

/** 房間舒適度 0~100(佈置越齊全/越療癒/越乾淨越高) */
export function roomComfort(roomId: string | null, cleanliness: number): number {
  return roomComfortBreakdown(roomId, cleanliness).comfort;
}

/**
 * 舒適度 → homeostasis 基準的溫和增量(慢變:改的是「回到哪」,不直接灌當下值)。
 * 係數刻意小:comfort 每偏離 50 一點,基準才動一點點,租客靠既有 K=0.06 慢慢趨近。
 *   comfort 80(佈置精緻乾淨):mood 基準 +4.8、stress −3、wellbeing 錨 +2.4
 *   comfort 30(簡陋或髒亂)  :mood 基準 −3.2、stress +2、wellbeing 錨 −1.6
 */
export function comfortBaselineDelta(comfort: number): { mood: number; stress: number; wellbeing: number } {
  const cd = comfort - 50;
  return { mood: cd * 0.16, stress: -cd * 0.1, wellbeing: cd * 0.08 };
}

/**
 * 整潔的自然回歸目標(homeostasis 錨點):生活會慢慢變髒回到這個水位,
 * 收納家具(storage)墊高「常保整潔」的基準 = 減緩實際衰減;
 * 自動清潔家具(掃地機器人的 cleanPower)再往上墊,體現「買了會自動維持乾淨」。
 *   無收納:錨 50(略髒,dirt 會微微顯現,提示玩家買收納)
 *   收納充足:最高錨 80;加掃地機器人可再上探,總上限夾到 90。
 */
export function cleanlinessBaseline(roomId: string | null): number {
  if (!roomId) return 50;
  const storage = roomAttributes(roomId).storage ?? 0;
  const cleanPower = roomCleanPower(roomId);
  return clamp(50 + storage * 2 + cleanPower, 50, 90);
}

/** 房間細看的改善提示(依太髒/缺哪類家具/不夠療癒,最多 3 條;手機直式勿擠) */
export function comfortHints(roomId: string | null, cleanliness: number): string[] {
  if (!roomId) return [];
  const bd = roomComfortBreakdown(roomId, cleanliness);
  const hints: string[] = [];
  if (cleanliness < 40) hints.push("太髒亂了,該打掃了");
  else if (cleanliness < 60 && (roomAttributes(roomId).storage ?? 0) < 4) hints.push("有點亂,加收納能常保整潔");
  // 缺哪類家具(依 bucket 定義的提示語)
  for (const b of COMFORT_BUCKETS) {
    if (bd.missing.includes(b.label)) hints.push(b.hint);
    if (hints.length >= 3) return hints.slice(0, 3);
  }
  // 都齊了但屬性偏低 → 建議加療癒佈置
  if (hints.length < 3 && bd.attrPart < 28) hints.push("多點溫馨佈置會更舒適");
  return hints.slice(0, 3);
}

// ===========================================================================
// 共用區舒適度(交誼廳 / 浴室 / 洗衣間)
//
// 🔴 **刻意走獨立管道,不把共用區分數塞進 `roomComfort`**:
//   1. `roomComfort` 是 `cozyHomePass` 的門檻輸入(tick.ts)。把共用區攪進去會位移
//      每個租客的舒適度,慶祝日誌的觸發次數一變,mood/satisfaction 就會偏移遠超
//      balance 快照的容差。獨立管道讓 `roomComfort` 的值**一位元都不變**。
//   2. 共用區不能沿用私人房的 `COMFORT_BUCKETS`:那五類裡「睡眠」對浴室永遠不可能達成、
//      「社交」對洗衣間也不該算缺點;更致命的是 `FurnCategory` 的 `utility` **不在任何
//      bucket 裡**,而浴室 3/4 件、洗衣間 5/5 件全是 utility → 洗衣間結構性拿 0 分,
//      玩家怎麼買都拿不到分。所以共用區用自己的 bucket 表(按 `sprite.kind` 細分 utility)。
//   3. 不動 `COMFORT_BUCKETS` / `COMFORT_LIMITS`:把 utility 併成第六類會讓私人房的
//      categoryMax 30→36、總上限破 100(`robot_vacuum` 是 utility,連所有私人房分數都會變)。
//
// 共用區自己維持自己的不變量:**每一區 attrMax + categoryMax + tierMax = 100**,
// 三區用同一組上限 → 三區分數在同一個 0~100 尺規上,加權合成才有意義。
// ===========================================================================

/** 共用區 id(這三個是全部;它們永遠不會是 `roomOfTenant()` 的回傳值) */
export type CommunalAreaId = "lounge" | "bathroom" | "laundry";

/**
 * 加權合成:交誼廳權重最高(租客待最久、社交/用餐都在那),浴室次之,洗衣間最低。
 * 用加權而非「取最低」:UI 上「哪一區拖累最多」比「木桶效應」好解釋,
 * 而且不會發生「洗衣間差一分,整棟樓全毀」的懸崖。
 */
const COMMUNAL_WEIGHTS: Record<CommunalAreaId, number> = { lounge: 0.5, bathroom: 0.3, laundry: 0.2 };

/** 共用區的三個加項上限(三區共用一套 → 每區滿分都是 100) */
const COMMUNAL_ATTR_MAX = 50;
const COMMUNAL_CATEGORY_MAX = 30;
/**
 * 共用區的品質層級上限刻意比私人房的 10 寬:種子交誼廳的 tierPart 已經是 7.0,
 * 沿用 10 等於一開場就快撞頂、玩家換精品家具幾乎看不到分數動。20 給得出升級空間,
 * 又維持 50 + 30 + 20 = 100 的不變量。
 */
const COMMUNAL_TIER_MAX = 20;

/**
 * 每一區自己的舒適 bucket。`cats` 比對家具分類,`kinds` 比對 `sprite.kind`——
 * 後者是把 `utility` 這個大雜燴拆開的關鍵(淋浴間/馬桶/洗手台/洗衣機/曬衣架全是 utility,
 * 但它們對「浴室夠不夠用」與「洗衣間夠不夠用」的意義完全不同)。
 *
 * 每一區的 bucket 都**確保拿得到**(種子局缺的那一類都買得到對應家具),
 * `categoryPoints` = 30 ÷ 該區 bucket 數 → 不論幾類,「機能齊全」對每一區都值 30 分。
 */
interface CommunalBucket {
  label: string;
  cats?: FurnCategory[];
  kinds?: FurnKind[];
  hint: string;
}

const COMMUNAL_BUCKETS: Record<CommunalAreaId, CommunalBucket[]> = {
  // 交誼廳:種子局缺「收納」(擺個書架/衣櫃/抽屜櫃就補得起來)
  lounge: [
    { label: "社交", cats: ["seating", "av"], hint: "交誼廳缺沙發或電視,沒人想留下來" },
    { label: "餐廚", cats: ["kitchen"], hint: "交誼廳缺廚房機能,吃飯只能各自解決" },
    { label: "裝飾", cats: ["ambiance"], hint: "交誼廳加點盆栽/地毯會更像家" },
    { label: "收納", cats: ["storage"], hint: "交誼廳缺收納,公共雜物沒地方放" },
  ],
  // 浴室:種子局缺「收納」
  bathroom: [
    { label: "淋浴", kinds: ["shower", "bathtub"], hint: "浴室缺淋浴設備" },
    { label: "如廁", kinds: ["toilet"], hint: "浴室缺馬桶" },
    { label: "盥洗", kinds: ["sink"], hint: "浴室缺洗手台" },
    { label: "裝飾", cats: ["ambiance"], hint: "浴室擺盆小植栽會舒服很多" },
    { label: "收納", cats: ["storage"], hint: "浴室缺收納,盥洗用品散一地" },
  ],
  // 洗衣間:種子局缺「裝飾」
  laundry: [
    { label: "洗滌", kinds: ["washer", "sink"], hint: "洗衣間缺洗衣機或水槽" },
    { label: "晾曬", kinds: ["drying_rack"], hint: "洗衣間缺晾衣的地方" },
    { label: "整理", kinds: ["laundry_basket"], cats: ["storage"], hint: "洗衣間缺洗衣籃/收納" },
    { label: "裝飾", cats: ["ambiance"], hint: "洗衣間加點綠意就不只是機房" },
  ],
};

/** 共用區三區的顯示順序(UI 與測試共用,權重高的在前) */
export const COMMUNAL_AREA_IDS: readonly CommunalAreaId[] = ["lounge", "bathroom", "laundry"];

/** 共用區的中文名稱(UI 面板列標題) */
export const COMMUNAL_AREA_LABELS: Record<CommunalAreaId, string> = {
  lounge: "交誼廳",
  bathroom: "浴室",
  laundry: "洗衣間",
};

/**
 * 給 UI 拆解面板/測試讀的共用區上限(**純讀取的鏡射,不參與計算**)。
 * 每一區 attrMax + categoryMax + tierMax = 100 → 分數永遠不會被 clamp 夾到,
 * 面板上「屬性 + 齊全 + 品質」的加法對得起來(同私人房 `COMFORT_LIMITS` 的硬性約束)。
 */
export const COMMUNAL_LIMITS: Record<
  CommunalAreaId,
  { attrMax: number; categoryMax: number; categoryPoints: number; tierMax: number; weight: number }
> = Object.fromEntries(
  COMMUNAL_AREA_IDS.map((id) => [
    id,
    {
      attrMax: COMMUNAL_ATTR_MAX,
      categoryMax: COMMUNAL_CATEGORY_MAX,
      categoryPoints: COMMUNAL_CATEGORY_MAX / COMMUNAL_BUCKETS[id].length,
      tierMax: COMMUNAL_TIER_MAX,
      weight: COMMUNAL_WEIGHTS[id],
    },
  ]),
) as Record<CommunalAreaId, { attrMax: number; categoryMax: number; categoryPoints: number; tierMax: number; weight: number }>;

/** 某區具備哪些 sprite kind(bucket 用來細分 utility) */
function areaKinds(areaId: string): Set<FurnKind> {
  const set = new Set<FurnKind>();
  for (const p of getPlacements()) {
    if (p.room !== areaId) continue;
    const sprite = getDef(p.defId).sprite;
    if ("kind" in sprite) set.add(sprite.kind);
  }
  return set;
}

/**
 * 單一共用區的品質拆解(0~100)。形狀刻意與 `roomComfortBreakdown` 對稱:
 * `quality === (attrPart + categoryPart + tierPart) × cleanMult`。
 *
 * **整潔沒有新狀態**:共用區沒有租客、沒有 `rt.cleanliness`,直接用純函式
 * `cleanlinessBaseline(areaId)` 推導它的自然水位(收納家具與掃地機器人墊高它)。
 * 於是整個共用區分數 100% 由 `placements.list` 推導 → 零存檔改動、零 migration、
 * 零 tick 工作,舊存檔載入自動一致(placements 早已入存檔)。
 */
export function communalAreaBreakdown(areaId: CommunalAreaId) {
  const limits = COMMUNAL_LIMITS[areaId];
  const attrPart = attrPartOf(areaId, limits.attrMax);

  const cats = roomCategories(areaId);
  const kinds = areaKinds(areaId);
  const buckets = COMMUNAL_BUCKETS[areaId].map((b) => ({
    label: b.label,
    hint: b.hint,
    has: (b.cats?.some((c) => cats.has(c)) ?? false) || (b.kinds?.some((k) => kinds.has(k)) ?? false),
  }));
  const categoryPart = buckets.filter((b) => b.has).length * limits.categoryPoints;

  const tierPart = tierPointsIn(areaId, limits.tierMax);

  const cleanBase = cleanlinessBaseline(areaId);
  const cleanMult = cleanlinessMultiplier(cleanBase);
  const quality = clamp((attrPart + categoryPart + tierPart) * cleanMult, 0, 100);
  return { quality, attrPart, categoryPart, tierPart, cleanMult, cleanBase, buckets };
}

/** 三區的完整拆解 + 加權合成分數(UI 展開面板與測試共用同一份計算) */
export function communalBreakdown() {
  const areas = COMMUNAL_AREA_IDS.map((id) => ({
    id,
    label: COMMUNAL_AREA_LABELS[id],
    weight: COMMUNAL_WEIGHTS[id],
    ...communalAreaBreakdown(id),
  }));
  const quality = areas.reduce((sum, a) => sum + a.quality * a.weight, 0);
  return { quality, areas };
}

/** 公共空間整體品質 0~100(交誼廳 0.5 / 浴室 0.3 / 洗衣間 0.2 加權) */
export function communalQuality(): number {
  return communalBreakdown().quality;
}

/**
 * 🔴 中性基準 = **開場樓層的公共空間分數**,不是 50。
 *
 * 低於它 = 你把公共空間搞差了(賣掉沙發、拆了洗衣機),高於它 = 你有投資。
 * 取 50 會讓功能一上線就是全樓大扣分(種子局 q ≈ 35.3 → cd ≈ −15 → mood −1.5、
 * 三區合成後更難看),而且 balance 快照會全盤重排,等於用「新功能」偷改既有平衡。
 *
 * **實測推導**(種子 `INITIAL_PLACEMENTS`,無任何玩家操作;上限 50/30/20):
 *   交誼廳:attr 32.5243(cozy 23・style 14・tech 6 → 加權 33.5)
 *          + 齊全 22.5(社交/餐廚/裝飾 ✓、收納 ✗ → 3/4 × 30)
 *          + 品質 7.0  → 小計 62.0243 × 0.81(整潔錨 62:冰箱 4 + 流理臺 2 → 50+12)
 *          = 50.2397
 *   浴室  :attr 5.0(僅浴室小盆栽 cozy 2)
 *          + 齊全 24(淋浴/如廁/盥洗/裝飾 ✓、收納 ✗ → 4/5 × 30)
 *          + 品質 0.5  → 小計 29.5 × 0.75(整潔錨 50)= 22.125
 *   洗衣間:attr 0(五件全零屬性)
 *          + 齊全 22.5(洗滌/晾曬/整理 ✓、裝飾 ✗ → 3/4 × 30)
 *          + 品質 1.0  → 小計 23.5 × 0.75(整潔錨 50)= 17.625
 *   加權  :0.5 × 50.2397 + 0.3 × 22.125 + 0.2 × 17.625 = 35.28233…
 *
 * 下面這個字面值是把實測的 double 原封不動貼回來(不是四捨五入的近似值),
 * 所以種子局 `cd` **恰好** === 0 → 三個 delta 全 0 → balance 快照零漂移。
 * communal-comfort-test 有斷言把這條釘死;改動 bucket 表/上限/權重都必須重新校準,
 * 不可以改 `scripts/balance-snapshot.json` 掩蓋。
 */
export const COMMUNAL_NEUTRAL = 35.28233009708738;

/**
 * 公共空間品質 → homeostasis 基準的溫和增量(疊在私人房的 `comfortBaselineDelta` 之上)。
 *
 * 係數刻意**小於私人房**(私人房 0.16 / 0.10 / 0.08):公共空間是共享環境,
 * 影響力應該低於「自己的房間」——把交誼廳佈置到滿分也不該蓋過房間本身的好壞。
 *   q 55(比開場好很多):mood +1.97、stress −1.18、wellbeing 錨 +0.99
 *   q 15(公共空間荒廢):mood −2.03、stress +1.22、wellbeing 錨 −1.01
 */
export function communalBaselineDelta(q: number): { mood: number; stress: number; wellbeing: number } {
  const cd = q - COMMUNAL_NEUTRAL;
  return { mood: cd * 0.1, stress: -cd * 0.06, wellbeing: cd * 0.05 };
}
