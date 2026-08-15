/**
 * 2026-08-09 劇情弧本地種子目錄的測試。
 *
 * 要釘住的不變式:
 *   ① 資料健全:id 唯一、theme ≤14 字(對齊 AI 路徑的同一道上限)、stages 2~6、
 *      成長特質與 tone 都在白名單內、觸發條件只用得到的職業/標籤;
 *   ② 決定性:同輸入永遠同輸出,且**零 Math.random**(不擾動其他系統的 RNG 次序);
  *   ③ 分工:AI 主線(arc)與本地支線(sideArc)可並行,彼此不互改;
 *   ④ 全程:開弧 → 逐階段推進 → 落幕,會留下日誌、記憶、成長特質與心願加成。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { STORY_ARC_SEEDS } = await import("../src/content/storyArcs");
const localArc = await import("../src/sim/localArc");
const { ARC_TONE_PULSE } = await import("../src/sim/arcs");
const { GROWTH_TAGS } = await import("../src/sim/growth");
const { ARCHETYPES } = await import("../src/sim/recruit");
const { state } = await import("../src/store");
const { ROOM_ATTRIBUTES } = await import("../src/types");
void ROOM_ATTRIBUTES;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// ── ① 資料健全 ─────────────────────────────────────────────
check("種子至少 10 條", STORY_ARC_SEEDS.length >= 10, `實際 ${STORY_ARC_SEEDS.length}`);
check("id 唯一", new Set(STORY_ARC_SEEDS.map((s) => s.id)).size === STORY_ARC_SEEDS.length);
check("主題唯一", new Set(STORY_ARC_SEEDS.map((s) => s.theme)).size === STORY_ARC_SEEDS.length);
check("主題 2~14 字(與 sanitizeArcUpdate 給 AI 的上限一致)",
  STORY_ARC_SEEDS.every((s) => s.theme.length >= 2 && s.theme.length <= 14),
  STORY_ARC_SEEDS.filter((s) => s.theme.length > 14).map((s) => s.theme).join(" "));
check("每條 2~6 階段(與 sanitizeArcUpdate 的 maxStage 夾值一致)",
  STORY_ARC_SEEDS.every((s) => s.stages.length >= 2 && s.stages.length <= 6));
check("每階段都有 summary 與 line",
  STORY_ARC_SEEDS.every((s) => s.stages.every((st) => st.summary.length > 0 && st.line.length > 0)));
const TONES = new Set(Object.keys(ARC_TONE_PULSE.advance));
check("tone 只用白名單值(或 null)",
  STORY_ARC_SEEDS.every((s) => s.stages.every((st) => st.tone === null || TONES.has(st.tone))
    && TONES.has(s.conclude.tone)));
check("收束的成長特質都存在",
  STORY_ARC_SEEDS.every((s) => s.conclude.growthTag in GROWTH_TAGS));
const OCCUPATIONS = new Set(ARCHETYPES.map((a) => a.occupation));
check("職業條件都對得上實際存在的職業",
  STORY_ARC_SEEDS.every((s) => (s.occupations ?? []).every((o) => OCCUPATIONS.has(o))),
  STORY_ARC_SEEDS.flatMap((s) => (s.occupations ?? []).filter((o) => !OCCUPATIONS.has(o))).join(" "));
const TAGS = new Set(ARCHETYPES.flatMap((a) => a.coreTags.map((t) => t.id)));
check("標籤條件都對得上實際存在的核心標籤",
  STORY_ARC_SEEDS.every((s) => (s.tags ?? []).every((t) => TAGS.has(t))),
  STORY_ARC_SEEDS.flatMap((s) => (s.tags ?? []).filter((t) => !TAGS.has(t))).join(" "));
check("有不限條件的通用種子(任何職業都抽得到弧)",
  STORY_ARC_SEEDS.some((s) => !(s.occupations?.length) && !(s.tags?.length)));

// ── ② 決定性 + 零 RNG ───────────────────────────────────────
const rt = Object.values(state.runtimes)[0];
check("拿得到一位種子租客當受測對象", !!rt);

{
  let rngCalls = 0;
  const orig = Math.random;
  Math.random = () => { rngCalls++; return orig(); };
  const a = Array.from({ length: 40 }, (_, d) => localArc.pickSeedForDay(rt, d)?.id ?? "-");
  const b = Array.from({ length: 40 }, (_, d) => localArc.pickSeedForDay(rt, d)?.id ?? "-");
  Math.random = orig;
  check("同輸入同輸出(決定性)", a.join(",") === b.join(","));
  check("挑種子零 Math.random", rngCalls === 0, `實際呼叫 ${rngCalls} 次`);
  check("40 天內至少會開到一次弧", a.some((x) => x !== "-"), a.join(","));
  check("不是天天都開(要有呼吸)", a.filter((x) => x !== "-").length < 40);
}
check("已有 AI 主線仍可挑本地支線,且不撞主線題材", (() => {
  const backup = rt.arc;
  rt.arc = { id: "arc_ai_1", theme: "AI 的弧", stage: 1, maxStage: 3, summary: "" };
  const picked = Array.from({ length: 40 }, (_, d) => localArc.pickSeedForDay(rt, d)).filter(Boolean);
  rt.arc = backup;
  return picked.length > 0 && picked.every((s) => s!.theme !== "AI 的弧");
})());
check("每位租客都抽得到至少一條種子(沒有人永遠沒有劇情)",
  Object.values(state.runtimes).every((r) => localArc.eligibleSeeds(r).length > 0));

// ── ③ AI 主線不碰,但本地支線可並行 ──────────────────────────
{
  const backup = rt.arc;
  const sideBackup = rt.sideArc;
  rt.sideArc = null;
  rt.arc = { id: "arc_ai_2", theme: "AI 的弧", stage: 1, maxStage: 3, summary: "AI 寫的摘要" };
  const before = JSON.stringify(rt.arc);
  for (let d = 0; d < 30; d++) localArc.localArcPass();
  check("AI 開的弧(沒有 seedId)完全不動", JSON.stringify(rt.arc) === before);
  check("AI 主線存在時仍可並行本地支線", rt.sideArc === null || !!rt.sideArc.seedId);
  rt.arc = backup;
  rt.sideArc = sideBackup;
}

// ── ④ 完整流程:開弧 → 推進 → 落幕 ───────────────────────────
{
  const target = Object.values(state.runtimes)[1] ?? rt;
  target.arc = null;
  target.sideArc = null;
  const seed = STORY_ARC_SEEDS.find((s) => !(s.occupations?.length) && !(s.tags?.length))!;
  // 直接把弧擺成「剛開好的第 1 階段」,再用 localArcPass 一天一天推,不倚賴機率何時命中
  target.sideArc = {
    id: `${localArc.LOCAL_ARC_ID_PREFIX}${seed.id}_0`,
    theme: seed.theme, stage: 1, maxStage: seed.stages.length,
    summary: seed.stages[0].summary, seedId: seed.id, localDay: -99,
  };
  const logBefore = target.log.length;
  const stagesSeen: number[] = [];
  for (let i = 0; i < seed.stages.length + 3; i++) {
    localArc.localArcPass();
    if (target.sideArc) { stagesSeen.push(target.sideArc.stage); target.sideArc.localDay = -99; } // 讓下一輪立刻可推進
    else break;
  }
  check("逐階段推進到底", stagesSeen.length > 0 && stagesSeen[stagesSeen.length - 1] === seed.stages.length,
    stagesSeen.join(">"));
  check("推進不會跳階", stagesSeen.every((s, i) => i === 0 || s === stagesSeen[i - 1] + 1), stagesSeen.join(">"));
  localArc.localArcPass(); // 最後一步的下一個窗 → 落幕
  check("走完後落幕(sideArc 清空)", target.sideArc === null);
  check("落幕留下記憶", (target.tenant.memoryTags ?? []).some((m) => m.label === `[經歷:${seed.theme}]`));
  check("落幕留下日誌(篇章落幕)", target.log.slice(logBefore).some((e) => e.text.startsWith("📕 篇章落幕")));
  check("每一階段的旁白都進了日誌",
    seed.stages.slice(1).every((st) => target.log.some((e) => e.text === st.line)));
  check("同一條種子落幕後不會馬上重播(記憶擋下)",
    !localArc.eligibleSeeds(target).filter((s) => s.id === seed.id).length
      || Array.from({ length: 40 }, (_, d) => localArc.pickSeedForDay(target, d)?.id).every((id) => id !== seed.id));
}

{
  const target = Object.values(state.runtimes)[0];
  target.arc = null;
  target.sideArc = null;
  const seed = STORY_ARC_SEEDS.find((s) => !(s.occupations?.length) && !(s.tags?.length))!;
  target.sideArc = {
    id: `${localArc.LOCAL_ARC_ID_PREFIX}${seed.id}_0`,
    theme: seed.theme, stage: 1, maxStage: seed.stages.length,
    summary: seed.stages[0].summary, seedId: seed.id, localDay: 0,
  };
  const stageBefore = target.sideArc.stage;
  localArc.localArcPass();
  check("同一天不會連推兩步", target.sideArc?.stage === stageBefore);
}

{
  const target = Object.values(state.runtimes)[0];
  target.sideArc = null;
  // 舊存檔可能仍把本地弧放在 arc；在未經 load 的情境也要能安靜收掉。
  target.arc = {
    id: `${localArc.LOCAL_ARC_ID_PREFIX}gone_0`,
    theme: "已被刪掉的種子", stage: 1, maxStage: 3, summary: "", seedId: "arc_seed_不存在", localDay: -99,
  };
  localArc.localArcPass();
  check("種子被刪過的舊存檔:安靜收掉,不留殭屍弧", target.arc === null);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
