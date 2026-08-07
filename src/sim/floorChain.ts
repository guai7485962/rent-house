/**
 * 月度全樓事件鏈(章節感):8 條鏈 × 4 階段的跨日連鎖劇情。
 *
 * 都更傳聞 / 颱風夜停電 / 頂樓漏水整修 / 樓下的檢舉信 / 停水三天 / 後巷的一窩小貓 /
 * 樓下開了夜市攤 / 前房客回來拿東西——每條鏈約 4 遊戲日推進一話,
 * 四話走完後休息一段時間再換下一條,讓掛機生活有「這個月正在發生一件事」的章節感。
 * 一個月一條、開章排除上一條 ⇒ 8 條約可撐一年不重複。
 *
 * **資料與邏輯分家**:章節文本與數值全在 `src/content/floorChains.ts`(純資料,零 sim import);
 * 本檔只留挑鏈/推進/收束/結算,以及與別的系統的掛勾表(STAGE_HOOKS / CHOICE_HOOKS)。
 *
 * 刻意的設計約束:
 * - **零 RNG**:選鏈、選文案一律用決定性雜湊(同 community.sceneIndex / weather 的作法),
 *   不呼叫 Math.random,才不會改變 balance 快照的亂數次序。
 * - **純模板文案**:章節文字全部寫死,離線補進度、AI 額度用完時一樣成立;
 *   只在關鍵階段掛一個「純中文人話」的伏筆旗標,讓既有 AI 每日觀察自然提到它
 *   (旗標不含系統鍵,可安全餵給模型,不必進 narration 的過濾名單)。
 * - **獨立抉擇槽**:用 state.pendingChainEvent,不與 state.pendingGroupEvent 共用——
 *   後者有 group_any 3 日冷卻,共用會兩邊互相餓死。
 * - **可跳階、冪等**:掛機補進度時中間的遊戲日不會被 hourlyTick 走過,所以推進條件寫成
 *   「距上次推進 ≥ STAGE_DAYS 就推一話」,每次 pass 最多推一話(不會重複發),
 *   拖太久(超過 CHAIN_MAX_DAYS)則跳過中間話直接收束到最後一話。
 * - **前 CHAIN_FIRST_DAY 天不開章**:新局先讓玩家熟悉基本循環,也讓 balance-test
 *   的 10 遊戲日固定種子跑完全程碰不到本系統(零漂移)。
 */
import type { ChainEvent, FloorChainEntry, GroupChoice, GroupDelta } from "../types";
import { FLOOR_CHAINS, LITTER_KITTEN_NAMES, type ChainDef, type ChainStage } from "../content/floorChains";
import { state, addFlag, clamp, gameDayIndex, notify, pushMemory, pushSocialLog, type TenantRuntime } from "./gameState";
import { adjustGroupBond, adjustTension } from "./social";
import { clearNoiseMemories } from "./memoryEffects";
import { adoptCat } from "./pets";
import { clampCafePopularity } from "./cafe";
import { addMoney } from "./economy";
import { save } from "./persistence";
import { spawnFx } from "../floor/fx";
import { LOUNGE_HALL_RECT } from "../floor/map";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "./clock";
import { clearGroupScene, startGroupScene } from "../floor/groupScene";

/** 每話之間的遊戲日間隔 */
export const STAGE_DAYS = 4;
/** 一條鏈完結後,隔多少遊戲日才開下一條(4 話 12 天 + 休息 16 天 ≈ 28~30 天一輪) */
export const CHAIN_REST_DAYS = 16;
/** 新局前幾天不開章(也讓 balance-test 的 10 遊戲日完全碰不到本系統) */
export const CHAIN_FIRST_DAY = 14;
/** 一條鏈最多拖這麼多遊戲日;超過就跳過中間話、直接收束到最後一話 */
export const CHAIN_MAX_DAYS = 30;

/** 章節鏈資料在 `src/content/floorChains.ts`(純資料);本檔只留邏輯。 */
export const CHAIN_DEFS: ChainDef[] = FLOOR_CHAINS;

export const CHAIN_STAGE_COUNT = 4;

/** 決定性雜湊(同 community.sceneIndex 的寫法):同輸入永遠同輸出,不消耗 Math.random */
function chainIndex(key: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % Math.max(1, size);
}

/** 目前「在場」的租客:沒外出、也沒卡著待決事件(有 pendingEvent 者已被模擬凍結) */
function presentTenants(): TenantRuntime[] {
  return Object.values(state.runtimes)
    .filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent)
    .sort((a, b) => a.tenant.id.localeCompare(b.tenant.id)); // 固定順序 → 文案與關係變化可重現
}

function applyChainDelta(rt: TenantRuntime, d?: GroupDelta) {
  if (!d) return;
  const s = rt.tenant.stats;
  if (d.mood) s.mood = clamp(s.mood + d.mood, 0, 100);
  if (d.stress) s.stress = clamp(s.stress + d.stress, 0, 100);
  if (d.affinity) s.affinity = clamp(s.affinity + d.affinity, 0, 100);
  if (d.satisfaction) rt.satisfaction = clamp(rt.satisfaction + d.satisfaction, 0, 100);
}

function bondAll(parts: TenantRuntime[], delta: number) {
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) adjustGroupBond(parts[i].tenant, parts[j].tenant, delta);
}

/**
 * 文案替換記號。目前只有 `{alumni}`:接 state.alumni(名冊,最近離開的排最前面)。
 * 名冊空的時候退回泛稱,`old_resident_return` 在全新存檔一樣講得通。
 */
function fillChainText(text: string): string {
  if (!text.includes("{alumni}")) return text;
  return text.replaceAll("{alumni}", state.alumni[0]?.name ?? "以前那位房客");
}

/**
 * 這一話的旁白:`notice` 與 `notices` 合成一個池,依「鏈 id + 話數 + 開章日」決定性挑一句。
 * 開章日進 key ⇒ 同一條鏈下次再輪到時多半換一句,但同一次跑動內重複呼叫必得同一句(冪等)。
 */
function noticeFor(defId: string, stage: number, st: ChainStage, startDay: number): string {
  const pool = st.notices?.length ? [st.notice, ...st.notices] : [st.notice];
  return fillChainText(pool[chainIndex(`notice|${defId}|${stage}|${startDay}`, pool.length)]);
}

// ---------------------------------------------------------------------------
// 與既有系統的掛勾
//
// 內容檔只寫文案與 GroupDelta;真正動到**別的系統**的效果一律寫在這裡,理由有三:
//  1. 內容檔要保持零 sim import(純資料),補文本的人不必懂 sim;
//  2. 掛勾要能被 code review 一眼看完,不會散落在幾百行 JSON 樣的資料裡;
//  3. **不新增存檔欄位**——全部走既有欄位(rt.cleanliness / stats.wellbeing /
//     relationships.tension / state.pets / state.cafe.popularity / memoryTags)。
// 鍵值:階段掛勾用 `鏈id|話數`,抉擇掛勾用 `鏈id|選項id`。
// ---------------------------------------------------------------------------

function bumpCleanliness(parts: TenantRuntime[], delta: number) {
  for (const rt of parts) rt.cleanliness = clamp(rt.cleanliness + delta, 0, 100);
}

function bumpWellbeing(parts: TenantRuntime[], delta: number) {
  for (const rt of parts) rt.tenant.stats.wellbeing = clamp(rt.tenant.stats.wellbeing + delta, 0, 100);
}

function tensionAll(parts: TenantRuntime[], delta: number) {
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) adjustTension(parts[i].tenant.id, parts[j].tenant.id, delta);
}

/** 咖啡廳沒開張就沒有聲譽可動(不會偷偷把 popularity 從 0 推起來) */
function bumpCafePopularity(delta: number) {
  if (!state.cafe.open) return;
  state.cafe.popularity = clampCafePopularity(state.cafe.popularity + delta);
}

/**
 * `stray_litter` 選「留下來」:真的多一隻貓,給「租客撿到寵物」一條**不靠 AI** 的路徑
 * (`data/events.json` 的規則事件目錄一則都沒提供 adopt_cat)。
 * 🔴 名字與花色一律決定性挑選 → 不碰 Math.random,零 RNG 約束仍成立。
 */
function adoptLitterKitten(parts: TenantRuntime[]) {
  const target = parts.find((rt) => !state.pets[rt.tenant.id]);
  if (!target) return;
  const seed = `${target.tenant.id}|${state.floorChain?.startDay ?? 0}`;
  adoptCat(target.tenant.id, {
    name: LITTER_KITTEN_NAMES[chainIndex(`kitten|${seed}`, LITTER_KITTEN_NAMES.length)],
    color: 1 + chainIndex(`kittenColor|${seed}`, 3), // 0 號橘貓是種子租客專屬
  });
}

/** 每話播出後的額外系統效果(只在正式播出時跑;補進度跳過的中間話不套) */
const STAGE_HOOKS: Record<string, (parts: TenantRuntime[]) => void> = {
  // 停水:提水那幾天身心與整潔一起掉,復水後補回來
  "water_outage|2": (parts) => { bumpWellbeing(parts, -3); bumpCleanliness(parts, -6); },
  "water_outage|4": (parts) => { bumpWellbeing(parts, 4); bumpCleanliness(parts, 8); },
  // 夜市:油煙讓房間變髒,人潮反而幫咖啡廳帶客;收攤後兩者都回落
  "night_market|2": (parts) => { bumpCleanliness(parts, -6); bumpCafePopularity(4); },
  "night_market|4": (parts) => { bumpCleanliness(parts, 6); bumpCafePopularity(-2); },
};

/** 房東拍板後的額外系統效果 */
const CHOICE_HOOKS: Record<string, (parts: TenantRuntime[]) => void> = {
  // 噪音:隔音把積怨壓下去並清掉「被噪音困擾」的記憶;擺爛則讓積怨繼續長
  "noise_complaint_chain|soundproof": (parts) => {
    for (const rt of parts) clearNoiseMemories(rt.tenant);
    tensionAll(parts, -8);
  },
  "noise_complaint_chain|mediate": (parts) => tensionAll(parts, -5),
  "noise_complaint_chain|ignore": (parts) => tensionAll(parts, 6),
  // 停水
  "water_outage|tanker": (parts) => { bumpWellbeing(parts, 5); bumpCleanliness(parts, 10); },
  "water_outage|schedule": (parts) => bumpWellbeing(parts, 2),
  "water_outage|wait": (parts) => bumpWellbeing(parts, -3),
  // 小貓:真的領養(規則路徑的 adopt_cat)
  "stray_litter|keep": adoptLitterKitten,
  // 夜市
  "night_market|filter": (parts) => { bumpCleanliness(parts, 10); bumpCafePopularity(2); },
  "night_market|ignore": () => bumpCafePopularity(-3),
  // 舊房客:一起把箱子翻完的人會留下一段記憶(進 memoryTags,之後影響敘事與行為)
  "old_resident_return|sort": (parts) => {
    for (const rt of parts) pushMemory(rt.tenant, "和舊房客的重逢", "偶爾會主動提起以前住這裡的人", "landlord_decision");
  },
};

function runStageHook(defId: string, stage: number, parts: TenantRuntime[]) {
  if (parts.length) STAGE_HOOKS[`${defId}|${stage}`]?.(parts);
}

function runChoiceHook(chainId: string, choice: GroupChoice, parts: TenantRuntime[]) {
  if (parts.length) CHOICE_HOOKS[`${chainId}|${choice.id}`]?.(parts);
}

/** 交誼廳大廳中央掛一個特效;現實時間與遊戲時間雙重過期,快轉不會殘留 */
function loungeFx(kind: "chat" | "anger" | "lights") {
  const c = Math.floor((LOUNGE_HALL_RECT.c0 + LOUNGE_HALL_RECT.c1) / 2);
  const r = Math.floor((LOUNGE_HALL_RECT.r0 + LOUNGE_HALL_RECT.r1) / 2);
  spawnFx(kind, c, r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
}

export const chainDef = (chainId: string) => CHAIN_DEFS.find((d) => d.id === chainId) ?? null;

/** 清掉全樓身上這條鏈留下的伏筆旗標(鏈結束時呼叫,免得擠掉既有伏筆) */
function clearChainFlags(chainId: string) {
  const flags = new Set((chainDef(chainId)?.stages ?? []).map((s) => s.flag).filter(Boolean) as string[]);
  if (!flags.size) return;
  for (const rt of Object.values(state.runtimes)) {
    for (let i = rt.flags.length - 1; i >= 0; i--) if (flags.has(rt.flags[i])) rt.flags.splice(i, 1);
  }
}

function pushEntry(entry: FloorChainEntry) {
  const chain = state.floorChain;
  if (!chain) return;
  if (chain.entries.some((e) => e.stage === entry.stage)) return; // 冪等:同一話不重複記
  chain.entries.push(entry);
}

/** 開一條新鏈(決定性選鏈:排除上一條,避免連續同題材) */
function startChain(day: number): boolean {
  const prevId = state.floorChain?.chainId;
  const pool = CHAIN_DEFS.filter((d) => d.id !== prevId);
  const def = pool[chainIndex(`floorChain|${day}`, pool.length)] ?? CHAIN_DEFS[0];
  state.floorChain = {
    chainId: def.id,
    stage: 0,
    startDay: day,
    lastAdvanceDay: day - STAGE_DAYS, // 開章當天就播第一話
    entries: [],
    done: false,
  };
  return fireStage(day, 1, false);
}

/**
 * 播一話。quiet=true 表示這是補進度時被跳過的中間話:只留章節紀錄,
 * 不套數值、不發個人日誌、不掛抉擇(避免離線回來被一次灌爆)。
 */
function fireStage(day: number, stage: number, quiet: boolean): boolean {
  const chain = state.floorChain;
  if (!chain) return false;
  const def = chainDef(chain.chainId);
  if (!def) {
    // 未知鏈 id(舊存檔或改版移除)→ 安全收束,不讓狀態卡死
    chain.done = true;
    state.lastChainEndDay = day;
    return false;
  }
  const st = def.stages[stage - 1];
  if (!st) return false;
  chain.stage = stage;
  chain.lastAdvanceDay = day;

  const notice = noticeFor(def.id, stage, st, chain.startDay);
  pushEntry({ stage, title: fillChainText(st.title), text: quiet ? "(這幾天忙著別的事,這一段悄悄過去了)" : notice, gameMs: state.gameMs, skipped: quiet || undefined });

  if (!quiet) {
    const parts = presentTenants();
    for (const rt of parts) {
      const line = fillChainText(st.lines[chainIndex(`${def.id}|${stage}|${rt.tenant.id}`, st.lines.length)]);
      pushSocialLog(rt, line, "notable");
      applyChainDelta(rt, st.effect);
      if (st.flag) addFlag(rt, st.flag);
    }
    if (st.bond && parts.length >= 2) bondAll(parts, st.bond);
    runStageHook(def.id, stage, parts);
    if (st.scene && parts.length > 0) {
      startGroupScene({
        id: `chain:${def.id}:${stage}:${state.gameMs}`,
        title: `${def.icon} ${st.title}`,
        venue: "lounge",
        layout: st.scene.layout,
        participantIds: parts.map((p) => p.tenant.id),
        fx: st.fx,
        gameNow: state.gameMs,
        priority: 2,
      });
    } else if (st.fx) {
      loungeFx(st.fx);
    }
    notify(`${def.icon} 【${def.title}】${fillChainText(st.title)}——${notice}`);
    if (st.decision) {
      state.pendingChainEvent = {
        chainId: def.id,
        stage,
        id: `${def.id}_s${stage}`,
        title: fillChainText(st.decision.title),
        description: fillChainText(st.decision.description),
        participantIds: parts.map((p) => p.tenant.id),
        choices: st.decision.choices,
      };
    }
  }

  if (stage >= def.stages.length) endChain(day);
  return true;
}

function endChain(day: number) {
  const chain = state.floorChain;
  if (!chain || chain.done) return;
  chain.done = true;
  state.lastChainEndDay = day;
  clearChainFlags(chain.chainId);
}

/**
 * 換日呼叫:必要時開新章或推進一話。回傳是否有推進(給測試與除錯用)。
 * 每次 pass 最多推一話,不會重複發;拖過 CHAIN_MAX_DAYS 則跳過中間話直接收束。
 */
export function floorChainPass(): boolean {
  const day = gameDayIndex();
  if (state.pendingChainEvent) return false; // 有待決抉擇 → 停在原地等房東拍板
  const chain = state.floorChain;

  if (!chain || chain.done) {
    if (day < CHAIN_FIRST_DAY) return false;
    if (day - state.lastChainEndDay < CHAIN_REST_DAYS) return false;
    return startChain(day);
  }

  const def = chainDef(chain.chainId);
  if (!def) {
    chain.done = true;
    state.lastChainEndDay = day;
    return false;
  }
  if (chain.stage >= def.stages.length) {
    endChain(day); // 舊存檔可能停在最後一話卻沒收束
    return false;
  }
  if (day - chain.lastAdvanceDay < STAGE_DAYS) return false;

  // 拖太久(長時間掛機/補進度):中間話只留紀錄,直接收束到最後一話
  if (day - chain.startDay >= CHAIN_MAX_DAYS) {
    for (let s = chain.stage + 1; s < def.stages.length; s++) fireStage(day, s, true);
    return fireStage(day, def.stages.length, false);
  }
  return fireStage(day, chain.stage + 1, false);
}

/** 房東拍板章節抉擇:套用效果到參與者、記帳、補記章節卡,清掉待決槽 */
export function resolveChainEvent(choiceId: string): boolean {
  const ev = state.pendingChainEvent;
  if (!ev) return false;
  const choice = ev.choices.find((c) => c.id === choiceId);
  if (!choice) return false;
  const def = chainDef(ev.chainId);
  if (choice.money) addMoney(choice.money, `全樓章節:${ev.title}`, "event");
  const parts = ev.participantIds.map((id) => state.runtimes[id]).filter(Boolean) as TenantRuntime[];
  for (const rt of parts) {
    applyChainDelta(rt, choice.all);
    rt.unhappyHours = 0;
    pushSocialLog(rt, `${def?.icon ?? "📖"} 「${ev.title}」——房東選擇了「${choice.label}」。`, "notable");
  }
  if (choice.bond && parts.length >= 2) bondAll(parts, choice.bond);
  runChoiceHook(ev.chainId, choice, parts);
  const entry = state.floorChain?.entries.find((e) => e.stage === ev.stage);
  if (entry) entry.decision = choice.label;
  state.pendingChainEvent = null;
  save();
  return true;
}

export interface FloorChainView {
  chainId: string;
  icon: string;
  title: string;
  stage: number;
  total: number;
  done: boolean;
  entries: FloorChainEntry[];
}

/** 動態頁章節卡的唯讀視圖;沒有進行中/剛完結的章節回 null */
export function floorChainView(): FloorChainView | null {
  const chain = state.floorChain;
  if (!chain) return null;
  const def = chainDef(chain.chainId);
  if (!def) return null;
  return {
    chainId: def.id,
    icon: def.icon,
    title: def.title,
    stage: chain.stage,
    total: def.stages.length,
    done: chain.done,
    entries: chain.entries,
  };
}

/** 測試用:把章節鏈狀態清乾淨(含全樓旗標) */
export function resetFloorChain() {
  if (state.floorChain) clearChainFlags(state.floorChain.chainId);
  state.floorChain = null;
  state.pendingChainEvent = null;
  state.lastChainEndDay = -99;
  clearGroupScene();
}
