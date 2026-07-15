/**
 * 一鍵回歸:依序跑 scripts/ 下所有 *-test.ts,再跑 sim-trace 24h 檢查。
 * 任一失敗 → 整體 exit 1(給 CI 與「改動後驗證」用)。
 *
 * 用法:
 *   npx tsx scripts/run-all.ts            # 全跑
 *   npx tsx scripts/run-all.ts pet diary  # 只跑檔名含這些關鍵字的
 *
 * 判定失敗:離開碼 ≠ 0,或輸出的「結果:N 通過 / M 失敗」中 M > 0。
 * sim-trace 額外要求輸出含「無異常」。
 * balance-test 需要固定種子基準;若你剛做了刻意的平衡調整,先手動
 *   npx tsx scripts/balance-test.ts --update 重建基準,再跑本 runner。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));

/**
 * 正式回歸集:有斷言計數(或 exit 1 把關)的確定性測試。
 * scripts/ 下另有一批早期「煙霧腳本」(只印輸出、不斷言、有的還會掛著計時器不結束),
 * 不列入 CI——需要時用 `npx tsx scripts/run-all.ts <關鍵字>` 以檔名過濾即可跑到它們。
 */
// 註:CI 必須固定時區(TZ=Asia/Taipei,見 .github/workflows/ci.yml)——遊戲用本地時區的
// getHours()/getDate() 決定作息,設計基準 +08:00;UTC 下作息位移 8 小時會讓時段型測試假性失敗。
// balance-test 已在時區一致下可重現,故留在 CI 集;浮點欄位另有 ±0.6 容差兜跨版本微抖。
const REGRESSION = [
  "acoustics-laundry-test.ts", "ai-interaction-test.ts", "appearance-test.ts", "arc-test.ts", "archetypes-test.ts",
  "balance-test.ts", "bathroom-life-test.ts", "bugfix2-test.ts", "cohabit-integrity-test.ts", "community-test.ts", "conflict-test.ts", "content-variety-test.ts", "data-catalog-test.ts",
  "daynight-test.ts", "diary-queue-test.ts", "diary-stagger-test.ts", "diary-upgrade-test.ts", "directive-test.ts",
  "distinct-test.ts", "drama-test.ts", "eviction-test.ts", "feed-test.ts", "finance-test.ts", "fixes-test.ts", "fx-test.ts",
  "interactions-test.ts", "invite-test.ts", "kitchen-life-test.ts", "legacy-test.ts", "maintenance-test.ts", "memory-lifecycle-test.ts",
  "move-test.ts", "pair-session-test.ts", "pet-test.ts", "qol-test.ts", "relist-test.ts", "romance-integrity-test.ts",
  "rent-test.ts", "roomcam-test.ts", "rotation-pose-test.ts", "stats-model-test.ts", "summary-test.ts", "weekly-report-test.ts", "worker-test.ts",
];

// 無過濾 → 跑正式回歸集;有過濾 → 從 scripts/ 全體 *-test.ts 撈符合關鍵字的(含舊煙霧腳本)
const pool = filters.length === 0
  ? REGRESSION
  : readdirSync(here).filter((f) => f.endsWith("-test.ts") && f !== "run-all.ts");
const allTests = pool.filter((f) => filters.length === 0 || filters.some((k) => f.includes(k))).sort();

interface Result { name: string; ok: boolean; detail: string; ms: number }
const results: Result[] = [];

function run(script: string, requirePhrase?: string): Result {
  const t0 = Date.now();
  // node --import tsx <script>:免 shell(不觸發 shell:true 的參數轉義警告)、免每支重跑 npx 解析
  const r = spawnSync(process.execPath, ["--import", "tsx", join(here, script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.error) return { name: script, ok: false, detail: `執行錯誤:${r.error.message}`, ms };
  // 失敗時把實際失敗的斷言(❌ 那幾行)帶出來,CI log 直接看得到是哪一條掛了
  const failDetail = () => {
    const fails = out.split("\n").filter((l) => l.includes("❌")).slice(0, 6).join(" ⏎ ");
    const summary = out.match(/\d+\s*通過\s*\/\s*\d+\s*失敗/)?.[0] ?? `exit ${r.status}`;
    return fails ? `${summary} | ${fails}` : `${summary} — ${out.trim().split("\n").slice(-3).join(" ⏎ ")}`;
  };
  if (r.status !== 0) return { name: script, ok: false, detail: failDetail(), ms };
  // 「結果:N 通過 / M 失敗」——M>0 也算失敗(有些舊腳本不 exit 1)
  const m = out.match(/(\d+)\s*通過\s*\/\s*(\d+)\s*失敗/);
  if (m && Number(m[2]) > 0) return { name: script, ok: false, detail: failDetail(), ms };
  if (requirePhrase && !out.includes(requirePhrase)) {
    return { name: script, ok: false, detail: `輸出未見「${requirePhrase}」`, ms };
  }
  return { name: script, ok: true, detail: m ? `${m[1]} 通過` : "OK", ms };
}

// 失敗就重試一次:機率型測試偶爾抽到壞運會假性失敗,重試多半就過;
// 真正壞掉的測試(確定性失敗)兩次都失敗 → 照樣抓到,不會被漏掉。
function runWithRetry(script: string, requirePhrase?: string): Result {
  const first = run(script, requirePhrase);
  if (first.ok) return first;
  const retry = run(script, requirePhrase);
  if (retry.ok) return { ...retry, detail: `${retry.detail}(首次失敗後重試通過)` };
  return first;
}

console.log(`▶ 跑 ${allTests.length} 支測試${filters.length ? `(過濾:${filters.join(", ")})` : ""}…\n`);
for (const t of allTests) {
  const res = runWithRetry(t);
  results.push(res);
  console.log(`${res.ok ? "✅" : "❌"} ${res.name.padEnd(26)} ${res.detail}  (${(res.ms / 1000).toFixed(1)}s)`);
}

// sim-trace:只在無過濾(全跑)或明確點名時跑
if (filters.length === 0 || filters.some((k) => "sim-trace".includes(k) || k === "trace")) {
  const res = runWithRetry("sim-trace.ts", "無異常");
  res.name = "sim-trace.ts";
  results.push(res);
  console.log(`${res.ok ? "✅" : "❌"} ${res.name.padEnd(26)} ${res.detail}  (${(res.ms / 1000).toFixed(1)}s)`);
}

const failed = results.filter((r) => !r.ok);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n=== ${results.length - failed.length}/${results.length} 支通過,耗時 ${(totalMs / 1000).toFixed(1)}s ===`);
if (failed.length > 0) {
  console.log(`失敗:${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("全部通過 🎉");
