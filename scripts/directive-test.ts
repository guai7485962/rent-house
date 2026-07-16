/**
 * 行為指令白名單(設計檢討 7-2)驗證:
 * 消毒白名單 / 作息位移 / 逗貓+貓 prop / hermit 迴避交誼廳 / social 泡交誼廳 /
 * 事件抉擇授予指令 / 到期恢復
 */
import { state, debugInit, debugStepHour, decide } from "../src/store";
import { sanitizeDirective, DIRECTIVES } from "../src/sim/directives";
import { sanitizeAiEvent } from "../src/sim/events";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

const chen = state.runtimes["tenant_chen_engineer"];
const lin = state.runtimes["tenant_lin_asmr"];
const GAME_START = new Date("2026-07-05T22:00:00+08:00").getTime();
const day = () => Math.floor((state.gameMs - GAME_START) / (24 * 3600 * 1000));
function setHour(h: number) {
  const d = new Date(state.gameMs);
  d.setHours(h, 0, 0, 0);
  state.gameMs = d.getTime();
}
// 避免壓力偏離干擾行為判定
chen.tenant.stats.stress = 40;
lin.tenant.stats.stress = 30;
chen.tenant.memoryTags = [];

// --- 1. 消毒白名單 ---
check("未知指令 id → 丟棄", sanitizeDirective({ id: "hack_the_world", days: 3 }) === null);
check("days 夾 1~7(99→7)", sanitizeDirective({ id: "night_owl", days: 99 })?.days === 7);
check("沒給 days → 用預設", sanitizeDirective({ id: "adopt_cat" })?.days === DIRECTIVES.adopt_cat.defaultDays);
const aiEv = sanitizeAiEvent({
  title: "測試",
  description: "",
  choices: [
    { label: "壞指令", hint: "", effect: { directive: { id: "teleport", days: 3 } } },
    { label: "好指令", hint: "", effect: { directive: { id: "binge_watch", days: 99 } } },
  ],
});
check("AI 事件:未知指令被丟棄", aiEv !== null && aiEv.choices[0].effect.directive === undefined);
check("AI 事件:合法指令保留且 days 夾 7", aiEv !== null && aiEv.choices[1].effect.directive?.id === "binge_watch" && aiEv.choices[1].effect.directive.days === 7);

// --- 2. night_owl 作息位移:陳家豪 06 點本該睡覺,熬夜中應仍在工作(03 點的作息) ---
chen.directive = { id: "night_owl", untilDay: day() + 3 };
setHour(6);
debugInit();
check(`熬夜位移:06 點在做 03 點的事(${chen.tenant.visualState})`, chen.tenant.visualState === "working_at_desk");
chen.directive = null;
debugInit();
check("清掉指令後 06 點恢復睡覺", chen.tenant.visualState === "sleeping_on_bed");

// --- 3. adopt_cat:20 點插入逗貓 + 房裡有貓 prop ---
chen.directive = { id: "adopt_cat", untilDay: day() + 5 };
setHour(20);
debugInit();
check(`逗貓時段生效(${chen.tenant.visualState})`, chen.tenant.visualState === "playing_with_cat");
check("貓 prop 出現", chen.roomProps.includes("cat_on_table"));
setHour(21); // 非逗貓時段:貓睡沙發
debugInit();
check("其他時段貓睡沙發", chen.roomProps.includes("cat_sleeping_on_couch"));

// --- 4. hermit:陳家豪 13 點原本去交誼廳沙發逗貓 → 改在自房發呆 ---
chen.directive = null;
setHour(13);
debugInit();
const wasInLounge = chen.inLounge;
chen.directive = { id: "hermit", untilDay: day() + 3 };
debugInit();
check("hermit 前 13 點確實在交誼廳(前提)", wasInLounge === true);
check(`hermit 後改在自房發呆(${chen.tenant.visualState})`, chen.tenant.visualState === "idle" && !chen.inLounge);
chen.directive = null;

// --- 5. social:林小婕 20 點原本在自房準備直播 → 跑去交誼廳看電視 ---
setHour(20);
debugInit();
const before = lin.tenant.visualState;
lin.directive = { id: "social", untilDay: day() + 3 };
debugInit();
check(`social 前 20 點在自房(${before})`, before === "idle");
check(`social 後泡交誼廳(${lin.tenant.visualState})`, lin.tenant.visualState === "watching_tv" && lin.inLounge);
lin.directive = null;

// --- 5b. 自發行為新指令(觀察回饋第二期)的作息接線 ---
setHour(20);
lin.directive = { id: "overtime", untilDay: day() + 2, source: "ai" };
debugInit();
check(`overtime:20 點釘在書桌前趕工(${lin.tenant.visualState})`, lin.tenant.visualState === "working_at_desk");
lin.directive = { id: "self_care", untilDay: day() + 2, source: "ai" };
setHour(22);
debugInit();
check(`self_care:22 點提早上床(${lin.tenant.visualState})`, lin.tenant.visualState === "sleeping_on_bed");
lin.directive = null;
setHour(13);
chen.directive = { id: "sulk", untilDay: day() + 2, source: "ai" };
debugInit();
check(`sulk:13 點不去交誼廳、待在自房(${chen.tenant.visualState})`, chen.tenant.visualState === "idle" && !chen.inLounge);
chen.directive = null;

// --- 6. 事件抉擇授予指令 ---
lin.pendingEvent = {
  id: "t",
  title: "測試事件",
  description: "",
  choices: [{ id: "c1", label: "去追劇", hint: "", effect: { directive: { id: "binge_watch", days: 2 } } }],
};
decide(lin.tenant.id, "c1", "去追劇");
check("抉擇後指令生效", lin.directive?.id === "binge_watch" && lin.directive.untilDay === day() + 2);
check("生效日誌已寫入", lin.log.some((e) => e.text === DIRECTIVES.binge_watch.startText));

// --- 7. 到期恢復 ---
lin.directive = { id: "binge_watch", untilDay: day() - 1 };
debugStepHour();
check("過期後指令清除", lin.directive === null);
check("恢復日誌已寫入", lin.log.some((e) => e.text === DIRECTIVES.binge_watch.endText));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
