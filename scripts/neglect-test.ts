/**
 * 虧待度(neglect)機件與四條掛載點的驗證。
 *
 * 背景:`rollEvent()` 的四則根事件從來沒觸發過,病根是**遊戲裡沒有任何「房東虧待房客」
 * 會持續推動數值的管道**——所有懲罰都是脈衝,而 stress/wellbeing/satisfaction/affinity
 * 四條數值全部有回歸,脈衝會被抹平(熱水器壞六天不修,滿意度長期只掉約 2 點、好感 0 點;
 * 修好一次卻永久 +5)。`neglectPoints()` 就是補上那條管道。
 *
 * 本檔釘住四件事:
 *   1. 🔴 **裁決 A 的回歸鎖**:沒有任何旗標、只靠故障拖延天數,也要能到達設計上限
 *   2. 四條掛載點的**單位效果**(每條數值的回歸速度不同,倍率不可共用一組常數)
 *   3. **可逆性**:修好之後立刻回 0
 *   4. **零影響守衛**:無虧待時所有新項恆為 0,舊呼叫端逐位元不變
 */

// 固定種子:第 6 節要跑真的 tick,量測不能被亂數序列左右(必須在載入 store 之前)
let seed = 20260827;
Math.random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { state, debugStepHour } = await import("../src/store");
const { roomOfTenant } = await import("../src/sim/gameState");
const {
  neglectPoints, NEGLECT_CAP, NEGLECT_AFFINITY_PER_DAY, maintenancePass, repairBreakdown, triggerBreakdown,
} = await import("../src/sim/maintenance");
const { baselines } = await import("../src/sim/tick");
const { satisfactionTarget, NEGLECT_SATISFACTION_PER_POINT } = await import("../src/sim/satisfaction");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}`); }
}

const DAY_MS = 24 * 3600 * 1000;
const chen = state.runtimes["tenant_chen_engineer"];
const chenRoom = roomOfTenant(chen.tenant.id)!;

/** 把一件故障種在指定房間,並把「壞掉時間」倒推 days 個遊戲日 */
function breakFor(roomId: string, days: number) {
  state.breakdowns[roomId] = { defId: "water_heater", cost: 1500, sinceMs: state.gameMs - days * DAY_MS };
}
function clearBreakdowns() {
  for (const k of Object.keys(state.breakdowns)) delete state.breakdowns[k];
}
function clearFlags() {
  chen.flags.splice(0, chen.flags.length);
}

// ---------------------------------------------------------------------------
// 1. neglectPoints 各分支
// ---------------------------------------------------------------------------
clearBreakdowns();
clearFlags();
check("無故障、無旗標 ⇒ 0(無虧待時恆等於 0)", neglectPoints(chen) === 0);

breakFor(chenRoom, 0);
check("剛壞掉的當下 ⇒ 0(拖延還沒開始)", neglectPoints(chen) === 0);
breakFor(chenRoom, 1);
check("壞了 1 個遊戲日 ⇒ 1", neglectPoints(chen) === 1);
breakFor(chenRoom, 3);
check("壞了 3 個遊戲日 ⇒ 3", neglectPoints(chen) === 3);

// 🔴 裁決 A 的回歸鎖 -------------------------------------------------------
// 原設計把上限訂成「故障拖延最多 4 分 + 答應改善房間旗標 2 分」,但那個旗標的唯一來源是
// 玩家在 `dissatisfied` 事件選 `promise`,而 `dissatisfied` 又要靠虧待度到頂才觸發:
//     n=6 需要旗標 → 旗標需要 dissatisfied 觸發 → dissatisfied 需要 n=6
// 循環相依 ⇒ 三則事件的可達性證明全部落空。這一條就是防止它復發的鎖。
clearFlags();
breakFor(chenRoom, NEGLECT_CAP);
check(
  `🔴 裁決 A:**沒有任何旗標**、只靠故障拖延 ${NEGLECT_CAP} 個遊戲日,就能到設計上限 ${NEGLECT_CAP}`,
  chen.flags.length === 0 && neglectPoints(chen) === NEGLECT_CAP,
);
breakFor(chenRoom, NEGLECT_CAP + 20);
check(`拖再久也封頂在 ${NEGLECT_CAP}(不會無限上綱)`, neglectPoints(chen) === NEGLECT_CAP);

// 旗標只能當**加速器**:讓玩家更快到頂,不得是到頂的必要條件
clearFlags();
breakFor(chenRoom, 2);
const beforeFlag = neglectPoints(chen);
chen.flags.push("答應改善房間");
const afterFlag = neglectPoints(chen);
check(`「答應改善房間」空頭支票 +2(${beforeFlag} → ${afterFlag})`, afterFlag === beforeFlag + 2);
clearBreakdowns();
check("只有旗標、沒有故障 ⇒ 2(旗標自己到不了上限,只是加速器)", neglectPoints(chen) === 2);
clearFlags();

// 「什麼都沒做也會發生」的來源一律排除:沒故障、沒旗標就是 0,
// 不管房東多久沒送宵夜、多久沒互動。
chen.lastCareDay = -999;
check("很久沒送宵夜/沒互動也**不算**虧待(每一分都要來自明確通知或親手按過的按鈕)", neglectPoints(chen) === 0);

// ---------------------------------------------------------------------------
// 2. 可逆性:修好之後立刻回 0
// ---------------------------------------------------------------------------
clearBreakdowns();
clearFlags();
breakFor(chenRoom, NEGLECT_CAP);
state.money = 999_999;
check("(前提)修之前是上限", neglectPoints(chen) === NEGLECT_CAP);
const repaired = repairBreakdown(chenRoom);
check("repairBreakdown() 之後 neglectPoints 立刻回 0(虧待度可逆)", repaired.ok && neglectPoints(chen) === 0);

// triggerBreakdown() 走真正的入口也要能被算到(不是只有測試手動塞的才算)
clearBreakdowns();
check("triggerBreakdown() 真正入口也計入", triggerBreakdown(chenRoom, "leak", () => 0.5) && neglectPoints(chen) === 0);
state.breakdowns[chenRoom].sinceMs = state.gameMs - 2 * DAY_MS;
check("真正入口 + 拖 2 日 ⇒ 2", neglectPoints(chen) === 2);

// ---------------------------------------------------------------------------
// 3. 掛載點 ①:stress 掛 baselines()(回歸 6%/h ⇒ ×1)
// ---------------------------------------------------------------------------
clearBreakdowns();
clearFlags();
const baseStress0 = baselines(chen).stress;
breakFor(chenRoom, NEGLECT_CAP);
const baseStressN = baselines(chen).stress;
check(
  `虧待度推高壓力基準(n=0 ${baseStress0.toFixed(1)} → n=${NEGLECT_CAP} ${baseStressN.toFixed(1)})`,
  baseStressN > baseStress0,
);
check("壓力基準仍夾在 10~90 之內", baseStressN <= 90 && baseStressN >= 10);
clearBreakdowns();
check("修好後壓力基準立刻回到原值(逐位元)", baselines(chen).stress === baseStress0);

// ---------------------------------------------------------------------------
// 4. 掛載點 ②:satisfaction 掛 target(回歸 20%/h ⇒ 掛脈衝只剩 ×0.21,必須掛 target)
// ---------------------------------------------------------------------------
const stats = chen.tenant.stats;
const t0 = satisfactionTarget(stats, 1);
const tN = satisfactionTarget(stats, 1, NEGLECT_CAP);
check(
  `虧待度壓低滿意度目標(n=0 ${t0.toFixed(1)} → n=${NEGLECT_CAP} ${tN.toFixed(1)},每點 −${NEGLECT_SATISFACTION_PER_POINT})`,
  Math.abs(t0 - tN - NEGLECT_SATISFACTION_PER_POINT * NEGLECT_CAP) < 1e-9 || tN === 0,
);
// 🔴 零影響守衛:第三參數預設 0 ⇒ 舊呼叫端逐位元相同
check("零影響守衛:satisfactionTarget(s, nm) 與 (s, nm, 0) 逐位元相同",
  [0, 0.25, 0.5, 0.75, 1].every((nm) => satisfactionTarget(stats, nm) === satisfactionTarget(stats, nm, 0)));
check("虧待度不會把目標壓成負數(仍夾在 0~100)", satisfactionTarget({ ...stats, mood: 0, affinity: 0, stress: 100, wellbeing: 0, energy: 0 }, 0, NEGLECT_CAP) >= 0);

// ---------------------------------------------------------------------------
// 5. 掛載點 ③:affinity 掛每日一次(**無回歸** ⇒ 掛每小時等於 ×24,兩天歸零)
// ---------------------------------------------------------------------------
clearBreakdowns();
clearFlags();
stats.affinity = 60;
maintenancePass(() => 0.99); // 0.99 > BREAK_CHANCE ⇒ 不會擲出新故障
check(`無虧待時 maintenancePass 不動好感(60 → ${stats.affinity})`, stats.affinity === 60);

breakFor(chenRoom, NEGLECT_CAP);
stats.affinity = 60;
maintenancePass(() => 0.99);
const expected = 60 - NEGLECT_AFFINITY_PER_DAY * NEGLECT_CAP;
check(
  `虧待每日侵蝕好感(60 → ${stats.affinity.toFixed(2)},預期 ${expected.toFixed(2)})`,
  Math.abs(stats.affinity - expected) < 1e-9,
);
// 對稱性:及時修繕是 affinity +5(永久),虧待這一側原本是 0 —— 這裡把不對稱補平
check(
  `虧待滿 ${NEGLECT_CAP} 日流失的好感(${(NEGLECT_AFFINITY_PER_DAY * NEGLECT_CAP * NEGLECT_CAP).toFixed(1)})與「及時修繕 +5」量級相當`,
  NEGLECT_AFFINITY_PER_DAY * NEGLECT_CAP * NEGLECT_CAP >= 5,
);

// ---------------------------------------------------------------------------
// 6. 掛載點 ④:wellbeing 掛每小時增量(回歸只有 1%/h ⇒ ×100;掛 wbAnchor 只有 ×1)
// ---------------------------------------------------------------------------
// 作息是 24 小時循環,所以拿**連續兩個 24 小時窗**對照:第一窗無虧待、第二窗虧待到頂。
chen.lastEventDay = 999_999; // 擋掉事件,免得 pendingEvent 把租客凍住、跳過 applyStat
state.money = 999_999;
clearBreakdowns();
clearFlags();
stats.stress = 40;
stats.wellbeing = 80;
const wbA0 = stats.wellbeing;
for (let i = 0; i < 24; i++) debugStepHour();
const dropClean = wbA0 - stats.wellbeing;

clearBreakdowns();
breakFor(chenRoom, NEGLECT_CAP);
stats.stress = 40;
stats.wellbeing = 80;
const wbB0 = stats.wellbeing;
for (let i = 0; i < 24; i++) {
  breakFor(chenRoom, NEGLECT_CAP); // 每小時重壓 sinceMs,讓整個窗都維持在上限
  debugStepHour();
}
const dropNeglect = wbB0 - stats.wellbeing;
// 每小時 −0.03 × 6 = −0.18 ⇒ 24 小時約 −4.3(扣掉 1%/h 回歸把一部分拉回來)
check(
  `虧待度侵蝕身心健康(乾淨 24h 掉 ${dropClean.toFixed(2)} → 虧待 24h 掉 ${dropNeglect.toFixed(2)})`,
  dropNeglect > dropClean + 2,
);
clearBreakdowns();
clearFlags();

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
