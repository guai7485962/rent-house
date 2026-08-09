/**
 * 劇情弧的**本地引擎**:不靠 AI 也能開弧、推進、收束。
 *
 * 在此之前弧的主題只有 AI 生得出來,所以離線、免費額度用完、或走模板 fallback 的玩家
 * 永遠不會有連載。本檔依 `src/content/storyArcs.ts` 的種子目錄補上那條路徑。
 *
 * 與 AI 路徑的分工(關鍵不變式):
 * - **本地只碰自己開的弧**(`arc.seedId` 有值)。AI 開的弧一律不動。
 * - `rt.arc` 非空時本地不會開新弧 ⇒ AI 有額度時,主導權完全在 AI 手上。
 * - AI 仍可推進/收束本地開的弧(`sanitizeArcUpdate` 鎖住 id/theme/maxStage,
 *   spread 會保留 `seedId`/`localDay`),兩條路徑不會打架。
 * - 同一天只推進一步:`arc.localDay` 記上次推進的遊戲日。
 *
 * 🔴 **零 `Math.random`**:挑種子與間隔都用租客 id + 遊戲日的雜湊,
 * 不消耗亂數 ⇒ 不擾動其他系統的 RNG 次序,對 balance 快照零影響。
 */
import { STORY_ARC_SEEDS, type StoryArcSeed } from "../content/storyArcs";
import { applyArcTone } from "./arcs";
import { grantGrowthTag } from "./growth";
import { state, gameDayIndex, pushMemory, pushSocialLog, type TenantRuntime } from "./gameState";
import { boostWishFromArc } from "./wishes";

/** 本地弧的 id 前綴(和 AI 的 `arc_<timestamp>` 區隔,肉眼也看得出來) */
export const LOCAL_ARC_ID_PREFIX = "larc_";
/** 每幾個遊戲日推進一步(弧要有呼吸,不能一天走完) */
export const LOCAL_ARC_ADVANCE_EVERY_DAYS = 2;
/** 沒有弧的日子裡,每天有 1/N 的決定性機會開一條新的(平均 N 天開一條) */
const START_CHANCE_DENOM = 6;

/** FNV-1a 32-bit:與咖啡廳線同一套決定性雜湊,零 RNG。 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 這位租客抽得到哪些種子:職業或核心標籤命中任一即可;兩者都沒寫 = 誰都可以。 */
export function eligibleSeeds(rt: TenantRuntime): StoryArcSeed[] {
  const occupation = rt.tenant.occupation;
  const tags = new Set(rt.tenant.coreTags.map((t) => t.id));
  return STORY_ARC_SEEDS.filter((seed) => {
    const wantsOccupation = (seed.occupations?.length ?? 0) > 0;
    const wantsTag = (seed.tags?.length ?? 0) > 0;
    if (!wantsOccupation && !wantsTag) return true;
    if (wantsOccupation && seed.occupations!.includes(occupation)) return true;
    return wantsTag && seed.tags!.some((t) => tags.has(t));
  });
}

/**
 * 這位租客在這一天會開哪一條種子弧;不該開時回 null。
 * 純函式(只讀 runtime 與遊戲日),測試可以直接對打。
 */
export function pickSeedForDay(rt: TenantRuntime, day: number): StoryArcSeed | null {
  if (rt.arc) return null;
  const pool = eligibleSeeds(rt);
  if (!pool.length) return null;
  const id = rt.tenant.id;
  if (hash(`${id}|arcstart|${day}`) % START_CHANCE_DENOM !== 0) return null;
  // 不要一直重播同一條:最近的經歷記憶裡出現過的主題先排除,全排除掉就不開。
  const recent = new Set((rt.tenant.memoryTags ?? []).map((m) => m.label));
  const fresh = pool.filter((seed) => !recent.has(`[經歷:${seed.theme}]`));
  const usable = fresh.length ? fresh : [];
  if (!usable.length) return null;
  return usable[hash(`${id}|arcpick|${day}`) % usable.length];
}

function startLocalArc(rt: TenantRuntime, seed: StoryArcSeed, day: number) {
  const first = seed.stages[0];
  rt.arc = {
    id: `${LOCAL_ARC_ID_PREFIX}${seed.id}_${day}`,
    theme: seed.theme,
    stage: 1,
    maxStage: seed.stages.length,
    summary: first.summary,
    seedId: seed.id,
    localDay: day,
  };
  pushSocialLog(rt, `📖 新篇章開始:「${seed.theme}」`, "notable");
  pushSocialLog(rt, first.line, "notable");
  applyArcTone(rt, "advance", first.tone);
}

function concludeLocalArc(rt: TenantRuntime, seed: StoryArcSeed) {
  rt.arc = null;
  pushSocialLog(rt, seed.conclude.line, "notable");
  applyArcTone(rt, "conclude", seed.conclude.tone);
  boostWishFromArc(rt, seed.conclude.tone); // 好好落幕 = 人生心願也往前一步(同 AI 路徑)
  const growth = grantGrowthTag(rt.tenant, seed.conclude.growthTag);
  pushMemory(rt.tenant, `[經歷:${seed.theme}]`, "這段經歷已成為他的一部分", "ai_event");
  pushSocialLog(rt, `📕 篇章落幕:「${seed.theme}」`, "notable");
  if (growth) pushSocialLog(rt, `🌱 成長:${growth.label}——${growth.hint}`, "notable");
}

/** 推進一位租客的本地弧一步(該推進時);回傳是否真的動了。 */
function stepOne(rt: TenantRuntime, day: number): boolean {
  const arc = rt.arc;
  if (!arc) {
    const seed = pickSeedForDay(rt, day);
    if (!seed) return false;
    startLocalArc(rt, seed, day);
    return true;
  }
  if (!arc.seedId) return false; // AI 開的弧,不碰
  const seed = STORY_ARC_SEEDS.find((s) => s.id === arc.seedId);
  if (!seed) { rt.arc = null; return true; } // 種子被刪過的舊存檔:安靜收掉,不留半條殭屍弧
  if (day - (arc.localDay ?? day) < LOCAL_ARC_ADVANCE_EVERY_DAYS) return false;

  const nextStage = arc.stage + 1;
  if (nextStage > seed.stages.length) {
    concludeLocalArc(rt, seed);
    return true;
  }
  const step = seed.stages[nextStage - 1];
  arc.stage = nextStage;
  arc.summary = step.summary;
  arc.localDay = day;
  pushSocialLog(rt, step.line, "notable");
  applyArcTone(rt, "advance", step.tone);
  // 最後一階段走完的隔一個推進窗才落幕,讓「最後一步」有機會被玩家看到
  return true;
}

/**
 * 每日一次:替所有現任租客推進本地劇情弧。由 `tick.ts` 的換日區塊呼叫。
 * 回傳這次動到的租客數(測試與除錯用)。
 */
export function localArcPass(): number {
  const day = gameDayIndex();
  let touched = 0;
  // 固定用 id 排序,不吃物件列舉順序 ⇒ 同一存檔跑兩次結果一致
  for (const id of Object.keys(state.runtimes).sort()) {
    if (stepOne(state.runtimes[id], day)) touched++;
  }
  return touched;
}
