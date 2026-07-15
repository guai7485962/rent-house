/** 同居唯一性回歸：正式伴侶與同居皆為一對一，第三人的舊待決申請也不能覆蓋住處。 */
import {
  state,
  resolveCohabit,
  getApplicants,
  moveIn,
  cohabitingPartnerId,
  canStartCohabit,
} from "../src/store";
import { relationships, pairKey, setCouple } from "../src/sim/social";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const A = "tenant_chen_engineer";
const B = "tenant_lin_asmr";
const a = state.runtimes[A];
const b = state.runtimes[B];
relationships[pairKey(A, B)] = { value: 95, romantic: true, cohabitOffered: true };

check("尚未同居的兩人可以申請", canStartCohabit(A, B));
state.pendingCohabit = { aId: A, bId: B, aName: a.tenant.name, bName: b.tenant.name };
resolveCohabit(true);
check("B 搬入 A 的 r301", state.cohabits[B] === "r301" && !state.occupancy.r302);
check("雙向都能查到正確同居對象", cohabitingPartnerId(A) === B && cohabitingPartnerId(B) === A);

const applicant = getApplicants("r302")[0];
moveIn("r302", applicant);
const C = applicant.id;
const c = state.runtimes[C];
relationships[pairKey(B, C)] = { value: 96, romantic: false, cohabitOffered: false };
check("已有伴侶者不能再和第三人成為正式情侶", !setCouple(B, C, true, b.tenant, c.tenant));

check("同居搬入者不能再和第三人申請", !canStartCohabit(B, C));
state.pendingCohabit = { aId: C, bId: B, aName: c.tenant.name, bName: b.tenant.name };
resolveCohabit(true);
check("第三人申請不能覆蓋 B 原同居房", state.cohabits[B] === "r301", JSON.stringify(state.cohabits));
check("被拒的第三人仍保有原承租房", state.occupancy.r302 === C, JSON.stringify(state.occupancy));
check("原本 A×B 同居關係完整保留", cohabitingPartnerId(A) === B && cohabitingPartnerId(B) === A);
check("第三人關係維持曖昧、不會變成第二位伴侶", relationships[pairKey(B, C)]?.romantic === false && relationships[pairKey(B, C)]?.value === 96);
check("玩家會收到申請取消原因", state.notice.includes("已有同居對象"));

relationships[pairKey(A, C)] = { value: 97, romantic: false, cohabitOffered: false };
check("同居房主也不能和第三人成為正式情侶", !setCouple(A, C, true, a.tenant, c.tenant));
check("同居房主也不能和第三人申請", !canStartCohabit(A, C));
state.pendingCohabit = { aId: A, bId: C, aName: a.tenant.name, bName: c.tenant.name };
resolveCohabit(true);
check("房主側申請也不會拆掉原同居", state.cohabits[B] === "r301" && state.occupancy.r302 === C);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
