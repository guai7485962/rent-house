/**
 * Worker 端點防護單元測試(不需啟動 Cloudflare runtime,直接測 _internal 純函式):
 * - sameOrigin:同源 Origin/Referer 放行、跨站/裸請求/壞 header 擋下
 * - guardRequest:非同源 403、body 過大 413、正常放行
 * - clampCtx:陣列條數/字串長度/數值範圍夾值,亂資料不炸
 * - parseResult:抽出 JSON、diary 截長、壞資料 → null
 */
const { _internal } = await import("../worker/index");
const { sameOrigin, guardRequest, clampCtx, parseResult } = _internal;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const HOST = "https://rent-house.guai7485962.workers.dev";
const mk = (headers: Record<string, string>) => new Request(`${HOST}/api/narrate`, { method: "POST", headers });

// --- sameOrigin ---
check("同源 Origin → 通過", sameOrigin(mk({ origin: HOST })));
check("同源 Referer → 通過", sameOrigin(mk({ referer: `${HOST}/room` })));
check("跨站 Origin → 擋", !sameOrigin(mk({ origin: "https://evil.example.com" })));
check("無 Origin 無 Referer(裸 curl)→ 擋", !sameOrigin(mk({})));
check("壞掉的 Origin → 擋", !sameOrigin(mk({ origin: "not a url" })));

// --- guardRequest ---
check("守門:非同源 → 403", guardRequest(mk({ origin: "https://evil.example.com" }))?.status === 403);
check("守門:同源且小 body → 放行(null)", guardRequest(mk({ origin: HOST, "content-length": "500" })) === null);
check("守門:body 過大 → 413", guardRequest(mk({ origin: HOST, "content-length": String(20 * 1024) }))?.status === 413);

// --- clampCtx ---
const huge = {
  name: "x".repeat(999),
  todayLog: Array.from({ length: 200 }, () => "L".repeat(999)),
  stats: { mood: 9999, stress: -5, affinity: 50, satisfaction: 70 },
  flags: Array(999).fill("f"),
  arc: { theme: "t".repeat(99), stage: 99, maxStage: 1, summary: "s".repeat(999) },
};
const c = clampCtx(huge);
check("clampCtx:name 截短 ≤24", c.name.length <= 24);
check("clampCtx:todayLog 條數 ≤20", c.todayLog.length <= 20);
check("clampCtx:todayLog 單條 ≤200", c.todayLog[0].length <= 200);
check("clampCtx:stat 夾 0~100", c.stats.mood === 100 && c.stats.stress === 0);
check("clampCtx:flags ≤16", c.flags.length <= 16);
check("clampCtx:arc.stage/maxStage 夾值", (c.arc?.stage ?? 0) <= 9 && (c.arc?.maxStage ?? 0) >= 2);
check("clampCtx:亂資料不炸", (() => { try { clampCtx(null); clampCtx("x"); clampCtx(123); return true; } catch { return false; } })());
check("clampCtx:無 arc → null", clampCtx({ name: "a" }).arc === null);

// --- parseResult ---
check("parseResult:抽出 JSON + diary", parseResult('前綴 {"diary":"你好","summaryUpdate":"s"} 後綴')?.diary === "你好");
check("parseResult:diary 截 ≤500", (parseResult(`{"diary":"${"字".repeat(999)}"}`)?.diary.length ?? 0) <= 500);
check("parseResult:壞 JSON → null", parseResult("這不是 json") === null);
check("parseResult:缺 diary → null", parseResult('{"summaryUpdate":"s"}') === null);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
