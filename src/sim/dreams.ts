/**
 * 夢境彩蛋:租客睡著時低頻(每人每 3~4 遊戲日)留下一則夢境日誌。
 *
 * 素材取自「記憶標籤 → 夢境主題」與「鄰居關係」,純模板、零 AI 成本。
 * 刻意的設計約束:
 * - **零 RNG**:整支檔案不呼叫 `Math.random`。選主題、選文案、決定下次間隔
 *   一律用決定性雜湊(比照 `tick.cozyHomeIndex` / `floorChain.chainIndex`),
 *   多一次亂數呼叫就會位移整個模擬序列、讓 balance 快照全盤漂移。
 * - **純風味,不改任何數值**:不碰 mood/stress/energy、不呼叫 `adjustRelationship`、
 *   不寫回 `MemoryTag.intensity`,只讀不寫。夢是「觀察到的畫面」,不是事件。
 * - **冷卻入存檔**:冷卻寫在 `state.interactionCooldowns`(比照 pets.ts 借用同一張表),
 *   會被 persistence 存讀。刻意不用模組層 Map——那種冷卻 reload 就清空,
 *   會變成「每次重開頁面當晚必做夢」。
 * - **用 `gameDayIndex()` 而非 `calendarGameDayIndex()`**:前者以 22:00 為換日邊界,
 *   22:00→06:00 整夜同屬一個遊戲日,天然保證「一夜最多一夢」;後者午夜換日會一夜兩夢。
 * - **前 DREAM_FIRST_DAY 天不做夢**:balance-test 的快照窗只有 10 遊戲日且
 *   `logs` 是整數精確比對,第 14 天起才觸發 ⇒ 快照零漂移(同 floorChain.CHAIN_FIRST_DAY)。
 */
import type { TenantVisualState } from "../types";
import { state, gameDayIndex, pushSocialLog, type TenantRuntime } from "./gameState";
import { listRelationships } from "./social";
import { MEMORY_RULES } from "./memoryEffects";
import {
  DREAM_BOND_LINES,
  DREAM_DISTANT_LINES,
  DREAM_EXERCISE_LINES,
  DREAM_FAREWELL_LINES,
  DREAM_FORTUNE_LINES,
  DREAM_GLOOM_LINES,
  DREAM_GRATITUDE_LINES,
  DREAM_HEARTBREAK_LINES,
  DREAM_LATE_NIGHT_LINES,
  DREAM_LONELY_LINES,
  DREAM_NEUTRAL_LINES,
  DREAM_PET_LINES,
  DREAM_ROMANCE_LINES,
  DREAM_SETBACK_LINES,
} from "../content/dreamLines";

/** 新局前幾個遊戲日不做夢(也讓 balance-test 的 10 遊戲日完全碰不到本系統) */
export const DREAM_FIRST_DAY = 14;
/** 兩次夢境之間最少相隔幾個遊戲日 */
export const DREAM_MIN_GAP_DAYS = 3;
/** 實際間隔 = DREAM_MIN_GAP_DAYS + [0, DREAM_GAP_SPAN) → 3~4 天,決定性挑 */
const DREAM_GAP_SPAN = 2;
/** 冷卻鍵前綴(借用 interactionCooldowns 這張入存檔的表);值存的是遊戲日序號 */
const DREAM_CD_PREFIX = "dream|";
/** 關係要到「朋友」(tierLabel 的 35 分門檻)以上才算親近 */
const CLOSE_RELATION_VALUE = 35;

/** 睡著才會做夢(沙發睡死也算) */
const SLEEPING_STATES = new Set<TenantVisualState>(["sleeping_on_bed", "sleeping_on_couch"]);

/** 決定性雜湊:同輸入永遠同輸出,不消耗 Math.random(同 tick.cozyHomeIndex 的寫法) */
function dreamIndex(key: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % Math.max(1, size);
}

/**
 * 取 MEMORY_RULES 中含有該錨點關鍵字的那一組關鍵字。
 * 用錨點反查而不是寫死索引/複製一份,關鍵字表擴充時夢境主題自動跟著走。
 */
const keywordsOf = (anchor: string): string[] =>
  MEMORY_RULES.find((rule) => rule.keywords.includes(anchor))?.keywords ?? [anchor];

interface DreamTheme {
  id: string;
  /** 記憶標籤 label「包含」任一關鍵字即命中(比對法同 memoryEffects.labelDrift) */
  keywords: string[];
  lines: string[];
}

/** 記憶主題:對齊 MEMORY_RULES 的分類軸,挑語感上最適合做夢的十組 */
export const DREAM_THEMES: DreamTheme[] = [
  { id: "romance", keywords: keywordsOf("熱戀"), lines: DREAM_ROMANCE_LINES },
  { id: "heartbreak", keywords: keywordsOf("失戀"), lines: DREAM_HEARTBREAK_LINES },
  { id: "gloom", keywords: keywordsOf("低落"), lines: DREAM_GLOOM_LINES },
  { id: "farewell", keywords: keywordsOf("搬走"), lines: DREAM_FAREWELL_LINES },
  { id: "pet", keywords: keywordsOf("毛孩"), lines: DREAM_PET_LINES },
  { id: "exercise", keywords: keywordsOf("晨跑"), lines: DREAM_EXERCISE_LINES },
  { id: "lateNight", keywords: keywordsOf("熬夜"), lines: DREAM_LATE_NIGHT_LINES },
  { id: "gratitude", keywords: keywordsOf("感激"), lines: DREAM_GRATITUDE_LINES },
  { id: "lonely", keywords: keywordsOf("孤獨"), lines: DREAM_LONELY_LINES },
  { id: "fortune", keywords: keywordsOf("升遷"), lines: DREAM_FORTUNE_LINES },
  { id: "setback", keywords: keywordsOf("失業"), lines: DREAM_SETBACK_LINES },
];

export interface DreamPick {
  /** 主題 id:記憶主題用 DREAM_THEMES 的 id,關係主題用 bond/distant,保底用 neutral */
  themeId: string;
  lines: string[];
  /** 佔位符代換表({m} 記憶文字、{o} 對方名字、{tier} 親疏文字) */
  vars: Record<string, string>;
}

/** 佔位符代換(同 community.fillCommunity) */
const fillDream = (line: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), value), line);

/**
 * 決定今晚夢到什麼:記憶標籤優先 → 鄰居關係 → 保底池。
 * 全程決定性(同一遊戲日、同一租客、同樣的記憶與關係 ⇒ 同一個結果)。
 */
export function pickDreamTheme(rt: TenantRuntime): DreamPick {
  const id = rt.tenant.id;
  const day = gameDayIndex();

  // 1) 記憶標籤:蒐集所有命中的(標籤順序 × 主題順序 → 固定次序),再決定性挑一個
  const hits: { theme: DreamTheme; label: string }[] = [];
  for (const tag of rt.tenant.memoryTags) {
    for (const theme of DREAM_THEMES) {
      if (theme.keywords.some((k) => tag.label.includes(k))) hits.push({ theme, label: tag.label });
    }
  }
  if (hits.length) {
    const hit = hits[dreamIndex(`memory|${id}|${day}`, hits.length)];
    // 記憶標籤帶方括號([失戀]),進日誌前一律去掉(同 tick.pruneStaleMemories 的寫法)
    return { themeId: hit.theme.id, lines: hit.theme.lines, vars: { m: hit.label.replace(/[[\]]/g, "") } };
  }

  // 2) 沒有記憶就夢到鄰居(過濾自己與已不存在的租客,同 narration.buildNarrateCtx)
  const rels = listRelationships((tenantId) => state.runtimes[tenantId]?.tenant)
    .filter((r) => (r.aId === id || r.bId === id) && state.runtimes[r.aId] && state.runtimes[r.bId]);
  if (rels.length) {
    const rel = rels[dreamIndex(`relation|${id}|${day}`, rels.length)];
    const otherId = rel.aId === id ? rel.bId : rel.aId;
    const close = rel.romantic || rel.value >= CLOSE_RELATION_VALUE;
    return {
      themeId: close ? "bond" : "distant",
      lines: close ? DREAM_BOND_LINES : DREAM_DISTANT_LINES,
      vars: { o: state.runtimes[otherId].tenant.name, tier: rel.label },
    };
  }

  // 3) 兩者皆無 → 保底池(無佔位符,永遠成立)
  return { themeId: "neutral", lines: DREAM_NEUTRAL_LINES, vars: {} };
}

/** 組出這一則夢境日誌的文字(決定性;hour 併入雜湊,讓入睡時段不同的夜晚不會撞同一句) */
export function dreamLine(rt: TenantRuntime, day: number, hour: number): string {
  const pick = pickDreamTheme(rt);
  const line = pick.lines[dreamIndex(`line|${pick.themeId}|${rt.tenant.id}|${day}|${hour}`, pick.lines.length)];
  return fillDream(line, pick.vars);
}

/**
 * 每小時呼叫:睡著且冷卻到期的租客留下一則夢境日誌。
 * 冷卻以遊戲日計(gameDayIndex,22:00 換日),所以整個 22:00→06:00 的夜晚最多一則。
 */
export function dreamPass(hour: number): void {
  const day = gameDayIndex();
  if (day < DREAM_FIRST_DAY) return;
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent) continue; // 被事件凍結的租客 visualState 停在舊值,不該發夢
    if (!SLEEPING_STATES.has(rt.tenant.visualState)) continue;
    const key = `${DREAM_CD_PREFIX}${rt.tenant.id}`;
    const last = state.interactionCooldowns[key];
    if (last != null) {
      const gap = DREAM_MIN_GAP_DAYS + dreamIndex(`gap|${rt.tenant.id}|${last}`, DREAM_GAP_SPAN);
      if (day - last < gap) continue;
    }
    state.interactionCooldowns[key] = day;
    pushSocialLog(rt, dreamLine(rt, day, hour), "notable");
  }
}

/** 測試用:清掉所有夢境冷卻(比照 tick.resetCozyHomeCooldown) */
export function resetDreamCooldown(): void {
  for (const key of Object.keys(state.interactionCooldowns)) {
    if (key.startsWith(DREAM_CD_PREFIX)) delete state.interactionCooldowns[key];
  }
}
