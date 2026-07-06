import { state, sellFurnitureAt } from "../src/store";
import { furnitureAt, getPlacements } from "../src/sim/placements";
import { getDef } from "../src/furniture/catalog";

// 301 的電競桌在 c4,r1(2×1)。點它涵蓋範圍內任一格應查到。
console.log("點 (5,1)(電競桌右半格)查到:", (() => { const f = furnitureAt(5, 1); return f ? getDef(f.defId).name + ` @(${f.c},${f.r})` : "無"; })());
console.log("點 (3,4)(301 空地)查到:", furnitureAt(3, 4) ? "有" : "無(正確,空地)");

// 賣掉它
const f = furnitureAt(5, 1)!;
const before = state.money;
const n0 = getPlacements().length;
const res = sellFurnitureAt(f.c, f.r);
console.log(`賣掉 ${getDef(f.defId).name}:${res.ok ? "成功退 $" + res.refund : "失敗"}  金錢 ${before}→${state.money}  家具數 ${n0}→${getPlacements().length}`);
console.log("賣掉後同格再查:", furnitureAt(5, 1) ? "仍有(錯)" : "已移除(正確)");
