/**
 * 互動觸發頻率實測(G 批第 3 批的「零稀釋」最終實證)。
 *
 * `interaction-pool-test.ts` 用蒙地卡羅證明了**抽籤本身**對主池零稀釋(逐位元);但真正
 * 上線後還會疊上時段/家具/gate/冷卻/退租換人,所以這裡直接跑真的 `hourlyTick()` 迴圈,
 * 統計每個 `InteractionDef` 實際觸發幾次,回答兩個問題:
 *   ① 既有 18 種的分布,在次池加入新內容(批次 3 的 6 種 + 批次 4 的戀愛線 4 種)前後是否一致
 *   ② 次池每一種是否都真的出現過(沒有因時段/家具/gate 疊加而永遠啞掉)
 *
 * ⚠️ **為什麼一定要多種子 A/B,不能只跑一次前後比對**:次池命中一次就會多消耗一顆選句骰,
 * 整條亂數序列從此位移。這棟樓是混沌系統(退租換人、事件、天氣全在同一條序列上),
 * 單一種子的前後差異裡,**分池造成的部分與序列位移造成的部分完全分不開**——實測單種子
 * 200 日的 core 合計差了 6%,但那幾乎全是「換了另一組隨機軌跡」而不是稀釋。
 * 所以本腳本對每個種子各跑一次 **A(完整目錄)** 與 **B(把次池濾掉,等同批次 2 之前的
 * 18 種目錄)**,再把多個種子加總後比較 core 的平均速率與組成。
 *
 * 計數手法:`performInteraction()` 每次都會寫 `state.interactionCooldowns["<pairKey>|<defId>"]
 * = state.gameMs`,所以每小時 tick 後掃一次這個 Map、比對值有沒有變,就能**零侵入**地
 * 精確計數(ESM 匯出是唯讀綁定,攔不到函式本身)。
 *
 * 只印數字、不斷言 ⇒ 與 `conflict-freq-sim.ts` / `cafe-growth-sim.ts` 一樣
 * **刻意不列入回歸集**(`run-all.ts` 的清單沒有它)。
 *
 *   TZ=Asia/Taipei npx tsx scripts/interaction-freq-sim.ts             # 100 日 × 5 種子 × A/B
 *   TZ=Asia/Taipei npx tsx scripts/interaction-freq-sim.ts 200 3       # 自訂天數/種子數
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAYS = Number(process.argv[2] ?? 100);
const SEED_COUNT = Number(process.argv[3] ?? 5);
const BASE_SEED = 20260818;
const CHILD_SEED = process.env.RENT_FREQ_SEED;
/** B 組:把次池整個濾掉 ⇒ `pickInteraction` 與批次 2 之前逐位元相同 */
const NO_EXTRA = process.env.RENT_FREQ_NO_EXTRA === "1";

// ---------------------------------------------------------------------------
// 父行程:每個種子各 spawn 一次 A 與一次 B(模組層有大量跨情境的冷卻 Map,
// 同一個 process 連跑會互相汙染,比照 conflict-freq-sim.ts 用子行程隔離)
// ---------------------------------------------------------------------------
if (!CHILD_SEED) {
  const self = fileURLToPath(import.meta.url);
  const agg = { A: new Map<string, number>(), B: new Map<string, number>() };
  const order: string[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    for (const variant of ["A", "B"] as const) {
      const seed = String(BASE_SEED + i * 7717);
      const r = spawnSync(process.execPath, ["--import", "tsx", self, String(DAYS)], {
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, RENT_FREQ_SEED: seed, RENT_FREQ_NO_EXTRA: variant === "B" ? "1" : "0" },
      });
      if (r.status !== 0) { console.error(r.stdout?.toString()); process.exit(r.status ?? 1); }
      const out = r.stdout.toString();
      const line = out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("{")).at(-1);
      if (!line) { console.error(out); process.exit(1); }
      const obj = JSON.parse(line) as Record<string, number>;
      for (const [id, n] of Object.entries(obj)) {
        if (!order.includes(id)) order.push(id);
        agg[variant].set(id, (agg[variant].get(id) ?? 0) + n);
      }
      const tot = Object.values(obj).reduce((s, n) => s + n, 0);
      console.log(`  種子 ${seed} / ${variant === "A" ? "A 完整目錄" : "B 只有主池"} … ${tot} 次`);
    }
  }

  const sum = (m: Map<string, number>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  const EXTRA_IDS = [
    "lend_money", "sick_care", "catch_up_show", "bathroom_rush", "laundry_wait", "bar_cheers", // 批次 3
    "first_kiss", "morning_kiss", "anniversary", "stargaze_window", // 批次 4(戀愛線)
  ];
  const CORE_IDS = order.filter((id) => !EXTRA_IDS.includes(id));
  const coreA = sum(agg.A, CORE_IDS);
  const coreB = sum(agg.B, CORE_IDS);
  const extraA = sum(agg.A, EXTRA_IDS);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`=== 零稀釋 A/B 實測:${DAYS} 遊戲日 × ${SEED_COUNT} 種子 × 4 人滿房`);
  console.log(`===   A = 完整 28 種目錄 / B = 濾掉次池(= 批次 2 之前的 18 種)`);
  console.log(`${"=".repeat(78)}\n`);
  console.log("id".padEnd(22) + "pool".padEnd(7) + "A".padStart(6) + "B".padStart(7) + "   差異%    A 佔 core%  B 佔 core%");
  console.log("-".repeat(78));
  for (const id of [...CORE_IDS].sort((x, y) => (agg.B.get(y) ?? 0) - (agg.B.get(x) ?? 0))) {
    const a = agg.A.get(id) ?? 0;
    const b = agg.B.get(id) ?? 0;
    if (a === 0 && b === 0) continue;
    const d = b > 0 ? ((a - b) / b) * 100 : Number.NaN;
    console.log(
      id.padEnd(22) + "core".padEnd(7) + String(a).padStart(6) + String(b).padStart(7)
      + "   " + (Number.isNaN(d) ? "—" : (d >= 0 ? "+" : "") + d.toFixed(1)).padStart(7)
      + "    " + ((a / coreA) * 100).toFixed(2).padStart(7) + "    " + ((b / coreB) * 100).toFixed(2).padStart(7),
    );
  }
  console.log("-".repeat(78));
  for (const id of EXTRA_IDS) {
    console.log(id.padEnd(22) + "extra".padEnd(7) + String(agg.A.get(id) ?? 0).padStart(6) + String(0).padStart(7));
  }
  console.log("-".repeat(78));
  const coreDelta = ((coreA - coreB) / coreB) * 100;
  /**
   * 判準是**單邊**的:稀釋的定義是「既有內容被新內容擠掉」⇒ A 比 B **少**。
   * A 比 B 多不是稀釋,而是次池自己的 rel/mood 加成把整棟樓的關係推得更高、
   * 讓更多主池 def 過得了 tier 門檻的順風效果(序列位移下本來就會有幾個百分點的擺盪)。
   */
  console.log(`core 合計   A=${coreA}  B=${coreB}  差異 ${coreDelta >= 0 ? "+" : ""}${coreDelta.toFixed(2)}%`
    + `  ${coreDelta >= -5 ? "✅ 沒有被擠掉(稀釋的判準是 A 比 B 少 5% 以上)" : "❌ 主池被稀釋了,回頭查批次 1"}`);
  console.log(`extra 合計  A=${extraA}(B 組定義上為 0)`);
  const silentExtra = EXTRA_IDS.filter((id) => (agg.A.get(id) ?? 0) === 0);
  console.log(silentExtra.length === 0
    ? `✅ 次池 ${EXTRA_IDS.length} 種每一種都觸發過`
    : `⚠️ 新目錄從未觸發:${silentExtra.join(", ")}`);
  // 組成差異:core 內部各自的佔比(對序列位移比絕對次數穩健得多)
  const maxShareDrift = CORE_IDS.reduce((m, id) => {
    const sa = coreA > 0 ? ((agg.A.get(id) ?? 0) / coreA) * 100 : 0;
    const sb = coreB > 0 ? ((agg.B.get(id) ?? 0) / coreB) * 100 : 0;
    return Math.max(m, Math.abs(sa - sb));
  }, 0);
  console.log(`core 組成:單一 def 的佔比最大偏移 ${maxShareDrift.toFixed(2)} 個百分點`
    + `  ${maxShareDrift <= 5 ? "✅ 主池內部的相對分布維持原樣" : "⚠️ 主池內部組成被改變了"}`);
  process.exit(0);
}

// 固定 RNG:量測要可重現,而且必須在 import 遊戲模組**之前**換掉(比照 conflict-freq-sim.ts)
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

const HOURS = DAYS * 24;

const { state } = await import("../src/sim/gameState");
const { hourlyTick } = await import("../src/sim/tick");
const { moveIn, decide } = await import("../src/sim/tenancy");
const { relationships, pairKey } = await import("../src/sim/social");
const { addPlacement } = await import("../src/sim/placements");
const { INTERACTIONS } = await import("../src/sim/interactions");
const { randomAppearance } = await import("../src/pixel/parts");
import type { Applicant } from "../src/sim/recruit";

/**
 * B 組:就地把次池從目錄裡拿掉。`pickInteraction()` 在 `extra.length === 0` 時
 * 走的是與批次 2 之前**逐位元相同**的路徑(同一顆 weight 骰、同一顆 chance 骰、
 * 落空即收工、零額外擲骰),所以這是「舊版目錄」的忠實重現,不必真的 checkout 舊 commit。
 */
if (NO_EXTRA) {
  for (let i = INTERACTIONS.length - 1; i >= 0; i--) {
    if (INTERACTIONS[i].pool === "extra") INTERACTIONS.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// 高互動滿房:4 位成年、彼此相容的租客;兩對可以發展戀愛線(讓 couple/cohabit 也量得到)
// ---------------------------------------------------------------------------

interface Spec {
  room: string; id: string; name: string; archetypeKey: string; occupation: string;
  gender: "male" | "female"; attractedTo: ("male" | "female")[];
  tags: { id: string; label: string }[]; rent: number;
}

const SPECS: Spec[] = [
  { room: "r301", id: "sim_a", name: "阿倫", archetypeKey: "homebody", occupation: "插畫家",
    gender: "male", attractedTo: ["female"], tags: [{ id: "homebody", label: "[宅居]" }], rent: 13000 },
  { room: "r302", id: "sim_b", name: "小妍", archetypeKey: "homebody", occupation: "書店店員",
    gender: "female", attractedTo: ["male"], tags: [{ id: "homebody", label: "[宅居]" }], rent: 13000 },
  { room: "r303", id: "sim_c", name: "阿祥", archetypeKey: "homebody", occupation: "後端工程師",
    gender: "male", attractedTo: ["female"], tags: [{ id: "homebody", label: "[宅居]" }], rent: 13000 },
  { room: "r304", id: "sim_d", name: "小柔", archetypeKey: "homebody", occupation: "咖啡師",
    gender: "female", attractedTo: ["male"], tags: [{ id: "homebody", label: "[宅居]" }], rent: 13000 },
];

function applicantOf(s: Spec): Applicant {
  return {
    id: s.id, name: s.name, archetypeKey: s.archetypeKey, occupation: s.occupation,
    bio: `${s.occupation}。互動頻率實測用的合成租客。`,
    coreTags: s.tags.map((t) => ({ ...t, behaviorHint: "" })),
    preferences: {}, monthlyRent: s.rent, stars: 3,
    gender: s.gender, attractedTo: s.attractedTo,
    appearance: randomAppearance(), isAdult: true,
  };
}

// 家具:讓 requiresFurniture 的 def 全部解鎖(lounge 基本盤在 map.ts 已有 shared_sofa/
// lounge_tv/bar_counter/counter/washing_machine,這裡補 lounge_console 與各房私有家具)
addPlacement({ defId: "lounge_console", room: "lounge", c: 11, r: 9, rotation: 0 });
/**
 * ⚠️ 家具配置直接決定量得到什麼,踩過一次坑:一開始四間房都塞了 `romantic_table`(kind
 * `dining_table`)與 `loveseat`(kind `sofa`),`resolveTarget()` 的 `own ?? communal`
 * 就永遠選自己房間 ⇒ **早上 7-9 點沒有任何人會出現在交誼廳**,`bathroom_rush` 直接量成 0。
 *
 * 所以只給情侶房(r301)完整家具讓 couple/cohabit 的互動演得起來;r303/r304 刻意只放書桌,
 * 吃飯/看電視/坐沙發全部得下樓到交誼廳——這也才是真實遊戲裡沒買家具的房客的樣子。
 */
addPlacement({ defId: "double_bed", room: "r301", c: 6, r: 18, rotation: 0 });
addPlacement({ defId: "tv_console", room: "r301", c: 4, r: 16, rotation: 0 });
addPlacement({ defId: "loveseat", room: "r301", c: 8, r: 16, rotation: 0 });
addPlacement({ defId: "romantic_table", room: "r301", c: 2, r: 18, rotation: 0 });
addPlacement({ defId: "gaming_desk", room: "r303", c: 4, r: 16, rotation: 0 });
addPlacement({ defId: "gaming_desk", room: "r304", c: 4, r: 16, rotation: 0 });

for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
for (const room of Object.keys(state.occupancy)) delete state.occupancy[room];
for (const key of Object.keys(relationships)) delete relationships[key];
state.money = 5_000_000;
state.adultMode = true; // 🔞 目錄也要量得到(否則 4 種成人互動永遠 0 次,分布會失真)

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
for (const room of ROOMS) fillRoom(room);
state.activeId = state.occupancy[ROOMS[0]];

/**
 * r301 的阿倫與 r302 的小妍直接設成「同居情侶」(比照 `tenancy.resolveCohabit()` 的結果:
 * 空出 r302、小妍記在 `state.cohabits`)。不這麼做的話,couple/cohabit 兩個 tier 的 9 種
 * 互動在 200 天內一次都量不到——`encounter()` 要湊齊 rel≥75 + comp≥0 + 相遇擲骰,
 * 而 `interactionsPass()` 又跑在 `socialPass()` 之前、會先把這對標成已觸發。
 */
const COHABIT_ROOM = "r302";
const relOf = (aId: string, bId: string) => {
  const k = pairKey(aId, bId);
  return relationships[k] ?? (relationships[k] = { value: 0, tension: 0, lastConflictGameMs: 0, romantic: false, cohabitOffered: false });
};

/** 每日重新確立同居情侶。租客會退租換人(`wishes.SETTLE_TENURE_DAYS`),
 *  不每天重建的話這一對第一個月就散了,couple/cohabit 的 9 種互動整段量不到。 */
function keepCohabitCouple() {
  const aId = state.occupancy["r301"];
  if (!aId) return;
  let bId = Object.keys(state.cohabits).find((id) => state.cohabits[id] === "r301" && state.runtimes[id]);
  if (!bId) {
    if (!state.occupancy[COHABIT_ROOM]) { generation += 1; fillRoom(COHABIT_ROOM); }
    bId = state.occupancy[COHABIT_ROOM];
    if (!bId) return;
    delete state.occupancy[COHABIT_ROOM];
    state.cohabits[bId] = "r301";
    state.runtimes[bId].roomNo = "301";
  }
  const rel = relOf(aId, bId);
  rel.value = 92;
  rel.tension = 0;
  rel.romantic = true;
  rel.cohabitOffered = true;
}
keepCohabitCouple();

/** 把所有配對的關係值頂到 close 門檻以上(零 RNG:直接寫 relationships)。
 *  沒有這一步,前兩週幾乎量不到 close 以上的互動,200 天的樣本會被暖機期吃掉。 */
function warmRelationships(min = 80) {
  const ids = Object.keys(state.runtimes);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const rel = relOf(ids[i], ids[j]);
      if (rel.value < min) rel.value = min;
    }
  }
}
warmRelationships();

// ---------------------------------------------------------------------------
// 計數:diff state.interactionCooldowns
// ---------------------------------------------------------------------------

const DEF_IDS = new Set(INTERACTIONS.map((d) => d.id));
const counts = new Map<string, number>(INTERACTIONS.map((d) => [d.id, 0]));
const firstSeen = new Map<string, number>();
let prev = new Map<string, number>();

function sampleCooldowns(day: number) {
  const next = new Map<string, number>();
  for (const [key, value] of Object.entries(state.interactionCooldowns)) {
    next.set(key, value);
    const defId = key.slice(key.lastIndexOf("|") + 1);
    if (!DEF_IDS.has(defId) || !key.includes("|")) continue;
    if (prev.get(key) === value) continue;
    counts.set(defId, (counts.get(defId) ?? 0) + 1);
    if (!firstSeen.has(defId)) firstSeen.set(defId, day);
  }
  prev = next;
}
sampleCooldowns(0);

console.log(`\n${"=".repeat(74)}`);
console.log(`=== 互動觸發頻率實測 ${DAYS} 遊戲日 × 4 人滿房(種子 ${CHILD_SEED}${NO_EXTRA ? "、B 組:濾掉次池" : "、A 組:完整目錄"})`);
console.log(`=== 目錄 ${INTERACTIONS.length} 種(core ${INTERACTIONS.filter((d) => (d.pool ?? "core") === "core").length} / extra ${INTERACTIONS.filter((d) => d.pool === "extra").length})`);
console.log(`${"=".repeat(74)}`);

for (let h = 0; h < HOURS; h++) {
  hourlyTick();
  const day = Math.floor(h / 24) + 1;
  // 事件一律選第一項,避免 pendingEvent 卡住互動(pendingEvent 的租客整段被跳過)
  for (const rt of Object.values(state.runtimes)) {
    if (rt.pendingEvent) {
      const c = rt.pendingEvent.choices[0];
      decide(rt.tenant.id, c.id, c.label);
    }
  }
  sampleCooldowns(day);
  /**
   * gate 情境注入(零 RNG,A/B 兩組完全相同 ⇒ 不影響比較)。
   * `one_broke` 與 `one_unwell` 依設計就只在「有人手頭緊」「有人身體不舒服」時才成立;
   * 這座實測樓層錢多、住得爽,兩個閘門一輩子不會自然成立,`lend_money` / `sick_care`
   * 會被誤判成「永遠啞掉」。所以每 6 個遊戲日的 17 點注入一次(緊接著 lend_money 的
   * 18-23 時窗,錢包才不會在窗口打開前就被日結收入補回去):一位手頭剩 1500、
   * 一位 wellbeing 掉到 30,之後讓模擬自己恢復——對應真實遊戲裡的月底吃緊與小感冒。
   */
  if (h % (24 * 6) === 17) {
    const rts = Object.values(state.runtimes);
    if (rts.length >= 2) {
      rts[h % rts.length].wallet = 1500;
      for (const rt of rts) if (rt.wallet != null && rt.wallet < 8000 && rt !== rts[h % rts.length]) rt.wallet = 12000;
      rts[(h + 1) % rts.length].tenant.stats.wellbeing = 30;
    }
  }
  // 有人退租就補人(比照 conflict-freq-sim),並重新暖機關係值
  if (h % 24 === 23) {
    for (const room of ROOMS) {
      if (room === COHABIT_ROOM) continue; // 同居後刻意空著,不要補人進來拆散這一對
      if (!state.occupancy[room]) { generation += 1; fillRoom(room); }
    }
    keepCohabitCouple();
    warmRelationships();
  }
}

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------

const total = [...counts.values()].reduce((s, n) => s + n, 0);
const rows = INTERACTIONS.map((d) => ({
  id: d.id,
  pool: (d.pool ?? "core") as string,
  tier: d.tier,
  n: counts.get(d.id) ?? 0,
  share: total > 0 ? ((counts.get(d.id) ?? 0) / total) * 100 : 0,
  first: firstSeen.get(d.id) ?? null,
}));

console.log(`\n總觸發次數 ${total} 次 / ${DAYS} 日(平均每日 ${(total / DAYS).toFixed(2)} 次)\n`);
console.log("id".padEnd(22) + "pool".padEnd(7) + "tier".padEnd(12) + "次數".padStart(6) + "  佔比%   首次(日)");
console.log("-".repeat(74));
for (const r of rows.sort((a, b) => b.n - a.n)) {
  console.log(
    r.id.padEnd(22) + r.pool.padEnd(7) + r.tier.padEnd(12)
    + String(r.n).padStart(6) + "  " + r.share.toFixed(2).padStart(6) + "   " + (r.first ?? "—"),
  );
}

const coreTotal = rows.filter((r) => r.pool === "core").reduce((s, r) => s + r.n, 0);
const extraTotal = rows.filter((r) => r.pool === "extra").reduce((s, r) => s + r.n, 0);
console.log("-".repeat(74));
console.log(`core 合計 ${coreTotal} 次 / extra 合計 ${extraTotal} 次`);
const silent = rows.filter((r) => r.n === 0);
console.log(silent.length === 0 ? "✅ 沒有任何 def 完全啞掉" : `⚠️ 從未觸發:${silent.map((r) => r.id).join(", ")}`);

// 機器可讀:給前後兩次量測做 ±5% 比對用
console.log("\n--- JSON ---");
console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.n]))));
