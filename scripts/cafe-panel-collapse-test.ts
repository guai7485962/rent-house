/**
 * 2026-08-09「咖啡廳分頁改成可收合 + 常備量加 ±1／±5」的 SFC 合約測試。
 *
 * 這兩項都住在 `CafePanel.vue` 的樣板與區域狀態裡(夾值用的 `MAX_STANDING_ORDER`
 * 依 `cafe-recipe-clarity-test.ts` 的斷言必須留在本元件),沒有可以在無頭環境跑的
 * 模擬邏輯,所以照 `ops-panel-test.ts` 的做法掃原始碼釘住不變式:
 *   ① 九個區塊都可收合,預設只展開「營運觀察」與「常備量」;
 *   ② 收起時仍看得到摘要,而且有顧客在等的詢問卡不會被收起來害玩家漏掉;
 *   ③ ± 快捷動的是草稿、經過夾值,寫入存檔的路徑仍只有「套用常備量」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panel = readFileSync(fileURLToPath(new URL("../src/components/CafePanel.vue", import.meta.url)), "utf8");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};
const count = (re: RegExp) => (panel.match(re) ?? []).length;

const SECTIONS = ["today", "research", "menu", "sales", "stock", "staff", "invest", "adoption", "rent"] as const;
/** 每個標題列按鈕的內容(到第一個 </button> 為止)。 */
const heads = [...panel.matchAll(/<button class="section-head"[\s\S]*?<\/button>/g)].map((m) => m[0]);

// ── ① 收合 ────────────────────────────────────────────────
check("九個區塊的標題列都是收合開關", heads.length === SECTIONS.length);
check("沒有殘留不可收合的標題列", !panel.includes('<div class="section-head">'));
check(
  "每個區塊都有 toggle、v-if 與收起狀態的 class",
  SECTIONS.every((id) =>
    panel.includes(`@click="toggleSection('${id}')"`)
    && panel.includes(`v-if="openSections.${id}"`)
    && panel.includes(`:class="{ collapsed: !openSections.${id} }"`)),
);
check(
  "標題列有 aria-expanded,每個區塊各一顆開關",
  count(/:aria-expanded="openSections\./g) === SECTIONS.length,
);
check(
  "預設只展開「營運觀察」與「常備量」",
  /openSections = reactive\(\{[\s\S]*?\}\)/.test(panel)
    && /today: true/.test(panel) && /stock: true/.test(panel)
    && ["research", "menu", "sales", "staff", "invest"].every((id) => new RegExp(`${id}: false`).test(panel)),
);
check(
  "有顧客在等回覆的詢問卡預設展開,開著面板時進來的也會補開",
  /adoption: adoptGuests\.value\.length > 0/.test(panel)
    && /rent: rentGuests\.value\.length > 0/.test(panel)
    && /watch\(\(\) => adoptGuests\.value\.length[\s\S]*?openSections\.adoption = true/.test(panel)
    && /watch\(\(\) => rentGuests\.value\.length[\s\S]*?openSections\.rent = true/.test(panel),
);
check(
  "收起時整張卡只剩標題列(不留下面的間距)",
  /\.section-head\.collapsed \{ margin-bottom: 0; \}/.test(panel),
);
check(
  "標題列裡不能再放按鈕(button 不可巢狀)——常備量的兩顆工具鍵已移到內容區",
  heads.every((head) => (head.match(/<button/g) ?? []).length === 1)
    && panel.includes('<div class="order-tools">'),
);
check(
  "收起也看得出要不要點開:每個標題列都帶一個摘要 + 箭頭",
  heads.every((head) => /<span class="(capacity|research-count|ticket|window|blamed-count|count|staff-wage|balance)/.test(head)
    && head.includes('<span class="chev"')),
);

// ── ② 常備量 ±1／±5 ────────────────────────────────────────
check(
  "每列原料都有 −5 / −1 / +1 / +5 四顆快捷",
  count(/bumpOrder\(item\.id, -5\)/g) === 1
    && count(/bumpOrder\(item\.id, -1\)/g) === 1
    && count(/bumpOrder\(item\.id, 1\)/g) === 1
    && count(/bumpOrder\(item\.id, 5\)/g) === 1
    && panel.includes('<div class="order-stepper">'),
);
check(
  "± 走同一套夾值(0 ～ MAX_STANDING_ORDER),不會做出負數或超上限",
  /function bumpOrder\(id: string, delta: number\) \{\s*orderDraft\[id\] = safeUnits\(safeUnits\(orderDraft\[id\]\) \+ delta\);/.test(panel)
    && /MAX_STANDING_ORDER\s*=\s*\d+/.test(panel)
    && /Math\.min\(MAX_STANDING_ORDER, Math\.max\(0, Math\.floor\(n\)\)\)/.test(panel),
);
check(
  "到邊界就 disable(0 不能再減、上限不能再加)",
  count(/:disabled="safeUnits\(orderDraft\[item\.id\]\) <= 0"/g) === 2
    && count(/:disabled="safeUnits\(orderDraft\[item\.id\]\) >= MAX_STANDING_ORDER"/g) === 2,
);
check(
  "± 動的是草稿:寫進 state 的路徑仍只有「套用常備量」",
  count(/state\.cafe\.standingOrders = /g) === 1
    && panel.includes('@click="applyStandingOrders"')
    && !/bumpOrder[\s\S]{0,200}(save\(\)|state\.cafe\.standingOrders)/.test(panel),
);
check(
  "原料列不再是 label(button 包在 label 裡會連帶 focus 輸入框)",
  panel.includes('<div v-for="item in CAFE_INGREDIENTS" :key="item.id" class="order-row"')
    && !/<label v-for="item in CAFE_INGREDIENTS"/.test(panel),
);
check(
  "四顆快捷與輸入框都有可讀的 aria-label",
  count(/:aria-label="`\$\{item\.name\}常備量[加減] [15]`"/g) === 4
    && panel.includes(':aria-label="`${item.name}常備量`"'),
);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
