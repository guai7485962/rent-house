/** AI 房東抉擇品質回歸：鎖住玩家截圖中的簡體、驅逐、收養租客與掛錯人物案例。 */
import { sanitizeAiEvent } from "../src/sim/events";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const owner = "陳家豪";
const roster = { 邱柏翰: "tenant_chiu", 林小婕: "tenant_lin" };

const screenshotFixture = {
  title: "保护橘子",
  description: "橘子对邱柏翰产生了依恋,可能影响其生存安全",
  choices: [
    { label: "收养邱柏翰", hint: "保护橘子", effect: { mood: 5 } },
    { label: "驱逐邱柏翰", hint: "保护橘子", effect: { evict: true } },
    { label: "继续加班", hint: "工作狂模式", effect: { stress: 5 } },
  ],
};
check("截圖案例：整個怪異事件被拒絕", sanitizeAiEvent(screenshotFixture, roster, owner) === null);

const traditional = sanitizeAiEvent({
  title: "邻居来敲门",
  description: "林小婕对陈家豪说,保护猫咪也要顾虑邻居。",
  with: "林小婕",
  choices: [
    { label: "答应沟通", hint: "让他们把话说开", effect: { memory: { label: "[学会沟通]", hint: "关系恢复" } } },
    { label: "暂时拒绝", hint: "之后再问", effect: {} },
  ],
}, roster, owner);
check("事件四類文案：簡體統一轉繁體", !!traditional
  && traditional.title === "鄰居來敲門"
  && traditional.description.includes("林小婕對陳家豪說")
  && traditional.choices[0].label === "答應溝通"
  && traditional.choices[0].hint === "讓他們把話說開",
  JSON.stringify(traditional));
check("事件 effect 記憶文案也走相同語言閘門", traditional?.choices[0].effect.memory?.label === "[學會溝通]" && traditional?.choices[0].effect.memory?.hint === "關係恢復");

const unsafeMemory = sanitizeAiEvent({
  title: "租約討論", description: "陳家豪想聽聽房東的意見。",
  choices: [
    { label: "先答應", hint: "觀察後續", effect: { memory: { label: "[房東承諾]", hint: "之後驅逐邱柏翰" } } },
    { label: "先拒絕", hint: "保持距離", effect: {} },
  ],
}, roster, owner);
check("effect 記憶：禁用語意與錯置姓名同樣拒絕整個事件", unsafeMemory === null);

const strayTenant = sanitizeAiEvent({
  title: "工作上的煩惱",
  description: "邱柏翰突然跑來要求林小婕替他處理工作。",
  with: "林小婕",
  choices: [
    { label: "請他們談談", hint: "把問題說清楚", effect: {} },
    { label: "先不介入", hint: "觀察後續", effect: {} },
  ],
}, roster, owner);
check("姓名一致性：出現非 owner／with 的在住租客就拒絕", strayTenant === null);

const validCrossTenant = sanitizeAiEvent({
  title: "深夜談心",
  description: "陳家豪想和林小婕談談最近的誤會。",
  with: "林小婕",
  choices: [
    { label: "借出交誼廳", hint: "讓兩人好好聊", effect: { rel: { delta: 4 } } },
    { label: "不要介入", hint: "讓他們自己決定", effect: {} },
  ],
}, roster, owner);
check("姓名一致性：owner + with 的正常跨租客事件保留", validCrossTenant?.withId === "tenant_lin");

const petAdoption = sanitizeAiEvent({
  title: "浪貓的去留",
  description: "陳家豪想正式收養門口那隻橘貓。",
  choices: [
    { label: "答應養貓", hint: "房裡會多一位小成員", effect: { directive: { id: "adopt_cat", days: 3 } } },
    { label: "暫時拒絕", hint: "請他再想清楚", effect: {} },
  ],
}, roster, owner);
check("收養寵物仍合法，不會被收養租客規則誤殺", petAdoption !== null);

for (const word of ["驅逐", "趕走", "退租"]) {
  const ev = sanitizeAiEvent({
    title: "租約爭議", description: "兩人對處理方式沒有共識。",
    choices: [
      { label: `${word}租客`, hint: "立即處理", effect: {} },
      { label: "再談談", hint: "找別的方法", effect: {} },
    ],
  }, roster, owner);
  check(`禁用語意：${word} 出現在文案就拒絕整個事件`, ev === null);
}

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
