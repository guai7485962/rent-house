import { state, fastForward, resolveCohabit } from "../src/store";
import { listRelationships } from "../src/sim/social";

// 1. 自然相遇:跑 4 天,看陳家豪與林小婕是否在交誼廳建立關係
fastForward(96);
const rels = listRelationships().filter((r) => state.runtimes[r.aId] && state.runtimes[r.bId]);
console.log("=== 自然相遇後的關係 ===");
console.log(
  rels.map((r) => `  ${state.runtimes[r.aId].tenant.name} × ${state.runtimes[r.bId].tenant.name}:${r.label}(${r.value})`).join("\n") || "  (4 天內沒在交誼廳碰上)",
);

// 2. 同居抉擇流程(直接觸發驗證邏輯)
console.log("\n=== 同居抉擇:同意 ===");
state.pendingCohabit = { aId: "tenant_chen_engineer", bId: "tenant_lin_asmr", aName: "陳家豪", bName: "林小婕" };
const sat0 = state.runtimes["tenant_chen_engineer"].satisfaction;
const before = Object.keys(state.runtimes).length;
resolveCohabit(true);
console.log(`  租客數 ${before}→${Object.keys(state.runtimes).length}`);
console.log(`  302 佔用:${state.occupancy["r302"] ?? "空(可再招租)"}`);
console.log(`  陳家豪滿意:${Math.round(sat0)}→${Math.round(state.runtimes["tenant_chen_engineer"].satisfaction)}`);
console.log(`  通知:${state.notice}`);
