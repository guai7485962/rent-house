/**
 * 互動抽籤的主池/次池框架(G 批第 1 批)驗證:
 * - 主池零稀釋:同種子下「含 extra 的完整目錄」與「濾掉 extra 的目錄」選出的主池序列逐位元相同
 * - 擲骰次數:主池非空 2 顆／主池空+次池空 0 顆／主池空+次池非空 1 顆(唯一的變動,見規格)
 * - 次池預算公式 (1−P_core)·(w/W)·c、條件亂數 u 的均勻性
 * - gateOk() 邊界、applyLend() 守恆(不動 state.money)、applyNeedyBonus() 挑對人
 * - 真實目錄的結構把關(批次 3 起):主池仍是原本 18 種、次池 6 種、`venue` 不搭
 *   `requiresFurniture`、`interactions.ts` 全檔不得出現 `adjustTension`
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32)+ 擲骰計數,讓「逐位元相同」與「擲骰次數」都可斷言
let __seed = 20260710;
let __rolls = 0;
Math.random = () => {
  __rolls++;
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const reseed = (s: number) => { __seed = s; __rolls = 0; };

const { pickInteraction, splitPools, gateOk, applyLend, applyNeedyBonus, INTERACTIONS } =
  await import("../src/sim/interactions");
const { relationships, pairKey } = await import("../src/sim/social");
const { state } = await import("../src/store");
import type { InteractionDef } from "../src/sim/interactions";
import type { TenantRuntime } from "../src/sim/gameState";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

/** 合成 def:本批零新內容,故一律用假目錄驗框架,不動真的 INTERACTIONS */
const D = (id: string, pool: "extra" | undefined, weight: number, chance: number): InteractionDef =>
  ({
    id, tier: "close", location: "lounge", pool, weight, chance,
    cooldownHours: 1, fx: "chat", lines: ["和{o}測試。"], effects: { rel: 1 },
  }) as InteractionDef;

const RT = (id: string, o: { wallet?: number; wellbeing?: number; isAdult?: boolean } = {}): TenantRuntime =>
  ({
    tenant: {
      id, name: id, isAdult: o.isAdult,
      stats: { mood: 50, stress: 50, wellbeing: o.wellbeing ?? 70, energy: 50, affinity: 50 },
    },
    wallet: o.wallet,
  }) as unknown as TenantRuntime;

// ---------------------------------------------------------------------------
// 1. 主池零稀釋(逐位元)
// ---------------------------------------------------------------------------
// 刻意把 extra 交錯進 core 之間,一併驗 splitPools 保序
const c1 = D("c1", undefined, 3, 0.4);
const c2 = D("c2", undefined, 1, 0.2);
const c3 = D("c3", undefined, 2, 0.3);
const e1 = D("e1", "extra", 2, 0.3);
const e2 = D("e2", "extra", 2, 0.5);
const FULL = [c1, e1, c2, e2, c3];
const CORE_ONLY = [c1, c2, c3];

const P_CORE = (3 / 6) * 0.4 + (1 / 6) * 0.2 + (2 / 6) * 0.3; // = 1/3

const N = 5000;
const SEED = 424242;

reseed(SEED);
const withExtra: (InteractionDef | null)[] = [];
for (let i = 0; i < N; i++) withExtra.push(pickInteraction(FULL, false));
const rollsWith = __rolls;

reseed(SEED);
const withoutExtra: (InteractionDef | null)[] = [];
for (let i = 0; i < N; i++) withoutExtra.push(pickInteraction(CORE_ONLY, false));
const rollsWithout = __rolls;

check("splitPools 保序:core/extra 各自維持原目錄順序",
  splitPools(FULL).core.join() === [c1, c2, c3].join() && splitPools(FULL).extra.join() === [e1, e2].join());
check("pool 省略 = core", splitPools([c1]).core.length === 1 && splitPools([c1]).extra.length === 0);

// (a) 逐位置:沒有 extra 時抽中的主池 def,加了 extra 之後必須是「同一個物件」
let posMismatch = -1;
for (let i = 0; i < N; i++) {
  if (withoutExtra[i] !== null && withExtra[i] !== withoutExtra[i]) { posMismatch = i; break; }
}
check("逐位置相同:主池命中的每一格,含 extra 與濾掉 extra 選出同一個 def(物件identity)",
  posMismatch === -1, `第 ${posMismatch} 格 ${withoutExtra[posMismatch]?.id} → ${withExtra[posMismatch]?.id}`);

// (b) 落空的格子只可能維持 null 或改由 extra 遞補,絕不會冒出別的 core def
let leak = -1;
for (let i = 0; i < N; i++) {
  const w = withExtra[i];
  if (withoutExtra[i] === null && w !== null && w.pool !== "extra") { leak = i; break; }
}
check("主池落空的格子只會是 null 或 extra,不會偷換成別的 core def", leak === -1, `第 ${leak} 格`);

// (c) 抽出主池子序列後,兩份紀錄逐位元相同
const coreSeqWith = withExtra.filter((d) => d && d.pool !== "extra").map((d) => d!.id).join(",");
const coreSeqWithout = withoutExtra.filter((d) => d !== null).map((d) => d!.id).join(",");
check("主池子序列逐位元相同(長度與內容)",
  coreSeqWith === coreSeqWithout && coreSeqWith.length > 0,
  `${coreSeqWith.length} vs ${coreSeqWithout.length}`);

// (d) 擲骰次數也一位元不差(否則後面所有系統的亂數序列會位移)
check("擲骰次數相同且恰為 2N(加 extra 不多擲一顆)",
  rollsWith === rollsWithout && rollsWith === 2 * N, `${rollsWith} vs ${rollsWithout}`);

// (e) 測試本身不可以是空的:extra 必須真的有被抽中過
const extraHits = withExtra.filter((d) => d?.pool === "extra").length;
check("次池確實有觸發(測試非空轉)", extraHits > 100, `extra 命中 ${extraHits} 次`);

// 每個 core def 的命中次數兩邊也必須完全一致
const tally = (arr: (InteractionDef | null)[]) => {
  const m: Record<string, number> = {};
  for (const d of arr) if (d && d.pool !== "extra") m[d.id] = (m[d.id] ?? 0) + 1;
  return JSON.stringify(m);
};
check("每個 core def 的命中次數完全一致", tally(withExtra) === tally(withoutExtra), `${tally(withExtra)} vs ${tally(withoutExtra)}`);

// ---------------------------------------------------------------------------
// 2. 擲骰次數三情境
// ---------------------------------------------------------------------------
const M = 300;
reseed(SEED);
for (let i = 0; i < M; i++) pickInteraction(FULL, false);
check("主池非空 → 每次恰 2 顆骰", __rolls === 2 * M, `${__rolls}`);

reseed(SEED);
for (let i = 0; i < M; i++) pickInteraction([], false);
check("主池空 + 次池空 → 0 顆骰(與擴充前相同)", __rolls === 0, `${__rolls}`);

reseed(SEED);
for (let i = 0; i < M; i++) pickInteraction([e1, e2], false);
check("主池空 + 次池非空 → 每次恰 1 顆骰(唯一的變動)", __rolls === M, `${__rolls}`);

reseed(SEED);
for (let i = 0; i < M; i++) pickInteraction(CORE_ONLY, true);
check("串門配對(visitPair)仍是 2 顆骰且必定成局",
  __rolls === 2 * M && pickInteraction(CORE_ONLY, true) !== null, `${__rolls}`);

reseed(SEED);
const visitExtra = Array.from({ length: M }, () => pickInteraction([e1, e2], true));
check("串門配對只剩次池時也必定成局(不因 chance 落空而白跑一趟)",
  visitExtra.every((d) => d !== null) && __rolls === M, `${__rolls}`);

// ---------------------------------------------------------------------------
// 3. 次池預算公式:P = (1−P_core)·(w/W)·c
// ---------------------------------------------------------------------------
const MC = 20000;
reseed(998877);
const hits: Record<string, number> = {};
for (let i = 0; i < MC; i++) {
  const d = pickInteraction(FULL, false);
  if (d) hits[d.id] = (hits[d.id] ?? 0) + 1;
}
const wExtra = 2 + 2;
for (const [id, w, c] of [["e1", 2, 0.3], ["e2", 2, 0.5]] as const) {
  const expected = (1 - P_CORE) * (w / wExtra) * c;
  const actual = (hits[id] ?? 0) / MC;
  const err = Math.abs(actual - expected) / expected;
  check(`次池 ${id} 實測觸發率貼合預算公式(誤差 < 15%)`, err < 0.15,
    `實測 ${(actual * 100).toFixed(2)}% vs 預期 ${(expected * 100).toFixed(2)}%(誤差 ${(err * 100).toFixed(1)}%)`);
}
const coreRate = (["c1", "c2", "c3"].reduce((s, id) => s + (hits[id] ?? 0), 0)) / MC;
check("主池整體觸發率仍是 P_core(次池沒吃掉主池的份額)",
  Math.abs(coreRate - P_CORE) < 0.02, `實測 ${(coreRate * 100).toFixed(2)}% vs ${(P_CORE * 100).toFixed(2)}%`);

// ---------------------------------------------------------------------------
// 4. 條件亂數 u 的均勻性:10 個等寬 bucket 的 extra 各佔 10% ± 2%
// ---------------------------------------------------------------------------
const bucketCore = [D("bc", undefined, 1, 0.5)];
const buckets = Array.from({ length: 10 }, (_, i) => D(`u${i}`, "extra", 1, 1));
reseed(13579);
const bucketHits = new Array(10).fill(0);
let bucketTotal = 0;
for (let i = 0; i < 40000; i++) {
  const d = pickInteraction([...bucketCore, ...buckets], false);
  if (d && d.pool === "extra") { bucketHits[Number(d.id.slice(1))]++; bucketTotal++; }
}
const worst = bucketHits.reduce((m, h) => Math.max(m, Math.abs(h / bucketTotal - 0.1)), 0);
check("u(由落空的 chanceRoll 換算)在 [0,1) 均勻:10 bucket 各 10% ± 2%",
  worst < 0.02, `最大偏差 ${(worst * 100).toFixed(2)}%(樣本 ${bucketTotal})`);

// ---------------------------------------------------------------------------
// 5. gateOk 邊界
// ---------------------------------------------------------------------------
check("gate 省略 → 一律通過", gateOk(undefined, RT("a"), RT("b")));

check("one_broke:2999 + 8000 → 通過",
  gateOk("one_broke", RT("a", { wallet: 2999 }), RT("b", { wallet: 8000 })));
check("one_broke:3000 + 8000 → 擋(窮的那邊未達門檻)",
  !gateOk("one_broke", RT("a", { wallet: 3000 }), RT("b", { wallet: 8000 })));
check("one_broke:2999 + 7999 → 擋(有錢的那邊未達門檻)",
  !gateOk("one_broke", RT("a", { wallet: 2999 }), RT("b", { wallet: 7999 })));
check("one_broke:順序對調結果相同(對稱)",
  gateOk("one_broke", RT("a", { wallet: 8000 }), RT("b", { wallet: 2999 })));
check("one_broke:wallet undefined 當 0,不 NaN",
  gateOk("one_broke", RT("a"), RT("b", { wallet: 8000 })) && !gateOk("one_broke", RT("a"), RT("b")));

check("one_unwell:wellbeing 39 → 通過", gateOk("one_unwell", RT("a", { wellbeing: 39 }), RT("b")));
check("one_unwell:wellbeing 40 → 擋", !gateOk("one_unwell", RT("a", { wellbeing: 40 }), RT("b", { wellbeing: 40 })));

check("both_adult:雙方成年 → 通過", gateOk("both_adult", RT("a", { isAdult: true }), RT("b", { isAdult: true })));
check("both_adult:isAdult undefined 視同成年(內建角色)", gateOk("both_adult", RT("a"), RT("b")));
check("both_adult:任一方未成年 → 擋",
  !gateOk("both_adult", RT("a", { isAdult: false }), RT("b")) && !gateOk("both_adult", RT("a"), RT("b", { isAdult: false })));

const rel = (v: number, romantic: boolean, cohabitOffered: boolean) => {
  relationships[pairKey("ga", "gb")] = { value: v, tension: 0, lastConflictGameMs: 0, romantic, cohabitOffered };
};
const GA = RT("ga");
const GB = RT("gb");
rel(94, true, false);
check("deep_couple:情侶 rel 94、未同居抉擇 → 擋", !gateOk("deep_couple", GA, GB));
rel(95, true, false);
check("deep_couple:情侶 rel 95 → 通過", gateOk("deep_couple", GA, GB));
rel(94, true, true);
check("deep_couple:rel 94 但已觸發同居抉擇 → 通過", gateOk("deep_couple", GA, GB));
rel(95, false, true);
check("deep_couple:非情侶一律擋(rel 95 也不行)", !gateOk("deep_couple", GA, GB));
delete relationships[pairKey("ga", "gb")];
check("deep_couple:沒有關係紀錄 → 擋", !gateOk("deep_couple", GA, GB));

// ---------------------------------------------------------------------------
// 6. applyLend 守恆 / applyNeedyBonus
// ---------------------------------------------------------------------------
const moneyBefore = state.money;
const LA = RT("la", { wallet: 10000 });
const LB = RT("lb", { wallet: 500 });
const sumBefore = (LA.wallet ?? 0) + (LB.wallet ?? 0);
const moved = applyLend(LA, LB, 2000);
check("lend:錢多的轉給錢少的", moved === 2000 && LA.wallet === 8000 && LB.wallet === 2500,
  `moved=${moved} A=${LA.wallet} B=${LB.wallet}`);
check("lend:兩人錢包總和不變", (LA.wallet ?? 0) + (LB.wallet ?? 0) === sumBefore);
check("lend:不動 state.money(房東帳)", state.money === moneyBefore);

const PA = RT("pa", { wallet: 1000 });
const PB = RT("pb", { wallet: 0 });
check("lend:錢多的也不夠時只轉得出手上的數,不會轉出負數",
  applyLend(PA, PB, 2000) === 1000 && PA.wallet === 0 && PB.wallet === 1000);
const ZA = RT("za", { wallet: 0 });
const ZB = RT("zb", { wallet: 0 });
check("lend:兩人都沒錢 → 0 元、錢包不變", applyLend(ZA, ZB, 2000) === 0 && ZA.wallet === 0 && ZB.wallet === 0);
const UA = RT("ua");
const UB = RT("ub");
check("lend:wallet undefined 不產生 NaN", applyLend(UA, UB, 2000) === 0 && !Number.isNaN(UA.wallet ?? 0));
check("lend:金額 0/負數 → 不動作", applyLend(LA, LB, 0) === 0 && applyLend(LA, LB, -5) === 0);

const NA = RT("na", { wellbeing: 30 });
const NB = RT("nb", { wellbeing: 80 });
applyNeedyBonus(NA, NB, { wellbeing: 3, mood: 2 });
check("needyBonus:只加在 wellbeing 較低的那一方",
  NA.tenant.stats.wellbeing === 33 && NA.tenant.stats.mood === 52 && NB.tenant.stats.wellbeing === 80 && NB.tenant.stats.mood === 50,
  `A=${NA.tenant.stats.wellbeing}/${NA.tenant.stats.mood} B=${NB.tenant.stats.wellbeing}/${NB.tenant.stats.mood}`);
const CA = RT("ca", { wellbeing: 99 });
const CB = RT("cb", { wellbeing: 100 });
applyNeedyBonus(CA, CB, { wellbeing: 10 });
check("needyBonus:夾在 0~100", CA.tenant.stats.wellbeing === 100);

// ---------------------------------------------------------------------------
// 7. 真實目錄的現況把關(批次 3:主池 18 + 次池 6)
// ---------------------------------------------------------------------------
const realSplit = splitPools(INTERACTIONS);
check("真實目錄共 24 種", INTERACTIONS.length === 24, `${INTERACTIONS.length}`);
check("主池仍恰好是原本的 18 種(零稀釋的前提)", realSplit.core.length === 18, `${realSplit.core.length}`);
check("次池恰好是新加的 6 種", realSplit.extra.length === 6, `${realSplit.extra.length}`);
check("次池 id 就是規格上的那 6 種",
  realSplit.extra.map((d) => d.id).sort().join(",")
    === ["bar_cheers", "bathroom_rush", "catch_up_show", "laundry_wait", "lend_money", "sick_care"].join(","),
  realSplit.extra.map((d) => d.id).join(","));
const TIERS = new Set(["close", "crush", "couple", "cohabit"]);
check("沒有新增更低的 tier(acquaintance 會讓全樓低關係配對多擲骰)",
  INTERACTIONS.every((d) => TIERS.has(d.tier)));
check("次池的 def 一律 tier close 以上(擲骰次數變動只發生在朋友以上的配對)",
  realSplit.extra.every((d) => TIERS.has(d.tier)));
check("gate/lend/needyBonus 只出現在次池",
  realSplit.core.every((d) => !d.gate && !d.lend && !d.needyBonus));
check("lend 只有 lend_money 用,且只搭 one_broke",
  INTERACTIONS.filter((d) => d.lend).map((d) => `${d.id}:${d.gate}`).join(",") === "lend_money:one_broke");

// 🔴 requiresFurniture 對 venue **無效**:furnitureSetOf() 只查 `p.room === roomId`,
//    而帶 venue 的 def 演出地點與家具反查的地點不是同一個。設了會變成「永遠鎖死」或「形同虛設」。
check("帶 venue 的 def 一律不帶 requiresFurniture",
  INTERACTIONS.filter((d) => d.venue).every((d) => !d.requiresFurniture),
  INTERACTIONS.filter((d) => d.venue && d.requiresFurniture).map((d) => d.id).join(","));
// standAt 需要長度 ≥2 的家具(furnitureStandingPair);1×1 的 washing_machine 用不了。
check("standAt 一律不指向 1×1 家具(washing_machine)",
  INTERACTIONS.every((d) => !d.standAt?.includes("washing_machine")));

// 🔴 硬規則:負向互動不得餵養冷戰/打架系統(F 系列剛把打架門檻調到 50/22)
const SRC = readFileSync(fileURLToPath(new URL("../src/sim/interactions.ts", import.meta.url)), "utf8");
check("interactions.ts 全檔不出現 adjustTension", !/adjustTension/.test(SRC));
const negative = INTERACTIONS.filter((d) => d.effects.rel < 0);
check("負向互動只有 bathroom_rush 一種", negative.map((d) => d.id).join(",") === "bathroom_rush", negative.map((d) => d.id).join(","));
check("負向互動的 rel 扣分不超過 1", negative.every((d) => d.effects.rel >= -1));

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
