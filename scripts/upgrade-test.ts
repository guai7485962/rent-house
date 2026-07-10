/**
 * 房間升級階梯(設計檢討 7-1)驗證:
 * 購買/擋重複/擋沒錢 / 屬性疊加 / 應徵者租金行情與星等 / 在住租客加成與記憶 / 談漲租容忍度提升
 */
import { state, buyUpgrade, previewRent, getApplicants } from "../src/store";
import { roomAttributes } from "../src/sim/placements";
import { roomUpgradeIds, upgradeRentBonus, UPGRADES } from "../src/sim/upgrades";
import { generateApplicants } from "../src/sim/recruit";

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

const money0 = state.money;
const soundproof = UPGRADES.find((u) => u.id === "soundproof_reno")!;

// --- 1. 空房改建:購買 / 擋重複 / 擋沒錢 ---
const before303 = roomAttributes("r303").soundproof ?? 0;
const r1 = buyUpgrade("r303", "soundproof_reno");
check("空房 303 改建成功", r1.ok);
check("錢有扣", state.money === money0 - soundproof.price);
check("帳目類別 = upgrade", state.ledger.at(-1)?.category === "upgrade");
check("已安裝清單有記錄", roomUpgradeIds("r303").includes("soundproof_reno"));
check("重複改建被擋", !buyUpgrade("r303", "soundproof_reno").ok);
check("未知改建被擋", !buyUpgrade("r303", "gold_toilet").ok);
const moneyBak = state.money;
state.money = 100;
check("沒錢被擋", !buyUpgrade("r303", "premium_reno").ok);
state.money = moneyBak;

// --- 2. 屬性疊加 ---
check(`303 隔音屬性 +8(${before303} → ${roomAttributes("r303").soundproof}`, (roomAttributes("r303").soundproof ?? 0) === before303 + 8);

// --- 3. 應徵者租金行情與星等 ---
const apps = generateApplicants("r303");
check("應徵者租金含行情加成(baseRent × 1.12 取整百)", apps.every((a) => a.monthlyRent === Math.round((a.baseRent! * 1.12) / 100) * 100));
const apps304 = generateApplicants("r304"); // 未改建對照組
check("未改建房間租金無加成", apps304.every((a) => a.monthlyRent === Math.round(a.baseRent! / 100) * 100));
// 既有的池(getApplicants)也會被 rescore 吃到加成
const pool = getApplicants("r303");
check("既有應徵者池 rescore 後也吃到行情", pool.every((a) => a.monthlyRent === Math.round(((a.baseRent ?? a.monthlyRent) * 1.12) / 100) * 100));
check(`upgradeRentBonus 合計正確(${upgradeRentBonus("r303")})`, upgradeRentBonus("r303") === 0.12);

// --- 4. 在住租客的房間改建:滿意/心情↑ + 記憶 ---
const chen = state.runtimes["tenant_chen_engineer"];
const sat0 = chen.satisfaction;
const r2 = buyUpgrade("r301", "premium_reno");
check("在住房 301 改建成功", r2.ok);
check("滿意度上升", chen.satisfaction > sat0);
check("留下改建記憶", chen.tenant.memoryTags.some((m) => m.label.includes("精裝修")));
check("改建日誌已寫入", chen.log.some((e) => e.text.includes("精裝修")));

// --- 5. 談漲租容忍度提升:同條件下,改建後的房不再被拒 ---
chen.satisfaction = 60;
chen.tenant.stats.affinity = 60;
chen.rentChangeDay = -99;
// 容忍度基礎 = (60*0.5+60*0.5-35)/200 = 0.125;301 已裝精裝修 +0.07 → 0.195
const rent = chen.tenant.finance.monthlyRent;
const pv = previewRent(chen.tenant.id, Math.round(rent * 1.16));
check(`+16% 提案:精裝修加持下不會被拒(verdict=${pv?.verdict})`, pv !== null && pv.verdict !== "reject");
// 對照:把加成拿掉(303 沒住人不影響;直接算 0.125 < 0.16 會被拒)
const lin = state.runtimes["tenant_lin_asmr"];
lin.satisfaction = 60;
lin.tenant.stats.affinity = 60;
lin.rentChangeDay = -99;
const linRent = lin.tenant.finance.monthlyRent;
const pvLin = previewRent(lin.tenant.id, Math.round(linRent * 1.16));
check(`對照組(302 未改建)+16% 會被拒(verdict=${pvLin?.verdict})`, pvLin !== null && pvLin.verdict === "reject");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
