import { state, fastForward, unreadCount } from "../src/store";
import { roomAttributes } from "../src/sim/placements";

const before = state.money;
// 模擬遊戲 72 小時(3 天)
fastForward(72);

console.log(`遊戲時鐘:${new Date(state.gameMs).toLocaleString("zh-TW")}`);
console.log(`金錢:${before} → ${state.money}(3 天收租 +${state.money - before})`);
console.log(`301 房間屬性:`, roomAttributes("r301"));
console.log(`302 房間屬性:`, roomAttributes("r302"));
for (const rt of Object.values(state.runtimes)) {
  console.log(`\n== ${rt.tenant.name}(${rt.roomNo})  未讀 ${unreadCount(rt.tenant.id)} 筆 / 共 ${rt.log.length} 筆 ==`);
  for (const e of rt.log.slice(-8)) {
    console.log(`  ${e.timeLabel}  [${e.visualState}]${e.importance === "major" ? " ★偏離" : ""}  ${e.text}`);
  }
  const s = rt.tenant.stats;
  console.log(`  數值:心情 ${s.mood} / 壓力 ${s.stress} / 好感 ${s.affinity} / 整潔 ${rt.cleanliness}`);
}
