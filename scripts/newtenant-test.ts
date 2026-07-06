import { state, moveIn, buyFurniture, fastForward } from "../src/store";
import { generateApplicants } from "../src/sim/recruit";
import { ROOM_RECTS } from "../src/floor/map";
import { getTheme } from "../src/pixel/scene";

// 裝潢 303 一點 + 讓一位入住
buyFurniture("tv_console", "r303");
const ap = generateApplicants("r303")[0];
moveIn("r303", ap);
console.log(`${ap.name} 入住 r303(${ap.occupation})`);

// 快轉 24 小時,檢查他的目標格是否都落在 303 房內
const rect = ROOM_RECTS.r303;
const rt = state.runtimes[ap.id];
let inRoom = 0, communal = 0, away = 0, wrongRoom = 0;
for (let h = 0; h < 24; h++) {
  fastForward(1);
  const t = rt.targetTile;
  if (rt.tenant.visualState === "away" || !t) { away++; continue; }
  const insideOwn = t.c >= rect.c0 && t.c <= rect.c1 && t.r >= rect.r0 && t.r <= rect.r1;
  // 落在其他套房(301/302/304)= 跑錯房間
  const otherRoom = ["r301", "r302", "r304"].some((rid) => {
    const rr = ROOM_RECTS[rid];
    return t.c >= rr.c0 && t.c <= rr.c1 && t.r >= rr.r0 && t.r <= rr.r1;
  });
  if (insideOwn) inRoom++;
  else if (otherRoom) { wrongRoom++; console.log(`  ⚠ ${rt.tenant.visualState} 目標(${t.c},${t.r}) 跑到別人套房`); }
  else communal++;
}
console.log(`24h:自房 ${inRoom} / 共用區 ${communal} / 外出 ${away} / 跑錯套房 ${wrongRoom}`);

// 外觀:與陳家豪比對
const mine = getTheme(ap.id);
const chen = getTheme("tenant_chen_engineer");
console.log(`外觀:${ap.name} 上衣 ${mine.shirt} 髮 ${mine.hair} | 陳家豪 上衣 ${chen.shirt} 髮 ${chen.hair}`);
console.log(mine.shirt !== chen.shirt ? "✅ 外觀與陳家豪不同" : "⚠ 外觀仍與陳家豪相同");
