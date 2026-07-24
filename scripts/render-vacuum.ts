/**
 * 離線視覺驗證:遊走掃地機器人。
 * 在 in-memory placements 放一台 robot_vacuum,套用租客作息讓角色現身並走動,
 * 模擬多幀 + 跨遊戲小時換區域,擷取 3 張不同時間點的 PNG,證明:
 *   - 掃地機在不同幀出現在不同位置(會遊走)
 *   - 每一幀都不與任何在場租客同格(避讓成立;程式化斷言 + 目檢)
 *
 * 用法:npx tsx scripts/render-vacuum.ts [輸出資料夾]
 * 預設輸出到 ../artifacts/ui-lab/rent/ 下 vacuum_0/1/2.png(git-ignored)。
 * 不跑 sim tick、不動 balance-snapshot、不改 INITIAL_PLACEMENTS。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { composeFloor, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { createVacuumAgents, tickVacuumAgents, vacuumCellKeys, vacuumTargetArea } = await import("../src/floor/vacuumAgents");
const { addPlacement } = await import("../src/sim/placements");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");
const { applyHour, resetBathroomClaims } = await import("../src/sim/tick");
const { GAME_START } = await import("../src/sim/gameState");
const { state } = await import("../src/store");

// ---- 最小 canvas(只需 fillRect;LimeZu 圖未載入 → 走程序繪圖)----
function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map((v) => parseFloat(v.trim())); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return [255, 0, 255, 1];
}
class FakeCtx {
  buf: Uint8ClampedArray;
  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  globalAlpha = 1;
  constructor(public w: number, public h: number) { this.buf = new Uint8ClampedArray(w * h * 4); }
  save() {} restore() { this.globalAlpha = 1; }
  clearRect() {} translate() {} rotate() {} scale() {} setTransform() {}
  beginPath() {} moveTo() {} lineTo() {} stroke() {} fill() {} closePath() {} arc() {} strokeRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    for (let j = Math.max(0, y | 0); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x | 0); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
  }
}

// ---- PNG 編碼 ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function encodePNG(rgba: Uint8ClampedArray, w: number, h: number) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDirArg = process.argv[2] ?? join(here, "..", "..", "artifacts", "ui-lab", "rent");
const outDir = isAbsolute(outDirArg) ? outDirArg : join(process.cwd(), outDirArg);
mkdirSync(outDir, { recursive: true });

// 起始時間:白天(租客在家),遊戲小時序號 % 7 = 0 → 掃地機首個區域 = r301(和陳家豪同房)
state.gameMs = GAME_START.getTime();
const applyRoutine = () => {
  const hour = new Date(state.gameMs).getHours();
  resetBathroomClaims();
  for (const rt of Object.values(state.runtimes)) {
    try { applyHour(rt as any, hour, false); } catch { /* 作息偶發相依:忽略,至少有預設 targetTile */ }
  }
};
applyRoutine();

// 放一台掃地機在 301(起始就與陳家豪同房,便於呈現「同房但不同格」)
addPlacement({ defId: "robot_vacuum", room: "r301", c: 3, r: 3, rotation: 0 });

let agents = createAgents();
const vac = createVacuumAgents();
console.log(`偵測到 ${vac.length} 台掃地機`);

const SCALE = 3;
function capture(name: string, frame: number) {
  const ctx = new FakeCtx(FLOOR_W, FLOOR_H);
  composeFloor(ctx as any, frame, agents, undefined, new Date(state.gameMs).getHours(), [], vac);
  const outW = FLOOR_W * SCALE, outH = FLOOR_H * SCALE;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++)
    for (let x = 0; x < outW; x++) {
      const src = (((y / SCALE) | 0) * FLOOR_W + ((x / SCALE) | 0)) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = ctx.buf[src]; out[dst + 1] = ctx.buf[src + 1]; out[dst + 2] = ctx.buf[src + 2]; out[dst + 3] = 255;
    }
  const path = join(outDir, name);
  writeFileSync(path, encodePNG(out, outW, outH));
  const v = vac[0];
  const tenants = agents.filter((a) => !a.hidden).map((a) => `${a.tenantId}@(${a.c},${a.r})`);
  const overlap = agents.some((a) => !a.hidden && a.c === v.c && a.r === v.r);
  console.log(`寫出 ${name}: 掃地機@(${v.c},${v.r}) 目標區=${vacuumTargetArea(v.lastHourIdx)} | 租客 ${tenants.join(" ")} | 疊格=${overlap ? "是(異常)" : "否"}`);
  return { cell: `${v.c},${v.r}`, overlap };
}

// 模擬 sec 秒(dt=0.1),掃地機避讓、租客走動
function simulate(seconds: number) {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    tickAgents(agents, 0.1, vacuumCellKeys(vac));
    tickVacuumAgents(vac, 0.1, agents);
  }
}

const results: { cell: string; overlap: boolean }[] = [];
// 幀 0:在 r301 內遊蕩一小段
simulate(3);
results.push(capture("vacuum_0.png", 6));

// 幀 1:推進到「lounge」區域小時 → 掃地機往中央大廳走
state.gameMs += MS_PER_GAME_HOUR; // -> area index 1 = lounge
applyRoutine(); agents = createAgents();
simulate(22);
results.push(capture("vacuum_1.png", 17));

// 幀 2:再推進到「r302」區域小時 → 掃地機走向林小婕的房
state.gameMs += MS_PER_GAME_HOUR; // -> area index 2 = r302
applyRoutine(); agents = createAgents();
simulate(26);
results.push(capture("vacuum_2.png", 31));

const distinct = new Set(results.map((r) => r.cell)).size;
const anyOverlap = results.some((r) => r.overlap);
console.log(`\n不同位置數=${distinct}/3,任一幀疊格=${anyOverlap ? "是(異常!)" : "否"}`);
if (distinct < 2 || anyOverlap) { console.error("視覺驗證未達標"); process.exit(1); }
console.log("視覺驗證通過:位置不同且全程不與租客疊格 🎉");
