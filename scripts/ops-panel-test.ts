/**
 * 2026-08-09「收支 ＋ 咖啡廳營運合併成一顆入口、樓層切換鈕併回動作列」的 SFC 合約測試。
 *
 * 這批全是版面/接線改動,沒有可以在無頭環境跑的模擬邏輯,所以照 `floor-view-test.ts`
 * 的做法掃原始碼釘住不變式。要保護的三件事:
 *   ① 收支與咖啡廳只有一顆入口,且同一時間只掛一個面板;
 *   ② 分頁文案只寫在共用的 `OpsTabs.vue`,兩個面板不各寫一份;
 *   ③ 樓層頁面底部只剩兩排(動作列四顆 + 底部導覽四顆),不再有第三排。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const appSource = read("../src/App.vue");
const opsTabs = read("../src/components/OpsTabs.vue");
const finance = read("../src/components/FinancePanel.vue");
const cafe = read("../src/components/CafePanel.vue");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};
const count = (source: string, re: RegExp) => (source.match(re) ?? []).length;

// ── ① 單一入口 ─────────────────────────────────────────────
check(
  "收支與咖啡廳共用一個分頁 id,不再是兩個 boolean",
  // 只認程式碼上的用法,註解裡提到舊名字(說明為何改掉)不算
  appSource.includes("const opsTab = ref<OpsTab | null>(null)")
    && !/\b(showFinance|showCafe)\s*[=.)]/.test(appSource)
    && !/\bconst (showFinance|showCafe)\b/.test(appSource),
);
check(
  "底部導覽那顆是唯一的開啟點",
  count(appSource, /openOps\(\)/g) === 2 // 一次宣告 + 一次 @click
    && appSource.includes('@click="openOps()"'),
);
check(
  "動作列不再有獨立的咖啡廳按鈕",
  !appSource.includes("cafe-btn"),
);
check(
  "預設分頁跟著玩家目前在看的樓層走(在 1F 一鍵直達營運)",
  appSource.includes('opsTab.value = floorView.value === "1f" ? "cafe" : "finance"'),
);
check(
  "兩個面板同一時間只掛一個,且都能切到對方",
  count(appSource, /opsTab === 'finance'/g) === 1
    && count(appSource, /opsTab === 'cafe'/g) === 1
    && count(appSource, /@switch-tab="opsTab = \$event"/g) === 2,
);
check(
  "關閉任一分頁就是關掉整個面板",
  count(appSource, /@close="opsTab = null"/g) === 2,
);

// ── ② 分頁文案單一出處 ──────────────────────────────────────
check(
  "分頁文案只寫在 OpsTabs",
  opsTabs.includes('{ id: "finance", label: "💰 收支" }')
    && opsTabs.includes('{ id: "cafe", label: "☕ 咖啡廳" }')
    && opsTabs.includes("export const OPS_TABS"),
);
check(
  "兩個面板都掛共用分頁列、自己不做 tab 標記",
  finance.includes('<OpsTabs active="finance"') && !finance.includes('role="tab'),
);
check(
  "咖啡廳面板同上,且仍保有既有的 done toast 出口",
  cafe.includes('<OpsTabs active="cafe"')
    && !cafe.includes('role="tab')
    && cafe.includes("done: [text: string]"),
);
check(
  "兩個面板都把切分頁往上丟給 App,不自己開關對方",
  finance.includes("switchTab: [tab: OpsTab]")
    && cafe.includes("switchTab: [tab: OpsTab]")
    && count(finance, /@select="emit\('switchTab', \$event\)"/g) === 1
    && count(cafe, /@select="emit\('switchTab', \$event\)"/g) === 1,
);
check(
  "分頁列本身是可存取的 tablist",
  opsTabs.includes('role="tablist"')
    && opsTabs.includes('role="tab"')
    && opsTabs.includes(':aria-selected="t.id === active"'),
);

// ── ③ 底部只剩兩排 ─────────────────────────────────────────
const actionsStart = appSource.indexOf('<div class="floor-actions">');
const actionsBlock = appSource.slice(actionsStart, appSource.indexOf("\n    </div>", actionsStart));
check("找得到樓層動作列", actionsStart > 0 && actionsBlock.length > 0);
check(
  "動作列剛好四顆:樓層切換 / 家具商店 / 寵物 / 快轉",
  count(actionsBlock, /<button /g) === 4
    && actionsBlock.includes('class="floor-switch"')
    && actionsBlock.includes('class="shop-btn"')
    && actionsBlock.includes('class="pet-btn"')
    && actionsBlock.includes('class="advance"'),
);
check(
  "樓層切換鈕不再自己佔一排(它在動作列裡面,不在外面)",
  count(appSource, /class="floor-switch"/g) === 1
    && actionsBlock.includes('class="floor-switch"'),
);
check(
  "切換鈕不再用整排寬的 grid 版面",
  !appSource.includes("floor-switch-arrow") && !appSource.includes("floor-switch-icon"),
);
check(
  "四顆全部 nowrap(390px 下不折行的既有前提)",
  ["floor-switch", "shop-btn", "pet-btn", "advance"].every((cls) =>
    new RegExp(`\\.${cls} \\{[^}]*white-space: nowrap`).test(appSource)),
);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
