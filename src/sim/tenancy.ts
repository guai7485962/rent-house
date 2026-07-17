/**
 * 租約與人事(store 拆分:tenancy 模組)。
 * 招租應徵者池、入住、退租、同居/分手搬遷,以及房東抉擇(decide)的後果套用。
 */
import type { Tenant } from "../types";
import { generateApplicants, rescoreApplicants, type Applicant } from "./recruit";
import { registerRoutine } from "./routine";
import {
  removeTenantRelations,
  getRel,
  listRelationships,
  adjustRelationship,
  setCouple,
  canRomance,
} from "./social";
import type { EventEffect } from "./events";
import { DIRECTIVES } from "./directives";
import { endFeud } from "./conflicts";
import { forceInteraction } from "./interactions";
import { adoptCat } from "./pets";
import { recordAlumnus } from "./legacy";
import { ensureWishes } from "./wishes";
import {
  state,
  clamp,
  fmt,
  gameDayIndex,
  notify,
  pushMemory,
  pushSocialLog,
  addFlag,
  applySocialEffect,
  refreshAppearances,
  makeRuntime,
  isVacant,
  canStartCohabit,
  ROOM_APPEARANCE,
  type TenantRuntime,
} from "./gameState";
import { applyHour } from "./tick";
import { addMoney, applyRentAction, DEPOSIT_MONTHS } from "./economy";
import { upgradeTolBonus } from "./upgrades";
import { setCustomAppearance } from "../pixel/scene";
import { randomAppearance } from "../pixel/parts";
import { save } from "./persistence";

/** 取得某空房的應徵者(每遊戲日換一批;重開面板/重整頁面不重抽,星等隨當前裝潢即時更新) */
export function getApplicants(roomId: string): Applicant[] {
  const day = gameDayIndex();
  const pool = state.applicantPools[roomId];
  if (!pool || pool.day !== day || pool.applicants.length === 0) {
    const excludeNames = Object.values(state.runtimes).map((rt) => rt.tenant.name);
    state.applicantPools[roomId] = { day, applicants: generateApplicants(roomId, excludeNames) };
    save();
  }
  return rescoreApplicants(state.applicantPools[roomId].applicants, roomId);
}

/** 重新刊登費用(§7-1 招租費用):不想等明天,花錢立刻換一批應徵者 */
export const RELIST_COST = 800;

/** 重新刊登:扣費 → 立刻重抽這間房的應徵者池(當日批次直接替換) */
export function relistApplicants(roomId: string): { ok: boolean; reason?: string } {
  if (state.money < RELIST_COST) return { ok: false, reason: "金錢不足" };
  addMoney(-RELIST_COST, `重新刊登 ${roomId.replace(/^r/, "")} 房招租`, "other");
  const excludeNames = Object.values(state.runtimes).map((rt) => rt.tenant.name);
  state.applicantPools[roomId] = { day: gameDayIndex(), applicants: generateApplicants(roomId, excludeNames) };
  save();
  return { ok: true };
}

/** 招租入住:把一位應徵者變成正式租客 */
export function moveIn(roomId: string, ap: Applicant) {
  if (!isVacant(roomId)) return;
  const roomNo = roomId.replace(/^r/, "");
  const tenant: Tenant = {
    id: ap.id,
    name: ap.name,
    occupation: ap.occupation,
    bio: ap.bio,
    gender: ap.gender,
    attractedTo: ap.attractedTo,
    appearance: ap.appearance ?? randomAppearance(), // 舊池子的應徵者沒有外觀 → 入住時補抽
    isAdult: ap.isAdult ?? true,
    coreTags: ap.coreTags,
    memoryTags: [],
    finance: { monthlyRent: ap.monthlyRent, paymentReliability: 80, monthsOverdue: 0 },
    stats: { mood: 72, stress: 28, wellbeing: 70, energy: 65, affinity: 55 },
    preferences: ap.preferences,
    visualState: "idle",
    recentSummary: `${ap.name} 剛搬進 ${roomNo} 房。${ap.bio}`,
  };
  const rt = makeRuntime(tenant, roomNo, 70, []);
  rt.archetypeKey = ap.archetypeKey;
  rt.moveInMs = state.gameMs; // 動態入住:從現在起算「住了幾天」
  state.runtimes[ap.id] = rt;
  state.occupancy[roomId] = ap.id;
  delete state.applicantPools[roomId]; // 房間租出去,該池作廢
  for (const p of Object.values(state.applicantPools)) p.applicants = p.applicants.filter((x) => x.name !== ap.name); // 別的房不能再出現同名應徵者
  registerRoutine(ap.id, ap.archetypeKey);
  if (tenant.appearance) setCustomAppearance(tenant.id, tenant.appearance); // 部件化外觀登錄(髮型/配件/衣色)
  refreshAppearances(); // 指派配色(依房間,確保彼此不同;有部件外觀者角色色由 Appearance 覆蓋)
  applyHour(rt, new Date(state.gameMs).getHours(), false); // 定位到當前活動
  if (ap.pet) adoptCat(ap.id, ap.pet); // 自帶寵物 → 入住即成為飼主(§A-1)
  ensureWishes(); // 依職業指派人生心願(入住當下就看得到,不用等換日)
  const deposit = ap.monthlyRent * DEPOSIT_MONTHS; // 入住押金:招租一次性收入
  if (deposit > 0) addMoney(deposit, `${ap.name} 入住押金`, "other");
  save();
}

/** 租客退租搬走:清空房間佔用、移除 runtime、清掉別人身上關於他的記憶 */
export function moveOut(tenantId: string, reason: string) {
  const rt = state.runtimes[tenantId];
  if (!rt) return;
  const name = rt.tenant.name;
  // 帶著欠款離開:這筆收不回來了,至少讓房東知道(名冊原因不變)
  if ((rt.arrears ?? 0) > 0) notify(`💸 ${name} 帶著 $${rt.arrears} 的未繳欠租搬走了`);
  recordAlumnus(rt, reason); // 進歷任房客名冊(趁 runtime 還在;§G-8)
  // 在清除關係前,先記下誰跟他親近(留一筆「搬走了」的記憶給留下的人)
  const bonds = listRelationships().filter((r) => r.aId === tenantId || r.bId === tenantId);
  const entry = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId);
  if (entry) {
    delete state.occupancy[entry[0]];
    // 若有同居者住在這間房 → 伴侶接手承租(轉正,開始付租)
    const mateId = Object.keys(state.cohabits).find((id) => state.cohabits[id] === entry[0]);
    if (mateId && state.runtimes[mateId] && mateId !== tenantId) {
      delete state.cohabits[mateId];
      state.occupancy[entry[0]] = mateId;
      state.runtimes[mateId].roomNo = entry[0].replace(/^r/, "");
    }
  }
  delete state.cohabits[tenantId];
  state.pendingDiaries.splice(0, state.pendingDiaries.length, ...state.pendingDiaries.filter((job) => job.tenantId !== tenantId));
  delete state.runtimes[tenantId];
  removeTenantRelations(tenantId);
  // 其他租客身上「提到他」的記憶標籤一併移除(人都走了,AI 不該再寫跟他的互動)
  for (const other of Object.values(state.runtimes)) {
    const t = other.tenant;
    // 雙人弧的另一位主角搬走 → 弧降級為單人繼續(AI 會自然把「對方離開」寫進後續推進)
    if (other.arc?.partnerId === tenantId) {
      other.arc = { ...other.arc, partnerId: undefined, partnerName: undefined };
      pushSocialLog(other, `📖 篇章「${other.arc.theme}」的另一位主角 ${name} 搬走了,故事只能自己寫下去。`, "notable");
    }
    t.memoryTags = t.memoryTags.filter((m) => !m.label.includes(name) && !m.behaviorHint.includes(name));
    const bond = bonds.find((b) => b.aId === t.id || b.bId === t.id);
    if (bond && (bond.romantic || bond.value >= 50)) {
      pushMemory(t, `[${name}搬走了]`, `親近的${bond.romantic ? "戀人" : "朋友"} ${name} 已退租離開,心裡有些失落。`, "ai_event");
    }
  }
  if (state.pendingCohabit && (state.pendingCohabit.aId === tenantId || state.pendingCohabit.bId === tenantId)) {
    state.pendingCohabit = null;
  }
  if (state.activeId === tenantId) state.activeId = Object.keys(state.runtimes)[0] ?? "";
  refreshAppearances();
  notify(`${name} 退租搬走了(${reason})`);
  save();
}

// ---------------------------------------------------------------------------
// 房東主動終止居住
// ---------------------------------------------------------------------------

export type EvictionMode = "agreement" | "forced";
export const AGREEMENT_COMPENSATION_MONTHS = 1;
export const FORCED_EVICTION_AFFINITY = -8;
export const FORCED_EVICTION_SATISFACTION = -10;

export interface EvictionPreview {
  mode: EvictionMode;
  cost: number;
  canAfford: boolean;
  isLeaseHolder: boolean;
  handoffName: string | null;
}

/** 玩家請離前的唯讀預覽；同居者也可以單獨終止居住。 */
export function previewEviction(tenantId: string, mode: EvictionMode): EvictionPreview | null {
  const rt = state.runtimes[tenantId];
  if (!rt) return null;
  const ownRoom = Object.entries(state.occupancy).find(([, id]) => id === tenantId)?.[0] ?? null;
  const handoffId = ownRoom
    ? Object.keys(state.cohabits).find((id) => id !== tenantId && state.cohabits[id] === ownRoom)
    : null;
  const cost = mode === "agreement"
    ? Math.max(0, Math.round(rt.tenant.finance.monthlyRent * AGREEMENT_COMPENSATION_MONTHS))
    : 0;
  return {
    mode,
    cost,
    canAfford: state.money >= cost,
    isLeaseHolder: ownRoom !== null,
    handoffName: handoffId ? state.runtimes[handoffId]?.tenant.name ?? null : null,
  };
}

/**
 * 玩家主動請房客離開：協議解約要付一個月搬遷補償；強制請離免費，
 * 但所有留下的住戶都會降低對房東的信任與居住滿意度。
 */
export function evictTenant(tenantId: string, mode: EvictionMode): { ok: boolean; text: string } {
  const rt = state.runtimes[tenantId];
  const preview = previewEviction(tenantId, mode);
  if (!rt || !preview) return { ok: false, text: "這位房客已經不在這裡了" };
  const name = rt.tenant.name;

  if (mode === "agreement") {
    if (!preview.canAfford) {
      return { ok: false, text: `現金不足，協議解約需要 $${preview.cost.toLocaleString()} 搬遷補償` };
    }
    if (preview.cost > 0) addMoney(-preview.cost, `${name} 協議解約搬遷補償`, "other");
    moveOut(tenantId, `與房東協議解約（補償 $${preview.cost.toLocaleString()}）`);
    return { ok: true, text: `${name} 已接受協議解約並搬走` };
  }

  moveOut(tenantId, "遭房東強制請離");
  for (const other of Object.values(state.runtimes)) {
    other.tenant.stats.affinity = clamp(other.tenant.stats.affinity + FORCED_EVICTION_AFFINITY, 0, 100);
    applySocialEffect(other, {
      satisfaction: FORCED_EVICTION_SATISFACTION,
      mood: -4,
      stress: 4,
    });
    other.unhappyHours += 12;
    pushMemory(
      other.tenant,
      `[目睹${name}被強制請離]`,
      `房東沒有協議就讓 ${name} 搬走，開始擔心自己是否也會突然失去住處。`,
      "landlord_decision",
    );
    pushSocialLog(other, `⚠️ 房東強制請 ${name} 搬走，整棟公寓的氣氛變得不安。`, "major");
  }
  notify(`${name} 已被強制請離；其他住戶對房東的信任下降。`);
  save();
  return { ok: true, text: `${name} 已被強制請離` };
}

/** 同居情侶分手:同居的一方搬離伴侶房(有空房就搬過去續租,沒有就退租離開) */
export function endCohabitOnBreakup(aId: string, bId: string) {
  const mateId = state.cohabits[aId] ? aId : state.cohabits[bId] ? bId : null;
  if (!mateId) return;
  const rt = state.runtimes[mateId];
  if (!rt) return;
  const vacant = Object.keys(ROOM_APPEARANCE).find((roomId) => !state.occupancy[roomId]);
  if (vacant) {
    delete state.cohabits[mateId];
    state.occupancy[vacant] = mateId;
    rt.roomNo = vacant.replace(/^r/, "");
    refreshAppearances();
    pushSocialLog(rt, `💔 分手後搬到 ${rt.roomNo} 房,一個人重新開始。`, "major");
    notify(`${rt.tenant.name} 分手後搬進了空房 ${rt.roomNo}。`);
  } else {
    moveOut(mateId, "分手後無處可住,搬離公寓");
  }
}

/** 同居抉擇:同意 → b 搬進 a 的房一起住(b 仍是遊戲中的角色!空出 b 的房、少一份租、兩人大加成) */
export function resolveCohabit(accept: boolean) {
  const pc = state.pendingCohabit;
  if (!pc) return;
  state.pendingCohabit = null;
  const a = state.runtimes[pc.aId];
  const b = state.runtimes[pc.bId];
  if (!a || !b) return;
  if (accept) {
    // 防止待決視窗開著時，其中一人先和第三人同居；絕不能覆寫既有 cohabits 映射。
    if (!canStartCohabit(pc.aId, pc.bId)) {
      const rel = getRel(pc.aId, pc.bId);
      if (rel) rel.cohabitOffered = false;
      notify(`${pc.aName} 或 ${pc.bName} 已有同居對象，這次同居申請已取消。`);
      save();
      return;
    }
    const aRoom = Object.entries(state.occupancy).find(([, tid]) => tid === pc.aId)?.[0];
    if (!aRoom) return; // 異常(a 沒有自己的房)→ 不處理
    // b 讓出自己的房(空出可再招租),搬進 a 的房;runtime/關係全部保留
    const bRoomEntry = Object.entries(state.occupancy).find(([, tid]) => tid === pc.bId);
    if (bRoomEntry) delete state.occupancy[bRoomEntry[0]];
    state.cohabits[pc.bId] = aRoom;
    b.roomNo = aRoom.replace(/^r/, "");
    // 兩人同居加成 + 記憶
    for (const rt of [a, b]) {
      rt.satisfaction = clamp(rt.satisfaction + 15, 0, 100);
      rt.tenant.stats.mood = clamp(rt.tenant.stats.mood + 15, 0, 100);
      rt.unhappyHours = 0;
    }
    pushMemory(a.tenant, `[與${pc.bName}同居]`, `${pc.bName} 搬進來一起住,兩人開始同居生活。`, "landlord_decision");
    pushMemory(b.tenant, `[與${pc.aName}同居]`, `搬進 ${pc.aName} 的房間,兩人開始同居生活。`, "landlord_decision");
    pushSocialLog(a, `❤️ ${pc.bName} 搬進來一起住了`, "major");
    pushSocialLog(b, `❤️ 搬進 ${pc.aName} 的房間,開始同居生活`, "major");
    refreshAppearances();
    applyHour(b, new Date(state.gameMs).getHours(), false); // 立即重新定位到新房間
    notify(`${pc.bName} 搬去和 ${pc.aName} 同居了 ❤️(${pc.bName} 原本的房間空出來了)`);
  } else {
    // 不同意 → 兩人失望,關係回落
    const rel = getRel(pc.aId, pc.bId);
    if (rel) rel.value = clamp(rel.value - 15, 0, 100);
    applySocialEffect(a, { satisfaction: -8, mood: -6 });
    applySocialEffect(b, { satisfaction: -8, mood: -6 });
    notify(`你婉拒了 ${pc.aName} 和 ${pc.bName} 的同居請求。`);
  }
  save();
}

// ---------------------------------------------------------------------------
// 調租談判(設計檢討 7-1:投資遊戲性的核心 trade-off)
// ---------------------------------------------------------------------------

export const RENT_COOLDOWN_DAYS = 5; // 同一位租客談過(不論成敗)後的冷卻遊戲日
const RENT_MAX_STEP = 0.3; // 單次談判最多 ±30%

/** 租客對漲租的容忍度(比例):滿意度與好感越高越能接受;狀態差時任何漲租都翻臉 */
function raiseTolerance(rt: TenantRuntime): number {
  return clamp((rt.satisfaction * 0.5 + rt.tenant.stats.affinity * 0.5 - 35) / 200, 0, 0.25);
}

export interface RentPreview {
  /** 夾在 ±30% 內的實際提案金額 */
  next: number;
  /** 相對現租的漲跌幅(-0.3 ~ 0.3) */
  pct: number;
  /** 預估反應:cut=降租必開心 / safe=應會接受 / risky=勉強接受但傷感情 / reject=會拒絕並翻臉 */
  verdict: "cut" | "safe" | "risky" | "reject";
  /** 冷卻剩餘遊戲日(0 = 可以談) */
  cooldownLeft: number;
}

/** 預覽調租反應(不成交);非承租人(同居者)回傳 null */
export function previewRent(tenantId: string, newRent: number): RentPreview | null {
  const rt = state.runtimes[tenantId];
  if (!rt || !Object.values(state.occupancy).includes(tenantId)) return null;
  const cur = rt.tenant.finance.monthlyRent;
  const next = Math.round(clamp(newRent, cur * (1 - RENT_MAX_STEP), cur * (1 + RENT_MAX_STEP)));
  const pct = (next - cur) / cur;
  // 房間做過升級改建 → 漲租更站得住腳(容忍度加成,合計上限 0.35)
  const roomId = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId)?.[0] ?? "";
  const tol = Math.min(0.35, raiseTolerance(rt) + upgradeTolBonus(roomId));
  const verdict = pct <= 0 ? "cut" : pct <= tol * 0.75 ? "safe" : pct <= tol ? "risky" : "reject";
  const cooldownLeft = Math.max(0, RENT_COOLDOWN_DAYS - (gameDayIndex() - rt.rentChangeDay));
  return { next, pct, verdict, cooldownLeft };
}

/** 對承租人提出新月租。降租必成;漲租依容忍度接受(傷感情)或拒絕(房租不變+惹惱)。 */
export function proposeRent(tenantId: string, newRent: number): { ok: boolean; accepted: boolean; text: string } {
  const rt = state.runtimes[tenantId];
  const pv = previewRent(tenantId, newRent);
  if (!rt || !pv) return { ok: false, accepted: false, text: "只有承租人才能談房租" };
  if (pv.cooldownLeft > 0) return { ok: false, accepted: false, text: `才剛談過房租,${pv.cooldownLeft} 天後再開口吧` };
  const f = rt.tenant.finance;
  const cur = f.monthlyRent;
  if (pv.next === cur) return { ok: false, accepted: false, text: "金額沒有變,不用談" };
  rt.rentChangeDay = gameDayIndex(); // 不論成敗都進冷卻(才談完不能馬上再凹)
  const s = rt.tenant.stats;
  const name = rt.tenant.name;
  let accepted: boolean;
  let text: string;

  if (pv.pct < 0) {
    // 降租:必接受,好感/滿意度上升(幅度與降幅成正比)
    f.monthlyRent = pv.next;
    s.affinity = clamp(s.affinity + Math.min(12, Math.round(-pv.pct * 50)), 0, 100);
    rt.satisfaction = clamp(rt.satisfaction + Math.min(10, Math.round(-pv.pct * 40)), 0, 100);
    rt.unhappyHours = Math.max(0, rt.unhappyHours - 12);
    if (pv.pct <= -0.1) pushMemory(rt.tenant, "[房東主動降租]", `房東把月租降到 $${pv.next},心存感激,想住久一點。`, "landlord_decision");
    accepted = true;
    text = `${name} 又驚又喜地答應了,月租降為 $${pv.next.toLocaleString()}`;
    pushSocialLog(rt, `💲 房東主動把月租降到 $${pv.next.toLocaleString()},太感動了!`, "major");
  } else if (pv.verdict !== "reject") {
    // 漲租且在容忍範圍:勉強接受,好感/滿意度下降
    f.monthlyRent = pv.next;
    s.affinity = clamp(s.affinity - Math.round(pv.pct * 60), 0, 100);
    rt.satisfaction = clamp(rt.satisfaction - Math.round(pv.pct * 80), 0, 100);
    accepted = true;
    text = `${name} 皺著眉答應了,月租調為 $${pv.next.toLocaleString()}(好感/滿意度下降)`;
    pushSocialLog(rt, `💲 房東把月租漲到 $${pv.next.toLocaleString()},雖然答應了,心裡不太舒服。`, "notable");
  } else {
    // 漲太多:拒絕,房租不變,關係惡化 + 不滿累積 + 留記憶給 AI 發揮
    s.affinity = clamp(s.affinity - (6 + Math.round(pv.pct * 40)), 0, 100);
    rt.satisfaction = clamp(rt.satisfaction - (8 + Math.round(pv.pct * 50)), 0, 100);
    rt.unhappyHours += 10;
    pushMemory(rt.tenant, "[對漲租不滿]", `房東想把月租漲到 $${pv.next},被拒絕了;開始考慮這裡值不值得住。`, "landlord_decision");
    accepted = false;
    text = `${name} 一口回絕:「這價錢我就搬走!」(關係惡化,房租維持 $${cur.toLocaleString()})`;
    pushSocialLog(rt, `💢 房東開口要漲租到 $${pv.next.toLocaleString()},當場回絕了。這裡還值得住嗎…`, "major");
  }
  save();
  return { ok: true, accepted, text };
}

function applyEffect(rt: TenantRuntime, eff: EventEffect) {
  if (eff.money) addMoney(eff.money, `事件:${rt.tenant.name}`, "event");
  const s = rt.tenant.stats;
  if (eff.mood) s.mood = clamp(s.mood + eff.mood, 0, 100);
  if (eff.stress) s.stress = clamp(s.stress + eff.stress, 0, 100);
  if (eff.wellbeing) s.wellbeing = clamp(s.wellbeing + eff.wellbeing, 0, 100);
  if (eff.energy) s.energy = clamp(s.energy + eff.energy, 0, 100);
  if (eff.affinity) s.affinity = clamp(s.affinity + eff.affinity, 0, 100);
  if (eff.satisfaction) rt.satisfaction = clamp(rt.satisfaction + eff.satisfaction, 0, 100);
  if (eff.satisfaction && eff.satisfaction > 0) rt.unhappyHours = 0; // 有改善就重置退租倒數
  if (eff.memory) pushMemory(rt.tenant, eff.memory.label, eff.memory.hint, "landlord_decision");
  if (eff.flag) addFlag(rt, eff.flag); // 事件連鎖:留伏筆旗標,之後每天餵回 AI
  if (eff.rentAction) applyRentAction(rt, eff.rentAction); // 繳租求情:寬限/催繳/一筆勾銷(economy)
  // 行為指令(已在 events 消毒過白名單):接下來 N 遊戲日的行為看得見地改變
  if (eff.directive) {
    const def = DIRECTIVES[eff.directive.id];
    rt.directive = { id: eff.directive.id, untilDay: gameDayIndex() + eff.directive.days };
    pushSocialLog(rt, def.startText, "major");
    if (eff.directive.id === "adopt_cat") adoptCat(rt.tenant.id); // 貓不只是指令:留下來成為永久寵物
    applyHour(rt, new Date(state.gameMs).getHours(), false); // 立即依新行為重新定位
  }
}

/** 套用 AI 跨租客事件對「第二位鄰居」與兩人關係的影響(夾值 + 取向把關) */
function applyCrossTenant(aId: string, bId: string, eff: EventEffect) {
  const b = state.runtimes[bId];
  if (!b) return;
  if (eff.other) {
    const bs = b.tenant.stats;
    if (eff.other.mood) bs.mood = clamp(bs.mood + eff.other.mood, 0, 100);
    if (eff.other.stress) bs.stress = clamp(bs.stress + eff.other.stress, 0, 100);
    if (eff.other.affinity) bs.affinity = clamp(bs.affinity + eff.other.affinity, 0, 100);
    if (eff.other.satisfaction) b.satisfaction = clamp(b.satisfaction + eff.other.satisfaction, 0, 100);
  }
  if (eff.rel) {
    if (typeof eff.rel.delta === "number" && eff.rel.delta) adjustRelationship(aId, bId, eff.rel.delta);
    const a = state.runtimes[aId];
    if (eff.rel.breakup) setCouple(aId, bId, false);
    else if (eff.rel.couple && a && canRomance(a.tenant, b.tenant)) {
      const becameCouple = setCouple(aId, bId, true, a.tenant, b.tenant);
      if (!becameCouple) {
        pushSocialLog(a, `💭 和 ${b.tenant.name} 彼此有好感,但其中一人已有伴侶,關係停在曖昧。`, "notable");
        pushSocialLog(b, `💭 和 ${a.tenant.name} 彼此有好感,但其中一人已有伴侶,關係停在曖昧。`, "notable");
      }
    }
  }
}

/** 玩家做出房東抉擇 → 套用該選項的後果 */
export function decide(tenantId: string, choiceId: string, choiceLabel: string) {
  const rt = state.runtimes[tenantId];
  if (!rt?.pendingEvent) return;
  const title = rt.pendingEvent.title;
  const withId = rt.pendingEvent.withId;
  const eventId = rt.pendingEvent.id;
  const choice = rt.pendingEvent.choices.find((c) => c.id === choiceId);
  rt.decisions.push(choiceId);
  rt.pendingEvent = null;
  rt.log.push({
    gameMs: state.gameMs,
    timeLabel: fmt(state.gameMs),
    text: "",
    visualState: rt.tenant.visualState,
    importance: "major",
    decisionNote: `【${title}】你的決定:${choiceLabel}`,
  });
  if (choice) {
    applyEffect(rt, choice.effect);
    if (withId) applyCrossTenant(tenantId, withId, choice.effect);
    if (choice.effect.evict) moveOut(tenantId, "你請他搬走了");
    // 打架事件(§10-2):房東出面調解成功 → 冷戰直接解除
    if (eventId === "fight_decision" && choiceId === "mediate" && withId) endFeud(tenantId, withId, "mediated");
    // AI 提議互動(§10-3):玩家拍板 → 白名單+門檻把關後在畫面上演出來;不放行就靜默略過
    if (withId && choice.effect.interaction) forceInteraction(tenantId, withId, choice.effect.interaction);
  }
  save();
}
