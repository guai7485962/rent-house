/**
 * 演出層(§10-4)+ 額度提示 驗證:
 * - fx 佇列:spawn/過期清除/上限
 * - encounter 回傳 tone(friendly/romantic/conflict)
 * - narrate quota 旗標型別接通(NarrateResult.quota)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnFx, activeFx, clearFx } from "../src/floor/fx";
import { encounter, relationships, pairKey } from "../src/sim/social";
import type { Tenant } from "../src/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};

// --- fx 佇列 ---
clearFx();
spawnFx("hearts", 5, 5, 5000);
spawnFx("anger", 6, 6, 5000);
check("spawn 後存活 2 個", activeFx().length === 2);
spawnFx("chat", 7, 7, -1); // 立刻過期
check("過期的自動清除", activeFx().length === 2 && activeFx().every((f) => f.kind !== "chat"));
for (let i = 0; i < 60; i++) spawnFx("chat", i, 0, 5000);
check("上限 40 不爆量", activeFx().length <= 40);
clearFx();
check("clearFx 清空", activeFx().length === 0);

// --- 掃碼:FxKind union 的每個成員都要在 drawFx 有分支 ---
// 「加了 kind 卻忘了畫」是靜默失敗:spawnFx 照樣進佇列、畫面上什麼都沒有,
// 而且沒有任何型別錯誤會提醒你。這條掃碼是唯一的把關。
{
  const here = dirname(fileURLToPath(import.meta.url));
  const readSrc = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");
  const fxSrc = readSrc("floor/fx.ts");
  const sceneSrc = readSrc("floor/floorScene.ts");
  const unionStart = fxSrc.indexOf("export type FxKind");
  const union = fxSrc.slice(unionStart, fxSrc.indexOf(";", unionStart));
  const kinds = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  const drawBody = sceneSrc.slice(sceneSrc.indexOf("function drawFx"), sceneSrc.indexOf("/** 隨狀態的環境演出"));
  const missing = kinds.filter((k) => !drawBody.includes(`f.kind === "${k}"`));
  check(`FxKind union 掃得到全部成員(目前 ${kinds.length} 種)`, kinds.length >= 11);
  check(`每個 FxKind 在 drawFx 都有分支(漏接=${missing.join(",") || "無"})`, missing.length === 0);
}

// --- encounter tone ---
const t = (id: string, tags: string[] = []): Tenant =>
  ({ id, name: id, coreTags: tags.map((x) => ({ id: x, label: x, behaviorHint: "" })), memoryTags: [], gender: "male", attractedTo: ["female"] }) as unknown as Tenant;

// 衝突:相容度極差(noisy vs quiet)→ 多抽幾次必出 conflict
let sawConflict = false;
let sawFriendly = false;
for (let i = 0; i < 200 && !(sawConflict && sawFriendly); i++) {
  delete relationships[pairKey("x1", "x2")];
  const res = encounter(t("x1", ["noisy"]), t("x2", ["perfectionist"]));
  if (res.tone === "conflict") sawConflict = true;
  if (res.tone === "friendly") sawFriendly = true;
}
check("tone 有 conflict(水火不容組合)", sawConflict);
check("tone 有 friendly(一般互動)", sawFriendly);

// 戀愛氛圍:已是情侶 → romantic
relationships[pairKey("y1", "y2")] = { value: 80, romantic: true, cohabitOffered: true };
const g = (id: string, gender: "male" | "female"): Tenant =>
  ({ id, name: id, coreTags: [], memoryTags: [], gender, attractedTo: [gender === "male" ? "female" : "male"] }) as unknown as Tenant;
let sawRomantic = false;
for (let i = 0; i < 50 && !sawRomantic; i++) {
  relationships[pairKey("y1", "y2")].value = 80; // 防衝突扣到分手線
  if (encounter(g("y1", "male"), g("y2", "female")).tone === "romantic") sawRomantic = true;
}
check("tone 有 romantic(情侶互動)", sawRomantic);

// --- quota 旗標型別接通(編譯期即驗;此處驗 runtime 形狀)---
const { templateDiary } = await import("../src/sim/narrate");
const diary = templateDiary({
  name: "測", occupation: "", bio: "", dayLabel: "第 1 天", coreTags: [], memoryTags: [],
  stats: { mood: 50, stress: 50, affinity: 50, satisfaction: 50 },
  todayLog: [], relationships: [], events: [], neighbors: [], summary: "", arc: null, flags: [],
});
check("模板日記照常運作", typeof diary === "string" && diary.length > 0);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
