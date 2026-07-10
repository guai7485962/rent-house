/**
 * balance 快照測試(設計檢討 §6 工作項 10)。
 * 固定隨機種子跑 10 遊戲日(事件自動選第一個選項),把關鍵數值/金錢快照存檔;
 * 之後任何改動若不小心動到手感,diff 會直接現形。
 *
 * 改了數值模型、事件、作息後「刻意」要更新基準:
 *   npx tsx scripts/balance-test.ts --update
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 固定種子 PRNG(mulberry32)蓋掉 Math.random —— 必須在載入 store 之前
let seed = 20260710;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state, debugStepHour, decide } = await import("../src/store");

let decisions = 0;
for (let i = 0; i < 240; i++) {
  // 10 遊戲日
  debugStepHour();
  // 事件一律選第一個選項(讓模擬不會被 pendingEvent 卡住,且決策路徑固定)
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent) {
      const c = rt.pendingEvent.choices[0];
      decide(rt.tenant.id, c.id, c.label);
      decisions++;
    }
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const snap = {
  note: "固定種子 20260710、10 遊戲日、事件選第一項。改動手感後用 --update 重建基準。",
  money: state.money,
  ledgerCount: state.ledger.length,
  decisions,
  tenantCount: Object.keys(state.runtimes).length,
  tenants: Object.fromEntries(
    Object.values(state.runtimes).map((rt) => [
      rt.tenant.id,
      {
        mood: r1(rt.tenant.stats.mood),
        stress: r1(rt.tenant.stats.stress),
        energy: r1(rt.tenant.stats.energy),
        wellbeing: r1(rt.tenant.stats.wellbeing),
        affinity: r1(rt.tenant.stats.affinity),
        satisfaction: r1(rt.satisfaction),
        rent: rt.tenant.finance.monthlyRent,
        logs: rt.log.length,
        memories: rt.tenant.memoryTags.length,
      },
    ]),
  ),
};

const file = fileURLToPath(new URL("./balance-snapshot.json", import.meta.url));
const text = JSON.stringify(snap, null, 2);

if (!existsSync(file) || process.argv.includes("--update")) {
  writeFileSync(file, text, "utf8");
  console.log("📸 已寫入新的 balance 基準:scripts/balance-snapshot.json");
  console.log(text);
  process.exit(0);
}

const prev = readFileSync(file, "utf8");
if (prev.trim() === text.trim()) {
  console.log("✅ balance 快照一致:數值手感沒有變。");
} else {
  console.log("❌ balance 快照不一致!以下是新舊差異(左=基準、右=本次):");
  const a = JSON.parse(prev);
  const flat = (o: any, p = ""): Record<string, unknown> =>
    Object.entries(o).reduce((acc, [k, v]) => {
      if (v && typeof v === "object") Object.assign(acc, flat(v, `${p}${k}.`));
      else acc[`${p}${k}`] = v;
      return acc;
    }, {} as Record<string, unknown>);
  const fa = flat(a);
  const fb = flat(snap);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (fa[k] !== fb[k]) console.log(`  ${k}: ${fa[k]} → ${fb[k]}`);
  }
  console.log("\n若是刻意的平衡調整:npx tsx scripts/balance-test.ts --update");
  process.exit(1);
}
