import { state, startPlacing, placeAt } from "../src/store";
import { getPlacements } from "../src/sim/placements";

function tryPlace(defId: string, c: number, r: number, label: string) {
  startPlacing(defId);
  const res = placeAt(c, r);
  console.log(`  ${label}: ${res.ok ? "✅ 成功" : "⛔ " + res.reason}`);
  return res.ok;
}

console.log(`起始金錢 ${state.money}`);
console.log("在 303 空房(cols1-5, rows16-22)試擺 plant(1×1):");
tryPlace("plant", 3, 18, "空地 (3,18)");          // 應成功
tryPlace("plant", 0, 18, "牆上 (0,18)");          // 應被擋(col0 是牆)
tryPlace("plant", 3, 18, "同一格重疊 (3,18)");    // 應被擋(已被上一個佔用)
tryPlace("gaming_desk", 4, 16, "跨越床鋪 (4,16)"); // 床在 c1r16 2×2,desk 2×1 在 c4 部分壓到? 視情況

console.log(`剩餘金錢 ${state.money}`);
console.log(`303 家具:`, getPlacements().filter((p) => p.room === "r303").map((p) => `${p.defId}@(${p.c},${p.r})`));
