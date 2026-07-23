/**
 * 房東口碑(圓夢畢業批):租客在這裡把心願住成真,好房東的名聲就傳出去。
 *
 * state.reputation(0~100,入存檔):畢業離開 +8、安居圓夢 +3,封頂 100。
 * 效果都在招租端(recruit.ts):
 *   - 契合星等 raw 加 reputation×0.3(滿口碑約半級~一級星等)
 *   - 應徵者願意開的月租 +(reputation×0.05)%(滿口碑 +5%)
 *
 * 獨立成檔而不併入 legacy.ts:legacy 檔頭明訂「只寫成就/名冊/通知,不動數值、
 * 不影響 balance 快照」,口碑會改招租出價與星等,放這裡才不破壞該契約;
 * 也讓 recruit 只需 import 本檔,不用連帶拉進 legacy → finance 的依賴。
 */
import { state, clamp, notify } from "./gameState";

/** 租客圓夢畢業離開的口碑增量 */
export const REP_GRADUATE = 8;
/** 安居型心願實現(成為模範房客)的口碑增量 */
export const REP_SETTLE = 3;
/** 模範房客安居期滿「圓滿搬離」的口碑增量。
 *  取 = REP_GRADUATE(8):圓滿收尾與畢業同樣是好房東的口碑印記;
 *  且安居軌一生累計(成為模範 +3 → 圓滿搬離 +8 = 11)刻意高於畢業軌(+8),
 *  獎勵這段更長、更忠誠的居住關係。 */
export const REP_SETTLE_GRADUATE = 8;

/** 口碑異動唯一入口:夾 0~100,實際有升才通知(標明來源) */
export function addReputation(amount: number, reason: string) {
  const before = state.reputation;
  state.reputation = clamp(Math.round(state.reputation + amount), 0, 100);
  const gained = state.reputation - before;
  if (gained > 0) notify(`⭐ 房東口碑 +${gained}(${reason};現為 ${state.reputation}/100)`);
}

/** 招租契合度 raw 的口碑加成(matchStars 用) */
export const reputationStarBonus = () => state.reputation * 0.3;

/** 應徵者開價的口碑加成比例(offeredRent 用;0.05%/點 → 滿口碑 +5%) */
export const reputationRentBonus = () => state.reputation * 0.0005;
