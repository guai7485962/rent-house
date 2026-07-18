/**
 * 房東的心意互動(玩家目標批第 2 波,點子 3):
 * 送宵夜/塞紙條/介紹案子——玩家主動對單一租客表達善意,小成本換立即回饋;
 * 動作日誌進 Feed,也是隔日 AI 日記的素材(AI 會寫出租客對這份心意的反應)。
 * 規則:每位租客每遊戲日收一次心意;介紹案子僅在財務困難時可用(提早結束收入中斷)。
 * 全程零 RNG、僅玩家觸發 → 不影響 balance 快照與亂數次序。
 */
import { state, clamp, gameDayIndex, notify, pushMemory, pushSocialLog, type TenantRuntime } from "./gameState";
import { addMoney, inHardship, WALLET_CAP_MONTHS } from "./economy";
import { unlock } from "./legacy";
import { save } from "./persistence";

export interface KindnessDef {
  icon: string;
  label: string;
  cost: number;
  hint: string;
}

export const KINDNESS_ACTS = {
  snack: { icon: "🍜", label: "送宵夜", cost: 120, hint: "在他門口掛一袋熱宵夜(心情+、好感+)" },
  note: { icon: "📝", label: "塞紙條", cost: 0, hint: "手寫一張暖心紙條塞進門縫(壓力−、好感+)" },
  referral: { icon: "💼", label: "介紹案子", cost: 600, hint: "動用人脈介紹工作,拉他一把(結束財務困難)" },
} satisfies Record<string, KindnessDef>;

export type KindnessId = keyof typeof KINDNESS_ACTS;

/** 累計心意達標 → 成就「暖心房東」 */
export const CARE_ACHIEVEMENT_AT = 10;

/** 今天是否已對這位租客表達過心意(每人每遊戲日一次) */
export const caredToday = (rt: TenantRuntime) => (rt.lastCareDay ?? -99) === gameDayIndex();

/** 對租客表達一份心意(UI 按鈕觸發;失敗回 reason 供 toast) */
export function giveKindness(tenantId: string, id: KindnessId): { ok: boolean; reason?: string } {
  const rt = state.runtimes[tenantId];
  const def = KINDNESS_ACTS[id];
  if (!rt || !def) return { ok: false, reason: "找不到這位租客" };
  if (caredToday(rt)) return { ok: false, reason: "今天已經表達過心意了,明天再來吧" };
  if (id === "referral" && !inHardship(rt)) return { ok: false, reason: "他目前不缺工作,這份人情先留著吧" };
  if (state.money < def.cost) return { ok: false, reason: "金錢不足" };

  if (def.cost > 0) addMoney(-def.cost, `${def.label}:${rt.tenant.name}`, "other");
  rt.lastCareDay = gameDayIndex();
  const s = rt.tenant.stats;
  if (id === "snack") {
    s.mood = clamp(s.mood + 6, 0, 100);
    s.affinity = clamp(s.affinity + 4, 0, 100);
    pushSocialLog(rt, "🍜 門把上掛著一袋還溫的宵夜——是房東送的。他提著袋子愣了幾秒,嘴角忍不住上揚。", "notable");
  } else if (id === "note") {
    s.stress = clamp(s.stress - 5, 0, 100);
    s.affinity = clamp(s.affinity + 2, 0, 100);
    pushSocialLog(rt, "📝 門縫塞進一張房東的手寫紙條:「辛苦了,有困難隨時說。」他讀了兩遍,把紙條貼在桌邊。", "notable");
  } else {
    // 介紹案子:提早結束財務困難,案子頭款進錢包(夾錢包上限),拮据記憶直接翻頁
    rt.hardshipUntilDay = -99;
    const cap = rt.tenant.finance.monthlyRent * WALLET_CAP_MONTHS;
    rt.wallet = clamp((rt.wallet ?? 0) + Math.round(rt.tenant.finance.monthlyRent * 0.5), 0, cap);
    s.affinity = clamp(s.affinity + 8, 0, 100);
    s.stress = clamp(s.stress - 6, 0, 100);
    rt.tenant.memoryTags = rt.tenant.memoryTags.filter((m) => m.label !== "[手頭拮据]");
    pushMemory(rt.tenant, "[房東拉了一把]", "最難的時候房東介紹了案子,這份恩情記在心裡", "landlord_decision");
    pushSocialLog(rt, "💼 房東介紹的案子談成了!收入總算有著落,他朝著樓下深深鞠了個躬。", "major");
    notify(`💼 ${rt.tenant.name} 接下了你介紹的案子,收入恢復了`);
  }
  state.careGiven += 1;
  if (state.careGiven >= CARE_ACHIEVEMENT_AT) unlock("care_10");
  save();
  return { ok: true };
}
