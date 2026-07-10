/**
 * 記憶標籤 → 行為/數值影響。
 *
 * AI 給的記憶標籤(label 是自由文字,如 [熱戀中]、[失戀]、[養貓]、[開始晨跑]…)
 * 無法窮舉 → 用「關鍵字 → 每小時微幅漂移」的資料驅動對照表。
 * 帶某記憶的租客會長期往某方向偏(全部夾值,不會瞬間爆表)。
 *
 * 擴充方式:在 RULES 加一列即可。
 */
import type { Tenant } from "../types";

/** 每小時的微幅數值漂移 */
export interface Drift {
  mood?: number;
  stress?: number;
  hygiene?: number;
  affinity?: number;
}

interface MemoryRule {
  keywords: string[];
  drift: Drift;
  /** 給 UI/除錯看的說明 */
  note: string;
}

/** 關鍵字 → 效果。label 只要「包含」任一關鍵字就套用 */
export const MEMORY_RULES: MemoryRule[] = [
  { keywords: ["熱戀", "戀愛", "告白", "曖昧", "交往", "喜歡上", "心動"], drift: { mood: 0.8, stress: -0.5 }, note: "戀愛中,心情變好、壓力下降" },
  { keywords: ["失戀", "分手", "被甩", "心碎", "單戀"], drift: { mood: -0.9, stress: 0.6 }, note: "情傷,心情低落、壓力上升" },
  { keywords: ["貓", "狗", "寵", "毛孩", "倉鼠", "兔"], drift: { mood: 0.6, stress: -0.4 }, note: "養寵物療癒" },
  { keywords: ["晨跑", "運動", "健身", "跑步", "瑜伽", "早起"], drift: { stress: -0.5, hygiene: 0.5, mood: 0.3 }, note: "規律運動,身心變好" },
  { keywords: ["熬夜", "失眠", "爆肝", "通宵", "作息亂"], drift: { stress: 0.7, hygiene: -0.3, mood: -0.2 }, note: "熬夜傷身、壓力累積" },
  { keywords: ["疑", "怨", "不滿", "衝突", "吵架", "討厭房東", "抱怨"], drift: { affinity: -0.7 }, note: "對房東心生芥蒂" },
  { keywords: ["感激", "感謝", "溫情", "信任", "貼心", "照顧"], drift: { affinity: 0.7, mood: 0.3 }, note: "感念房東的好" },
  { keywords: ["孤獨", "寂寞", "封閉", "疏離"], drift: { mood: -0.5, stress: 0.3 }, note: "孤單感侵蝕心情" },
  { keywords: ["加薪", "升遷", "接到案", "訂閱", "破萬", "接案順", "得獎"], drift: { mood: 0.7, stress: -0.3 }, note: "事業順遂" },
  { keywords: ["失業", "被裁", "沒收入", "欠債", "沒案子", "掉粉"], drift: { mood: -0.8, stress: 0.8 }, note: "財務/事業打擊" },
  { keywords: ["沉迷", "上癮", "電動", "追劇"], drift: { hygiene: -0.3, stress: -0.2 }, note: "沉迷娛樂,爽但邋遢" },
  { keywords: ["潔癖", "整理", "斷捨離", "打掃"], drift: { hygiene: 0.6 }, note: "愛乾淨" },
];

/** 每軸每小時漂移上限(即使多個記憶疊加也不會過猛) */
const PER_HOUR_CAP = 1.5;
const clampCap = (v: number) => Math.min(PER_HOUR_CAP, Math.max(-PER_HOUR_CAP, v));

/** 依租客目前所有記憶標籤,算出這一小時的合計漂移(已夾上限) */
export function memoryDrift(tenant: Tenant): Drift {
  const total: Drift = { mood: 0, stress: 0, hygiene: 0, affinity: 0 };
  for (const tag of tenant.memoryTags) {
    for (const rule of MEMORY_RULES) {
      if (rule.keywords.some((k) => tag.label.includes(k))) {
        total.mood! += rule.drift.mood ?? 0;
        total.stress! += rule.drift.stress ?? 0;
        total.hygiene! += rule.drift.hygiene ?? 0;
        total.affinity! += rule.drift.affinity ?? 0;
      }
    }
  }
  return {
    mood: clampCap(total.mood!),
    stress: clampCap(total.stress!),
    hygiene: clampCap(total.hygiene!),
    affinity: clampCap(total.affinity!),
  };
}
