/**
 * 房間細看鏡頭(工作項 9 重做)驗證:直接以 scale+translate 畫相機窗格(無離屏、無 drawImage)。
 * - 相機目標:在房者對準其位置;外出者對準其房間中心;都不會落在圖外
 * - 直接渲染:同一 FakeCtx 疊 setTransform,產出非空白畫面(亮度 > 門檻)
 * - 每位在住租客的房間鏡頭都有內容(不會有人是全黑)
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { composeFloor, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { TILE } = await import("../src/floor/map");
const { roomRect } = await import("../src/sim/placements");
const { generateApplicants } = await import("../src/sim/recruit");
const { moveIn } = await import("../src/sim/tenancy");
const { state, roomOfTenant, debugStepHour } = await import("../src/store");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const VIEW_W = 8 * TILE;
const VIEW_H = 7 * TILE;
const SCALE = 3;
const CANVAS_W = VIEW_W * SCALE;
const CANVAS_H = VIEW_H * SCALE;

// FakeCtx:支援 setTransform(平移+縮放)的最小畫布,量測亮度
function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map((v) => parseFloat(v.trim())); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255, 1];
}
class FakeCtx {
  buf: Uint8ClampedArray;
  fillStyle = "#000";
  globalAlpha = 1;
  imageSmoothingEnabled = true;
  private sx = 1; private sy = 1; private tx = 0; private ty = 0;
  constructor(public w: number, public h: number) { this.buf = new Uint8ClampedArray(w * h * 4); }
  save() {}
  restore() { this.globalAlpha = 1; }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) { this.sx = a; this.sy = d; this.tx = e; this.ty = f; }
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    const px0 = Math.round(x * this.sx + this.tx), py0 = Math.round(y * this.sy + this.ty);
    const pw = Math.round(w * this.sx), ph = Math.round(h * this.sy);
    for (let j = Math.max(0, py0); j < Math.min(this.h, py0 + ph); j++)
      for (let i = Math.max(0, px0); i < Math.min(this.w, px0 + pw); i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
  }
  brightness(): number {
    let sum = 0;
    for (let i = 0; i < this.buf.length; i += 4) sum += this.buf[i] + this.buf[i + 1] + this.buf[i + 2];
    return sum / (this.buf.length / 4);
  }
}

const clampCam = (v: number, max: number) => Math.min(Math.max(v, 0), max);

function cameraTarget(agents: ReturnType<typeof createAgents>, tid: string): { x: number; y: number } {
  const a = agents.find((x) => x.tenantId === tid);
  if (a && !a.hidden) return { x: a.px + TILE / 2, y: a.py + TILE / 2 };
  const rect = roomRect(roomOfTenant(tid) ?? "");
  if (rect) return { x: ((rect.c0 + rect.c1 + 1) / 2) * TILE, y: ((rect.r0 + rect.r1 + 1) / 2) * TILE };
  return { x: FLOOR_W / 2, y: FLOOR_H / 2 };
}

/** 一位租客的房間鏡頭渲染一幀,回傳亮度 */
function renderCam(agents: ReturnType<typeof createAgents>, tid: string): number {
  const tgt = cameraTarget(agents, tid);
  const camX = clampCam(tgt.x - VIEW_W / 2, FLOOR_W - VIEW_W);
  const camY = clampCam(tgt.y - VIEW_H / 2, FLOOR_H - VIEW_H);
  const ctx = new FakeCtx(CANVAS_W, CANVAS_H);
  ctx.setTransform(SCALE, 0, 0, SCALE, -Math.round(camX * SCALE), -Math.round(camY * SCALE));
  composeFloor(ctx as any, 0, agents, undefined, 12);
  return ctx.brightness();
}

// 招滿 4 房 + 跑幾小時讓 agent 定位
moveIn("r303", generateApplicants("r303")[0]);
moveIn("r304", generateApplicants("r304")[0]);
let agents = createAgents();
for (let i = 0; i < 6; i++) { debugStepHour(); tickAgents(agents, 0.05); }
agents = createAgents();
tickAgents(agents, 0.05);

// 相機目標永遠落在合法範圍
for (const tid of Object.values(state.occupancy)) {
  const tgt = cameraTarget(agents, tid);
  const camX = clampCam(tgt.x - VIEW_W / 2, FLOOR_W - VIEW_W);
  const camY = clampCam(tgt.y - VIEW_H / 2, FLOOR_H - VIEW_H);
  check(`${tid} 相機在圖內`, camX >= 0 && camX <= FLOOR_W - VIEW_W && camY >= 0 && camY <= FLOOR_H - VIEW_H);
}

// 每位在住租客的鏡頭都有內容(亮度門檻)
for (const tid of Object.values(state.occupancy)) {
  const b = renderCam(agents, tid);
  check(`${tid} 房間鏡頭非空白`, b > 15, `亮度 ${b.toFixed(1)}`);
}

// 種子租客(陳家豪,原本回報空白的那位)特別驗
const chenB = renderCam(agents, "tenant_chen_engineer");
check("陳家豪(301)鏡頭有內容", chenB > 15, `亮度 ${chenB.toFixed(1)}`);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
