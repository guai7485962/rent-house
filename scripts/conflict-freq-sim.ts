/**
 * 衝突頻率實測(§10-2 衝突批的**量測**腳本)。
 *
 * 起因:使用者反映「要看到大打出手太難了」。專案原本**沒有任何腳本統計衝突頻率**
 * (`conflict-test.ts` 是條件矩陣單元測試、`balance-test.ts` 只快照最終數值、
 * `sim-trace.ts` 只做走位健全性),所以要調打架門檻之前,先補這一支用數據說話。
 *
 * 做法:固定種子 + 滿房 4 位租客 + 真的 `hourlyTick()` 迴圈跑 60 遊戲日,統計
 *   1. 口角(自然衝突)、冷戰、打架各幾次
 *   2. **漏斗計數**:`tryFight()` 的每個條件各擋掉幾次(rel<20 / tension≥70 / comp≤−3 /
 *      雙方 stress / 最終擲骰)——判斷瓶頸的直接證據
 *   3. **stress 分布**:各租客 min/mean/max,以及「兩人同時 ≥45/55/65/80」的小時數
 *   4. tension 的時間序列(最大/平均)
 *   5. 幾組候選門檻(合計 + 各自下限)分別能放行多少 pair-hour
 *
 * 三個情境跑同一組人與同一組作息,**只有壓力基準不同**(靠 `tick.baselines()` 認得的
 * 標籤字樣加值),用來分離「摩擦夠不夠」與「壓力到不到得了門檻」兩個問題:
 *   normal   基準 38/38/38/46 —— 標籤全部照抄 `recruit.ts` 的 ARCHETYPES
 *   stressed 基準 58/58/58/66 —— 多掛 [工作狂]+[社恐]
 *   extreme  基準 78/78/78/86 —— 再多掛 [截稿]+[敏感](天花板探測,不是常見局)
 * 加掛標籤的 id 刻意選 `compatibilityDetail()` 不看的(introvert/workaholic/…),
 * 三個情境的相容度矩陣**完全相同**。
 *
 * ⚠️ 漏斗是**影子評估**:`tryFight()` 在 `hourlyTick()` 內部被呼叫,ESM 匯出是唯讀
 * 綁定無法攔截,所以本腳本在每個 `hourlyTick()` **之後**用同一組純函式
 * (`getRel`/`compatibility`/`feudActive` + `stats.stress`)重算一次條件。socialPass
 * 之後只剩社交效果的小幅增量會動到這些值 ⇒ 量級判斷不受影響。
 * 影子漏斗數的是「**同框 pair-hour**」,不含 socialPass 每小時 0.55 的相遇擲骰,
 * 所以它是**機會數的上界**;真正的打架次數另外由 `fight_decision` 待決事件精確計數。
 *
 * 只印數字、不斷言 ⇒ 與 `cafe-growth-sim.ts` / `cafe-opening-sim.ts` 一樣
 * **刻意不列入回歸集**(檔名不是 `*-test.ts`,`run-all.ts` 的 REGRESSION 也沒有它)。
 *
 *   TZ=Asia/Taipei npx tsx scripts/conflict-freq-sim.ts              # 三個情境都跑
 *   TZ=Asia/Taipei npx tsx scripts/conflict-freq-sim.ts normal 60    # 單一情境
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["normal", "stressed", "extreme"] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const argScenario = process.argv[2] as ScenarioName | undefined;
const argDays = Number(process.argv[3] ?? 60);

// 沒指定情境 → 依序把自己 spawn 三次。三個情境共用一堆模組層的冷卻 Map
// (dirtyComplaintDay / cozyHomeDay / 貓咪筆記…),同一個 process 內連跑會互相汙染,
// 所以用子行程隔離,而不是就地重置。
if (!argScenario) {
  const self = fileURLToPath(import.meta.url);
  for (const name of SCENARIOS) {
    const r = spawnSync(process.execPath, ["--import", "tsx", self, name, String(argDays)], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  process.exit(0);
}

// 固定 RNG:量測要可重現,而且必須在 import 遊戲模組**之前**換掉(比照 sim-trace.ts)。
let seed = 20260817;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// persistence.save() 會寫 localStorage;無頭環境要先補一個記憶體版(比照 cafe-growth-sim.ts)。
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state } = await import("../src/sim/gameState");
const { hourlyTick, baselines } = await import("../src/sim/tick");
const { moveIn, decide } = await import("../src/sim/tenancy");
const { resolveGroupEvent } = await import("../src/sim/community");
const { resolveChainEvent } = await import("../src/sim/floorChain");
const { repairBreakdown } = await import("../src/sim/maintenance");
const { giveKindness } = await import("../src/sim/kindness");
const { getRel, compatibility, relationships } = await import("../src/sim/social");
const { feudActive } = await import("../src/sim/conflicts");
const { sessionFor } = await import("../src/floor/pairSession");
const { addPlacement } = await import("../src/sim/placements");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { randomAppearance } = await import("../src/pixel/parts");
import type { Applicant } from "../src/sim/recruit";

const DAYS = argDays;
const HOURS = DAYS * 24;

// ---------------------------------------------------------------------------
// 高摩擦滿房:6 組配對裡有 4 組 compatibility ≤ −3
// ---------------------------------------------------------------------------

/**
 * 相容標籤全部照抄 `recruit.ts` 的 ARCHETYPES(不自創),配對邏輯見 `social.ts` 的
 * `compatibilityDetail()`:噪音需求衝突 −3、作息相反 −2。
 *
 * 性別一律設成「男、只被女性吸引」⇒ 四人之間**不可能**發展戀愛線,讓量測只反映
 * 衝突管道,不被情侶/分手劇情汙染(comp<0 的配對本來就進不了戀愛,這裡是把
 * comp≥0 的那兩組也關掉)。
 */
interface Spec {
  room: string;
  id: string;
  name: string;
  archetypeKey: string;
  occupation: string;
  tags: { id: string; label: string }[];
  rent: number;
}

/** 只影響 `baselines()` 的壓力基準、不影響 `compatibilityDetail()` 的加掛標籤。 */
const STRESS_TAGS: Record<ScenarioName, { id: string; label: string }[]> = {
  normal: [],
  stressed: [
    { id: "workaholic", label: "[工作狂]" },   // baselines(): +12
    { id: "introvert", label: "[社恐]" },      // baselines(): +8
  ],
  extreme: [
    { id: "workaholic", label: "[工作狂]" },   // +12
    { id: "introvert", label: "[社恐]" },      // +8
    { id: "deadline", label: "[截稿地獄]" },   // +12
    { id: "delicate", label: "[敏感體質]" },   // +8
  ],
};

const SPECS: Spec[] = [
  // r303 / r304 是原本的空房,本腳本補上書桌讓四個人的 routineNeedsMet 接近,
  // 否則空房住戶滿意度長期偏低會在第 4 週左右退租,量不到 60 天。
  {
    room: "r303", id: "sim_drummer", name: "鼓手阿凱", archetypeKey: "student", occupation: "樂團鼓手",
    tags: [{ id: "noisy", label: "[製造噪音]" }, { id: "late_return", label: "[夜歸]" }], rent: 13000,
  },
  {
    room: "r304", id: "sim_gamer", name: "電競小豪", archetypeKey: "student", occupation: "電競系學生",
    tags: [{ id: "night_owl", label: "[夜貓子]" }, { id: "gamer", label: "[電競魂]" }], rent: 11000,
  },
  {
    room: "r301", id: "sim_yoga", name: "瑜伽阿哲", archetypeKey: "homebody", occupation: "瑜伽老師",
    tags: [{ id: "sound_sensitive", label: "[靜謐主義]" }, { id: "fitness", label: "[身心平衡]" }], rent: 13000,
  },
  {
    room: "r302", id: "sim_florist", name: "花藝阿文", archetypeKey: "early_riser", occupation: "花藝師",
    tags: [{ id: "early_bird", label: "[清晨批花]" }, { id: "perfectionist", label: "[構圖偏執]" }], rent: 12000,
  },
];

function applicantOf(s: Spec): Applicant {
  return {
    id: s.id,
    name: s.name,
    archetypeKey: s.archetypeKey,
    occupation: s.occupation,
    bio: `${s.occupation}。衝突頻率實測用的合成租客。`,
    coreTags: [...s.tags, ...STRESS_TAGS[argScenario]].map((t) => ({ ...t, behaviorHint: "" })),
    preferences: {},
    monthlyRent: s.rent,
    stars: 3,
    gender: "male",
    attractedTo: ["female"],
    appearance: randomAppearance(),
    isAdult: true,
  };
}

// 空房補書桌(student 作息有 desk 時段;交誼廳沒有書桌類家具)
addPlacement({ defId: "gaming_desk", room: "r303", c: 4, r: 16, rotation: 0 });
addPlacement({ defId: "gaming_desk", room: "r304", c: 10, r: 16, rotation: 0 });

// 清空種子局的兩位租客,換成 4 位高摩擦租客(種子局那對 compatibility 是 +2,量不到東西)
for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
for (const room of Object.keys(state.occupancy)) delete state.occupancy[room];
for (const key of Object.keys(relationships)) delete relationships[key];
state.money = 5_000_000; // 只量衝突,不讓「沒錢修繕」變成隱藏變因

/**
 * 房間 → 現任租客。**所有統計都以房間為鍵**,因為 `wishes.SETTLE_TENURE_DAYS`(20 日)
 * 會讓模範房客「安居期滿圓滿搬離」——實測第 29 日就走掉兩位。真實遊戲就是會換人,
 * 所以本腳本照做:一有空房就用**同一份人設**再招一位進來(id 換代號),量測涵蓋換房客,
 * 只是新住戶的 rel/tension 從 0 重來(這本身就是「打架難見」的成因之一)。
 */
const ROOMS = SPECS.map((s) => s.room);
const SPEC_OF = new Map(SPECS.map((s) => [s.room, s]));
let generation = 1;
const turnover: string[] = [];

function fillRoom(room: string) {
  const s = SPEC_OF.get(room)!;
  const ap = applicantOf(s);
  ap.id = generation === 1 ? s.id : `${s.id}_g${generation}`;
  ap.name = generation === 1 ? s.name : `${s.name}${generation}`;
  moveIn(room, ap);
}
const rtOf = (room: string) => state.runtimes[state.occupancy[room]];
const nameOf = (room: string) => rtOf(room)?.tenant.name ?? room;

for (const room of ROOMS) fillRoom(room);
state.activeId = state.occupancy[ROOMS[0]];

const PAIRS: [string, string][] = [];
for (let i = 0; i < ROOMS.length; i++) for (let j = i + 1; j < ROOMS.length; j++) PAIRS.push([ROOMS[i], ROOMS[j]]);

console.log(`\n${"=".repeat(78)}`);
console.log(`=== 衝突頻率實測 [${argScenario}] ${DAYS} 遊戲日 × 4 人滿房(固定種子 20260817)`);
console.log(`${"=".repeat(78)}`);
console.log("配對相容度(≤ −3 才可能打架)與壓力基準:");
for (const [a, b] of PAIRS) {
  const comp = compatibility(rtOf(a).tenant, rtOf(b).tenant);
  console.log(`  ${nameOf(a)} × ${nameOf(b)}  comp = ${comp >= 0 ? "+" : ""}${comp}${comp <= -3 ? "  ✅ 可能打架" : ""}`);
}
const BASE_STRESS = new Map(ROOMS.map((room) => [room, baselines(rtOf(room)).stress]));
for (const room of ROOMS) {
  console.log(`  ${nameOf(room).padEnd(8)} 壓力基準 ${BASE_STRESS.get(room)!.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 統計容器
// ---------------------------------------------------------------------------

const STRESS_LEVELS = [45, 55, 65, 80];
/** 影子漏斗的候選門檻:[合計, 各自下限] */
const SUM_GATES: [number, number][] = [
  [110, 45], [110, 50], [100, 45], [90, 40], [80, 35], [70, 30], [60, 25], [50, 20],
];

const funnel = {
  coLoungePairHours: 0,   // 兩人同時在交誼廳、都沒有待決事件、且非冷戰中
  passRel: 0,             // 通過 rel < 20
  passTension: 0,         // 再通過 tension >= 70
  passComp: 0,            // 再通過 comp <= -3
  passStress80: 0,        // 再通過「雙方 stress >= 80」(現行門檻)
  blockedByFeud: 0,       // 冷戰中,socialPass 先擋掉、根本沒進候選
};
const gateHits = new Map<string, number>(SUM_GATES.map(([s, e]) => [`${s}/${e}`, 0]));
/** 過了 rel/tension/comp 三關的 pair-hour,其(較低者 stress、合計 stress) */
const reachedStressGate: { min: number; sum: number }[] = [];

const stressSeries = new Map<string, number[]>(ROOMS.map((room) => [room, []]));
const bothAtLeast = new Map<number, number>(STRESS_LEVELS.map((n) => [n, 0]));
const bothAtLeastInLounge = new Map<number, number>(STRESS_LEVELS.map((n) => [n, 0]));
const tensionSeries: number[] = [];
const tensionMaxByPair = new Map<string, number>();

let fights = 0;
let allConflicts = 0;
let feudsStarted = 0;
let prevConflictCount = 0;
let groupEventsResolved = 0;
let repairs = 0;
let kindnesses = 0;
let maxPairSum = 0;
let maxPairMin = 0;
/** 打架當下兩位租客的 sprite 有沒有真的並肩站好(4-鄰接)。 */
let adjacencyOk = 0;
let adjacencyBad = 0;
let adjacencyEver = 0;
let sessionStomped = 0;
/** 被蓋掉的細分:另一方已經在**下一場打架**裡(同小時第二場;每日上限是 2)。
 *  這一種不是「一般相遇搶走演出」,擋不掉——兩場打架搶同一個人,總有一場演不成。 */
let stompedByFight = 0;
let pathfindMiss = 0;
const adjacencyMisses: string[] = [];
const satisfactionSeries = new Map<string, number[]>(ROOMS.map((room) => [room, []]));
const activeFeuds = new Set<string>();
const fightLog: string[] = [];
/** 每場打架的日期與配對(用來算「同一對的間隔」,驗證自我抑制)。 */
const fightEvents: { day: number; aId: string; bId: string; pair: string }[] = [];
const decisionsTaken = new Map<string, number>();

const CONFLICT_COUNT_KEY = "social_conflicts_day_count";

// ---------------------------------------------------------------------------
// 演出層:真的跑 agent 走位,驗證打架時兩人會並肩站好
// ---------------------------------------------------------------------------

/**
 * 「打架看得見」的最後一哩:`fight` 雲的錨點與兩人的走位是**各自獨立**的,
 * 萬一有一方沒走到 session 指定的格,畫面會變成「雲在中間、兩人分開站」。
 * 所以本腳本連 agent 層一起跑(比照 `sim-trace.ts`:tick 到全部靜止),
 * 打架成立的那一小時就量兩人的最終格是不是 4-鄰接。
 *
 * ⚠️ agent／pathfind／pairSession／fx 這幾個模組**完全沒有 `Math.random()`**(已掃碼確認),
 * 所以加跑走位**不會動到亂數序列**,打架次數與不跑走位時逐場相同。
 */
const AGENT_DT = 0.1;
/** 打架 session 只活 **15 現實秒**(`conflicts.tryFight` 的 durationMs);
 *  0.1 秒一個 tick ⇒ 150 tick 就是玩家實際看得到演出的整個窗口。多跑也沒有意義。 */
const AGENT_MAX_TICKS = 150;
let agents = createAgents();

/**
 * 跑走位到全部靜止(或跑滿 session 的 15 秒)。
 * `watch` 有值時,逐 tick 記錄那兩位有沒有 4-鄰接過——因為玩家看的是**整段演出**,
 * 不是最後一幀:中途站到一起過就代表畫面成立。
 */
function settleAgents(watches: { aId: string; bId: string }[] = []): Set<string> {
  const ever = new Set<string>(); // 同一小時可能有兩場打架(每日上限是 2)
  const sample = () => {
    for (const w of watches) {
      const key = `${w.aId}|${w.bId}`;
      if (ever.has(key)) continue;
      const ga = agents.find((x) => x.tenantId === w.aId);
      const gb = agents.find((x) => x.tenantId === w.bId);
      if (!ga || !gb || ga.hidden || gb.hidden) continue;
      if (Math.abs(ga.c - gb.c) + Math.abs(ga.r - gb.r) === 1) ever.add(key);
    }
  };
  tickAgents(agents, AGENT_DT); // 先觸發本小時的重新尋路
  sample();
  for (let i = 0; i < AGENT_MAX_TICKS && agents.some((a) => !a.hidden && a.moving); i++) {
    tickAgents(agents, AGENT_DT);
    sample();
  }
  return ever;
}

/**
 * 打架成立 → 兩人的 sprite 是否 4-鄰接(上下左右相鄰,不含對角、不含疊格)。
 *
 * 沒對上時要能分辨**兩種完全不同的成因**,否則會誤判成走位問題:
 *   (a) session 還在(pose 仍是 scuffle)但人沒走到 → 走位/擁擠(pathfind 的範圍)
 *   (b) session 已經被別的系統蓋掉(pose 變成 apart/其他,或整個消失)
 *       → 同一小時內 `socialPass` 後面的流程搶走了演出,與走位無關
 *
 * 2026-08-17:(b) 的一般相遇那半已由 `startPairSession()` 的 scuffle 守衛擋掉(實測歸零);
 * 只剩「同小時第二場打架接手」擋不掉(兩場打架搶同一個人),另計 `stompedByFight`。
 */
function checkAdjacency(aTenantId: string, bTenantId: string, day: number, hour: number, everAdjacent: boolean) {
  if (everAdjacent) adjacencyEver += 1;
  const ga = agents.find((x) => x.tenantId === aTenantId);
  const gb = agents.find((x) => x.tenantId === bTenantId);
  const sa = sessionFor(aTenantId, state.gameMs);
  const sb = sessionFor(bTenantId, state.gameMs);
  const poses = `pose A=${sa?.pose ?? "無"} B=${sb?.pose ?? "無"}`;
  if (!ga || !gb || ga.hidden || gb.hidden) {
    adjacencyBad += 1;
    adjacencyMisses.push(`第 ${day} 日 ${hour} 點:有一方沒有 sprite(hidden);${poses}`);
    return;
  }
  const dist = Math.abs(ga.c - gb.c) + Math.abs(ga.r - gb.r);
  if (dist === 1) {
    adjacencyOk += 1;
    return;
  }
  adjacencyBad += 1;
  const stomped = sa?.pose !== "scuffle" || sb?.pose !== "scuffle";
  const byFight = stomped && (sa?.pose === "scuffle" || sb?.pose === "scuffle");
  if (stomped) { sessionStomped += 1; if (byFight) stompedByFight += 1; } else pathfindMiss += 1;
  adjacencyMisses.push(
    `第 ${day} 日 ${hour} 點:距離 ${dist} A(${ga.c},${ga.r}) B(${gb.c},${gb.r})`
    + `;錨點 A(${sa?.tile.c},${sa?.tile.r}) B(${sb?.tile.c},${sb?.tile.r});${poses}`
    + `;moving A=${ga.moving} B=${gb.moving};goal A(${ga.goal?.c},${ga.goal?.r}) B(${gb.goal?.c},${gb.goal?.r})`
    + `;${stomped ? "**session 被蓋掉**" : "session 還在 ⇒ 走位沒到位"}`,
  );
}

// ---------------------------------------------------------------------------
// 主迴圈
// ---------------------------------------------------------------------------

for (let h = 0; h < HOURS; h++) {
  hourlyTick();

  // --- 1) 打架:tryFight 一定會掛上 fight_decision 待決事件 ⇒ 精確計數 ---
  const day = Math.floor(h / 24) + 1;
  const watches: { aId: string; bId: string }[] = [];
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (rt?.pendingEvent?.id === "fight_decision") {
      fights += 1;
      fightLog.push(`第 ${day} 日 ${h % 24} 點  ${rt.tenant.name} × ${rt.pendingEvent.withName ?? "?"}`);
      fightEvents.push({ day, aId: rt.tenant.id, bId: rt.pendingEvent.withId ?? "", pair: `${rt.tenant.name}×${rt.pendingEvent.withName ?? "?"}` });
      if (rt.pendingEvent.withId) watches.push({ aId: rt.tenant.id, bId: rt.pendingEvent.withId });
    }
  }
  // 演出層:讓 sprite 走到本小時的目標(打架時 = session 指定的相鄰兩格)
  const everAdjacent = settleAgents(watches);
  for (const w of watches) checkAdjacency(w.aId, w.bId, day, h % 24, everAdjacent.has(`${w.aId}|${w.bId}`));

  // --- 2) 衝突計數器(自然口角 + 打架都會 +1),每日歸零 ---
  const cur = state.interactionCooldowns[CONFLICT_COUNT_KEY] ?? 0;
  allConflicts += cur >= prevConflictCount ? cur - prevConflictCount : cur;
  prevConflictCount = cur;

  // --- 3) 冷戰:新登記的 pairKey ---
  for (const key of Object.keys(state.feuds)) {
    if (!activeFeuds.has(key)) {
      activeFeuds.add(key);
      feudsStarted += 1;
    }
  }
  for (const key of [...activeFeuds]) if (!state.feuds[key]) activeFeuds.delete(key);

  // --- 4) 房東抉擇:沒有玩家就會把租客凍住,一律用固定規則拍板(不擲骰) ---
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (!rt?.pendingEvent) continue;
    // 打架抉擇固定選「各打五十大板」:冷戰**繼續**,是三個選項裡最保守的
    // (選「調解」會直接解除冷戰 ⇒ 打架間隔變短,會把頻率量高)。
    const choiceId = rt.pendingEvent.id === "fight_decision" ? "scold_both" : rt.pendingEvent.choices[0].id;
    const label = rt.pendingEvent.choices.find((c) => c.id === choiceId)?.label ?? "";
    decisionsTaken.set(rt.pendingEvent.id, (decisionsTaken.get(rt.pendingEvent.id) ?? 0) + 1);
    decide(rt.tenant.id, choiceId, label);
  }
  if (state.pendingGroupEvent) {
    resolveGroupEvent(state.pendingGroupEvent.choices[0].id);
    groupEventsResolved += 1;
  }
  if (state.pendingChainEvent) resolveChainEvent(state.pendingChainEvent.choices[0].id);
  if (state.pendingCohabit) state.pendingCohabit = null; // 四人互不吸引,理論上不會發生

  // --- 5) 房東有在管:故障當天就修 + 不滿意的租客送宵夜 ---
  // 兩個動作都是遊戲內既有的玩家行為(`repairBreakdown` / `giveKindness`)、零 RNG,
  // 只補心情與好感,**不直接改 stress**(所以用「送宵夜」而不是壓力 −5 的「塞紙條」),
  // 避免「房東完全不管」造成的退租把 60 天的量測截斷。
  for (const roomId of Object.keys(state.breakdowns)) {
    if (repairBreakdown(roomId).ok) repairs += 1;
  }
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (rt && rt.satisfaction < 45 && giveKindness(rt.tenant.id, "snack").ok) kindnesses += 1;
  }

  // --- 6) 有人離開就立刻招同一份人設進來(安居期滿 20 日必定發生,見上面註解)---
  const vacant = ROOMS.filter((room) => !rtOf(room));
  if (vacant.length > 0) {
    generation += 1;
    // alumni 最新在前;同一小時可能走掉多位,取最近 vacant.length 筆(順序不保證對應房號)
    for (const last of state.alumni.slice(0, vacant.length)) {
      turnover.push(`第 ${Math.floor(h / 24) + 1} 日  ${last.name} 住了 ${last.daysLived} 日 — ${last.reason}`);
    }
    for (const room of vacant) fillRoom(room);
    agents = createAgents(); // 換人 ⇒ 舊的 agent 陣列還指著已離開的 tenantId
  }

  // --- 7) stress 分布 ---
  for (const room of ROOMS) {
    stressSeries.get(room)!.push(rtOf(room).tenant.stats.stress);
    satisfactionSeries.get(room)!.push(rtOf(room).satisfaction);
  }
  for (const [a, b] of PAIRS) {
    maxPairSum = Math.max(maxPairSum, rtOf(a).tenant.stats.stress + rtOf(b).tenant.stats.stress);
    maxPairMin = Math.max(maxPairMin, Math.min(rtOf(a).tenant.stats.stress, rtOf(b).tenant.stats.stress));
  }
  for (const n of STRESS_LEVELS) {
    const both = ([a, b]: [string, string]) =>
      rtOf(a).tenant.stats.stress >= n && rtOf(b).tenant.stats.stress >= n;
    if (PAIRS.some(both)) bothAtLeast.set(n, bothAtLeast.get(n)! + 1);
    if (PAIRS.some((p) => both(p) && rtOf(p[0]).inLounge && rtOf(p[1]).inLounge)) {
      bothAtLeastInLounge.set(n, bothAtLeastInLounge.get(n)! + 1);
    }
  }

  // --- 8) tension ---
  for (const [a, b] of PAIRS) {
    const t = getRel(rtOf(a).tenant.id, rtOf(b).tenant.id)?.tension ?? 0;
    tensionSeries.push(t);
    const key = `${SPEC_OF.get(a)!.name}×${SPEC_OF.get(b)!.name}`;
    tensionMaxByPair.set(key, Math.max(tensionMaxByPair.get(key) ?? 0, t));
  }

  // --- 9) 影子漏斗(同框 pair-hour;條件順序照 tryFight)---
  for (const [ra, rb] of PAIRS) {
    const A = rtOf(ra);
    const B = rtOf(rb);
    const a = A.tenant.id;
    const b = B.tenant.id;
    if (!A.inLounge || !B.inLounge) continue;
    if (A.pendingEvent || B.pendingEvent) continue;
    if (feudActive(a, b)) { funnel.blockedByFeud += 1; continue; }
    funnel.coLoungePairHours += 1;
    const rel = getRel(a, b);
    if ((rel?.value ?? 0) >= 20) continue;
    funnel.passRel += 1;
    if ((rel?.tension ?? 0) < 70) continue;
    funnel.passTension += 1;
    if (compatibility(A.tenant, B.tenant) > -3) continue;
    funnel.passComp += 1;
    const sa = A.tenant.stats.stress;
    const sb = B.tenant.stats.stress;
    reachedStressGate.push({ min: Math.min(sa, sb), sum: sa + sb });
    for (const [sum, each] of SUM_GATES) {
      if (Math.min(sa, sb) >= each && sa + sb >= sum) gateHits.set(`${sum}/${each}`, gateHits.get(`${sum}/${each}`)! + 1);
    }
    if (sa < 80 || sb < 80) continue;
    funnel.passStress80 += 1;
  }
}

// ---------------------------------------------------------------------------
// 報表
// ---------------------------------------------------------------------------

const hoursRun = stressSeries.get(ROOMS[0])!.length;
const daysRun = hoursRun / 24;
const stat = (arr: number[]) => ({
  min: Math.min(...arr),
  mean: arr.reduce((s, v) => s + v, 0) / arr.length,
  max: Math.max(...arr),
});
const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
/** socialPass 每小時 0.55 才相遇 × tryFight 最後 rng()<=0.6 才真的打 */
const ROLL_FACTOR = 0.55 * 0.6;

console.log(`\n--- 1) 衝突次數(實跑 ${daysRun.toFixed(1)} 遊戲日 / ${hoursRun} 小時)---`);
const quarrels = allConflicts - fights;
console.log(`  自然口角:${quarrels} 次(約每 ${quarrels ? (daysRun / quarrels).toFixed(1) : "∞"} 遊戲日一次)`);
console.log(`  冷戰    :${feudsStarted} 次`);
console.log(`  🥊 打架 :${fights} 次`);
for (const line of fightLog) console.log(`      ${line}`);
console.log(`  換房客:${turnover.length} 次(安居期滿 20 日/圓夢畢業;每換一次 rel/tension 從 0 重來)`);
for (const line of turnover) console.log(`      ${line}`);

// --- 1b) 自我抑制:同一對兩次打架至少要隔 3 遊戲日(冷戰 3 日 + 打完 stress −15)---
console.log(`\n--- 1b) 自我抑制:同一對打架的間隔 ---`);
const byPair = new Map<string, number[]>();
for (const ev of fightEvents) {
  const key = [ev.aId, ev.bId].sort().join("|");
  if (!byPair.has(key)) byPair.set(key, []);
  byPair.get(key)!.push(ev.day);
}
let minGap = Infinity;
let violations = 0;
for (const [key, days] of byPair) {
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  for (const g of gaps) {
    minGap = Math.min(minGap, g);
    if (g < 3) violations += 1;
  }
  const label = fightEvents.find((e) => [e.aId, e.bId].sort().join("|") === key)!.pair;
  console.log(`  ${label.padEnd(24)} ${days.length} 場,日期 ${days.join("/")}${gaps.length ? `,間隔 ${gaps.join("/")} 日` : ""}`);
}
console.log(`  最短間隔:${minGap === Infinity ? "—(沒有同一對打第二次)" : `${minGap} 遊戲日`};`
  + `間隔 <3 日的違規:**${violations}** 次`);
const fightDays = new Set(fightEvents.map((e) => e.day));
console.log(`  打架分佈在 ${fightDays.size} 個不同的遊戲日(共 ${fights} 場)⇒ ${fights > 0 ? (fights / fightDays.size).toFixed(2) : "0"} 場/日`);

// --- 1c) 演出層:打架時兩人的 sprite 有沒有並肩站好 ---
const adjTotal = adjacencyOk + adjacencyBad;
console.log(`\n--- 1c) 演出層:打架當下兩人 sprite 是否 4-鄰接 ---`);
console.log(`  相鄰 ${adjacencyOk} / ${adjTotal}`
  + `${adjTotal > 0 ? `(${(adjacencyOk / adjTotal * 100).toFixed(1)}%)` : ""};沒對上 ${adjacencyBad}`
  + `(其中 session 被別的系統蓋掉 ${sessionStomped}[同小時第二場打架接手 ${stompedByFight}]`
  + `、session 還在但走位沒到位 ${pathfindMiss})`);
console.log(`  演出期間(15 現實秒)**曾經**相鄰過:${adjacencyEver} / ${adjTotal}` + (adjTotal > 0 ? `(${(adjacencyEver / adjTotal * 100).toFixed(1)}%)` : ""));
for (const line of adjacencyMisses.slice(0, 10)) console.log(`      ⚠ ${line}`);

console.log(`\n--- 2) tryFight 漏斗(同框 pair-hour;不含 socialPass 每小時 0.55 的相遇擲骰)---`);
const step = (label: string, before: number, after: number) =>
  console.log(`  ${label.padEnd(26)} 進入 ${String(before).padStart(6)} → 通過 ${String(after).padStart(6)}  (擋掉 ${String(before - after).padStart(6)})`);
console.log(`  冷戰中而未進候選(socialPass 先擋):${funnel.blockedByFeud} pair-hour`);
step("① rel < 20", funnel.coLoungePairHours, funnel.passRel);
step("② tension >= 70", funnel.passRel, funnel.passTension);
step("③ comp <= -3", funnel.passTension, funnel.passComp);
step("④ 雙方 stress >= 80(現行)", funnel.passComp, funnel.passStress80);
console.log(`  ⑤ 相遇 0.55 × 擲骰 0.6 ⇒ 現行門檻期望打架 ${(funnel.passStress80 * ROLL_FACTOR).toFixed(2)} 場 / ${daysRun.toFixed(0)} 日`);

console.log(`\n--- 2b) 走到 stress 這關的 ${reachedStressGate.length} 個 pair-hour,壓力長什麼樣 ---`);
if (reachedStressGate.length > 0) {
  const mins = reachedStressGate.map((x) => x.min);
  const sums = reachedStressGate.map((x) => x.sum);
  const sm = stat(mins);
  const ss = stat(sums);
  console.log(`  較低者 stress:min ${sm.min.toFixed(1)} / p50 ${pct(mins, 0.5).toFixed(1)} / p90 ${pct(mins, 0.9).toFixed(1)} / p99 ${pct(mins, 0.99).toFixed(1)} / max ${sm.max.toFixed(1)}(mean ${sm.mean.toFixed(1)})`);
  console.log(`  合計   stress:min ${ss.min.toFixed(1)} / p50 ${pct(sums, 0.5).toFixed(1)} / p90 ${pct(sums, 0.9).toFixed(1)} / p99 ${pct(sums, 0.99).toFixed(1)} / max ${ss.max.toFixed(1)}(mean ${ss.mean.toFixed(1)})`);
  console.log("  候選門檻(合計/各自)能放行幾個 pair-hour → 期望打架場數:");
  for (const [sum, each] of SUM_GATES) {
    const n = gateHits.get(`${sum}/${each}`)!;
    console.log(`    合計 ≥${String(sum).padStart(3)} 且各 ≥${String(each).padStart(2)}   ${String(n).padStart(5)} / ${reachedStressGate.length}`
      + `   ⇒ 期望 ${(n * ROLL_FACTOR).toFixed(2)} 場 / ${daysRun.toFixed(0)} 日`);
  }
} else {
  console.log("  (沒有任何 pair-hour 走到這一關 ⇒ 瓶頸在 stress **之前**)");
}

console.log(`\n--- 3) stress 分布 ---`);
for (const room of ROOMS) {
  const s = stat(stressSeries.get(room)!);
  console.log(`  ${SPEC_OF.get(room)!.name.padEnd(8)} 基準 ${BASE_STRESS.get(room)!.toFixed(0).padStart(3)}`
    + `  min ${s.min.toFixed(1).padStart(6)}  mean ${s.mean.toFixed(1).padStart(6)}  max ${s.max.toFixed(1).padStart(6)}`
    + `   |  滿意度 mean ${stat(satisfactionSeries.get(room)!).mean.toFixed(1).padStart(5)}`);
}
console.log(`  全程任一配對的**最高**「較低者 stress」= ${maxPairMin.toFixed(1)};最高「合計 stress」= ${maxPairSum.toFixed(1)}`);
console.log("  「至少一組配對兩人同時 ≥N」的小時數:");
for (const n of STRESS_LEVELS) {
  const all = bothAtLeast.get(n)!;
  const lounge = bothAtLeastInLounge.get(n)!;
  console.log(`    ≥${String(n).padStart(2)}  ${String(all).padStart(5)} / ${hoursRun} 小時(${(all / hoursRun * 100).toFixed(1)}%)`
    + `   其中兩人同時在交誼廳:${String(lounge).padStart(4)} 小時`);
}

console.log(`\n--- 4) tension ---`);
const ts = stat(tensionSeries);
console.log(`  全配對逐時 tension:min ${ts.min.toFixed(1)} / mean ${ts.mean.toFixed(1)} / max ${ts.max.toFixed(1)}`);
for (const [key, max] of tensionMaxByPair) console.log(`    ${key.padEnd(22)} 最高 ${max.toFixed(1)}`);

console.log(`\n--- 5) 其他 ---`);
console.log(`  自動拍板的房東抉擇:${[...decisionsTaken].map(([k, v]) => `${k}×${v}`).join("、") || "無"}`);
console.log(`  自動拍板的全樓群體事件:${groupEventsResolved} 件;當日修繕 ${repairs} 次;送宵夜 ${kindnesses} 次`);
console.log("\n本腳本只量,不反過來調參數。");
