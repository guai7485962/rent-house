/** 家具旋轉與單人坐／躺姿勢回歸。 */
import {
  state,
  startPlacing,
  placeAt,
  startMoving,
  moveFurnitureTo,
  rotatePendingFurniture,
} from "../src/store";
import { getDef } from "../src/furniture/catalog";
import { normalizeRotation, rotateGridOffset, rotatedFootprint } from "../src/furniture/rotation";
import {
  furnitureAt,
  placementFootprint,
  placementInteract,
  removePlacementAt,
} from "../src/sim/placements";
import { currentBlocked } from "../src/floor/pathfind";
import { applyHour } from "../src/sim/tick";
import { createAgents, tickAgents } from "../src/floor/agents";
import { furnitureStandingPair } from "../src/sim/interactions";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const counter = getDef("counter");
check("舊存檔缺方向時正規化為 0°", normalizeRotation(undefined) === 0);
check("角度正規化支援循環", normalizeRotation(450) === 90 && normalizeRotation(-90) === 270);
check("90° 會交換 2×1 家具尺寸", rotatedFootprint(counter, 90).w === 1 && rotatedFootprint(counter, 90).h === 2);
const rotatedInteract = rotateGridOffset(counter.interact, counter.footprint, 90);
check("90° 會把原本下方互動點轉到左側", rotatedInteract.dc === -1 && rotatedInteract.dr === 0);

state.money = Math.max(state.money, 20000);
check("可開始擺放流理臺", startPlacing("counter").ok);
check("新家具預設 0°", state.pendingRotation === 0);
check("旋轉按鈕切到 90°", rotatePendingFurniture() && state.pendingRotation === 90);
const placed = placeAt(4, 18);
const vertical = furnitureAt(4, 19);
check("旋轉後可依 1×2 佔位擺放", placed.ok && vertical?.defId === "counter");
check("Placement 保存 90° 與旋轉尺寸", vertical?.rotation === 90 && !!vertical && placementFootprint(vertical).w === 1 && placementFootprint(vertical).h === 2);
check("碰撞格跟著旋轉", currentBlocked()[19][4] === true);
check("家具互動點跟著旋轉", !!vertical && placementInteract(vertical).c === 3 && placementInteract(vertical).r === 18);
const standingPair = furnitureStandingPair("r303", ["counter"]);
check("雙人料理站位會沿旋轉後的家具邊緣排列", standingPair?.a.c === 3 && standingPair?.b.c === 3 && Math.abs(standingPair.a.r - standingPair.b.r) === 1);

check("移動模式沿用家具目前方向", startMoving(4, 19).ok && state.pendingRotation === 90);
check("移動時可再轉到 180°", rotatePendingFurniture() && state.pendingRotation === 180);
const moved = moveFurnitureTo(3, 20);
const horizontal = furnitureAt(4, 20);
check("搬動確認後保存新方向", moved.ok && horizontal?.rotation === 180 && !!horizontal && placementFootprint(horizontal).w === 2 && placementFootprint(horizontal).h === 1);
if (horizontal) removePlacementAt(horizontal.c, horizontal.r);

const chen = state.runtimes["tenant_chen_engineer"];
applyHour(chen, 6, false);
check("日常睡床推導出躺姿", chen.activityPose === "lie" && chen.activitySurface === "furniture" && chen.activityTile !== null);
let agents = createAgents();
tickAgents(agents, 0);
let chenAgent = agents.find((a) => a.tenantId === chen.tenant.id)!;
check("角色會跨上床格並躺下", chenAgent.pose === "lie" && !chenAgent.moving && chenAgent.c === chen.activityTile?.c && chenAgent.r === chen.activityTile?.r);
check("床頭朝上時躺姿會校正為直向", chen.activityRotation === 90 && chenAgent.poseRotation === 90);
const sleepingBed = chen.activityTile ? furnitureAt(chen.activityTile.c, chen.activityTile.r) : null;
const sleepingFp = sleepingBed ? placementFootprint(sleepingBed) : null;
const centeredX = sleepingBed && sleepingFp
  ? chenAgent.px + chenAgent.poseOffsetX + 8 === (sleepingBed.c + sleepingFp.w / 2) * 16
  : false;
const centeredY = sleepingBed && sleepingFp
  ? chenAgent.py + chenAgent.poseOffsetY + 8 === (sleepingBed.r + sleepingFp.h / 2) * 16
  : false;
check("睡覺角色以整張床中心定位", centeredX && centeredY && (chenAgent.poseOffsetX !== 0 || chenAgent.poseOffsetY !== 0));

if (sleepingBed) {
  sleepingBed.rotation = 90;
  applyHour(chen, 6, false);
  check("床旋轉 90° 後躺姿仍沿床頭方向", chen.activityRotation === 180);
  sleepingBed.rotation = 180;
  applyHour(chen, 6, false);
  check("床旋轉 180° 後躺姿仍沿床頭方向", chen.activityRotation === 270);
  sleepingBed.rotation = 270;
  applyHour(chen, 6, false);
  check("床旋轉 270° 後躺姿仍沿床頭方向", chen.activityRotation === 0);
  sleepingBed.rotation = 0;
}

applyHour(chen, 13, false);
check("沙發休閒推導出坐姿", chen.activityPose === "sit" && chen.activitySurface === "furniture");
applyHour(chen, 0, false);
check("桌前工作使用坐姿與工作椅", chen.activityPose === "sit" && chen.activitySurface === "chair" && chen.activityTile?.c === chen.targetTile?.c && chen.activityTile?.r === chen.targetTile?.r);
agents = createAgents();
tickAgents(agents, 0);
chenAgent = agents.find((a) => a.tenantId === chen.tenant.id)!;
check("桌前 Agent 會標記補畫椅背", chenAgent.pose === "sit" && chenAgent.seatBack);

check("家具商店包含可旋轉木質單椅", getDef("wood_chair").sprite.kind === "chair");

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
