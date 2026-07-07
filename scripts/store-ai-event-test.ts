import { state, decide } from "../src/store";
import { sanitizeAiEvent } from "../src/sim/events";

const chen = state.runtimes["tenant_chen_engineer"];
const mem0 = chen.tenant.memoryTags.length;
const aff0 = chen.tenant.stats.affinity;
const mood0 = chen.tenant.stats.mood;

// 模擬 AI 回傳、經消毒後設為待決事件
chen.pendingEvent = sanitizeAiEvent({
  title: "陳家豪想正式收養那隻浪貓",
  description: "貓被鄰居發現了,他鼓起勇氣問你能不能養。",
  choices: [
    { label: "答應收養", hint: "他會很開心", effect: { mood: 12, affinity: 10, memory: { label: "[正式養貓]", hint: "貓成為房間固定成員,他心情更穩定" } } },
    { label: "拒絕", hint: "他會失落", effect: { mood: -10, affinity: -8 } },
  ],
});
console.log("待決事件:", chen.pendingEvent?.title, "/ ai =", chen.pendingEvent?.ai);

// 玩家選「答應收養」
decide("tenant_chen_engineer", "ai0", "答應收養");

console.log(`\n選「答應收養」後:`);
console.log(`  pendingEvent 清空:${chen.pendingEvent === null}`);
console.log(`  好感 ${aff0}→${chen.tenant.stats.affinity}(+10)`);
console.log(`  心情 ${mood0}→${chen.tenant.stats.mood}(+12,夾在 100 內)`);
console.log(`  記憶標籤 ${mem0}→${chen.tenant.memoryTags.length} 個`);
const newTag = chen.tenant.memoryTags[chen.tenant.memoryTags.length - 1];
console.log(`  新增記憶:${newTag.label}(來源 ${newTag.source})`);
console.log(`  決策日誌:${chen.log[chen.log.length - 1].decisionNote}`);
