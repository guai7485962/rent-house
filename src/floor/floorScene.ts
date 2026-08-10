/**
 * 樓層地圖渲染器(正俯視 3/4,嚴格對齊 tile 網格)
 * 純函式:FloorMap.vue 在 canvas 呼叫,scripts/render-floor.ts 離線預覽。
 */
import {
  type Ctx,
  type Palette,
  BASE_PAL,
  ramp,
  shade,
  rect,
  box,
  block,
  groundShadow,
  drawSprite,
  CHAR_STAND,
  CHAR_SIT,
  CHAR_SPRITES,
  type CharView,
} from "../pixel/sprites";
import type { Agent } from "./agents";
import {
  guestDrawX,
  guestDrawY,
  guestSeated,
  GUEST_SERVED_SECONDS,
  type GuestAgent,
} from "./guestAgents";
import {
  staffMoving,
  staffWipeFrame,
  staffWorkFrame,
  STAFF_APRON,
  STAFF_APRON_TIE,
  type StaffAgent,
} from "./staffAgents";
import type { PetAgent } from "./petAgents";
import { isVacuumDef, type VacuumAgent } from "./vacuumAgents";
import { activeFx, type Fx } from "./fx";
import { getTheme, getCustomAppearance } from "../pixel/scene";
import { drawAppearanceOverlay } from "../pixel/parts";
import { TILE, GRID_W, GRID_H, buildGrid, TENANT_SPOTS, ROOM_RECTS, FACILITY_RECTS, LOUNGE_HALL_RECT, CAFE_RECTS } from "./map";
import { getDef } from "../furniture/catalog";
import { drawDef } from "../furniture/render";
import { getPlacements, placementInteract, placementFootprint, placements, furnitureAt } from "../sim/placements";
import type { FurnitureRotation } from "../furniture/rotation";
import { tryDrawLimezuFloor, tryDrawLimezuThinkingEmote, tryDrawLimezuWallPiece, type LimezuFloorRoomId } from "../art/limezu";
import type { Appearance } from "../types";
import { CAT_PALS, DOG_PALS, CALICO_PATCH_A, CALICO_PATCH_B } from "./petPalettes";

export const FLOOR_W = GRID_W * TILE; // 256
export const FLOOR_H = GRID_H * TILE; // 832

const GRID = buildGrid();

/** 各區地板底色(讓 4 房 + 大廳一眼可分) */
const FLOOR_TINT: Record<string, string> = {
  r301: "#b08a5e", // 暖木(工程師)
  r302: "#b6926a", // 略帶粉的暖木(實況主)
  r303: "#8f8676", // 灰(空房)
  r304: "#8f8676",
  lounge: "#a5825a", // 交誼廳
  bathroom: "#8ea6b0", // 藍灰磁磚(浴室)
  laundry: "#9aa2a8", // 灰磁磚(洗衣間)
  door: "#9a7a52",
  entrance: "#8a6a44",
  stairs: "#9c7652", // 暖木樓梯
  cafe_floor: "#c89b6b", // 蜂蜜木色(主座位區)
  cafe_counter: "#b97572", // 玫瑰陶磚(吧台／點餐區)
  cafe_pet: "#91ad8e", // 鼠尾草綠(寵物遊戲區)
  cafe_back: "#7f8992", // 灰藍工作地坪(後場)
  cafe_entrance: "#a17a54", // 暖木門檻
};

/** 磁磚地板的區域(方格縫,而非木紋)*/
const TILED: Record<string, true> = { bathroom: true, laundry: true };

function charPalette(tenantId: string): Palette {
  const t = getTheme(tenantId);
  return {
    ...BASE_PAL,
    h: t.hair,
    H: shade(t.hair, 26),
    F: t.skin,
    f: shade(t.skin, -16),
    t: t.shirt,
    T: shade(t.shirt, 20),
    j: shade(t.shirt, -22),
    d: t.pants,
    D: shade(t.pants, -22),
  };
}

function guestPalette(appearance: Appearance): Palette {
  return {
    ...BASE_PAL,
    h: appearance.hairColor,
    H: shade(appearance.hairColor, 26),
    F: appearance.skin,
    f: shade(appearance.skin, -16),
    t: appearance.shirt,
    T: shade(appearance.shirt, 20),
    j: shade(appearance.shirt, -22),
    d: appearance.pants,
    D: shade(appearance.pants, -22),
  };
}

/** 樓層警示標記(維修系統等):在某格上方畫閃爍的警告小圖示 */
export interface FloorMark {
  c: number;
  r: number;
}

/** 日夜色調(工作項 9):依遊戲小時回傳疊在整個樓層上的色調;白天 null = 不疊 */
export function dayNightTint(hour: number): { color: string; alpha: number } | null {
  if (hour >= 21 || hour <= 4) return { color: "#141840", alpha: 0.32 }; // 深夜:靛藍
  if (hour <= 6) return { color: "#5a3c6e", alpha: 0.18 }; // 拂曉:紫粉
  if (hour <= 15) return null; // 白天
  if (hour <= 17) return { color: "#ff9a4d", alpha: 0.1 }; // 傍晚:斜陽
  if (hour <= 19) return { color: "#7c4630", alpha: 0.16 }; // 黃昏:暖褐
  return { color: "#141840", alpha: 0.24 }; // 入夜
}

export function composeFloor(ctx: Ctx, frame: number, agents?: Agent[], marks?: FloorMark[], hour?: number, pets?: PetAgent[], vacuums?: VacuumAgent[], guests?: GuestAgent[], cafeOpen?: boolean, staff?: StaffAgent[]) {
  rect(ctx, 0, 0, FLOOR_W, FLOOR_H, "#0d0c12");

  drawFloorTiles(ctx);
  drawLimezuFloorOverlay(ctx);
  drawWalls(ctx);
  drawEntrance(ctx);
  drawFloorDivider(ctx);
  drawStairs(ctx);

  // 家具:讀 PLACEMENTS(id+座標)→ 查目錄 → drawDef。
  // 由上而下(r 由小到大)繪製,讓前方物件蓋住後方。
  // 有傳 vacuums(遊走的掃地機)時,略過靜態 robot_vacuum 家具——改由下方會動的 sprite 取代,
  // 避免同一台掃地機出現兩份(基地一份 + 遊走一份)。離線預覽/房間鏡頭未傳時照舊畫靜態。
  const drawVacuums = vacuums !== undefined;
  const sorted = [...getPlacements()].sort((a, b) => a.r - b.r);
  for (const p of sorted) {
    if (drawVacuums && isVacuumDef(p.defId)) continue;
    drawDef(ctx, getDef(p.defId), p.c * TILE, p.r * TILE, p.rotation ?? 0);
  }

  if (agents || pets || vacuums || guests || staff) {
    // 租客、咖啡廳顧客、寵物與掃地機依 y 混排,讓靠下(近鏡頭)的蓋住上方。
    const items: { y: number; draw: () => void }[] = [];
    const petPairs = activePetPairs(pets ?? []);
    for (const [a, b] of petPairs) {
      items.push({ y: Math.min(a.py, b.py) + 2, draw: () => drawPetPairGround(ctx, a, b, frame) });
    }
    for (const a of agents ?? []) {
      if (a.hidden) continue;
      items.push({ y: a.py, draw: () => { drawAgent(ctx, a); drawAmbient(ctx, a, frame); } });
    }
    for (const guest of guests ?? []) {
      if (guest.hidden || guest.phase === "departed") continue;
      items.push({ y: guestDrawY(guest), draw: () => drawGuest(ctx, guest) });
    }
    // P4b:員工站在吧台後方,和其他人一起依 y 混排(吧台本體會蓋住他的下半身)。
    for (const worker of staff ?? []) items.push({ y: worker.py, draw: () => drawStaff(ctx, worker) });
    for (const v of vacuums ?? []) items.push({ y: v.py + 6, draw: () => drawVacuum(ctx, v, frame) });
    for (const p of pets ?? []) items.push({ y: p.py + 4, draw: () => p.kind === "dog" ? drawDog(ctx, p, frame) : drawCat(ctx, p, frame) });
    for (const it of items.sort((m, n) => m.y - n.y)) it.draw();
    // 泡泡與浮字是資訊層,統一蓋在人物／家具之上(P2:點餐 → 收錢 → 入座三種演出)。
    for (const guest of guests ?? []) drawGuestBubble(ctx, guest, frame);
    for (const worker of staff ?? []) drawStaffBubble(ctx, worker);
    for (const [a, b] of petPairs) drawPetPairAction(ctx, a, b, frame);
    for (const f of activeFx()) drawFx(ctx, f, frame); // 互動/事件演出(愛心/怒氣/心碎/對話)
  } else {
    // 離線預覽:靜態站立
    for (const spot of TENANT_SPOTS) {
      const px = spot.c * TILE;
      const py = spot.r * TILE;
      const spriteY = py - 4 - (frame % 2);
      groundShadow(ctx, px + TILE / 2, py + TILE - 1, 11);
      drawSprite(ctx, CHAR_STAND, px + 3, spriteY, charPalette(spot.tenantId));
      const appearance = getCustomAppearance(spot.tenantId);
      if (appearance) drawAppearanceOverlay(ctx, appearance, px + 3, spriteY);
    }
  }

  // 咖啡廳開店/關店(設計文件 §4.4):店門、招牌、一樓亮度三件事讀同一個旗標。
  if (cafeOpen !== undefined) {
    drawCafeShopfront(ctx, cafeOpen, frame);
    if (!cafeOpen) drawCafeClosedDim(ctx);
  }

  // 日夜色調(工作項 9;疊在場景之上、警示之下——警示要保持醒目)
  const tint = hour != null ? dayNightTint(hour) : null;
  if (tint) {
    ctx.save();
    ctx.globalAlpha = tint.alpha;
    ctx.fillStyle = tint.color;
    ctx.fillRect(0, 0, FLOOR_W, FLOOR_H);
    ctx.restore();
  }
  if (marks) for (const m of marks) drawWarnMark(ctx, m, frame); // 設備故障等警示(§7-1)
}

/** CAFE-08：顧客沿用四方向人物骨架，但外觀直接讀 CafeGuest snapshot，不查 TenantRuntime。 */
export function drawGuest(ctx: Ctx, agent: GuestAgent) {
  const appearance = agent.guest.appearance;
  const palette = guestPalette(appearance);
  const x = guestDrawX(agent);
  const y = guestDrawY(agent);
  groundShadow(ctx, x + TILE / 2, y + TILE - 1, 11);
  // P2：坐姿只在「真的走到那張椅子上」時出現，不再是「停在空地板上也算入座」。
  if (guestSeated(agent)) {
    drawSprite(ctx, CHAR_SIT, x + 3, y + 1, palette);
    drawAppearanceOverlay(ctx, appearance, x + 3, y + 1, "front");
    return;
  }
  const sprites = CHAR_SPRITES[agent.view];
  const secondStep = agent.moving && Math.floor(agent.walkPhase) % 2 !== 0;
  const sprite = agent.moving ? (secondStep ? sprites.walkB : sprites.walkA) : sprites.stand;
  const yoff = secondStep ? -1 : 0;
  drawSprite(ctx, sprite, x + 3, y - 4 + yoff, palette);
  drawAppearanceOverlay(ctx, appearance, x + 3, y - 4 + yoff, agent.view);
}

// ---------------------------------------------------------------------------
// 🔴 P4b:員工站在吧台後面(設計文件 §4.9)
//
// 三個狀態必須在畫面上分得出來,而且**不需要讀任何數字**:
//   idle    → 站在吧台後,偶爾拿起杯子擦兩下
//   serving → 轉身面向吧台前的顧客,頭上出現「製作中」的杯子圖示
//   busy    → 同上,但動作不停(外面還有人在排隊)
// 制服(深咖啡圍裙)是「這個人是店員不是顧客」唯一且最強的辨識訊號。
// ---------------------------------------------------------------------------

/** 員工本體:四方向人物骨架 + 圍裙 + 待機時手上的杯子。 */
export function drawStaff(ctx: Ctx, agent: StaffAgent) {
  const palette = guestPalette(agent.appearance);
  const x = agent.px;
  const y = agent.py;
  groundShadow(ctx, x + TILE / 2, y + TILE - 1, 11);
  const sprites = CHAR_SPRITES[agent.view];
  const work = staffWorkFrame(agent);
  const moving = staffMoving(agent);
  // 忙碌/結帳中一律走「連續動作」的兩幀;待機且沒在挪位就站著。
  const animated = moving || agent.phase !== "idle";
  const sprite = animated ? (work === 0 ? sprites.walkA : sprites.walkB) : sprites.stand;
  const yoff = animated && work === 1 ? -1 : 0;
  const sx = x + 3;
  const sy = y - 4 + yoff;
  drawSprite(ctx, sprite, sx, sy, palette);
  drawAppearanceOverlay(ctx, agent.appearance, sx, sy, agent.view);
  drawStaffApron(ctx, sx, sy, agent.view);
  const wipe = staffWipeFrame(agent);
  if (wipe !== 0) drawStaffCup(ctx, sx, sy + (wipe === 1 ? 0 : 1), agent.view);
}

/** 圍裙:蓋在軀幹上(背面畫成交叉綁帶),一眼分得出店員與顧客。 */
function drawStaffApron(ctx: Ctx, sx: number, sy: number, view: CharView) {
  if (view === "back") {
    rect(ctx, sx + 3, sy + 9, 5, 1, STAFF_APRON_TIE);
    rect(ctx, sx + 4, sy + 10, 1, 4, STAFF_APRON_TIE);
    rect(ctx, sx + 6, sy + 10, 1, 4, STAFF_APRON_TIE);
    return;
  }
  const narrow = view !== "front";
  const w = narrow ? 4 : 6;
  const ox = narrow ? 3 : 2;
  rect(ctx, sx + ox, sy + 9, w, 1, STAFF_APRON_TIE); // 腰帶
  rect(ctx, sx + ox, sy + 10, w, 5, STAFF_APRON);    // 裙身
  rect(ctx, sx + ox + 1, sy + 11, 1, 3, shade(STAFF_APRON, 18)); // 摺線
}

/** 待機時手上那只被擦來擦去的杯子。 */
function drawStaffCup(ctx: Ctx, sx: number, sy: number, view: CharView) {
  const cx = view === "side_l" ? sx + 1 : sx + 8;
  rect(ctx, cx, sy + 9, 3, 4, "#f4efe4");
  rect(ctx, cx, sy + 9, 3, 1, "#d8cfbe");
}

/** 結帳中/忙碌時頭上的「製作中」泡泡:杯子 + 兩股會動的熱氣。 */
export function drawStaffBubble(ctx: Ctx, agent: StaffAgent) {
  if (agent.phase === "idle") return;
  const w = 16;
  const h = 14;
  const x = Math.round(agent.px) + Math.round((TILE - w) / 2);
  const y = Math.round(agent.py) - h - 8;
  bubbleBox(ctx, x, y, w, h, "#fff6e2", "#5a4230");
  rect(ctx, x + 4, y + 6, 7, 5, "#8a5a37");   // 杯身
  rect(ctx, x + 4, y + 6, 7, 2, "#c98b57");   // 液面
  rect(ctx, x + 11, y + 7, 1, 3, "#8a5a37");  // 把手
  const lift = staffWorkFrame(agent) === 0 ? 0 : 1; // 熱氣上下飄
  rect(ctx, x + 5, y + 2 + lift, 1, 3, "#c9b7a4");
  rect(ctx, x + 8, y + 3 - lift, 1, 3, "#c9b7a4");
}

// ---------------------------------------------------------------------------
// P2:看得見的消費(設計文件 §4.5)
//
// 這一段是整期的視覺主體。三件事必須在畫面上分得出來:
//   ordering → 他點的是**什麼**(品名圖示 + 價格,不是抽象符號)
//   served   → 我**收到了多少錢**(綠色 +$34 浮字)
//   refused  → 這一單**沒做成**(紅色 ❌)
// 另外兩種「可互動」意圖(想認養/想租房)要一眼看得出可以點,見 drawIntentBubble。
// ---------------------------------------------------------------------------

/** 3×5 像素字模。canvas 上沒有任何 fillText,金額只能自己畫。 */
const PIXEL_GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "$": ["011", "110", "111", "011", "110"],
  "+": ["000", "010", "111", "010", "000"],
  "-": ["000", "000", "111", "000", "000"],
};

/** 畫一串像素字(只支援 PIXEL_GLYPHS 收錄的字元);回傳實際寬度。 */
export function drawPixelText(ctx: Ctx, text: string, x: number, y: number, color: string): number {
  let cursor = 0;
  for (const ch of text) {
    const glyph = PIXEL_GLYPHS[ch];
    if (!glyph) { cursor += 2; continue; }
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === "1") rect(ctx, x + cursor + col, y + row, 1, 1, color);
      }
    }
    cursor += 4;
  }
  return Math.max(0, cursor - 1);
}

export const PIXEL_TEXT_HEIGHT = 5;
export const pixelTextWidth = (text: string) => Math.max(0, text.length * 4 - 1);

/** 商品圖示:咖啡杯 / 烘焙 / 肉球。玩家看的是「他點了什麼」,不是抽象意圖。 */
function drawMenuIcon(ctx: Ctx, track: "coffee" | "bakery" | "pet", x: number, y: number) {
  if (track === "coffee") {
    rect(ctx, x + 1, y + 2, 7, 6, "#8a5a37"); // 杯身
    rect(ctx, x + 1, y + 2, 7, 2, "#c98b57"); // 咖啡面
    rect(ctx, x + 8, y + 3, 2, 3, "#8a5a37"); // 把手
    rect(ctx, x + 2, y, 1, 2, "#d9c8bb");     // 熱氣
    rect(ctx, x + 5, y, 1, 2, "#d9c8bb");
    return;
  }
  if (track === "bakery") {
    rect(ctx, x + 1, y + 3, 8, 5, "#d9a45c"); // 麵包體
    rect(ctx, x + 2, y + 2, 6, 2, "#f0c583"); // 上緣亮面
    rect(ctx, x + 3, y + 5, 2, 1, "#a56a33"); // 烤紋
    rect(ctx, x + 6, y + 5, 2, 1, "#a56a33");
    return;
  }
  rect(ctx, x + 2, y + 4, 6, 4, "#e0913f");   // 肉球
  rect(ctx, x + 1, y + 1, 2, 2, "#e0913f");
  rect(ctx, x + 4, y, 2, 2, "#e0913f");
  rect(ctx, x + 7, y + 1, 2, 2, "#e0913f");
}

/** 泡泡底板(圓角靠切角模擬)+ 指向角色的小尾巴。 */
function bubbleBox(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, edge: string) {
  rect(ctx, x + 1, y + 1, w, h, "#2b2838");     // 陰影
  rect(ctx, x, y, w, h, edge);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
  rect(ctx, x + w / 2 - 2, y + h, 4, 2, edge);  // 尾巴
  rect(ctx, x + w / 2 - 1, y + h, 2, 1, fill);
}

/**
 * 顧客頭上的資訊層。依 phase 分派,一次只畫一種,不會疊在一起。
 *
 * 位置一律用 `guestDrawX/Y`(坐著時是椅子格),泡泡才不會飄在別的格子上。
 */
export function drawGuestBubble(ctx: Ctx, agent: GuestAgent, frame: number) {
  if (agent.hidden || agent.phase === "departed") return;
  if (agent.phase === "ordering") return drawOrderBubble(ctx, agent);
  if (agent.phase === "served") return drawServedFloat(ctx, agent);
  if (agent.phase === "refused") return drawRefusedBubble(ctx, agent);
  drawIntentBubble(ctx, agent, frame);
}

/** `ordering`：站在吧台前，頭上顯示**他點的商品**（圖示 + 價格）。 */
export function drawOrderBubble(ctx: Ctx, agent: GuestAgent) {
  const order = agent.guest.order;
  if (!order) return;
  const label = `$${Math.round(order.price)}`;
  const w = 10 + 2 + pixelTextWidth(label) + 6;
  const h = 13;
  const x = Math.round(guestDrawX(agent)) + Math.round((TILE - w) / 2);
  const y = Math.round(guestDrawY(agent)) - h - 6;
  bubbleBox(ctx, x, y, w, h, "#fdf6ea", "#4a3f52");
  drawMenuIcon(ctx, order.track, x + 3, y + 2);
  drawPixelText(ctx, label, x + 15, y + 4, "#3f3446");
}

/** `served`：綠色 `+$34` 從頭上升起，末段淡出。 */
export function drawServedFloat(ctx: Ctx, agent: GuestAgent) {
  const order = agent.guest.order;
  if (!order) return;
  const t = Math.min(1, Math.max(0, agent.phaseT / GUEST_SERVED_SECONDS));
  const label = `+$${Math.round(order.price)}`;
  const w = pixelTextWidth(label);
  const x = Math.round(guestDrawX(agent)) + Math.round((TILE - w) / 2);
  const y = Math.round(guestDrawY(agent)) - 10 - Math.round(t * 12);
  ctx.save();
  ctx.globalAlpha = t > 0.75 ? Math.max(0, (1 - t) * 4) : 1;
  // 深色描邊：地板是暖木色，純綠字在上面會糊掉。
  drawPixelText(ctx, label, x, y + 1, "#14301c");
  drawPixelText(ctx, label, x + 1, y, "#14301c");
  drawPixelText(ctx, label, x, y, "#5ee08a");
  ctx.restore();
}

/** `refused`：紅色 ❌ 泡泡（他想點的東西做不出來）。 */
export function drawRefusedBubble(ctx: Ctx, agent: GuestAgent) {
  const w = 15;
  const h = 13;
  const x = Math.round(guestDrawX(agent)) + Math.round((TILE - w) / 2);
  const y = Math.round(guestDrawY(agent)) - h - 6;
  bubbleBox(ctx, x, y, w, h, "#ffe3e6", "#7a2334");
  for (let i = 0; i < 7; i++) {
    rect(ctx, x + 4 + i, y + 3 + i, 2, 1, "#e5395a");
    rect(ctx, x + 10 - i, y + 3 + i, 2, 1, "#e5395a");
  }
}

/**
 * CAFE-10 的意圖泡泡（P2 重做）。
 *
 * 使用者原話：「不知道這些人走進來後頭上的標誌代表什麼意思」。舊版是 8px 的抽象
 * 像素圖，三種意圖長得差不多、也看不出哪些**可以互動**。改成：
 *
 * - `coffee`：小小一杯咖啡，安靜地表示「他只是來喝東西」（不可互動）
 * - `adopt` / `rent`：**加大的醒目牌子 + 閃爍的驚嘆號 + 外框光暈**，
 *   一眼看得出「這個人有事找你」，對應咖啡廳面板上真的可以按的那兩張卡。
 */
export function drawIntentBubble(ctx: Ctx, agent: GuestAgent, frame: number) {
  if (agent.hidden || agent.phase !== "seated" || agent.moving) return;
  const phase = Math.floor(Math.max(0, frame)) % 2;
  const intent = agent.guest.intent;
  const x = Math.round(guestDrawX(agent));
  const y = Math.round(guestDrawY(agent)) - 18;

  if (intent === "coffee") {
    if (tryDrawLimezuThinkingEmote(ctx, intent, phase, x, y)) return;
    bubbleBox(ctx, x + 2, y + 2, 12, 11, "#f5f1ff", "#4a4764");
    rect(ctx, x + 5, y + 6, 6, 4, "#a86942");
    rect(ctx, x + 11, y + 7, 2, 2, "#a86942");
    rect(ctx, x + 6, y + 4, 1, 2, "#d9b28f");
    rect(ctx, x + 9, y + 4, 1, 2, "#d9b28f");
    return;
  }

  // 可互動意圖：外框光暈（兩幀呼吸）+ 大牌子 + 驚嘆號
  const w = 22;
  const h = 15;
  const bx = x + Math.round((TILE - w) / 2);
  const by = y - 2;
  const accent = intent === "adopt" ? "#e95a72" : "#5f83c1";
  ctx.save();
  ctx.globalAlpha = phase === 0 ? 0.5 : 0.28;
  rect(ctx, bx - 2, by - 2, w + 4, h + 4, accent);
  ctx.restore();
  bubbleBox(ctx, bx, by, w, h, "#fffbe8", accent);
  if (intent === "adopt") {
    // 愛心 + 貓耳，表示「想帶一隻回家」
    rect(ctx, bx + 4, by + 4, 2, 2, accent);
    rect(ctx, bx + 8, by + 4, 2, 2, accent);
    rect(ctx, bx + 3, by + 5, 8, 3, accent);
    rect(ctx, bx + 5, by + 8, 4, 2, "#c93f5b");
    rect(ctx, bx + 6, by + 10, 2, 1, "#c93f5b");
  } else {
    // 房子（屋頂 + 門），表示「想租房」
    rect(ctx, bx + 3, by + 6, 9, 6, accent);
    rect(ctx, bx + 5, by + 3, 5, 3, "#3d5a8c");
    rect(ctx, bx + 6, by + 8, 3, 4, "#fffbe8");
  }
  // 驚嘆號：閃爍，代表「這個可以點」
  const bang = phase === 0 ? "#f6b93b" : "#ffd66e";
  rect(ctx, bx + 15, by + 3, 2, 5, bang);
  rect(ctx, bx + 15, by + 9, 2, 2, bang);
}

// ---------------------------------------------------------------------------
// P2:開店 / 關店(設計文件 §4.4)
// ---------------------------------------------------------------------------

/** 店門(`cafe_entrance` 兩格)與招牌。開店 = 門開、招牌亮;打烊 = 門關、招牌熄。 */
function drawCafeShopfront(ctx: Ctx, open: boolean, frame: number) {
  const doorRect = CAFE_RECTS.cafe_entrance;
  const x = doorRect.c0 * TILE;
  const y = doorRect.r0 * TILE;
  const w = (doorRect.c1 - doorRect.c0 + 1) * TILE;
  const h = TILE;
  const wood = ramp(open ? "#a3794c" : "#6a5235");
  box(ctx, x - 1, y - 2, w + 2, h + 3, wood.dark, "#2c2018"); // 門框
  if (open) {
    // 兩扇門往兩側開,中間透出室內暖光
    block(ctx, x, y, 5, h, wood, 2);
    block(ctx, x + w - 5, y, 5, h, wood, 2);
    rect(ctx, x + 5, y + 1, w - 10, h - 2, "#ffe0a3");
    rect(ctx, x + 5, y + h - 3, w - 10, 2, "#fff3d0");
  } else {
    block(ctx, x, y, w / 2, h, wood, 2);
    block(ctx, x + w / 2, y, w / 2, h, wood, 2);
    rect(ctx, x + 2, y + 2, w / 2 - 4, h - 4, shade("#6a5235", -22));
    rect(ctx, x + w / 2 + 2, y + 2, w / 2 - 4, h - 4, shade("#6a5235", -22));
    rect(ctx, x + w / 2 - 2, y + h / 2 - 1, 2, 3, "#c8a86a"); // 把手
    rect(ctx, x + w / 2, y + h / 2 - 1, 2, 3, "#c8a86a");
  }

  // 招牌:掛在門正上方。亮著 = 營業中,一眼可辨。
  const sw = 26;
  const sx = x + Math.round((w - sw) / 2);
  const sy = y - 13;
  if (open) {
    ctx.save();
    ctx.globalAlpha = Math.floor(Math.max(0, frame)) % 2 === 0 ? 0.34 : 0.22;
    rect(ctx, sx - 3, sy - 3, sw + 6, 16, "#ffd66e");
    ctx.restore();
  }
  box(ctx, sx, sy, sw, 10, open ? "#ffcf6b" : "#4c4437", "#2b2318");
  rect(ctx, sx + 1, sy + 1, sw - 2, 8, open ? "#7a4a2c" : "#332c22");
  const bar = open ? "#ffe9a8" : "#5b5346";
  rect(ctx, sx + 3, sy + 3, 6, 2, bar);
  rect(ctx, sx + 11, sy + 3, 4, 2, bar);
  rect(ctx, sx + 17, sy + 3, 6, 2, bar);
  rect(ctx, sx + 3, sy + 6, 20, 1, open ? "#f6b93b" : "#453e33");
}

/** 打烊：整個一樓（樓梯口以下）壓暗。玩家一眼分得出「營業中」與「打烊」。 */
function drawCafeClosedDim(ctx: Ctx) {
  const top = CAFE_RECTS.stairs.r0 * TILE;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "#0a0913";
  ctx.fillRect(0, top, FLOOR_W, FLOOR_H - top);
  ctx.restore();
}

/** 擺放/移動預覽:半透明 footprint 疊在地圖上(可放=綠、不可=紅),再點確認才成交 */
export function drawFootprintPreview(ctx: Ctx, c: number, r: number, w: number, h: number, ok: boolean, rotation: FurnitureRotation = 0) {
  const x = c * TILE;
  const y = r * TILE;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = ok ? "#5ad06a" : "#e5395a";
  ctx.fillRect(x, y, w * TILE, h * TILE);
  ctx.restore();
  ctx.strokeStyle = ok ? "#b6ffbe" : "#ffb3c1";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w * TILE - 1, h * TILE - 1);
  // 中央方向箭頭；正方形家具旋轉時也看得出朝向。
  const cx = x + (w * TILE) / 2;
  const cy = y + (h * TILE) / 2;
  ctx.fillStyle = ok ? "#d9ffdc" : "#ffd7df";
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.fillRect(-1, -6, 2, 9);
  ctx.fillRect(-4, -6, 8, 2);
  ctx.fillRect(-3, -4, 6, 1);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 演出層(設計檢討 §10-4):互動特效 + 隨狀態的環境演出
// ---------------------------------------------------------------------------

/** 依 pattern 畫 1px 像素圖("X" = 上色) */
function pxPat(ctx: Ctx, pattern: string[], x: number, y: number, color: string, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let r = 0; r < pattern.length; r++)
    for (let c = 0; c < pattern[r].length; c++)
      if (pattern[r][c] === "X") ctx.fillRect(x + c, y + r, 1, 1);
  ctx.restore();
}

const PAT_HEART = [".X.X.", "XXXXX", ".XXX.", "..X.."];
const PAT_BANG = ["X", "X", "X", ".", "X"]; // 驚嘆號

/** 設備故障警示:黃色三角 + 驚嘆號,慢閃(§7-1 讓「壞掉」在樓層一眼看到) */
function drawWarnMark(ctx: Ctx, m: { c: number; r: number }, frame: number) {
  if (frame % 3 === 2) return; // 閃爍:亮兩拍、暗一拍
  const x = m.c * TILE + 2; // 三角頂點的中心欄
  const y = m.r * TILE - 10;
  // 深色底三角(當描邊)+ 黃色內三角
  ctx.fillStyle = "#5c4300";
  for (let row = 0; row < 9; row++) {
    const half = Math.ceil(((row + 1) / 9) * 6);
    ctx.fillRect(x + 6 - half, y + row, half * 2 - 1, 1);
  }
  ctx.fillStyle = "#ffd23e";
  for (let row = 2; row < 8; row++) {
    const half = Math.max(1, Math.ceil(((row + 1) / 9) * 6) - 1);
    ctx.fillRect(x + 6 - half, y + row, half * 2 - 1, 1);
  }
  pxPat(ctx, PAT_BANG, x + 6, y + 3, "#5c4300");
}
const PAT_CRACK = ["..X..", ".X...", "..X..", ".X..."];
const PAT_ANGER = ["X...X", ".X.X.", ".....", ".X.X.", "X...X"];
const PAT_Z = ["XXX", ".X.", "XXX"];
const PAT_STAR = ["..X..", ".XXX.", "XX.XX", ".XXX.", "..X.."];
const PAT_NOTE = [".XX", ".X.", ".X.", "XX."];

/** 互動/事件演出:掛在格子上方,輕微上下漂 */
function drawFx(ctx: Ctx, f: Fx, frame: number) {
  const x = f.c * TILE;
  const y = f.r * TILE;
  const bob = frame % 3;
  if (f.kind === "hearts") {
    pxPat(ctx, PAT_HEART, x + 2, y - 9 - bob, "#ff6b9d");
    pxPat(ctx, PAT_HEART, x + 9, y - 13 - ((frame + 1) % 3), "#ff9ec2", 0.9);
  } else if (f.kind === "heartbreak") {
    pxPat(ctx, PAT_HEART, x + 5, y - 11 - (frame % 2), "#9aa0aa");
    pxPat(ctx, PAT_CRACK, x + 5, y - 11 - (frame % 2), "#3a3d46");
  } else if (f.kind === "anger") {
    pxPat(ctx, PAT_ANGER, x + 5, y - 11, frame % 2 ? "#ff5a5a" : "#ff9a7a");
  } else if (f.kind === "chat") {
    // 小對話泡泡 + 閃爍的點點
    ctx.fillStyle = "#f5f2ea";
    ctx.fillRect(x + 3, y - 10, 9, 6);
    ctx.fillRect(x + 5, y - 4, 2, 1); // 泡泡尾巴
    ctx.fillStyle = "#6a6456";
    const dots = frame % 2 ? 3 : 2;
    for (let i = 0; i < dots; i++) ctx.fillRect(x + 5 + i * 2, y - 8, 1, 1);
  } else if (f.kind === "steam") {
    // 霧氣(遮蔽式演出:一起洗澡等)
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(x + 1, y - 6 - bob, 3, 3);
    ctx.fillRect(x + 7, y - 11 - ((frame + 1) % 3), 3, 3);
    ctx.fillRect(x + 12, y - 5 - ((frame + 2) % 3), 3, 3);
    ctx.fillRect(x + 5, y - 15 - bob, 2, 2);
    ctx.restore();
  } else if (f.kind === "lights") {
    // 關燈(遮蔽式演出:房間局部變暗 + 一顆小愛心)
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#0a0912";
    ctx.fillRect(x - TILE, y - TILE, TILE * 3, TILE * 2.5);
    ctx.restore();
    pxPat(ctx, PAT_HEART, x + 5, y - 4 - bob, "#ff9ec2", 0.85);
  } else if (f.kind === "fight") {
    // 打鬥雲(遮蔽式演出:卡通打鬥雲 + 飛出的星星,不見血)
    ctx.fillStyle = frame % 2 ? "#c9c4bd" : "#b7b1a8";
    ctx.fillRect(x - 2, y - 8 - bob, 8, 6);
    ctx.fillRect(x + 4, y - 11 - bob, 8, 6);
    ctx.fillRect(x + 9, y - 6 - bob, 7, 5);
    ctx.fillRect(x + 2, y - 4 - bob, 10, 5);
    ctx.fillStyle = "#8f887d";
    ctx.fillRect(x + 3, y - 7 - bob, 4, 3); // 雲內陰影
    ctx.fillRect(x + 9, y - 9 - bob, 3, 2);
    const star = frame % 2 ? "#ffd23e" : "#fff3b0";
    pxPat(ctx, PAT_STAR, x - 5, y - 13 - ((frame + 1) % 3), star);
    pxPat(ctx, PAT_STAR, x + 14, y - 15 - bob, star);
    pxPat(ctx, PAT_STAR, x + 16, y - 2 - ((frame + 2) % 3), star);
  } else if (f.kind === "slam") {
    // 冷戰摔門:門板震動 + 驚嘆號/撞擊線,不依賴音效也能看懂「砰」的一下
    const shake = frame % 2;
    rect(ctx, x + 4 + shake, y - 10, 8, 10, "#4b2f24");
    rect(ctx, x + 5 + shake, y - 9, 6, 9, "#9a6240");
    rect(ctx, x + 10 + shake, y - 5, 1, 1, "#ffd27a");
    pxPat(ctx, PAT_BANG, x + 13, y - 13, "#ffcf4a");
    rect(ctx, x + 1 - shake, y - 8, 2, 1, "#ff8a5b");
    rect(ctx, x, y - 5, 3, 1, "#ff8a5b");
  }
}

/** 隨狀態的環境演出:睡覺 Zzz、直播音符、洗澡蒸氣、崩潰淚滴 */
function drawAmbient(ctx: Ctx, a: Agent, frame: number) {
  const bob = frame % 2;
  const px = a.px + a.poseOffsetX;
  const py = a.py + a.poseOffsetY;
  if (a.vs === "sleeping_on_bed") {
    pxPat(ctx, PAT_Z, px + 9, py - 7 - bob, "#cfd6ff", 0.9);
    pxPat(ctx, PAT_Z, px + 13, py - 12 - bob, "#aab4e8", 0.7);
  } else if (a.vs === "streaming") {
    pxPat(ctx, PAT_NOTE, a.px + 10, a.py - 9 - bob, "#cfe0ff", 0.9);
  } else if (a.vs === "showering") {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(a.px + 1, a.py - 6 - bob, 2, 2);
    ctx.fillRect(a.px + 6, a.py - 10 - ((frame + 1) % 3), 2, 2);
    ctx.fillRect(a.px + 11, a.py - 5 - ((frame + 2) % 3), 2, 2);
    ctx.restore();
  } else if (a.vs === "washing_at_sink") {
    ctx.fillStyle = "#8fd3ff";
    ctx.fillRect(a.px + 2, a.py + 7 + bob, 2, 1);
    ctx.fillRect(a.px + 11, a.py + 8 - bob, 2, 1);
  } else if (a.vs === "taking_bath") {
    ctx.fillStyle = "#dfe9ee";
    ctx.fillRect(px + 2, py + 2 - bob, 2, 2);
    ctx.fillRect(px + 12, py + 4 - ((frame + 1) % 2), 1, 1);
  } else if (a.vs === "using_toilet" || a.vs === "waiting_for_bathroom") {
    ctx.fillStyle = "#cfd6ff";
    ctx.fillRect(a.px + 5, a.py - 5, 2, 2);
    ctx.fillRect(a.px + 9, a.py - 5, 2, 2);
    ctx.fillRect(a.px + 13, a.py - 5, 2, 2);
  } else if (a.vs === "crying") {
    ctx.fillStyle = "#7fb4ff";
    ctx.fillRect(a.px + 2, a.py - 2 + bob, 1, 2);
    ctx.fillRect(a.px + 13, a.py - 3 + ((frame + 1) % 2), 1, 2);
  } else if (a.vs === "at_cafe" && !a.moving) {
    // 杯口的熱氣。高度跟著 drawAgent 的 drawCoffeeCup() 走(坐姿 +8 / 站姿 +4),
    // 但**橫向刻意偏到角色輪廓右外側**(px+13 起):杯子疊在腹前,熱氣若正上方升起會
    // 直接畫在臉上。走路途中不畫(那時杯子也沒畫)。
    const cupY = a.pose === "sit" ? a.py + 8 : a.py + 4;
    ctx.fillStyle = "#e6dcc8";
    ctx.fillRect(a.px + 13, cupY - 2 - bob, 1, 1);
    ctx.fillRect(a.px + 14, cupY - 5 - ((frame + 1) % 3), 1, 1);
  }
}

// ---------------------------------------------------------------------------
// 四方向朝向:**在 renderer 內唯讀推導,零 `agents.ts` 改動**
// ---------------------------------------------------------------------------

/**
 * 每位租客「最後一次確定的朝向」。
 *
 * 刻意放在 renderer 而不是寫回 `Agent`:
 * 1. `agents.ts` 是模擬層,朝向純粹是畫面問題,寫回去會讓模擬多背一個沒人用的欄位;
 *    而且該檔目前是別的 agent 的活動區,本批的硬性約束就是不碰它。
 * 2. 靜止時要「沿用最後方向」需要跨幀記憶,而 `Agent` 每幀由 `tickAgents` 重寫
 *    `facing`(`agents.ts:103`),放在那裡會被覆蓋。
 * 3. **決定性**:離線單幀渲染(`render-floor.ts` / `roomcam-test`)時這張表是空的,
 *    規則 3 落空 → 一律回退規則 4 的正面,和舊行為完全一致,不會因為 Map 的殘留而漂移。
 *
 * 鍵是 tenantId,而 tenantId 是帶時間戳的唯一值(如 `tenant_r303_1785546924760_0`),
 * **退租時不會被移除**,所以這張表在長時間遊玩下是**單調成長**的:上限不是「當下租客數」,
 * 而是「本次 session 曾出現過的所有租客數」。每筆只有一個短字串鍵 + 一個列舉值,
 * 幾百筆也在數十 KB 等級,而且 session 一結束就整份消失,因此**刻意不做主動清理**——
 * 要清的話最自然的掛點是 `createAgents()`,但那要動 `agents.ts`。
 */
const lastFacingDir = new Map<string, CharView>();

/** 測試/離線渲染重置用:清掉跨幀朝向記憶,讓渲染回到「零記憶」的決定性狀態。 */
export function clearFacingMemory() {
  lastFacingDir.clear();
}

/**
 * 朝向推導的優先序(由高到低):
 * 1. `pairSession` 的 `stand_face` facing → 維持既有行為,側面朝向對方
 * 2. 移動中 → 由 `a.path[0]` 減 `{a.c, a.r}` 推導。`findPath()` 是 **4 鄰 BFS(無對角)**
 *    (`pathfind.ts:57-62`),所以差值保證是正交四方向之一
 * 3. 靜止 → 沿用最後已知方向(上面那張 Map)
 * 4. 都沒有 → 正面
 *
 * 例外:`cook_pair` 一律回正面 —— 既有的 `drawCookingCue()` 是照**正面基底**畫的
 * 抬手 + 鍋鏟像素,套在背面/側面骨架上會錯位。並肩料理本來就面向流理台,維持正面不失真。
 *
 * export 是為了讓 `scripts/appearance-test.ts` 能直接斷言這條優先序(不必架整張畫布)。
 * ⚠️ 有副作用:規則 1、2 命中時會寫入 `lastFacingDir`,測試前請先 `clearFacingMemory()`。
 */
export function agentView(a: Agent): CharView {
  if (a.pose === "cook_pair") return "front";
  if (!a.moving && a.pose === "stand_face" && a.facing !== 0) {
    const dir: CharView = a.facing > 0 ? "side_r" : "side_l";
    lastFacingDir.set(a.tenantId, dir);
    return dir;
  }
  if (a.moving) {
    const next = a.path[0];
    if (next) {
      const dc = next.c - a.c;
      const dr = next.r - a.r;
      const dir: CharView | null =
        dc !== 0 ? (dc > 0 ? "side_r" : "side_l") : dr !== 0 ? (dr > 0 ? "front" : "back") : null;
      if (dir) {
        lastFacingDir.set(a.tenantId, dir);
        return dir;
      }
    }
  }
  return lastFacingDir.get(a.tenantId) ?? "front";
}

function drawAgent(ctx: Ctx, a: Agent) {
  const pal = charPalette(a.tenantId);
  // §10-6 雙人圖式:互動 session 抵達定點後坐下/躺下(還在走路時照常走)
  if (!a.moving && a.pose === "lie") {
    drawLying(ctx, a, pal);
    return;
  }
  if (!a.moving && a.pose === "sit" && a.seatBack) drawActivityChair(ctx, a);
  // 咖啡廳裡沒有任何座位時,走位會退到大廳空地板格(`routine.cafeSeatTarget()` 的虛擬
  // placement),腳下沒有家具 ⇒ 直接畫坐姿會像坐在地上。補一張咖啡廳椅當地板座位。
  // 條件刻意收到 `at_cafe`:其它 visualState 的坐姿一律走原路徑,一位元不變。
  else if (!a.moving && a.pose === "sit" && a.vs === "at_cafe" && !furnitureAt(a.c, a.r)) {
    drawCafeChair(ctx, a.px, a.py);
  }
  groundShadow(ctx, a.px + TILE / 2, a.py + TILE - 1, 11);
  if (!a.moving && a.pose === "sit") {
    // 坐姿 14 行(站姿 19):底邊貼齊同一地面線 → 頭自然比站著矮一截
    drawSprite(ctx, CHAR_SIT, a.px + 3, a.py + 1, pal);
    const apSit = getCustomAppearance(a.tenantId);
    if (apSit) drawAppearanceOverlay(ctx, apSit, a.px + 3, a.py + 1);
    if (a.vs === "at_cafe") drawCoffeeCup(ctx, a.px + 8, a.py + 8);
    return;
  }
  // 四方向:先推導視角,再查該視角的站/走 A/走 B
  const view = agentView(a);
  const set = CHAR_SPRITES[view];
  let sprite = set.stand;
  let yoff = 0;
  if (a.moving) {
    const step = Math.floor(a.walkPhase) % 2 === 0;
    sprite = step ? set.walkA : set.walkB;
    yoff = step ? 0 : -1; // 走路上下彈跳
  }
  drawSprite(ctx, sprite, a.px + 3, a.py - 4 + yoff, pal);
  // 部件化外觀(§9-1):在基底 sprite 上疊髮型/配件(依視角換圖層;朝左會鏡射)
  const ap = getCustomAppearance(a.tenantId);
  if (ap) drawAppearanceOverlay(ctx, ap, a.px + 3, a.py - 4 + yoff, view);
  // 舊的 drawFacingCue()(在正面基底上補一顆側眼與鼻尖)已移除:
  // stand_face 且 facing !== 0 現在直接畫**真正的側面 sprite**,側臉本身就自帶
  // 單眼與凸出的鼻樑,再補一顆點會落在錯的位置。facing === 0(垂直相鄰)舊版本來就不畫。
  if (!a.moving && a.pose === "cook_pair") drawCookingCue(ctx, a, pal);
  // 站著喝(咖啡廳一張座位都沒有、或還沒 snap 上椅子的那一幀)也要看得出手裡有杯子
  if (!a.moving && a.vs === "at_cafe") drawCoffeeCup(ctx, a.px + 8, a.py + 4 + yoff);
}

/**
 * 咖啡杯:白瓷杯 + 深色咖啡液面 + 把手 + 杯墊,畫在角色身上(胸腹高度)。
 *
 * 刻意疊在角色 sprite **之上**而不是旁邊:tile 只有 16px 寬,放在體側會出格、
 * 和隔壁格的家具打架;疊在腹前讀起來就是「雙手捧著杯子」。
 * 純程序像素,不新增任何外部圖檔(沿用 `rect()`,同 `drawCookingCue` 的做法)。
 */
function drawCoffeeCup(ctx: Ctx, x: number, y: number) {
  rect(ctx, x, y, 5, 5, "#2f2a38"); // 描邊:深色衣服上也切得出輪廓
  rect(ctx, x + 1, y + 1, 3, 3, "#f6efe6"); // 白瓷杯身
  rect(ctx, x + 1, y + 1, 3, 1, "#6b4433"); // 咖啡液面
  rect(ctx, x + 4, y + 2, 1, 1, "#f6efe6"); // 把手
  rect(ctx, x, y + 5, 5, 1, "#cdbfae"); // 杯墊
}

/** 並肩料理:抬起靠流理台的一隻手，搭配鍋鏟像素，和一般站姿區分。 */
function drawCookingCue(ctx: Ctx, a: Agent, pal: Palette) {
  const x = a.px + 3;
  const y = a.py - 4;
  rect(ctx, x + 1, y + 10, 2, 1, pal.F);
  rect(ctx, x, y + 8, 1, 3, shade(pal.F, -12));
  rect(ctx, x, y + 5, 1, 4, "#5f6470");
  rect(ctx, x - 1, y + 4, 3, 1, "#353943");
}

/** 活動椅造型:依身下家具種類分電競椅/辦公椅/矮凳,反查不到時回退原本的木椅。 */
type ChairStyle = "gaming" | "office" | "stool" | "plain" | "cafe";

/** 家具 sprite kind → 椅子造型。只有這三種 kind 會讓 tick.ts 給出 activitySurface="chair"。 */
const CHAIR_STYLE_BY_KIND: Record<string, ChairStyle> = {
  desk: "gaming", // 電競桌 → 電競椅
  mic_desk: "office", // 直播設備台 → 一般辦公椅
  tv: "stool", // 電視櫃/交誼廳電視 → 矮凳、軟座
};

/** 距離分支的搜尋半徑(Chebyshev)。放大只會擴大誤吸面積,不會提高正確率,理由見下方註解。 */
const CHAIR_LOOKUP_RADIUS = 1;

/**
 * 反查角色腳下這張活動椅是配哪一件家具(唯讀,不必在 Agent 上多存欄位)。
 *
 * `activitySurface === "chair"` 時 `activityTile` 是家具的**互動格**(catalog 的
 * `interact` 偏移,電競桌/電視櫃是 `dr: 2`),或互動格被擋時退而求其次的外圈可走格,
 * 所以 `furnitureAt(a.c, a.r)` 必定落空。實測初始擺設:tv_console 的座位落在家具
 * **斜對角**、mic_desk 的座位離桌 **2 格**,連四鄰掃描都只命中 4 件中的 2 件;
 * gaming_desk 的四鄰甚至會先撞到 single_bed。因此改成反向比對:
 *   1. 互動格與角色所在格完全吻合 → 直接命中(mic_desk / lounge_tv 走這條;
 *      注意 mic_desk 這條的幾何距離是 2,所以「互動格吻合」無法用距離推導出來,
 *      必須當成獨立且更高優先的訊號)
 *   2. 否則取 Chebyshev ≤ CHAIR_LOOKUP_RADIUS(=1)內最近的一件(gaming_desk / tv_console)
 * 兩條都不中就回傳 "plain",畫回原本的棕色木椅,不拋錯也不會漏畫。
 *
 * ⚠️ **半徑刻意是 1,不要放大**。實際四個座位全是「互動格吻合」或 dist=1,沒有一個需要 2;
 * 而放到 2 會讓 r301 的兩件家具互相誤吸:gaming_desk 的使用者若停在 row 4
 * (互動格 (4,3) 被佔、snap 失敗時會發生),到桌子 dy=3 出圈、到 tv_console dy=2 入圈,
 * 於是**電競位被畫成矮凳**;反向 tv_console 的使用者停在 row 3 則會被畫成電競椅。
 * 半徑 1 時兩者的涵蓋區完全不重疊。至於 claimCrowdTarget(`agents.ts:219-240`)
 * 最遠會推到 **Manhattan 半徑 4**,本來就不是半徑 2 蓋得住的;被擠開的人
 * **應該**安全回退成木椅,而不是用更大的半徑去猜一個可能錯的造型。
 *
 * ⚠️ **這是純幾何啟發式,完全不看牆與房間邊界**。靠牆擺放時可能隔牆吸到隔壁房的家具
 * (例如 r301↔r302 之間的走道/牆帶同時落在兩房家具的半徑內);半徑收到 1 之後
 * 風險大降但未消失。真正的解法是由上游直傳 defId,見第五節技術債。
 */
function computeChairStyle(c: number, r: number): ChairStyle {
  let best: ChairStyle = "plain";
  let bestDist = Infinity;
  for (const p of getPlacements()) {
    const def = getDef(p.defId);
    if (!("kind" in def.sprite)) continue;
    const style = CHAIR_STYLE_BY_KIND[def.sprite.kind];
    if (!style) continue;
    const it = placementInteract(p);
    if (it.c === c && it.r === r) return style;
    const fp = placementFootprint(p);
    const dx = Math.max(p.c - c, 0, c - (p.c + fp.w - 1));
    const dy = Math.max(p.r - r, 0, r - (p.r + fp.h - 1));
    const dist = Math.max(dx, dy);
    if (dist <= CHAIR_LOOKUP_RADIUS && dist < bestDist) {
      bestDist = dist;
      best = style;
    }
  }
  // 一樓咖啡廳的家具全是 recipe sprite(沒有 kind),上面的反查**必定**落空。
  // 與其在咖啡廳畫三樓的棕色木椅,不如畫一張同色系的咖啡廳椅。
  // 只在反查落空時才生效 ⇒ 三樓四個既有座位的造型一位元不變。
  if (best === "plain" && String(GRID[r]?.[c] ?? "").startsWith("cafe")) return "cafe";
  return best;
}

/**
 * 以格座標記憶上面的掃描結果,家具一變(placements.version)就整份作廢。
 *
 * 沒有記憶時是「每幀 × 每個坐姿角色」各跑一次全表掃描(約 35 件 placements),
 * 每件都要 getDef + placementInteract + placementFootprint,後兩者各配置一個新物件。
 * 快取鍵是格座標而非 tenantId:同一格的答案與是誰坐在上面無關,租客換人也能命中。
 *
 * 為什麼不改用「找到就提前 break」:因為**優先序不是單調的**——「互動格吻合」的優先度
 * 高於任何距離命中,但它的幾何距離可能是 2(mic_desk 就是),所以在單趟掃描裡
 * 一旦因為距離命中就 break,會漏掉排在後面、其實該優先採用的互動格吻合項,答案會變。
 * (而 `dist === 0` 這個看似安全的提前退出對本情境是死碼:家具佔位格是 blocked,
 * 走「chair」分支的角色永遠站在家具**外面**的可走格,dist 不可能是 0。)
 * `placements.version` 是可靠的作廢訊號:新增/移除/紀念物移除/讀檔都會 ++,
 * 移動家具走的是 removePlacementAt + addPlacement 也會 ++;`pathfind.ts:41`
 * 早就用同一個版本號快取障礙格,沿用同一套機制。
 */
let chairStyleCache: Map<string, ChairStyle> | null = null;
let chairStyleCacheVersion = -1;

function activityChairStyle(a: Agent): ChairStyle {
  if (chairStyleCache === null || chairStyleCacheVersion !== placements.version) {
    chairStyleCache = new Map();
    chairStyleCacheVersion = placements.version;
  }
  const key = `${a.c},${a.r}`;
  const cached = chairStyleCache.get(key);
  if (cached !== undefined) return cached;
  const style = computeChairStyle(a.c, a.r);
  chairStyleCache.set(key, style);
  return style;
}

/**
 * 桌前／電視前的單人座椅,先畫在角色背後,讓坐姿不會像蹲在地上。
 * 角色 sprite(11×14,畫在 +3/+1)會蓋掉椅子中央,所以三種造型的辨識度全靠
 * **側緣輪廓 + 底座 + 色相**:電競椅有外露側翼與頭枕、辦公椅只有扶手、矮凳沒有椅背。
 */
function drawActivityChair(ctx: Ctx, a: Agent) {
  const x = a.px;
  const y = a.py;
  switch (activityChairStyle(a)) {
    case "gaming":
      drawGamingChair(ctx, x, y);
      break;
    case "office":
      drawOfficeChair(ctx, x, y);
      break;
    case "stool":
      drawLoungeStool(ctx, x, y);
      break;
    case "cafe":
      drawCafeChair(ctx, x, y);
      break;
    default:
      drawPlainChair(ctx, x, y);
  }
}

/**
 * 咖啡廳椅:深藍灰框 + 白軟墊,對齊**玩家真的看得到的那張椅子**。
 *
 * ⚠️ 配色刻意抄 LimeZu atlas 的 `cafe_chair_front`(`art/limezu.ts:109`)而不是 catalog
 * 的玫瑰粉 recipe —— atlas 有載入時(app 的常態)椅子就是這個深藍灰 + 白墊的樣子,
 * 用 recipe 的粉色畫會和旁邊真的椅子明顯不同色。
 */
function drawCafeChair(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 2, y + 2, 12, 10, "#3c4059"); // 椅背外框
  rect(ctx, x + 4, y + 4, 8, 6, "#e7e5f2"); // 白軟墊
  rect(ctx, x + 4, y + 9, 8, 1, "#b9bcd0"); // 墊下壓線
  rect(ctx, x + 2, y + 12, 12, 3, "#8e93ad"); // 坐面
  rect(ctx, x + 2, y + 12, 12, 1, "#c9ccdd");
  rect(ctx, x + 3, y + 15, 2, 1, "#2f3348"); // 椅腳
  rect(ctx, x + 11, y + 15, 2, 1, "#2f3348");
}

/** 電競椅:高椅背過頭頂 + 外露包覆側翼 + 撞色紅 + 五爪底座。 */
function drawGamingChair(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 3, y + 1, 10, 11, "#2c2f3d"); // 椅背主體
  rect(ctx, x + 5, y, 6, 2, "#3a3e50"); // 頭枕:唯一高過頭頂的造型
  rect(ctx, x + 6, y, 4, 1, "#b0453a");
  rect(ctx, x + 1, y + 3, 2, 8, "#b0453a"); // 撞色側翼(包覆感;整片露在角色輪廓外)
  rect(ctx, x + 13, y + 3, 2, 8, "#b0453a");
  rect(ctx, x + 1, y + 3, 2, 1, "#8e372e"); // 側翼上緣壓深,做出前傾包覆的厚度
  rect(ctx, x + 13, y + 3, 2, 1, "#8e372e");
  rect(ctx, x + 2, y + 12, 12, 2, "#33374a"); // 椅座
  rect(ctx, x + 7, y + 14, 2, 1, "#22242f"); // 氣壓中柱
  rect(ctx, x + 3, y + 15, 10, 1, "#22242f"); // 五爪底座
}

/** 一般辦公椅:中高網布椅背 + 腰高扶手 + 單柱雙輪,灰藍色。 */
function drawOfficeChair(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 3, y + 3, 10, 8, "#4c5364"); // 椅背外框(不過頭頂)
  rect(ctx, x + 4, y + 4, 8, 6, "#5d6579"); // 網面
  rect(ctx, x + 3, y + 5, 10, 1, "#6e7789"); // 網格橫紋(兩端露在角色外)
  rect(ctx, x + 3, y + 8, 10, 1, "#6e7789");
  rect(ctx, x + 1, y + 9, 2, 3, "#3b404e"); // 扶手
  rect(ctx, x + 13, y + 9, 2, 3, "#3b404e");
  rect(ctx, x + 2, y + 11, 12, 3, "#434a5a"); // 椅座
  rect(ctx, x + 7, y + 14, 2, 1, "#2b2f3a"); // 單柱
  rect(ctx, x + 4, y + 15, 2, 1, "#2b2f3a"); // 兩輪
  rect(ctx, x + 10, y + 15, 2, 1, "#2b2f3a");
}

/** 交誼廳矮凳／軟座:完全沒有椅背,厚布面 + 外八木腳,橄欖綠與周圍暖木地板分開。 */
function drawLoungeStool(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 3, y + 9, 10, 1, "#8d9a7c"); // 坐墊上緣亮面
  rect(ctx, x + 2, y + 10, 12, 4, "#77836a"); // 厚布面
  rect(ctx, x + 2, y + 11, 12, 1, "#8d9a7c"); // 布面壓線
  rect(ctx, x + 3, y + 13, 10, 1, "#5d6653"); // 下緣陰影
  rect(ctx, x + 2, y + 14, 2, 2, "#4a3d31"); // 外八木腳
  rect(ctx, x + 12, y + 14, 2, 2, "#4a3d31");
  rect(ctx, x + 5, y + 14, 1, 2, "#3c3128");
  rect(ctx, x + 10, y + 14, 1, 2, "#3c3128");
}

/** 反查不到家具時的回退造型:維持本批之前的棕色木椅,像素完全不變。 */
function drawPlainChair(ctx: Ctx, x: number, y: number) {
  rect(ctx, x + 3, y + 4, 10, 7, "#5b4636");
  rect(ctx, x + 4, y + 5, 8, 2, "#8a6444");
  rect(ctx, x + 2, y + 11, 12, 3, "#6d5236");
  rect(ctx, x + 3, y + 14, 2, 2, "#3f342d");
  rect(ctx, x + 11, y + 14, 2, 2, "#3f342d");
}

// ---------------------------------------------------------------------------
// 寵物貓(寵物系統):走路/坐/捲成一團睡,五種花色
// ---------------------------------------------------------------------------

/**
 * 花色本體 2026-08-10 搬到 `./petPalettes`(送養紀錄的像素照片也要用同一組顏色);
 * 色碼與順序一個字未動,既有像素指紋不變。
 */

function drawCat(ctx: Ctx, a: PetAgent, frame: number) {
  const pal = CAT_PALS[a.color] ?? CAT_PALS[0];
  const patchA = pal.patchA ?? CALICO_PATCH_A;
  const patchB = pal.patchB ?? CALICO_PATCH_B;
  const x = a.px + 1; // 貓佔位 14px 寬,置中於 16px tile
  const y = a.py;
  const f = a.facing;
  /** 依面向鏡射的水平座標(off = 面向右時的偏移) */
  const fx = (off: number, w = 1) => x + (f > 0 ? off : 14 - off - w);

  groundShadow(ctx, x + 7, y + TILE - 2, 8);

  if (a.sleeping) {
    // 捲成一團睡:橢圓身體 + 貼著的頭 + 圍上來的尾巴 + Zzz
    rect(ctx, x + 3, y + 8, 8, 1, pal.body);
    rect(ctx, x + 2, y + 9, 10, 4, pal.body);
    rect(ctx, x + 3, y + 12, 8, 1, pal.dark);
    rect(ctx, x + 8, y + 7, 4, 2, pal.body); // 頭靠在身上
    rect(ctx, x + 8, y + 6, 1, 1, pal.dark); // 耳
    rect(ctx, x + 11, y + 6, 1, 1, pal.dark);
    rect(ctx, x + 2, y + 11, 3, 1, pal.dark); // 尾巴圍到身前
    if (pal.tabby) {
      // 白底虎斑:背脊一條 + 頭頂一塊 + 壓回來的白肚 + 粉鼻
      rect(ctx, x + 3, y + 8, 8, 1, patchB);
      rect(ctx, x + 8, y + 7, 3, 1, patchA);
      rect(ctx, x + 4, y + 10, 4, 2, pal.belly);
      if (pal.nose) rect(ctx, x + 11, y + 8, 1, 1, pal.nose);
    } else if (pal.patch) {
      rect(ctx, x + 4, y + 9, 3, 2, patchA);
      rect(ctx, x + 8, y + 10, 2, 2, patchB);
    }
    pxPat(ctx, PAT_Z, x + 12, y + 1 - (frame % 2), "#cfd6ff", 0.8);
    return;
  }

  if (!a.moving) {
    // 端坐:直立身體 + 頭 + 收在腳邊的尾巴
    rect(ctx, x + 4, y + 8, 5, 5, pal.body);
    rect(ctx, x + 5, y + 10, 2, 3, pal.belly); // 胸口
    rect(ctx, x + 4, y + 4, 5, 4, pal.body); // 頭
    rect(ctx, x + 4, y + 3, 1, 1, pal.dark); // 耳
    rect(ctx, x + 8, y + 3, 1, 1, pal.dark);
    rect(ctx, x + 5, y + 5, 1, 1, pal.eye); // 眼(眨眼:偶爾閉上)
    rect(ctx, x + 7, y + 5, 1, 1, frame % 7 === 3 ? pal.body : pal.eye);
    rect(ctx, x + 9, y + 12, 3, 1, pal.dark); // 尾巴
    rect(ctx, x + 11, y + 11, 1, 1, pal.dark);
    if (pal.tabby) {
      // 頭頂只鋪額前一列 —— 三花那塊 2×2 會蓋掉一隻眼睛,而綠眼是辣椒的招牌
      rect(ctx, x + 4, y + 4, 5, 1, patchA);
      rect(ctx, x + 4, y + 8, 5, 1, patchB); // 肩背的鞍狀虎斑
      rect(ctx, x + 5, y + 10, 2, 3, pal.belly); // 胸口白毛
      rect(ctx, x + 4, y + 12, 1, 1, pal.belly); // 白襪
      rect(ctx, x + 8, y + 12, 1, 1, pal.belly);
      if (pal.nose) rect(ctx, x + 6, y + 6, 1, 1, pal.nose);
    } else if (pal.patch) {
      rect(ctx, x + 4, y + 4, 2, 2, patchA);
      rect(ctx, x + 7, y + 9, 2, 2, patchB);
    }
    return;
  }

  // 走路:水平身體 + 前方的頭 + 交替的四肢 + 翹起的尾巴
  rect(ctx, fx(2, 8), y + 8, 8, 3, pal.body);
  rect(ctx, fx(3, 6), y + 10, 6, 1, pal.belly);
  rect(ctx, fx(9, 4), y + 5, 4, 4, pal.body); // 頭
  rect(ctx, fx(9, 1), y + 4, 1, 1, pal.dark); // 耳
  rect(ctx, fx(12, 1), y + 4, 1, 1, pal.dark);
  rect(ctx, fx(12, 1), y + 6, 1, 1, pal.eye); // 眼
  const stepA = Math.floor(a.walkPhase) % 2 === 0;
  const legs = stepA ? [3, 8] : [4, 7];
  for (const off of legs) rect(ctx, fx(off, 1), y + 11, 1, 2, pal.body);
  rect(ctx, fx(1, 1), y + 5, 1, 2, pal.dark); // 尾巴翹起
  rect(ctx, fx(2, 1), y + 7, 1, 1, pal.dark);
  if (pal.tabby) {
    rect(ctx, fx(2, 8), y + 8, 8, 1, patchB); // 背脊虎斑
    rect(ctx, fx(3, 6), y + 10, 6, 1, pal.belly); // 白肚
    for (const off of legs) rect(ctx, fx(off, 1), y + 12, 1, 1, pal.belly); // 白襪
    rect(ctx, fx(9, 3), y + 5, 3, 1, patchA); // 頭頂斑塊(眼睛在 y+6,不會被蓋到)
    rect(ctx, fx(1, 1), y + 5, 1, 2, patchB); // 尾巴的深色環
    if (pal.nose) rect(ctx, fx(12, 1), y + 8, 1, 1, pal.nose);
  } else if (pal.patch) {
    rect(ctx, fx(4, 3), y + 8, 3, 2, patchA);
    rect(ctx, fx(10, 2), y + 5, 2, 2, patchB);
  }
}

// 狗維持 16px tile 尺寸,但輪廓比貓更厚、耳朵下垂、口鼻向前,四種毛色。
function drawDog(ctx: Ctx, a: PetAgent, frame: number) {
  const pal = DOG_PALS[a.color] ?? DOG_PALS[0];
  const x = a.px + 1;
  const y = a.py;
  const f = a.facing;
  const fx = (off: number, w = 1) => x + (f > 0 ? off : 14 - off - w);
  groundShadow(ctx, x + 7, y + TILE - 2, 9);

  if (a.sleeping) {
    // 側躺:長身、前伸的口鼻、收在身旁的腳與尾巴。
    rect(ctx, fx(2, 8), y + 8, 8, 4, pal.body);
    rect(ctx, fx(8, 4), y + 7, 4, 4, pal.body);
    rect(ctx, fx(11, 3), y + 9, 3, 2, pal.light);
    rect(ctx, fx(8, 2), y + 6, 2, 2, pal.dark); // 垂耳
    rect(ctx, fx(12, 1), y + 9, 1, 1, pal.dark); // 鼻
    rect(ctx, fx(3, 5), y + 12, 5, 1, pal.dark);
    rect(ctx, fx(1, 2), y + 7, 2, 2, pal.dark); // 尾巴
    if (pal.patch) rect(ctx, fx(7, 3), y + 8, 3, 3, pal.dark);
    pxPat(ctx, PAT_Z, fx(12, 2), y + 2 - (frame % 2), "#cfd6ff", 0.8);
    return;
  }

  if (!a.moving) {
    // 坐姿:寬胸、兩隻前腳、朝前上方抬起的頭。
    rect(ctx, x + 4, y + 8, 7, 5, pal.body);
    rect(ctx, x + 5, y + 9, 3, 4, pal.light);
    rect(ctx, fx(6, 6), y + 4, 6, 5, pal.body);
    rect(ctx, fx(10, 3), y + 7, 3, 2, pal.light); // 口鼻
    rect(ctx, fx(6, 2), y + 4, 2, 3, pal.dark); // 垂耳
    rect(ctx, fx(11, 1), y + 7, 1, 1, pal.dark);
    rect(ctx, fx(9, 1), y + 5, 1, 1, frame % 7 === 3 ? pal.body : pal.eye);
    rect(ctx, x + 5, y + 12, 2, 2, pal.dark);
    rect(ctx, x + 9, y + 12, 2, 2, pal.dark);
    rect(ctx, fx(2, 3), y + 10, 3, 2, pal.dark); // 捲尾
    if (pal.patch) {
      rect(ctx, fx(7, 3), y + 4, 3, 3, pal.dark);
      rect(ctx, x + 8, y + 9, 3, 2, pal.dark);
    }
    return;
  }

  // 小跑步:厚實水平身體、前伸口鼻、垂耳與高舉尾巴。
  const bob = Math.floor(a.walkPhase) % 2;
  rect(ctx, fx(2, 8), y + 7 - bob, 8, 4, pal.body);
  rect(ctx, fx(8, 5), y + 5 - bob, 5, 5, pal.body);
  rect(ctx, fx(11, 3), y + 8 - bob, 3, 2, pal.light);
  rect(ctx, fx(8, 2), y + 5 - bob, 2, 3, pal.dark);
  rect(ctx, fx(13, 1), y + 8 - bob, 1, 1, pal.dark);
  rect(ctx, fx(11, 1), y + 6 - bob, 1, 1, pal.eye);
  const legs = bob ? [3, 8] : [4, 7];
  for (const off of legs) rect(ctx, fx(off, 1), y + 11, 1, 3, pal.dark);
  rect(ctx, fx(1, 1), y + 4 - bob, 1, 3, pal.dark);
  rect(ctx, fx(2, 1), y + 6 - bob, 1, 1, pal.dark);
  if (pal.patch) rect(ctx, fx(5, 3), y + 7 - bob, 3, 3, pal.dark);
}

/**
 * 遊走的掃地機:沿用 render.ts 的 robot_vacuum 家具原圖(drawDef),
 * 再加一點「活著」的細節——輕微上下晃動 + 感應燈閃爍。純外觀,不影響任何模擬。
 */
function drawVacuum(ctx: Ctx, v: VacuumAgent, frame: number) {
  // 1px 晃動:移動中前後微擺,靜止時上下小呼吸,像機器在運轉
  const wobbleY = frame % 2 === 0 ? 0 : -1;
  const wobbleX = v.moving ? (Math.floor(frame / 2) % 2 === 0 ? 0 : v.facing) : 0;
  const x = Math.round(v.px) + wobbleX;
  const y = Math.round(v.py) + wobbleY;
  drawDef(ctx, getDef(v.defId), x, y, 0);
  // 感應燈閃爍(疊在原圖的燈位上):亮兩拍暗一拍,綠/藍交替呼吸
  const on = frame % 3 !== 2;
  if (on) {
    const blue = Math.floor(frame / 3) % 2 === 0;
    rect(ctx, x + 7, y + 8, 1, 1, "#9dffc0");
    rect(ctx, x + 9, y + 8, 1, 1, blue ? "#bcdcff" : "#7db4ff");
    // 機身頂緣一顆掃描光點,隨方向左右移,強化「在運轉」的感覺
    const scan = v.facing > 0 ? x + 10 + (frame % 2) : x + 4 - (frame % 2);
    rect(ctx, scan, y + 6, 1, 1, "#cfe6ff");
  }
}

function activePetPairs(pets: PetAgent[]): [PetAgent, PetAgent][] {
  const byId = new Map(pets.map((p) => [p.petId, p]));
  const pairs: [PetAgent, PetAgent][] = [];
  for (const leader of pets) {
    if (!leader.pairLeader || !leader.pairAction || !leader.pairWith) continue;
    const partner = byId.get(leader.pairWith);
    if (partner) pairs.push([leader, partner]);
  }
  return pairs;
}

/** 共眠、搗蛋與追球先鋪共享道具，讓互動看起來是同一幕。 */
function drawPetPairGround(ctx: Ctx, a: PetAgent, b: PetAgent, frame: number) {
  if (!a.pairAction) return;
  const minX = Math.min(a.px, b.px);
  const maxX = Math.max(a.px, b.px) + TILE;
  const minY = Math.min(a.py, b.py);
  const maxY = Math.max(a.py, b.py) + TILE;
  const cx = Math.floor((minX + maxX) / 2);
  const cy = Math.floor((minY + maxY) / 2);
  if (a.pairAction === "nap") {
    // 同一塊柔軟小墊＋縫線，呼應概念圖中兩隻貓捲成一團的輪廓。
    const w = Math.min(30, maxX - minX + 8);
    rect(ctx, cx - Math.floor(w / 2), cy + 4, w, 8, "#6f5572");
    rect(ctx, cx - Math.floor(w / 2) + 1, cy + 5, w - 2, 5, "#a57e91");
    for (let x = cx - Math.floor(w / 2) + 3; x < cx + w / 2 - 2; x += 4) rect(ctx, x, cy + 9, 2, 1, "#d2a2ad");
  } else if (a.pairAction === "mischief") {
    // 被兩位主子拆開的小紙箱；箱蓋與紙屑各自有清楚輪廓。
    rect(ctx, cx - 5, cy + 4, 10, 7, "#8c5b31");
    rect(ctx, cx - 4, cy + 5, 8, 5, "#c18548");
    rect(ctx, cx - 6, cy + 3, 5, 2, "#d29a5b");
    rect(ctx, cx + 1, cy + 3, 5, 2, "#d29a5b");
    const hop = frame % 2;
    rect(ctx, cx - 9, cy + 9 - hop, 2, 1, "#d7ae72");
    rect(ctx, cx + 8, cy + 7 + hop, 2, 2, "#d7ae72");
  } else if (a.pairAction === "fetch") {
    // 橘色小球在兩隻狗之間彈跳，白點保留球面高光。
    const hop = frame % 2;
    rect(ctx, cx - 2 + hop, cy + 5 - hop, 5, 5, "#8f442c");
    rect(ctx, cx - 1 + hop, cy + 4 - hop, 4, 4, "#e46d3f");
    rect(ctx, cx + hop, cy + 4 - hop, 1, 1, "#ffd6a2");
  }
}

/** 所有雙寵物事件都有獨立、無文字的像素演出。 */
function drawPetPairAction(ctx: Ctx, a: PetAgent, b: PetAgent, frame: number) {
  if (!a.pairAction) return;
  const ax = a.px + TILE / 2, ay = a.py + 5;
  const bx = b.px + TILE / 2, by = b.py + 5;
  const cx = Math.floor((ax + bx) / 2), cy = Math.floor((ay + by) / 2);
  const bob = frame % 2;
  if (a.pairAction === "chase") {
    // 腳後速度線與灰塵，方向跟著各自面向。
    for (const cat of [a, b]) {
      const tailX = cat.px + (cat.facing > 0 ? 0 : 13);
      rect(ctx, tailX, cat.py + 8 + bob, 3, 1, "#f1d5a1");
      rect(ctx, tailX + (cat.facing > 0 ? -2 : 3), cat.py + 11 - bob, 2, 2, "#d8b883");
    }
  } else if (a.pairAction === "groom") {
    // 舔毛的小粉線與上浮愛心；不蓋住兩隻貓的臉。
    rect(ctx, cx - 1, cy - 5 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx + 1, cy - 5 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx, cy - 4 - bob, 1, 2, "#e95783");
    rect(ctx, cx - 2, cy + 1, 4, 1, "#ffc0ce");
  } else if (a.pairAction === "nap") {
    // 共享的 Z 字節奏，比兩顆獨立泡泡更像一起睡。
    rect(ctx, cx + 2, cy - 8 - bob, 4, 1, "#cfd6ff");
    rect(ctx, cx + 5, cy - 7 - bob, 1, 1, "#cfd6ff");
    rect(ctx, cx + 2, cy - 6 - bob, 4, 1, "#cfd6ff");
  } else if (a.pairAction === "territory") {
    // 中間鋸齒狀火花與兩側炸毛線，保留明顯安全距離。
    rect(ctx, cx, cy - 5 - bob, 2, 2, "#f0c14b");
    rect(ctx, cx - 2, cy - 3 - bob, 2, 2, "#d95454");
    rect(ctx, cx + 2, cy - 1 - bob, 2, 2, "#d95454");
    rect(ctx, Math.floor(ax) - 7, Math.floor(ay) - 3, 3, 1, "#f4e9da");
    rect(ctx, Math.floor(bx) + 4, Math.floor(by) - 3, 3, 1, "#f4e9da");
  } else if (a.pairAction === "mischief") {
    // 紙箱上方跳動的驚嘆星芒，強調「一起闖禍」。
    rect(ctx, cx, cy - 7 - bob, 1, 5, "#ffd66e");
    rect(ctx, cx - 2, cy - 5 - bob, 5, 1, "#ffd66e");
    rect(ctx, cx - 1, cy - 6 - bob, 3, 3, "#fff0a8");
  } else if (a.pairAction === "fetch") {
    // 球後方的短速度線，配合兩隻狗的小跑步形成追球方向。
    rect(ctx, cx - 8, cy + 4 + bob, 4, 1, "#f1d5a1");
    rect(ctx, cx + 5, cy + 1 - bob, 3, 1, "#f1d5a1");
  } else if (a.pairAction === "sniff") {
    // 鼻尖間的嗅聞點與兩側搖尾線。
    rect(ctx, cx - 1, cy, 3, 1, "#d9c7aa");
    rect(ctx, cx, cy - 2 - bob, 1, 1, "#f3e5cb");
    rect(ctx, Math.floor(ax) - 7, Math.floor(ay) - 1 - bob, 3, 1, "#f1d5a1");
    rect(ctx, Math.floor(bx) + 4, Math.floor(by) - 1 + bob, 3, 1, "#f1d5a1");
  } else if (a.pairAction === "greet") {
    // 貓狗鼻尖上方浮起一顆小愛心。
    rect(ctx, cx - 1, cy - 7 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx + 1, cy - 7 - bob, 1, 1, "#ff8fac");
    rect(ctx, cx, cy - 6 - bob, 1, 2, "#e95783");
  } else if (a.pairAction === "avoid") {
    // 兩側各自的警覺線，中間留下清楚的安全距離。
    rect(ctx, Math.floor(ax) - 1, Math.floor(ay) - 7 - bob, 1, 4, "#ffd66e");
    rect(ctx, Math.floor(ax) - 1, Math.floor(ay) - 2, 1, 1, "#ffd66e");
    rect(ctx, Math.floor(bx), Math.floor(by) - 7 + bob, 1, 4, "#9fc4da");
    rect(ctx, Math.floor(bx), Math.floor(by) - 2, 1, 1, "#9fc4da");
    for (let x = cx - 4; x <= cx + 4; x += 4) rect(ctx, x, cy + 3, 2, 1, "#817b91");
  }
}

/** 躺姿(§10-6 lie:賴床)——頭枕左側 + 蓋著被子的身體(被子用衣服色,一眼認得出是誰) */
function drawLying(ctx: Ctx, a: Agent, pal: Palette) {
  const ox = a.px + a.poseOffsetX;
  const oy = a.py + a.poseOffsetY;
  const rr = (x: number, y: number, w: number, h: number, color: string) => {
    if (a.poseRotation === 90) rect(ctx, ox + TILE - y - h, oy + x, h, w, color);
    else if (a.poseRotation === 180) rect(ctx, ox + TILE - x - w, oy + TILE - y - h, w, h, color);
    else if (a.poseRotation === 270) rect(ctx, ox + y, oy + TILE - x - w, h, w, color);
    else rect(ctx, ox + x, oy + y, w, h, color);
  };
  const appearance = getCustomAppearance(a.tenantId);
  if (appearance?.hairStyle === "long") {
    rr(1, 3, 1, 8, pal.h);
    rr(7, 3, 1, 8, shade(pal.h, -18));
    rr(2, 3, 5, 1, shade(pal.h, 24));
  } else if (appearance?.hairStyle === "ponytail") {
    rr(1, 3, 6, 1, pal.h);
    rr(0, 4, 2, 4, pal.h);
    rr(0, 7, 1, 3, shade(pal.h, -18));
  } else if (appearance?.hairStyle === "spiky") {
    rr(1, 3, 1, 2, pal.h);
    rr(3, 2, 1, 2, shade(pal.h, 24));
    rr(5, 3, 2, 1, pal.h);
  } else if (appearance?.hairStyle === "bob") {
    rr(1, 3, 7, 2, pal.h);
    rr(1, 5, 1, 5, pal.h);
    rr(7, 5, 1, 5, shade(pal.h, -18));
  }
  rr(7, 3, 8, 10, shade(pal.t, -22)); // 被子滾邊
  rr(8, 4, 7, 8, pal.t); // 被子
  rr(8, 7, 7, 1, shade(pal.t, 22)); // 摺線高光
  rr(2, 4, 5, 3, pal.h); // 頭髮
  rr(2, 7, 5, 3, pal.F); // 臉
  rr(3, 8, 1, 1, shade(pal.F, -40)); // 閉眼
  rr(5, 8, 1, 1, shade(pal.F, -40));
  if (appearance?.accessory === "glasses" || appearance?.accessory === "round_glasses") {
    rr(2, 7, 2, 1, "#34313b");
    rr(5, 7, 2, 1, "#34313b");
    rr(4, 8, 1, 1, "#34313b");
  } else if (appearance?.accessory === "cap") {
    rr(1, 3, 7, 2, "#3a66aa");
    rr(6, 5, 3, 1, "#31578e");
  } else if (appearance?.accessory === "bow") {
    rr(1, 3, 1, 2, "#ff88b0");
    rr(2, 4, 1, 1, "#e96f9b");
  } else if (appearance?.accessory === "headphones") {
    rr(1, 6, 1, 4, "#2a2d38");
    rr(7, 6, 1, 4, "#2a2d38");
  }
}

// ---------------------------------------------------------------------------
// 地板
// ---------------------------------------------------------------------------

function drawFloorTiles(ctx: Ctx) {
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const cell = GRID[r][c];
      if (cell === "wall") continue;
      const x = c * TILE;
      const y = r * TILE;
      const base = FLOOR_TINT[cell] ?? "#a5825a";
      // 棋盤微差
      const tint = (c + r) % 2 === 0 ? 0 : -4;
      rect(ctx, x, y, TILE, TILE, shade(base, tint));
      // tile 縫
      rect(ctx, x, y, TILE, 1, shade(base, -14));
      rect(ctx, x, y, 1, TILE, shade(base, -10));
      if (TILED[cell]) {
        // 磁磚:半格再切一次,呈現方格
        rect(ctx, x + TILE / 2, y, 1, TILE, shade(base, -10));
        rect(ctx, x, y + TILE / 2, TILE, 1, shade(base, -12));
      } else {
        // 木板橫紋
        rect(ctx, x, y + 8, TILE, 1, shade(base, -8));
      }
    }
  }
  // 門檻 / 大門地墊
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++) {
      if (GRID[r][c] === "door") {
        const x = c * TILE, y = r * TILE;
        rect(ctx, x + 2, y + 2, TILE - 4, TILE - 4, "#7a5c3a");
        rect(ctx, x + 2, y + 2, TILE - 4, 2, "#8a6c48");
      }
      if (GRID[r][c] === "entrance") {
        const x = c * TILE, y = r * TILE;
        rect(ctx, x + 1, y + 3, TILE - 2, TILE - 5, "#4d3d2a");
        rect(ctx, x + 3, y + 5, TILE - 6, 1, "#6d5540");
      }
    }
}

/**
 * LimeZu 地板覆蓋的房間範圍:四間套房 + 交誼廳橫向大廳 + 浴室 + 洗衣間。
 * 走廊與大門刻意不鋪;範圍全部取自 map.ts,避免和格局漂移。
 */
const LIMEZU_FLOOR_AREAS: ReadonlyArray<{
  room: LimezuFloorRoomId;
  rect: { c0: number; r0: number; c1: number; r1: number };
}> = [
  { room: "r301", rect: ROOM_RECTS.r301 },
  { room: "r302", rect: ROOM_RECTS.r302 },
  { room: "r303", rect: ROOM_RECTS.r303 },
  { room: "r304", rect: ROOM_RECTS.r304 },
  { room: "lounge", rect: LOUNGE_HALL_RECT },
  { room: "bathroom", rect: FACILITY_RECTS.bathroom },
  { room: "laundry", rect: FACILITY_RECTS.laundry },
];

/**
 * 逐房以 1:1 像素覆蓋 LimeZu 地板;圖片不可用時下方程序地板完整保留。
 * 變體沿用 301 既有的 (c + 2*r) % 3 pattern(以房內左上角為原點),
 * 所以 r301 的視覺結果與單房版完全一致。
 * GRID 檢查會跳過範圍內的非本房格(例如浴室的隔間牆)。
 */
function drawLimezuFloorOverlay(ctx: Ctx) {
  for (const area of LIMEZU_FLOOR_AREAS) {
    for (let r = area.rect.r0; r <= area.rect.r1; r++) {
      for (let c = area.rect.c0; c <= area.rect.c1; c++) {
        if (GRID[r][c] !== area.room) continue;
        const variant = (c - area.rect.c0 + 2 * (r - area.rect.r0)) % 3;
        tryDrawLimezuFloor(ctx, area.room, variant, c * TILE, r * TILE);
      }
    }
  }
}

/**
 * 三樓與一樓之間的樓板橫切面。先鋪程序 fallback，再逐格換成 Visible Upstairs
 * 的暖灰橫紋；row 33 固定由樓梯 region 推導，避免另造一份地圖常數。
 */
export function drawFloorDivider(ctx: Ctx) {
  const row = CAFE_RECTS.stairs.r0 + 1;
  const y = row * TILE;
  for (let c = 0; c < GRID_W; c++) {
    const x = c * TILE;
    if (!tryDrawLimezuWallPiece(ctx, "floor_divider", x, y)) {
      rect(ctx, x, y, TILE, TILE, "#6f625d");
      rect(ctx, x, y, TILE, 3, "#93847b");
      rect(ctx, x, y + 6, TILE, 2, "#51484a");
      rect(ctx, x, y + TILE - 2, TILE, 2, "#29242d");
    }
  }
}

/**
 * 2x4 格的跨樓層樓梯。踏面取自 Visible Upstairs 的兩個 16px 變體交錯鋪設；
 * atlas 不可用時畫同尺寸程序踏面，兩側扶手則一律由清晰的 1px/2px 像素線補齊。
 */
export function drawStairs(ctx: Ctx) {
  const stair = CAFE_RECTS.stairs;
  const x = stair.c0 * TILE;
  const y = stair.r0 * TILE;
  const w = (stair.c1 - stair.c0 + 1) * TILE;
  const h = (stair.r1 - stair.r0 + 1) * TILE;

  rect(ctx, x, y, w, h, "#211d25");
  for (let r = stair.r0; r <= stair.r1; r++) {
    for (let c = stair.c0; c <= stair.c1; c++) {
      const piece = (r - stair.r0) % 2 === 0 ? "stair_tread_a" : "stair_tread_b";
      const px = c * TILE;
      const py = r * TILE;
      if (!tryDrawLimezuWallPiece(ctx, piece, px, py)) {
        rect(ctx, px, py, TILE, TILE, r % 2 === 0 ? "#725f57" : "#806b61");
        rect(ctx, px, py + 2, TILE, 3, "#b49a82");
        rect(ctx, px, py + 5, TILE, 2, "#433b43");
        rect(ctx, px, py + 12, TILE, 2, "#a18976");
      }
    }
  }

  // 扶手、立柱與頂端橫桿：讓樓梯輪廓在 1x 像素與夜間 tint 下仍然清楚。
  rect(ctx, x, y, 2, h, "#332b34");
  rect(ctx, x + 2, y, 2, h, "#b69a7d");
  rect(ctx, x + w - 4, y, 2, h, "#b69a7d");
  rect(ctx, x + w - 2, y, 2, h, "#332b34");
  rect(ctx, x + 2, y, w - 4, 2, "#d0b596");
  rect(ctx, x + 2, y + h - 2, w - 4, 2, "#4a3d3d");
}

/** 大門(樓層出入口):明顯的雙開木門 */
function drawEntrance(ctx: Ctx) {
  let minC = GRID_W, maxC = -1, rr = -1;
  for (let r = 0; r < GRID_H; r++)
    for (let c = 0; c < GRID_W; c++)
      if (GRID[r][c] === "entrance") {
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        rr = r;
      }
  if (rr < 0) return;
  const x = minC * TILE;
  const y = rr * TILE;
  const w = (maxC - minC + 1) * TILE;
  const h = TILE;
  const wood = ramp("#8a6a44");
  // 門框
  box(ctx, x - 1, y - 2, w + 2, h + 2, wood.dark, "#2c2018");
  // 兩扇門板
  block(ctx, x, y, w / 2, h, wood, 2);
  block(ctx, x + w / 2, y, w / 2, h, wood, 2);
  rect(ctx, x + 2, y + 2, w / 2 - 4, h - 4, shade("#8a6a44", -20)); // 凹格
  rect(ctx, x + w / 2 + 2, y + 2, w / 2 - 4, h - 4, shade("#8a6a44", -20));
  // 金色對開把手
  rect(ctx, x + w / 2 - 2, y + h / 2 - 1, 2, 3, "#ffd66e");
  rect(ctx, x + w / 2, y + h / 2 - 1, 2, 3, "#ffd66e");
  // 門外暖光(底緣透出)
  rect(ctx, x, y + h - 1, w, 1, "#ffe9a8");
  rect(ctx, x + 1, y - 2, w - 2, 1, shade("#8a6a44", 20));
}

// ---------------------------------------------------------------------------
// 牆(俯視 3/4:牆體 + 南面稍矮的正面,製造厚度)
// ---------------------------------------------------------------------------

function drawWalls(ctx: Ctx) {
  const wallTop = "#5b5470";
  const wallFace = "#413a55";
  const wallHi = "#6e6688";
  const wallSh = "#2c2740";
  const isWall = (rr: number, cc: number) =>
    rr >= 0 && rr < GRID_H && cc >= 0 && cc < GRID_W && GRID[rr][cc] === "wall";
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (GRID[r][c] !== "wall") continue;
      const x = c * TILE;
      const y = r * TILE;
      const below = r + 1 < GRID_H ? GRID[r + 1][c] : "outside";
      const faceVisible = below !== "wall"; // 牆南側露出正面
      // LimeZu 牆貼圖(第三批):幾何沿用「整格頂 + 南向 6px 面」,只換填色。
      // 北鄰非牆 → cap(白頂蓋條),否則 body(牆身延伸);左右鄰非牆側帶深色收邊。
      const west = isWall(r, c - 1);
      const east = isWall(r, c + 1);
      const side = west && east ? "mid" : west ? "right" : east ? "left" : "both";
      const band = isWall(r - 1, c) ? "body" : "cap";
      const topDrawn = tryDrawLimezuWallPiece(ctx, `${band}_${side}`, x, y);
      if (!topDrawn) {
        rect(ctx, x, y, TILE, TILE, wallTop);
        rect(ctx, x, y, TILE, 2, wallHi); // 頂面高光
        rect(ctx, x, y, 1, TILE, shade(wallTop, 8));
      }
      if (faceVisible) {
        // 南面正面(有厚度感);LimeZu 版鋪 16x6 橙踢腳條
        if (!tryDrawLimezuWallPiece(ctx, "baseboard", x, y + TILE - 6)) {
          rect(ctx, x, y + TILE - 6, TILE, 6, wallFace);
          rect(ctx, x, y + TILE - 6, TILE, 1, shade(wallFace, 14));
          rect(ctx, x, y + TILE - 1, TILE, 1, wallSh);
        }
      } else if (!topDrawn) {
        rect(ctx, x, y + TILE - 1, TILE, 1, wallSh);
      }
    }
  }
}
