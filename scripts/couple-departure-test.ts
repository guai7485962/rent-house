/**
 * 情侶離開節點測試(同居一起離開 + 未同居情侶思念劇情):
 *  A. 正向離開(圓夢/安居)時同居伴侶追隨一起走——兩人都離開、都進名冊、伴侶用 follow_partner 告別信。
 *  A2. 被趕走(強制請離)時同居者仍「轉正接手」房間留下——現行行為不變。
 *  B. 未同居情侶的留下方中等難過——當下情緒打擊 + sulk + 思念記憶,不打 satisfaction 永久值。
 *  分流:同居→A、未同居情侶→B、普通朋友(value≥50 非情侶)→原本的普通失落記憶。
 *  邏輯本身不使用 RNG;仍上固定 mulberry32 種子以防外圍機率系統擾動。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

let __seed = 20260723;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state } = await import("../src/store");
const { makeRuntime, tenants, gameDayIndex } = await import("../src/sim/gameState");
const { graduateFarewell, moveOut } = await import("../src/sim/tenancy");
const { relationships, pairKey } = await import("../src/sim/social");
const { classifyDeparture } = await import("../src/sim/legacy");
const { toTraditional } = await import("../src/sim/narrativeQuality");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const SIMP_RE = /[们过这么后来东乐话说觉别买卖钱贝见风飞车专业欢兴学随写垃圾还惊场满门问间闻阔]/;

// 全部清空,由測試完全掌控住戶/房間/關係(避免種子租客干擾)
const reset = () => {
  for (const k of Object.keys(state.runtimes)) delete state.runtimes[k];
  for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
  for (const k of Object.keys(state.cohabits)) delete state.cohabits[k];
  for (const k of Object.keys(relationships)) delete relationships[k];
  state.alumni.splice(0);
};

let seq = 0;
function spawn(roomNo: string, name: string, occupation: string): string {
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  const id = `cd_${seq++}`;
  seed.id = id; seed.name = name; seed.occupation = occupation;
  seed.coreTags = [{ id: "perfectionist", label: "[完美主義]", behaviorHint: "", acquiredAt: "", source: "ai_event", intensity: 1 }];
  seed.memoryTags = [];
  const rt = makeRuntime(seed, roomNo, 70, []);
  rt.moveInMs = state.gameMs - 5 * 24 * 3600 * 1000; // 假裝住了 5 天
  rt.tenant.recentSummary = `${name}總把公共區收拾得整整齊齊。`;
  state.runtimes[id] = rt;
  return id;
}
const couple = (a: string, b: string, value = 90) => { relationships[pairKey(a, b)] = { value, romantic: true, cohabitOffered: true }; };
const friend = (a: string, b: string, value = 60) => { relationships[pairKey(a, b)] = { value, romantic: false, cohabitOffered: false }; };

// =====================================================================
// A. 正向離開(圓夢)時同居伴侶追隨一起走
// =====================================================================
{
  reset();
  const H = spawn("301", "圓夢咖啡師", "咖啡師"); // 承租人(host),圓夢離開
  const G = spawn("301", "追隨愛人", "自由接案"); // 同居 guest,追隨離開
  state.occupancy.r301 = H;
  state.cohabits[G] = "r301";
  couple(H, G);
  const d0 = gameDayIndex();
  // host 圓夢:設一個已實現、今天到期的心願,graduateFarewell 才走圓夢信
  state.runtimes[H].wish = { id: "open_shop", progress: 100, fulfilledDay: d0 - 6, graduateDay: d0, announced: true } as any;
  // guest 也剛好有已實現心願 → 驗證仍優先用 follow_partner 語氣(不被自己的圓夢信蓋掉)
  state.runtimes[G].wish = { id: "open_shop", progress: 100, fulfilledDay: d0 - 6, graduateDay: d0, announced: true } as any;

  graduateFarewell(H, "圓夢離開:開一間屬於自己的小店");

  check("A:主離開者與同居伴侶都離開了", !state.runtimes[H] && !state.runtimes[G]);
  check("A:房間空出來(伴侶沒有轉正接手)", !state.occupancy.r301, JSON.stringify(state.occupancy));
  check("A:同居映射已清乾淨", !state.cohabits[G] && !state.cohabits[H]);

  const recH = state.alumni.find((a) => a.name === "圓夢咖啡師");
  const recG = state.alumni.find((a) => a.name === "追隨愛人");
  check("A:兩人都進歷任名冊", !!recH && !!recG);
  check("A:主離開者用圓夢告別信(提到開店)", !!recH?.farewell && recH.farewell.includes("開店"), recH?.farewell);
  check("A:伴侶離開原因歸為 follow_partner", !!recG && classifyDeparture(recG.reason) === "follow_partner", recG?.reason);
  check("A:伴侶用 follow_partner 告別信(非自己的圓夢信)", !!recG?.farewell && !recG.farewell.includes("開店") && recG.farewell.length > 20, recG?.farewell);
  check("A:伴侶告別信為繁體(無簡體、toTraditional 冪等)", !!recG?.farewell && !SIMP_RE.test(recG.farewell) && recG.farewell === toTraditional(recG.farewell));
  check("A:伴侶告別信摻入住了幾天", !!recG?.farewell && recG.farewell.includes("5 天"));
}

// =====================================================================
// A(反向:主離開者是同居 guest,伴侶是 host)——一樣兩人都走、房間空出
// =====================================================================
{
  reset();
  const Host = spawn("302", "留守房東緣", "上班族"); // host,是伴侶
  const Grad = spawn("302", "圓夢舞者", "舞者"); // 同居 guest,圓夢離開(主離開者)
  state.occupancy.r302 = Host;
  state.cohabits[Grad] = "r302";
  couple(Host, Grad);
  const d0 = gameDayIndex();
  state.runtimes[Grad].wish = { id: "stage_dream", progress: 100, fulfilledDay: d0 - 6, graduateDay: d0, announced: true } as any;

  graduateFarewell(Grad, "圓夢離開:站上一次正式的舞台");

  check("A反向:guest 圓夢離開,host 伴侶也一起走", !state.runtimes[Grad] && !state.runtimes[Host]);
  check("A反向:房間空出(host 沒被留下獨自承租)", !state.occupancy.r302);
  const recHost = state.alumni.find((a) => a.name === "留守房東緣");
  check("A反向:host 伴侶進名冊且歸 follow_partner", !!recHost && classifyDeparture(recHost.reason) === "follow_partner");
}

// =====================================================================
// A2. 被趕走(強制請離)時同居者仍轉正接手房間——現行行為不變
// =====================================================================
{
  reset();
  const Host = spawn("303", "被趕走的人", "上班族");
  const Mate = spawn("303", "接手同居者", "設計師");
  state.occupancy.r303 = Host;
  state.cohabits[Mate] = "r303";
  couple(Host, Mate);

  moveOut(Host, "遭房東強制請離");

  check("A2:被趕走者離開", !state.runtimes[Host]);
  check("A2:同居者轉正接手原房(現行不變)", state.occupancy.r303 === Mate && !state.cohabits[Mate] && state.runtimes[Mate]?.roomNo === "303");
  check("A2:轉正接手者留下,得普通失落記憶(未升級成思念)",
    state.runtimes[Mate].tenant.memoryTags.some((m) => m.label.includes("搬走了"))
    && !state.runtimes[Mate].tenant.memoryTags.some((m) => m.label.includes("思念")));
}

// =====================================================================
// B. 未同居情侶留下方中等難過 + 分流(情侶未同居→B、普通朋友→原失落)
// =====================================================================
{
  reset();
  const Stay = spawn("301", "難過的留下方", "工程師"); // 情侶、未同居 → B
  const Leave = spawn("302", "先走的戀人", "護理師"); // 主離開者
  const Pal = spawn("303", "好朋友旁觀", "老師"); // 普通朋友 value≥50 → 原失落
  state.occupancy.r301 = Stay;
  state.occupancy.r302 = Leave;
  state.occupancy.r303 = Pal;
  couple(Stay, Leave);
  friend(Pal, Leave, 60);

  const s = state.runtimes[Stay];
  s.tenant.stats.mood = 70;
  s.tenant.stats.stress = 30;
  s.satisfaction = 55;
  s.directive = null;
  const d0 = gameDayIndex();
  const sat0 = s.satisfaction;
  const palMood0 = state.runtimes[Pal].tenant.stats.mood;

  moveOut(Leave, "對居住品質長期不滿");

  check("B:留下方心情下降 13(夾值)", s.tenant.stats.mood === 57, `mood=${s.tenant.stats.mood}`);
  check("B:留下方壓力上升 12(夾值)", s.tenant.stats.stress === 42, `stress=${s.tenant.stats.stress}`);
  check("B:不打 satisfaction 永久值(可恢復)", s.satisfaction === sat0, `sat=${s.satisfaction}`);
  check("B:設 sulk 約 2 遊戲日", s.directive?.id === "sulk" && s.directive?.untilDay === d0 + 2, JSON.stringify(s.directive));
  const miss = s.tenant.memoryTags.find((m) => m.label.includes("思念"));
  check("B:留下方獲得思念記憶(含思念/難過字樣,餵 AI)",
    !!miss && miss.label.includes("先走的戀人") && (miss.behaviorHint.includes("思念") || miss.behaviorHint.includes("難過")), JSON.stringify(miss));
  check("B:留下方寫下 💔 思念類 major 日誌", s.log.some((e) => e.importance === "major" && e.text.includes("💔") && e.text.includes("思念")));

  const p = state.runtimes[Pal];
  check("分流:普通朋友維持原本普通失落記憶(非思念、無 sulk)",
    p.tenant.memoryTags.some((m) => m.label.includes("搬走了")) && !p.tenant.memoryTags.some((m) => m.label.includes("思念")) && !p.directive);
  check("分流:普通朋友心情不受中等打擊(維持原值)", p.tenant.stats.mood === palMood0, `mood=${p.tenant.stats.mood} vs ${palMood0}`);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
