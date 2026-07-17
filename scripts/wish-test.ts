/**
 * 人生心願系統測試(玩家目標批第 1 項):
 * 職業指派與冪等、每日推進/倒退、里程碑日誌、劇情弧收束加成、
 * 實現(成長特質/記憶/成就/計數/不再推進)、圓夢離開(預告 → moveOut → 名冊)、
 * AI context 心願行、存檔往返。全程不使用 RNG,結果確定。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, SAVE_KEY } = await import("../src/store");
const wishes = await import("../src/sim/wishes");
const { gameDayIndex, makeRuntime, tenants } = await import("../src/sim/gameState");
const { buildNarrateCtx } = await import("../src/sim/narration");
const { save } = await import("../src/sim/persistence");
const { moveOut } = await import("../src/sim/tenancy");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const chen = state.runtimes["tenant_chen_engineer"]; // 後端工程師 → career_step
const lin = state.runtimes["tenant_lin_asmr"]; // ASMR 實況主 → finish_masterwork
const day = () => gameDayIndex();

// --- 1. 指派 ---
check("種子租客開局即有心願(store 門面 ensureWishes)", !!chen.wish && !!lin.wish);
check("後端工程師 → career_step", chen.wish!.id === "career_step");
check("ASMR 實況主 → finish_masterwork", lin.wish!.id === "finish_masterwork");
check("咖啡師 → open_shop / 未知職業 → settle_life",
  wishes.wishIdForOccupation("咖啡師") === "open_shop" && wishes.wishIdForOccupation("神秘人") === "settle_life");
chen.wish!.progress = 10;
wishes.ensureWishes();
check("ensureWishes 冪等(不重置既有進度)", chen.wish!.progress === 10);
{
  const backup = lin.wish!;
  lin.wish = { id: "不存在的心願" as any, progress: 55, fulfilledDay: -99, graduateDay: -99, announced: false };
  wishes.ensureWishes();
  check("壞檔防線:未知心願 id → 重新指派", lin.wish!.id === "finish_masterwork" && lin.wish!.progress === 0);
  lin.wish = backup;
}

// --- 2. 每日推進 / 倒退 ---
const good = (rt: typeof chen) => {
  const s = rt.tenant.stats;
  s.energy = 80; s.stress = 30; s.mood = 70; s.wellbeing = 70;
  rt.hardshipUntilDay = -99; rt.arrears = 0; rt.satisfaction = 70;
};
good(chen); good(lin);
{
  chen.wish!.progress = 10;
  const p0 = chen.wish!.progress;
  wishes.wishPass();
  check("順利的一天 → 進度 +4", chen.wish!.progress === p0 + 4, `progress=${chen.wish!.progress}`);
  chen.hardshipUntilDay = day() + 3; // 財務困難 → career_step 倒退
  const p1 = chen.wish!.progress;
  wishes.wishPass();
  check("困頓的一天 → 進度 -2(不會低於 0)", chen.wish!.progress === p1 - 2, `progress=${chen.wish!.progress}`);
  chen.hardshipUntilDay = -99;
}

// --- 3. 里程碑日誌 ---
{
  chen.wish!.progress = 23;
  const n0 = chen.log.filter((e) => e.text.startsWith("🎯")).length;
  wishes.wishPass(); // 23 → 27,跨 25
  const n1 = chen.log.filter((e) => e.text.startsWith("🎯")).length;
  check("跨過 25% 里程碑 → 🎯 日誌一筆", chen.wish!.progress === 27 && n1 === n0 + 1);
  wishes.wishPass(); // 27 → 31,無新里程碑
  check("同一里程碑不重複報", chen.log.filter((e) => e.text.startsWith("🎯")).length === n1);
}

// --- 4. 劇情弧收束加成 ---
{
  chen.wish!.progress = 40;
  wishes.boostWishFromArc(chen, "up");
  check("弧收束(up)→ 心願 +6", chen.wish!.progress === 46);
  wishes.boostWishFromArc(chen, "down");
  check("弧收束(down)→ 不加成", chen.wish!.progress === 46);
}

// --- 5. 實現 ---
{
  chen.wish!.progress = 98;
  const mood0 = chen.tenant.stats.mood;
  wishes.wishPass(); // 98 + 4 → 夾 100 → 實現
  const w = chen.wish!;
  check("進度封頂 100 且記下實現日", w.progress === 100 && w.fulfilledDay === day());
  check("慶祝脈衝:mood +10", chen.tenant.stats.mood === Math.min(100, mood0 + 10));
  check("留下[心願成真]記憶", chen.tenant.memoryTags.some((m) => m.label === "[心願成真]"));
  check("授予永久成長特質(career_step → grounded)", (chen.tenant.growthTags ?? []).includes("grounded"));
  check("🎉 日誌 + 成就「圓夢推手」", chen.log.some((e) => e.text.startsWith("🎉")) && state.achievements.includes("wish_fulfilled"));
  check("career_step 不會圓夢離開", w.graduateDay === -99);
  const p = w.progress;
  wishes.wishPass();
  check("已實現的心願不再推進", chen.wish!.progress === p);
}

// --- 6. AI context 心願行 ---
{
  const ctxChen = buildNarrateCtx(chen, "第 N 天");
  check("剛實現 3 天內:AI 拿到餘韻素材", (ctxChen.wish ?? "").includes("剛實現"));
  lin.wish!.progress = 60;
  const ctxLin = buildNarrateCtx(lin, "第 N 天");
  check("進行中:AI 拿到進度素材", (ctxLin.wish ?? "").includes("進度約 60%"));
  chen.wish!.fulfilledDay = day() - 10; // 實現已久 → 不再提
  check("實現已久:不進 prompt", buildNarrateCtx(chen, "第 N 天").wish === undefined);
}

// --- 7. 圓夢離開(open_shop:實現 → 預告 → 搬走進名冊) ---
{
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  seed.id = "t_coffee"; seed.name = "測試咖啡師"; seed.occupation = "咖啡師";
  const rtC = makeRuntime(seed, "303", 70, []);
  state.runtimes["t_coffee"] = rtC;
  state.occupancy["r303"] = "t_coffee";
  wishes.ensureWishes();
  check("新住戶依職業領到 open_shop", rtC.wish!.id === "open_shop");
  good(rtC);
  rtC.wallet = rtC.tenant.finance.monthlyRent; // 手頭寬裕 → +4
  rtC.wish!.progress = 98;
  wishes.wishPass();
  check("open_shop 實現 → 排定圓夢離開日", rtC.wish!.fulfilledDay === day() && rtC.wish!.graduateDay === day() + wishes.GRADUATE_AFTER_DAYS);
  rtC.wish!.graduateDay = day() + 2; // 快轉到預告窗口
  wishes.wishPass();
  check("離開前兩天 → 📦 打包預告(只一次)", rtC.wish!.announced && rtC.log.filter((e) => e.text.startsWith("📦")).length === 1);
  const before = wishes.wishPass();
  check("未到期 → 不在搬離名單", !before.some((g) => g.id === "t_coffee"));
  rtC.wish!.graduateDay = day(); // 到期
  const grads = wishes.wishPass();
  const g = grads.find((x) => x.id === "t_coffee");
  check("到期 → 進圓夢離開名單(原因含心願)", !!g && g.reason.includes("圓夢離開"));
  if (g) moveOut(g.id, g.reason);
  check("moveOut 後:runtime 移除、名冊記下圓夢離開", !state.runtimes["t_coffee"] && state.alumni[0]?.reason.includes("圓夢離開"));
}

// --- 8. 三度圓夢 → 夢想孵化器 ---
{
  good(lin);
  lin.wish!.progress = 99;
  wishes.wishPass();
  check("第三位實現(chen/咖啡師/lin)→ 累計計數", state.wishesFulfilled >= 3);
  check("成就「夢想孵化器」解鎖", state.achievements.includes("wish_collector"));
}

// --- 9. 存檔往返 ---
{
  save();
  const s = JSON.parse(mem[SAVE_KEY]);
  check("存檔含 wish 與 wishesFulfilled", s.runtimes["tenant_lin_asmr"].wish.progress === 100 && s.wishesFulfilled === state.wishesFulfilled);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
