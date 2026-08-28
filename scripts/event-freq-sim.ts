/**
 * 規則事件觸發頻率實測(`rollEvent()` 復活批的**量測**腳本)。
 *
 * 起因:`data/events.json` 的四則根事件(breakdown/sick/dissatisfied/grievance)實測
 * **從來沒觸發過**,三則續集(sick_aftermath/stress_aftermath/promise_due)因此是死碼。
 * 病根不是門檻太高,而是「房東虧待房客」在遊戲裡**沒有任何持續推動數值的管道**——
 * 所有懲罰都是脈衝,而 stress/wellbeing/satisfaction/affinity 四條數值全部有回歸,
 * 脈衝會被抹平。要改係數之前,先用這一支把「四條數值實際走到哪」量出來。
 *
 * 做法比照 `conflict-freq-sim.ts` / `interaction-freq-sim.ts` 的既有慣例:
 *   - 固定種子,而且必須在 import 遊戲模組**之前**換掉 `Math.random`
 *   - 記憶體版 localStorage(persistence.save() 會寫)
 *   - 子行程隔離每一個(種子 × policy × 情境):模組層的冷卻 Map 會跨情境汙染
 *   - **只印數字、不斷言、不進 `run-all.ts` 的 REGRESSION**
 *
 * 🔴 兩組房東行為(現有腳本最大的量測盲點):`conflict-freq-sim.ts` 內建的是**模範房東**
 * (每小時全修 + 送宵夜),用它量本批等於白量——每小時全修 ⇒ 虧待度恆為 0;
 * snack 的 affinity +4/日 ⇒ 完全蓋過虧待造成的每日流失。所以這裡跑兩組:
 *   caring  當日全修 + satisfaction<45 送宵夜 + 抉擇取第一項 → 上界(照顧好就該安靜)
 *   lax     拖 5 日才修、不送宵夜、抉擇同 absent → 拖延型房東(唯一能量到完整事件鏈的一組)
 *   absent  不修 + 不送 + 抉擇取最後一項(白名單例外見 CHOICE_OVERRIDE)→ 下界(碰不碰得到)
 *
 * 🔴 `absent` 的抉擇不能盲取最後一項:`grievance` 的最後一項是 `evict`(會把租客趕走、
 * 截斷量測),`rent_plea` 的最後一項是 `forgive`(affinity +14,和「放牛吃草」自相矛盾),
 * 而 `dissatisfied` 的最後一項 `ignore` **不會留下 `答應改善房間` 旗標** ⇒ `promise_due`
 * 這一則永遠量不到。三者都寫進 CHOICE_OVERRIDE。
 *
 * 🔴 為什麼要有第三組 `lax`:`sick_aftermath` 的 `wellbeing >= 60` **只在玩家修好之後**
 * 才爬得到(繼續不修時爬升速率恰為 0,敘事上正確)。`caring` 從不留旗標(取第一項 =
 * 帶去看醫生)、`absent` 從不修 ⇒ 兩組都量不到這一則,而「三則續集是否 > 0」是本批
 * 「事件鏈真的活了」的唯一硬指標。`lax` 才是真實玩家(會拖、但最後會修)。
 *
 * 情境維度沿用 `conflict-freq-sim.ts` 的 STRESS_TAGS:breakdown 的可達性直接綁在
 * `baselines().stress` 上,只跑 normal 會得到「還是零」的假結論。
 *
 *   TZ=Asia/Taipei npx tsx scripts/event-freq-sim.ts            # 5 種子 × 2 policy × 3 情境 × 60 日
 *   TZ=Asia/Taipei npx tsx scripts/event-freq-sim.ts 30 2       # 自訂天數/種子數
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCENARIOS = ["normal", "stressed", "extreme"] as const;
const POLICIES = ["caring", "lax", "absent"] as const;
/**
 * `lax` 在故障擱置幾個遊戲日之後才修(拖延型房東)。
 * 刻意 **> NEGLECT_CAP(6)**:虧待度要先真的到頂、把租客推進事件裡,玩家才動手修,
 * 這樣才走得完 `sick →(讓他自己休養)→ 修好 → wellbeing 回到 60 → sick_aftermath` 整條鏈。
 * 設 5 的話虧待度封頂在 4,`sick` 幾乎不觸發,續集當然也量不到。
 */
const LAX_REPAIR_AFTER_DAYS = 8;
type ScenarioName = (typeof SCENARIOS)[number];
type PolicyName = (typeof POLICIES)[number];

const DAYS = Number(process.argv[2] ?? 60);
const SEED_COUNT = Number(process.argv[3] ?? 5);
const BASE_SEED = 20260827;

const CHILD_SEED = process.env.RENT_EVT_SEED;
const CHILD_POLICY = process.env.RENT_EVT_POLICY as PolicyName | undefined;
const CHILD_SCENARIO = process.env.RENT_EVT_SCENARIO as ScenarioName | undefined;

/** 直方圖:index = 四捨五入後的整數值。父行程把子行程的直方圖逐格相加 ⇒ 百分位是精確的。 */
type Hist = number[];
interface Child {
  policy: PolicyName;
  scenario: ScenarioName;
  seed: number;
  tenantHours: number;
  tenantDays: number;
  hist: Record<string, Hist>;
  affinityFinal: number[];
  events: Record<string, number>;
  moveOuts: number;
  moveOutsUnhappy: number;
  aiOppDays: number;
  pendingHours: number;
}

// ---------------------------------------------------------------------------
// 父行程:5 種子 × 2 policy × 3 情境,每格 spawn 一次
// ---------------------------------------------------------------------------
if (!CHILD_SEED) {
  const self = fileURLToPath(import.meta.url);
  const rows: Child[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const seed = BASE_SEED + i * 7717;
    for (const policy of POLICIES) {
      for (const scenario of SCENARIOS) {
        const r = spawnSync(process.execPath, ["--import", "tsx", self, String(DAYS)], {
          stdio: ["ignore", "pipe", "inherit"],
          env: { ...process.env, RENT_EVT_SEED: String(seed), RENT_EVT_POLICY: policy, RENT_EVT_SCENARIO: scenario },
          maxBuffer: 64 * 1024 * 1024,
        });
        if (r.status !== 0) { console.error(r.stdout?.toString()); process.exit(r.status ?? 1); }
        const out = r.stdout.toString();
        const line = out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("{")).at(-1);
        if (!line) { console.error(out); process.exit(1); }
        rows.push(JSON.parse(line) as Child);
        process.stderr.write(`  種子 ${seed} / ${policy} / ${scenario} …完成\n`);
      }
    }
  }

  const merge = (sel: (c: Child) => boolean) => {
    const picked = rows.filter(sel);
    const hist: Record<string, Hist> = {};
    const events: Record<string, number> = {};
    const acc = { tenantHours: 0, tenantDays: 0, moveOuts: 0, moveOutsUnhappy: 0, aiOppDays: 0, pendingHours: 0 };
    const affinityFinal: number[] = [];
    for (const c of picked) {
      for (const [k, h] of Object.entries(c.hist)) {
        if (!hist[k]) hist[k] = new Array(h.length).fill(0);
        for (let i = 0; i < h.length; i++) hist[k][i] += h[i];
      }
      for (const [k, n] of Object.entries(c.events)) events[k] = (events[k] ?? 0) + n;
      acc.tenantHours += c.tenantHours;
      acc.tenantDays += c.tenantDays;
      acc.moveOuts += c.moveOuts;
      acc.moveOutsUnhappy += c.moveOutsUnhappy;
      acc.aiOppDays += c.aiOppDays;
      acc.pendingHours += c.pendingHours;
      affinityFinal.push(...c.affinityFinal);
    }
    return { ...acc, hist, events, affinityFinal, runs: picked.length };
  };

  const total = (h: Hist) => h.reduce((s, n) => s + n, 0);
  const pctOf = (h: Hist, p: number) => {
    const n = total(h);
    if (n === 0) return NaN;
    const want = p * (n - 1);
    let seen = 0;
    for (let i = 0; i < h.length; i++) {
      seen += h[i];
      if (seen > want) return i;
    }
    return h.length - 1;
  };
  const minOf = (h: Hist) => h.findIndex((n) => n > 0);
  const maxOf = (h: Hist) => { for (let i = h.length - 1; i >= 0; i--) if (h[i] > 0) return i; return NaN; };
  const atLeast = (h: Hist, v: number) => h.slice(v).reduce((s, n) => s + n, 0);
  const below = (h: Hist, v: number) => h.slice(0, v).reduce((s, n) => s + n, 0);
  const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
  const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "—");

  const ROOT_EVENTS = ["breakdown", "sick", "dissatisfied", "grievance"];
  const SEQUEL_EVENTS = ["sick_aftermath", "stress_aftermath", "promise_due"];

  console.log(`\n${"=".repeat(96)}`);
  console.log(`=== 規則事件頻率實測:${DAYS} 遊戲日 × ${SEED_COUNT} 種子 × 2 policy × 3 情境 × 4 人滿房`);
  console.log(`===   基礎種子 ${BASE_SEED}(+ i×7717);單一種子的前後差異裡「改動效果」與「序列位移」分不開,故多種子加總`);
  console.log(`${"=".repeat(96)}`);

  for (const policy of POLICIES) {
    for (const scenario of [...SCENARIOS, "全部" as const]) {
      const m = merge((c) => c.policy === policy && (scenario === "全部" || c.scenario === scenario));
      const per30 = (n: number) => (m.tenantDays > 0 ? (n / m.tenantDays) * 30 : NaN);
      console.log(`\n${"-".repeat(96)}`);
      console.log(`### policy=${policy}  情境=${scenario}   (${m.runs} 次跑,租客-日 ${m.tenantDays},租客-小時 ${m.tenantHours})`);
      console.log(`${"-".repeat(96)}`);

      console.log("  分布(每租客每小時取樣;min/p05/p50/p95/max):");
      const dist = (label: string, key: string) => {
        const h = m.hist[key] ?? [];
        console.log(`    ${label.padEnd(22)} ${f1(minOf(h)).padStart(6)} ${f1(pctOf(h, 0.05)).padStart(6)}`
          + ` ${f1(pctOf(h, 0.5)).padStart(6)} ${f1(pctOf(h, 0.95)).padStart(6)} ${f1(maxOf(h)).padStart(6)}`);
      };
      console.log(`    ${"".padEnd(22)} ${"min".padStart(6)} ${"p05".padStart(6)} ${"p50".padStart(6)} ${"p95".padStart(6)} ${"max".padStart(6)}`);
      dist("stats.stress", "stress");
      dist("baselines().stress", "baseStress");
      dist("stats.wellbeing", "wellbeing");
      dist("rt.satisfaction", "satisfaction");
      dist("stats.affinity", "affinity");
      dist("neglectPoints(rt)", "neglect");
      dist("rt.unhappyHours", "unhappy");
      const nHours = total(m.hist.stressN ?? []);
      if (nHours > 0) {
        console.log(`  🔴 只看虧待度到頂的 ${nHours} 個租客-小時(這才是「虧待到底把數值推到哪」):`);
        dist("stats.stress", "stressN");
        dist("baselines().stress", "baseStressN");
        dist("stats.wellbeing", "wellbeingN");
        dist("rt.satisfaction", "satisfactionN");
        dist("stats.affinity", "affinityN");
      }
      const af = m.affinityFinal;
      if (af.length > 0) {
        const sorted = [...af].sort((a, b) => a - b);
        console.log(`    affinity 最終值        min ${f1(sorted[0])} / p50 ${f1(sorted[Math.floor(sorted.length / 2)])}`
          + ` / max ${f1(sorted[sorted.length - 1])}(${sorted.length} 位在住租客)`);
      }

      console.log("  門檻窗口(每租客每日的小時數):");
      const perTd = (n: number) => (m.tenantDays > 0 ? n / m.tenantDays : NaN);
      const sh = m.hist.stress ?? [];
      for (const t of [60, 65, 70, 72, 75, 80, 85, 90]) {
        const n = atLeast(sh, t);
        process.stdout.write(`    stress ≥${String(t).padStart(2)}: ${f3(perTd(n)).padStart(7)} h/日 `);
        if (t % 20 === 0 || t === 75) process.stdout.write("\n");
      }
      process.stdout.write("\n");
      console.log(`    satisfaction < 30: ${f3(perTd(below(m.hist.satisfaction ?? [], 30)))} h/日`
        + `;< 25: ${f3(perTd(below(m.hist.satisfaction ?? [], 25)))} h/日`);
      console.log(`    wellbeing ≤ 28: ${f3(perTd(atLeast([], 0) + below(m.hist.wellbeing ?? [], 29)))} h/日`
        + `;≥ 60(sick_aftermath 用): ${f3(perTd(atLeast(m.hist.wellbeing ?? [], 60)))} h/日`);
      console.log(`    affinity ≤ 20: ${f3(perTd(below(m.hist.affinity ?? [], 21)))} h/日`);
      console.log(`    neglect ≥ 1: ${f3(perTd(atLeast(m.hist.neglect ?? [], 1)))} h/日`
        + `;= 上限 6: ${f3(perTd(atLeast(m.hist.neglect ?? [], 6)))} h/日`);

      console.log("  事件觸發(每租客每 30 遊戲日):");
      const ids = [...ROOT_EVENTS, ...SEQUEL_EVENTS, ...Object.keys(m.events).filter((k) => ![...ROOT_EVENTS, ...SEQUEL_EVENTS].includes(k)).sort()];
      for (const id of ids) {
        const n = m.events[id] ?? 0;
        const tag = ROOT_EVENTS.includes(id) ? "根" : SEQUEL_EVENTS.includes(id) ? "續" : " ";
        console.log(`    ${tag} ${id.padEnd(20)} ${String(n).padStart(5)} 次  ⇒ ${f3(per30(n))} / 租客·30日`);
      }
      const rootSum = ROOT_EVENTS.reduce((s, id) => s + (m.events[id] ?? 0), 0);
      const seqSum = SEQUEL_EVENTS.reduce((s, id) => s + (m.events[id] ?? 0), 0);
      console.log(`    四則根事件合計 ${rootSum} 次 ⇒ ${f3(per30(rootSum))} / 租客·30日`
        + `;三則續集合計 ${seqSum} 次 ⇒ ${f3(per30(seqSum))} / 租客·30日`);

      console.log("  其他驗收指標:");
      console.log(`    退租 ${m.moveOuts} 次(其中「長期不滿」${m.moveOutsUnhappy} 次)⇒ ${f3(per30(m.moveOuts))} / 租客·30日`);
      console.log(`    AI 事件機會日 ${m.aiOppDays} / ${m.tenantDays} 租客-日 = ${f3(m.tenantDays ? m.aiOppDays / m.tenantDays : NaN)}`);
      console.log(`    pendingEvent 佔用 ${m.pendingHours} / ${m.tenantHours} 租客-小時 = ${f3(m.tenantHours ? m.pendingHours / m.tenantHours : NaN)}`);
    }
  }
  console.log("\n本腳本只量,不反過來調參數。");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 子行程:一格(種子 × policy × 情境)
// ---------------------------------------------------------------------------
const policy = CHILD_POLICY ?? "absent";
const scenario = CHILD_SCENARIO ?? "normal";

let seed = Number(CHILD_SEED);
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state, roomOfTenant, gameDayIndex } = await import("../src/sim/gameState");
const { hourlyTick, baselines } = await import("../src/sim/tick");
const { moveIn, decide } = await import("../src/sim/tenancy");
const { resolveGroupEvent } = await import("../src/sim/community");
const { resolveChainEvent } = await import("../src/sim/floorChain");
const { repairBreakdown, neglectPoints, NEGLECT_CAP } = await import("../src/sim/maintenance");
const { giveKindness } = await import("../src/sim/kindness");
const { relationships } = await import("../src/sim/social");
const { addPlacement } = await import("../src/sim/placements");
const { randomAppearance } = await import("../src/pixel/parts");
import type { Applicant } from "../src/sim/recruit";

const HOURS = DAYS * 24;

/** 只影響 `baselines()` 的壓力基準、不影響 `compatibilityDetail()`(照抄 conflict-freq-sim.ts)。 */
const STRESS_TAGS: Record<ScenarioName, { id: string; label: string }[]> = {
  normal: [],
  stressed: [
    { id: "workaholic", label: "[工作狂]" },
    { id: "introvert", label: "[社恐]" },
  ],
  extreme: [
    { id: "workaholic", label: "[工作狂]" },
    { id: "introvert", label: "[社恐]" },
    { id: "deadline", label: "[截稿地獄]" },
    { id: "delicate", label: "[敏感體質]" },
  ],
};

interface Spec { room: string; id: string; name: string; archetypeKey: string; occupation: string; tags: { id: string; label: string }[]; rent: number }
const SPECS: Spec[] = [
  { room: "r303", id: "sim_drummer", name: "鼓手阿凱", archetypeKey: "student", occupation: "樂團鼓手", tags: [{ id: "noisy", label: "[製造噪音]" }, { id: "late_return", label: "[夜歸]" }], rent: 13000 },
  { room: "r304", id: "sim_gamer", name: "電競小豪", archetypeKey: "student", occupation: "電競系學生", tags: [{ id: "night_owl", label: "[夜貓子]" }, { id: "gamer", label: "[電競魂]" }], rent: 11000 },
  { room: "r301", id: "sim_yoga", name: "瑜伽阿哲", archetypeKey: "homebody", occupation: "瑜伽老師", tags: [{ id: "sound_sensitive", label: "[靜謐主義]" }, { id: "fitness", label: "[身心平衡]" }], rent: 13000 },
  { room: "r302", id: "sim_florist", name: "花藝阿文", archetypeKey: "early_riser", occupation: "花藝師", tags: [{ id: "early_bird", label: "[清晨批花]" }, { id: "perfectionist", label: "[構圖偏執]" }], rent: 12000 },
];

function applicantOf(s: Spec): Applicant {
  return {
    id: s.id, name: s.name, archetypeKey: s.archetypeKey, occupation: s.occupation,
    bio: `${s.occupation}。規則事件頻率實測用的合成租客。`,
    coreTags: [...s.tags, ...STRESS_TAGS[scenario]].map((t) => ({ ...t, behaviorHint: "" })),
    preferences: {}, monthlyRent: s.rent, stars: 3,
    gender: "male", attractedTo: ["female"], appearance: randomAppearance(), isAdult: true,
  };
}

addPlacement({ defId: "gaming_desk", room: "r303", c: 4, r: 16, rotation: 0 });
addPlacement({ defId: "gaming_desk", room: "r304", c: 10, r: 16, rotation: 0 });

for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
for (const room of Object.keys(state.occupancy)) delete state.occupancy[room];
for (const key of Object.keys(relationships)) delete relationships[key];
state.money = 5_000_000; // 不讓「沒錢修繕」變成隱藏變因(absent 是**選擇**不修,不是修不起)

const ROOMS = SPECS.map((s) => s.room);
const SPEC_OF = new Map(SPECS.map((s) => [s.room, s]));
let generation = 1;
function fillRoom(room: string) {
  const s = SPEC_OF.get(room)!;
  const ap = applicantOf(s);
  ap.id = generation === 1 ? s.id : `${s.id}_g${generation}`;
  ap.name = generation === 1 ? s.name : `${s.name}${generation}`;
  moveIn(room, ap);
}
const rtOf = (room: string) => state.runtimes[state.occupancy[room]];
for (const room of ROOMS) fillRoom(room);
state.activeId = state.occupancy[ROOMS[0]];

/**
 * `lax` / `absent` 的抉擇白名單:盲取最後一項會截斷量測、自相矛盾、或讓某則續集永遠量不到。
 *   grievance    → evict 會直接把租客趕走,60 天量不完
 *   rent_plea    → forgive 是 affinity +14,和「放牛吃草」完全相反
 *   dissatisfied → ignore 不留旗標 ⇒ promise_due 永遠是 0(那是驗收指標 2 的一部分)
 */
const CHOICE_OVERRIDE: Record<string, string> = { grievance: "talk", rent_plea: "collect", dissatisfied: "promise" };

/** `*N` 後綴 = **只在虧待度到頂(neglect === NEGLECT_CAP)的那些小時**取樣。
 *  混合樣本(含大量 n=0 的小時)會把分布拉回中間,量不出「虧待到底把數值推到哪」。 */
const HIST_KEYS = [
  "stress", "baseStress", "wellbeing", "satisfaction", "affinity", "neglect", "unhappy",
  "stressN", "baseStressN", "wellbeingN", "satisfactionN", "affinityN",
] as const;
const HIST_SIZE: Record<(typeof HIST_KEYS)[number], number> = {
  stress: 101, baseStress: 101, wellbeing: 101, satisfaction: 101, affinity: 101, neglect: 16, unhappy: 181,
  stressN: 101, baseStressN: 101, wellbeingN: 101, satisfactionN: 101, affinityN: 101,
};
const hist: Record<string, number[]> = {};
for (const k of HIST_KEYS) hist[k] = new Array(HIST_SIZE[k]).fill(0);
const put = (k: (typeof HIST_KEYS)[number], v: number) => {
  const i = Math.min(HIST_SIZE[k] - 1, Math.max(0, Math.round(v)));
  hist[k][i] += 1;
};

const events: Record<string, number> = {};
let tenantHours = 0;
let pendingHours = 0;
let moveOuts = 0;
let moveOutsUnhappy = 0;
let aiOppDays = 0;
let alumniSeen = 0;
/** 每位租客每個遊戲日只計一次「AI 事件機會日」(該日**任一小時**條件成立即算)。 */
const oppMarked = new Map<string, number>();
const tenantDaysSeen = new Map<string, Set<number>>();

for (let h = 0; h < HOURS; h++) {
  hourlyTick();
  const day = gameDayIndex();

  // --- 取樣(在拍板之前:pendingEvent 還掛著)---
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (!rt) continue;
    tenantHours += 1;
    if (rt.pendingEvent) pendingHours += 1;
    const n = neglectPoints(rt);
    const bs = baselines(rt).stress;
    put("stress", rt.tenant.stats.stress);
    put("baseStress", bs);
    put("wellbeing", rt.tenant.stats.wellbeing);
    put("satisfaction", rt.satisfaction);
    put("affinity", rt.tenant.stats.affinity);
    put("neglect", n);
    put("unhappy", rt.unhappyHours);
    if (n >= NEGLECT_CAP) {
      put("stressN", rt.tenant.stats.stress);
      put("baseStressN", bs);
      put("wellbeingN", rt.tenant.stats.wellbeing);
      put("satisfactionN", rt.satisfaction);
      put("affinityN", rt.tenant.stats.affinity);
    }
    if (!tenantDaysSeen.has(rt.tenant.id)) tenantDaysSeen.set(rt.tenant.id, new Set());
    tenantDaysSeen.get(rt.tenant.id)!.add(day);
    // AI 事件機會日(narration.ts:305 的條件):!pendingEvent && day - lastEventDay >= 3
    if (!rt.pendingEvent && day - rt.lastEventDay >= 3 && oppMarked.get(rt.tenant.id) !== day) {
      oppMarked.set(rt.tenant.id, day);
      aiOppDays += 1;
    }
  }

  // --- 事件計數(每小時都會拍板 ⇒ 每個事件恰好被看見一次)---
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (!rt?.pendingEvent) continue;
    const id = rt.pendingEvent.id;
    events[id] = (events[id] ?? 0) + 1;
  }

  // --- 房東拍板 ---
  for (const room of ROOMS) {
    const rt = rtOf(room);
    if (!rt?.pendingEvent) continue;
    const ev = rt.pendingEvent;
    const choiceId = policy === "caring"
      ? ev.choices[0].id
      : (CHOICE_OVERRIDE[ev.id] && ev.choices.some((c) => c.id === CHOICE_OVERRIDE[ev.id])
        ? CHOICE_OVERRIDE[ev.id]
        : ev.choices[ev.choices.length - 1].id);
    const label = ev.choices.find((c) => c.id === choiceId)?.label ?? "";
    decide(rt.tenant.id, choiceId, label);
  }
  if (state.pendingGroupEvent) resolveGroupEvent(state.pendingGroupEvent.choices[0].id);
  if (state.pendingChainEvent) resolveChainEvent(state.pendingChainEvent.choices[0].id);
  if (state.pendingCohabit) state.pendingCohabit = null;

  // --- 房東行為 ---
  if (policy === "caring") {
    for (const roomId of Object.keys(state.breakdowns)) repairBreakdown(roomId);
    for (const room of ROOMS) {
      const rt = rtOf(room);
      if (rt && rt.satisfaction < 45) giveKindness(rt.tenant.id, "snack");
    }
  } else if (policy === "lax") {
    for (const [roomId, bd] of Object.entries(state.breakdowns)) {
      if (state.gameMs - bd.sinceMs >= LAX_REPAIR_AFTER_DAYS * 24 * 3600 * 1000) repairBreakdown(roomId);
    }
  }

  // --- 有人走就補一位同人設(不然放牛吃草會在第 3 週把樓清空,量不到 60 天)---
  for (const a of state.alumni.slice(0, Math.max(0, state.alumni.length - alumniSeen))) {
    moveOuts += 1;
    if ((a.reason ?? "").includes("不滿")) moveOutsUnhappy += 1;
  }
  alumniSeen = state.alumni.length;
  const vacant = ROOMS.filter((room) => !rtOf(room));
  if (vacant.length > 0) {
    generation += 1;
    for (const room of vacant) fillRoom(room);
  }
}

const affinityFinal = ROOMS.map((room) => rtOf(room)?.tenant.stats.affinity).filter((v): v is number => typeof v === "number");
let tenantDays = 0;
for (const set of tenantDaysSeen.values()) tenantDays += set.size;

const out: Child = {
  policy, scenario, seed: Number(CHILD_SEED),
  tenantHours, tenantDays, hist, affinityFinal, events,
  moveOuts, moveOutsUnhappy, aiOppDays, pendingHours,
};
console.log(JSON.stringify(out));
