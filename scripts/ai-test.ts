import { state, fastForward } from "../src/store";

// fastForward 走 live=false → 用模板日記(不打 API),驗證每日一篇機制
fastForward(50); // 約 2 個換日
console.log("=== 每日觀察日記(模板 fallback)===");
for (const rt of Object.values(state.runtimes)) {
  const diaries = rt.log.filter((e) => e.ai !== undefined && e.importance === "major" && e.text);
  console.log(`\n${rt.tenant.name}:${diaries.length} 篇`);
  for (const d of diaries) console.log(`  [${d.timeLabel}] ${d.text}`);
}
