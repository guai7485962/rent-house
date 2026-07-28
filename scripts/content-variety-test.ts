/**
 * 內建內容豐富度回歸：確保免費 fallback 句庫不會在後續重構時被縮回去，
 * 並驗證狀態型每日總結仍只需模板即可呈現壓力／低落／開心／社交差異。
 */
import {
  DAILY_HAPPY_TEMPLATES,
  DAILY_LOW_MOOD_TEMPLATES,
  DAILY_SOCIAL_TEMPLATES,
  DAILY_STRESS_TEMPLATES,
  DAILY_TEMPLATES,
  OBSERVATION_LINES,
} from "../src/content/observationLines";
import * as DREAM_LINES from "../src/content/dreamLines";
import { INTERACTIONS } from "../src/sim/interactions";
import { templateDiary, type NarrateCtx } from "../src/sim/narrate";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const observationEntries = Object.entries(OBSERVATION_LINES);
const observationCount = observationEntries.reduce((sum, [, lines]) => sum + (lines?.length ?? 0), 0);
check("每個觀察狀態至少 13 句", observationEntries.every(([, lines]) => (lines?.length ?? 0) >= 13));
check("每小時觀察句總數至少 220", observationCount >= 220, `count=${observationCount}`);
check("各狀態句庫內沒有重複句", observationEntries.every(([, lines]) => new Set(lines).size === lines?.length));
check("所有觀察句都是非空文字", observationEntries.every(([, lines]) => lines?.every((line) => line.trim().length >= 8)));

check("一般每日總結至少 24 句", DAILY_TEMPLATES.length >= 24, `count=${DAILY_TEMPLATES.length}`);
check("四種情境每日總結各至少 6 句", [DAILY_STRESS_TEMPLATES, DAILY_LOW_MOOD_TEMPLATES, DAILY_HAPPY_TEMPLATES, DAILY_SOCIAL_TEMPLATES].every((pool) => pool.length >= 6));

const base: NarrateCtx = {
  name: "測試員", occupation: "", bio: "", dayLabel: "第 3 天", coreTags: [], memoryTags: [],
  stats: { mood: 60, stress: 40, affinity: 55, satisfaction: 60 }, room: { noise: 0, soundproof: 0, treated: false, complaintRisk: false }, todayLog: [], relationships: [], events: [], neighbors: [],
  summary: "", arc: null, flags: [], eventDue: false,
};
const originalRandom = Math.random;
Math.random = () => 0.999999; // 一律抽候選池最後一句，精確驗證情境池有被加入
const stressDiary = templateDiary({ ...base, stats: { ...base.stats, stress: 85 } });
const lowDiary = templateDiary({ ...base, stats: { ...base.stats, mood: 25 } });
const happyDiary = templateDiary({ ...base, stats: { ...base.stats, mood: 85, stress: 30 } });
const socialDiary = templateDiary({ ...base, relationships: ["和鄰居阿明是好朋友"] });
Math.random = originalRandom;
const filledLast = (pool: string[]) => pool.at(-1)!.replace(/\{name\}/g, base.name).replace(/\{time\}/g, "夜裡");
check("高壓日記會使用高壓情境池", stressDiary.startsWith(filledLast(DAILY_STRESS_TEMPLATES)));
check("低落日記會使用低心情情境池", lowDiary.startsWith(filledLast(DAILY_LOW_MOOD_TEMPLATES)));
check("開心日記會使用正向情境池", happyDiary.startsWith(filledLast(DAILY_HAPPY_TEMPLATES)));
check("有鄰居互動時會使用社交情境池", socialDiary.startsWith(filledLast(DAILY_SOCIAL_TEMPLATES)));

const dreamPools = Object.entries(DREAM_LINES) as [string, string[]][];
const dreamCount = dreamPools.reduce((sum, [, lines]) => sum + lines.length, 0);
check("夢境句庫:至少 12 個主題池", dreamPools.length >= 12, `pools=${dreamPools.length}`);
check("夢境句庫:每個主題池至少 13 句", dreamPools.every(([, lines]) => lines.length >= 13), JSON.stringify(dreamPools.map(([k, v]) => `${k}=${v.length}`)));
check("夢境句庫:總數至少 150 句", dreamCount >= 150, `count=${dreamCount}`);
check("夢境句庫:各池內沒有重複句", dreamPools.every(([, lines]) => new Set(lines).size === lines.length));
const dreamAllLines = dreamPools.flatMap(([, lines]) => lines);
const dreamDupes = dreamAllLines.filter((line, i) => dreamAllLines.indexOf(line) !== i);
check("夢境句庫:跨池也沒有重複句", dreamDupes.length === 0, JSON.stringify([...new Set(dreamDupes)]));
check("夢境句庫:全部以 💤 前綴開頭且長度足夠", dreamPools.every(([, lines]) => lines.every((line) => line.startsWith("💤 ") && line.trim().length >= 12)));
check("夢境句庫:佔位符都能代換乾淨", dreamPools.every(([, lines]) => lines.every((line) =>
  !line.replace(/\{m\}/g, "失戀").replace(/\{o\}/g, "鄰居").replace(/\{tier\}/g, "好朋友").match(/[{}]/))));
check("夢境句庫:保底池不含任何佔位符", DREAM_LINES.DREAM_NEUTRAL_LINES.every((line) => !/[{}]/.test(line)));
// tierLabel 會回傳「陌生」「曖昧」等不能直接當名詞用的詞,一律用「」包住才不會讀成「只是陌生」。
const dreamTierLines = [...DREAM_LINES.DREAM_BOND_LINES, ...DREAM_LINES.DREAM_DISTANT_LINES].filter((line) => line.includes("{tier}"));
check("夢境句庫:{tier} 一律以「」包住(任何親疏值代入都通順)", dreamTierLines.length > 0 && dreamTierLines.every((line) => !/[^「]\{tier\}|\{tier\}[^」]/.test(line)), JSON.stringify(dreamTierLines));

check("每種雙人互動至少 3 條文案", INTERACTIONS.every((def) => def.lines.length >= 3));
check("雙人文案都能代換對方名字", INTERACTIONS.every((def) => def.lines.every((line) => !line.replace(/\{o\}/g, "鄰居").includes("{o}"))));
check("成人互動仍全數使用 hidden 遮蔽姿勢", INTERACTIONS.filter((def) => def.adult).every((def) => def.pose === "hidden"));

console.log(`\n內容統計:觀察 ${observationCount} 句 / 每日 ${DAILY_TEMPLATES.length + DAILY_STRESS_TEMPLATES.length + DAILY_LOW_MOOD_TEMPLATES.length + DAILY_HAPPY_TEMPLATES.length + DAILY_SOCIAL_TEMPLATES.length} 句 / 雙人 ${INTERACTIONS.reduce((sum, def) => sum + def.lines.length, 0)} 句 / 夢境 ${dreamCount} 句`);
console.log(`=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
