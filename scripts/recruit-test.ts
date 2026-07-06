import { state, buyFurniture, moveIn, isVacant, fastForward, unreadCount } from "../src/store";
import { generateApplicants } from "../src/sim/recruit";

console.log(`303 空房?${isVacant("r303")}  租客總數 ${Object.keys(state.runtimes).length}`);

// 1. 裝潢 303:電競桌 + 電視(拉高 tech,吸引學生/電競型)
buyFurniture("gaming_desk", "r303");
buyFurniture("tv_console", "r303");
buyFurniture("beanbag", "r303");

// 2. 產生應徵者(契合度依裝潢)
const apps = generateApplicants("r303");
console.log(`\n303 應徵者(裝潢後):`);
for (const a of apps) console.log(`  ${a.name} / ${a.occupation} / 契合 ${a.stars}★ / 月租 $${a.monthlyRent}`);

// 3. 讓契合度最高的入住
const best = [...apps].sort((x, y) => y.stars - x.stars)[0];
moveIn("r303", best);
console.log(`\n讓 ${best.name} 入住 303。`);
console.log(`  303 空房?${isVacant("r303")}  租客總數 ${Object.keys(state.runtimes).length}`);
console.log(`  occupancy:`, state.occupancy);

// 4. 快轉 2 天,確認新租客有作息 + 有繳租
const money0 = state.money;
fastForward(48);
const rt = state.runtimes[best.id];
console.log(`\n快轉 2 天後:`);
console.log(`  ${best.name} 目前狀態 ${rt.tenant.visualState},log ${rt.log.length} 筆,未讀 ${unreadCount(best.id)}`);
console.log(`  近期日誌:`);
for (const e of rt.log.slice(-4)) console.log(`    ${e.timeLabel} ${e.text}`);
console.log(`  金錢 ${money0} → ${state.money}(含新租客貢獻的租金)`);
