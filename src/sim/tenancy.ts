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
import { adoptCat, adoptPet, petIcon, resolvePetFarewell } from "./pets";
import { recordAlumnus, unlock } from "./legacy";
import { ensureWishes, WISH_DEFS, type WishId, type WishDef } from "./wishes";
import { addReputation, REP_GRADUATE, REP_SETTLE_GRADUATE } from "./reputation";
import { addPlacement, findFreeSlot } from "./placements";
import { getDef } from "../furniture/catalog";
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
  cohabitingPartnerId,
  ROOM_APPEARANCE,
  type TenantRuntime,
} from "./gameState";
import { applyHour } from "./tick";
import { addMoney, applyRentAction, inHardship, DEPOSIT_MONTHS } from "./economy";
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
  if (ap.pet) adoptPet(ap.id, ap.pet); // 舊池缺 kind 會在 adoptPet 視為貓
  ensureWishes(); // 依職業指派人生心願(入住當下就看得到,不用等換日)
  const deposit = ap.monthlyRent * DEPOSIT_MONTHS; // 入住押金:招租一次性收入
  if (deposit > 0) addMoney(deposit, `${ap.name} 入住押金`, "other");
  save();
}

/**
 * 圓夢離開離場儀式(只走 wishPass 排定的離開;房東請離/分手搬走不適用):
 * 謝禮紅包(0.5×月租×(1+好感/100),上限 1×月租)+ 退還入住押金(以離開時月租計)
 * + 口碑 + 紀念物 + 送別會,最後執行通用 moveOut。
 *
 * 兩軌共用一套儀式,情境不同:
 *   - 畢業型(def.graduates):圓夢後很快搬離,口碑 +REP_GRADUATE,計入畢業成就(首位畢業生/名人堂)。
 *   - 安居型(模範房客安居期滿):圓滿搬離,口碑 +REP_SETTLE_GRADUATE;不計畢業成就
 *     (安居圓滿不是「畢業」;仍透過 recordAlumnus 觸發送走 N 位房客的通用成就)。
 */
export function graduateFarewell(tenantId: string, reason: string) {
  const rt = state.runtimes[tenantId];
  if (!rt) return;
  const w = rt.wish;
  const def = w ? (WISH_DEFS[w.id] as WishDef | undefined) : undefined;
  const isSettle = rt.modelTenant === true && !!def && !def.graduates; // 安居型圓滿搬離
  farewellSendoff(rt); // 送別會/獨白:離開者仍在名單時演出(結算之前)
  placeMemorial(rt); // 紀念物留在原房間(occupancy 尚未清除,綁房間不綁租客)
  const name = rt.tenant.name;
  const rent = rt.tenant.finance.monthlyRent;
  const gift = Math.min(rent, Math.round(0.5 * rent * (1 + rt.tenant.stats.affinity / 100)));
  const deposit = rent * DEPOSIT_MONTHS;
  if (gift > 0) {
    addMoney(gift, `${name} ${isSettle ? "圓滿謝禮紅包" : "圓夢謝禮紅包"}`, "other");
    const giftLine = isSettle
      ? `🧧 臨走前塞給你一個紅包($${gift.toLocaleString()}):「謝謝你,這裡是我住成家的地方。」`
      : `🧧 臨走前塞給你一個紅包($${gift.toLocaleString()}):「謝謝你,這裡是我圓夢的地方。」`;
    pushSocialLog(rt, giftLine, "major");
  }
  if (deposit > 0) {
    addMoney(-deposit, `退還 ${name} 押金`, "other");
    pushSocialLog(rt, `💵 你把 $${deposit.toLocaleString()} 押金如數退還,兩人握了握手,好聚好散。`, "major");
  }
  notify(`🧧 ${name} ${isSettle ? "安居圓滿搬離" : "圓夢離開"}:留下 $${gift.toLocaleString()} 謝禮紅包,押金 $${deposit.toLocaleString()} 已退還`);
  if (isSettle) {
    addReputation(REP_SETTLE_GRADUATE, `${name} 在這裡安居圓滿,展開人生下一步`);
  } else {
    addReputation(REP_GRADUATE, `${name} 在這裡圓夢畢業`);
    state.graduateCount += 1;
    unlock("first_graduate");
    if (state.graduateCount >= 3) unlock("graduate_3");
    if (state.graduateCount >= 5) unlock("hall_of_fame"); // 🏛️ 名人堂:五位畢業生
  }
  // 正向離開(圓夢/安居圓滿)且有同居伴侶 → 伴侶追隨一起走(浪漫的追隨,不是被連坐):
  // 兩人都離開、都進名冊、都有告別信;伴侶用 follow_partner 語氣。金錢(謝禮紅包/退押金)只按
  // 主離開者算一次(上方已發),伴侶本就不另收租/押金,故不重複發。送別會只辦一場(上方 farewellSendoff)。
  // 移除時把「這趟是伴侶一起走」透過 followPartnerId 告知 moveOut:略過「同居者轉正接手」與互相的
  // 「被留下的失落」記憶(此分支只在正向離開走;被趕走/主動退租/分手仍走現行轉正接手,不受影響)。
  const followId = cohabitingPartnerId(tenantId);
  if (followId && state.runtimes[followId]) {
    const followReason = `跟隨伴侶${name}離開,兩個人一起去展開新生活`;
    moveOut(followId, followReason, { followPartnerId: tenantId });
    moveOut(tenantId, reason, { followPartnerId: followId });
  } else {
    moveOut(tenantId, reason);
  }
}

// ---------------------------------------------------------------------------
// 圓夢畢業第二批:送別會(ambient 演出)+ 紀念物家具
// ---------------------------------------------------------------------------

/** 決定性選句(不消耗 Math.random,避免擾動其他系統的 RNG 次序與平衡快照)。 */
function sendoffIndex(salt: string): number {
  const day = Math.floor(state.gameMs / (24 * 3600 * 1000));
  const key = `sendoff|${day}|${salt}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

const SENDOFF_PARTY_LINES = [
  "🎉 交誼廳臨時辦起了歡送會,鄰居們七手八腳掛上彩帶,舉杯慶祝 {name} 的「{label}」成真,笑著笑著就有人紅了眼眶。",
  "🎉 全樓聚到交誼廳為 {name} 餞行,有人翻出舊照片,有人塞來親手做的點心,「{label}」這句話今晚被反覆說起。",
  "🎉 {name} 要啟程了,大家在交誼廳擺上飲料熱菜辦了場歡送會,說好無論走多遠,這裡永遠是「{label}」開始的地方。",
];

const SENDOFF_SOLO_LINES = [
  "🕯️ 沒有誰能替 {name} 熱鬧一場,他一個人把行李收拾妥當,對著空蕩蕩的樓道輕聲說了句「謝謝這裡」,帶著「{label}」的圓滿離開。",
  "🕯️ 樓裡只剩 {name} 一人,他在門口回頭望了很久,把「{label}」的這段日子仔細收進心底,才輕輕帶上了門。",
];

const fillSendoff = (line: string, name: string, label: string) =>
  line.replace(/\{name\}/g, name).replace(/\{label\}/g, label);

/** 同棟在住者中與離開者關係最好的一位(送別日誌的落點,確保搬走後仍留在全樓 Feed);
 *  沒有關係紀錄時退回任一在住的其他人。 */
function bestStayingNeighbor(leaverId: string): TenantRuntime | null {
  let best: TenantRuntime | null = null;
  let bestVal = -1;
  for (const rel of listRelationships()) {
    if (rel.aId !== leaverId && rel.bId !== leaverId) continue;
    const otherId = rel.aId === leaverId ? rel.bId : rel.aId;
    const other = state.runtimes[otherId];
    if (!other || otherId === leaverId) continue;
    if (rel.value > bestVal) { bestVal = rel.value; best = other; }
  }
  return best ?? Object.values(state.runtimes).find((r) => r.tenant.id !== leaverId) ?? null;
}

/** 圓夢離開當天的送別會(ambient,非抉擇):graduateFarewell 結算前呼叫,離開者仍在名單。
 *  全樓在住 ≥2 人 → 交誼廳歡送會(全員 mood+4/壓力-4、兩兩關係+2,🎉 送別日誌進全樓 Feed);
 *  <2 人 → 改發離開者的獨白 major 日誌。文案 2~3 種、依日期與姓名決定性挑選。 */
export function farewellSendoff(rt: TenantRuntime) {
  const w = rt.wish;
  const def = w ? (WISH_DEFS[w.id] as WishDef | undefined) : undefined;
  const label = def?.label ?? "心願";
  const name = rt.tenant.name;
  const residents = Object.values(state.runtimes);
  const idx = sendoffIndex(name);
  if (residents.length < 2) {
    pushSocialLog(rt, fillSendoff(SENDOFF_SOLO_LINES[idx % SENDOFF_SOLO_LINES.length], name, label), "major");
    notify(`🕯️ ${name} 圓夢啟程,獨自向這棟樓道別`);
    return;
  }
  for (const r of residents) {
    r.tenant.stats.mood = clamp(r.tenant.stats.mood + 4, 0, 100);
    r.tenant.stats.stress = clamp(r.tenant.stats.stress - 4, 0, 100);
  }
  const ids = residents.map((r) => r.tenant.id);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) adjustRelationship(ids[i], ids[j], 2);
  // 送別日誌掛在最好的鄰居身上,離開者搬走後這筆仍留在全樓 Feed
  const host = bestStayingNeighbor(rt.tenant.id) ?? rt;
  pushSocialLog(host, fillSendoff(SENDOFF_PARTY_LINES[idx % SENDOFF_PARTY_LINES.length], name, label), "major");
  notify(`🎉 全樓在交誼廳為 ${name} 辦了一場歡送會`);
}

/** 心願軌別 → 專屬紀念物家具 id。畢業型 4 款各異;安居型 4 條共用一款「全家福相框」
 *  (安居圓滿搬離時同樣在原房間留下紀念物)。 */
const MEMORIAL_DEF: Partial<Record<WishId, string>> = {
  stage_dream: "memorial_poster", // 🎭 登台 → 簽名海報
  open_shop: "memorial_sign", // 🏪 開店 → 小招牌
  graduate_thesis: "memorial_cert", // 🎓 論文 → 裱框證書
  finish_masterwork: "memorial_book", // 📖 代表作 → 簽名書
  career_step: "memorial_frame", // 💼 站穩工作 ┐
  recover_rhythm: "memorial_frame", // 🌿 養回健康 ┤ 安居型圓滿搬離 → 🏠 全家福相框
  feel_at_home: "memorial_frame", // 🏡 住成家 ┤
  settle_life: "memorial_frame", // 🌤️ 過成喜歡的樣子 ┘
};

/** 在畢業生的原房間留一件紀念物(綁房間不綁租客);occupancy 尚未清除時呼叫。
 *  房間已滿(找不到空位)→ 靜默略過並記一筆通知,不阻斷離開流程。 */
function placeMemorial(rt: TenantRuntime) {
  const defId = rt.wish ? MEMORIAL_DEF[rt.wish.id] : undefined;
  if (!defId) return;
  const roomId = `r${rt.roomNo}`;
  if (!ROOM_APPEARANCE[roomId]) return; // 只在套房留紀念物(同居/異常房略過)
  const slot = findFreeSlot(roomId, 1, 1);
  if (!slot) {
    notify(`🎁 ${rt.tenant.name} 想留件紀念物,但 ${rt.roomNo} 房已經擺滿了`);
    return;
  }
  addPlacement({ defId, room: roomId, c: slot.c, r: slot.r, memorial: true });
  const nm = getDef(defId).name;
  pushSocialLog(rt, `🎁 臨走前,他把一件「${nm}」留在了 ${rt.roomNo} 房:「就當我還在這裡吧。」`, "major");
  notify(`🎁 ${rt.tenant.name} 在 ${rt.roomNo} 房留下了紀念物「${nm}」`);
}

/** 租客退租搬走:清空房間佔用、移除 runtime、清掉別人身上關於他的記憶。
 *  opts.followPartnerId:同居伴侶正向離開時「一起走」的另一位——對這位略過「轉正接手」與
 *  互相的「被留下的失落」記憶(兩人是一起離開,不是被留下)。 */
export function moveOut(tenantId: string, reason: string, opts?: { followPartnerId?: string }) {
  const rt = state.runtimes[tenantId];
  if (!rt) return;
  const name = rt.tenant.name;
  const followPartnerId = opts?.followPartnerId;
  // 捕捉離開者當前的同居伴侶(在 occupancy/cohabits 被下面變動之前):用來把「未同居情侶」
  // 的留下方(任務 B,中等難過)和「同居轉正接手」的那位(維持現行、不套 B)區分開。
  const cohabitMateId = cohabitingPartnerId(tenantId);
  // 帶著欠款離開:這筆收不回來了,至少讓房東知道(名冊原因不變)
  if ((rt.arrears ?? 0) > 0) notify(`💸 ${name} 帶著 $${rt.arrears} 的未繳欠租搬走了`);
  recordAlumnus(rt, reason); // 進歷任房客名冊(趁 runtime 還在;§G-8;會順帶記下貓一起走)
  // 通用路徑(含請離/分手):自己養的貓一律跟著走,根治「飼主走了貓還在」的殘留。
  // 已托付成樓貓的(ownerId="landlord")不在此列,牠留下來歸公寓照顧。
  const ownPet = state.pets[tenantId];
  if (ownPet && ownPet.ownerId === tenantId) {
    delete state.pets[tenantId];
    notify(`${petIcon(ownPet)} 「${ownPet.name}」也跟著 ${name} 一起搬走了`);
  }
  // 在清除關係前,先記下誰跟他親近(留一筆「搬走了」的記憶給留下的人)
  const bonds = listRelationships().filter((r) => r.aId === tenantId || r.bId === tenantId);
  const entry = Object.entries(state.occupancy).find(([, tid]) => tid === tenantId);
  if (entry) {
    delete state.occupancy[entry[0]];
    // 若有同居者住在這間房 → 伴侶接手承租(轉正,開始付租)。
    // 例外:followPartnerId(正向離開時一起走的伴侶)不接手——房間直接空出來,兩人一起離開。
    const mateId = Object.keys(state.cohabits).find((id) => state.cohabits[id] === entry[0]);
    if (mateId && state.runtimes[mateId] && mateId !== tenantId && mateId !== followPartnerId) {
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
    if (bond?.romantic && other.tenant.id !== cohabitMateId && other.tenant.id !== followPartnerId) {
      // 任務 B:未同居情侶的留下方——中等難過(當下打擊 + 低落幾天 + 思念記憶,隨時間恢復)。
      // 不打 satisfaction 永久值;mood/stress 夾值;思念記憶與 sulk 都被既有系統慢慢接住還原。
      const s = t.stats;
      s.mood = clamp(s.mood - 13, 0, 100);
      s.stress = clamp(s.stress + 12, 0, 100);
      // 低落 directive:2 遊戲日的 sulk;既有 directive 未過期時不覆蓋(尊重原本的行為狀態)。
      if (!other.directive || other.directive.untilDay < gameDayIndex()) {
        other.directive = { id: "sulk", untilDay: gameDayIndex() + 2 };
        applyHour(other, new Date(state.gameMs).getHours(), false); // 立即依 sulk 重新定位
      }
      pushMemory(t, `[思念${name}]`, `情人 ${name} 搬走了,一個人的時候總會想念,心裡難過又空落落的。`, "ai_event");
      pushSocialLog(other, `💔 ${name} 搬走了,望著空下來的位子,思念一下子湧了上來。`, "major");
    } else if (bond && (bond.romantic || bond.value >= 50)) {
      // 同居轉正接手方、或一般好朋友(value≥50 非情侶):維持現行的普通失落記憶,不升級。
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
  if (eff.rentAction) {
    // 繳租求情:寬限/催繳/一筆勾銷(economy);房東的處置風格順手記成就
    if (eff.rentAction === "grace") unlock("grace_giver");
    else if (eff.rentAction === "forgive") unlock("debt_forgiver");
    else if (inHardship(rt)) unlock("hard_collector");
    applyRentAction(rt, eff.rentAction);
  }
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
    // 圓夢畢業的貓去留(wishes.maybeAttachCatFarewell):留下 → 轉樓貓;帶走 → 離開日隨主人走
    if (eventId === "wish_cat_farewell" || eventId === "wish_pet_farewell") resolvePetFarewell(rt, choiceId);
    // AI 提議互動(§10-3):玩家拍板 → 白名單+門檻把關後在畫面上演出來;不放行就靜默略過
    if (withId && choice.effect.interaction) forceInteraction(tenantId, withId, choice.effect.interaction);
  }
  save();
}
