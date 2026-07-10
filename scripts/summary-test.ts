/**
 * AI 連續性摘要(設計檢討 §1)驗證:mock /api/narrate,確認
 * - context 帶了滾動摘要(summary)
 * - AI 回的 summaryUpdate 會回寫 tenant.recentSummary(下一天餵回去)
 * - 日記寫入且帶 ai 標;live 模式多租客間有節流間隔
 */

// mock fetch —— 必須在載入 store 之前
const seenBodies: any[] = [];
const callTimes: number[] = [];
(globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
  callTimes.push(Date.now());
  const body = init?.body ? JSON.parse(init.body) : null;
  seenBodies.push(body);
  return {
    ok: true,
    json: async () => ({
      diary: `【AI】${body?.name ?? "?"} 的一天,接續昨天的劇情。`,
      newMemory: null,
      event: null,
      summaryUpdate: `【摘要】${body?.name ?? "?"}:昨天的伏筆持續發酵,今天有了新進展。`,
    }),
  };
};

const { state, fastForward } = await import("../src/store");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

const lin = state.runtimes["tenant_lin_asmr"];
const summaryBefore = lin.tenant.recentSummary;

// 開局 22:00 → 快轉 3 小時跨午夜,觸發 live AI 日記(fire-and-forget)
fastForward(3);
// 等 fire-and-forget 完成(2 位租客 × (fetch + 4s 節流間隔))
await new Promise((r) => setTimeout(r, 7000));

check("兩位租客各打了一次 narrate", seenBodies.length === 2);
check("context 帶了滾動摘要 summary", typeof seenBodies[0]?.summary === "string" && seenBodies[0].summary.length > 0);
check("AI 日記寫入且帶 ✨AI 標", lin.log.some((e) => e.daily && e.ai && e.text.startsWith("【AI】")));
check(
  `recentSummary 已被 summaryUpdate 取代`,
  lin.tenant.recentSummary !== summaryBefore && lin.tenant.recentSummary.startsWith("【摘要】林小婕"),
);
check(
  `narrate 節流:兩次呼叫間隔 ≥ 3.5 秒(實測 ${callTimes.length === 2 ? callTimes[1] - callTimes[0] : "?"}ms)`,
  callTimes.length === 2 && callTimes[1] - callTimes[0] >= 3500,
);

// 第二天:context 的 summary 應該是「更新後」的摘要(連續性閉環)
seenBodies.length = 0;
fastForward(24);
await new Promise((r) => setTimeout(r, 7000));
const linBody = seenBodies.find((b) => b?.name === "林小婕");
check("次日 context 餵的是更新後的摘要(閉環)", !!linBody && linBody.summary.startsWith("【摘要】林小婕"));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
