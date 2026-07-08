import { state, moveIn } from "../src/store";
import { generateApplicants } from "../src/sim/recruit";
import { getTheme } from "../src/pixel/scene";
import { generateHourly } from "../src/sim/generate";

// Bug 1:四位租客配色不同
moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
const ids = ["tenant_chen_engineer", "tenant_lin_asmr", state.occupancy["r303"], state.occupancy["r304"]];
const shirts = ids.map((id) => getTheme(id).shirt);
console.log("=== Bug1:四位租客上衣色 ===");
ids.forEach((id, i) => console.log(`  ${state.runtimes[id].tenant.name}(${state.runtimes[id].roomNo}): ${shirts[i]}`));
console.log(new Set(shirts).size === 4 ? "✅ 四色皆不同" : "❌ 有撞色");

// Bug 2:白天不會說半夜
console.log("\n=== Bug2:cooking 時段用詞 ===");
for (const h of [8, 14, 19, 2]) {
  const r = generateHourly({ tenantId: "x", tenantName: "測", hour: h, timeLabel: "", state: "cooking", isDeviation: false, recentSummary: "" });
  console.log(`  ${String(h).padStart(2, "0")}:00 → ${r.logText}`);
}
const day = generateHourly({ tenantId: "x", tenantName: "測", hour: 14, timeLabel: "", state: "cooking", isDeviation: false, recentSummary: "" });
console.log(day.logText.includes("半夜") ? "❌ 白天仍說半夜" : "✅ 白天不再說半夜");
