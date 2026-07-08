import { generateHourly } from "../src/sim/generate";
import { templateDiary } from "../src/sim/narrate";
import { OBSERVATION_LINES } from "../src/content/observationLines";

const states = Object.keys(OBSERVATION_LINES) as (keyof typeof OBSERVATION_LINES)[];
console.log(`句庫:${states.length} 狀態,共 ${states.reduce((s, k) => s + (OBSERVATION_LINES[k]?.length ?? 0), 0)} 句`);

// 同一狀態連生 6 次,看是否有變化
console.log("\n=== gaming 連生 6 次 ===");
for (let i = 0; i < 6; i++) {
  const r = generateHourly({ tenantId: "x", tenantName: "測", hour: 20, timeLabel: "", state: "gaming", isDeviation: false, recentSummary: "" });
  console.log("  " + r.logText);
}

// {time} 正確替換
console.log("\n=== cooking 不同時段 ===");
for (const h of [8, 14, 2]) {
  let line = "";
  for (let k = 0; k < 20 && !line.includes("廚房"); k++) line = generateHourly({ tenantId: "x", tenantName: "測", hour: h, timeLabel: "", state: "cooking", isDeviation: false, recentSummary: "" }).logText;
  console.log(`  ${h}:00 → ${line}  ${line.includes("{time}") ? "❌未替換" : line.match(/半夜|凌晨|早上/) ? "❌寫死時段" : "✅"}`);
}

// 每日模板變化
console.log("\n=== 每日模板連生 5 次 ===");
for (let i = 0; i < 5; i++) {
  console.log("  " + templateDiary({ name: "林小婕", occupation: "", bio: "", dayLabel: "第 3 天", coreTags: [], memoryTags: [], stats: { mood: 60, stress: 40, affinity: 55, satisfaction: 60 }, todayLog: [], relationships: [], events: [], neighbors: [] }));
}
