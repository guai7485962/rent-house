/**
 * 戲劇事件(設計檢討 §10-2 戲劇批):讓「觀察」有八卦可看。
 * - 劈腿抓包:有伴者與第三人曖昧值過高 → 修羅場——分手 + 冷戰 + 全樓八卦。
 * - 偷吃冰箱:交情普通的兩人,一方(吃貨/夜貓/電競)半夜偷吃對方放在共用冰箱的食物被抓。
 * - 被撞見(maybeWitness 由 interactions 在 🔞 互動觸發後呼叫):第三位租客撞見,三方尷尬。
 * 全部走既有安全機制:夾值、記憶標籤接 AI、冷戰接 conflicts、冷卻用 interactionCooldowns。
 */
import { relationships, getRel, pairKey, canRomance, isBestFriend, tierLabel, setCouple, adjustRelationship } from "./social";
import { state, clamp, notify, pushMemory, pushSocialLog, type TenantRuntime } from "./gameState";
import { startFeud } from "./conflicts";
import { endCohabitOnBreakup } from "./tenancy";
import { unlock } from "./legacy";
import { spawnFx } from "../floor/fx";
import { MS_PER_GAME_HOUR } from "./clock";

/** 每小時:有伴者曖昧過界被抓包的機率(條件成立時) */
const AFFAIR_CHANCE = 0.04;
/** 每小時:一組合格配對發生偷吃冰箱的機率 */
const FRIDGE_CHANCE = 0.01;
/** 🔞 互動被第三人撞見的機率 */
const WITNESS_CHANCE = 0.15;

const rtOf = (id: string) => state.runtimes[id];

/** 劈腿條件:cheater 有伴,卻和第三人(非伴侶)曖昧值 ≥75 且互有好感 */
function affairThird(cheaterId: string, partnerId: string): TenantRuntime | null {
  const cheater = rtOf(cheaterId);
  if (!cheater) return null;
  for (const rt of Object.values(state.runtimes)) {
    const cId = rt.tenant.id;
    if (cId === cheaterId || cId === partnerId) continue;
    const rel = getRel(cheaterId, cId);
    if (rel && !rel.romantic && rel.value >= 75 && canRomance(cheater.tenant, rt.tenant)) return rt;
  }
  return null;
}

/** 修羅場:分手 + 心碎/怒氣演出 + 三方記憶 + 全樓八卦 + 分手冷戰 + 同居拆夥 */
function scandal(cheater: TenantRuntime, partner: TenantRuntime, third: TenantRuntime) {
  const cId = cheater.tenant.id;
  const pId = partner.tenant.id;
  const partnerThirdRel = getRel(pId, third.tenant.id);
  const bestFriendBetrayal = isBestFriend(partnerThirdRel, partner.tenant, third.tenant);
  const formerBond = bestFriendBetrayal && partnerThirdRel
    ? tierLabel(partnerThirdRel, partner.tenant, third.tenant)
    : null;
  setCouple(cId, pId, false);
  adjustRelationship(cId, pId, -35);
  adjustRelationship(cId, third.tenant.id, -20); // 曖昧對象也尷尬退避
  if (bestFriendBetrayal) adjustRelationship(pId, third.tenant.id, -70); // 伴侶與摯友的雙重背叛

  const ps = partner.tenant.stats;
  ps.mood = clamp(ps.mood - 20, 0, 100);
  ps.stress = clamp(ps.stress + 15, 0, 100);
  const cs = cheater.tenant.stats;
  cs.mood = clamp(cs.mood - 10, 0, 100);
  cs.stress = clamp(cs.stress + 12, 0, 100);
  const ts = third.tenant.stats;
  ts.stress = clamp(ts.stress + 8, 0, 100);

  pushMemory(partner.tenant, "[被劈腿]", `發現${cheater.tenant.name}和${third.tenant.name}走得太近,當場鬧翻分手。`, "ai_event");
  pushMemory(cheater.tenant, "[劈腿被抓包]", `和${third.tenant.name}的曖昧被${partner.tenant.name}抓包,場面難看。`, "ai_event");
  if (bestFriendBetrayal) {
    pushMemory(partner.tenant, "[摯友背叛]", `自己的${formerBond}${third.tenant.name}竟和伴侶${cheater.tenant.name}曖昧,同時失去愛情與友情。`, "ai_event");
    pushMemory(third.tenant, "[背叛摯友]", `和${partner.tenant.name}的伴侶${cheater.tenant.name}越界,被曾經的${formerBond}當場發現。`, "ai_event");
  } else {
    pushMemory(third.tenant, "[捲入修羅場]", `捲入${cheater.tenant.name}的感情風暴,全樓都在看自己。`, "ai_event");
  }

  const betrayalNote = bestFriendBetrayal ? `,對象竟是自己的${formerBond}` : "";
  pushSocialLog(partner, `💔 發現 ${cheater.tenant.name} 和 ${third.tenant.name} 走得太近${betrayalNote},當場鬧翻,分手了!`, "major");
  pushSocialLog(cheater, `💥 和 ${third.tenant.name} 的曖昧被 ${partner.tenant.name} 抓包,修羅場…分手了。`, "major");
  pushSocialLog(third, bestFriendBetrayal
    ? `🗡️ 和 ${cheater.tenant.name} 的曖昧被${formerBond} ${partner.tenant.name} 發現,友情徹底決裂。`
    : `🫣 被捲入 ${cheater.tenant.name} 和 ${partner.tenant.name} 的修羅場,超級尷尬。`, "major");

  // 全樓八卦:其他住戶都在傳
  for (const rt of Object.values(state.runtimes)) {
    const id = rt.tenant.id;
    if (id === cId || id === pId || id === third.tenant.id) continue;
    pushSocialLog(rt, `🍵 全樓都在傳 ${cheater.tenant.name} 劈腿被 ${partner.tenant.name} 抓包的事…`, "notable");
  }

  // 演出:心碎(伴侶處)+ 怒氣(現場)
  const at = partner.targetTile ?? cheater.targetTile;
  if (at) {
    spawnFx("heartbreak", at.c, at.r, 15000);
    spawnFx("anger", at.c + 1, at.r, 12000);
  }

  startFeud(partner, cheater, true); // 分手後冷戰(修羅場日誌已經夠大聲)
  if (bestFriendBetrayal) startFeud(partner, third, true);
  endCohabitOnBreakup(cId, pId);
  notify(`💔 修羅場!${cheater.tenant.name} 劈腿被 ${partner.tenant.name} 抓包,兩人分手了`);
  unlock("scandal"); // 成就:修羅場(§G-7)
}

/** 劈腿抓包 pass:掃所有情侶,任一方與第三人曖昧過界 → 低機率當場抓包 */
export function affairPass(rng: () => number = Math.random): boolean {
  for (const [key, rel] of Object.entries(relationships)) {
    if (!rel.romantic) continue;
    const [aId, bId] = key.split("|");
    for (const [cheaterId, partnerId] of [[aId, bId], [bId, aId]] as const) {
      const cheater = rtOf(cheaterId);
      const partner = rtOf(partnerId);
      if (!cheater || !partner || cheater.pendingEvent || partner.pendingEvent) continue;
      if (partner.tenant.visualState === "away") continue; // 要被抓,伴侶得在場
      const third = affairThird(cheaterId, partnerId);
      if (!third) continue;
      if (rng() > AFFAIR_CHANCE) continue;
      scandal(cheater, partner, third);
      return true; // 一小時最多一場修羅場
    }
  }
  return false;
}

/** 偷吃冰箱被抓:交情普通的兩人,吃貨/夜貓/電競的一方偷吃對方食物被抓,結下樑子 */
export function fridgePass(rng: () => number = Math.random): boolean {
  const present = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent);
  for (const thief of present) {
    const tags = thief.tenant.coreTags.map((t) => t.id);
    if (!tags.some((t) => ["foodie", "night_owl", "gamer", "late_return"].includes(t))) continue;
    for (const victim of present) {
      if (victim === thief) continue;
      const rel = getRel(thief.tenant.id, victim.tenant.id);
      if (rel?.romantic || (rel?.value ?? 0) >= 50) continue; // 有交情的會先問過,不算偷
      const cdk = `${pairKey(thief.tenant.id, victim.tenant.id)}|fridge_theft`;
      const last = state.interactionCooldowns[cdk];
      if (last != null && state.gameMs - last < 72 * MS_PER_GAME_HOUR) continue;
      if (rng() > FRIDGE_CHANCE) continue;

      adjustRelationship(thief.tenant.id, victim.tenant.id, -8);
      const vs = victim.tenant.stats;
      vs.stress = clamp(vs.stress + 5, 0, 100);
      vs.mood = clamp(vs.mood - 5, 0, 100);
      pushSocialLog(victim, `💢 放在共用冰箱、寫了名字的布丁被 ${thief.tenant.name} 偷吃了,當場抓包!`, "major");
      pushSocialLog(thief, `😋 半夜偷吃了 ${victim.tenant.name} 冰箱裡的布丁,結果被抓個正著…`, "notable");
      pushMemory(victim.tenant, "[冰箱結仇]", `${thief.tenant.name}偷吃了自己冰箱的食物,看到對方就想起那顆布丁。`, "ai_event");
      const at = victim.targetTile ?? thief.targetTile;
      if (at) spawnFx("anger", at.c, at.r, 10000);
      state.interactionCooldowns[cdk] = state.gameMs;
      return true;
    }
  }
  return false;
}

/** 🔞 互動被撞見(interactions 在 privacy 互動觸發後呼叫):第三位租客撞見,三方尷尬 */
export function maybeWitness(A: TenantRuntime, B: TenantRuntime, rng: () => number = Math.random): boolean {
  const candidates = Object.values(state.runtimes).filter(
    (rt) => rt !== A && rt !== B && rt.tenant.visualState !== "away" && !rt.pendingEvent,
  );
  if (candidates.length === 0 || rng() > WITNESS_CHANCE) return false;
  const w = candidates[Math.floor(rng() * candidates.length) % candidates.length];
  const ws = w.tenant.stats;
  ws.stress = clamp(ws.stress + 6, 0, 100);
  pushMemory(w.tenant, "[撞見不該看的]", `不小心撞見${A.tenant.name}和${B.tenant.name}的私密時刻,現在見面都不知道眼睛往哪擺。`, "ai_event");
  pushSocialLog(w, `🙈 不小心撞見了 ${A.tenant.name} 和 ${B.tenant.name} 的私密時刻,尷尬到倒退三步…`, "major");
  for (const rt of [A, B]) {
    rt.tenant.stats.stress = clamp(rt.tenant.stats.stress + 3, 0, 100);
    pushSocialLog(rt, `😳 好像被 ${w.tenant.name} 撞見了,尷尬到想搬家。`, "notable");
  }
  return true;
}

/** 每小時戲劇 pass(tick 在互動/社交之後呼叫) */
export function dramaPass(rng: () => number = Math.random) {
  affairPass(rng);
  fridgePass(rng);
}
