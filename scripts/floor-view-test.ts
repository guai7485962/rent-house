/** CAFE-02 樓層切換器的 SFC 合約測試。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/components/FloorMap.vue", import.meta.url)), "utf8");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};

check("固定樓層機位集中在 FLOOR_VIEWS", source.includes("const FLOOR_VIEWS"));
check("3F 機位維持既有 16×33 格", /viewportRect\(0, 0, 16 \* TILE, 33 \* TILE\)/.test(source));
check("1F 機位固定為 row 34 起的 16×18 格", /viewportRect\(0, 34 \* TILE, 16 \* TILE, 18 \* TILE\)/.test(source));
check("FloorMap 透過共用 FloorViewport 繪製", source.includes("renderFloorViewport(ctx, view, 1"));
check("canvas 尺寸跟隨目前樓層矩形", source.includes(':width="canvasWidth"') && source.includes(':height="canvasHeight"'));
check("點擊座標加回目前 viewport 原點", source.includes("const cx = view.x +") && source.includes("const cy = view.y +"));
check("樓層切換具 tab 語意與選取狀態", source.includes('role="tablist"') && source.includes(':aria-selected="floorView === view.id"'));
check("沒有加入自由捲動或縮放手勢", !/@(?:wheel|pointerdown|touchstart)=/.test(source));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
