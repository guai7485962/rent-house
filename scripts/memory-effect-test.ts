import { memoryDrift } from "../src/sim/memoryEffects";
import type { Tenant } from "../src/types";

function tagged(labels: string[]): Tenant {
  return {
    memoryTags: labels.map((l, i) => ({ id: "m" + i, label: l, behaviorHint: "", acquiredAt: "", source: "ai_event" as const })),
  } as unknown as Tenant;
}

console.log("=== 記憶 → 漂移對照(每小時)===");
const cases = ["[熱戀中]", "[失戀]", "[偷養浪貓]", "[開始晨跑]", "[熬夜成癮]", "[對房東起疑]", "[房東的溫情]", "[接案順利]", "[未知的隨機標籤]"];
for (const c of cases) {
  const d = memoryDrift(tagged([c]));
  console.log(`  ${c.padEnd(12)} → mood ${d.mood} / stress ${d.stress} / wellbeing ${d.wellbeing} / energy ${d.energy} / affinity ${d.affinity}`);
}

console.log("\n=== 多標籤疊加 + 夾上限(±1.5)===");
const stacked = memoryDrift(tagged(["[熱戀中]", "[養貓]", "[接案順利]"])); // mood 應被夾在 1.5
console.log(`  熱戀+養貓+接案順 → mood ${stacked.mood}(應 = 1.5,夾上限)`);

console.log("\n=== 方向正確性檢查 ===");
const heartbreak = memoryDrift(tagged(["[失戀]"]));
console.log(heartbreak.mood! < 0 && heartbreak.stress! > 0 ? "✅ 失戀:心情↓ 壓力↑" : "❌");
const love = memoryDrift(tagged(["[熱戀中]"]));
console.log(love.mood! > 0 && love.stress! < 0 ? "✅ 熱戀:心情↑ 壓力↓" : "❌");
const suspicious = memoryDrift(tagged(["[對房東起疑]"]));
console.log(suspicious.affinity! < 0 ? "✅ 起疑:好感↓" : "❌");
const nothing = memoryDrift(tagged(["[完全無關的標籤]"]));
console.log(nothing.mood === 0 && nothing.stress === 0 ? "✅ 無關標籤:無效果" : "❌");
