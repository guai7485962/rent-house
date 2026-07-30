/**
 * 家具品質層級(tier)的單一資料來源:**係數與 UI 文案住在同一個檔**。
 *
 * tier 曾經只是商店/資訊卡上的星星標示,玩家多花錢買精品版在數值上什麼都拿不到;
 * 本檔把 tier 接上舒適度——`comfort.ts` 逐件加總 `TIER_POINTS`,成為舒適度的第三個加項。
 *
 * 刻意的設計約束:
 * - **零 RNG**:整支檔案不呼叫 `Math.random`(比照 `sim/dreams.ts`)。tier 是查表加總的
 *   決定性數值,多一次亂數呼叫就會位移整個模擬序列、讓 balance 快照全盤漂移。
 * - **係數與文案同檔**:星數/中文標籤原本在 `FurnitureShop.vue` 與 `FurnitureInfo.vue`
 *   各抄一份,改了係數很容易忘記改文案。這裡統一輸出 `tierChipText()` 給兩處 SFC 用,
 *   商店與資訊卡上的「+1.5」永遠等於實際進入舒適度的點數。
 * - **fallback 是 `standard` 不是 `budget`**:畢業生紀念物(price 0)與 `UNKNOWN_DEF`
 *   沒有標 tier,它們的定位是「留下的禮物 / 純裝飾」,fallback 成 budget 會讓紀念物
 *   變成相對扣分,語意完全相反。中性基準 = standard。
 * - **獨立加分項,不是 attributes 乘子**:約 1/3 的目錄家具 attributes 是空的
 *   (單人床、折疊床、塑膠椅凳、爐具、馬桶、淋浴間、洗衣機…),乘子對它們是 0×n=0 的
 *   空砲。獨立加分才能讓零屬性家具也真的有 tier 差。
 */
import type { FurnitureDef, FurnTier } from "./catalog";

/** 未標 tier 的家具視為標準品(中性基準;紀念物/未知家具走這條) */
export const DEFAULT_TIER: FurnTier = "standard";

/**
 * 每件家具依 tier 貢獻的舒適度點數(進入 `roomComfortBreakdown` 的 `tierPart`)。
 * standard = 0.5 是中性基準:budget 相對它少 0.5、premium 相對它多 1.0,
 * 玩家換掉平價家具就看得到分數動,但單件影響刻意很小(整房上限見 `COMFORT_LIMITS.tierMax`)。
 */
export const TIER_POINTS: Record<FurnTier, number> = {
  budget: 0,
  standard: 0.5,
  premium: 1.5,
};

/** 品質層級的一眼標示(星數 + 中文標籤);商店與資訊卡共用,不再各自抄一份 */
export const TIER_INFO: Record<FurnTier, { label: string; stars: string }> = {
  budget: { label: "平價", stars: "★" },
  standard: { label: "標準", stars: "★★" },
  premium: { label: "精品", stars: "★★★" },
};

/**
 * 睡眠恢復效率乘數:床的 tier 直接放大這一小時的睡眠效果(`sim/generate.ts` 的 EFFECT 展開)。
 * 形狀刻意對齊 `TIER_POINTS` 的 0 / 0.5 / 1.5——premium 的躍升大於 standard,
 * 讓「再往上加一階」始終有感,而不是線性到頂。
 *
 * budget 是 **精確的 1.0**:種子局四間房全是平價單人床,`9 * 1.0 === 9` 位元級成立
 * ⇒ 既有 balance 快照零漂移。任何「先四捨五入再乘」「先加 bonus 再乘」的變體都會
 * 在這條路徑上引入浮點誤差,因此全系統只准有 `EFFECT[key] × mult` 這一種形式。
 *
 * **只乘 energy 與 stress**(見 `sim/generate.ts` 的 `SLEEP_SCALED`):
 * mood 的 +2 在實測中已頻繁頂到 100 上限,乘了幾乎全浪費;wellbeing 的 +0.3 幅度太小。
 */
export const SLEEP_MULT: Record<FurnTier, number> = {
  budget: 1.0,
  standard: 1.15,
  premium: 1.35,
};

/** 睡眠乘數的合理值域(防未來有人把係數改成離譜的數字,睡一晚回滿或倒扣) */
export const SLEEP_MULT_RANGE = { min: 0.5, max: 2.0 } as const;

/** 家具的實際 tier(未標 → 中性 standard) */
export function tierOf(def: Pick<FurnitureDef, "tier">): FurnTier {
  return def.tier ?? DEFAULT_TIER;
}

/** 家具貢獻的舒適度 tier 點數(未標 → 中性 standard 的點數) */
export function tierPoints(def: Pick<FurnitureDef, "tier">): number {
  return TIER_POINTS[tierOf(def)];
}

/**
 * 睡在這件家具上的恢復效率乘數(未標 tier → 走 `tierOf()` 的中性 standard)。
 *
 * 刻意**複用 `tierOf()` 而不另開一套 fallback**:tier 語意在全系統只有一份,
 * 未標 tier 的家具在舒適度是 standard、在睡眠也必須是 standard。
 * `UNKNOWN_DEF` 走同一條路,不會拋例外。
 */
export function sleepMultiplier(def: Pick<FurnitureDef, "tier">): number {
  const raw = SLEEP_MULT[tierOf(def)] ?? SLEEP_MULT[DEFAULT_TIER];
  return Math.min(SLEEP_MULT_RANGE.max, Math.max(SLEEP_MULT_RANGE.min, raw));
}

/**
 * 商店/資訊卡的 tier chip 文字,例:`★★★ 精品 +1.5`。
 * 刻意把數值寫進既有 chip 而不另開一個 chip——390px 下 chips 已經很擠,
 * 內含數值是零額外寬度,又能讓玩家知道貴的那件到底多給了什麼。
 */
export function tierChipText(tier: FurnTier): string {
  const info = TIER_INFO[tier];
  return `${info.stars} ${info.label} +${TIER_POINTS[tier]}`;
}
