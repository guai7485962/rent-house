/**
 * 人生心願系統測試(玩家目標批第 1 項 + 圓夢畢業批第一批):
 * 職業指派與冪等、每日推進/倒退、里程碑日誌、劇情弧收束加成、
 * 實現(成長特質/記憶/成就/計數/不再推進)、圓夢離開(預告 → moveOut → 名冊)、
 * AI context 心願行、存檔往返;
 * 圓夢畢業批:兩軌分流、模範房客(+3% 租金/每日光環/封頂)、謝禮紅包+押金退還記帳、
  * 口碑增長與招租星等/開價效果、寵物去留(留下/預設帶走)、孤兒寵物修復、新成就。
 * 心願邏輯本身不使用 RNG;貓名等外圍用 mulberry32 固定種子。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32),讓外圍機率系統(貓名/應徵者)在任何環境可重現
let __seed = 20260721;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state, SAVE_KEY } = await import("../src/store");
const wishes = await import("../src/sim/wishes");
const { gameDayIndex, makeRuntime, tenants } = await import("../src/sim/gameState");
const { buildNarrateCtx } = await import("../src/sim/narration");
const { save, load } = await import("../src/sim/persistence");
const { moveOut, graduateFarewell, decide, farewellSendoff, moveIn } = await import("../src/sim/tenancy");
const { DEPOSIT_MONTHS, sellFurnitureAt } = await import("../src/sim/economy");
const { getPlacements } = await import("../src/sim/placements");
const { adoptCat, adoptPet, petsPass, ensurePets, HOUSE_CAT_OWNER } = await import("../src/sim/pets");
const { rescoreApplicants, generateApplicants } = await import("../src/sim/recruit");
const { relationships, pairKey } = await import("../src/sim/social");
const { REP_GRADUATE, REP_SETTLE } = await import("../src/sim/reputation");

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
check("心願說明含手機可讀的明確達成方式與門檻",
  wishes.WISH_DEFS.career_step.hint.includes("達成方式")
    && wishes.WISH_DEFS.career_step.hint.includes("精力維持在 40 以上")
    && wishes.WISH_DEFS.feel_at_home.hint.includes("關係達到 50"));
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
const chenRent0 = chen.tenant.finance.monthlyRent; // 模範房客 +3% 的比較基準
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

// ============================================================
// 圓夢畢業批(兩軌制心願 + 房東獎勵核心)
// ============================================================

// --- 10. 兩軌制 defs ---
{
  const D = wishes.WISH_DEFS;
  const grads = ["open_shop", "graduate_thesis", "stage_dream", "finish_masterwork"] as const;
  const settlers = ["career_step", "recover_rhythm", "feel_at_home", "settle_life"] as const;
  check("畢業型 4 條(含新增舞台/代表作)且都有告別文案",
    grads.every((id) => D[id].graduates && D[id].farewellText.length > 0));
  check("安居型 4 條不畢業", settlers.every((id) => !D[id].graduates));
}

// --- 11. 模範房客(chen 在第 5 節實現 career_step 時已授予) ---
{
  check("安居圓夢 → 授予模範房客", chen.modelTenant === true);
  check("租金自願 +3%(一次性)", chen.tenant.finance.monthlyRent === Math.round(chenRent0 * 1.03),
    `rent=${chen.tenant.finance.monthlyRent} base=${chenRent0}`);
  check("續住宣言 major 日誌", chen.log.some((e) => e.text.startsWith("🏠 續住宣言") && e.importance === "major"));
  check("主動加租的 💲 日誌", chen.log.some((e) => e.text.includes("多付一點")));
  check("成就「第一位模範房客」", state.achievements.includes("first_model_tenant"));
  check(`口碑:安居圓夢 +${REP_SETTLE}`, state.reputation === REP_SETTLE, `rep=${state.reputation}`);
}

// --- 12. 模範房客每日光環(掛在 wishPass) ---
{
  chen.tenant.stats.mood = 50;
  lin.tenant.stats.mood = 50;
  wishes.wishPass(); // 只有 chen 是模範
  check("光環:其他租客每日 mood +0.5", lin.tenant.stats.mood === 50.5, `mood=${lin.tenant.stats.mood}`);
  check("模範自己不吃自己的光環", chen.tenant.stats.mood === 50);
  // 三位模範同住 → 非模範者的光環封頂 +1
  const mk = (id: string, name: string) => {
    const seed = JSON.parse(JSON.stringify(tenants[0]));
    seed.id = id; seed.name = name;
    const r = makeRuntime(seed, "303", 70, []);
    r.wish = { id: "career_step", progress: 100, fulfilledDay: day(), graduateDay: -99, announced: false };
    state.runtimes[id] = r;
    return r;
  };
  const m1 = mk("t_model_a", "模範甲");
  const m2 = mk("t_model_b", "模範乙");
  m1.modelTenant = m2.modelTenant = true;
  const obs = mk("t_obs", "觀察者");
  obs.tenant.stats.mood = 50;
  m1.tenant.stats.mood = 50;
  wishes.wishPass(); // 模範 = chen + m1 + m2(共 3 位)
  check("多位模範不疊超過 +1(非模範)", obs.tenant.stats.mood === 51, `mood=${obs.tenant.stats.mood}`);
  check("模範彼此的光環同樣封頂 +1", m1.tenant.stats.mood === 51, `mood=${m1.tenant.stats.mood}`);
  delete state.runtimes["t_model_a"];
  delete state.runtimes["t_model_b"];
  delete state.runtimes["t_obs"];
}

// --- 13. 圓夢離開:謝禮紅包 + 押金退還 + 口碑 + 畢業成就 ---
{
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  seed.id = "t_grad1"; seed.name = "畢業咖啡師"; seed.occupation = "咖啡師";
  const rtG = makeRuntime(seed, "303", 70, []);
  state.runtimes["t_grad1"] = rtG;
  state.occupancy["r303"] = "t_grad1";
  rtG.tenant.finance.monthlyRent = 15000;
  rtG.tenant.stats.affinity = 60;
  rtG.wish = { id: "open_shop", progress: 100, fulfilledDay: day() - 6, graduateDay: day(), announced: true };
  const money0 = state.money;
  const rep0 = state.reputation;
  const g = wishes.wishPass().find((x) => x.id === "t_grad1");
  check("到期 → 進圓夢離開名單", !!g);
  if (g) graduateFarewell(g.id, g.reason);
  const gift = Math.min(15000, Math.round(0.5 * 15000 * 1.6)); // 12000(未觸頂)
  const deposit = 15000 * DEPOSIT_MONTHS;
  check("紅包進帳(0.5×月租×(1+好感/100))", state.ledger.some((t) => t.label.includes("圓夢謝禮紅包") && t.amount === gift));
  check("押金退還出帳(離開時月租 × 押金月數)", state.ledger.some((t) => t.label.includes("退還") && t.label.includes("押金") && t.amount === -deposit));
  check("餘額淨變化 = 紅包 − 押金", state.money === money0 + gift - deposit, `money=${state.money}`);
  check(`口碑:畢業離開 +${REP_GRADUATE}`, state.reputation === rep0 + REP_GRADUATE, `rep=${state.reputation}`);
  check("畢業計數 + 成就「首位畢業生」", state.graduateCount === 1 && state.achievements.includes("first_graduate"));
  check("runtime 移除、名冊記下圓夢離開", !state.runtimes["t_grad1"] && state.alumni[0]?.reason.includes("圓夢離開"));
  // 紅包上限:好感 100 → 0.5×2.0 = 1.0×月租,不會超過
  check("紅包公式觸頂 = 1×月租", Math.min(15000, Math.round(0.5 * 15000 * (1 + 100 / 100))) === 15000);
}

// --- 14. 口碑的招租效果(星等 raw + 開價) ---
{
  const ap: any = {
    id: "ap1", name: "口碑測試員", archetypeKey: "office", occupation: "上班族", bio: "",
    coreTags: [], preferences: {}, monthlyRent: 10000, baseRent: 10000, stars: 1,
    gender: "male", attractedTo: ["female"],
  };
  const repBackup = state.reputation;
  state.reputation = 0;
  rescoreApplicants([ap], "r304");
  check("口碑 0:空偏好 → 1 星、開價 = 基礎", ap.stars === 1 && ap.monthlyRent === 10000, `stars=${ap.stars} rent=${ap.monthlyRent}`);
  state.reputation = 100;
  rescoreApplicants([ap], "r304");
  check("口碑 100:raw +30 → 3 星", ap.stars === 3, `stars=${ap.stars}`);
  check("口碑 100:開價 +5%(取整到百位)", ap.monthlyRent === 10500, `rent=${ap.monthlyRent}`);
  state.reputation = repBackup;
}

// --- 15. 貓的去留(畢業型 + 有貓 → 規則式抉擇) ---
{
  // a) 留下成樓貓
  const seedD = JSON.parse(JSON.stringify(tenants[0]));
  seedD.id = "t_drummer"; seedD.name = "畢業鼓手"; seedD.occupation = "樂團鼓手";
  const rtD = makeRuntime(seedD, "304", 70, []);
  state.runtimes["t_drummer"] = rtD;
  state.occupancy["r304"] = "t_drummer";
  wishes.ensureWishes();
  check("樂團鼓手 → stage_dream(畢業型)", rtD.wish!.id === "stage_dream");
  adoptCat("t_drummer", { name: "鼓棒", color: 1 });
  good(rtD);
  rtD.wish!.progress = 98;
  wishes.wishPass(); // 實現 → 排定離開 + 掛貓去留抉擇
  check("實現當下掛上「寵物去留」抉擇(不經 AI)", rtD.pendingEvent?.id === "wish_pet_farewell" && rtD.pendingEvent!.choices.length === 2);
  decide("t_drummer", "stay", "把牠留下當樓貓");
  const cat = state.pets["t_drummer"];
  check("留下 → ownerId 轉 landlord、錨點交誼廳", cat?.ownerId === HOUSE_CAT_OWNER && cat?.hangout === "lounge");
  rtD.wish!.graduateDay = day();
  const gD = wishes.wishPass().find((x) => x.id === "t_drummer");
  if (gD) graduateFarewell(gD.id, gD.reason);
  check("飼主畢業離開後樓貓留下", !state.runtimes["t_drummer"] && state.pets["t_drummer"]?.ownerId === HOUSE_CAT_OWNER);
  check("名冊不寫「帶著愛貓」(貓沒跟走)", !state.alumni[0]?.memory.includes("帶著愛貓"));
  petsPass(); // 樓貓照常遊蕩,不會被清掉
  const legal = new Set(["lounge", ...Object.keys(state.occupancy)]);
  check("petsPass 後樓貓仍在且去處合法", !!state.pets["t_drummer"] && legal.has(state.pets["t_drummer"].hangout), state.pets["t_drummer"]?.hangout);

  // b) 玩家未決 → 離開日預設帶走(moveOut 通用路徑根治殘留)
  const seedT = JSON.parse(JSON.stringify(tenants[0]));
  seedT.id = "t_thesis"; seedT.name = "畢業研究生"; seedT.occupation = "研究生";
  const rtT = makeRuntime(seedT, "304", 70, []);
  state.runtimes["t_thesis"] = rtT;
  state.occupancy["r304"] = "t_thesis";
  wishes.ensureWishes();
  adoptPet("t_thesis", { name: "論文", color: 2, kind: "dog" });
  good(rtT);
  rtT.wish!.progress = 98;
  wishes.wishPass();
  check("養狗的研究生也掛上寵物去留抉擇", rtT.pendingEvent?.id === "wish_pet_farewell" && rtT.pendingEvent.description.includes("養狗"));
  // 不 decide(玩家未決) → 到期直接離開,狗預設帶走
  rtT.wish!.graduateDay = day();
  const gT = wishes.wishPass().find((x) => x.id === "t_thesis");
  if (gT) graduateFarewell(gT.id, gT.reason);
  check("未決 → 預設帶走(狗移除)", !state.runtimes["t_thesis"] && !state.pets["t_thesis"]);
  check("名冊 memory 提到帶狗離開", state.alumni[0]?.memory.includes("帶著愛狗「論文」") === true);
  check("3 位畢業 → 成就「桃李天下」", state.graduateCount === 3 && state.achievements.includes("graduate_3"));
}

// --- 16. 孤兒貓修復(persistence 載入經 ensurePets) ---
{
  state.pets["t_ghost"] = { name: "阿飄", kind: "cat", color: 2, ownerId: "t_ghost", hangout: "r303", sinceMs: state.gameMs };
  ensurePets();
  const ghost = state.pets["t_ghost"];
  check("飼主不存在的貓 → 轉樓貓 + 錨點交誼廳", ghost?.ownerId === HOUSE_CAT_OWNER && ghost?.hangout === "lounge");
  check("修復時補了通知", state.noticeLog.some((n) => n.text.includes("阿飄") && n.text.includes("樓貓")));
  delete state.pets["t_ghost"];
  state.pets["t_ghost_dog"] = { name: "小福", kind: "dog", color: 0, ownerId: "t_ghost_dog", hangout: "r303", sinceMs: state.gameMs };
  ensurePets();
  check("飼主不存在的狗 → 轉公寓犬", state.pets["t_ghost_dog"]?.ownerId === HOUSE_CAT_OWNER && state.noticeLog.some((n) => n.text.includes("小福") && n.text.includes("公寓犬")));
  delete state.pets["t_ghost_dog"];
}

// --- 17. 💑 雙雙圓夢(隱藏成就) ---
{
  const mk = (id: string, name: string, occupation: string) => {
    const seed = JSON.parse(JSON.stringify(tenants[0]));
    seed.id = id; seed.name = name; seed.occupation = occupation;
    const r = makeRuntime(seed, "304", 70, []);
    state.runtimes[id] = r;
    return r;
  };
  const a = mk("t_love_a", "圓夢甲", "上班族"); // career_step(安居)
  const b = mk("t_love_b", "圓夢乙", "神祕職業"); // fallback settle_life(安居)
  wishes.ensureWishes();
  relationships[pairKey("t_love_a", "t_love_b")] = { value: 85, romantic: true, cohabitOffered: false };
  good(a); good(b);
  a.wish!.progress = 98;
  wishes.wishPass();
  check("只有一人圓夢 → 尚未解鎖", !state.achievements.includes("couple_wish"));
  b.wish!.progress = 98;
  wishes.wishPass();
  check("情侶皆圓夢 → 解鎖「雙雙圓夢」", state.achievements.includes("couple_wish"));
  delete state.runtimes["t_love_a"];
  delete state.runtimes["t_love_b"];
  delete relationships[pairKey("t_love_a", "t_love_b")];
}

// --- 18. 存檔往返(新欄位) ---
{
  save();
  const s = JSON.parse(mem[SAVE_KEY]);
  check("存檔含 reputation / graduateCount", s.reputation === state.reputation && s.graduateCount === 3);
  check("存檔含 modelTenant 與樓貓", s.runtimes["tenant_chen_engineer"].modelTenant === true && s.pets["t_drummer"]?.ownerId === HOUSE_CAT_OWNER);
  const repBefore = state.reputation;
  check("load 還原:模範房客/口碑/樓貓", load() && state.runtimes["tenant_chen_engineer"].modelTenant === true
    && state.reputation === repBefore && state.pets["t_drummer"]?.ownerId === HOUSE_CAT_OWNER);
}

// ============================================================
// 圓夢畢業第二批(送別會 / 紀念物 / 名人堂)
// ============================================================

const mkRt = (id: string, name: string, occupation: string, roomNo = "304") => {
  const seed = JSON.parse(JSON.stringify(tenants[0]));
  seed.id = id; seed.name = name; seed.occupation = occupation;
  const r = makeRuntime(seed, roomNo, 70, []);
  state.runtimes[id] = r;
  return r;
};

// --- 19. 送別會(farewellSendoff 人數門檻) ---
{
  for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
  const leaver = mkRt("s_leaver", "送別鼓手", "樂團鼓手"); // stage_dream(畢業型)
  const n1 = mkRt("s_n1", "鄰居甲", "上班族");
  const n2 = mkRt("s_n2", "鄰居乙", "上班族");
  wishes.ensureWishes();
  leaver.wish!.fulfilledDay = day(); // 標記已實現 → 文案帶心願 label
  relationships[pairKey("s_leaver", "s_n1")] = { value: 70, romantic: false, cohabitOffered: false };
  relationships[pairKey("s_n1", "s_n2")] = { value: 40, romantic: false, cohabitOffered: false };
  n1.tenant.stats.mood = 50; n1.tenant.stats.stress = 50;
  n2.tenant.stats.mood = 50; n2.tenant.stats.stress = 50;
  farewellSendoff(leaver);
  check("≥2 人:全員 mood +4 / 壓力 -4", n1.tenant.stats.mood === 54 && n1.tenant.stats.stress === 46,
    `mood=${n1.tenant.stats.mood} stress=${n1.tenant.stats.stress}`);
  check("≥2 人:兩兩關係 +2", (relationships[pairKey("s_n1", "s_n2")]?.value ?? 0) === 42,
    `rel=${relationships[pairKey("s_n1", "s_n2")]?.value}`);
  check("≥2 人:🎉 送別 major 日誌落在最好鄰居身上",
    n1.log.some((e) => e.text.startsWith("🎉") && e.text.includes("送別鼓手") && e.text.includes("站上一次正式的舞台") && e.importance === "major"));
  check("≥2 人:歡送會 notify 進歷史", state.noticeLog.some((n) => n.text.includes("歡送會") && n.text.includes("送別鼓手")));
  // <2 人:僅剩離開者 → 獨白
  delete state.runtimes["s_n1"]; delete state.runtimes["s_n2"];
  farewellSendoff(leaver);
  check("<2 人:改發離開者獨白 major 日誌", leaver.log.some((e) => e.text.startsWith("🕯️") && e.importance === "major"));
}

// --- 20. 紀念物家具(留房間 / 不可賣 / 招租後保留) ---
{
  for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
  for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
  const rtM = mkRt("m_grad", "紀念鼓手", "樂團鼓手"); // stage_dream → memorial_poster
  state.occupancy["r304"] = "m_grad";
  wishes.ensureWishes();
  rtM.wish = { id: "stage_dream", progress: 100, fulfilledDay: day() - 6, graduateDay: day(), announced: true };
  const g = wishes.wishPass().find((x) => x.id === "m_grad");
  if (g) graduateFarewell(g.id, g.reason);
  const mem = getPlacements().find((p) => p.room === "r304" && p.memorial);
  check("畢業生在原房間留下紀念物(依軌別 = 簽名海報)", !!mem && mem.defId === "memorial_poster");
  const posterDef = (await import("../src/furniture/catalog")).getDef("memorial_poster");
  check("紀念物純裝飾(空屬性 → 不佔招租)", Object.keys(posterDef.attributes).length === 0 && posterDef.price === 0);
  check("紀念物不可變賣(sellFurnitureAt 擋)", mem ? sellFurnitureAt(mem.c, mem.r).ok === false : false);
  check("擋賣後紀念物仍在原房間", getPlacements().some((p) => p.room === "r304" && p.memorial));
  // 空房招租新租客 → 紀念物仍保留(綁房間不綁租客)
  moveIn("r304", generateApplicants("r304")[0]);
  check("招租後仍在原房間(綁房間不綁租客)", getPlacements().some((p) => p.room === "r304" && p.memorial));
}

// --- 21. 🏛️ 名人堂(五位畢業生) ---
{
  check("四位畢業時名人堂未解", state.graduateCount === 4 && !state.achievements.includes("hall_of_fame"),
    `graduateCount=${state.graduateCount}`);
  for (const id of Object.keys(state.runtimes)) delete state.runtimes[id];
  for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
  const rtH = mkRt("hof_grad", "名人堂咖啡師", "咖啡師", "303");
  state.occupancy["r303"] = "hof_grad";
  rtH.wish = { id: "open_shop", progress: 100, fulfilledDay: day() - 6, graduateDay: day(), announced: true };
  const g = wishes.wishPass().find((x) => x.id === "hof_grad");
  if (g) graduateFarewell(g.id, g.reason);
  check("第五位畢業 → 解鎖名人堂", state.graduateCount === 5 && state.achievements.includes("hall_of_fame"),
    `graduateCount=${state.graduateCount}`);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
