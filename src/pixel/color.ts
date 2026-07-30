/**
 * 顏色安全化的純函式工具(AI 色碼消毒用)。
 *
 * 為什麼不用「vs 背景」的 WCAG 對比:
 * 實測專案自家色池對背景的對比幾乎全在 1.0~1.3(例如 SHIRT `#5aa06a` vs r301 地板
 * `#b08a5e` → CR 1.00),用那套模型會把現有美術整批判成違規。而且背景不是常數
 * (`floors.png` 各區平均亮度 r301 L=0.215、洗衣間 L=0.617,人物會走遍所有區域,
 * 夜間 tint 還會再壓縮對比)。
 *
 * 因此改用「per-slot 亮度帶夾值 + 髮膚 ΔL 分離」:背景無關、永遠成立、且可證明
 * 不會誤殺自家色池(見 `scripts/invite-test.ts` 的護欄測試)。
 *
 * 本檔全為純函式:無副作用、無 RNG、可重入、冪等。
 */
import { shade } from "./sprites";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 亮度帶(相對亮度的下限/上限,皆含端點) */
export interface LumaBand {
  lo: number;
  hi: number;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** `#rrggbb` → 0~255 分量;格式不合法回 null(呼叫端自行決定回退) */
export function hexToRgb(hex: string): Rgb | null {
  if (typeof hex !== "string" || !HEX6.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** sRGB 分量 → 線性光 */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 相對亮度(0=黑、1=白);格式不合法回 0 */
export function relLuma(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 對比率(1~21)。本檔不用它做判定,只給診斷/日誌與測試參考。 */
export function contrastRatio(a: string, b: string): number {
  const la = relLuma(a);
  const lb = relLuma(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 夾值用的固定步長表(0.5% ~ 100%),決定性、零 RNG */
const STEPS: number[] = Array.from({ length: 200 }, (_, i) => (i + 1) * 0.5);

const inBand = (l: number, band: LumaBand) => l >= band.lo && l <= band.hi;

/**
 * 把顏色的相對亮度夾進 `band`,**色相保留**(用 `shade()` 往白/黑線性內插)。
 *
 * - 已在帶內 → 原樣返回(這是護欄測試與冪等性的基礎)。
 * - 太亮 → 往黑收斂;太暗 → 往白收斂;取固定步長表中第一個落入帶內者。
 * - 步長表走完都沒落入(帶極窄時)→ 回退到最接近帶的候選,仍是決定性結果。
 * - 格式不合法 → 原樣返回(呼叫端負責格式回退)。
 */
export function clampLuma(hex: string, band: LumaBand): string {
  if (!hexToRgb(hex)) return hex;
  const l = relLuma(hex);
  if (inBand(l, band)) return hex;
  const sign = l > band.hi ? -1 : 1;
  let best = hex;
  let bestDist = Math.min(Math.abs(l - band.lo), Math.abs(l - band.hi));
  for (const step of STEPS) {
    const cand = shade(hex, sign * step);
    const cl = relLuma(cand);
    if (inBand(cl, band)) return cand;
    const dist = Math.min(Math.abs(cl - band.lo), Math.abs(cl - band.hi));
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

/** 歐氏距離(RGB 空間)最近的池內色;零 RNG。池為空或格式不合法 → 回池首色 */
export function nearestInPool(hex: string, pool: readonly string[]): string {
  if (pool.length === 0) return hex;
  const target = hexToRgb(hex);
  if (!target) return pool[0];
  let best = pool[0];
  let bestD = Infinity;
  for (const cand of pool) {
    const c = hexToRgb(cand);
    if (!c) continue;
    const d = (c.r - target.r) ** 2 + (c.g - target.g) ** 2 + (c.b - target.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best;
}

/**
 * 髮膚分離:讓 `|L(hair) − L(skin)| >= minDelta`。
 *
 * 背景會變(區域、日夜 tint),但頭髮永遠貼著臉,所以髮膚是唯一「背景無關、永遠成立」
 * 的對比對象,也是「人臉糊成一團」的真實風險。
 *
 * 只動髮色(膚色已 snap 到白名單)。優先往暗夾(符合「髮色偏深」的美術方向);
 * 帶內往暗走不通時才往亮夾;兩者都不行就放棄(維持已夾好的髮色)。
 * 所有候選都必須留在 `band` 內 —— 這是冪等性的關鍵:成功時結果同時滿足帶與 ΔL,
 * 第二次呼叫直接短路;失敗時輸入即輸出,候選集合不變,結論也不變。
 */
export function separateHairFromSkin(hair: string, skin: string, band: LumaBand, minDelta: number): string {
  const skinL = relLuma(skin);
  if (Math.abs(relLuma(hair) - skinL) >= minDelta) return hair;
  for (const sign of [-1, 1]) {
    for (const step of STEPS) {
      const cand = shade(hair, sign * step);
      const cl = relLuma(cand);
      if (inBand(cl, band) && Math.abs(cl - skinL) >= minDelta) return cand;
    }
  }
  return hair;
}
