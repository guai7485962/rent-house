/**
 * 廚房／冰箱生活劇情驗證：
 * - 冰箱食物失蹤會留下雙方伏筆，下一次由同一配對收尾並清旗標
 * - 瓦斯爐＋流理臺＋餐桌依關係演成合作料理或廚房口角
 * - 咖啡機產生低強度善意，且所有事件都在實際家具前建立雙人演出
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { COMMUNITY_EVENTS, kitchenStageTiles } = await import("../src/sim/community");
const { relationships, pairKey, getRel } = await import("../src/sim/social");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const { state } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

if (!state.occupancy.r303) moveIn("r303", generateApplicants("r303")[0]);
if (!state.occupancy.r304) moveIn("r304", generateApplicants("r304")[0]);
const rts = Object.values(state.runtimes);
const [A, B] = rts;
for (const rt of rts) {
  rt.tenant.visualState = "idle";
  rt.pendingEvent = null;
  rt.flags.splice(0);
}

const ev = (id: string) => COMMUNITY_EVENTS.find((e) => e.id === id)!;
const fridge = ev("kitchen_fridge");
const cook = ev("kitchen_cook");
const coffee = ev("morning_coffee");
const relVal = () => getRel(A.tenant.id, B.tenant.id)?.value ?? 0;

check("廚房三種生活事件已登錄", !!fridge && !!cook && !!coffee);
check("冰箱有可達的雙人演出格", kitchenStageTiles("fridge") != null);
check("流理臺有可達的雙人演出格", kitchenStageTiles("counter") != null);
check("咖啡機有可達的雙人演出格", kitchenStageTiles("coffee_machine") != null);
check("家具齊全時三種事件都能選出兩人",
  fridge.select(rts, () => 0.2)?.length === 2
  && cook.select(rts, () => 0.2)?.length === 2
  && coffee.select(rts, () => 0.2)?.length === 2);

// --- 冰箱第一幕：失蹤與猜疑 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 20, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
clearPairSessions();
const beforeMissing = relVal();
fridge.fire([A, B], () => 0);
const missingFlag = `冰箱食物失蹤:${B.tenant.id}`;
const suspectFlag = `被懷疑偷吃:${A.tenant.id}`;
check("冰箱失蹤：失主留下指向被懷疑者的伏筆", A.flags.includes(missingFlag));
check("冰箱失蹤：被懷疑者留下對應伏筆", B.flags.includes(suspectFlag));
check("冰箱失蹤：關係下降", relVal() < beforeMissing);
check("冰箱失蹤：雙方都有冰箱衝突日誌", A.log.some((l) => /冰箱|布丁|飲料|蛋糕|外送/.test(l.text)) && B.log.some((l) => /冰箱|質問|空瓶|空盒/.test(l.text)));
check("冰箱失蹤：兩人走到家具前演出", !!sessionFor(A.tenant.id, state.gameMs) && A.tenant.visualState === "eating" && B.tenant.visualState === "eating");

// select 應優先把未完的同一對找回來，而不是換人演第二幕。
const pendingPair = fridge.select([rts[2], B, A, rts[3]], () => 0.8);
check("冰箱伏筆：下一幕鎖定原失主與被懷疑者", pendingPair?.[0] === A && pendingPair?.[1] === B);

// --- 冰箱第二幕：真相與收尾 ---
A.log.splice(0); B.log.splice(0);
const beforeTruth = relVal();
fridge.fire([A, B], () => 0);
check("冰箱真相：雙方伏筆都被消耗", !A.flags.includes(missingFlag) && !B.flags.includes(suspectFlag));
check("冰箱真相：說開後關係回升", relVal() > beforeTruth);
check("冰箱真相：日誌明確收束誤會", A.log.some((l) => /找到|誤會|坦白|紙條/.test(l.text)) && B.log.some((l) => /道歉|誤會|承認|格位/.test(l.text)));

// --- 高關係冰箱分享：不一定進衝突線 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 65, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const beforeShare = relVal();
fridge.fire([A, B], () => 0.9);
check("冰箱分享：高關係配對可直接演友善日常", relVal() > beforeShare && !A.flags.some((f) => f.startsWith("冰箱食物失蹤:")));

// --- 一起料理：好關係合作、差關係口角 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 60, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
clearPairSessions();
const beforeCook = relVal();
cook.fire([A, B], () => 0);
check("合作料理：關係與心情上升", relVal() > beforeCook && A.tenant.stats.mood > 0 && B.tenant.stats.mood > 0);
check("合作料理：兩人在流理臺前用 cook_pair 演出", sessionFor(A.tenant.id, state.gameMs)?.pose === "cook_pair" && A.tenant.visualState === "cooking");
check("合作料理：雙方都有料理日誌", A.log.some((l) => /切菜|食材|餃子|掌廚/.test(l.text)) && B.log.some((l) => /切菜|食材|餃子|掌廚/.test(l.text)));

relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 20, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
const beforeClash = relVal();
cook.fire([A, B], () => 0);
check("廚房口角：低關係配對會繼續下降", relVal() < beforeClash);
check("廚房口角：雙方日誌呈現不同視角", A.log.some((l) => /流理臺|調味|髒鍋|食材/.test(l.text)) && B.log.some((l) => /廚房|鍋|流理臺|食材/.test(l.text)));

// --- 咖啡機：低強度修復 ---
relationships[pairKey(A.tenant.id, B.tenant.id)] = { value: 30, romantic: false, cohabitOffered: false };
A.log.splice(0); B.log.splice(0);
clearPairSessions();
const beforeCoffee = relVal();
coffee.fire([A, B], () => 0);
check("咖啡善意：關係小幅回溫", relVal() === beforeCoffee + 1);
check("咖啡善意：兩人在咖啡機前演出", !!sessionFor(A.tenant.id, state.gameMs) && A.tenant.visualState === "using_appliance");
check("咖啡善意：雙方都有咖啡日誌", A.log.some((l) => l.text.includes("咖啡")) && B.log.some((l) => l.text.includes("咖啡")));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
