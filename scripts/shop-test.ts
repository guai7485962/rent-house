import { state, buyFurniture } from "../src/store";
import { roomAttributes, getPlacements, findFreeSlot } from "../src/sim/placements";

console.log(`起始金錢:${state.money}`);
console.log(`303 空房初始屬性:`, roomAttributes("r303"), `家具數 ${getPlacements().filter((p) => p.room === "r303").length}`);

// 幫 303 空房添購:電競桌 + 電視 + 盆栽
for (const id of ["gaming_desk", "tv_console", "plant"]) {
  const before = state.money;
  const res = buyFurniture(id, "r303");
  console.log(`買 ${id}: ${res.ok ? "成功" : "失敗:" + res.reason}  金錢 ${before}→${state.money}`);
}
console.log(`303 添購後屬性:`, roomAttributes("r303"), `家具數 ${getPlacements().filter((p) => p.room === "r303").length}`);

// 測試買不起
state.money = 100;
const poor = buyFurniture("gaming_desk", "r303");
console.log(`錢不夠時買電競桌:${poor.ok ? "成功(不該發生)" : "正確擋下:" + poor.reason}`);

// 測試找空位不重疊
const slot = findFreeSlot("r303", 2, 2);
console.log(`303 下一個 2×2 空位:`, slot ?? "(已滿)");
