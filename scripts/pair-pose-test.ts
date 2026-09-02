/**
 * 租客雙人動作「看得見」的驗證(G-2,2026-08-18)。
 *
 * 使用者的原話是「不只是文字敘述,動畫也需要有」。在這批之前,兩個租客之間**沒有任何
 * 肢體互動幀**:全部是「站好 + 頭上冒 fx」。寵物早就有完整的雙人互動動畫(9 種
 * `PetPairAction`,分地面道具層與動作特效層兩層繪製),租客卻沒有等價物。
 * 本批把那套管線補給租客,新增 4 個 pose:game_pair / kiss / confess / cheers。
 *
 * 驗證手法沿用 F 批 `scuffle-pose-test.ts` 的 **FakeCtx 像素 diff**:無頭環境沒有 canvas,
 * 就自己實作一個記錄 fillRect 的最小畫布,直接量「畫出來的像素」。
 * 對照組(`sit` 兩拍完全相同)是關鍵:證明差異來源是新動作本身,不是環境閃爍。
 *   TZ=Asia/Taipei npx tsx scripts/pair-pose-test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { composeFloor, agentView, clearFacingMemory, pairLeanOffset, activeTenantPairs, FLOOR_W, FLOOR_H } =
  await import("../src/floor/floorScene");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { startPairSession, sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const { clearFx } = await import("../src/floor/fx");
const { TILE } = await import("../src/floor/map");
const { currentBlocked } = await import("../src/floor/pathfind");
const { state } = await import("../src/store");
import type { Agent } from "../src/floor/agents";
import type { PairPose } from "../src/floor/pairSession";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

/** 本批新增的 4 個雙人動作(有共享圖層的那一組) */
const NEW_POSES = ["game_pair", "kiss", "confess", "cheers"] as const;
/** 既有 8 個 pose:本批**不得**讓它們產生任何前傾位移 */
const OLD_POSES = ["sit", "lie", "pair", "cook_pair", "apart", "hidden", "stand_face", "scuffle"] as const;

const [aId, bId] = Object.keys(state.runtimes);

/** 交誼廳裡找一組真的可站、且水平相鄰的兩格(寫死座標會被家具改動弄壞)。 */
function findAdjacentPair(): { c: number; r: number } {
  const blocked = currentBlocked();
  for (let r = 9; r <= 14; r++) {
    for (let c = 1; c <= 13; c++) {
      if (blocked[r]?.[c] === false && blocked[r]?.[c + 1] === false) return { c, r };
    }
  }
  throw new Error("交誼廳找不到水平相鄰的兩個可走格");
}
const anchor = findAdjacentPair();
const tiles = { a: anchor, b: { c: anchor.c + 1, r: anchor.r } };

// ---------------------------------------------------------------------------
// 1. pairSession:4 個新 pose 都是合法 PairPose,且 partnerId 指得回對方
// ---------------------------------------------------------------------------

for (const pose of NEW_POSES) {
  clearPairSessions();
  startPairSession(aId, bId, anchor, pose, state.gameMs, 15000, tiles);
  const sa = sessionFor(aId, state.gameMs);
  const sb = sessionFor(bId, state.gameMs);
  check(`${pose}:兩人都拿到同一個 pose`, sa?.pose === pose && sb?.pose === pose);
  check(`${pose}:partnerId 互指(渲染層才配得出共享圖層)`, sa?.partnerId === bId && sb?.partnerId === aId);
}

clearPairSessions();
startPairSession(aId, bId, anchor, "kiss", state.gameMs, 15000, tiles);
check("kiss 水平相鄰 → 兩人朝向相反(側面相對)",
  sessionFor(aId, state.gameMs)?.facing === 1 && sessionFor(bId, state.gameMs)?.facing === -1);
clearPairSessions();
startPairSession(aId, bId, anchor, "kiss", state.gameMs, 15000, { a: anchor, b: { c: anchor.c, r: anchor.r + 1 } });
check("kiss 垂直相鄰 → facing 0(維持正面,不假裝看向錯方向)", sessionFor(aId, state.gameMs)?.facing === 0);

// ---------------------------------------------------------------------------
// 2. agentView:kiss/confess/cheers 用側面 sprite(沿用四方向站姿,零新美術)
// ---------------------------------------------------------------------------

const mkAgent = (o: Partial<Agent>): Agent => ({
  tenantId: "pair_probe", c: 9, r: 12, px: 9 * TILE, py: 12 * TILE, path: [], goal: null,
  moving: false, hidden: false, walkPhase: 0, vs: "idle", pose: null, facing: 0, pairWith: null,
  poseRotation: 0, poseOffsetX: 0, poseOffsetY: 0, seatBack: false, ...o,
});
clearFacingMemory();
for (const pose of ["kiss", "confess", "cheers"] as const) {
  check(`agentView(${pose}, facing≠0) → 側面`,
    agentView(mkAgent({ pose, facing: 1 })) === "side_r" && agentView(mkAgent({ pose, facing: -1 })) === "side_l");
}
clearFacingMemory(); // 上面的 kiss/confess 迴圈會寫入朝向記憶,要先清掉才量得到「零記憶」的回退值
check("game_pair 不走側面:並肩坐是坐姿分支(drawAgent 提早 return),朝向維持正面",
  agentView(mkAgent({ pose: "game_pair", facing: 1 })) === "front");
clearFacingMemory();

// ---------------------------------------------------------------------------
// 3. pairLeanOffset:只有 kiss/confess 前傾,既有 8 個 pose 一律 0
// ---------------------------------------------------------------------------

check("既有 8 個 pose 一律回 0(本批沒有波及任何舊姿勢)",
  OLD_POSES.every((p) => [0, 1, 2, 3].every((f) =>
    pairLeanOffset(mkAgent({ pose: p as PairPose, facing: 1, pairWith: "zzz" }), f) === 0)));
check("kiss:偶數拍朝對方靠近 1px、奇數拍回位",
  pairLeanOffset(mkAgent({ pose: "kiss", facing: 1 }), 0) === 1
  && pairLeanOffset(mkAgent({ pose: "kiss", facing: -1 }), 0) === -1
  && pairLeanOffset(mkAgent({ pose: "kiss", facing: 1 }), 1) === 0);
{
  // confess:字典序在前者「遞出」,另一方「微退」——同一拍位移相反
  const lead = mkAgent({ tenantId: "aaa", pairWith: "bbb", pose: "confess", facing: 1 });
  const follow = mkAgent({ tenantId: "bbb", pairWith: "aaa", pose: "confess", facing: -1 });
  check("confess:一方遞出、一方微退(不是兩人同進同退)",
    pairLeanOffset(lead, 0) === 1 && pairLeanOffset(follow, 0) === 1);
  check("confess 的主客之分是決定性的(字典序,不看傳入順序)",
    pairLeanOffset(mkAgent({ tenantId: "bbb", pairWith: "aaa", pose: "confess", facing: 1 }), 0) === -1);
}
check("走路中不前傾(避免和走路動畫打架)",
  pairLeanOffset(mkAgent({ pose: "kiss", facing: 1, moving: true }), 0) === 0);
check("facing 0(垂直相鄰)不前傾", pairLeanOffset(mkAgent({ pose: "kiss", facing: 0 }), 0) === 0);
check("cheers 不前傾(舉杯只抬手,身體不動)", pairLeanOffset(mkAgent({ pose: "cheers", facing: 1 }), 0) === 0);

// ---------------------------------------------------------------------------
// 4. activeTenantPairs:leader 規則決定性 + 防衛(缺人/姿勢不一致/隱藏一律靜默跳過)
//    🔴 渲染迴圈丟例外 = rAF 永久停格,所以這裡全部要求「跳過」而不是「丟錯」。
// ---------------------------------------------------------------------------

const pa = mkAgent({ tenantId: "t_aaa", pairWith: "t_bbb", pose: "kiss", facing: 1 });
const pb = mkAgent({ tenantId: "t_bbb", pairWith: "t_aaa", pose: "kiss", facing: -1, c: 10, px: 10 * TILE });
const pair1 = activeTenantPairs([pa, pb]);
const pair2 = activeTenantPairs([pb, pa]);
check("成對的 kiss 只回傳一組(不會畫兩次)", pair1.length === 1);
check("leader 規則決定性:交換傳入順序結果相同(字典序在前者當基準)",
  pair2.length === 1 && pair1[0][0].tenantId === pair2[0][0].tenantId && pair1[0][0].tenantId === "t_aaa");
check("對手不在場 → 靜默跳過(不丟例外)", activeTenantPairs([pa]).length === 0);
check("兩人姿勢不一致 → 靜默跳過", activeTenantPairs([pa, { ...pb, pose: "stand_face" }]).length === 0);
check("對手被 hidden → 靜默跳過", activeTenantPairs([pa, { ...pb, hidden: true }]).length === 0);
check("沒有共享圖層的舊 pose 不進雙人層",
  OLD_POSES.every((p) => activeTenantPairs([
    { ...pa, pose: p as PairPose }, { ...pb, pose: p as PairPose },
  ]).length === 0));
check("4 個新 pose 都會進雙人層",
  NEW_POSES.every((p) => activeTenantPairs([{ ...pa, pose: p }, { ...pb, pose: p }]).length === 1));

// ---------------------------------------------------------------------------
// 5. agents 層:4 個新 pose 都**不會**被藏起來(hidden 才會),且 pairWith 有傳到
// ---------------------------------------------------------------------------

const agents = createAgents();
const findAgent = (id: string) => agents.find((x) => x.tenantId === id)!;
for (const id of [aId, bId]) state.runtimes[id].tenant.visualState = "idle";

/** 掛一場 session,跑一次 `tickAgents`,再把兩人直接放到各自的錨點。
 *  走位本身有既有的讓位規則(`sim-trace.ts` 在管),本檔要驗的是**繪製層**,
 *  所以把「人已經站定」當成前提,量的是「站定之後畫出什麼」。 */
function settle(pose: PairPose) {
  clearPairSessions();
  startPairSession(aId, bId, anchor, pose, state.gameMs, 15000, tiles);
  tickAgents(agents, 0.1);
  for (const id of [aId, bId]) {
    const tile = sessionFor(id, state.gameMs)!.tile;
    const ag = findAgent(id);
    ag.c = tile.c; ag.r = tile.r; ag.px = tile.c * TILE; ag.py = tile.r * TILE;
    ag.path = []; ag.moving = false; ag.goal = { ...tile };
  }
}

for (const pose of NEW_POSES) {
  settle(pose);
  const ag = findAgent(aId);
  const bg = findAgent(bId);
  check(`${pose}:兩人都**沒有**被 hidden(動作看得見)`, !ag.hidden && !bg.hidden);
  check(`${pose}:pose 與 pairWith 都傳到 agent 層`,
    ag.pose === pose && bg.pose === pose && ag.pairWith === bId && bg.pairWith === aId);
  check(`${pose}:composeFloor 找得到這一對(共享圖層真的會被畫)`, activeTenantPairs(agents).length === 1);
}
settle("sit");
check("對照組:sit 沒有 pairWith 以外的副作用,但不進雙人層", activeTenantPairs(agents).length === 0);

// ---------------------------------------------------------------------------
// 6. FakeCtx 量畫面:像素 diff
// ---------------------------------------------------------------------------

function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map((v) => parseFloat(v.trim())); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255, 1];
}
/** 只記錄 fillRect 的最小畫布(比照 scuffle-pose-test.ts),不需要真的 canvas。 */
class FakeCtx {
  buf: Uint8ClampedArray;
  fillStyle = "#000";
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  constructor(public w: number, public h: number) { this.buf = new Uint8ClampedArray(w * h * 4); }
  save() {}
  restore() { this.globalAlpha = 1; }
  setTransform() {}
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    const px0 = Math.round(x), py0 = Math.round(y);
    for (let j = Math.max(0, py0); j < Math.min(this.h, py0 + Math.round(h)); j++)
      for (let i = Math.max(0, px0); i < Math.min(this.w, px0 + Math.round(w)); i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
  }
}

// 角色 sprite 畫在 px+3 / py-4 起算;取兩格寬、上半身高的觀察窗
const BAND_X0 = anchor.c * TILE - 2;
const BAND_X1 = (anchor.c + 2) * TILE + 2;
const BAND_Y0 = anchor.r * TILE - 6;
const BAND_Y1 = anchor.r * TILE + 12;

function bandMass(ctx: FakeCtx): number {
  let sum = 0;
  for (let y = BAND_Y0; y < BAND_Y1; y++)
    for (let x = BAND_X0; x < BAND_X1; x++) {
      const o = (y * ctx.w + x) * 4;
      sum += ctx.buf[o] + ctx.buf[o + 1] + ctx.buf[o + 2];
    }
  return sum;
}
/** 兩張畫面在觀察窗內有幾個像素不同(> 0 = 這一拍畫面真的動了)。 */
function bandDiff(p: FakeCtx, q: FakeCtx): number {
  let n = 0;
  for (let y = BAND_Y0; y < BAND_Y1; y++)
    for (let x = BAND_X0; x < BAND_X1; x++) {
      const o = (y * p.w + x) * 4;
      if (p.buf[o] !== q.buf[o] || p.buf[o + 1] !== q.buf[o + 1] || p.buf[o + 2] !== q.buf[o + 2]) n++;
    }
  return n;
}

function renderAt(pose: PairPose, frame: number): FakeCtx {
  clearFx(); // 只留兩個人:fx 自己也會隨 frame 變形,會汙染量測
  clearFacingMemory();
  settle(pose);
  const ctx = new FakeCtx(FLOOR_W, FLOOR_H);
  composeFloor(ctx as unknown as CanvasRenderingContext2D, frame, agents);
  return ctx;
}

const game0 = renderAt("game_pair", 0);
const game1 = renderAt("game_pair", 1);
check("game_pair 的兩格真的畫出了東西(不是空白)", bandMass(game0) > 0);
const gameMoved = bandDiff(game0, game1);
check("螢幕閃光真的在動:game_pair 相鄰兩拍畫面不同", gameMoved > 0, `changed=${gameMoved}`);

// 對照組:同樣兩個人、同樣兩拍,但姿勢是舊的 sit → 完全不動
const sit0 = renderAt("sit", 0);
const sit1 = renderAt("sit", 1);
const sitMoved = bandDiff(sit0, sit1);
check("對照組:sit 兩拍畫面完全相同(差異來源是新動作,不是環境閃爍)", sitMoved === 0, `changed=${sitMoved}`);

// 像素質量:用「和沒有人的同一幕相比,改掉了幾個像素」來量。
// 直接加總亮度會被地板底色主導(深色 sprite 反而讓總和變小),量不到「畫了多少東西」。
const blankCtx = renderAt("hidden", 0);
const bandInk = (c: FakeCtx) => bandDiff(c, blankCtx);
const kiss0 = renderAt("kiss", 0);
check("kiss 畫得比 sit 更滿(側面站姿 19 行 + 脈動愛心 vs 坐姿 14 行)",
  bandInk(kiss0) > bandInk(sit0), `${bandInk(kiss0)} vs ${bandInk(sit0)}`);
check("sit / kiss 都比 hidden 多畫出人的像素(這就是「看得見」)",
  bandInk(sit0) > 0 && bandInk(kiss0) > 0);
const kissMoved = bandDiff(kiss0, renderAt("kiss", 1));
check("kiss 相鄰兩拍畫面不同(前傾 + 愛心脈動)", kissMoved > 0, `changed=${kissMoved}`);
const confessMoved = bandDiff(renderAt("confess", 0), renderAt("confess", 1));
check("confess 相鄰兩拍畫面不同(彩紙爆開)", confessMoved > 0, `changed=${confessMoved}`);
const cheersMoved = bandDiff(renderAt("cheers", 0), renderAt("cheers", 1));
check("cheers 相鄰兩拍畫面不同(碰杯星芒)", cheersMoved > 0, `changed=${cheersMoved}`);
console.log(`   [像素 diff] game_pair=${gameMoved} kiss=${kissMoved} confess=${confessMoved} cheers=${cheersMoved} | 對照組 sit=${sitMoved} | 質量 kiss=${bandInk(kiss0)} sit=${bandInk(sit0)}`);
clearFx();
clearPairSessions();

// ---------------------------------------------------------------------------
// 7. 掃碼:PairPose union 的每個成員都有明確歸屬,不會「加了 pose 忘了畫」
// ---------------------------------------------------------------------------

const sessionSrc = src("floor/pairSession.ts");
const sceneSrc = src("floor/floorScene.ts");
const unionBody = sessionSrc.slice(sessionSrc.indexOf("export type PairPose"), sessionSrc.indexOf(";", sessionSrc.indexOf("export type PairPose")));
const members = [...unionBody.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
check("掃得到 PairPose union 的全部成員", members.length === 12, `members=${members.join(",")}`);

/** 刻意沒有專屬繪製的姿勢:pair = 單純站在一起、apart = 各自站開、hidden = 🔞 遮蔽式不畫。
 *  新增 pose 時若忘了在 floorScene 接線,會落到這裡而**掃碼失敗**,不會靜默沒動畫。 */
const PLAIN_POSES = ["pair", "apart", "hidden"];
const unhandled = members.filter((p) => !PLAIN_POSES.includes(p) && !sceneSrc.includes(`"${p}"`));
check("每個非「純站立」的 PairPose 在 floorScene 都有對應處理", unhandled.length === 0, `漏接=${unhandled.join(",")}`);

const actionBody = sceneSrc.slice(sceneSrc.indexOf("function drawTenantPairAction"), sceneSrc.indexOf("/** 躺姿"));
check("4 個新 pose 在 drawTenantPairAction 都有分支",
  NEW_POSES.every((p) => actionBody.includes(`"${p}"`)));
const groundBody = sceneSrc.slice(sceneSrc.indexOf("function drawTenantPairGround"), sceneSrc.indexOf("function drawTenantPairAction"));
check("雙人繪製兩層都對「找不到對手/姿勢不一致」做防衛(rAF 丟例外會永久停格)",
  /a\.pose !== b\.pose/.test(groundBody) && /a\.pose !== b\.pose/.test(actionBody)
  && /if \(!partner/.test(sceneSrc));
check("drawAgent 的坐姿分支涵蓋 game_pair(並肩坐,不是站著)", sceneSrc.includes('Set<PairPose>(["sit", "game_pair"])'));
check("雙人動作特效層畫在 drawFx 之前(fx 仍是最上層的資訊層)",
  sceneSrc.indexOf("drawTenantPairAction(ctx, a, b, frame)") < sceneSrc.indexOf("for (const f of activeFx())"));

// 回貼到既有內容:電動夜與房內連線改用 game_pair;里程碑演出改用 confess / apart
const interactionsSrc = readFileSync(join(here, "..", "src", "sim", "interactions.ts"), "utf8");
const tickSrc = readFileSync(join(here, "..", "src", "sim", "tick.ts"), "utf8");
// 批次 2 把 game_night / room_coop_game 改成 game_pair;批次 3 的 catch_up_show 也共用同一組演出。
check("game_night / room_coop_game / catch_up_show 都用 game_pair(不再只是站好的 sit)",
  (interactionsSrc.match(/pose: "game_pair"/g) ?? []).length === 3);
check("批次 2 的 cheers 已被 bar_cheers 用上(新 pose 不是只寫給測試看的)",
  /id: "bar_cheers"[\s\S]*?pose: "cheers"/.test(interactionsSrc));
check("became_couple 里程碑演出 = confess + confetti(玩家真的看到告白那一幕)",
  /became_couple" \? "confess"/.test(tickSrc) && /spawnFx\("confetti"/.test(tickSrc));
check("broke_up 里程碑演出 = apart(各自退開)", /broke_up" \? "apart"/.test(tickSrc));
// 2026-09-03:28 → 39(加了 11 種 location: "cafe")。除了總數,另外釘住「三樓那 28 種一種都沒少」,
// 才擋得到真正該擋的事(既有 def 被誤刪),而不是每次擴充只把數字往上改一格。
check("互動目錄 39 種(三樓 28 + 一樓咖啡廳 11)",
  (interactionsSrc.match(/^    id: "/gm) ?? []).length === 39, `defs=${(interactionsSrc.match(/^    id: "/gm) ?? []).length}`);
check("三樓的 room / lounge 目錄仍是原本的 28 種(咖啡廳池沒有偷改既有內容)",
  (interactionsSrc.match(/^    location: "cafe",$/gm) ?? []).length === 11
    && (interactionsSrc.match(/^    id: "/gm) ?? []).length - 11 === 28);
// 批次 4:kiss / confess 兩個 pose 終於被真的 def 用上(不再只有里程碑演出在用)
check("批次 2 的 kiss 已被 first_kiss / morning_kiss 用上",
  /id: "first_kiss"[\s\S]*?pose: "kiss"/.test(interactionsSrc) && /id: "morning_kiss"[\s\S]*?pose: "kiss"/.test(interactionsSrc));
check("批次 2 的 confess 已被 anniversary 用上", /id: "anniversary"[\s\S]*?pose: "confess"/.test(interactionsSrc));

// 安全底線:新動作一律不得繞過既有的 🔞 遮蔽式規則
check("4 個新 pose 都不是 🔞 內容(hidden 仍是唯一的遮蔽式姿勢)",
  NEW_POSES.every((p) => !new RegExp(`adult[^\\n]*${p}`).test(interactionsSrc)));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
