import { sanitizeAiEvent } from "../src/sim/events";

function show(label: string, raw: unknown) {
  const ev = sanitizeAiEvent(raw);
  console.log(`\n== ${label} ==`);
  console.log(ev ? JSON.stringify(ev, null, 0) : "→ null(拒絕)");
}

// 1. 正常 AI 事件
show("正常事件", {
  title: "陳家豪想收養那隻貓",
  description: "偷養的浪貓被鄰居發現了,他問你能不能正式養。",
  choices: [
    { label: "答應", hint: "他會很開心", effect: { mood: 10, affinity: 8, memory: { label: "[正式養貓]", hint: "貓成為房間固定成員" } } },
    { label: "拒絕", hint: "他會沮喪", effect: { mood: -8, affinity: -10 } },
  ],
});

// 2. 惡意:超大數值 + evict + 未知欄位 + 太多選項
show("惡意(超大值/evict/未知欄位/4選項)", {
  title: "X".repeat(200),
  description: "d",
  choices: [
    { label: "a", hint: "h", effect: { mood: 9999, money: -999999, evict: true, hackField: "rm -rf", affinity: -500 } },
    { label: "b", hint: "h", effect: { stress: -100 } },
    { label: "c", hint: "h", effect: {} },
    { label: "d(第4個應被砍)", hint: "h", effect: {} },
  ],
});

// 3. 不合格:只有 1 個選項 → 應回 null
show("只有 1 個選項", { title: "t", description: "d", choices: [{ label: "only", hint: "h", effect: {} }] });

// 4. 不合格:沒有 title / choices 非陣列
show("缺 title", { description: "d", choices: [] });
show("choices 非陣列", { title: "t", choices: "not-array" });

// 5. memory 格式不全 → 應丟棄 memory
show("memory 殘缺", {
  title: "t",
  description: "d",
  choices: [
    { label: "a", hint: "h", effect: { memory: { label: "[只有label]" } } },
    { label: "b", hint: "h", effect: { memory: { label: "[完整]", hint: "有指引" } } },
  ],
});
