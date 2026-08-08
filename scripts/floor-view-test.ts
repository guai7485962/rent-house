/** CAFE-02 獨立樓層頁面切換的 SFC 合約測試。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/components/FloorMap.vue", import.meta.url)), "utf8");
/** 樓層切換鈕 2026-08-09 起住在 App.vue 的底部動作區,不在 FloorMap 裡。 */
const appSource = readFileSync(fileURLToPath(new URL("../src/App.vue", import.meta.url)), "utf8");

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
check(
  "樓層以頁面區域呈現且切換時替換整個 floor-wrap",
  source.includes(':aria-label="`${activeFloorView.floor} ${activeFloorView.label}頁面`"')
    && source.includes('<div :key="floorView" class="floor-wrap">'),
);
// 2026-08-09:切換鈕從 FloorMap 的頁首搬到 App.vue 底部的動作區(使用者要求放到
// 畫面下半部;留在地圖下方會被 `.floor-main` 的 `overflow: hidden` 裁掉)。
// 要保護的不變式沒變 ——「每層只有一顆目的地按鈕、且由 switchFloorPage 觸發」——
// 只是按鈕與觸發點現在跨兩個檔,所以分開驗。
check(
  "FloorMap 仍是唯一決定目的地文案的地方,並把切換動作 expose 出去",
  source.includes('label: "前往 1F 寵物咖啡廳"')
    && source.includes('label: "返回 3F 租屋樓"')
    && source.includes("defineExpose({ switchFloorPage })"),
);
check(
  "3F 只有前往咖啡廳按鈕、1F 只有返回租屋樓按鈕(按鈕在 App 的底部動作區)",
  appSource.includes('floorMapRef?.switchFloorPage()')
    && appSource.includes('floorView === "3f" ? "前往 1F 寵物咖啡廳" : "返回 3F 租屋樓"')
    // 兩個文案是三元的兩端 ⇒ 同一時間只會出現一顆,不可能兩顆並存
    && (appSource.match(/floorMapRef\?\.switchFloorPage\(\)/g) ?? []).length === 1,
);
check(
  "不再使用同頁雙 tab 樣式",
  !source.includes('role="tablist"') && !source.includes('role="tab"') && !source.includes("floor-switcher"),
);
check("沒有加入自由捲動或縮放手勢", !/@(?:wheel|pointerdown|touchstart)=/.test(source));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
