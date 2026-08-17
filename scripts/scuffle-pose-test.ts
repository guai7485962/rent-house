/**
 * 打架演出「看得見」的驗證(§10-2,2026-08-17)。
 *
 * 舊版打架用 `pose: "hidden"`,兩人 sprite 直接被藏起來,畫面上只剩一團打鬥雲——
 * 使用者反映「要看到大打出手太難了」的第二個成因。本批換成 `scuffle`:
 * 兩人各自畫**側面 sprite 面對面**,再用既有的 500ms `frame` 計數做交替 ±1px 的推擠位移。
 *
 * 🚫 **非血腥的硬規則也在這裡把關**:本檔會掃 `conflicts.ts` / `floorScene.ts` 的原始碼,
 * 確認「不畫傷口、不畫血」的註解還在,且沒有人偷偷把 `spawnFx` 換成別的種類。
 * 打架的演出上限就是「卡通推擠 + 既有的雲與星星」。
 *
 * 驗證手法沿用 `roomcam-test.ts` 的 **FakeCtx 量畫面**:無頭環境沒有 canvas,
 * 就自己實作一個記錄 fillRect 的最小畫布,直接量「畫出來的像素」。
 *   TZ=Asia/Taipei npx tsx scripts/scuffle-pose-test.ts
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

const { composeFloor, agentView, clearFacingMemory, scufflePushOffset, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { startPairSession, startSeparationSession, sessionFor, clearPairSessions } = await import("../src/floor/pairSession");
const { clearFx } = await import("../src/floor/fx");
const { TILE } = await import("../src/floor/map");
const { state } = await import("../src/store");
import type { Agent } from "../src/floor/agents";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", "src", rel), "utf8");

// ---------------------------------------------------------------------------
// 1. pairSession:scuffle 兩人面對面,朝向相反
// ---------------------------------------------------------------------------

const { currentBlocked } = await import("../src/floor/pathfind");

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
clearPairSessions();
startPairSession(aId, bId, anchor, "scuffle", state.gameMs, 15000, { a: anchor, b: { c: anchor.c + 1, r: anchor.r } });
const sesA = sessionFor(aId, state.gameMs);
const sesB = sessionFor(bId, state.gameMs);
check("scuffle 是合法的 PairPose,兩人都拿到", sesA?.pose === "scuffle" && sesB?.pose === "scuffle");
check("水平相鄰 → 兩人朝向相反(面對面)", sesA?.facing === 1 && sesB?.facing === -1);

clearPairSessions();
startPairSession(aId, bId, anchor, "scuffle", state.gameMs, 15000, { a: anchor, b: { c: anchor.c, r: anchor.r + 1 } });
check("垂直相鄰 → facing 0(維持正面,不假裝看向錯方向)", sessionFor(aId, state.gameMs)?.facing === 0);

// ---------------------------------------------------------------------------
// 2. agentView:scuffle 用側面 sprite(和 stand_face 同一套,不需要新剪影)
// ---------------------------------------------------------------------------

const mkAgent = (o: Partial<Agent>): Agent => ({
  tenantId: "scuffle_probe", c: 9, r: 12, px: 9 * TILE, py: 12 * TILE, path: [], goal: null,
  moving: false, hidden: false, walkPhase: 0, vs: "idle", pose: null, facing: 0,
  poseRotation: 0, poseOffsetX: 0, poseOffsetY: 0, seatBack: false, ...o,
});
clearFacingMemory();
check(
  "scuffle + facing → 側面 sprite(沿用四方向站姿,零新美術)",
  agentView(mkAgent({ pose: "scuffle", facing: 1 })) === "side_r"
    && agentView(mkAgent({ pose: "scuffle", facing: -1 })) === "side_l",
);
check(
  "scuffle 與 stand_face 用同一組視角(沒有替打架另開剪影)",
  agentView(mkAgent({ pose: "scuffle", facing: 1 })) === agentView(mkAgent({ pose: "stand_face", facing: 1 })),
);
clearFacingMemory();

// ---------------------------------------------------------------------------
// 3. 推擠位移:靠既有 frame 計數交替 ±1px,兩人反相
// ---------------------------------------------------------------------------

const pushR = mkAgent({ pose: "scuffle", facing: 1 });
const pushL = mkAgent({ pose: "scuffle", facing: -1 });
check("frame 偶數 → 朝對方擠 +1 / −1", scufflePushOffset(pushR, 0) === 1 && scufflePushOffset(pushL, 0) === -1);
check("frame 奇數 → 退開(反向)", scufflePushOffset(pushR, 1) === -1 && scufflePushOffset(pushL, 1) === 1);
check("同一拍兩人位移相反 ⇒ 一起靠近、一起彈開(拉扯感)", scufflePushOffset(pushR, 0) === -scufflePushOffset(pushL, 0));
check("走路中不推擠(避免和走路動畫打架)", scufflePushOffset(mkAgent({ pose: "scuffle", facing: 1, moving: true }), 0) === 0);
check("facing 0(垂直相鄰)不推擠", scufflePushOffset(mkAgent({ pose: "scuffle", facing: 0 }), 0) === 0);
check("其他姿勢一律 0(沒有波及聊天/坐/躺)", ["stand_face", "sit", "lie", "pair", "cook_pair", "apart", "hidden"]
  .every((p) => scufflePushOffset(mkAgent({ pose: p as Agent["pose"], facing: 1 }), 0) === 0));

// ---------------------------------------------------------------------------
// 4. agents 層:scuffle **不會**被藏起來(hidden 才會)
// ---------------------------------------------------------------------------

const agents = createAgents();
const findAgent = (id: string) => agents.find((x) => x.tenantId === id)!;
for (const id of [aId, bId]) state.runtimes[id].tenant.visualState = "idle";

/**
 * 掛一場 session,跑一次 `tickAgents`(pose/facing/hidden 都由它決定),
 * 再把兩人**直接放到各自的 session 錨點**。
 *
 * 為什麼要手動落位:走位本身有既有的讓位規則(`occupiedByOther`),兩人同時擠向相鄰兩格時
 * 需要好幾幀才會排開,而且那是 `sim-trace.ts` 已經在管的事。本檔要驗的是**繪製層**,
 * 所以把「人已經站定」當成前提,量的是「站定之後畫出什麼」。
 */
function settle(pose: "scuffle" | "hidden" | "stand_face") {
  clearPairSessions();
  startPairSession(aId, bId, anchor, pose, state.gameMs, 15000, { a: anchor, b: { c: anchor.c + 1, r: anchor.r } });
  tickAgents(agents, 0.1);
  for (const id of [aId, bId]) {
    const tile = sessionFor(id, state.gameMs)!.tile;
    const ag = findAgent(id);
    ag.c = tile.c; ag.r = tile.r; ag.px = tile.c * TILE; ag.py = tile.r * TILE;
    ag.path = []; ag.moving = false; ag.goal = { ...tile };
  }
}

settle("hidden");
check("對照組:hidden session 仍然把兩人藏起來(🔞 遮蔽式不變)", findAgent(aId).hidden && findAgent(bId).hidden);

settle("scuffle");
check("scuffle:兩人都**沒有**被 hidden(打架看得見)", !findAgent(aId).hidden && !findAgent(bId).hidden);
check("scuffle:兩人的 pose/facing 有傳到 agent 層", findAgent(aId).pose === "scuffle" && findAgent(aId).facing === 1 && findAgent(bId).facing === -1);

// ---------------------------------------------------------------------------
// 5. FakeCtx 量畫面:兩人真的被畫出來,而且位置隨 frame 左右擺動
// ---------------------------------------------------------------------------

function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map((v) => parseFloat(v.trim())); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255, 1];
}
/** 只記錄 fillRect 的最小畫布(比照 roomcam-test.ts),不需要真的 canvas。 */
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

// 角色 sprite 畫在 px+3 / py-4 起算(19 行高);取兩格寬、上半身高的觀察窗
const BAND_X0 = anchor.c * TILE - 2;
const BAND_X1 = (anchor.c + 2) * TILE + 2;
const BAND_Y0 = anchor.r * TILE - 4;
const BAND_Y1 = anchor.r * TILE + 10;

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
      const o = (y * ctx0.w + x) * 4;
      if (p.buf[o] !== q.buf[o] || p.buf[o + 1] !== q.buf[o + 1] || p.buf[o + 2] !== q.buf[o + 2]) n++;
    }
  return n;
}

function renderAt(pose: "scuffle" | "hidden" | "stand_face", frame: number): FakeCtx {
  clearFx(); // 只留兩個人:打鬥雲自己也會隨 frame 變形,會汙染量測
  settle(pose);
  const ctx = new FakeCtx(FLOOR_W, FLOOR_H);
  composeFloor(ctx as unknown as CanvasRenderingContext2D, frame, agents);
  return ctx;
}

const ctx0 = renderAt("scuffle", 0);
const ctx1 = renderAt("scuffle", 1);
check("scuffle 的兩格真的畫出了東西(不是空白)", bandMass(ctx0) > 0);
const moved = bandDiff(ctx0, ctx1);
check("推擠真的畫得出來:相鄰兩拍的畫面不同", moved > 0, `changed=${moved}`);

// 對照組 1:同樣兩拍、同樣兩個人,但姿勢是聊天 → 完全不動(證明差異來自 scuffle 的位移)
const face0 = renderAt("stand_face", 0);
const face1 = renderAt("stand_face", 1);
check("對照組:stand_face 兩拍畫面完全相同(位移只發生在 scuffle)", bandDiff(face0, face1) === 0, `changed=${bandDiff(face0, face1)}`);

// 對照組 2:hidden 時同一段畫面應該少掉兩個人的像素
const hiddenCtx = renderAt("hidden", 0);
check("scuffle 畫面比 hidden 多出人的像素(這就是「看得見」)",
  bandMass(ctx0) > bandMass(hiddenCtx), `${bandMass(ctx0)} vs ${bandMass(hiddenCtx)}`);

// ---------------------------------------------------------------------------
// 6. 演出優先權:進行中的 scuffle 不被別的 session 搶走
//    (socialPass 在打架成立後仍會繼續配對,那些相遇的 stand_face 曾把打架演出蓋掉
//     ⇒ 雲留在中間、兩人卻走開;實測 53 場裡佔 10 場)
// ---------------------------------------------------------------------------

const CID = "scuffle_guard_third";
const stillScuffling = () => sessionFor(aId, state.gameMs)?.pose === "scuffle" && sessionFor(bId, state.gameMs)?.pose === "scuffle";

clearPairSessions();
startPairSession(aId, bId, anchor, "scuffle", state.gameMs, 15000, { a: anchor, b: { c: anchor.c + 1, r: anchor.r } });
startPairSession(aId, CID, anchor, "stand_face", state.gameMs);
check("打架中和第三人相遇 → stand_face 蓋不掉 scuffle", stillScuffling());
check("被擋掉的那場相遇不會留下半場 session", sessionFor(CID, state.gameMs) === null);
startSeparationSession(bId, CID, { c: 1, r: 1 }, { c: 14, r: 22 }, state.gameMs);
check("打架中的冷戰退場(apart)也蓋不掉 scuffle", stillScuffling());
startPairSession(aId, bId, anchor, "hidden", state.gameMs);
check("同一對改掛別的姿勢一樣擋住(演出以打架優先)", stillScuffling());

// 例外一:再打一場仍然可以接手(打架換對手還是打架)
startPairSession(aId, CID, anchor, "scuffle", state.gameMs, 15000, { a: anchor, b: { c: anchor.c + 1, r: anchor.r } });
check("新的一場 scuffle 可以接手", sessionFor(aId, state.gameMs)?.pose === "scuffle" && sessionFor(CID, state.gameMs)?.pose === "scuffle" && sessionFor(bId, state.gameMs) === null);

// 例外二:演出過期後不再擋人(守衛只在 15 秒的窗口內生效)
check("scuffle 過期後恢復正常覆蓋", (() => {
  startPairSession(aId, CID, anchor, "scuffle", state.gameMs, 0);
  startPairSession(aId, bId, anchor, "stand_face", state.gameMs);
  return sessionFor(aId, state.gameMs)?.pose === "stand_face";
})());

// 沒有牽涉打架者的第三對照常登記
clearPairSessions();
startPairSession(aId, bId, anchor, "scuffle", state.gameMs, 15000, { a: anchor, b: { c: anchor.c + 1, r: anchor.r } });
startPairSession("guard_x", "guard_y", anchor, "stand_face", state.gameMs);
check("不相干的兩人照常演出(守衛只認打架當事人)", sessionFor("guard_x", state.gameMs)?.pose === "stand_face" && stillScuffling());
clearPairSessions();

// ---------------------------------------------------------------------------
// 7. 非血腥硬規則:掃碼把關
// ---------------------------------------------------------------------------

const conflictsSrc = src("sim/conflicts.ts");
const sceneSrc = src("floor/floorScene.ts");
const sessionSrc = src("floor/pairSession.ts");
const pairSessionCalls = conflictsSrc.match(/startPairSession\([^;]*\)/g) ?? [];
check("conflicts.ts 掛的是 scuffle,而且沒有任何一處還在傳 hidden",
  pairSessionCalls.some((c) => c.includes('"scuffle"')) && pairSessionCalls.every((c) => !c.includes('"hidden"')));
check("conflicts.ts 保留「不畫傷口、不畫血」的註解", conflictsSrc.includes("不畫傷口") && conflictsSrc.includes("不畫血"));
check("floorScene.ts 的推擠函式保留同一條註解", sceneSrc.includes("不畫傷口") && sceneSrc.includes("不畫血"));
check("pairSession.ts 註明 scuffle 不見血、且與 🔞 hidden 是兩件事", sessionSrc.includes("不見血") && sessionSrc.includes("遮蔽式"));
check("打架仍然只掛既有的 fight fx(沒有新增暴力特效種類)", /spawnFx\("fight"/.test(conflictsSrc)
  && (conflictsSrc.match(/spawnFx\(/g) ?? []).length === 2); // fight + 摔門 slam
check("fight fx 的實作仍是卡通雲 + 星星", /f\.kind === "fight"/.test(sceneSrc) && sceneSrc.includes("不見血"));
const bloodWords = /(blood|wound|傷口|流血|鮮血|瘀血|血跡)/;
const bodyOfScuffle = sceneSrc.slice(sceneSrc.indexOf("scufflePushOffset"), sceneSrc.indexOf("function drawCoffeeCup"));
check("推擠段落沒有出現任何血腥字樣(註解裡的「不畫血/不畫傷口」除外)",
  !bloodWords.test(bodyOfScuffle.replace(/不畫傷口|不畫血|不見血/g, "")));

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
