/**
 * 居住體驗 UI 摘要測試：確認呈現層沿用既有滿意度權重，
 * 並能把主要風險翻成玩家看得懂的診斷，不改任何模擬狀態。
 */
import {
  livingInfluenceNotes,
  livingTone,
  mindBodyScore,
  retentionLabel,
  retentionTone,
  satisfactionTarget,
} from "../src/presentation/livingExperience";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

const healthy = { mood: 80, stress: 20, energy: 80, wellbeing: 80, affinity: 80 };
const exhausted = { mood: 30, stress: 90, energy: 10, wellbeing: 35, affinity: 30 };

check("身心全高時摘要分數為 80", mindBodyScore(healthy) === 80);
check("高壓透支時身心摘要明顯降低", mindBodyScore(exhausted) < 30);
check(
  "極端輸入仍夾在 0~100",
  mindBodyScore({ mood: 999, stress: -50, energy: 999, wellbeing: 999, affinity: 80 }) === 100,
);

check("低於 35 為危險", livingTone(34.9) === "danger");
check("35~54 為留意", livingTone(35) === "watch" && livingTone(54.9) === "watch");
check("55~74 為穩定", livingTone(55) === "steady" && livingTone(74.9) === "steady");
check("75 以上為良好", livingTone(75) === "good");

check("續住意願只有低於真實安全線 25 才是危險", retentionTone(24.9) === "danger");
check("續住意願 25 起不再宣稱正在累積退租風險", retentionTone(25) === "watch");
check("續住意願四段門檻完整", retentionTone(45) === "steady" && retentionTone(75) === "good");
check("續住標籤涵蓋退租風險", retentionLabel(20) === "有退租風險");
check("續住標籤涵蓋安心狀態", retentionLabel(90) === "住得很安心");
check("續住目標公式與滿意度既有權重一致", satisfactionTarget(healthy, 1) === 80);
check("生活機能不足會降低續住目標", satisfactionTarget(healthy, 0.5) === 62);

const risks = livingInfluenceNotes({
  stats: exhausted,
  satisfaction: 25,
  comfort: 25,
  cleanliness: 20,
  needsMet: 0.5,
});
check("診斷最多顯示三項，避免手機資訊過載", risks.length === 3);
check("診斷優先指出高壓", risks[0].includes("壓力"));
check("診斷會指出精力不足", risks.some((note) => note.includes("精力")));

const recovering = livingInfluenceNotes({
  stats: healthy,
  satisfaction: 20,
  comfort: 70,
  cleanliness: 85,
  needsMet: 1,
});
check("當前分數落後好轉狀態時提示正在回升", recovering[0].includes("回升"));

const declining = livingInfluenceNotes({
  stats: exhausted,
  satisfaction: 90,
  comfort: 70,
  cleanliness: 85,
  needsMet: 1,
});
check("當前分數高於惡化狀態時提示可能下降", declining[0].includes("下降"));

const stable = livingInfluenceNotes({
  stats: healthy,
  satisfaction: 85,
  comfort: 70,
  cleanliness: 85,
  needsMet: 1,
});
check("穩定狀態提供不誤稱當前分數因果的正向摘要", stable.length === 1 && stable[0].includes("長期續住"));

const neutral = livingInfluenceNotes({
  stats: { mood: 60, stress: 45, energy: 60, wellbeing: 60, affinity: 60 },
  satisfaction: 60,
  comfort: 55,
  cleanliness: 65,
  needsMet: 1,
});
check("普通狀態不製造警訊", neutral.length === 1 && neutral[0].includes("沒有明顯警訊"));

console.log(`\n結果: ${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
