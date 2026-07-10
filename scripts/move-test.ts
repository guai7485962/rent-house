/** 家具移動(8-1)驗證:合法搬動 / 非法還原 / 跨房屬性 / 租客重定位 / 錢不變 */
import { state, startMoving, moveFurnitureTo, debugStepHour } from "../src/store";
import { placements, furnitureAt, findFreeSlot, roomAttributes } from "../src/sim/placements";
import { getDef } from "../src/furniture/catalog";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const moneyBefore = state.money;

// 找一件 301 房的家具來搬
const target = placements.list.find((p) => p.room === "r301")!;
const def = getDef(target.defId);
const orig = { c: target.c, r: target.r };
console.log(`搬動目標:${def.name}(${orig.c},${orig.r})@r301,佔 ${def.footprint.w}x${def.footprint.h}`);

// 1. 非法:搬到 (0,0) 牆上 → 失敗且家具留在原地
startMoving(orig.c, orig.r);
const bad = moveFurnitureTo(0, 0);
check("搬到牆上失敗", !bad.ok);
check("失敗後家具留在原位", furnitureAt(orig.c, orig.r)?.defId === target.defId);
check("失敗後 pendingMove 仍在(可再選位)", state.pendingMove !== null);

// 2. 非法:壓到別的家具 → 失敗還原
const other = placements.list.find((p) => p.room === "r301" && p !== target);
if (other) {
  const bad2 = moveFurnitureTo(other.c, other.r);
  check("壓到其他家具失敗", !bad2.ok);
  check("家具仍在原位", furnitureAt(orig.c, orig.r)?.defId === target.defId);
}

// 3. 合法:搬到 302(跨房)的空位
const slot = findFreeSlot("r302", def.footprint.w, def.footprint.h)!;
const attr301Before = JSON.stringify(roomAttributes("r301"));
const ok = moveFurnitureTo(slot.c, slot.r);
check("跨房搬到空位成功", ok.ok, ok.reason);
check("新位置查得到", furnitureAt(slot.c, slot.r)?.defId === target.defId);
check("舊位置已空", furnitureAt(orig.c, orig.r)?.defId !== target.defId || !furnitureAt(orig.c, orig.r));
check("room 欄位更新為 r302", placements.list.find((p) => p.defId === target.defId && p.c === slot.c)?.room === "r302");
check("301 房屬性已改變", JSON.stringify(roomAttributes("r301")) !== attr301Before || Object.keys(def.attributes).length === 0);
check("移動免費(錢不變)", state.money === moneyBefore, `${moneyBefore} → ${state.money}`);
check("pendingMove 已清除", state.pendingMove === null);

// 4. 搬走後推進幾小時:租客不該卡死(sim 健全)
for (let i = 0; i < 6; i++) debugStepHour();
check("搬動後推進 6 小時無崩潰", true);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
