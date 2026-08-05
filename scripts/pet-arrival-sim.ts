/**
 * 🐾 寵物到來頻率實測(A 批,2026-08-05)。
 *
 * 使用者實玩回報「租客撿到寵物／帶寵物來太少見」。這支腳本回答一個問題:
 * **平均幾個遊戲日會有一隻寵物進到公寓?**
 *
 * ## 兩條到來路徑(程式碼實況)
 *
 * 1. **自帶寵物入住的應徵者** —— `recruit.generateApplicants()` 每位應徵者
 *    `Math.random() < PET_CHANCE` 決定,`tenancy.moveIn()` 呼叫 `adoptPet()`。
 *    這是**唯一有數值旋鈕**、也是實際上唯一會自己發生的路徑。
 * 2. **`adopt_cat` 行為指令** —— 只由 **AI 生成事件**的選項帶進來
 *    (`data/events.json` 的規則事件目錄**一則都沒有**,`observationEffects` 又明文
 *    把 `adopt_cat` 排除在自發行為之外)。⇒ 沒有金鑰/離線/走模板 fallback 時
 *    **這條路徑的機率是 0**,有 AI 時也完全取決於模型當天想不想寫這個選項。
 *
 * ## 量測方式
 *
 * 模擬一位「房間一空就馬上招租、而且一定挑第一位應徵者」的房東(對寵物到來
 * 頻率是**上界**),跑 `DAYS` 個遊戲日,數寵物出現次數。跑兩輪:
 * 一輪用舊機率、一輪用現行機率,直接對照「平均幾天一隻」。
 *
 * 用法:`npx tsx scripts/pet-arrival-sim.ts`
 */
import { PET_CHANCE } from "../src/sim/recruit";

const DAYS = 180;
const OLD_CHANCE = 0.22; // A 批之前的值
const ROOMS = ["r1", "r2", "r3", "r4"];
const PERMANENT_HOUSE_PET_LIMIT = 2;

/** 固定種子 PRNG(mulberry32);同一顆種子的兩輪只差在機率參數。 */
function makeRandom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一位租客住多久(遊戲日)。
 *
 * 不是憑空取的:`wishes.ts` 的圓夢畢業、`tenancy` 的請離/分手搬走加起來,實際觀察到的
 * 租期落在數十日的量級。這裡取 45~105 日的均勻分布(平均 75 日),對兩輪完全相同,
 * 所以「新舊對照」只反映機率參數本身的變化。
 */
const STAY_MIN = 45;
const STAY_SPAN = 61;

interface Result {
  pets: number;
  moveIns: number;
  daysPerPet: number;
  /** 任一時刻同時在樓裡的寵物數的最大值(含種子貓「橘子」)。 */
  peakPets: number;
  /** 飼主搬走時若玩家一律選「留下」,永久名額會被塞到幾隻。 */
  peakHousePets: number;
}

function run(chance: number, seed: number): Result {
  const random = makeRandom(seed);
  // 種子貓「橘子」(陳家豪的橘貓)開局就在,計入同時在樓的寵物數
  let livePets = 1;
  let housePets = 0;
  let pets = 0;
  let moveIns = 0;
  let peakPets = livePets;
  let peakHousePets = 0;
  // 開局四間房都有人;先各給一段剩餘租期
  const leaveDay = ROOMS.map(() => Math.floor(random() * STAY_SPAN) + STAY_MIN);
  const hasPet = ROOMS.map(() => false);

  for (let day = 1; day <= DAYS; day++) {
    for (let i = 0; i < ROOMS.length; i++) {
      if (day < leaveDay[i]) continue;
      // 退租:寵物跟著走;玩家若選「留下」才會變成樓寵物(這裡取最壞情況:全部留下)
      if (hasPet[i]) {
        livePets--;
        if (housePets < PERMANENT_HOUSE_PET_LIMIT) housePets++; // 超過名額會自動轉中途送養
        peakHousePets = Math.max(peakHousePets, housePets);
      }
      hasPet[i] = false;
      // 招租:generateApplicants() 生 3 位,玩家挑第一位(每位各擲一次寵物骰)
      const applicants = [random() < chance, random() < chance, random() < chance];
      moveIns++;
      if (applicants[0]) {
        hasPet[i] = true;
        pets++;
        livePets++;
      }
      leaveDay[i] = day + Math.floor(random() * STAY_SPAN) + STAY_MIN;
      peakPets = Math.max(peakPets, livePets + housePets);
    }
  }
  return {
    pets,
    moveIns,
    daysPerPet: pets === 0 ? Infinity : DAYS / pets,
    peakPets,
    peakHousePets,
  };
}

function summarise(label: string, chance: number) {
  const runs = Array.from({ length: 40 }, (_, i) => run(chance, 20260805 + i * 7919));
  const avg = (pick: (r: Result) => number) => runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;
  const finite = runs.filter((r) => Number.isFinite(r.daysPerPet));
  const daysPerPet = finite.length === 0
    ? Infinity
    : finite.reduce((sum, r) => sum + r.daysPerPet, 0) / finite.length;
  const dry = runs.filter((r) => r.pets === 0).length;
  console.log(
    `${label.padEnd(22)} 機率 ${(chance * 100).toFixed(0).padStart(2)}%`
    + ` │ ${DAYS} 日內平均 ${avg((r) => r.pets).toFixed(1)} 隻到來`
    + ` │ 平均 ${daysPerPet.toFixed(0)} 天一隻`
    + ` │ 同時在樓峰值 ${avg((r) => r.peakPets).toFixed(1)} 隻(最多 ${Math.max(...runs.map((r) => r.peakPets))})`
    + ` │ 永久樓寵物峰值 ${Math.max(...runs.map((r) => r.peakHousePets))}/${PERMANENT_HOUSE_PET_LIMIT}`
    + ` │ 整局零寵物的局數 ${dry}/${runs.length}`,
  );
  return { daysPerPet, peakPets: Math.max(...runs.map((r) => r.peakPets)), dry };
}

console.log(`🐾 寵物到來頻率實測(每組 40 局 × ${DAYS} 遊戲日,退租即刻招租、一律挑第一位應徵者)\n`);
const before = summarise("A 批之前", OLD_CHANCE);
const after = summarise("A 批之後(現行)", PET_CHANCE);
console.log("");
console.log(`▶ 平均幾天一隻:${before.daysPerPet.toFixed(0)} 天 → ${after.daysPerPet.toFixed(0)} 天`
  + `(縮短 ${(100 - (after.daysPerPet / before.daysPerPet) * 100).toFixed(0)}%)`);
console.log(`▶ 整局一隻寵物都沒有的局數:${before.dry}/40 → ${after.dry}/40`);
console.log(`▶ 同時在樓的寵物峰值:${before.peakPets} → ${after.peakPets} 隻`
  + `(四間房 + 種子貓的結構上界是 ${ROOMS.length + 1 + PERMANENT_HOUSE_PET_LIMIT} 隻,永久樓寵物名額 ${PERMANENT_HOUSE_PET_LIMIT} 由 pets.ts 自動把超額轉中途送養)`);
console.log("");
console.log("⚠️ `adopt_cat` 行為指令這條路徑沒有列入:它只由 AI 事件選項帶進來,");
console.log("   `data/events.json` 的規則事件目錄一則都沒有,離線/模板 fallback 時機率為 0。");
