import { state, fastForward, moveIn, buyFurniture } from "../src/store";
import { generateApplicants } from "../src/sim/recruit";
import { listRelationships } from "../src/sim/social";

// 佈置兩間空房並各招一位(較平靜、壓力低的新租客)
buyFurniture("gaming_desk", "r303");
buyFurniture("tv_console", "r304");
const a = generateApplicants("r303")[0];
moveIn("r303", a);
const b = generateApplicants("r304")[0];
moveIn("r304", b);
console.log(`招入:${a.name}(${a.occupation}) → 303、${b.name}(${b.occupation}) → 304`);

// 跑 5 天,看兩位新鄰居是否在交誼廳建立關係
fastForward(120);
const rels = listRelationships().filter((r) => state.runtimes[r.aId] && state.runtimes[r.bId]);
console.log("=== 5 天後的鄰居關係 ===");
if (rels.length === 0) console.log("  (沒碰上)");
for (const r of rels)
  console.log(`  ${state.runtimes[r.aId].tenant.name} × ${state.runtimes[r.bId].tenant.name}:${r.label}(${r.value})${r.romantic ? " ❤️" : ""}`);
