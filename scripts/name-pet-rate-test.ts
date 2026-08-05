/**
 * A 批(2026-08-05)使用者實玩回報的兩點:
 *
 * - **B. 姓名池**「都是類似的名字重複出現」⇒ `NAME_IDENTITIES` 20 → 72 筆
 * - **C. 寵物到來機率**太低 ⇒ 應徵者自帶貓狗的 `PET_CHANCE` 0.22 → 0.45
 *
 * 本測試釘的是三件會壞掉存檔或平衡的事:
 *
 * 1. 🔴 **既有 20 筆一字未動、順序未變** —— `genderForKnownName()` 是舊存檔的性別
 *    校正來源,改一筆就會讓存檔裡的同名租客當場換性別、戀愛線配對整組錯亂
 * 2. **姓名池本身健康** —— ≥70 筆、無重複、每筆 gender 合法、男女比例平衡、
 *    不含真實可辨識藝人本名(中控判斷:AI 會替角色生成戀愛/衝突敘事)
 * 3. **寵物機率調高但不爆量** —— 一人一隻的硬上限、永久樓寵物名額仍是 2、
 *    超額一律自動轉中途媒合(不會逼玩家一直手動送養)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { genderForKnownName, generateApplicants, PET_CHANCE } = await import("../src/sim/recruit");
const { state } = await import("../src/sim/gameState");
const {
  adoptPet, permanentHousePetEntries, resolvePetFarewell, repairOrphanPets,
  HOUSE_PET_OWNER, PERMANENT_HOUSE_PET_LIMIT,
} = await import("../src/sim/pets");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const recruitSrc = readFileSync(join(here, "..", "src", "sim", "recruit.ts"), "utf8");

/**
 * 🔴 A 批之前的 20 筆,逐字釘死在測試裡(含順序)。
 * 未來任何人改動、重排、或在中間插入新名字,這一條會立刻紅掉。
 */
const LEGACY_20: Array<[string, "male" | "female"]> = [
  ["王大明", "male"], ["李佳蓉", "female"],
  ["張偉", "male"], ["陳思妤", "female"],
  ["林俊傑", "male"], ["黃美玲", "female"],
  ["吳承恩", "male"], ["周曉涵", "female"],
  ["蔡明軒", "male"], ["許雅婷", "female"],
  ["鄭浩宇", "male"], ["謝欣妤", "female"],
  ["洪偉哲", "male"], ["郭品妍", "female"],
  ["曾冠廷", "male"], ["賴思穎", "female"],
  ["潘建宏", "male"], ["簡莉雯", "female"],
  ["邱柏翰", "male"], ["溫若晴", "female"],
];

/** 從原始碼把 NAME_IDENTITIES 的內容抓出來(順序也要驗,所以不能只靠 export)。 */
function parseNameIdentities(): Array<{ name: string; gender: string }> {
  const start = recruitSrc.indexOf("const NAME_IDENTITIES");
  const open = recruitSrc.indexOf("[", start);
  const close = recruitSrc.indexOf("\n];", open);
  const body = recruitSrc.slice(open, close);
  return [...body.matchAll(/\{\s*name:\s*"([^"]+)",\s*gender:\s*"([^"]+)"\s*\}/g)]
    .map((m) => ({ name: m[1], gender: m[2] }));
}

try {
  // =========================================================================
  // B. 姓名池
  // =========================================================================
  const pool = parseNameIdentities();
  check("姓名池擴充到 70 筆以上", pool.length >= 70, `目前 ${pool.length} 筆`);

  check("🔴 既有 20 筆一字未動、順序未變(舊存檔的性別校正靠它)",
    LEGACY_20.every(([name, gender], i) => pool[i]?.name === name && pool[i]?.gender === gender),
    LEGACY_20.map(([name], i) => pool[i]?.name === name ? "" : `#${i} 期望 ${name} 實得 ${pool[i]?.name}`)
      .filter(Boolean).join(" / "));
  check("🔴 既有 20 筆是**前 20 筆**(新名字只能 append 在後面)",
    pool.slice(0, 20).every((entry, i) => entry.name === LEGACY_20[i][0]));
  check("🔴 genderForKnownName() 對既有 20 筆的回答完全沒變",
    LEGACY_20.every(([name, gender]) => genderForKnownName(name) === gender),
    LEGACY_20.filter(([name, gender]) => genderForKnownName(name) !== gender).map(([n]) => n).join(","));

  const names = pool.map((entry) => entry.name);
  check("沒有重複的名字(重複會讓某些名字出現機率翻倍)",
    new Set(names).size === names.length,
    names.filter((name, i) => names.indexOf(name) !== i).join(","));
  check("每一筆都有合法的 gender(戀愛線配對只讀這一欄)",
    pool.every((entry) => entry.gender === "male" || entry.gender === "female" || entry.gender === "nonbinary"),
    pool.filter((e) => !["male", "female", "nonbinary"].includes(e.gender)).map((e) => e.name).join(","));
  check("每一筆 genderForKnownName() 都查得到(沒有漏標)",
    pool.every((entry) => genderForKnownName(entry.name) === entry.gender));

  const males = pool.filter((entry) => entry.gender === "male").length;
  const females = pool.filter((entry) => entry.gender === "female").length;
  check("男女比例平衡(任一性別都不低於四成)",
    Math.min(males, females) / pool.length >= 0.4, `男 ${males} / 女 ${females}`);

  check("名字長度合理(2~4 字,UI 卡片放得下)",
    pool.every((entry) => entry.name.length >= 2 && entry.name.length <= 4),
    pool.filter((e) => e.name.length < 2 || e.name.length > 4).map((e) => e.name).join(","));

  // 🔴 安全底線:AI 會替角色生成戀愛/衝突/私生活敘事,不能用真實可辨識的藝人本名。
  const REAL_CELEBRITIES = [
    "周杰倫", "蔡依林", "五月天", "阿信", "張惠妹", "王力宏", "羅志祥", "田馥甄",
    "邵雨薇", "歐陽娜娜", "阮經天", "白冰冰", "蔡阿嘎", "陳綺貞", "盧廣仲", "魏如萱",
    "林志玲", "郭富城", "劉德華", "梁靜茹", "孫燕姿", "李榮浩", "楊丞琳", "炎亞綸",
  ];
  check("🔴 姓名池不含真實可辨識的藝人本名(AI 會替角色生成私生活敘事)",
    REAL_CELEBRITIES.every((celebrity) => !names.includes(celebrity)),
    REAL_CELEBRITIES.filter((c) => names.includes(c)).join(","));

  // 實際抽樣:重複感是「數量」問題,72 筆之後同一批三位一定不撞名
  const batches = Array.from({ length: 200 }, (_, i) => generateApplicants("r1", []));
  check("同一批應徵者內不會撞名", batches.every((batch) => new Set(batch.map((a) => a.name)).size === batch.length));
  check("excludeNames 真的排除得掉(已在住租客不會再出現在應徵者裡)",
    generateApplicants("r1", names.slice(0, 60)).every((a) => !names.slice(0, 60).includes(a.name)));
  const seen = new Set(batches.flatMap((batch) => batch.map((a) => a.name)));
  check("200 批抽樣至少覆蓋到七成的姓名池(不是永遠只抽到那幾個)",
    seen.size >= pool.length * 0.7, `覆蓋 ${seen.size}/${pool.length}`);
  check("應徵者的 gender 與姓名綁定(不會出現男名被存成女性)",
    batches.flat().every((a) => genderForKnownName(a.name) === undefined || genderForKnownName(a.name) === a.gender));

  console.log(`\n   姓名池:${pool.length} 筆(男 ${males} / 女 ${females});200 批抽樣覆蓋 ${seen.size} 個名字`);

  // =========================================================================
  // C. 寵物到來機率
  // =========================================================================
  check("寵物機率比 A 批之前(0.22)高", PET_CHANCE > 0.22, `PET_CHANCE=${PET_CHANCE}`);
  check("🔴 但仍然過半數應徵者沒有寵物(「他帶了一隻狗」還是一個資訊)",
    PET_CHANCE < 0.5, `PET_CHANCE=${PET_CHANCE}`);
  check("原始碼真的用了這個常數(不是留了常數卻還寫死 0.22)",
    /Math\.random\(\)\s*<\s*PET_CHANCE/.test(recruitSrc));

  const sample = Array.from({ length: 4000 }, () => generateApplicants("r1", [])).flat();
  const withPet = sample.filter((a) => a.pet).length;
  const rate = withPet / sample.length;
  check("實際抽樣的寵物率落在設定值 ±3%(常數真的生效)",
    Math.abs(rate - PET_CHANCE) < 0.03, `實測 ${(rate * 100).toFixed(1)}% vs 設定 ${(PET_CHANCE * 100).toFixed(0)}%`);
  check("自帶的寵物一定有名字、花色與物種(舊池缺 kind 才視為貓)",
    sample.filter((a) => a.pet).every((a) => !!a.pet!.name && Number.isInteger(a.pet!.color)
      && (a.pet!.kind === "cat" || a.pet!.kind === "dog")));
  const dogs = sample.filter((a) => a.pet?.kind === "dog").length;
  check("貓狗都抽得到(不是只有貓)", dogs > 0 && dogs < withPet, `狗 ${dogs} / 全部寵物 ${withPet}`);

  // 🔴 不爆量:一人一隻是硬上限
  const tenantIds = Object.keys(state.runtimes);
  check("測試前提:種子局有在住租客", tenantIds.length > 0);
  const target = tenantIds[0];
  const first = adoptPet(target, { name: "測試貓", color: 1, kind: "cat" });
  const second = adoptPet(target, { name: "第二隻", color: 2, kind: "dog" });
  check("🔴 一人最多一隻(第二次領養一律回 null)",
    (first !== null || !!state.pets[target]) && second === null);
  check("在住租客的寵物數硬上限 = 房間數(不會有人養兩隻)",
    Object.values(state.pets).filter((pet) => pet.ownerId !== HOUSE_PET_OWNER).length
      <= Object.keys(state.occupancy).length + Object.keys(state.cohabits).length + 1);

  // 🔴 不爆量:永久樓寵物名額滿了會自動轉中途,不會累積、也不會逼玩家一直手動送養
  const before = permanentHousePetEntries().length;
  for (let i = 0; i < 6; i++) {
    const id = `ghost_tenant_${i}`;
    state.pets[id] = {
      name: `幽靈寵${i}`, kind: i % 2 === 0 ? "cat" : "dog", color: 1,
      ownerId: id, hangout: "lounge", sinceMs: state.gameMs,
    };
  }
  repairOrphanPets(); // 飼主不在 runtime ⇒ 全部轉樓寵物
  check("🔴 永久樓寵物名額仍然是 2,超額一律自動轉中途媒合(不會爆量)",
    permanentHousePetEntries().length <= PERMANENT_HOUSE_PET_LIMIT,
    `permanent=${permanentHousePetEntries().length} limit=${PERMANENT_HOUSE_PET_LIMIT} before=${before}`);
  check("被轉中途的寵物都排進了媒合(不會卡在無主狀態)",
    Object.values(state.pets).filter((pet) => pet.ownerId === HOUSE_PET_OWNER
      && (pet.housePlacement ?? "permanent") !== "permanent")
      .every((pet) => typeof pet.rehomingAtMs === "number"));

  console.log(`   寵物率:實測 ${(rate * 100).toFixed(1)}%(設定 ${(PET_CHANCE * 100).toFixed(0)}%);`
    + `永久樓寵物 ${permanentHousePetEntries().length}/${PERMANENT_HOUSE_PET_LIMIT}`);
  console.log("   ⚠️ `adopt_cat` 行為指令只由 AI 事件選項帶進來(data/events.json 一則都沒有),");
  console.log("      離線/模板 fallback 時機率為 0 —— 詳見 scripts/pet-arrival-sim.ts 的說明。");
} finally {
  // 清掉測試造的幽靈寵物,避免污染同一個 process 內的後續斷言
  for (const id of Object.keys(state.pets)) if (id.startsWith("ghost_tenant_")) delete state.pets[id];
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
