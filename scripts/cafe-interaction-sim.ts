/**
 * ☕ 咖啡廳互動內容池的 A/B 實測(2026-09-03)。回答兩件事:
 *
 *   ① **零稀釋**:既有 room / lounge 的 28 種,在加入 11 種 `location: "cafe"` 之後
 *      觸發次數有沒有被擠掉。
 *   ② **內容有沒有真的活著**:11 種咖啡廳互動各自觸發幾次、第一次出現在第幾天,
 *      有沒有哪一種因為時段/家具/gate 疊加而永遠啞掉。
 *
 * 手法完全比照 `interaction-freq-sim.ts`(同一套子行程隔離 + cooldown diff 計數):
 *   A = 完整目錄;B = 把 `location === "cafe"` 的 11 種整個濾掉(= 這一批之前的目錄)。
 *
 * ⚠️ 為什麼一定要多種子 A/B:咖啡廳這一支**本身零 RNG**(見 `pickCafeInteraction()`),
 * 所以亂數序列不會因為「多抽了一次」而位移;但咖啡廳互動會改 mood/stress/好感,
 * 那些數值又會餵回 `encounter()` / `rollEvent()` 的門檻判斷 ⇒ 中長期軌跡仍會分岔。
 * 這是**新內容本來就該有的效果**,不是稀釋。判準因此和 `interaction-freq-sim.ts` 一樣是
 * **單邊**的:稀釋 = A 明顯比 B 少。
 *
 * 只印數字、不斷言 ⇒ 刻意不列入回歸集(`run-all.ts` 沒有它);
 * 有斷言的那份是 `cafe-interactions-test.ts`。
 *
 *   TZ=Asia/Taipei npx tsx scripts/cafe-interaction-sim.ts             # 120 日 × 5 種子 × A/B
 *   TZ=Asia/Taipei npx tsx scripts/cafe-interaction-sim.ts 200 3       # 自訂天數/種子數
 */import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAYS = Number(process.argv[2] ?? 120);
const SEED_COUNT = Number(process.argv[3] ?? 5);
const BASE_SEED = 20260903;
const CHILD_SEED = process.env.RENT_CAFE_SEED;
/** B 組:把 `location === "cafe"` 的 11 種整個濾掉 ⇒ 等同這一批之前的目錄 */
const NO_CAFE = process.env.RENT_CAFE_OFF === "1";

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
        env: { ...process.env, RENT_CAFE_SEED: seed, RENT_CAFE_OFF: variant === "B" ? "1" : "0" },
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
      console.log(`  種子 ${seed} / ${variant === "A" ? "A 完整目錄" : "B 沒有咖啡廳池"} … ${tot} 次`);
    }
  }

  const sum = (m: Map<string, number>, ids: string[]) => ids.reduce((s, id) => s + (m.get(id) ?? 0), 0);
  // A 組目錄裡 location === "cafe" 的那幾種;B 組定義上恆為 0
  const CAFE_IDS = [
    "cafe_order_queue", "cafe_people_watching", "cafe_landlord_upstairs", "cafe_chili_lap",
    "cafe_menu_bet", "cafe_split_cake", "cafe_coffee_cheers", "cafe_last_call",
    "cafe_closing_hands", "cafe_shared_cup", "cafe_window_date",
  ];
  const CORE_IDS = order.filter((id) => !CAFE_IDS.includes(id));
  const coreA = sum(agg.A, CORE_IDS);
  const coreB = sum(agg.B, CORE_IDS);
  const cafeA = sum(agg.A, CAFE_IDS);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`=== 咖啡廳池 零稀釋 A/B 實測:${DAYS} 遊戲日 × ${SEED_COUNT} 種子 × 4 人滿房 × 已開張咖啡廳`);
  console.log(`===   A = 完整 39 種目錄 / B = 濾掉 location: "cafe" 的 11 種(= 本批之前)`);
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
  for (const id of CAFE_IDS) {
    console.log(id.padEnd(22) + "cafe".padEnd(7) + String(agg.A.get(id) ?? 0).padStart(6) + String(0).padStart(7));
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
  console.log(`cafe 合計   A=${cafeA}(B 組定義上為 0)`);
  const silentCafe = CAFE_IDS.filter((id) => (agg.A.get(id) ?? 0) === 0);
  console.log(silentCafe.length === 0
    ? `✅ 咖啡廳 ${CAFE_IDS.length} 種每一種都觸發過`
    : `⚠️ 咖啡廳互動從未觸發:${silentCafe.join(", ")}`);
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
const { addPlacement, placeCafeStarterSet } = await import("../src/sim/placements");
const { INTERACTIONS } = await import("../src/sim/interactions");
const { randomAppearance } = await import("../src/pixel/parts");
import type { Applicant } from "../src/sim/recruit";

/**
 * B 組:就地把咖啡廳池從目錄裡拿掉。`runGroup()` 對 cafe 分組的 `eligible` 因此恆為空陣列,
 * `pickCafeInteraction([])` 直接回 null ⇒ 與「這一批之前把 at_cafe 整個 continue 掉」
 * 在**可觀測行為上等價**(兩者都不產生任何咖啡廳互動、都不擲骰),不必真的 checkout 舊 commit。
 */
if (NO_CAFE) {
  for (let i = INTERACTIONS.length - 1; i >= 0; i--) {
    if (INTERACTIONS[i].location === "cafe") INTERACTIONS.splice(i, 1);
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

/**
 * 🔴 作息 key **刻意混搭**,因為咖啡廳的下樓時段完全由它決定
 * (`routine.cafeSitHourForDay()` 取 `CAFE_SIT_HOURS` 的首個可用時段):
 *   office → 18:00 / homebody → 15:00 / freelancer・student・night_creator → 14:00 / night_shift → 15~16。
 * 四個人全用同一把 key 的話,17～19 點的「打烊前」內容整段量不到 —— 那是取樣問題,不是內容啞掉。
 * 這裡把情侶那一對設成 office(18:00 同框)、朋友那一對設成 homebody(15:00 同框),
 * 兩個時段各自都有一組配對,11 種才涵蓋得完整。
 */
const SPECS: Spec[] = [
  { room: "r301", id: "sim_a", name: "阿倫", archetypeKey: "office", occupation: "上班族",
    gender: "male", attractedTo: ["female"], tags: [{ id: "punctual", label: "[準時]" }], rent: 13000 },
  { room: "r302", id: "sim_b", name: "小妍", archetypeKey: "office", occupation: "社區里幹事",
    gender: "female", attractedTo: ["male"], tags: [{ id: "punctual", label: "[準時]" }], rent: 13000 },
  { room: "r303", id: "sim_c", name: "阿祥", archetypeKey: "homebody", occupation: "二手黑膠店主",
    gender: "male", attractedTo: ["female"], tags: [{ id: "homebody", label: "[宅居]" }], rent: 13000 },
  { room: "r304", id: "sim_d", name: "小柔", archetypeKey: "homebody", occupation: "獨立書店店員",
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

/**
 * 一樓:開張 + 家具。**兩件事缺一不可**——
 *   `state.cafe.open` 是 `routine.cafeSitActive()` 的閘門一(沒開張沒有人下樓),
 *   家具則決定 11 種裡有幾種站得出舞台(`standAt` / `requiresFurniture` 是硬性條件)。
 * 這裡刻意把「開張贈品 + 四件要花錢買的」都擺上,才量得到完整的 11 種;
 * 只有贈品的店會少掉菜單板/甜點櫃/咖啡機/寵物區那四條(那是設計上的預期,不是 bug)。
 */
state.cafe.open = true;
placeCafeStarterSet();
addPlacement({ defId: "espresso_machine", room: "cafe_counter", c: 6, r: 38, rotation: 0 });
addPlacement({ defId: "cafe_display_stocked", room: "cafe_counter", c: 2, r: 39, rotation: 0 });
addPlacement({ defId: "cafe_menu_board", room: "cafe_floor", c: 1, r: 36, rotation: 0 });
addPlacement({ defId: "cafe_pet_cushion", room: "cafe_pet", c: 10, r: 43, rotation: 0 });

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
console.log(`=== 咖啡廳互動實測 ${DAYS} 遊戲日 × 4 人滿房(種子 ${CHILD_SEED}${NO_CAFE ? "、B 組:沒有咖啡廳池" : "、A 組:完整目錄"})`);
console.log(`=== 目錄 ${INTERACTIONS.length} 種(三樓 ${INTERACTIONS.filter((d) => d.location !== "cafe").length} / 咖啡廳 ${INTERACTIONS.filter((d) => d.location === "cafe").length})`);
console.log(`${"=".repeat(74)}`);

/** 同框診斷:分辨「內容啞掉」與「根本沒同框」——後者是取樣問題,不是 def 的問題 */
const coByHour = new Map<number, number>();
let coHours = 0;

for (let h = 0; h < HOURS; h++) {
  hourlyTick();
  const day = Math.floor(h / 24) + 1;
  {
    // 排除 pendingEvent:`interactionsPass()` 本來就會跳過他們,不排除會高估同框機會
    const atCafe = Object.values(state.runtimes).filter((rt) => rt.tenant.visualState === "at_cafe" && !rt.pendingEvent);
    if (atCafe.length >= 2) {
      coHours++;
      coByHour.set(h % 24, (coByHour.get(h % 24) ?? 0) + 1);
    }
  }
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

console.log(`同框小時合計 ${coHours} 小時;依時段 ${JSON.stringify(Object.fromEntries([...coByHour.entries()].sort((a, b) => a[0] - b[0])))}`);

// 機器可讀:給前後兩次量測做 ±5% 比對用
console.log("\n--- JSON ---");
console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.n]))));
