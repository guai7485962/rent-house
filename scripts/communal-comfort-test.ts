/**
 * 共用區舒適度延伸(交誼廳 / 浴室 / 洗衣間)的驗證。
 *
 * 核心驗收點:
 * - **浴室/洗衣間真的拿得到分**——私人房那套 `COMFORT_BUCKETS` 沒有涵蓋 `utility`,
 *   而浴室 3/4 件、洗衣間 5/5 件全是 utility 且 attributes 全空 → 舊公式下洗衣間
 *   結構性拿 0 分、玩家怎麼買都拿不到。共用區自己的 bucket 表(按 `sprite.kind`
 *   細分 utility)必須讓三區都拿得到分、也都拿得到 categoryPart 滿分。
 * - **中性錨點校準成種子樓層實測值** → 種子局三個 delta 皆 === 0 → balance 快照零漂移。
 *   若這條紅了,代表 `COMMUNAL_NEUTRAL` 校準錯了,**回頭修常數,不要 --update 快照**。
 * - **`cozyHomePass` 讀的 `roomComfort` 一位元都不變**——本功能刻意走獨立管道的唯一理由。
 * - 每一區 attrMax + categoryMax + tierMax ≤ 100 → clamp 永不生效、面板加法恆等。
 * - 零 RNG:覆寫 Math.random 並計數,被呼叫就 fail。
 */
// 固定種子 PRNG + localStorage mock —— 必須在載入 store 之前
let seed = 20260730;
const seededRandom = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = seededRandom;
const store = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

await import("../src/store");
const {
  communalAreaBreakdown, communalBreakdown, communalQuality, communalBaselineDelta,
  COMMUNAL_NEUTRAL, COMMUNAL_LIMITS, COMMUNAL_AREA_IDS, COMMUNAL_AREA_LABELS,
  cleanlinessBaseline, cleanlinessMultiplier, roomComfort, roomComfortBreakdown,
  COMFORT_LIMITS,
} = await import("../src/sim/comfort");
const { addPlacement, getPlacements } = await import("../src/sim/placements");
const { getDef } = await import("../src/furniture/catalog");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

// ===========================================================================
// 0. 🔴 最先跑:種子樓層的中性校準(任何 addPlacement 都會汙染它)
// ===========================================================================
const seedQuality = communalQuality();
const seedDelta = communalBaselineDelta(seedQuality);
check(
  `種子樓層的公共空間分數 === COMMUNAL_NEUTRAL(q ${seedQuality} === ${COMMUNAL_NEUTRAL})`,
  seedQuality === COMMUNAL_NEUTRAL,
);
// 這條是「balance 快照零漂移」的直接證據:三個 delta 全 0 → baselines()/wbAnchor 完全不動。
check(
  `種子樓層三個 delta 皆恰好為 0(mood ${seedDelta.mood} / stress ${seedDelta.stress} / wellbeing ${seedDelta.wellbeing})`,
  seedDelta.mood === 0 && seedDelta.stress === 0 && seedDelta.wellbeing === 0,
);
check(
  "中性點刻意不是 50(取 50 會讓功能一上線就全樓大扣分、快照全盤重排)",
  COMMUNAL_NEUTRAL !== 50 && COMMUNAL_NEUTRAL > 20 && COMMUNAL_NEUTRAL < 50,
);

// 種子三區的實測分數(釘死推導過程的每一個中間值)
const seedAreas = communalBreakdown().areas;
const byId = Object.fromEntries(seedAreas.map((a) => [a.id, a])) as Record<string, (typeof seedAreas)[number]>;
check(
  `加權合成 = Σ(區分數 × 權重)(交誼廳 ${byId.lounge.quality.toFixed(4)}×0.5 + 浴室 ${byId.bathroom.quality}×0.3 + 洗衣間 ${byId.laundry.quality}×0.2 = ${seedQuality.toFixed(5)})`,
  Math.abs(
    seedQuality -
      (byId.lounge.quality * 0.5 + byId.bathroom.quality * 0.3 + byId.laundry.quality * 0.2),
  ) < 1e-12,
);
check(
  "權重固定 lounge 0.5 / bathroom 0.3 / laundry 0.2 且總和為 1(交誼廳權重最高:租客待最久)",
  COMMUNAL_LIMITS.lounge.weight === 0.5 && COMMUNAL_LIMITS.bathroom.weight === 0.3 &&
    COMMUNAL_LIMITS.laundry.weight === 0.2 &&
    COMMUNAL_AREA_IDS.reduce((s, id) => s + COMMUNAL_LIMITS[id].weight, 0) === 1,
);

// --- 3. 釘死種子 tierPart(tier 直接複用 furniture/tier.ts,一行沒改) ---
check(
  `種子 tierPart 釘死:交誼廳 ${byId.lounge.tierPart} === 7 / 浴室 ${byId.bathroom.tierPart} === 0.5 / 洗衣間 ${byId.laundry.tierPart} === 1`,
  byId.lounge.tierPart === 7 && byId.bathroom.tierPart === 0.5 && byId.laundry.tierPart === 1,
);
check(
  `共用區 tier 上限比私人房寬(共用 ${COMMUNAL_LIMITS.lounge.tierMax} > 私人房 ${COMFORT_LIMITS.tierMax};種子交誼廳已 7.0,沿用 10 幾乎沒升級空間)`,
  COMMUNAL_LIMITS.lounge.tierMax > COMFORT_LIMITS.tierMax && byId.lounge.tierPart < COMMUNAL_LIMITS.lounge.tierMax,
);
// 種子整潔錨點:全部由 cleanlinessBaseline 推導,零新狀態
check(
  `整潔由 cleanlinessBaseline 推導、無新狀態(交誼廳錨 ${byId.lounge.cleanBase}=62 → ×0.81 / 浴室 ${byId.bathroom.cleanBase}=50 / 洗衣間 ${byId.laundry.cleanBase}=50 → ×0.75)`,
  byId.lounge.cleanBase === cleanlinessBaseline("lounge") && byId.lounge.cleanBase === 62 &&
    byId.lounge.cleanMult === cleanlinessMultiplier(62) &&
    byId.bathroom.cleanBase === 50 && byId.laundry.cleanBase === 50 &&
    byId.bathroom.cleanMult === 0.75 && byId.laundry.cleanMult === 0.75,
);

// ===========================================================================
// 1. 值域 + 加法恆等式
// ===========================================================================
function identityHolds(id: (typeof COMMUNAL_AREA_IDS)[number]) {
  const a = communalAreaBreakdown(id);
  const lim = COMMUNAL_LIMITS[id];
  const expect = Math.min(100, Math.max(0, (a.attrPart + a.categoryPart + a.tierPart) * a.cleanMult));
  return (
    Math.abs(a.quality - expect) < 1e-9 &&
    a.attrPart >= 0 && a.attrPart <= lim.attrMax &&
    a.categoryPart >= 0 && a.categoryPart <= lim.categoryMax &&
    a.tierPart >= 0 && a.tierPart <= lim.tierMax &&
    a.quality >= 0 && a.quality <= 100 &&
    a.cleanMult >= 0.5 && a.cleanMult <= 1
  );
}
check(
  "三區的 quality === (屬性+齊全+品質)×整潔,且每項都落在自己的上限內",
  COMMUNAL_AREA_IDS.every(identityHolds),
);
check(
  `三區都有 id/中文名/bucket 清單(UI 面板不會拿到空列):${COMMUNAL_AREA_IDS.map((id) => COMMUNAL_AREA_LABELS[id]).join("/")}`,
  COMMUNAL_AREA_IDS.length === 3 &&
    COMMUNAL_AREA_IDS.every((id) => COMMUNAL_AREA_LABELS[id].length > 0 && communalAreaBreakdown(id).buckets.length >= 3),
);
check(
  "齊全度 =(有的類數 × 每類點數),且每類點數 = categoryMax ÷ 該區類數(不論幾類,機能齊全都值 30)",
  COMMUNAL_AREA_IDS.every((id) => {
    const a = communalAreaBreakdown(id);
    const lim = COMMUNAL_LIMITS[id];
    return (
      Math.abs(a.categoryPart - a.buckets.filter((b) => b.has).length * lim.categoryPoints) < 1e-12 &&
      Math.abs(lim.categoryPoints * a.buckets.length - lim.categoryMax) < 1e-12
    );
  }),
);

// --- 4. 每區上限之和 === 100(clamp 永不生效 → 面板加法恆等) ---
// 刻意是 === 而不是 ≤:「每區滿分都是 100、三區同尺規」是加權合成的前提。
// 寫成 ≤ 的話,有人把 COMMUNAL_TIER_MAX 從 20 改成 15,前提就破了而測試不會紅。
check(
  `每區 attrMax + categoryMax + tierMax === 100(${COMMUNAL_AREA_IDS.map((id) => `${COMMUNAL_AREA_LABELS[id]} ${COMMUNAL_LIMITS[id].attrMax}+${COMMUNAL_LIMITS[id].categoryMax}+${COMMUNAL_LIMITS[id].tierMax}=${COMMUNAL_LIMITS[id].attrMax + COMMUNAL_LIMITS[id].categoryMax + COMMUNAL_LIMITS[id].tierMax}`).join(" / ")})`,
  COMMUNAL_AREA_IDS.every(
    (id) => COMMUNAL_LIMITS[id].attrMax + COMMUNAL_LIMITS[id].categoryMax + COMMUNAL_LIMITS[id].tierMax === 100,
  ),
);
check(
  "三區共用同一組上限 → 三區分數在同一個 0~100 尺規上(加權合成才有意義)",
  COMMUNAL_AREA_IDS.every(
    (id) =>
      COMMUNAL_LIMITS[id].attrMax === COMMUNAL_LIMITS.lounge.attrMax &&
      COMMUNAL_LIMITS[id].categoryMax === COMMUNAL_LIMITS.lounge.categoryMax &&
      COMMUNAL_LIMITS[id].tierMax === COMMUNAL_LIMITS.lounge.tierMax,
  ),
);
// 不動私人房那套(動了會改變所有私人房分數 + 破壞 ≤100 不變量)
check(
  `私人房 COMFORT_LIMITS 未被本功能動到(${COMFORT_LIMITS.attrMax}/${COMFORT_LIMITS.categoryMax}/${COMFORT_LIMITS.tierMax},categoryPoints ${COMFORT_LIMITS.categoryPoints})`,
  COMFORT_LIMITS.attrMax === 60 && COMFORT_LIMITS.categoryMax === 30 &&
    COMFORT_LIMITS.categoryPoints === 6 && COMFORT_LIMITS.tierMax === 10,
);

// ===========================================================================
// 2. 🔴 核心驗收:舊公式下浴室/洗衣間結構性拿 0,新 bucket 表讓它們拿得到分
// ===========================================================================
// 前提:證明「洗衣間五件全是 utility 且 attributes 全空」這個結構性問題真的存在,
// 否則本測試失去意義(比照 furniture-tier-test 的「零屬性家具」前提斷言)。
const laundryDefs = getPlacements().filter((p) => p.room === "laundry").map((p) => getDef(p.defId));
check(
  `前提成立:洗衣間 ${laundryDefs.length} 件全是 utility 且 attributes 全空(舊公式必然 0 分)`,
  laundryDefs.length === 5 &&
    laundryDefs.every((d) => d.category === "utility") &&
    laundryDefs.every((d) => Object.values(d.attributes).every((v) => !v)),
);
const oldLaundry = roomComfortBreakdown("laundry", 100);
check(
  `私人房公式下洗衣間結構性拿 0 分(attrPart ${oldLaundry.attrPart} + categoryPart ${oldLaundry.categoryPart},缺全部五類)`,
  oldLaundry.attrPart === 0 && oldLaundry.categoryPart === 0 && oldLaundry.missing.length === 5,
);
check(
  `共用區公式讓洗衣間拿得到分(${byId.laundry.quality} > 0,齊全度 ${byId.laundry.categoryPart} > 0)`,
  byId.laundry.quality > 0 && byId.laundry.categoryPart > 0,
);
const oldBathroom = roomComfortBreakdown("bathroom", 100);
check(
  `共用區公式讓浴室拿到明顯更高的齊全度(私人房公式 ${oldBathroom.categoryPart}/30 → 共用區 ${byId.bathroom.categoryPart}/30)`,
  byId.bathroom.categoryPart > oldBathroom.categoryPart && byId.bathroom.quality > 0,
);
// bucket 表按 sprite.kind 細分 utility:浴室的淋浴/如廁/盥洗三類種子局都已達成
check(
  `浴室的 utility 被 sprite.kind 細分成可達成的機能類(${byId.bathroom.buckets.map((b) => (b.has ? "✓" : "✗") + b.label).join(" ")})`,
  ["淋浴", "如廁", "盥洗"].every((l) => byId.bathroom.buckets.find((b) => b.label === l)?.has === true),
);
check(
  `洗衣間同理(${byId.laundry.buckets.map((b) => (b.has ? "✓" : "✗") + b.label).join(" ")})`,
  ["洗滌", "晾曬", "整理"].every((l) => byId.laundry.buckets.find((b) => b.label === l)?.has === true),
);
// 三區都不該沿用私人房那五類(「睡眠」對浴室永遠不可能、「社交」對洗衣間不該算缺點)
check(
  "共用區 bucket 不含「睡眠」這種對共用區永遠不可能達成的類別",
  COMMUNAL_AREA_IDS.every((id) => !communalAreaBreakdown(id).buckets.some((b) => b.label === "睡眠")),
);

// ===========================================================================
// 8. 🔴 最重要:cozyHomePass 讀的 roomComfort 完全不受本功能影響
// ===========================================================================
// (a) 釘死 7ce59a7(本功能之前)實測的逐值 —— 公式若被動到,這裡立刻紅。
//     clean 取樣刻意穿過 r302 的 52 門檻翻轉窗口(74.9 / 80 / 83 / 84.2),
//     日間實際整潔 ≈83 正落在窗口中央,是本功能最大的風險點。
const PINNED_CLEANS = [0, 20, 50, 74.9, 80, 83, 84.2, 100];
const PINNED: Record<string, number[]> = {
  r301: [28.373966942148762, 34.04876033057851, 42.56095041322314, 49.62606818181819, 51.073140495867776, 51.924359504132234, 52.26484710743802, 56.747933884297524],
  r302: [29.74203821656051, 35.69044585987261, 44.61305732484077, 52.01882484076433, 53.535668789808916, 54.42792993630573, 54.78483439490446, 59.48407643312102],
  r303: [3, 3.5999999999999996, 4.5, 5.247, 5.4, 5.49, 5.526, 6],
  r304: [3, 3.5999999999999996, 4.5, 5.247, 5.4, 5.49, 5.526, 6],
};
const pinBad: string[] = [];
for (const [room, expected] of Object.entries(PINNED)) {
  PINNED_CLEANS.forEach((cl, i) => {
    const got = roomComfort(room, cl);
    if (got !== expected[i]) pinBad.push(`${room}@${cl}: ${got} ≠ ${expected[i]}`);
  });
}
check(
  `種子房 roomComfort 與本功能前(7ce59a7)實測值逐位元相同(${Object.keys(PINNED).length} 房 × ${PINNED_CLEANS.length} 檔整潔 = ${Object.keys(PINNED).length * PINNED_CLEANS.length} 個值)`,
  pinBad.length === 0,
);
if (pinBad.length) console.log(`   ↳ ${pinBad.slice(0, 5).join(" / ")}`);

// (b) 結構性不變量:**改動共用區完全不影響任何私人房的 roomComfort**。
//     這條不依賴任何基準檔,是「獨立管道」這個架構決定的直接證據。
const beforeRoomComfort = Object.keys(PINNED).flatMap((room) =>
  PINNED_CLEANS.map((cl) => roomComfort(room, cl)),
);
const qBeforeInvest = communalQuality();
// 把共用區大改一輪:三區各補齊缺的那一類 + 塞高屬性精品家具
addPlacement({ defId: "bookshelf", room: "lounge", c: 8, r: 9 } as any); // 交誼廳補「收納」
addPlacement({ defId: "dresser", room: "bathroom", c: 3, r: 24 } as any); // 浴室補「收納」
addPlacement({ defId: "lounge_plant", room: "laundry", c: 14, r: 29 } as any); // 洗衣間補「裝飾」
for (let i = 0; i < 6; i++) addPlacement({ defId: "shared_sofa", room: "lounge", c: 20 + i, r: 13 } as any);
const qAfterInvest = communalQuality();
const afterRoomComfort = Object.keys(PINNED).flatMap((room) =>
  PINNED_CLEANS.map((cl) => roomComfort(room, cl)),
);
check(
  `大改共用區確實改變了公共空間分數(${qBeforeInvest.toFixed(3)} → ${qAfterInvest.toFixed(3)},證明下一條不是空轉)`,
  qAfterInvest > qBeforeInvest,
);
check(
  "大改共用區後,所有私人房的 roomComfort 一位元都沒動(獨立管道 → cozyHomePass 門檻不可能翻轉)",
  afterRoomComfort.every((v, i) => v === beforeRoomComfort[i]),
);

// --- 2b. 每區都有可能拿到 categoryPart 滿分(本功能的核心驗收) ---
// 上面已為交誼廳/浴室補「收納」、洗衣間補「裝飾」——三區的缺項都補得起來。
check(
  `三區都拿到 categoryPart 滿分(${COMMUNAL_AREA_IDS.map((id) => `${COMMUNAL_AREA_LABELS[id]} ${communalAreaBreakdown(id).categoryPart}/${COMMUNAL_LIMITS[id].categoryMax}`).join(" / ")})`,
  COMMUNAL_AREA_IDS.every((id) => {
    const a = communalAreaBreakdown(id);
    return a.categoryPart === COMMUNAL_LIMITS[id].categoryMax && a.buckets.every((b) => b.has);
  }),
);
check(
  "滿分後三區的加法恆等式仍成立、分數仍不破 100",
  COMMUNAL_AREA_IDS.every(identityHolds),
);
check(
  `投資後公共空間分數高於中性基準 → delta 轉正(q ${qAfterInvest.toFixed(2)} > ${COMMUNAL_NEUTRAL.toFixed(2)},mood +${communalBaselineDelta(qAfterInvest).mood.toFixed(2)})`,
  communalBaselineDelta(qAfterInvest).mood > 0 &&
    communalBaselineDelta(qAfterInvest).stress < 0 &&
    communalBaselineDelta(qAfterInvest).wellbeing > 0,
);
check(
  "公共空間係數刻意小於私人房(公共空間影響力應低於自己的房間)",
  Math.abs(communalBaselineDelta(COMMUNAL_NEUTRAL + 10).mood) < Math.abs(10 * 0.16) &&
    Math.abs(communalBaselineDelta(COMMUNAL_NEUTRAL + 10).stress) < Math.abs(10 * 0.1) &&
    Math.abs(communalBaselineDelta(COMMUNAL_NEUTRAL + 10).wellbeing) < Math.abs(10 * 0.08),
);
// 方向對稱:拆掉共用區家具 → delta 轉負
check(
  `公共空間荒廢會扣分(q 10 → mood ${communalBaselineDelta(10).mood.toFixed(2)}、stress +${communalBaselineDelta(10).stress.toFixed(2)}、wellbeing ${communalBaselineDelta(10).wellbeing.toFixed(2)})`,
  communalBaselineDelta(10).mood < 0 && communalBaselineDelta(10).stress > 0 && communalBaselineDelta(10).wellbeing < 0,
);

// ===========================================================================
// 9. 玩法鉤子:掃地機器人放進交誼廳現在有後果了
// ===========================================================================
// `robot_vacuum` 的 placement 是 "room",但 FurnitureShop 只排除 wall、canPlaceFree 只檢查
// FLOOR_REGIONS(共用區都在裡面)→ 玩家今天就能把它買進交誼廳,只是**沒有任何後果**。
// 共用區整潔改用 cleanlinessBaseline 推導之後,它終於有後果了。
check(
  "前提:robot_vacuum 的 placement 是 room 但有 cleanPower(它進共用區沒被任何地方擋)",
  getDef("robot_vacuum").placement === "room" && (getDef("robot_vacuum").cleanPower ?? 0) > 0,
);
const cbBeforeVac = cleanlinessBaseline("lounge");
const qBeforeVac = communalQuality();
const loungeBeforeVac = communalAreaBreakdown("lounge");
addPlacement({ defId: "robot_vacuum", room: "lounge", c: 21, r: 9 } as any);
const cbAfterVac = cleanlinessBaseline("lounge");
const loungeAfterVac = communalAreaBreakdown("lounge");
check(
  `掃地機器人墊高交誼廳的整潔錨點(${cbBeforeVac} → ${cbAfterVac})`,
  cbAfterVac > cbBeforeVac,
);
check(
  `→ 交誼廳整潔乘子與分數跟著上升(×${loungeBeforeVac.cleanMult.toFixed(3)} → ×${loungeAfterVac.cleanMult.toFixed(3)},${loungeBeforeVac.quality.toFixed(3)} → ${loungeAfterVac.quality.toFixed(3)})`,
  loungeAfterVac.cleanMult > loungeBeforeVac.cleanMult && loungeAfterVac.quality > loungeBeforeVac.quality,
);
check(
  `→ 整體公共空間分數上升(${qBeforeVac.toFixed(3)} → ${communalQuality().toFixed(3)}),掃地機器人進交誼廳終於有後果`,
  communalQuality() > qBeforeVac,
);
check(
  "整潔錨點仍有上限保護(夾 ≤ 90 → 乘子 ≤ 0.95)",
  COMMUNAL_AREA_IDS.every((id) => cleanlinessBaseline(id) <= 90 && communalAreaBreakdown(id).cleanMult <= 0.95),
);

// --- 空區保護:共用區被拆空也不會 NaN / 負數(面板不會爆) ---
// ⚠️ 這裡必須真的走 `communalAreaBreakdown` 的空區路徑:屬性部分是 `max × w/(w+18)`,
// 全空時是 0/(0+18) 而非 0/0——但那要**實際呼叫**才驗得到。
// 作法:暫時把洗衣間的家具全數移出 placements,驗完立刻原樣塞回(順序也還原)。
const laundryBackup = getPlacements().filter((p) => p.room === "laundry").map((p) => ({ ...p }));
const listRef = getPlacements();
const keptOthers = listRef.filter((p) => p.room !== "laundry").map((p) => ({ ...p }));
listRef.length = 0;
listRef.push(...keptOthers);
const emptyArea = communalAreaBreakdown("laundry");
check(
  `真的清空一區後,該區走完整條計算路徑仍得 0 而非 NaN(attr ${emptyArea.attrPart} / cat ${emptyArea.categoryPart} / tier ${emptyArea.tierPart} → quality ${emptyArea.quality})`,
  emptyArea.attrPart === 0 && emptyArea.categoryPart === 0 && emptyArea.tierPart === 0 &&
    emptyArea.quality === 0 && Number.isFinite(emptyArea.quality),
);
check(
  `空區的 bucket 全部標記為缺、整潔錨回到無收納的 50(錨 ${emptyArea.cleanBase} → ×${emptyArea.cleanMult})`,
  emptyArea.buckets.every((b) => !b.has) && emptyArea.cleanBase === 50 &&
    emptyArea.cleanMult === cleanlinessMultiplier(50),
);
const qWithEmpty = communalQuality();
check(
  `整棟合成分數也不會 NaN,且比未清空時低(${qWithEmpty.toFixed(3)} 且為有限數)`,
  Number.isFinite(qWithEmpty) && qWithEmpty >= 0,
);
// 還原洗衣間(後面沒有斷言依賴它,但別留下被掏空的狀態給同進程的其他程式碼)
listRef.push(...laundryBackup);
check(
  `還原後洗衣間回到清空前的件數與分數(${getPlacements().filter((p) => p.room === "laundry").length} 件,quality ${communalAreaBreakdown("laundry").quality})`,
  getPlacements().filter((p) => p.room === "laundry").length === laundryBackup.length &&
    communalAreaBreakdown("laundry").quality > 0,
);

// ===========================================================================
// 6 + 7. 零 RNG + 決定性
// ===========================================================================
let rngCalls = 0;
Math.random = () => { rngCalls++; return seededRandom(); };
const detA = [communalQuality(), ...COMMUNAL_AREA_IDS.map((id) => communalAreaBreakdown(id).quality)];
const detB = [communalQuality(), ...COMMUNAL_AREA_IDS.map((id) => communalAreaBreakdown(id).quality)];
const deltaA = communalBaselineDelta(communalQuality());
const deltaB = communalBaselineDelta(communalQuality());
Math.random = seededRandom;
check(`共用區計算不呼叫 Math.random(實測 ${rngCalls} 次;多一次亂數就會位移整個模擬序列)`, rngCalls === 0);
check("連跑兩次結果完全相同(決定性)", detA.every((v, i) => v === detB[i]));
check(
  "communalBaselineDelta 也是決定性的",
  deltaA.mood === deltaB.mood && deltaA.stress === deltaB.stress && deltaA.wellbeing === deltaB.wellbeing,
);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
