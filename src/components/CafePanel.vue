<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { CAFE_INGREDIENTS } from "../content/cafeIngredients";
import { CAFE_FURNITURE_ZONE, CAFE_ZONE_INFO, type CafePlacementZone } from "../content/cafeZoneGuide";
import { getDef } from "../furniture/catalog";
import {
  buyCafeUpgrade,
  advanceCafeResearch,
  availableCafeResearch,
  avgTicket,
  cafeAmbianceFull,
  cafeAmbianceMultiplier,
  cafeBottleneck,
  cafeBottleneckAdvice,
  cafeCapability,
  cafeCrowd,
  cafeInvestOutlook,
  cafeTypicalBase,
  CAFE_AMBIANCE_FULL_POINTS,
  CAFE_AMBIANCE_SWING,
  cafeIngredientMenuUse,
  cafeIntentWeights,
  cafePetComfort,
  cafeStorageCapacity,
  cafeIngredientShortageBlame,
  cafeItemShortageCauses,
  cafeRecipeLines,
  cafeRegularMaxAwayDays,
  cafeRegularUsualItem,
  cafeResearchDaysLeft,
  cafeSalesRanking,
  cafeStaffCount,
  sortedCafeRegulars,
  CAFE_REGULAR_CAP,
  CAFE_REGULAR_FRIEND_AFFECTION,
  CAFE_REGULAR_LAPSE_DAYS,
  CAFE_MAX_EXTRA_STAFF,
  CAFE_STAFF_WAGE,
  CAFE_RESEARCH,
  CAFE_SALES_WINDOW_DAYS,
  CAFE_OPENING_COST,
  CAFE_UPGRADES,
  CAFE_UPGRADE_IDS,
  consumeStock,
  dailyDemand,
  fireCafeStaff,
  getCafeResearch,
  getCafeUpgrade,
  hireCafeStaff,
  menuItems,
  openCafe,
  startCafeResearch,
  suggestedStandingOrders,
  suggestStandingOrdersFromSales,
  type CafeInvestmentResult,
} from "../sim/cafe";
import { removeCafeGuest } from "../sim/cafeGuests";
import { isVacant, ROOM_APPEARANCE } from "../sim/gameState";
import { acceptCafeGuestAdoption, CAFE_GUEST_ADOPTION_DESTINATION } from "../sim/pets";
import { MS_PER_GAME_HOUR } from "../sim/clock";
import { save } from "../sim/persistence";
import {
  CAFE_PLACEMENT_REGIONS,
  cafeAmbiancePoints,
  cafeBackStoragePoints,
  cafePetComfortPoints,
  cafeSeatSpots,
  cafeServiceStations,
  getPlacements,
  placeCafeStarterSet,
} from "../sim/placements";
import { cafePetVisitEndHour } from "../floor/petAgents";
import { weatherForDay } from "../sim/weather";
import { weekdayOf } from "../sim/week";
import { acceptCafeGuestApplicant } from "../sim/recruit";
import { addMoney, gameDayIndex, permanentHousePetEntries, state } from "../store";
import type { CafeGuest, CafeRegular } from "../types";
import OpsTabs, { type OpsTab } from "./OpsTabs.vue";

const emit = defineEmits<{ close: []; done: [text: string]; switchTab: [tab: OpsTab] }>();

const initialOrders = Object.keys(state.cafe.standingOrders).length
  ? state.cafe.standingOrders
  : suggestedStandingOrders();
const orderDraft = reactive<Record<string, number>>({ ...initialOrders });
const selectedPet = reactive<Record<string, string>>({});
const selectedRoom = reactive<Record<string, string>>({});

const latest = computed(() => state.cafe.history.at(-1) ?? null);
/**
 * 🔴 P4b 修 bug:面板的產能一直讀「沒帶席次與員工」的 `cafeCapability()`。
 *
 * P4a 把產能改成 `min(外帶底量 + 席次 × 迴轉率, 員工數 × 每人杯數)`,不帶參數會退回
 * 「席次不設限 + 只有首位店員」的預設值 ⇒ 面板顯示的「產能 N 單」與 `tick.ts`
 * 真的用來夾客流的那個數字對不起來(雇了人也不會動)。這裡餵進與 `cafeHourlyPass()`
 * **完全相同的兩個輸入**:`cafeSeatSpots().length` 與 `state.cafe.extraStaff`。
 *
 * `placements` 是 reactive ⇒ 玩家搬椅子,這個數字立刻跟著動。
 */
const seatCount = computed(() => cafeSeatSpots().length);
/**
 * 🔴 A 批:`stations` 也必須跟著餵 —— 少餵一個輸入,面板的產能就會再一次與
 * `cafeHourlyPass()` 對不上(那正是 P4b 修過的 bug)。三個輸入與 tick 完全相同。
 */
const serviceStations = computed(() => cafeServiceStations());
const capability = computed(() => cafeCapability(state.cafe.upgrades, {
  seats: seatCount.value,
  extraStaff: state.cafe.extraStaff,
  stations: serviceStations.value,
}));
// A 批:後場容量與寵物區舒適 —— 兩者都是 placements(reactive),搬家具立刻反映。
const backStoragePoints = computed(() => cafeBackStoragePoints());
const storageCapacity = computed(() => cafeStorageCapacity(backStoragePoints.value));
const storedUnits = computed(() =>
  CAFE_INGREDIENTS.reduce((sum, item) => sum + Math.max(0, Math.trunc(state.cafe.stock[item.id] ?? 0)), 0));
const storageOver = computed(() => storedUnits.value > storageCapacity.value);
const storagePercent = computed(() => (storageCapacity.value > 0
  ? Math.min(100, Math.round((storedUnits.value / storageCapacity.value) * 100))
  : 0));
const petComfort = computed(() => cafePetComfort(cafePetComfortPoints(), state.cafe.upgrades));
const petIntentWeights = computed(() => cafeIntentWeights(petComfort.value, capability.value.signLevel));
const petStayEndHour = computed(() => cafePetVisitEndHour(petComfort.value));
// P4b 人力區塊:人數含開張費已付的首位店員,日薪只算第二位起(§4.9)。
const staffCount = computed(() => cafeStaffCount(state.cafe.extraStaff));
const extraStaffCount = computed(() => staffCount.value - 1);
const todaySales = computed(() => state.cafe.sales.find((row) => row.day === currentDay.value) ?? null);
const todayServed = computed(() => todaySales.value?.served ?? 0);
const loadPercent = computed(() => (capability.value.capacity > 0
  ? Math.min(100, Math.round((todayServed.value / capability.value.capacity) * 100))
  : 0));
/** 進度條轉紅的門檻:已經吃掉九成產能 ⇒ 畫面上的隊伍差不多也排起來了。 */
const loadFull = computed(() => loadPercent.value >= 90);
const adoptGuests = computed(() => state.cafe.guests.filter((guest) => guest.intent === "adopt"));
/**
 * 🔴 2026-09-02 貓跳台可見性:**把「結果」秀出來**。
 *
 * 貓跳台($12,000)換到的是真實內容而不是營收(`intent` 完全不參與結帳),那是對的、
 * 一個數值都不該動。缺的一直是**結果**:玩家看得到詢問率變高,卻永遠看不到「所以到底
 * 送養了幾隻」—— 於是那筆錢在感受上仍然是白花的。
 *
 * 兩個數字都**從既有存檔欄位推**(`state.petHomes` 的送養名冊),
 * **沒有新增任何存檔欄位、`SAVE_VERSION` 不動**:
 * - 詢問件數只有「現在店裡幾位」拿得到(顧客是當日的、不入存檔)⇒ 誠實寫成「現在」;
 * - 送養隻數是真的成果,近 30 天與累計都印。
 */
const CAFE_ADOPT_RECENT_DAYS = 30;
const cafeAdoptedHomes = computed(() =>
  state.petHomes.filter((entry) => entry.destination === CAFE_GUEST_ADOPTION_DESTINATION));
const cafeAdoptedRecent = computed(() => {
  const since = state.gameMs - CAFE_ADOPT_RECENT_DAYS * 24 * MS_PER_GAME_HOUR;
  return cafeAdoptedHomes.value.filter((entry) => entry.leftMs >= since).length;
});
const rentGuests = computed(() => state.cafe.guests.filter((guest) => guest.intent === "rent"));
/**
 * 🔴 B 批:常客名冊。**觀察物,不是決策卡** —— 沒有按鈕、不會過期,
 * 玩家看的是「這幾個人記得你」,而不是又一張要處理的待辦。
 * 順序與 `cafeRegularForHour()` 的抽籤同一份 `(sinceDay, name)` 排序。
 */
const regulars = computed(() => sortedCafeRegulars(state.cafe.regulars));
const regularMaxAway = computed(() => cafeRegularMaxAwayDays(regulars.value, currentDay.value));
const regularAway = (regular: CafeRegular) => Math.max(0, currentDay.value - regular.lastVisitDay);
const regularTasteLabel = (taste: CafeRegular["taste"]) =>
  (taste === "coffee" ? "咖啡" : taste === "bakery" ? "烘焙" : "寵物餐");
/** 「老樣子」的中文品名;品項已不在菜單(或還沒點過)時退回口味。 */
const regularUsualName = (regular: CafeRegular) => {
  const id = cafeRegularUsualItem(regular);
  const item = id ? cafeMenu.value.find((entry) => entry.id === id) : undefined;
  return item?.name ?? "";
};
/** 認養卡／租屋卡的補充說明:這位顧客是不是常客。 */
const regularOf = (name: string) => state.cafe.regulars.find((entry) => entry.name === name) ?? null;
const eligiblePets = computed(() => permanentHousePetEntries().map(([id, pet]) => ({ id, pet })));
const vacantRooms = computed(() => Object.keys(ROOM_APPEARANCE)
  .filter((roomId) => isVacant(roomId))
  .map((roomId) => ({ id: roomId, label: `${roomId.replace(/^r/, "")} 房` })));
/**
 * 2026-08-09:面板有九個區塊,使用者反映要一路捲很久才找得到常備量。
 * 改成可收合,**預設只展開「營運觀察」與「常備量」**(一個是看狀況、一個是天天要調的);
 * 其餘點標題列展開。收起時標題列右邊那顆數字/摘要仍看得到,所以不必展開就知道要不要點。
 *
 * 兩張詢問卡是例外:有顧客在等回覆時預設就展開 —— 它們是**會過期的決策**,
 * 收起來等於讓玩家漏掉。開著面板時才進來的顧客由下面的 watch 補開。
 */
const openSections = reactive({
  today: true,
  research: false,
  menu: false,
  sales: false,
  stock: true,
  staff: false,
  invest: false,
  regulars: false,
  adoption: adoptGuests.value.length > 0,
  rent: rentGuests.value.length > 0,
  zones: false,
});
type CafeSectionId = keyof typeof openSections;
function toggleSection(id: CafeSectionId) {
  openSections[id] = !openSections[id];
}

/** 分區小抄用的家具分組(依 room):資料只有一份(`CAFE_FURNITURE_ZONE`),這裡只是換個視圖。 */
const zoneFurnitureGroups = computed(() => {
  const groups = {} as Record<CafePlacementZone, { defId: string; name: string }[]>;
  for (const [defId, rule] of Object.entries(CAFE_FURNITURE_ZONE)) {
    (groups[rule.room] ??= []).push({ defId, name: getDef(defId).name });
  }
  return groups;
});
watch(() => adoptGuests.value.length, (n, prev) => { if (n > prev) openSections.adoption = true; });
watch(() => rentGuests.value.length, (n, prev) => { if (n > prev) openSections.rent = true; });

const predictedDemand = computed(() => dailyDemand(latest.value?.guests ?? 0));
const predictedSupply = computed(() => consumeStock(state.cafe.stock, predictedDemand.value));
/**
 * 🔴 只警告「目前菜單真的用得到」的原料(2026-08-25 修)。
 *
 * `dailyDemand()` 是照 `CafeIngredient.perGuest` 對**全部**原料一律估的,
 * 它不知道菜單上有什麼。第七種原料「精品生豆」上線後這個落差就現形了:
 * 還沒研發第三層的玩家(菜單上沒有任何一道用得到它、庫存自然是 0)
 * 每天都會看到「⚠️ 依最近客流預估會缺:精品生豆」——叫玩家去買一個買了也用不到的東西。
 *
 * 唯一事實來源仍然是 `CafeMenuItem.recipe`(見 `content/cafeIngredients.ts` 檔頭),
 * 所以這裡直接用 `cafeIngredientMenuUse()` 濾掉「菜單上沒人用」的原料。
 */
const predictedShortages = computed(() => predictedSupply.value.shortages
  .filter((id) => cafeIngredientMenuUse(id, cafeMenu.value).length > 0)
  .map((id) => CAFE_INGREDIENTS.find((item) => item.id === id)?.name ?? id));
const currentDay = computed(() => gameDayIndex());
// 氛圍加成的讀取面:placements 是 reactive,搬動/賣出家具後這兩個數字會立刻跟著動。
const ambiancePoints = computed(() => cafeAmbiancePoints());
const ambianceMultiplier = computed(() => cafeAmbianceMultiplier(ambiancePoints.value));
const cafeFurnitureCount = computed(() =>
  getPlacements().filter((p) => (CAFE_PLACEMENT_REGIONS as readonly string[]).includes(p.room)).length);
/** 🔴 氛圍是否吃滿:面板與商店共用 `cafeAmbianceFull()`,任何一處都不准手寫常數比較。 */
const ambianceFull = computed(() => cafeAmbianceFull(ambiancePoints.value));
/** 吃滿之後**多出來**的點數;剛好踩在門檻上時是 0(文案要換一句,不能寫「多出來的 0 點」)。 */
const ambianceOverflow = computed(() => Math.max(0, ambiancePoints.value - CAFE_AMBIANCE_FULL_POINTS));

// ---------------------------------------------------------------------------
// 🔴 可見性批次:想上門 vs 做得出來
//
// 主數字一律是「一般日」(天氣＝星期＝1.0)。當日值會被天氣(0.7~1.15)與星期
// (0.9~1.25)推到 ±38% 之間跳,玩家週一看到「買招牌沒用」、週六看到「有用」,
// 面板的可信度就沒了。當日值只放小字,讓玩家知道今天是旺是淡。
//
// `base` **不存進 state**:它是 popularity + signLevel + ambiancePoints 的純函式,
// 零 RNG、reactive ⇒ 玩家搬一張椅子,這裡立刻跟著動。
// ---------------------------------------------------------------------------
const typicalBase = computed(() => cafeTypicalBase({
  signLevel: capability.value.signLevel,
  popularity: state.cafe.popularity,
  ambiancePoints: ambiancePoints.value,
}));
const todayCrowd = computed(() => cafeCrowd({
  weather: weatherForDay(currentDay.value),
  weekday: weekdayOf(state.gameMs),
  signLevel: capability.value.signLevel,
  capacity: capability.value.capacity,
  popularity: state.cafe.popularity,
  outdoorSeats: capability.value.outdoorSeats,
  ambiancePoints: ambiancePoints.value,
}));
const bottleneck = computed(() => cafeBottleneck({ base: typicalBase.value, capability: capability.value }));
const bottleneckAdvice = computed(() => cafeBottleneckAdvice(bottleneck.value, capability.value, typicalBase.value));

/**
 * 過去 7 個遊戲日「因為做不出來而沒接到」的人。
 *
 * ⚠️ `turnedAway ⊇ abandoned`:排到放棄的是其中真的走進店裡排過隊的那一小撮
 * (每小時要溢出超過 `CAFE_ABANDON_QUEUE_TOLERANCE` 位才會有人排),其餘的人在門口
 * 看一眼就走。所以「沒接到 96 人／排到放棄 0 人」是正確的,文案必須交代這件事。
 */
const turnawayWindow = computed(() => {
  const rows = state.cafe.sales.slice(-CAFE_SALES_WINDOW_DAYS);
  const sum = rows.reduce((n, row) => n + Math.max(0, row.turnedAway ?? 0), 0);
  const abandoned = rows.reduce((n, row) => n + Math.max(0, row.abandoned ?? 0), 0);
  return {
    days: rows.length,
    sum,
    abandoned,
    avg: rows.length > 0 ? Math.round(sum / rows.length) : 0,
  };
});

/**
 * 🔴 2026-09-02:投資清單**只在 Vue 層分組**。
 *
 * `CAFE_UPGRADE_IDS` 的鍵名、值與宣告順序**一格都不能動**(存檔與 `cafeCapability()`
 * 都吃它們),所以這裡不重排資料、只挑出要放進哪一組來 render。
 *
 * 分兩組的理由是玩家一直把它們當成同一種東西在比 CP 值,然後對「買了沒變多」失望:
 * - **產能與客流**:買了會多做幾單,可以拿回本天數互比;
 * - **內容與保險**:貓跳台換到的是真實內容(店貓送養的唯一管道,`intent` 不參與結帳)、
 *   大型冷藏是保險 + 冷萃研發的閘門。它們**本來就不該用回本天數評價**,
 *   放在同一排比較就一定顯得爛。
 */
const CAFE_UNLOCK_UPGRADE_IDS: readonly string[] = [CAFE_UPGRADE_IDS.petTower, CAFE_UPGRADE_IDS.coldStorage];
const upgradeGroups = computed(() => [
  {
    key: "capacity",
    title: "產能與客流",
    note: "買了會多做幾單，chip 上的數字就是以現在這間店算出來的差分。",
    items: CAFE_UPGRADES.filter((item) => !CAFE_UNLOCK_UPGRADE_IDS.includes(item.id)),
  },
  {
    key: "unlock",
    title: "內容解鎖與保險",
    note: "不直接變成營收：打開新的研發線或新的故事，別拿回本天數跟上面那組比。",
    items: CAFE_UPGRADES.filter((item) => CAFE_UNLOCK_UPGRADE_IDS.includes(item.id)),
  },
]);

/** 投資卡的 chip:文字一律由 `cafeInvestOutlook()` 產,template 不寫死任何一句。 */
const investOutlook = (id: string) => cafeInvestOutlook(id, {
  upgrades: state.cafe.upgrades,
  seats: seatCount.value,
  extraStaff: state.cafe.extraStaff,
  stations: serviceStations.value,
  popularity: state.cafe.popularity,
  ambiancePoints: ambiancePoints.value,
  standingOrders: state.cafe.standingOrders,
  petComfortPoints: cafePetComfortPoints(),
});
const activeResearch = computed(() => state.cafe.research ? getCafeResearch(state.cafe.research.id) : undefined);
const researchDaysLeft = computed(() => cafeResearchDaysLeft(state.cafe, currentDay.value));
const researchProgress = computed(() => {
  if (!state.cafe.research || researchDaysLeft.value === null) return 0;
  const duration = Math.max(1, state.cafe.research.days);
  return Math.min(100, Math.max(0, Math.round((1 - researchDaysLeft.value / duration) * 100)));
});
const completedResearch = computed(() => new Set(state.cafe.completed));
const completedResearchCount = computed(() => CAFE_RESEARCH.filter((item) => completedResearch.value.has(item.id)).length);
const availableResearchIds = computed(() => new Set(availableCafeResearch(state.cafe).map((item) => item.id)));
const remainingResearch = computed(() => CAFE_RESEARCH.filter((item) =>
  !completedResearch.value.has(item.id) && item.id !== state.cafe.research?.id));
const cafeMenu = computed(() => menuItems(state.cafe.completed));
// P3 銷售排行:過去 7 個遊戲日各品項的賣出杯數與缺貨次數(資料來自 P1 的 state.cafe.sales)。
const salesRanking = computed(() => cafeSalesRanking(state.cafe.sales, cafeMenu.value, CAFE_SALES_WINDOW_DAYS));
const salesDays = computed(() => state.cafe.sales.slice(-CAFE_SALES_WINDOW_DAYS).length);
const salesHasData = computed(() => salesRanking.value.some((row) => row.sold > 0 || row.missed > 0));
const salesTotalMissed = computed(() => salesRanking.value.reduce((sum, row) => sum + row.missed, 0));
/** 長條圖用的相對長度;沒有任何銷量時全部顯示 0 寬(不會出現 0/0 的 NaN)。 */
const salesTopSold = computed(() => salesRanking.value.reduce((best, row) => Math.max(best, row.sold), 0));
const soldBarWidth = (sold: number) => (salesTopSold.value > 0 ? Math.round((sold / salesTopSold.value) * 100) : 0);
const cafeAverageTicket = computed(() => avgTicket(state.cafe.completed));
/**
 * 熱銷品 = 過去 7 日**實際賣最多**的菜單品項。
 *
 * 2026-08-08 之前這裡是「預估消耗最大的原料 → `usedIn[0]`」,而 `usedIn` 是
 * P1 之前的手寫字串、早就與菜單對不上(它會顯示「美式咖啡」,菜單上叫
 * 「招牌美式咖啡」)。`usedIn` 已整個移除,這裡改讀真的賣出份數——
 * 面板上的每一個商品名,現在都來自菜單本身。
 */
const hotItem = computed(() => {
  const best = salesRanking.value[0];
  if (!best || best.sold <= 0) return "尚無資料";
  return best.name;
});

// ---------------------------------------------------------------------------
// 🔴 缺貨 → 原料的歸因(使用者 2026-08-08:「不知道那個商品缺貨我要多進的是什麼原料」)
//
// 兩張表本來各說各話:銷售排行只講「品項缺貨 N 次」,常備量只講「原料庫存幾單位」。
// 下面三個 computed 就是那條缺掉的橋,而且**兩邊講的是同一份資料**:
//   1. `itemShortage()`  品項 → 當時真的缺的原料 + 要補多少(讀實際 `missedBy` 紀錄)
//   2. `itemRecipe()`    品項 → 配方(沒缺過時的說明,也是舊存檔的退路)
//   3. `ingredientUse()` / `blame` 原料 → 餵哪些品項 + 最近害幾單做不出來
// ---------------------------------------------------------------------------

/** 過去 7 日各原料害了幾單做不出來(來自逐位結帳當下記的 `missing`)。 */
const shortageBlame = computed(() => cafeIngredientShortageBlame(state.cafe.sales, CAFE_SALES_WINDOW_DAYS));
/** 某品項缺貨的實際原因(缺哪個原料、那些單子共需幾單位)。 */
const itemShortage = (itemId: string) =>
  cafeItemShortageCauses(state.cafe.sales, itemId, cafeMenu.value, CAFE_SALES_WINDOW_DAYS);
/** 某品項的配方明細(唯一事實來源是 `recipe`)。 */
const itemRecipe = (itemId: string) =>
  cafeRecipeLines(cafeMenu.value.find((item) => item.id === itemId));
/** 某原料餵得到的菜單品項(取代已移除的 `usedIn`)。 */
const ingredientUse = (ingredientId: string) => cafeIngredientMenuUse(ingredientId, cafeMenu.value);
/** 全店層級:過去 7 日最該補的原料(害最多單的那些),給排行卡的總結用。 */
/** 收起「常備量」時,標題列要能直接看出「有沒有東西該補」。 */
const blamedIngredients = computed(() => CAFE_INGREDIENTS.filter((item) => (shortageBlame.value[item.id] ?? 0) > 0));
const topBlamed = computed(() => CAFE_INGREDIENTS
  .map((item) => ({ id: item.id, name: item.name, times: shortageBlame.value[item.id] ?? 0 }))
  .filter((row) => row.times > 0)
  .sort((a, b) => b.times - a.times));

const trackLabel = { coffee: "咖啡", bakery: "烘焙", pet: "寵物餐" } as const;
const audienceLabel: Record<string, string> = {
  daily: "日常客",
  single_origin: "單品愛好者",
  photo: "拍照客",
  cold_drink: "冰飲客",
  sweet: "甜食客",
  afternoon_tea: "下午茶客",
  family: "親子／打卡客",
  pet_family: "寵物家庭",
  pet_companion: "毛孩同行客",
  celebration: "慶生客",
};

/**
 * `afterCommit` 在扣款之後、`save()` 之前跑,回傳要接在成功訊息後面的補述。
 * 開張贈品要走這條路(擺放會動 `placements`,必須一起進存檔)。
 */
function commitInvestment(result: CafeInvestmentResult, successText: string, afterCommit?: () => string) {
  if (!result.ok) {
    emit("done", `操作失敗:${result.reason}`);
    return;
  }
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳支出", result.category ?? "cafe");
  const extra = afterCommit?.() ?? "";
  save();
  emit("done", successText + extra);
}

/**
 * 開張。開張費 $12,000 的文案本來就含「第一批備品」,所以基本家具是**免費贈送**
 * (`placeCafeStarterSet()` 完全不碰金流)。
 *
 * 只擺一次:`openCafe()` 已開張時直接 reject ⇒ `afterCommit` 不會跑第二次。
 * 存檔往返只還原 `placements` 陣列、不重跑本函式;玩家事後搬走或賣掉也不會被塞回來。
 */
function onOpen() {
  commitInvestment(openCafe(state.cafe, state.money), "☕ 一樓寵物咖啡廳正式開張!", () => {
    const placed = placeCafeStarterSet();
    return placed.length > 0 ? `已免費擺上 ${placed.length} 件基本家具,可自由搬動或賣出` : "";
  });
}

function onBuy(id: string, name: string) {
  commitInvestment(buyCafeUpgrade(state.cafe, state.money, id), `✅ 「${name}」投資完成!`);
}

/**
 * 雇用/資遣。**不扣任何一次性費用**——薪資是 `tick.ts` 日結時扣的固定成本
 * (`hireCafeStaff()` 的註解說明了為什麼不共用投資那條路)。這裡只寫回 state 並存檔,
 * 吧台後的人數下一幀就跟著變(`FloorMap` 讀同一個 `cafeStaffCount()`)。
 */
function onHire() {
  const result = hireCafeStaff(state.cafe);
  if (!result.ok) { emit("done", `無法雇用:${result.reason}`); return; }
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `👤 已雇用第 ${result.extraStaff + 1} 位店員,日薪合計 −$${result.dailyWage.toLocaleString()}`);
}

function onFire() {
  const result = fireCafeStaff(state.cafe);
  if (!result.ok) { emit("done", `無法資遣:${result.reason}`); return; }
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `已資遣一位店員,現在吧台後有 ${result.extraStaff + 1} 人,日薪合計 −$${result.dailyWage.toLocaleString()}`);
}

function onStartResearch(id: string) {
  const result = startCafeResearch(state.cafe, state.money, id, currentDay.value);
  if (!result.ok) {
    emit("done", `無法開始研發：${result.reason}`);
    return;
  }
  Object.assign(state.cafe, result.cafe);
  addMoney(-result.cost, result.label ?? "咖啡廳研發", result.category ?? "cafe");
  save();
  emit("done", `🧪 「${result.research?.name ?? id}」開始研發，${result.research?.days ?? 0} 天後完成`);
}

function researchRequirement(item: (typeof CAFE_RESEARCH)[number]) {
  const missingResearch = item.requiresResearch
    .filter((id) => !completedResearch.value.has(id))
    .map((id) => getCafeResearch(id)?.name ?? id);
  const missingUpgrades = item.requiresUpgrades
    .filter((id) => !state.cafe.upgrades.includes(id))
    .map((id) => getCafeUpgrade(id)?.name ?? id);
  return [...missingResearch, ...missingUpgrades].join("＋");
}

function researchButtonText(item: (typeof CAFE_RESEARCH)[number]) {
  if (state.cafe.research) return "已有研發進行中";
  const missing = researchRequirement(item);
  if (missing) return `需先完成 ${missing}`;
  if (state.money < item.cost) return "資金不足";
  return `投入 $${item.cost.toLocaleString()} · ${item.days} 天`;
}

watch(currentDay, (day) => {
  const result = advanceCafeResearch(state.cafe, day);
  if (!result.changed) return;
  Object.assign(state.cafe, result.cafe);
  save();
  emit("done", `🎉 「${result.completed?.name ?? "咖啡廳研發"}」完成，新品已加入菜單`);
}, { immediate: true });

/**
 * 常備量的輸入夾值。
 *
 * 🔴 2026-08-08 修 bug:上限原本是 **99**,但內建建議值裡咖啡豆就是 **130**,
 * 「依上週銷量建議」在成長期之後更會算到 140+。玩家一按「套用常備量」,
 * 咖啡豆就被無聲砍到 99 ⇒ 每天固定撲空、面板卻只寫「招牌美式咖啡 缺貨 N」,
 * 正是使用者回報的「原料和商品對不起來、賺不太到錢」。
 *
 * 實測(招牌 Lv4 + 4 位額外店員、每天照建議值套用、56 天平均):
 * 上限 99 ⇒ 撲空 4.4/日、營收 $1,796;上限 999 ⇒ 撲空 0.5/日、營收 $1,929。
 *
 * 999 不是平衡旋鈕而是防呆:名店期尖峰需求約 240 單位,999 遠高於它,
 * 又擋得住手滑連按把數字灌成天文數字(進貨錢是當場真的扣的)。
 */
const MAX_STANDING_ORDER = 999;
function safeUnits(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_STANDING_ORDER, Math.max(0, Math.floor(n))) : 0;
}

function resetSuggestedOrders() {
  Object.assign(orderDraft, suggestedStandingOrders());
}

/**
 * 常備量的 ±1／±5 快捷(使用者要求)。動的是**草稿**,語意與直接打字完全相同
 * ——仍然要按「套用常備量」才會寫進存檔。夾在 0 ～ `MAX_STANDING_ORDER`,
 * 草稿是空字串或 NaN 時(輸入框被清空)當 0 起算。
 */
function bumpOrder(id: string, delta: number) {
  orderDraft[id] = safeUnits(safeUnits(orderDraft[id]) + delta);
}

/**
 * 拍板 Q3 的懶人路線:一鍵把常備量草稿設成「過去 7 個遊戲日的實際消耗」。
 *
 * 算式與 fallback 全部在 `suggestStandingOrdersFromSales()`(純函式、有測試);
 * 這裡只負責寫進草稿並告訴玩家依據了幾天資料——**還是要按「套用常備量」才生效**,
 * 與既有的「恢復建議」按鈕行為一致,不會偷偷改玩家的設定。
 */
function suggestOrdersFromSales() {
  const result = suggestStandingOrdersFromSales(state.cafe.sales, cafeMenu.value, CAFE_SALES_WINDOW_DAYS);
  Object.assign(orderDraft, result.orders);
  emit("done", result.fallback
    ? "📈 還沒有銷售紀錄，先帶入內建建議值；營業幾天後再按一次會更準"
    : `📈 已依過去 ${result.days} 個遊戲日的尖峰銷量填好草稿，確認後按「套用常備量」`);
}

function applyStandingOrders() {
  state.cafe.standingOrders = Object.fromEntries(
    CAFE_INGREDIENTS.map((item) => [item.id, safeUnits(orderDraft[item.id])]),
  );
  Object.assign(orderDraft, state.cafe.standingOrders);
  save();
  emit("done", "📦 常備量已套用，明天開店前（09:00）會依這份清單進貨");
}

function removeHandledGuest(guestId: string) {
  const next = removeCafeGuest(state.cafe.guests, guestId);
  state.cafe.guests.splice(0, state.cafe.guests.length, ...next);
  save();
}

function onAcceptAdoption(guest: CafeGuest) {
  const available = eligiblePets.value;
  const petId = available.some((entry) => entry.id === selectedPet[guest.id])
    ? selectedPet[guest.id]
    : available[0]?.id;
  if (!petId) {
    emit("done", "目前沒有可由咖啡廳顧客認養的永久樓寵物");
    return;
  }
  const result = acceptCafeGuestAdoption(guest, petId);
  if (result.ok) removeHandledGuest(guest.id);
  emit("done", result.text);
}

function onDeclineAdoption(guest: CafeGuest) {
  removeHandledGuest(guest.id);
  emit("done", `已婉拒 ${guest.name} 的認養詢問，寵物仍留在樓裡`);
}

/** 空的 v-model 會讓 <select> 顯示空白列，所以顯示值一律回退到第一間空房，跟接受時的回退一致。 */
function onSelectRoom(guestId: string, event: Event) {
  selectedRoom[guestId] = (event.target as HTMLSelectElement).value;
}

function onAcceptRentInquiry(guest: CafeGuest) {
  const available = vacantRooms.value;
  const roomId = available.some((room) => room.id === selectedRoom[guest.id])
    ? selectedRoom[guest.id]
    : available[0]?.id;
  if (!roomId) {
    emit("done", "目前沒有空房可以帶咖啡廳顧客看");
    return;
  }
  const result = acceptCafeGuestApplicant(guest, roomId);
  if (result.ok) removeHandledGuest(guest.id);
  emit("done", result.text);
}

function onDeclineRentInquiry(guest: CafeGuest) {
  removeHandledGuest(guest.id);
  emit("done", `已婉拒 ${guest.name} 的租屋詢問，空房繼續照原本的招租流程走`);
}

const money = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString()}`;
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <section class="panel" aria-label="咖啡廳營運面板">
      <OpsTabs active="cafe" @select="emit('switchTab', $event)" @close="emit('close')" />

      <div class="body">
        <section v-if="!state.cafe.open" class="opening-card">
          <span class="opening-icon">☕</span>
          <h3>把一樓正式打開吧</h3>
          <p>完成執照、設備檢查與第一批備品，<b>並免費附贈整套店面家具</b>(吧台 ×1、小圓桌 ×3、
            椅子 ×6)。開張後才會產生客流、補貨與日結紀錄;家具的舒適與風格還會轉成<b>氛圍加成</b>,
            讓客流變多。</p>
          <div class="opening-money">
            <span>開張費</span><strong>${{ CAFE_OPENING_COST.toLocaleString() }}</strong>
          </div>
          <div class="opening-money subtle">
            <span>目前資金</span><b>${{ state.money.toLocaleString() }}</b>
          </div>
          <button class="primary" :disabled="state.money < CAFE_OPENING_COST" @click="onOpen">
            {{ state.money < CAFE_OPENING_COST ? "資金不足" : `支付 $${CAFE_OPENING_COST.toLocaleString()}，正式開張` }}
          </button>
          <p class="micro">開張後不可退費；常備量仍由你決定，不會暗自替你進貨。</p>
        </section>

        <template v-else>
          <section class="overview" aria-label="咖啡廳營運摘要">
            <div><span>最近單數</span><strong>{{ latest?.guests ?? "—" }}</strong></div>
            <div><span>人氣</span><strong>{{ Math.round(state.cafe.popularity) }}</strong></div>
            <div><span>最近淨利</span><strong :class="{ loss: (latest?.net ?? 0) < 0 }">{{ latest ? money(latest.net) : "—" }}</strong></div>
          </section>

          <section class="card status-card">
            <button class="section-head" :class="{ collapsed: !openSections.today }" :aria-expanded="openSections.today" @click="toggleSection('today')">
              <div><span class="kicker">TODAY</span><h3>營運觀察</h3></div>
              <span class="capacity">想上門 {{ typicalBase }} · 產能 {{ capability.capacity }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.today">
            <!--
              🔴 可見性批次的主角:落差三格。主數字一律「一般日」(天氣＝星期＝1.0),
              當日值只放小字 —— 否則玩家週一與週六會看到互相矛盾的結論。
            -->
            <div class="gap-grid">
              <div>
                <span>想上門</span><b>{{ typicalBase }} 人</b>
                <small>一般日・今天 {{ todayCrowd.base }}</small>
              </div>
              <div>
                <span>做得出來</span><b>{{ capability.capacity }} 單</b>
                <small>產能上限</small>
              </div>
              <div :class="bottleneck.turnedAway > 0 ? 'miss' : 'ok'">
                <span>沒接到</span><b>{{ bottleneck.turnedAway }} 人</b>
                <small>{{ bottleneck.turnedAway > 0 ? "每天" : "產能吃得下" }}</small>
              </div>
            </div>
            <p class="alert" :class="bottleneck.kind === 'demand' ? 'good' : 'warn'">{{ bottleneckAdvice }}</p>
            <p v-if="turnawayWindow.sum > 0" class="alert bad">
              📉 過去 {{ turnawayWindow.days }} 天有 <b>{{ turnawayWindow.sum }} 位</b>客人因為做不出來而沒接到（平均 {{ turnawayWindow.avg }} 人／日），其中 {{ turnawayWindow.abandoned }} 位是真的排進隊伍才轉身離開的。這些人不會出現在營收，也不會出現在銷售排行 —— 產能夠了，他們就是錢。
            </p>
            <p v-else-if="turnawayWindow.days > 0" class="alert good">
              ✓ 過去 {{ turnawayWindow.days }} 天沒有人因為產能不足而落空。
            </p>
            <div class="status-grid">
              <div><span>熱銷品</span><b>{{ hotItem }}</b></div>
              <div><span>最近營收</span><b>{{ latest ? money(latest.revenue) : "尚無資料" }}</b></div>
              <div><span>一樓家具</span><b>{{ cafeFurnitureCount }} 件</b></div>
              <div><span>氛圍加成</span><b>客流 ×{{ ambianceMultiplier.toFixed(2) }}</b></div>
            </div>
            <!-- 🔴 氛圍吃滿之後多買的家具對客流是 0。不講,玩家就會繼續買下去。 -->
            <p v-if="ambianceFull" class="alert warn">
              🪑 氛圍 {{ ambiancePoints }} / {{ CAFE_AMBIANCE_FULL_POINTS }} 點 —— <b>已達上限，客流 ×{{ (1 + CAFE_AMBIANCE_SWING).toFixed(2) }} 不會再往上</b>。<template v-if="ambianceOverflow > 0">多出來的 {{ ambianceOverflow }} 點對客流沒有作用，</template><template v-else>再多擺一件對客流也不會有作用，</template>還想買家具的話挑<b>有機能</b>的：點餐吧台／濃縮咖啡機（擺吧台區 → 服務位）、貨架／木箱／冷藏櫃（擺後場 → 庫存）、椅子與圓桌（→ 席次）、貓跳台／軟墊（擺寵物區 → 認養）。
            </p>
            <p v-else class="alert" :class="ambiancePoints > 0 ? 'good' : 'warn'">
              🪑 氛圍 {{ ambiancePoints }} / {{ CAFE_AMBIANCE_FULL_POINTS }} 點（一樓家具的舒適＋風格總和）—— 目前客流 ×{{ ambianceMultiplier.toFixed(2) }}，再加 {{ CAFE_AMBIANCE_FULL_POINTS - ambiancePoints }} 點就吃滿 +{{ Math.round(CAFE_AMBIANCE_SWING * 100) }}%。
            </p>
            <!-- 🔴 A 批:地板分區的第二條機能。擺對區(寵物區)的貓跳台／軟墊才算進來。 -->
            <p class="alert" :class="petComfort > 0 ? 'good' : 'warn'">
              🐈 寵物區舒適 {{ petComfort }} 點<template v-if="petComfort > 0">
                → 認養詢問 {{ petIntentWeights.adopt }}%、寵物在一樓待到 {{ petStayEndHour }}:00</template><template v-else>
                （把貓跳台或軟墊擺進<b>寵物區</b>才算數，擺主廳只有氛圍分）</template>。
            </p>
            <!-- 舊的那句含糊提示已由上方 cafeBottleneckAdvice() 取代:它只說「滿載」,
                 沒說滿的是席次、吧台還是人手,而三者的解法完全不同。 -->
            <p v-if="predictedShortages.length" class="alert bad">⚠️ 依最近客流預估會缺：{{ predictedShortages.join("、") }}</p>
            <p v-else-if="latest" class="alert good">✓ 目前庫存足以應付最近一次的客流。</p>
            <p v-else class="empty">完成第一次日結後，這裡會顯示熱銷品與缺貨預估。</p>
            </template>
          </section>

          <section class="card research-card" aria-label="咖啡廳研發">
            <button class="section-head" :class="{ collapsed: !openSections.research }" :aria-expanded="openSections.research" @click="toggleSection('research')">
              <div><span class="kicker">RESEARCH</span><h3>新品研發</h3></div>
              <span class="research-count">{{ completedResearchCount }} / {{ CAFE_RESEARCH.length }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.research">
            <p class="section-note">同時只能進行一項；倒數以遊戲日計算，完成後新品會直接加入菜單。</p>

            <article v-if="state.cafe.research" class="active-research">
              <div class="active-research-head">
                <div>
                  <span>研發進行中</span>
                  <b>{{ activeResearch?.name ?? state.cafe.research.id }}</b>
                </div>
                <strong>{{ researchDaysLeft ?? 0 }} 天</strong>
              </div>
              <p>{{ activeResearch?.effect ?? "這項研發資料等待後續版本修復。" }}</p>
              <div class="progress" role="progressbar" :aria-valuenow="researchProgress" aria-valuemin="0" aria-valuemax="100">
                <i :style="{ width: `${researchProgress}%` }"></i>
              </div>
              <small>已投入 ${{ state.cafe.research.invested.toLocaleString() }} · 進度 {{ researchProgress }}%</small>
            </article>

            <p v-if="!remainingResearch.length && !state.cafe.research" class="research-complete">🏆 研發已全部完成</p>
            <div v-else-if="!state.cafe.research" class="research-list">
              <article v-for="item in remainingResearch" :key="item.id" class="research-item" :class="{ locked: !availableResearchIds.has(item.id) }">
                <div class="research-item-head">
                  <b>{{ item.name }}</b>
                  <span>{{ trackLabel[item.track] }} · 第 {{ item.level }} 層</span>
                </div>
                <p>{{ item.effect }}</p>
                <small>完成後：{{ item.menuItem }} ${{ item.menuPrice }} · {{ audienceLabel[item.audience] }}</small>
                <button
                  class="secondary research-action"
                  :disabled="!availableResearchIds.has(item.id) || state.money < item.cost"
                  @click="onStartResearch(item.id)"
                >
                  {{ researchButtonText(item) }}
                </button>
              </article>
            </div>
            <p v-else class="research-paused">其餘研發已暫停選擇；目前項目完成後會重新開放。</p>
            </template>
          </section>

          <section class="card menu-card" aria-label="咖啡廳菜單">
            <button class="section-head" :class="{ collapsed: !openSections.menu }" :aria-expanded="openSections.menu" @click="toggleSection('menu')">
              <div><span class="kicker">MENU</span><h3>目前菜單</h3></div>
              <span class="ticket">平均客單 ${{ cafeAverageTicket }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.menu">
            <div class="menu-list">
              <div v-for="item in cafeMenu" :key="item.id" class="menu-item">
                <span><b>{{ item.name }}</b><small>{{ audienceLabel[item.audience] }}</small></span>
                <strong>${{ item.price }}</strong>
              </div>
            </div>
            <p class="menu-note">平均客單 = 目前菜單標價的平均。第三層研發（$58～64 的高價品）要先把招牌升級才解得開。</p>
            </template>
          </section>

          <section class="card sales-card" aria-label="咖啡廳銷售排行">
            <button class="section-head" :class="{ collapsed: !openSections.sales }" :aria-expanded="openSections.sales" @click="toggleSection('sales')">
              <div><span class="kicker">SALES</span><h3>銷售排行</h3></div>
              <span class="window">過去 {{ salesDays }} 日<template v-if="salesTotalMissed > 0"> · 缺貨 {{ salesTotalMissed }}</template></span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.sales">
            <p v-if="!salesHasData" class="empty">還沒有銷售紀錄；營業一天之後這裡會列出每個品項賣了幾杯、又有幾次做不出來。</p>
            <template v-else>
              <p class="section-note">依賣出杯數排序。<b class="miss-word">缺貨次數</b>是有人想買、你卻做不出來的次數——那是正在流掉的錢。每一列都寫著它吃哪些原料。</p>
              <ol class="rank-list">
                <li v-for="(row, i) in salesRanking" :key="row.id" class="rank-row" :class="{ quiet: row.sold === 0 }">
                  <div class="rank-main">
                    <span class="rank-no">{{ i + 1 }}</span>
                    <div class="rank-body">
                      <div class="rank-line">
                        <b>{{ row.name }}</b>
                        <span class="rank-sold">{{ row.sold }} 杯</span>
                      </div>
                      <div class="rank-bar"><i :style="{ width: `${soldBarWidth(row.sold)}%` }"></i></div>
                    </div>
                    <span v-if="row.missed > 0" class="rank-miss">缺貨 {{ row.missed }}</span>
                    <span v-else class="rank-ok">—</span>
                  </div>
                  <!-- 🔴 缺貨 → 原料:讀的是結帳當下真的不夠的那項原料,不是拿配方猜的 -->
                  <p v-if="row.missed > 0 && itemShortage(row.id).length" class="rank-fix">
                    <span class="fix-tag">要補</span>
                    <span v-for="cause in itemShortage(row.id)" :key="cause.id" class="fix-item">
                      <b>{{ cause.name }}</b>
                      <small v-if="cause.units > 0">每份 ×{{ cause.units }}，這 {{ cause.times }} 單共差 {{ cause.unitsShort }} 單位</small>
                      <small v-else>害了 {{ cause.times }} 單</small>
                    </span>
                  </p>
                  <p v-else class="rank-recipe">
                    <span class="recipe-tag">配方</span>
                    <span v-if="itemRecipe(row.id).length">
                      <span v-for="line in itemRecipe(row.id)" :key="line.id" class="recipe-item">{{ line.name }} ×{{ line.units }}</span>
                    </span>
                    <span v-else class="recipe-empty">尚未登記</span>
                  </p>
                </li>
              </ol>
              <p v-if="salesTotalMissed > 0" class="alert warn miss-total">
                過去 {{ salesDays }} 日共 {{ salesTotalMissed }} 位客人空手離開。
                <template v-if="topBlamed.length">
                  <br>最該補的是<b class="blame-name" v-for="(row, i) in topBlamed" :key="row.id">{{ i > 0 ? "、" : "" }}{{ row.name }}（{{ row.times }} 單）</b>——到下面的「常備量」把它調高。
                </template>
                <template v-else><br>照上面每一列的配方，把對應的原料常備量調高。</template>
              </p>
              <p v-else class="miss-none">過去 {{ salesDays }} 日沒有任何一位客人撲空，備料節奏抓得剛好。</p>
            </template>
            </template>
          </section>

          <section class="card">
            <!-- 「恢復建議／依上週銷量建議」不能留在標題列:那會變成 button 裡包 button。 -->
            <button class="section-head" :class="{ collapsed: !openSections.stock }" :aria-expanded="openSections.stock" @click="toggleSection('stock')">
              <div><span class="kicker">STOCK</span><h3>常備量</h3></div>
              <span class="blamed-count" v-if="blamedIngredients.length">⚠️ {{ blamedIngredients.length }} 項該補</span>
              <!-- 🔴 A 批:後場(灰色地板)擺的貨架/木箱/冷藏決定放得下多少 -->
              <span class="storage-badge" :class="{ over: storageOver }">後場 {{ storedUnits }} / {{ storageCapacity }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.stock">
            <div class="storage-meter">
              <div class="progress load" :class="{ full: storageOver }" role="progressbar" :aria-valuenow="storagePercent" aria-valuemin="0" aria-valuemax="100">
                <i :style="{ width: `${storagePercent}%` }"></i>
              </div>
              <small>後場容量 {{ storageCapacity }} 單位（{{ backStoragePoints }} 點收納）· 目前放著 {{ storedUnits }} 單位</small>
            </div>
            <p v-if="storageOver" class="alert bad">
              📦 後場放不下了：到<b>後場（最下面那條灰色地板）</b>擺後場備品貨架或進貨木箱，容量才會變大。放不下的部分今天補不進來（既有庫存不會被丟掉）。
            </p>
            <div class="order-tools">
              <button class="ghost" @click="resetSuggestedOrders">恢復建議</button>
              <button class="ghost suggest" @click="suggestOrdersFromSales">依上週銷量建議</button>
            </div>
            <p class="section-note">每天<b>開店前（09:00）</b>自動補到這個數量、當場扣款；先改草稿，按下套用才會保存。
              每一列都寫著這個原料<b>餵哪些商品</b>，以及它最近<b class="miss-word">害幾單做不出來</b>。</p>
            <div class="order-list">
              <!-- 2026-08-09:改 label → div。加了 ± 鈕之後,button 包在 label 裡點一下會連帶 focus 輸入框;
                   輸入框本來就有 aria-label,不需要 label 的隱含關聯。 -->
              <div v-for="item in CAFE_INGREDIENTS" :key="item.id" class="order-row" :class="{ blamed: (shortageBlame[item.id] ?? 0) > 0 }">
                <span>
                  <b>{{ item.name }}</b>
                  <small>庫存 {{ state.cafe.stock[item.id] ?? 0 }} · 單價 ${{ item.unitPrice }}</small>
                  <!-- 🔴 原料 → 品項:從 recipe 推導,不再讀已移除的 usedIn 字串 -->
                  <small class="order-use">
                    <template v-if="ingredientUse(item.id).length">
                      用於 <em v-for="(use, i) in ingredientUse(item.id)" :key="use.id">{{ i > 0 ? "、" : "" }}{{ use.name }} ×{{ use.units }}</em>
                    </template>
                    <template v-else>目前菜單沒有商品用到它</template>
                  </small>
                  <small v-if="(shortageBlame[item.id] ?? 0) > 0" class="order-blame">
                    ⚠️ 過去 {{ salesDays }} 日害 {{ shortageBlame[item.id] }} 單做不出來
                  </small>
                </span>
                <div class="order-stepper">
                  <button class="step" :disabled="safeUnits(orderDraft[item.id]) <= 0" :aria-label="`${item.name}常備量減 5`" @click="bumpOrder(item.id, -5)">−5</button>
                  <button class="step" :disabled="safeUnits(orderDraft[item.id]) <= 0" :aria-label="`${item.name}常備量減 1`" @click="bumpOrder(item.id, -1)">−1</button>
                  <input v-model.number="orderDraft[item.id]" type="number" inputmode="numeric" min="0" :max="MAX_STANDING_ORDER" :aria-label="`${item.name}常備量`">
                  <button class="step" :disabled="safeUnits(orderDraft[item.id]) >= MAX_STANDING_ORDER" :aria-label="`${item.name}常備量加 1`" @click="bumpOrder(item.id, 1)">+1</button>
                  <button class="step" :disabled="safeUnits(orderDraft[item.id]) >= MAX_STANDING_ORDER" :aria-label="`${item.name}常備量加 5`" @click="bumpOrder(item.id, 5)">+5</button>
                </div>
              </div>
            </div>
            <button class="primary compact" @click="applyStandingOrders">套用常備量</button>
            </template>
          </section>

          <section class="card staff-card" aria-label="咖啡廳人力">
            <button class="section-head" :class="{ collapsed: !openSections.staff }" :aria-expanded="openSections.staff" @click="toggleSection('staff')">
              <div><span class="kicker">STAFF</span><h3>人力</h3></div>
              <span class="staff-wage">{{ staffCount }} 人 · 日薪 −${{ capability.dailyWage.toLocaleString() }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.staff">
            <div class="staff-line">
              <span class="staff-faces" aria-hidden="true">{{ "👤".repeat(Math.min(6, staffCount)) }}<b v-if="staffCount > 6">×{{ staffCount }}</b></span>
              <span class="staff-count">目前 {{ staffCount }} 人<small>（首位店員的薪水已含在每日固定開銷裡）</small></span>
            </div>
            <div class="staff-load">
              <div class="staff-load-line">
                <span>今日負荷</span>
                <b :class="{ full: loadFull }">已處理 {{ todayServed }} / 產能 {{ capability.capacity }} 杯</b>
              </div>
              <div class="progress load" :class="{ full: loadFull }" role="progressbar" :aria-valuenow="loadPercent" aria-valuemin="0" aria-valuemax="100">
                <i :style="{ width: `${loadPercent}%` }"></i>
              </div>
              <small>產能 = min(席次 {{ seatCount }} 張換算的內用量, 可用店員 {{ capability.activeStaff }} 人 × {{ capability.cupsPerStaff }} 杯)</small>
            </div>
            <!-- 🔴 A 批:吧台寬度 = 同時服務人數。沒有吧台位置的店員薪水照付卻做不出杯子。 -->
            <p class="alert" :class="capability.idleStaff > 0 ? 'warn' : 'good'">
              🧑‍🍳 服務位 {{ serviceStations }} / 店員 {{ staffCount }} 人<template v-if="capability.idleStaff > 0">
                —— 有 {{ capability.idleStaff }} 位沒有吧台位置。<b>加寬吧台</b>（在吧台區再擺一座點餐吧台，或把濃縮咖啡機也放進吧台區）才能讓他們上工。</template><template v-else>
                —— 每位店員都站得上吧台。</template>
            </p>
            <p class="alert" :class="loadFull ? 'warn' : 'good'">
              {{ loadFull
                ? (capability.idleStaff > 0
                  ? "🧍 今天已經做到產能上限——先加寬吧台讓閒著的店員上工，那比再雇人有效。"
                  : "🧍 今天已經做到產能上限——想再多賣就得加席次、加寬吧台或補人,否則吧台前只會越排越長。")
                : "產能還有餘裕。真正該雇人的訊號在畫面上：吧台前排起隊、店員忙個不停。" }}
            </p>
            <div class="staff-actions">
              <button class="secondary" :disabled="extraStaffCount >= CAFE_MAX_EXTRA_STAFF" @click="onHire">
                {{ extraStaffCount >= CAFE_MAX_EXTRA_STAFF ? "已達人力上限" : `雇用（−$${CAFE_STAFF_WAGE}/日）` }}
              </button>
              <button class="ghost fire" :disabled="extraStaffCount <= 0" @click="onFire">
                {{ extraStaffCount <= 0 ? "只剩首位店員" : "資遣" }}
              </button>
            </div>
            </template>
          </section>

          <section class="card">
            <button class="section-head" :class="{ collapsed: !openSections.invest }" :aria-expanded="openSections.invest" @click="toggleSection('invest')">
              <div><span class="kicker">INVEST</span><h3>永久投資</h3></div>
              <span class="balance">{{ state.cafe.upgrades.length }} / {{ CAFE_UPGRADES.length }} 已完成</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.invest">
            <p class="section-note">一次性、不可退；購買後永久生效。目前資金 <b>${{ state.money.toLocaleString() }}</b>。</p>
            <!--
              🔴 分組只發生在這裡(Vue 層)。`CAFE_UPGRADE_IDS` 的鍵名/值/順序一格未動。
            -->
            <div v-for="group in upgradeGroups" :key="group.key" class="upgrade-group">
            <h4 class="group-head">{{ group.title }}</h4>
            <p class="section-note">{{ group.note }}</p>
            <div class="upgrade-list">
              <article v-for="item in group.items" :key="item.id" class="upgrade" :class="{ owned: state.cafe.upgrades.includes(item.id) }">
                <div class="upgrade-head">
                  <b>{{ item.name }}</b>
                  <span v-if="state.cafe.upgrades.includes(item.id)" class="owned-label">✓ 已完成</span>
                  <strong v-else>${{ item.price.toLocaleString() }}</strong>
                </div>
                <p>{{ item.effect }}</p>
                <!--
                  🔴 「這一項買下去會怎樣」。文字**全部**來自 cafeInvestOutlook(),
                  template 不寫死任何一句 —— 它用差分(再呼叫一次真的 cafeCapability()
                  與 cafeTypicalBase())算出來,所以文案不可能與公式漂開。
                  刻意**不加 CSS transition**:跨界線時 chip 翻面是真的狀態改變,不是抖動。
                -->
                <span
                  v-if="!state.cafe.upgrades.includes(item.id) && investOutlook(item.id).text"
                  class="outlook" :class="investOutlook(item.id).tone"
                >{{ investOutlook(item.id).text }}</span>
                <button
                  v-if="!state.cafe.upgrades.includes(item.id)"
                  class="secondary"
                  :disabled="state.money < item.price"
                  @click="onBuy(item.id, item.name)"
                >
                  {{ state.money < item.price ? "金錢不足" : `投資 −$${item.price.toLocaleString()}` }}
                </button>
              </article>
            </div>
            </div>
            </template>
          </section>

          <section class="card">
            <button class="section-head" :class="{ collapsed: !openSections.regulars }" :aria-expanded="openSections.regulars" @click="toggleSection('regulars')">
              <div><span class="kicker">REGULARS</span><h3>常客</h3></div>
              <span class="regular-summary">{{ regulars.length }} / {{ CAFE_REGULAR_CAP }} 位<template v-if="regulars.length">・最久 {{ regularMaxAway }} 天沒來</template></span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.regulars">
            <p v-if="!regulars.length" class="empty">還沒有人固定來。同一位客人累積 3 個來訪日就會成為常客——大約四、五個遊戲日之後見。</p>
            <p v-else class="section-note">常客會自己回來、點「老樣子」，好感夠高還會留小費或帶朋友來。<b>這裡沒有按鈕</b>：他們是你經營出來的結果，不是待辦事項。</p>
            <div v-for="regular in regulars" :key="regular.name" class="regular-row">
              <div class="regular-line">
                <span>{{ regular.affection >= CAFE_REGULAR_FRIEND_AFFECTION ? "🌟" : "☕" }}</span>
                <b>{{ regular.name }}</b>
                <small>來訪 {{ regular.visits }} 次・{{ regularTasteLabel(regular.taste) }}客</small>
              </div>
              <div class="affection-meter">
                <div class="bar"><i :style="{ width: `${regular.affection}%` }" /></div>
                <small>好感 {{ regular.affection }}</small>
              </div>
              <small class="regular-note">
                <template v-if="regularUsualName(regular)">老樣子「{{ regularUsualName(regular) }}」・</template>
                <template v-if="regularAway(regular) <= 0">今天來過</template>
                <template v-else>{{ regularAway(regular) }} 天前來過</template>
                <template v-if="regularAway(regular) >= CAFE_REGULAR_LAPSE_DAYS"><b class="lapsing">・快要失聯了</b></template>
              </small>
            </div>
            </template>
          </section>

          <section class="card adoption-card">
            <button class="section-head" :class="{ collapsed: !openSections.adoption }" :aria-expanded="openSections.adoption" @click="toggleSection('adoption')">
              <div><span class="kicker">ADOPTION</span><h3>認養詢問</h3></div>
              <span class="count">{{ adoptGuests.length }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.adoption">
            <!--
              🔴 認養「結果」行:貓跳台買到的是內容不是營收,所以要用**送養隻數**結案。
              兩個數字都推自既有存檔(`state.petHomes`),沒有新增存檔欄位。
            -->
            <p class="alert" :class="cafeAdoptedHomes.length > 0 ? 'good' : 'note'">
              💗 現在有 {{ adoptGuests.length }} 位客人來問認養 · 最近 {{ CAFE_ADOPT_RECENT_DAYS }} 天成功送養
              <b>{{ cafeAdoptedRecent }}</b> 隻（累計 {{ cafeAdoptedHomes.length }} 隻）
              <template v-if="!cafeAdoptedHomes.length"> —— 還沒有送出去過；貓跳台與軟墊拉高的是「有人來問」的機率，成交要靠你在這裡按下接受。</template>
            </p>
            <p v-if="!adoptGuests.length" class="empty">目前沒有顧客詢問認養。</p>
            <article v-for="guest in adoptGuests" :key="guest.id" class="adoption">
              <div class="guest-line">
                <span>💗</span><b>{{ guest.name }}</b>
                <small>想認識一隻樓寵物<template v-if="regularOf(guest.name)">（常客・來訪 {{ regularOf(guest.name)!.visits }} 次）</template></small>
              </div>
              <select v-if="eligiblePets.length" v-model="selectedPet[guest.id]" :aria-label="`${guest.name}的認養對象`">
                <option value="">選擇認養對象</option>
                <option v-for="entry in eligiblePets" :key="entry.id" :value="entry.id">
                  {{ entry.pet.kind === "dog" ? "🐕" : "🐈" }} {{ entry.pet.name }}
                </option>
              </select>
              <p v-else class="alert warn">目前沒有可認養的永久樓寵物。</p>
              <div class="adoption-actions">
                <button class="decline" @click="onDeclineAdoption(guest)">婉拒</button>
                <button class="accept" :disabled="!eligiblePets.length" @click="onAcceptAdoption(guest)">接受認養</button>
              </div>
            </article>
            </template>
          </section>

          <section class="card rent-card">
            <button class="section-head" :class="{ collapsed: !openSections.rent }" :aria-expanded="openSections.rent" @click="toggleSection('rent')">
              <div><span class="kicker">RENT</span><h3>租屋詢問</h3></div>
              <span class="count rent-count">{{ rentGuests.length }}</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.rent">
            <p v-if="!rentGuests.length" class="empty">目前沒有顧客詢問租屋。</p>
            <article v-for="guest in rentGuests" :key="guest.id" class="rent-inquiry">
              <div class="guest-line">
                <span>🔑</span><b>{{ guest.name }}</b>
                <small>在打聽樓上有沒有空房<template v-if="regularOf(guest.name)">（常客・來訪 {{ regularOf(guest.name)!.visits }} 次）</template></small>
              </div>
              <select
                v-if="vacantRooms.length"
                :value="selectedRoom[guest.id] || vacantRooms[0].id"
                :aria-label="`${guest.name}的帶看房間`"
                @change="onSelectRoom(guest.id, $event)"
              >
                <option v-for="room in vacantRooms" :key="room.id" :value="room.id">🚪 帶看 {{ room.label }}</option>
              </select>
              <p v-else class="alert warn">目前沒有空房可以帶看。</p>
              <div class="adoption-actions">
                <button class="decline" @click="onDeclineRentInquiry(guest)">婉拒</button>
                <button class="accept rent-accept" :disabled="!vacantRooms.length" @click="onAcceptRentInquiry(guest)">安排看房</button>
              </div>
            </article>
            </template>
          </section>

          <!-- 🔴 分區小抄:提醒玩家「擺對區才有機能」,資料只讀 content/cafeZoneGuide.ts 這一份真相來源 -->
          <section class="card zones-card">
            <button class="section-head" :class="{ collapsed: !openSections.zones }" :aria-expanded="openSections.zones" @click="toggleSection('zones')">
              <div><span class="kicker">ZONES</span><h3>分區小抄</h3></div>
              <span class="zone-count">5 區</span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
            <template v-if="openSections.zones">
            <div class="zone-legend">
              <div v-for="(info, room) in CAFE_ZONE_INFO" :key="room" class="zone-row">
                <span class="zone-dot" :style="{ background: info.color }"></span>
                <b>{{ info.emoji }} {{ info.label }}</b>
                <small>{{ info.desc }}</small>
              </div>
            </div>
            <div class="zone-furniture">
              <div v-for="(items, room) in zoneFurnitureGroups" :key="room" class="zone-furn-group">
                <span class="zone-furn-head">{{ CAFE_ZONE_INFO[room].emoji }} {{ CAFE_ZONE_INFO[room].label }}</span>
                <span class="zone-furn-list">{{ items.map((i) => i.name).join("、") }}</span>
              </div>
              <div class="zone-furn-group">
                <span class="zone-furn-head">🎈 純氛圍</span>
                <span class="zone-furn-list">菜單板／桌／兩張椅——不分區,隨便擺都算氛圍分</span>
              </div>
            </div>
            <p class="alert good">擺錯區還是拿得到氛圍分(療癒+品味),只是拿不到專屬機能——不是完全沒用,只是少了那一項加成。</p>
            </template>
          </section>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 138; background: rgba(8,7,12,0.74); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 88vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 18px 18px 0 0; display: flex; flex-direction: column; animation: up 0.24s ease-out; overflow: hidden; }
@keyframes up { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
/* 2026-08-09:標題列換成與收支面板共用的 `OpsTabs`(兩者現在是同一顆入口的兩個分頁)。 */
.kicker { color: #d9a778; font-size: 9px; font-weight: 800; letter-spacing: 1.7px; }
.body { overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px calc(22px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 11px; }
.opening-card, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 13px; }
.opening-card { text-align: center; padding: 20px 16px 16px; background: linear-gradient(145deg, rgba(191,119,70,0.13), rgba(82,127,94,0.12)); }
.opening-icon { display: block; font-size: 38px; margin-bottom: 5px; }
.opening-card h3 { margin: 0 0 7px; font-size: 17px; }
.opening-card > p { color: var(--text-dim); font-size: 12px; line-height: 1.65; }
.opening-money { display: flex; justify-content: space-between; align-items: baseline; margin-top: 13px; padding: 9px 11px; border-top: 1px solid var(--line); font-size: 12px; }
.opening-money strong { color: var(--accent); font-size: 20px; }
.opening-money.subtle { margin-top: 0; padding-top: 3px; border-top: 0; color: var(--text-dim); }
.opening-money.subtle b { color: var(--text); }
.primary, .secondary, .accept, .decline, .ghost { border-radius: 9px; font-weight: 700; }
.primary { width: 100%; margin-top: 8px; padding: 10px; color: #271808; background: linear-gradient(135deg, var(--accent), #ff9440); }
.primary:disabled, .secondary:disabled, .accept:disabled { opacity: 0.45; }
.primary.compact { margin-top: 10px; padding: 9px; font-size: 13px; }
.micro { margin: 9px 0 0; font-size: 10.5px !important; }
.overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.overview div { min-width: 0; padding: 10px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 11px; text-align: center; }
.overview span { display: block; color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.overview strong { display: block; margin-top: 3px; color: #bdf1ca; font-size: 16px; overflow: hidden; text-overflow: ellipsis; }
.overview strong.loss { color: #ff9aa8; }
/*
 * 2026-08-09:標題列變成收合開關(整列可點,不是只有小箭頭)。
 * 收起時 `margin-bottom: 0`,那張卡就只剩這一列高。
 */
.section-head { display: flex; align-items: center; gap: 9px; width: 100%; margin-bottom: 7px; padding: 0; background: none; border: 0; color: inherit; font: inherit; text-align: left; }
.section-head.collapsed { margin-bottom: 0; }
/* 標題吃掉剩餘寬度 ⇒ 右邊的摘要與箭頭一律靠右,不管那個摘要有沒有 margin-left: auto */
.section-head > div:first-child { flex: 1; min-width: 0; }
.section-head h3 { margin: 1px 0 0; font-size: 14.5px; }
.chev { color: var(--text-dim); font-size: 11px; line-height: 1; transition: transform 0.15s; }
.section-head.collapsed .chev { transform: rotate(-90deg); }
.blamed-count { margin-left: auto; color: #ffb0a0; font-size: 11px; font-weight: 700; white-space: nowrap; }
/* 🔴 A 批:後場容量徽章。滿出來時轉紅,不必展開就看得到。 */
.storage-badge { margin-left: auto; color: var(--text-dim); font-size: 10.5px; white-space: nowrap; }
.blamed-count + .storage-badge { margin-left: 6px; }
.storage-badge.over { color: #ff9f6b; font-weight: 700; }
.storage-meter { display: grid; gap: 4px; margin: 6px 0 2px; }
.storage-meter small { color: var(--text-dim); font-size: 10.5px; }
.capacity, .balance, .count, .research-count, .ticket, .regular-summary, .zone-count { margin-left: auto; color: var(--text-dim); font-size: 11px; white-space: nowrap; }
/* 🔴 B 批:常客列。純文字 + emoji(同認養卡/租屋卡),不做頭像元件。 */
.regular-row { padding: 9px 10px; border-radius: 10px; border: 1px solid rgba(217,167,120,0.28); background: rgba(217,167,120,0.06); }
.regular-row + .regular-row { margin-top: 7px; }
.regular-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.regular-line b { font-size: 13px; }
.regular-line small { flex: 1; min-width: 0; color: var(--text-dim); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.affection-meter { display: flex; align-items: center; gap: 7px; margin-top: 6px; }
.affection-meter .bar { flex: 1; height: 5px; border-radius: 99px; background: rgba(255,255,255,0.08); overflow: hidden; }
.affection-meter .bar i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #d9a778, #ffb98a); }
.affection-meter small { color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.regular-note { display: block; margin-top: 5px; color: var(--text-dim); font-size: 10.5px; line-height: 1.5; }
.regular-note .lapsing { color: #ffacb7; }
.count { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: rgba(220,100,130,0.18); color: #f4b0c4; font-weight: 700; }
.research-count { color: #b9f6ce; font-weight: 700; }
.ticket { color: #ffd39a; font-weight: 700; }
.section-note, .empty { margin: 0 0 8px; color: var(--text-dim); font-size: 11px; line-height: 1.55; }
.status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.status-grid div { min-width: 0; padding: 8px 9px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.status-grid span { display: block; color: var(--text-dim); font-size: 10px; }
.status-grid b { display: block; margin-top: 2px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 🔴 落差三格:想上門 / 做得出來 / 沒接到。三欄等寬,直式手機 360px 也塞得下
   (每格最窄約 108px,數字用 tabular-nums 不會因位數跳動而換行)。 */
.gap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
.gap-grid div { min-width: 0; padding: 8px 7px; border-radius: 9px; background: rgba(255,255,255,0.03); border: 1px solid var(--line); }
.gap-grid span { display: block; color: var(--text-dim); font-size: 10px; }
.gap-grid b { display: block; margin-top: 2px; font-size: 14px; font-variant-numeric: tabular-nums; }
.gap-grid small { display: block; margin-top: 1px; color: var(--text-dim); font-size: 9.5px; line-height: 1.3; }
.gap-grid .miss { border-color: rgba(232,101,122,0.5); background: rgba(232,101,122,0.09); }
.gap-grid .miss b { color: #ffacb7; }
.gap-grid .ok { border-color: rgba(83,196,126,0.45); background: rgba(83,196,126,0.08); }
.gap-grid .ok b { color: #b9f6ce; }
.alert { margin: 8px 0 0; padding: 7px 9px; border-radius: 8px; font-size: 10.8px; line-height: 1.45; }
.alert.warn { color: #ffd98a; background: rgba(181,135,46,0.11); }
.alert.bad { color: #ffacb7; background: rgba(232,101,122,0.1); }
.alert.good { color: #b9f6ce; background: rgba(83,196,126,0.09); }
/* 2026-09-02:認養結果行在「還沒送養過」時用中性的紫,不要用警示色 —— 那不是錯誤狀態。 */
.alert.note { color: #d9c2ff; background: rgba(150,110,220,0.1); }
.ghost { margin-left: auto; padding: 5px 8px; color: #cdbcff; background: rgba(143,123,255,0.1); border: 1px solid rgba(143,123,255,0.4); font-size: 10.5px; }
.order-tools { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-bottom: 7px; }
.order-tools .ghost { margin-left: 0; }
.ghost.suggest { color: #ffd6a3; background: rgba(255,180,94,0.12); border-color: rgba(255,180,94,0.55); font-weight: 700; }

/* P3 銷售排行 —— 缺貨次數要比賣出杯數更搶眼:那是玩家在虧錢的訊號 */
.window { color: var(--text-dim); font-size: 10.5px; white-space: nowrap; }
.miss-word { color: #ff9fae; }
.rank-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rank-row { padding: 7px 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.rank-main { display: flex; align-items: center; gap: 8px; }
/* 🔴 缺貨 → 原料:整列裡最該被看到的一行,所以給它邊框與紅底 */
.rank-fix { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 7px; margin: 6px 0 0; padding: 5px 7px; border-radius: 7px; border: 1px solid rgba(232,101,122,0.4); background: rgba(232,101,122,0.1); font-size: 10px; line-height: 1.4; }
.fix-tag { flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(232,101,122,0.3); color: #ffd7dd; font-size: 9px; font-weight: 800; }
.fix-item b { color: #ffacb7; font-size: 11px; }
.fix-item small { margin-left: 4px; color: var(--text-dim); font-size: 9.5px; }
.rank-recipe { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; margin: 5px 0 0; color: var(--text-dim); font-size: 9.5px; line-height: 1.4; }
.recipe-tag { flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,0.06); color: #c7bdaf; font-size: 9px; font-weight: 700; }
.recipe-item + .recipe-item::before { content: "・"; }
.recipe-empty { font-style: italic; }
.blame-name { color: #ffd7a8; }
.rank-row.quiet { opacity: 0.5; }
.rank-no { flex: none; display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: rgba(255,180,94,0.16); color: #ffd39a; font-size: 9.5px; font-weight: 800; }
.rank-body { flex: 1; min-width: 0; }
.rank-line { display: flex; align-items: baseline; gap: 8px; }
.rank-line b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.rank-sold { margin-left: auto; color: #ffd39a; font-size: 10.5px; font-weight: 700; white-space: nowrap; }
.rank-bar { margin-top: 4px; height: 4px; border-radius: 3px; background: rgba(255,255,255,0.06); overflow: hidden; }
.rank-bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #cf8b5b, #e8b271); }
.rank-miss { flex: none; padding: 3px 7px; border-radius: 999px; background: rgba(232,101,122,0.18); border: 1px solid rgba(232,101,122,0.5); color: #ffacb7; font-size: 10px; font-weight: 800; white-space: nowrap; }
.rank-ok { flex: none; width: 34px; text-align: center; color: var(--text-dim); font-size: 10px; }
.miss-total { font-weight: 700; }
.miss-none { margin: 8px 0 0; color: var(--good); font-size: 10.8px; line-height: 1.45; }
.order-list, .upgrade-list { display: flex; flex-direction: column; gap: 7px; }
/* 2026-09-02:投資分組。標題只是分隔,不做成可收合(多一層收合會讓玩家找不到東西)。 */
.upgrade-group + .upgrade-group { margin-top: 14px; }
.group-head { margin: 0; font-size: 11.5px; letter-spacing: 0.04em; color: #e6e1f5; }
.upgrade-group .section-note { margin-top: 3px; }
.order-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.order-row > span { min-width: 0; display: flex; flex-direction: column; }
.order-row b { font-size: 12px; }
.order-row small { color: var(--text-dim); font-size: 9.5px; }
/* 🔴 原料 → 品項(從 recipe 推導)與「最近害幾單做不出來」 */
.order-row.blamed { border: 1px solid rgba(232,101,122,0.42); background: rgba(232,101,122,0.07); }
.order-use { margin-top: 2px; line-height: 1.4; }
.order-use em { font-style: normal; color: #d9c7a8; }
.order-blame { margin-top: 3px; color: #ffacb7 !important; font-weight: 700; line-height: 1.4; }
/*
 * 2026-08-09:常備量加 ±1／±5 快捷(使用者要求)。
 * 佔滿一整列而不是擠在原料說明右邊 —— 390px 下 4 顆鈕 + 輸入框跟左邊那三行小字搶寬度,
 * 兩邊都會變得難點也難讀;獨立一列每顆都吃得到 34px 的觸控高度。
 */
.order-row { flex-wrap: wrap; }
.order-row > span { flex: 1 1 100%; }
.order-stepper { display: flex; align-items: center; gap: 5px; width: 100%; margin-top: 6px; }
.order-stepper input { flex: 1; min-width: 0; padding: 6px; border-radius: 7px; border: 1px solid var(--line); background: #17151f; color: var(--text); text-align: center; font: inherit; font-size: 13px; font-weight: 700; }
.step { flex: 0 0 46px; min-height: 34px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.step:hover { background: #322c46; }
.step:disabled { opacity: 0.35; }
.upgrade { padding: 10px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,0.02); }
.upgrade.owned { border-color: rgba(83,196,126,0.4); opacity: 0.76; }
.upgrade-head { display: flex; align-items: baseline; gap: 8px; }
.upgrade-head b { font-size: 12.5px; }
.upgrade-head strong, .owned-label { margin-left: auto; color: var(--accent); font-size: 11.5px; white-space: nowrap; }
.owned-label { color: var(--good); }
.upgrade p { margin: 5px 0 8px; color: var(--text-dim); font-size: 10.5px; line-height: 1.45; }
/* 🔴 投資 chip:綠 = 現在買就有數字、橘 = 買了不會變成錢、紫 = 真實內容但不進營收。
   刻意**沒有 transition**:跨界線時翻面是真的狀態改變(§9-2),不該演成漸變動畫。 */
.outlook {
  display: block; margin: 0 0 8px; padding: 6px 8px; border-radius: 8px;
  font-size: 10.3px; line-height: 1.45; border: 1px solid transparent;
}
.outlook.good { color: #b9f6ce; background: rgba(83,196,126,0.1); border-color: rgba(83,196,126,0.34); }
.outlook.blocked { color: #ffd08a; background: rgba(200,140,50,0.12); border-color: rgba(200,140,50,0.4); }
.outlook.note { color: #d9c2ff; background: rgba(150,110,220,0.12); border-color: rgba(150,110,220,0.36); }
.secondary { width: 100%; padding: 7px; color: #ffd6a3; background: rgba(255,180,94,0.1); border: 1px solid rgba(255,180,94,0.55); font-size: 11.5px; }
.active-research { padding: 11px; border: 1px solid rgba(113,207,145,0.38); border-radius: 11px; background: linear-gradient(135deg, rgba(71,149,100,0.11), rgba(255,180,94,0.06)); }
.active-research-head { display: flex; align-items: center; gap: 10px; }
.active-research-head div { min-width: 0; }
.active-research-head span { display: block; color: #a9e8bd; font-size: 9.5px; font-weight: 700; }
.active-research-head b { display: block; margin-top: 2px; font-size: 13.5px; }
.active-research-head strong { margin-left: auto; color: #ffd39a; font-size: 18px; white-space: nowrap; }
.active-research p { margin: 8px 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.5; }
.active-research small { display: block; margin-top: 6px; color: var(--text-dim); font-size: 9.5px; }
.progress { height: 6px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,0.08); }
.progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #76d39a, #ffc477); transition: width 0.25s ease; }
/* P4b 人力區塊(§4.9):人數、今日負荷進度條、雇用/資遣 */
.staff-card .staff-wage { color: #ffb1a4; font-size: 10.5px; white-space: nowrap; }
.staff-line { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.staff-faces { font-size: 15px; line-height: 1; letter-spacing: -1px; }
.staff-faces b { margin-left: 3px; font-size: 11px; color: #ffd39a; }
.staff-count { color: var(--text); font-size: 11.5px; }
.staff-count small { display: block; color: var(--text-dim); font-size: 9.5px; }
.staff-load-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 10.5px; color: var(--text-dim); }
.staff-load-line b { color: #ffe0b4; font-size: 12px; }
.staff-load-line b.full { color: #ff9f9f; }
.progress.load i { background: linear-gradient(90deg, #76d39a, #ffc477); }
.progress.load.full i { background: linear-gradient(90deg, #ff9f6b, #ff6b6b); }
.staff-load small { display: block; margin-top: 5px; color: var(--text-dim); font-size: 9.5px; }
.staff-actions { display: grid; grid-template-columns: 1.6fr 1fr; gap: 7px; margin-top: 9px; }
.staff-actions .fire { color: #ffb1a4; border-color: rgba(255,140,140,0.4); }
.research-list { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; }
.research-item { padding: 10px; border: 1px solid rgba(255,180,94,0.24); border-radius: 10px; background: rgba(255,180,94,0.035); }
.research-item.locked { border-color: var(--line); background: rgba(255,255,255,0.015); }
.research-item-head { display: flex; align-items: baseline; gap: 7px; }
.research-item-head b { font-size: 12.5px; }
.research-item-head span { margin-left: auto; color: #d9a778; font-size: 9.5px; white-space: nowrap; }
.research-item p { margin: 5px 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.45; }
.research-item > small { color: #c7bdaf; font-size: 9.5px; }
.research-action { margin-top: 8px; }
.research-complete { margin: 3px 0 0; padding: 11px; border-radius: 9px; color: #b9f6ce; background: rgba(83,196,126,0.08); text-align: center; font-size: 11.5px; }
.research-paused { margin: 8px 0 0; color: var(--text-dim); font-size: 10px; text-align: center; }
.menu-list { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.menu-item { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; border-radius: 9px; background: rgba(255,255,255,0.025); }
.menu-item > span { min-width: 0; }
.menu-item b, .menu-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item b { font-size: 10.8px; }
.menu-item small { margin-top: 2px; color: var(--text-dim); font-size: 8.8px; }
.menu-item strong { margin-left: auto; color: #ffd39a; font-size: 11px; }
.menu-note { margin: 8px 0 0; color: var(--text-dim); font-size: 9.5px; line-height: 1.45; }
.adoption { padding: 10px; border-radius: 10px; border: 1px solid rgba(220,100,130,0.35); background: rgba(220,100,130,0.06); }
.adoption + .adoption { margin-top: 8px; }
.guest-line { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
.guest-line b { font-size: 12.5px; }
.guest-line small { min-width: 0; color: var(--text-dim); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adoption select, .rent-inquiry select { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: #17151f; font-size: 12px; }
.adoption-actions { display: grid; grid-template-columns: 1fr 1.35fr; gap: 7px; margin-top: 8px; }
.decline, .accept { padding: 8px; font-size: 11.5px; }
.decline { color: var(--text-dim); background: transparent; border: 1px solid var(--line); }
.accept { color: #21131a; background: #e99ab4; }
.rent-inquiry { padding: 10px; border-radius: 10px; border: 1px solid rgba(143,123,255,0.35); background: rgba(143,123,255,0.06); }
.rent-inquiry + .rent-inquiry { margin-top: 8px; }
.rent-count { background: rgba(143,123,255,0.18); color: #cdbcff; }
.accept.rent-accept { color: #17132c; background: #b5a8f4; }
/* 🔴 分區小抄:五區色卡 + 依區分組的家具清單,資料只讀 content/cafeZoneGuide.ts */
.zone-legend { display: flex; flex-direction: column; gap: 6px; }
.zone-row { display: flex; align-items: baseline; gap: 7px; }
.zone-row b { flex: none; font-size: 11.5px; }
.zone-row small { min-width: 0; color: var(--text-dim); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; }
.zone-furniture { display: flex; flex-direction: column; gap: 5px; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); }
.zone-furn-group { display: flex; align-items: baseline; gap: 6px; font-size: 10.5px; line-height: 1.5; }
.zone-furn-head { flex: none; color: var(--text-dim); }
.zone-furn-list { min-width: 0; }

@media (max-width: 390px) {
  .body { padding-left: 11px; padding-right: 11px; }
  .opening-card, .card { padding: 11px; }
  .overview span { font-size: 9.5px; }
  .overview strong { font-size: 14px; }
}
</style>
