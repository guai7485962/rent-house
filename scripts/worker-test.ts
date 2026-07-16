/**
 * Worker 端點防護單元測試(不需啟動 Cloudflare runtime,直接測 _internal 純函式):
 * - sameOrigin:同源 Origin/Referer 放行、跨站/裸請求/壞 header 擋下
 * - guardRequest:非同源 403、body 過大 413、正常放行
 * - clampCtx:陣列條數/字串長度/數值範圍夾值,亂資料不炸
 * - parseResult:抽出 JSON、diary 截長、壞資料 → null
 */
const { _internal } = await import("../worker/index");
const { sameOrigin, guardRequest, clampCtx, buildPrompt, parseResult, chooseGeminiModel, extractWorkersAiText, systemPrompt } = _internal;

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
check("clampCtx:todayLog 去重後條數 ≤10", c.todayLog.length <= 10);
check("clampCtx:todayLog 單條 ≤200", c.todayLog[0].length <= 200);
check("clampCtx:stat 夾 0~100", c.stats.mood === 100 && c.stats.stress === 0);
check("clampCtx:flags ≤16", c.flags.length <= 16);
check("clampCtx:arc.stage/maxStage 夾值", (c.arc?.stage ?? 0) <= 9 && (c.arc?.maxStage ?? 0) >= 2);
check("clampCtx:亂資料不炸", (() => { try { clampCtx(null); clampCtx("x"); clampCtx(123); return true; } catch { return false; } })());
check("clampCtx:無 arc → null", clampCtx({ name: "a" }).arc === null);
check("clampCtx:eventDue 僅接受 true", clampCtx({ eventDue: true }).eventDue && !clampCtx({ eventDue: "true" }).eventDue);
check("clampCtx:房間聲學夾值 + 非布林風險採保守預設", (() => {
  const room = clampCtx({ room: { noise: 999, soundproof: -3, treated: true, complaintRisk: "true" } }).room;
  return room.noise === 100 && room.soundproof === 0 && room.treated && room.complaintRisk;
})());
check("舊 context 缺聲學欄位時保守視為仍有抗議風險", clampCtx({ name: "舊租客" }).room.complaintRisk === true);
check("隔音完成會明確限制 AI 不得生成室內噪音抗議", buildPrompt(clampCtx({
  name: "夜貓租客", room: { noise: 8, soundproof: 12, treated: true, complaintRisk: false },
})).includes("不得生成相關抗議"));
check("日記 prompt 明定不可寫流水帳與重複總結", systemPrompt.includes("不要寫成流水帳") && systemPrompt.includes("每件事只能寫一次"));
check("背景與今日素材在 prompt 中明確分區", (() => {
  const prompt = buildPrompt(clampCtx({ name: "a", todayLog: ["今天片段"] }));
  return prompt.includes("背景資料—只供理解") && prompt.includes("今天可寫素材—已去重");
})());

// --- 免費模型分流:平淡日常用 Lite,事件/主線日用 Flash ---
check("模型分流:平淡日常 → 3.1 Flash-Lite", chooseGeminiModel(clampCtx({ name: "a" })) === "gemini-3.1-flash-lite");
check("模型分流:事件機會已到 → 3 Flash", chooseGeminiModel(clampCtx({ name: "a", eventDue: true })) === "gemini-3-flash-preview");
check("模型分流:進行中劇情弧 → 3 Flash", chooseGeminiModel(clampCtx({ name: "a", arc: { theme: "搬家", stage: 1, maxStage: 3, summary: "整理中" } })) === "gemini-3-flash-preview");

// --- Workers AI 同步輸出:新版是 OpenAI choices,舊版是 response ---
check("Workers AI:解析 OpenAI choices", extractWorkersAiText({ choices: [{ message: { content: "新版" } }] }) === "新版");
check("Workers AI:兼容舊 response", extractWorkersAiText({ response: "舊版" }) === "舊版");
check("Workers AI:支援 content parts", extractWorkersAiText({ choices: [{ message: { content: [{ type: "text", text: "分" }, { type: "text", text: "段" }] } }] }) === "分段");
check("Workers AI:JSON Mode 物件 response 會序列化", extractWorkersAiText({ response: { diary: "物件版" } }) === '{"diary":"物件版"}');
check("Workers AI:空 response 不會遮掉有效 choices", extractWorkersAiText({ response: "", choices: [{ message: { content: "choices 有值" } }] }) === "choices 有值");
check("Workers AI:空輸出 → null", extractWorkersAiText({ choices: [] }) === null);

// --- parseResult ---
check("parseResult:抽出 JSON + 補完整句號", parseResult('前綴 {"diary":"你好","summaryUpdate":"s"} 後綴')?.diary === "你好。");
check("parseResult:diary 只保留完整句且 ≤320", (() => {
  const diary = parseResult(`{"diary":"${"字".repeat(999)}"}`)?.diary ?? "";
  return diary.length <= 320 && diary.endsWith("。");
})());
check("parseResult:移除重複句", parseResult('{"diary":"他看了一眼窗外。他看了一眼窗外。他轉身去泡茶。"}')?.diary === "他看了一眼窗外。他轉身去泡茶。");
check("parseResult:壞 JSON → null", parseResult("這不是 json") === null);
check("parseResult:缺 diary → null", parseResult('{"summaryUpdate":"s"}') === null);

// --- observation(觀察回饋):prompt 指引 + 原樣透傳(消毒在前端統一做) ---
check("日記 prompt 含 observation 指引與夾值提示", systemPrompt.includes("observation(觀察回饋)") && systemPrompt.includes("±3") && systemPrompt.includes('"observation"'));
check("prompt 含自發行為 behavior 指引(含新 4 種、排除 adopt_cat)",
  systemPrompt.includes('"behavior"') && systemPrompt.includes("comfort_seek") && systemPrompt.includes("sulk") && systemPrompt.includes("adopt_cat 不在此清單"));
check("事件 directive 白名單已擴充至 10 個", systemPrompt.includes("id 只能從這 10 個選"));
check("prompt 含 arc tone 指引(enum 三值 + 收束語意)", systemPrompt.includes('"tone"') && systemPrompt.includes("如釋重負") && systemPrompt.includes('"up|down|tense(選填)"'));
check("prompt 含跨租客 rel 推力指引", systemPrompt.includes('"rel"') && systemPrompt.includes("delta") && systemPrompt.includes("系統會擋下越界的推力"));

// --- 天氣接線 ---
check("clampCtx:weather 截 ≤12", clampCtx({ name: "a", weather: "🌧️ 雨天".repeat(9) }).weather!.length <= 12);
check("prompt 帶天氣行(有值才出現)", (() => {
  const withW = buildPrompt(clampCtx({ name: "a", weather: "🌧️ 雨天" }));
  const without = buildPrompt(clampCtx({ name: "a" }));
  return withW.includes("今天天氣:🌧️ 雨天") && !without.includes("今天天氣");
})());
check("parseResult:observation 物件透傳", (() => {
  const r = parseResult('{"diary":"今天。","observation":{"nudge":{"mood":-2},"reason":"理由"}}');
  return !!r && typeof r.observation === "object" && (r.observation as any)?.nudge?.mood === -2;
})());
check("parseResult:observation 非物件 → null", parseResult('{"diary":"今天。","observation":"文字"}')?.observation === null);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
