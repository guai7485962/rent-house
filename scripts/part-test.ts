import { state, decide, fastForward, buyFurniture, sellFurnitureAt } from "../src/store";
import { sanitizeAiEvent } from "../src/sim/events";
import { getRel } from "../src/sim/social";
import { SCALE, currentGameMs } from "../src/sim/clock";
import { furnitureAt } from "../src/sim/placements";

console.log("========== Part 3:時間 7× ==========");
console.log(`SCALE = ${SCALE}(應為 7)`);
const g = currentGameMs(0, 0, 24 * 3600 * 1000); // 1 現實天後
console.log(`1 現實天 → 遊戲前進 ${g / 3600000} 遊戲小時(應為 168 = 7 天)`);

console.log("\n========== Part 1:跨租客事件消毒 ==========");
const roster = { 林小婕: "tenant_lin_asmr" };
const ev = sanitizeAiEvent(
  {
    title: "陳家豪對林小婕告白",
    description: "他鼓起勇氣了。",
    with: "林小婕",
    choices: [
      { label: "鼓勵他", hint: "推一把", effect: { mood: 10, other: { mood: 999, stress: -5 }, rel: { delta: 999, couple: true } } },
      { label: "勸他冷靜", hint: "先別急", effect: { mood: -3, rel: { delta: -5 } } },
    ],
  },
  roster,
);
console.log("with 解析:", ev?.withName, "→", ev?.withId);
console.log("other.mood 夾值(999→25):", ev?.choices[0].effect.other?.mood);
console.log("rel.delta 夾值(999→40):", ev?.choices[0].effect.rel?.delta);

const bad = sanitizeAiEvent({ title: "牽涉不存在的人", with: "王不存在", choices: [{ label: "a", hint: "", effect: { rel: { delta: 30 } } }, { label: "b", hint: "", effect: {} }] }, roster);
console.log("不存在鄰居 → withId:", bad?.withId, "/ rel 應被丟棄:", bad?.choices[0].effect.rel);

console.log("\n========== Part 1:跨租客套用 ==========");
const chen = state.runtimes["tenant_chen_engineer"];
const lin = state.runtimes["tenant_lin_asmr"];
const linStress0 = lin.tenant.stats.stress;
chen.pendingEvent = ev!;
chen.lastEventDay = -99;
decide("tenant_chen_engineer", "ai0", "鼓勵他");
const rel = getRel("tenant_chen_engineer", "tenant_lin_asmr");
console.log(`林小婕壓力 ${linStress0}→${lin.tenant.stats.stress}(other 生效)`);
console.log(`兩人關係值 ${Math.round(rel?.value ?? 0)} / 情侶 ${rel?.romantic}(取向相容→應成立)`);

console.log("\n========== Part 2:收支帳 ==========");
const money0 = state.money;
state.ledger.splice(0, state.ledger.length); // 清帳方便觀察
buyFurniture("tv_console", "r301"); // 支出
const f = furnitureAt(3, 6) ?? furnitureAt(4, 6);
if (f) sellFurnitureAt(f.c, f.r); // 收入(退半價)
fastForward(26); // 跨換日 → 租金 + 管理費
const sum = state.ledger.reduce((s, t) => s + t.amount, 0);
const cats = [...new Set(state.ledger.map((t) => t.category))];
console.log(`帳目 ${state.ledger.length} 筆,分類:${cats.join("、")}`);
console.log(`帳目加總 ${sum} == 餘額變化 ${state.money - money0}:${sum === state.money - money0 ? "✅ 一致" : "❌ 不一致"}`);
console.log("最近 3 筆:", state.ledger.slice(-3).map((t) => `${t.label} ${t.amount >= 0 ? "+" : ""}${t.amount}`).join(" / "));
