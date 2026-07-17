/** AI 當日觀察品質回歸：使用玩家回報的重複案例，鎖住來源與輸出兩端。 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const {
  sanitizeDiaryText,
  sanitizeSummaryText,
  sanitizeReasonText,
  normalizeNarrativeLanguage,
  selectDiverseNarrativeLines,
  splitNarrativeSentences,
  toTraditional,
} = await import("../src/sim/narrativeQuality");
const { buildNarrateCtx } = await import("../src/sim/narration");
const { state } = await import("../src/store");
const { save, load, SAVE_KEY } = await import("../src/sim/persistence");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const reported = "邱柏翰今天依舊準時備料,但是他的聊天時態度開始變得比較積極。他跟林小婕聊天時看起來很投入,而且他和陳家豪的互動也比以前更加積極。 他還跟花媽聊天時提到了貓的照片,看起來他對貓的感情越來越濃厚。 今天的變化是他的準備行為沒有太大變化,但是他的聊天時態度開始變得比較積極。 他還把書湊得很近又拉遠,大概是該去檢查一下視力了。 他跟林小婕邊喝飲料邊抱怨工作,看起來他真的很累。 他還叫的外送到了,拆袋子的動作透露出期待。 總體來說,邱柏翰今天的行為模式沒有太大變化,但是他的聊天時態度開始變得比較積極。 他還把書湊得很近又拉遠,大概是該去檢查一下視力了。 他還跟林小婕交換了最近踩雷的外送名單,聊得像在做正式評鑑。";
const cleaned = sanitizeDiaryText(reported);
check("玩家案例：輸出最多四個完整句", splitNarrativeSentences(cleaned).length <= 4 && /[。！？]$/.test(cleaned), cleaned);
check("玩家案例：聊天進展不再總結三次", occurrences(cleaned, "聊天時的態度開始變得比較積極") === 1, cleaned);
check("玩家案例：視力句不會原文重複", occurrences(cleaned, "把書湊得很近又拉遠") === 1, cleaned);
check("玩家案例：ASCII 標點正規化", !cleaned.includes(",") && !cleaned.includes("聊天時態度"), cleaned);
check("玩家案例：修正聊天態度語序", cleaned.includes("他聊天時的態度") && !cleaned.includes("他的聊天時的態度"), cleaned);
check("玩家案例：保留不同的貓咪畫面", cleaned.includes("貓的照片"), cleaned);

const diverse = selectDiverseNarrativeLines([
  "把書湊得很近又拉遠，大概該檢查視力了。",
  "跟林小婕聊到工作。",
  "把書湊得很近又拉遠，大概該檢查視力了。",
  "外送到了，拆袋子的動作很期待。",
], 8);
check("來源片段：完全相同事件只留一次", diverse.length === 3 && occurrences(diverse.join("|"), "檢查視力") === 1, JSON.stringify(diverse));

const summary = sanitizeSummaryText("他開始主動聊天。整體來看，他開始主動聊天。他仍在適應新鄰居。總體來說，他開始主動聊天。");
check("滾動摘要：同義重述不會繼續餵回下一天", occurrences(summary, "開始主動聊天") === 1, summary);

const rt = Object.values(state.runtimes)[0];
rt.log.splice(0);
rt.tenant.recentSummary = "他喜歡和鄰居聊天。他喜歡和鄰居聊天。";
const now = state.gameMs;
rt.log.push(
  { gameMs: now - 3_600_000, timeLabel: "", text: "舊 AI 流水帳不該再被摘要", visualState: "idle", importance: "major", daily: true, ai: true },
  { gameMs: now - 3_000_000, timeLabel: "", text: "把書湊得很近又拉遠。", visualState: "idle", importance: "minor" },
  { gameMs: now - 2_000_000, timeLabel: "", text: "把書湊得很近又拉遠。", visualState: "idle", importance: "minor" },
  { gameMs: now - 1_000_000, timeLabel: "", text: "和鄰居交換外送名單。", visualState: "idle", importance: "notable" },
);
const ctx = buildNarrateCtx(rt, "測試日");
check("Context：排除上一份 AI 當日觀察", !ctx.todayLog.some((line) => line.includes("舊 AI 流水帳")), JSON.stringify(ctx.todayLog));
check("Context：同日重複片段先去重", ctx.todayLog.filter((line) => line.includes("把書湊得很近")).length === 1, JSON.stringify(ctx.todayLog));
check("Context：舊摘要進 prompt 前先去重", occurrences(ctx.summary, "喜歡和鄰居聊天") === 1, ctx.summary);

save();
const saved = JSON.parse(mem[SAVE_KEY]);
const savedRt = saved.runtimes[rt.tenant.id];
savedRt.log.push({ gameMs: now, timeLabel: "", text: reported, visualState: "idle", importance: "major", daily: true, ai: true });
mem[SAVE_KEY] = JSON.stringify(saved);
check("舊存檔：可重新載入", load());
const restoredDiary = state.runtimes[rt.tenant.id].log.at(-1)?.text ?? "";
check("舊存檔：既有 AI 當日觀察也會就地去重", splitNarrativeSentences(restoredDiary).length <= 4 && occurrences(restoredDiary, "把書湊得很近又拉遠") === 1, restoredDiary);

// --- 線上實測發現的品質漏洞(2026-07-16 煙霧測試):簡體混入、標點連用、reason 冗贅 ---
check("簡繁轉換:詞級歧義(泡面→泡麵)", toTraditional("深夜一個人吃泡面") === "深夜一個人吃泡麵");
check("簡繁轉換:字級白名單(说/这/猫/让/头)", toTraditional("他说这猫让人头疼") === "他說這貓讓人頭疼");
check("簡繁轉換:繁體原文不受影響", toTraditional("她把麵條分給了鄰居,後來一起看書。") === "她把麵條分給了鄰居,後來一起看書。");
const punct = sanitizeDiaryText("今天的她看起來不太好，。她早早就回房休息了。");
check("標點連用:「,。」收斂為「。」", punct.includes("不太好。") && !punct.includes("，。"), punct);
const reason = sanitizeReasonText("她们还是不放弃，她們還是繼續努力，她們還是不放棄。");
check("reason 閘門:轉繁 + 冗贅子句去重 + 去尾標點", reason.includes("她們還是不放棄") && occurrences(reason, "不放棄") === 1 && !/[。！？]$/.test(reason), reason);
check("reason 閘門:截 60 字", sanitizeReasonText("長".repeat(99)).length === 60);

// --- 玩家回報案例(2026-07-17):英文／拼音混入與中文姓名被羅馬化 ---
const mixedLanguage = "今天 Chen 家豪 的行為變得更加孤僻。他吃飯的方式很慢lane，看來是很享受這頓飯。";
const mixedCleaned = sanitizeDiaryText(mixedLanguage, ["陳家豪"]);
check("英語混入:羅馬化姓氏依中文姓名還原", mixedCleaned.includes("陳家豪的行為") && !mixedCleaned.includes("Chen"), mixedCleaned);
check("英語混入:未知英文單字移除並保留自然標點", mixedCleaned.includes("很慢，看來") && !/[A-Za-z]/.test(mixedCleaned), mixedCleaned);
check("英語混入:常見縮寫轉成中文", normalizeNarrativeLanguage("他用AI整理ASMR直播內容") === "他用人工智慧整理耳語直播內容");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
